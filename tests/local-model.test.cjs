const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
let browser, server;

async function run() {
  server = spawn(process.execPath, ['tools/serve.cjs'], {
    cwd: root, env: { ...process.env, PORT: '4190' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Preview startup timeout')), 10000);
    server.on('error', reject);
    server.stdout.on('data', data => {
      const match = data.toString().match(/http:\/\/localhost:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'],
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') console.log('Browser:', message.text().slice(0, 240)); });
  await page.goto(url);
  await page.waitForFunction(() => !!window.Vosk);
  page.setDefaultTimeout(100000);
  const ready = await page.evaluate(async () => {
    const { LocalVoice } = await import('/src/local-voice.mjs');
    const { parseCommand } = await import('/src/commands.mjs');
    const sourceContext = new AudioContext({ sampleRate: 16000 });
    await sourceContext.resume();
    const destination = sourceContext.createMediaStreamDestination();
    const results = [];
    window.audioTest = { sourceContext, destination, results, parseCommand, failures: [] };
    const voice = new LocalVoice({ Vosk: window.Vosk,
      mediaDevices: { getUserMedia: async () => destination.stream },
      onStatus: status => { window.audioTest.status = status; },
      onText: input => results.push({ ...input, command: parseCommand(input.text) }),
      onFailure: reason => window.audioTest.failures.push(reason),
    });
    window.audioTest.voice = voice;
    return voice.start();
  });
  assert.equal(ready, true, 'real local model and AudioWorklet start');
  const samples = ['上', '下', '左', '右', '向上', '向下', '向左', '向右', '暂停', '继续', '再来一局', '结束游戏', '不要向左'];
  const expected = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'PAUSE', 'RESUME', 'RESTART', 'END', null];
  const observations = [];
  for (let index = 0; index < samples.length; index += 1) {
    const base64 = (await fs.readFile(path.join(root, 'test-results', 'speech', `${index}.wav`))).toString('base64');
    const result = await page.evaluate(async base64 => {
      const t = window.audioTest;
      const buffer = await t.sourceContext.decodeAudioData(Uint8Array.from(atob(base64), char => char.charCodeAt(0)).buffer);
      const offset = t.results.length;
      const channel = buffer.getChannelData(0), frameSize = Math.round(buffer.sampleRate * .016);
      let speechStart = null, speechEnd = null;
      for (let frame = 0; frame < channel.length; frame += frameSize) {
        const end = Math.min(channel.length, frame + frameSize);
        let sum = 0;
        for (let i = frame; i < end; i++) sum += channel[i] * channel[i];
        if (Math.sqrt(sum / (end - frame)) >= .008) {
          if (speechStart === null) speechStart = frame;
          speechEnd = end;
        }
      }
      const source = t.sourceContext.createBufferSource();
      source.buffer = buffer; source.connect(t.destination);
      const startedAt = performance.now();
      source.start();
      await new Promise(resolve => setTimeout(resolve, buffer.duration * 1000 + 1000));
      source.disconnect();
      return { durationMs: Math.round(buffer.duration * 1000),
        speechStartMs: speechStart === null ? null : Math.round(speechStart / buffer.sampleRate * 1000),
        speechEndMs: speechEnd === null ? null : Math.round(speechEnd / buffer.sampleRate * 1000),
        results: t.results.slice(offset).map(r => ({ ...r, afterStartMs: Math.round(r.receivedAt - startedAt) })) };
    }, base64);
    observations.push({ text: samples[index], ...result });
    console.log(JSON.stringify(observations.at(-1)));
  }
  await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
  const label = (process.env.MODEL_TEST_LABEL || 'local-model').replace(/[^a-z0-9_-]/gi, '_');
  await fs.writeFile(path.join(root, `test-results/${label}.json`), JSON.stringify(observations, null, 2));
  await page.evaluate(() => { window.audioTest.voice.stop(); return window.audioTest.sourceContext.close(); });
  assert.deepEqual(await page.evaluate(() => window.audioTest.failures), []);
  assert.deepEqual(errors, []);
  for (let i = 0; i < samples.length; i += 1) {
    const finals = observations[i].results.filter(r => r.isFinal && r.text.trim());
    assert.equal(finals.at(-1)?.command ?? null, expected[i], `synthetic speech: ${samples[i]}`);
  }
  console.log(`PASS ${samples.length} synthetic Chinese recordings through real Vosk and AudioWorklet; no microphone tested.`);
  // Exercise the actual default UI with a generated MediaStream, never a device.
  await page.evaluate(async () => {
    const context = new AudioContext({ sampleRate: 16000 });
    await context.resume();
    const destination = context.createMediaStreamDestination();
    window.uiAudio = { context, destination };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true, value: async () => destination.stream,
    });
  });
  const play = async index => {
    const base64 = (await fs.readFile(path.join(root, 'test-results', 'speech', `${index}.wav`))).toString('base64');
    await page.evaluate(async base64 => {
      const { context, destination } = window.uiAudio;
      const buffer = await context.decodeAudioData(Uint8Array.from(atob(base64), char => char.charCodeAt(0)).buffer);
      const source = context.createBufferSource(); source.buffer = buffer; source.connect(destination);
      source.start();
      await new Promise(resolve => setTimeout(resolve, buffer.duration * 1000 + 400));
      source.disconnect();
    }, base64);
  };
  await page.selectOption('#voice-engine', 'local');
  await page.getByRole('button', { name: '开始游戏', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('state').textContent === '游戏中');
  await play(4);
  assert.equal(await page.locator('#command').textContent(), '上');
  assert.equal(await page.locator('#receipt').textContent(), '已转向');
  assert.match(await page.locator('#turn-time').textContent(), /^\d+ ms$/);
  assert.equal(await page.locator('#state').textContent(), '游戏中');
  await page.screenshot({ path: path.join(root, 'test-results/local-running.png'), fullPage: true });
  await play(8);
  assert.equal(await page.locator('#state').textContent(), '已暂停');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  await page.screenshot({ path: path.join(root, 'test-results/local-mobile.png'), fullPage: true });
  await play(11);
  assert.equal(await page.locator('#state').textContent(), '已结束');
  await page.evaluate(() => window.uiAudio.context.close());
  assert.deepEqual(errors, []);
  console.log('PASS explicit local UI: synthetic audio starts, turns, reports timing, pauses and ends.');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (server) server.kill();
});
