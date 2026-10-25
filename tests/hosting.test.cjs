const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
let server, browser;

async function main() {
  const delivery = JSON.parse(await fs.readFile(path.join(root, 'test-results/delivery-latest.json'), 'utf8'));
  const siteDirectory = path.resolve(root, delivery.siteRelative || delivery.site);
  const prefix = '/voice-snake/';
  const requestedPaths = [];
  const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript',
    '.css': 'text/css', '.svg': 'image/svg+xml', '.gz': 'application/gzip' };
  if (!process.env.HOSTED_URL) server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      requestedPaths.push(pathname);
      if (!pathname.startsWith(prefix)) { response.writeHead(404); response.end(); return; }
      const file = path.resolve(siteDirectory, pathname.slice(prefix.length) || 'index.html');
      if (!file.startsWith(siteDirectory + path.sep) || !(await fs.stat(file)).isFile()) throw new Error('not found');
      response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      createReadStream(file).pipe(response);
    } catch { response.writeHead(404); response.end(); }
  });
  if (server) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = process.env.HOSTED_URL || `http://127.0.0.1:${server.address().port}${prefix}`;
  browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'],
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors = [], failedRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400 && !response.url().endsWith('favicon.ico')) failedRequests.push(response.url()); });
  await page.goto(url + '?review=1');
  await page.selectOption('#voice-engine', 'local');
  await page.evaluate(async () => {
    const context = new AudioContext({ sampleRate: 16000 });
    await context.resume();
    const destination = context.createMediaStreamDestination();
    window.hostingAudio = { context, destination };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true, value: async () => destination.stream,
    });
  });
  await page.getByRole('button', { name: '开始游戏', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('voice-status').textContent === '正在监听', null, { timeout: 100000 });
  await page.getByRole('button', { name: '开始录制', exact: true }).click();
  assert.equal(await page.locator('#record-status').textContent(), '录制中');
  await page.waitForFunction(() => document.getElementById('state').textContent === '游戏中');
  await page.getByRole('button', { name: '停止录制', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('record-status').textContent === '录像已生成');
  assert.equal(await page.locator('#voice-status').textContent(), '正在监听', 'stopping the recorder preserves local recognition');
  assert.equal(await page.getByRole('button', { name: '下载录像', exact: true }).isEnabled(), true);
  assert.equal(await page.locator('#record-kind').textContent(), '麦克风录制 · 本地保存');
  const output = path.join(root, 'test-results', process.env.HOSTED_URL ? 'hosting-live' : 'hosting');
  await fs.mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  assert.ok(await page.locator('img').evaluateAll(images => images.every(img => img.complete && img.naturalWidth > 0)));
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
  for (const suffix of ['src/local-voice.mjs', 'models/chinese-fast-v1.tar.gz', 'audio-capture.mjs', 'session-recorder.mjs']) {
    if (server) assert.ok(requestedPaths.includes(prefix + suffix), suffix);
    else assert.equal((await page.request.head(new URL(suffix, url).href)).status(), 200, suffix);
  }
  const build = await (await page.request.get(new URL('build.json', url).href)).json();
  assert.equal(build.commit, delivery.commit);
  assert.deepEqual(failedRequests, []);
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({
    browser: browser.version(), deliveryCommit: delivery.commit, sourceState: delivery.sourceState,
    kind: 'synthetic_stream', microphone: 'not_tested', subpath: prefix, url, publishedCommit: build.commit,
    localModelLoaded: true, recorderStartedAndStopped: true, downloadEnabled: true,
    screenshots: ['desktop.png', 'mobile.png'], errors, failedRequests,
  }, null, 2));
  console.log('PASS project-subpath hosting: real model, AudioWorklet, recorder lifecycle, assets and responsive layout. Input is simulated.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
});
