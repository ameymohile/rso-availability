// The transport, against a real socket.
//
// The point of http.mjs is one measured behaviour: a request made seconds after
// the last one inherits a live connection instead of paying for TCP and TLS
// again. Node's fetch does not, which was measured against this same kind of
// counting server: two requests 1s apart share a socket, 3s apart do not. So
// the test that matters here counts connections across a gap that fetch cannot
// survive.
//
// Everything else in this file is the sign-in flow's requirements, because
// swapping the transport under it is exactly the change that silently breaks a
// 302 or a form POST.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { send } from './http.mjs';

let server;
let base;
let connections = 0;
const seen = [];

before(async () => {
  server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });

      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/landed' });
        return res.end();
      }

      if (req.url === '/cookies') {
        res.writeHead(200, { 'set-cookie': ['a=1; Path=/', 'b=2; HttpOnly'] });
        return res.end('{}');
      }

      if (req.url === '/gzip') {
        const body = gzipSync(Buffer.from(JSON.stringify({ compressed: true })));
        res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'application/json' });
        return res.end(body);
      }

      if (req.url === '/refuse') {
        // A refusal with no body, which is exactly how swapboardCounts answers.
        res.writeHead(400);
        return res.end();
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    });
  });

  // Higher than the gap the reuse test waits out, so a closed socket in that
  // test means our agent dropped it and not that the server timed it out.
  server.keepAliveTimeout = 30_000;
  server.on('connection', () => { connections += 1; });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('a request four seconds later reuses the connection', async () => {
  connections = 0;

  const first = await send(`${base}/one`);
  assert.equal(first.reusedSocket, false, 'the first request establishes the socket');

  // Four seconds is past undici's ~3s idle close, so this is the gap where the
  // old transport paid ~90ms of TCP and TLS against their ELB and this one does
  // not. It is also why this test is slow, and worth it.
  await new Promise((r) => setTimeout(r, 4000));

  const second = await send(`${base}/two`);
  assert.equal(second.reusedSocket, true, 'the second request inherited it');
  assert.equal(connections, 1, `expected one TCP connection, got ${connections}`);
});

test('set-cookie comes back as every line, not just the last', async () => {
  // The session jar needs all of them. A transport that folds set-cookie into a
  // single string loses the antiforgery cookie and sign-in fails with no clue.
  const res = await send(`${base}/cookies`);
  assert.deepEqual(res.setCookie, ['a=1; Path=/', 'b=2; HttpOnly']);
});

test('a redirect is reported, not followed', async () => {
  const res = await send(`${base}/redirect`);

  assert.equal(res.status, 302);
  assert.equal(res.location, '/landed');
  // The session follows redirects itself so it can turn a POST into a GET and
  // keep collecting cookies on the way. A transport that followed them would
  // hide the 302 that sign-in depends on.
  assert.ok(!seen.some((r) => r.url === '/landed'));
});

test('a form POST carries a content-length, not chunked encoding', async () => {
  const body = 'portal=emp&EmpUser=23383';
  await send(`${base}/signin`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  const request = seen.find((r) => r.url === '/signin');
  assert.equal(request.body, body);
  assert.equal(request.headers['content-length'], String(Buffer.byteLength(body)));
  assert.equal(request.headers['transfer-encoding'], undefined);
});

test('a gzipped reply is decompressed', async () => {
  // fetch did this for us. node:https does not, and a body handed back as gzip
  // bytes would fail JSON.parse with an error naming the wrong problem.
  const res = await send(`${base}/gzip`);
  assert.deepEqual(JSON.parse(res.body), { compressed: true });
});

test('a 400 with an empty body is reported as a 400, not an exception', async () => {
  const res = await send(`${base}/refuse`);

  assert.equal(res.status, 400);
  assert.equal(res.ok, false);
  assert.equal(res.body, '');
});
