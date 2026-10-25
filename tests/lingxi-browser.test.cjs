const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
let server, browser;

async function run() {
  server = spawn(process.execPath, ['tools/serve.cjs'], { cwd: root,
    env: { ...process.env, PORT: '4195', LINGXI_API_KEY: '', LINGXI_API_BASE: '', LINGXI_REALTIME_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server startup timeout')), 10000);
    server.once('error', reject);
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`server exit ${code}`)); });
    server.stdout.on('data', data => {
      const match = data.toString().match(/http:\/\/localhost:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  browser = await chromium.launch({ headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], modelRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('/models/')) modelRequests.push(request.url()); });
  let credentialRequests = 0;
  await page.route('**/api/lingxi/session', async route => {
    credentialRequests++;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      endpoint: 'wss://lingxi.example/v1/realtime', credential: 'ek_mock_only', expiresAtMs: Date.now() + 120000,
      session: { type: 'realtime', output_modalities: ['text'], audio: { input: { format: { type: 'audio/pcm', rate: 16000 },
        transcription: {}, turn_detection: { type: 'server_vad', create_response: false, interrupt_response: false,
          prefix_padding_ms: 100, silence_duration_ms: 200 } } } },
    }) });
  });
  await page.addInitScript(() => {
    window.syntheticStreams = [];
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
      const context = new AudioContext(), oscillator = context.createOscillator(), gain = context.createGain();
      const destination = context.createMediaStreamDestination();
      gain.gain.value = .1; oscillator.connect(gain); gain.connect(destination); oscillator.start();
      await context.resume(); window.syntheticStreams.push({ context, oscillator, stream: destination.stream });
      return destination.stream;
    } });
    class MockSocket {
      constructor(url, protocols) {
        Object.assign(this, { url, protocols, readyState: 1, bufferedAmount: 0, audioMs: 0, sequence: 0, frames: 0, deleted: [] });
        window.lingxiSocket = this;
        setTimeout(() => this.emit({ type: 'session.created', session: { id: 'mock-session' } }), 10);
      }
      emit(event) { this.onmessage?.({ data: JSON.stringify(event) }); }
      send(value) {
        const event = JSON.parse(value);
        if (event.type === 'session.update') {
          this.config = event.session;
          setTimeout(() => this.emit({ type: 'session.updated', session: { ...event.session, id: 'mock-session' } }), 10);
        } else if (event.type === 'input_audio_buffer.append') {
          const bytes = atob(event.audio);
          if (bytes.length !== 512) throw new Error('unexpected PCM frame size');
          this.audioMs += bytes.length / 2 / 16; this.frames++;
        } else if (event.type === 'conversation.item.delete') this.deleted.push(event.item_id);
        else throw new Error(`unexpected client event: ${event.type}`);
      }
      phrase(text, finish = true) {
        const id = `mock-item-${++this.sequence}`;
        this.emit({ type: 'input_audio_buffer.speech_started', item_id: id, audio_start_ms: Math.max(0, this.audioMs - 128) });
        this.emit({ type: 'input_audio_buffer.speech_stopped', item_id: id, audio_end_ms: this.audioMs });
        this.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: id, content_index: 0, delta: text });
        this.pending = { type: 'conversation.item.input_audio_transcription.completed', item_id: id, content_index: 0, transcript: text };
        if (finish) this.emit(this.pending);
      }
      close() { this.readyState = 3; }
    }
    window.WebSocket = MockSocket;
  });
  await page.goto(url + '/?review=synthetic');
  await page.selectOption('#voice-engine', 'lingxi');
  assert.equal(await page.locator('#voice-engine').inputValue(), 'lingxi');
  await page.getByRole('button', { name: '开始游戏', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('state').textContent === '游戏中');
  await page.waitForFunction(() => window.lingxiSocket.frames >= 20);
  assert.equal(credentialRequests, 1);
  assert.deepEqual(modelRequests, []);
  assert.equal(await page.evaluate(() => window.lingxiSocket.config.audio.input.turn_detection.create_response), false);
  console.log('PASS default Lingxi startup, actual AudioWorklet PCM frames, no Vosk model download');

  await page.evaluate(() => window.lingxiSocket.phrase('上', false));
  assert.equal(await page.locator('#command').textContent(), '等待输入');
  await page.evaluate(() => window.lingxiSocket.emit(window.lingxiSocket.pending));
  await page.waitForFunction(() => document.getElementById('receipt').textContent === '已转向');
  await page.evaluate(() => window.lingxiSocket.emit(window.lingxiSocket.pending));
  assert.equal(await page.evaluate(() => window.lingxiSocket.deleted.length), 1);
  console.log('PASS final-only direction execution and duplicate final suppression');

  await page.getByRole('button', { name: '开始录制', exact: true }).click();
  await page.waitForTimeout(250);
  await page.evaluate(() => window.lingxiSocket.phrase('暂停'));
  assert.equal(await page.locator('#state').textContent(), '已暂停');
  await page.getByRole('button', { name: '停止录制', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('record-status').textContent === '录像已生成');
  assert.equal(await page.evaluate(() => window.syntheticStreams[0].stream.getAudioTracks()[0].readyState), 'live');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载事件记录', exact: true }).click();
  const download = await downloadPromise;
  const report = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
  assert.equal(report.engine, 'lingxi'); assert.equal(report.kind, 'synthetic');
  assert.ok(!JSON.stringify(report).includes('ek_mock'));
  console.log('PASS Lingxi recording, explicit synthetic label, no credentials in events, microphone ownership');

  await page.waitForTimeout(220);
  await page.evaluate(() => window.lingxiSocket.phrase('继续'));
  assert.equal(await page.locator('#state').textContent(), '游戏中');
  await page.waitForTimeout(220);
  await page.evaluate(() => window.lingxiSocket.phrase('结束游戏'));
  assert.equal(await page.locator('#state').textContent(), '已结束');
  assert.equal(await page.evaluate(() => window.syntheticStreams[0].stream.getAudioTracks()[0].readyState), 'ended');
  await page.getByRole('button', { name: '开始游戏', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('state').textContent === '游戏中');
  assert.equal(credentialRequests, 2);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.equal(await page.locator('#state').textContent(), '已暂停');
  assert.equal(await page.evaluate(() => window.lingxiSocket.readyState), 3);
  console.log('PASS voice resume/end, fresh credentials on new session, focus-loss cleanup');

  const output = path.join(root, 'test-results/lingxi-browser'); await fs.mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
  await page.evaluate(async () => {
    for (const { context, oscillator } of window.syntheticStreams) { oscillator.stop(); await context.close(); }
  });
  assert.deepEqual(errors, []);
  console.log('5 Lingxi browser checks passed with simulated credentials/Realtime and synthetic audio; no live service or real microphone tested.');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (server && server.exitCode === null) { const exited = once(server, 'exit'); server.kill(); await exited; }
});
