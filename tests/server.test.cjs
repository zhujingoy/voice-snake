const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { once } = require('node:events');
const { test, before, after } = require('node:test');

const root = path.resolve(__dirname, '..');
const servers = [];
let url;

async function start(port) {
  const child = spawn(process.execPath, ['tools/serve.cjs'], {
    cwd: root, env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.push(child);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timeout')), 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited: ${code}`)); });
    child.stdout.on('data', data => {
      const match = data.toString().match(/http:\/\/localhost:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0].replace('localhost', '127.0.0.1')); }
    });
  });
}

before(async () => { url = await start(4290); });
after(async () => {
  await Promise.all(servers.map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }));
});

test('serves the game entry point and query-string routes', async () => {
  const response = await fetch(`${url}/?debug=1`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(await response.text(), /id="board"/);
});

test('HEAD returns the same content type without a response body', async () => {
  const response = await fetch(`${url}/app.mjs`, { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /javascript/);
  assert.equal(await response.text(), '');
});

test('serves required runtime modules and installed vendor assets', async () => {
  for (const route of ['/style.css', '/app.mjs', '/runtime-config.js', '/renderer.mjs', '/audio-capture.mjs',
    '/src/local-voice.mjs', '/src/lingxi-voice.mjs', '/src/pcm.mjs', '/src/session.mjs', '/vendor/vosk.js', '/vendor/kontra.mjs',
    '/icons/mic.svg', '/icons/volume-2.svg']) {
    const response = await fetch(url + route);
    assert.equal(response.status, 200, route);
    assert.ok((await response.arrayBuffer()).byteLength > 0, route);
  }
});

test('successful assets include cache and browser security headers', async () => {
  const response = await fetch(url);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const policy = response.headers.get('content-security-policy');
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /worker-src 'self' blob:/);
  await response.arrayBuffer();
});

test('rejects non-read methods without changing the game asset', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const response = await fetch(url, { method });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
    await response.arrayBuffer();
  }
});

test('rejects source metadata, private artifacts and traversal attempts', async () => {
  for (const route of ['/.git/config', '/package-lock.json', '/README.md',
    '/test-results/local-model.json', '/.models/private', '/%2e%2e/.git/config',
    '/%2e%2e%2fpackage.json', '/missing']) {
    const response = await fetch(url + route);
    assert.equal(response.status, 404, route);
    await response.arrayBuffer();
  }
});

test('inherited object keys return 404 and cannot crash the server', async () => {
  for (const route of ['/toString', '/constructor', '/__proto__', '/hasOwnProperty']) {
    const response = await fetch(url + route);
    assert.equal(response.status, 404, route);
    await response.arrayBuffer();
  }
  const response = await fetch(url);
  assert.equal(response.status, 200);
  await response.arrayBuffer();
});

test('an occupied port starts a separate server on a subsequent port', async () => {
  const second = await start(Number(new URL(url).port));
  assert.notEqual(second, url);
  const response = await fetch(second);
  assert.equal(response.status, 200);
  await response.arrayBuffer();
});
