import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionRecorder } from '../web/session-recorder.mjs';

function fixture(options = {}) {
  const audio = Object.assign(new EventTarget(), { readyState: 'live', stopped: false, stop() { this.stopped = true; } });
  const video = { stopped: false, stop() { this.stopped = true; } };
  const videoStream = { getVideoTracks: () => [video], getTracks: () => [video] };
  const context = { fillRect() {}, fillText() {}, drawImage() {} };
  globalThis.document = { createElement: () => ({ captureStream: () => videoStream, getContext: () => context }) };
  class Recorder {
    static isTypeSupported() { return true; }
    constructor(stream) { this.stream = stream; this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable({ data: new Blob(['video']) });
      queueMicrotask(() => this.onstop());
    }
  }
  const statuses = [];
  const recorder = new SessionRecorder({
    board: { captureStream() {} }, snapshot: () => ({ state: 'RUNNING', score: 10, snake: [1, 2, 3] }),
    feedback: () => ({ text: '上', command: 'UP', receipt: 'queued' }),
    Recorder, Stream: class { constructor(tracks) { this.tracks = tracks; } },
    onStatus: status => statuses.push(status), ...options,
  });
  const stream = { getAudioTracks: () => [audio] };
  return { recorder, stream, audio, video, statuses, Recorder };
}

test('recording is opt-in and does not retain events before start', () => {
  const f = fixture();
  f.recorder.event('recognition', { text: '上' });
  assert.equal(f.recorder.active, null);
  assert.equal(f.recorder.result, null);
});

test('requires live local audio and supported browser recording', () => {
  const f = fixture();
  assert.throws(() => f.recorder.start(null, 'local'), /microphone_required/);
  assert.throws(() => f.recorder.start(f.stream, 'browser'), /microphone_required/);
  f.audio.readyState = 'ended';
  assert.throws(() => f.recorder.start(f.stream, 'local'), /microphone_required/);
  assert.throws(() => fixture({ Recorder: null }).recorder.start(f.stream, 'local'), /recording_unsupported/);
});

test('stops only video capture, preserves microphone and exports scoped events', async t => {
  const f = fixture();
  t.after(() => f.recorder.stop());
  f.recorder.start(f.stream, 'local');
  f.recorder.event('receipt', { command: 'UP', accepted: true });
  assert.throws(() => f.recorder.start(f.stream, 'local'), /already_recording/);
  const result = await f.recorder.stop();
  assert.equal(await result.video.text(), 'video');
  assert.equal(result.report.kind, 'microphone');
  assert.equal(result.report.events.length, 1);
  assert.equal(result.report.endToEndLatency, 'not_measured');
  assert.equal(f.video.stopped, true);
  assert.equal(f.audio.stopped, false);
  assert.deepEqual(f.statuses, ['recording', 'recorded']);
});

test('synthetic recordings stay explicitly labeled and reset on a new recording', async t => {
  const f = fixture({ kind: 'synthetic' });
  t.after(() => f.recorder.stop());
  f.recorder.start(f.stream, 'local');
  assert.equal((await f.recorder.stop()).report.kind, 'synthetic');
  f.recorder.start(f.stream, 'local');
  assert.equal(f.recorder.result, null);
  assert.equal((await f.recorder.stop()).report.events.length, 0);
});

test('audio device ending finalizes the recording', async t => {
  const f = fixture();
  t.after(() => f.recorder.stop());
  f.recorder.start(f.stream, 'local');
  f.audio.dispatchEvent(new Event('ended'));
  assert.equal((await f.recorder.stop()).report.status, 'recorded');
  assert.equal(f.audio.stopped, false);
});

test('a recorder start error releases owned video tracks without stopping audio', () => {
  const f = fixture();
  f.Recorder.prototype.start = () => { throw new Error('capture failed'); };
  assert.throws(() => f.recorder.start(f.stream, 'local'), /capture failed/);
  assert.equal(f.recorder.active, null);
  assert.equal(f.video.stopped, true);
  assert.equal(f.audio.stopped, false);
});

test('Lingxi recording retains engine provenance and does not stop its microphone', async t => {
  const f = fixture();
  t.after(() => f.recorder.stop());
  f.recorder.start(f.stream, 'lingxi');
  const result = await f.recorder.stop();
  assert.equal(result.report.engine, 'lingxi');
  assert.equal(result.report.kind, 'microphone');
  assert.equal(f.audio.stopped, false);
});
