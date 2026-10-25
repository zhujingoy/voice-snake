const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
let browser, server;

async function transcode(ffmpeg, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', ...args], { windowsHide: true });
    let log = '';
    child.stderr.on('data', data => { log += data; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(log) : reject(new Error(log)));
  });
}

async function main() {
  const ffmpeg = process.env.FFMPEG_EXECUTABLE;
  assert.ok(ffmpeg, 'Set FFMPEG_EXECUTABLE to an FFmpeg executable with H.264/AAC support.');
  await fs.access(ffmpeg);
  const output = path.join(root, 'test-results', 'demo');
  const staging = path.join(output, 'minute-staging');
  await fs.mkdir(staging, { recursive: true });
  server = spawn(process.execPath, ['tools/serve.cjs'], {
    cwd: root, env: { ...process.env, PORT: '4190' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timeout')), 10000);
    server.once('error', reject);
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited: ${code}`)); });
    server.stdout.on('data', data => {
      const match = data.toString().match(/http:\/\/localhost:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'],
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Read-only telemetry and deterministic food fixtures; commands still use real Vosk.
  await page.route('**/app.mjs', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\nwindow.previewSnapshot = () => session.snapshot();` });
  });
  await page.addInitScript(() => {
    let index = 0, restarted = false;
    Math.random = () => {
      const s = window.previewSnapshot();
      if (window.previewRestart && !restarted) { restarted = true; index = 0; }
      const targets = restarted
        ? [{ x: 14, y: 10 }, { x: 19, y: 10 }, { x: 19, y: 0 }]
        : [{ x: 19, y: 10 }, { x: 19, y: 0 }, { x: 0, y: 0 },
          { x: 0, y: 19 }, { x: 19, y: 19 }, { x: 19, y: 0 }];
      const snake = restarted && index === 0
        ? [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }]
        : [...s.snake, ...(s.food ? [s.food] : [])];
      const empty = [];
      for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) {
        if (!snake.some(p => p.x === x && p.y === y)) empty.push({ x, y });
      }
      const target = targets[index++];
      const position = empty.findIndex(p => p.x === target?.x && p.y === target?.y);
      if (position < 0) throw new Error('Demo food fixture is not reachable');
      return (position + .25) / empty.length;
    };
  });
  await page.goto(`${url}/?review=synthetic`);
  await page.selectOption('#voice-engine', 'local');
  await page.evaluate(async () => {
    const context = new AudioContext({ sampleRate: 16000 });
    await context.resume();
    const destination = context.createMediaStreamDestination();
    const carrier = context.createOscillator(), mute = context.createGain();
    mute.gain.value = 0;
    carrier.connect(mute).connect(destination);
    carrier.start();
    window.previewAudio = { context, destination };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true, value: async () => destination.stream,
    });
  });
  await page.getByRole('button', { name: '开始游戏', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('voice-status').textContent === '正在监听',
    null, { timeout: 100000 });
  await page.getByRole('button', { name: '开始录制', exact: true }).click();
  const started = Date.now();
  const checkpoints = [];
  assert.equal(await page.locator('#record-status').textContent(), '录制中');
  await page.waitForFunction(() => document.getElementById('state').textContent === '游戏中');
  const play = async index => {
    const data = await fs.readFile(path.join(root, 'test-results', 'speech', `${index}.wav`));
    await page.evaluate(async base64 => {
      const { context, destination } = window.previewAudio;
      const buffer = await context.decodeAudioData(Uint8Array.from(atob(base64), c => c.charCodeAt(0)).buffer);
      const source = context.createBufferSource(); source.buffer = buffer; source.connect(destination);
      source.start();
      await new Promise(resolve => setTimeout(resolve, buffer.duration * 1000 + 500));
      source.disconnect();
    }, data.toString('base64'));
  };
  const checkpoint = async label => {
    const s = await page.evaluate(() => window.previewSnapshot());
    checkpoints.push({ label, atMs: Date.now() - started, roundId: s.roundId,
      score: s.score, length: s.snake.length, head: s.snake[0], state: s.state });
    console.log(`${label}: round ${s.roundId}, score ${s.score}, ${Date.now() - started}ms`);
    assert.notEqual(s.state, 'GAME_OVER', `Unexpected collision: ${label}`);
    return s;
  };
  const reach = async (x, y, score) => {
    await page.waitForFunction(({ x, y, score }) => {
      const s = window.previewSnapshot();
      return s.state === 'RUNNING' && s.snake[0].x === x && s.snake[0].y === y && s.score >= score;
    }, { x, y, score }, { timeout: 14000, polling: 25 });
    await checkpoint(`apple-${score}`);
  };
  for (const [x, y, score, index, command] of [
    [19, 10, 10, 4, '上'], [19, 0, 20, 6, '左'],
    [0, 0, 30, 5, '下'], [0, 19, 40, 7, '右'],
  ]) {
    await reach(x, y, score);
    await play(index);
    assert.equal(await page.locator('#command').textContent(), command);
    assert.equal(await page.locator('#receipt').textContent(), '已转向');
  }
  await reach(19, 19, 50);
  await play(4);
  await play(8);
  assert.equal(await page.locator('#state').textContent(), '已暂停');
  const paused = await checkpoint('pause');
  await page.waitForTimeout(1000);
  assert.deepEqual((await checkpoint('pause-held')).head, paused.head);
  await play(9);
  assert.equal(await page.locator('#state').textContent(), '游戏中');
  await page.evaluate(() => { window.previewRestart = true; });
  await play(10);
  assert.equal(await page.locator('#state').textContent(), '游戏中');
  const restarted = await checkpoint('restart');
  assert.equal(restarted.roundId, 2);
  assert.ok(restarted.score < paused.score);
  assert.equal(restarted.snake.length, 3 + restarted.score / 10);
  await reach(14, 10, 10);
  await reach(19, 10, 20);
  await play(4);
  await page.waitForTimeout(Math.max(0, 58000 - (Date.now() - started)));
  await play(11);
  assert.equal(await page.locator('#state').textContent(), '已结束');
  await page.waitForFunction(() => document.getElementById('record-status').textContent === '录像已生成');
  for (const [name, filename] of [['下载录像', 'voice-snake-synthetic.webm'], ['下载事件记录', 'voice-snake-synthetic-events.json']]) {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name, exact: true }).click();
    await (await download).saveAs(path.join(staging, filename));
  }
  const report = JSON.parse(await fs.readFile(path.join(staging, 'voice-snake-synthetic-events.json'), 'utf8'));
  assert.equal(report.kind, 'synthetic');
  assert.equal(report.status, 'recorded');
  assert.ok(report.durationMs >= 58000 && report.durationMs <= 64000, `Duration: ${report.durationMs}`);
  for (const command of ['UP', 'LEFT', 'DOWN', 'RIGHT', 'PAUSE', 'RESUME', 'RESTART', 'END']) {
    assert.ok(report.events.some(event => event.type === 'receipt' && event.command === command && event.accepted), command);
  }
  assert.ok(report.events.some(event => event.type === 'recognition' &&
    event.text.replace(/\s/g, '') === '再来一局' && event.isFinal));
  assert.ok(report.events.some(event => event.type === 'receipt' &&
    event.command === 'END' && event.accepted && event.atMs < 60000), 'End must remain visible in the MP4');
  // Decode the saved file to verify a moving image and an audio track, not just nonzero bytes.
  const recording = (await fs.readFile(path.join(staging, 'voice-snake-synthetic.webm'))).toString('base64');
  const media = await page.evaluate(async base64 => {
    const blob = new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], { type: 'video/webm' });
    const url = URL.createObjectURL(blob), video = document.createElement('video');
    video.muted = true; video.src = url;
    await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = reject; });
    const canvas = document.createElement('canvas');
    canvas.width = 100; canvas.height = 100;
    const ctx = canvas.getContext('2d');
    const checksums = [];
    for (const time of [10, 35, 55]) {
      await new Promise(resolve => { video.onseeked = resolve; video.currentTime = time; });
      ctx.drawImage(video, 0, 0, 100, 100);
      checksums.push(ctx.getImageData(0, 0, 100, 100).data.reduce((sum, value, i) => sum + value * (i % 31), 0));
    }
    const audio = await window.previewAudio.context.decodeAudioData(await blob.arrayBuffer());
    const samples = audio.getChannelData(0);
    let peak = 0;
    for (const value of samples) peak = Math.max(peak, Math.abs(value));
    URL.revokeObjectURL(url);
    return { width: video.videoWidth, height: video.videoHeight, checksums, audioSeconds: audio.duration, peak };
  }, recording);
  assert.equal(media.width, 1000); assert.equal(media.height, 1000);
  assert.notEqual(media.checksums[0], media.checksums[1]);
  assert.ok(media.audioSeconds > 58 && media.peak > .01, JSON.stringify(media));
  assert.deepEqual(errors, []);
  const mp4 = path.join(staging, 'voice-snake-demo.mp4');
  await transcode(ffmpeg, ['-y', '-i', path.join(staging, 'voice-snake-synthetic.webm'),
    '-vf', 'tpad=stop_mode=clone:stop_duration=2', '-af', 'apad', '-t', '60',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', mp4]);
  const decoded = await transcode(ffmpeg, ['-i', mp4, '-f', 'null', '-']);
  assert.match(decoded, /Video: h264/);
  assert.match(decoded, /Audio: aac/);
  assert.match(decoded, /Duration: 00:01:00/);
  for (const seconds of [10, 35, 55]) {
    await transcode(ffmpeg, ['-y', '-ss', String(seconds), '-i', mp4,
      '-frames:v', '1', path.join(staging, `frame-${seconds}.png`)]);
  }
  await fs.copyFile(mp4, path.join(output, 'voice-snake-demo.mp4'));
  await fs.writeFile(path.join(output, 'voice-snake-demo-events.json'),
    JSON.stringify({ ...report, foodFixture: 'scripted apple route', checkpoints,
      applesEaten: 7, outputDurationSeconds: 60 }, null, 2));
  await fs.writeFile(path.join(output, 'demo-verification.json'),
    JSON.stringify({ browser: browser.version(), media, kind: 'synthetic',
      foodFixture: 'scripted apple route', commands: 8, applesEaten: 7,
      output: { seconds: 60, video: 'H.264', audio: 'AAC', decoded: true } }, null, 2));
  console.log(`PASS 60-second MP4, seven apples, real Vosk, all eight commands: ${output}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (server) server.kill();
});
