const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { test } = require('node:test');
const { readConfig, createSessionBroker } = require('../tools/lingxi-session.cjs');

const env = { LINGXI_API_KEY: 'test-private-key', LINGXI_API_BASE: 'https://lingxi.example',
  LINGXI_REALTIME_URL: 'wss://lingxi.example/v1/realtime' };
const issued = () => new Response(JSON.stringify({ value: 'ek_test', expires_at: Math.floor(Date.now() / 1000) + 120,
  internal_key: env.LINGXI_API_KEY }), { status: 200 });
async function fixture(t, options = {}) {
  const handle = createSessionBroker({ config: readConfig(env), fetchImpl: async () => issued(), ...options });
  const server = http.createServer((req, res) => void handle(req, res));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  return (changes = {}) => fetch(url + '/api/lingxi/session', { method: 'POST', body: '{}', ...changes,
    headers: { Origin: url, 'Content-Type': 'application/json', ...changes.headers } });
}

test('config is optional but partial/unsafe/public-unprotected configuration fails closed', () => {
  assert.equal(readConfig({}), null);
  for (const changes of [{ LINGXI_API_KEY: '' }, { LINGXI_API_BASE: 'http://lingxi.example' },
    { LINGXI_API_BASE: 'https://user:pass@lingxi.example' }, { LINGXI_REALTIME_URL: 'ws://lingxi.example/v1/realtime' },
    { LINGXI_REALTIME_URL: 'wss://lingxi.example/v1/realtime?token=secret' },
    { LINGXI_ALLOWED_ORIGIN: 'https://game.example' }]) assert.throws(() => readConfig({ ...env, ...changes }));
});

test('mints fixed realtime config; forwards key only upstream and returns only short credential', async t => {
  const request = await fixture(t, { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://lingxi.example/v1/realtime/client_secrets');
    assert.equal(options.headers.Authorization, `Bearer ${env.LINGXI_API_KEY}`);
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.expires_after.seconds, 120);
    assert.equal(body.session.audio.input.turn_detection.create_response, false);
    assert.deepEqual(body.session.audio.input.transcription, {});
    return issued();
  } });
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const text = await response.text();
  assert.ok(!text.includes(env.LINGXI_API_KEY));
  const data = JSON.parse(text);
  assert.equal(data.credential, 'ek_test');
  assert.ok(data.expiresAtMs > Date.now());
  assert.equal(data.endpoint, env.LINGXI_REALTIME_URL);
});

test('rejects cross-origin calls, unknown request fields, oversized bodies and non-POST methods', async t => {
  let calls = 0;
  const request = await fixture(t, { fetchImpl: async () => { calls++; return issued(); } });
  for (const [options, status] of [
    [{ headers: { Origin: 'https://evil.example' } }, 403],
    [{ headers: { Origin: 'null' } }, 403],
    [{ headers: { 'Content-Type': 'text/plain' } }, 415],
    [{ body: '{"endpoint":"https://evil.example"}' }, 400],
    [{ body: '[]' }, 400], [{ body: 'x'.repeat(4097) }, 413],
    [{ method: 'GET', body: undefined }, 405],
  ]) { const response = await request(options); assert.equal(response.status, status); await response.text(); }
  assert.equal(calls, 0);
});

test('public origin requires the authenticated reverse proxy secret', async t => {
  const config = readConfig({ ...env, LINGXI_ALLOWED_ORIGIN: 'https://game.example', LINGXI_PROXY_SECRET: 'proxy-test' });
  const request = await fixture(t, { config });
  const local = await request();
  assert.equal(local.status, 403); await local.text();
  const rejected = await request({ headers: { Origin: 'https://game.example' } });
  assert.equal(rejected.status, 403); await rejected.text();
  const accepted = await request({ headers: { Origin: 'https://game.example', 'X-Voice-Snake-Proxy-Token': 'proxy-test' } });
  assert.equal(accepted.status, 200); await accepted.text();
});

test('provider failure details and credentials never reach the client', async t => {
  const request = await fixture(t, { fetchImpl: async () => new Response(env.LINGXI_API_KEY, { status: 401 }) });
  const response = await request();
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: { code: 'lingxi_auth_failed' } });
});

test('rejects expired or malformed provider credentials', async t => {
  const request = await fixture(t, { fetchImpl: async () => new Response(JSON.stringify({ value: 'ek_expired', expires_at: 1 })) });
  const response = await request();
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: { code: 'lingxi_invalid_response' } });
});

test('rate limit and unconfigured service are explicit, without contacting a provider', async t => {
  const request = await fixture(t, { limit: 1 });
  const first = await request(); assert.equal(first.status, 200); await first.text();
  const second = await request(); assert.equal(second.status, 429); await second.text();
  const missing = await fixture(t, { config: null });
  const response = await missing();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: { code: 'lingxi_not_configured' } });
});

test('upstream timeout aborts work and returns a sanitized timeout', async t => {
  let aborted = false;
  const request = await fixture(t, { timeoutMs: 30, fetchImpl: async (_, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('secret internal failure')); }, { once: true });
  }) });
  const response = await request();
  assert.equal(response.status, 504);
  assert.equal(aborted, true);
  assert.deepEqual(await response.json(), { error: { code: 'lingxi_timeout' } });
});
