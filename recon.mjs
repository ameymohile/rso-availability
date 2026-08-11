// Recon: opens a real browser so you can log in by hand, and records what the
// TeamWork SPA does under the hood. No credentials are passed in or stored --
// you type them into the browser yourself, and secret-looking values are
// redacted before anything is written to disk.
//
// Usage: node recon.mjs      then close the browser window when you're done.

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = new URL('./recon-out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const SECRET_KEY = /pass|pwd|secret|token|auth|session|jwt|cookie/i;

// Keep field names (we need them to replicate the request) but never the value.
function redact(value, key = '') {
  if (typeof value === 'string') {
    if (!SECRET_KEY.test(key)) return value;
    return `<redacted len=${value.length}>`;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redact(v, k)]),
    );
  }
  return value;
}

// Bodies arrive as strings; parse JSON or form-encoding so we can redact by key.
function redactBody(body) {
  if (!body) return null;
  try {
    return redact(JSON.parse(body));
  } catch {}
  if (body.includes('=')) {
    const params = new URLSearchParams(body);
    const out = {};
    for (const [k, v] of params) out[k] = redact(v, k);
    return out;
  }
  return body.length > 4000 ? `${body.slice(0, 4000)}... [truncated]` : body;
}

const log = [];
const NOISE = /\.(png|jpe?g|gif|svg|ico|woff2?|ttf|eot|css)(\?|$)/i;

const context = await chromium.launchPersistentContext(`${OUT}profile`, {
  headless: false,
  viewport: null,
  args: ['--start-maximized'],
});

// Headers are where the API auth actually lives, so record them -- but keep
// secret VALUES out of the file. For a secret-looking header we record its
// length, and whether it happens to equal one of the cookies we're sending,
// which is enough to reconstruct the scheme without leaking the token.
function describeHeaders(headers) {
  const cookieValues = new Map();
  for (const part of (headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) cookieValues.set(part.slice(i + 1).trim(), part.slice(0, i).trim());
  }

  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name === 'cookie') {
      out.cookie = `<names: ${[...cookieValues.values()].join(', ')}>`;
    } else if (SECRET_KEY.test(name)) {
      const match = cookieValues.get(value);
      out[name] = match
        ? `<redacted len=${value.length}, EQUALS cookie "${match}">`
        : `<redacted len=${value.length}>`;
    } else {
      out[name] = value;
    }
  }
  return out;
}

context.on('request', (req) => {
  if (NOISE.test(req.url())) return;
  const type = req.resourceType();
  if (!['xhr', 'fetch', 'document'].includes(type)) return;
  log.push({
    at: new Date().toISOString(),
    kind: 'request',
    type,
    method: req.method(),
    url: req.url(),
    headers: describeHeaders(req.headers()),
    body: redactBody(req.postData()),
  });
});

context.on('response', async (res) => {
  const req = res.request();
  if (NOISE.test(req.url())) return;
  if (!['xhr', 'fetch'].includes(req.resourceType())) return;
  let body = null;
  try {
    const text = await res.text();
    body = redactBody(text);
  } catch {
    body = '<unreadable>';
  }
  log.push({
    at: new Date().toISOString(),
    kind: 'response',
    status: res.status(),
    method: req.method(),
    url: res.url(),
    body,
  });
});

const page = context.pages()[0] ?? (await context.newPage());

// Snapshot the DOM each time the SPA changes route, so we can see the markup of
// the availability screen specifically.
let lastHash = null;
const poll = setInterval(async () => {
  try {
    const hash = await page.evaluate(() => location.hash || '#none');
    if (hash === lastHash) return;
    lastHash = hash;
    const safe = hash.replace(/[^a-z0-9]+/gi, '_');
    // Give the view a moment to render after the route flips.
    await page.waitForTimeout(1500);
    writeFileSync(`${OUT}dom${safe}.html`, await page.content());
    console.log(`  snapshot: ${hash}`);
  } catch {}
}, 1000);

console.log('\n  Browser is open. Steps:');
console.log('   1. Sign in as Employee');
console.log('   2. Go to the availability / Setup Preferences screen');
console.log('   3. Change something and SAVE (this is the important part --');
console.log('      it captures the request that actually submits availability)');
console.log('   4. Close the browser window when done\n');

await page.goto('https://www.tmwork.net/emp/');

await new Promise((resolve) => context.on('close', resolve));
clearInterval(poll);

writeFileSync(`${OUT}network.json`, JSON.stringify(log, null, 2));
console.log(`\n  Done. ${log.length} events -> recon-out/network.json`);
process.exit(0);
