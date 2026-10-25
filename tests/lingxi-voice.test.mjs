import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LingxiVoice } from '../src/lingxi-voice.mjs';
import { GameSession } from '../src/session.mjs';

const sessionConfig = () => ({ type: 'realtime', output_modalities: ['text'], audio: { input: {
  format: { type: 'audio/pcm', rate: 16000 }, transcription: {}, turn_detection: {
    type: 'server_vad', create_response: false, interrupt_response: false, prefix_padding_ms: 100, silence_duration_ms: 200,
  },
} } });

function fixture(t, overrides = {}) {
  let time = 1000;
  const state = { state: 'RUNNING', epoch: 1, boundaryAt: 900, focused: true, visible: true };
  const received = [], failures = [], issues = [], statuses = [], sockets = [];
  const track = { stopped: false, stop() { this.stopped = true; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const node = () => ({ connect() {}, disconnect() { this.disconnected = true; }, gain: { value: 1 } });
  class Context {
    constructor() { this.sampleRate = 16000; this.currentTime = 0; this.state = 'running'; this.audioWorklet = { addModule: async () => {} }; }
    async resume() {}
    createMediaStreamSource() { return node(); }
    createGain() { return node(); }
    async close() { this.state = 'closed'; }
  }
  class Capture { constructor() { Object.assign(this, node()); this.port = {}; } }
  class Socket {
    constructor(url, protocols) { Object.assign(this, { url, protocols, readyState: 1, bufferedAmount: 0, sent: [] }); sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; }
    emit(event) { this.onmessage?.({ data: JSON.stringify(event) }); }
  }
  const voice = new LingxiVoice({ WebSocket: Socket, AudioContext: Context, AudioWorkletNode: Capture,
    mediaDevices: { getUserMedia: async () => stream }, now: () => time, wallNow: () => 1000000,
    getInputState: () => state, onStatus: s => statuses.push(s), onText: r => received.push(r),
    onFailure: r => failures.push(r), onIssue: r => issues.push(r),
    fetchImpl: async () => new Response(JSON.stringify({ endpoint: 'wss://lingxi.example/v1/realtime',
      credential: 'ek_test', expiresAtMs: 1120000, session: sessionConfig() })), ...overrides });
  t.after(() => voice.stop());
  const connect = async () => {
    const started = voice.start();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sockets.length, 1);
    const socket = sockets[0];
    socket.emit({ type: 'session.created', session: { id: 'session-test' } });
    socket.emit({ type: 'session.updated', session: { id: 'session-test', ...sessionConfig() } });
    assert.equal(await started, true);
    return socket;
  };
  const audio = (count = 10) => {
    for (let i = 0; i < count; i++) {
      time += 16;
      voice.active.capture.port.onmessage({ data: { samples: new Float32Array(256).fill(.1), level: .1, contextTime: (time - 1000) / 1000 } });
    }
  };
  const utterance = (id = 'item1', start = 0, end = 160) => {
    sockets[0].emit({ type: 'input_audio_buffer.speech_started', item_id: id, audio_start_ms: start });
    sockets[0].emit({ type: 'input_audio_buffer.speech_stopped', item_id: id, audio_end_ms: end });
  };
  const final = (id = 'item1', text = '上') => sockets[0].emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, content_index: 0, transcript: text });
  return { voice, state, statuses, sockets, failures, issues, received, track, connect, audio, utterance, final, setTime: t => { time = t; } };
}

test('waits for session.updated and sends no audio during READY countdown', async t => {
  const f = fixture(t);
  const started = f.voice.start(); await new Promise(resolve => setImmediate(resolve));
  assert.ok(!f.statuses.includes('listening'));
  const ws = f.sockets[0];
  assert.deepEqual(ws.protocols, ['realtime', 'openai-insecure-api-key.ek_test']);
  assert.ok(!ws.url.includes('ek_'));
  ws.emit({ type: 'session.created', session: { id: 'session-test' } });
  assert.equal(ws.sent[0].type, 'session.update');
  f.audio(); assert.equal(ws.sent.length, 1);
  ws.emit({ type: 'session.updated', session: { id: 'session-test', ...sessionConfig() } });
  assert.equal(await started, true);
  f.state.state = 'READY'; f.audio(); assert.equal(ws.sent.length, 1);
  f.state.state = 'RUNNING'; f.audio();
  assert.equal(ws.sent.filter(e => e.type === 'input_audio_buffer.append').length, 10);
});

test('only completed transcription executes once; repeated text on a new item remains usable', async t => {
  const f = fixture(t); const ws = await f.connect(); f.audio(); f.utterance();
  ws.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item1', content_index: 0, delta: '上' });
  ws.emit({ type: 'conversation.item.done', item: { role: 'assistant', content: [{ text: '右' }] } });
  assert.equal(f.received.length, 0);
  f.final(); f.final();
  assert.equal(f.received.length, 1);
  assert.equal(f.received[0].isFinal, true);
  assert.equal(f.received[0].source, 'lingxi');
  assert.equal(f.received[0].audioEndAt, 1160);
  assert.equal(ws.sent.filter(e => e.type === 'conversation.item.delete').length, 1);
  f.audio(); f.utterance('item2', 160, 320); f.final('item2');
  assert.equal(f.received.length, 2);
  assert.notEqual(f.received[0].resultId, f.received[1].resultId);
});

test('late final cannot cross a round boundary or acquire fresh timestamps on arrival', async t => {
  const f = fixture(t); await f.connect(); f.audio(); f.utterance();
  f.state.epoch++; f.state.boundaryAt = 1160;
  f.final(); assert.equal(f.received.length, 0);
  f.audio(); f.utterance('item2', 180, 320);
  f.setTime(4000); f.final('item2');
  assert.equal(f.received.length, 0);
  assert.deepEqual(f.issues, ['old_interaction', 'old_interaction']);
});

test('unknown speech timing is rejected instead of executing an untraceable final', async t => {
  const f = fixture(t); await f.connect(); f.audio(); f.final();
  assert.equal(f.received.length, 0);
  assert.deepEqual(f.issues, ['old_interaction']);
});

test('ASR failed pauses through issue callback but retains a healthy microphone connection', async t => {
  const f = fixture(t); const ws = await f.connect(); f.audio(); f.utterance();
  ws.emit({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'item1', content_index: 0 });
  assert.deepEqual(f.issues, ['lingxi_transcription_failed']);
  assert.equal(f.voice.active.ready, true);
  assert.deepEqual(f.failures, []);
});

test('config mismatch and unexpected generated responses stop the channel', async t => {
  const f = fixture(t); const ws = await f.connect();
  const wrong = sessionConfig(); wrong.audio.input.turn_detection.create_response = true;
  ws.emit({ type: 'session.updated', session: { id: 'session-test', ...wrong } });
  assert.deepEqual(f.failures, ['lingxi_config_mismatch']);
  assert.equal(f.track.stopped, true);
  const g = fixture(t); const other = await g.connect();
  other.emit({ type: 'response.created', response: { id: 'response1' } });
  assert.deepEqual(g.failures, ['lingxi_unexpected_response']);
});

test('backpressure and delayed capture stop instead of replaying stale audio', async t => {
  const f = fixture(t); const ws = await f.connect(); ws.bufferedAmount = 10001; f.audio(1);
  assert.deepEqual(f.failures, ['lingxi_backpressure']);
  const g = fixture(t); await g.connect(); g.setTime(2000);
  g.voice.active.capture.port.onmessage({ data: { samples: new Float32Array(256), level: 0, contextTime: .016 } });
  assert.deepEqual(g.failures, ['lingxi_backpressure']);
});

test('stop cancels pending authorization and late media acquisition releases its stream', async t => {
  let resolve;
  const f = fixture(t, { mediaDevices: { getUserMedia: () => new Promise(r => { resolve = r; }) } });
  const started = f.voice.start(); await new Promise(r => setImmediate(r));
  f.voice.stop(); resolve({ getTracks: () => [f.track] });
  assert.equal(await started, false);
  assert.equal(f.track.stopped, true);
  assert.equal(f.sockets.length, 0);
});

test('stop ignores queued events, closes audio and returns media ownership to the adapter', async t => {
  const f = fixture(t); const ws = await f.connect(); f.audio(); f.utterance();
  const receive = ws.onmessage, active = f.voice.active;
  assert.ok(f.voice.getMediaStream());
  f.voice.stop();
  receive({ data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item1', content_index: 0, transcript: '上' }) });
  assert.equal(f.received.length, 0);
  assert.equal(active.context.state, 'closed'); assert.equal(ws.readyState, 3);
  assert.equal(f.voice.getMediaStream(), null);
});

test('expired credentials are requested at most twice and raw errors are not exposed', async t => {
  let calls = 0;
  const f = fixture(t, { fetchImpl: async () => { calls++; return new Response(JSON.stringify({
    endpoint: 'wss://lingxi.example/v1/realtime', credential: 'ek_expired', expiresAtMs: 1, session: sessionConfig(),
  })); } });
  assert.equal(await f.voice.start(), false);
  assert.equal(calls, 2); assert.deepEqual(f.failures, ['lingxi_credential_expired']);
  const g = fixture(t, { fetchImpl: async () => new Response('{"error":{"code":"secret-in-error"}}', { status: 502 }) });
  assert.equal(await g.voice.start(), false);
  assert.deepEqual(g.failures, ['lingxi_unavailable']);
});

test('GameSession independently rejects expired and cross-epoch Lingxi input', () => {
  let now = 1000;
  const session = new GameSession({ now: () => now, countdownMs: 0 });
  session.setListening(true); session.requestStart(); session.update();
  const context = session.inputContext();
  const input = { text: '暂停', resultId: '1', receivedAt: now, isFinal: true, source: 'lingxi', inputEpoch: context.epoch, audioEndAt: now };
  assert.equal(session.receive({ ...input, inputEpoch: context.epoch - 1 }).accepted, false);
  now += 1600;
  assert.equal(session.receive({ ...input, receivedAt: now }).accepted, false);
  assert.equal(session.receive({ ...input, resultId: '2', receivedAt: now, audioEndAt: now }).accepted, true);
  assert.equal(session.engine.state, 'PAUSED');
});
