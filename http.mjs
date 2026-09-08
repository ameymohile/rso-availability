// One warm connection to TeamWork, and the numbers to prove it was warm.
//
// Node's global fetch cannot do this. undici closes an idle socket after about
// 3s (keepAliveTimeout 4000 minus keepAliveTimeoutThreshold 1000) and does not
// expose the dispatcher to change it, which was measured locally against a
// connection-counting server: two requests 1s apart reuse one socket, 3s apart
// open two. Every sweep interval this bot uses is longer than that, so *every
// single request* was paying a fresh TCP handshake plus a TLS handshake. Against
// their ELB in us-east-2 that is ~42ms and ~45ms respectively, so ~90ms, and the
// request it was hurting most is the claim, where 90ms is the whole race.
//
// An explicit keep-alive agent holds the socket open instead. The detector polls
// every few seconds, so by the time a shift appears the connection is already
// established and the claim is one round trip rather than three.
//
// `reusedSocket` on every reply is not decoration. "The claim went out on a warm
// connection" is exactly the kind of claim that is easy to believe and wrong, so
// it is measured on each request and logged.

import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { request as httpRequest, Agent as HttpAgent } from 'node:http';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';

// `lifo` hands back the most recently used socket, which keeps one connection
// genuinely hot instead of spreading requests over several lukewarm ones. Four
// sockets because the page poll, a sweep and a claim can overlap, and a claim
// queueing behind an in-flight board read would give back everything this file
// exists to save.
const options = {
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 4,
  maxFreeSockets: 4,
  scheduling: 'lifo',
};

const agents = {
  'https:': new HttpsAgent(options),
  'http:': new HttpAgent(options),
};

// Exported so a test can point at a local plain-HTTP server, and so the pool can
// be inspected rather than assumed.
export const poolState = () => Object.fromEntries(
  Object.entries(agents).map(([protocol, agent]) => [protocol, {
    free: Object.values(agent.freeSockets).reduce((n, list) => n + list.length, 0),
    active: Object.values(agent.sockets).reduce((n, list) => n + list.length, 0),
  }]),
);

const decompress = (buffer, encoding) => {
  if (!encoding || encoding === 'identity') return buffer;
  if (encoding === 'gzip') return gunzipSync(buffer);
  if (encoding === 'deflate') return inflateSync(buffer);
  if (encoding === 'br') return brotliDecompressSync(buffer);
  // An encoding we cannot read must not be handed back as text that silently
  // fails to parse further up.
  throw new Error(`unsupported content-encoding: ${encoding}`);
};

export function send(url, { method = 'GET', headers = {}, body = null, timeoutMs = 15000 } = {}) {
  const target = new URL(url);
  const isHttps = target.protocol === 'https:';
  const call = isHttps ? httpsRequest : httpRequest;

  const sendHeaders = { ...headers };
  if (body != null) {
    // Without an explicit length Node uses chunked transfer-encoding, and a
    // form POST to an ASP.NET endpoint is not the place to find out whether that
    // is accepted.
    sendHeaders['content-length'] = Buffer.byteLength(body);
  }

  const at = Date.now();

  return new Promise((resolve, reject) => {
    const req = call(target, {
      method,
      agent: agents[target.protocol],
      headers: sendHeaders,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const raw = decompress(Buffer.concat(chunks), res.headers['content-encoding']);
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            location: res.headers.location ?? null,
            setCookie: res.headers['set-cookie'] ?? [],
            body: raw.toString('utf8'),
            ms: Date.now() - at,
            // Whether this request paid for a handshake or inherited one.
            reusedSocket: req.reusedSocket === true,
          });
        } catch (err) {
          reject(err);
        }
      });
      res.on('error', reject);
    });

    // A request that hangs must not hold a sweep open forever. Destroying it
    // also takes the socket out of the pool, so the next attempt starts clean.
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`${method} ${target.pathname} timed out after ${timeoutMs}ms`));
    });

    req.on('error', reject);

    if (body != null) req.write(body);
    req.end();
  });
}
