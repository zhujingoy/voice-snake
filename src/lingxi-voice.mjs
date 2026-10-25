import { AudioTimeline, PcmEncoder, PCM_RATE, PCM_SAMPLES, pcmBase64 } from './pcm.mjs';

const MAX_ITEMS = 256;
const INPUT_TTL_MS = 1500;
const MAX_BUFFERED_BYTES = 10000;
const MAX_CAPTURE_LAG_MS = 200;
const PREFIX = 'conversation.item.input_audio_transcription.';
const safeID = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sendingState = state => ['RUNNING', 'PAUSED', 'GAME_OVER'].includes(state);

export function matchesSession(actual, expected) {
  const input = actual?.audio?.input, turn = input?.turn_detection;
  return actual?.type === 'realtime' && input?.format?.type === 'audio/pcm' && input.format.rate === PCM_RATE &&
    isObject(input.transcription) && turn?.type === 'server_vad' && turn.create_response === false &&
    turn.interrupt_response === false && turn.prefix_padding_ms === expected.audio.input.turn_detection.prefix_padding_ms &&
    turn.silence_duration_ms === expected.audio.input.turn_detection.silence_duration_ms &&
    (!expected.model || actual.model === expected.model);
}

export class LingxiVoice {
  constructor({ onStatus, onText, onFailure, onLevel = () => {},
    onIssue = () => {}, getInputState,
    fetchImpl = globalThis.fetch?.bind(globalThis), WebSocket = globalThis.WebSocket,
    mediaDevices = globalThis.navigator?.mediaDevices, AudioContext = globalThis.AudioContext,
    AudioWorkletNode = globalThis.AudioWorkletNode, now = () => performance.now(), wallNow = Date.now,
    endpoint = new URL('../api/lingxi/session', import.meta.url).href }) {
    Object.assign(this, { onStatus, onText, onFailure, onLevel, onIssue, getInputState,
      fetchImpl, WebSocket, mediaDevices, AudioContext, AudioWorkletNode, now, wallNow, endpoint });
    this.active = null;
    this.generation = 0;
  }

  getMediaStream() { return this.active?.stream || null; }

  async credentials(active) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.fetchImpl(this.endpoint, { method: 'POST', cache: 'no-store',
        credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: active.abort.signal });
      if (!response.ok) {
        let code;
        try { code = (await response.json()).error?.code; } catch {}
        const allowed = ['lingxi_not_configured', 'lingxi_auth_failed', 'lingxi_quota', 'lingxi_timeout', 'session_rate_limited', 'origin_not_allowed'];
        throw new Error(allowed.includes(code) ? code : 'lingxi_unavailable');
      }
      const data = await response.json();
      let endpoint;
      try { endpoint = new URL(data.endpoint); } catch { throw new Error('lingxi_invalid_response'); }
      if (endpoint.protocol !== 'wss:' || endpoint.username || endpoint.password || endpoint.hash ||
          !endpoint.pathname.endsWith('/v1/realtime') || [...endpoint.searchParams.keys()].some(key => key !== 'model') ||
          typeof data.credential !== 'string' || !/^ek_[A-Za-z0-9_-]+$/.test(data.credential) || data.credential.length > 8192 ||
          !Number.isFinite(data.expiresAtMs) || !matchesSession(data.session, {
            audio: { input: { turn_detection: { prefix_padding_ms: 100, silence_duration_ms: 200 } } },
          })) throw new Error('lingxi_invalid_response');
      if (data.expiresAtMs > this.wallNow() + 5000) return data;
    }
    throw new Error('lingxi_credential_expired');
  }

  async start() {
    if (this.active) return false;
    if (!this.WebSocket || !this.AudioContext || !this.AudioWorkletNode || !this.mediaDevices?.getUserMedia || !this.fetchImpl) {
      this.onFailure('lingxi_unsupported'); return false;
    }
    const active = { generation: ++this.generation, abort: new AbortController(),
      timeline: new AudioTimeline(), items: new Map(), finished: new Set(), ready: false };
    active.started = new Promise(resolve => { active.resolve = resolve; });
    this.active = active;
    active.timer = setTimeout(() => { if (this.active === active) this.fail('lingxi_timeout'); }, 45000);
    this.onStatus('starting');
    try {
      active.context = new this.AudioContext({ sampleRate: PCM_RATE, latencyHint: 'interactive' });
      await active.context.resume();
      if (this.active !== active) return false;
      active.clockOrigin = this.now() - active.context.currentTime * 1000;
      active.encoder = new PcmEncoder(active.context.sampleRate);
      this.onStatus('microphone');
      const stream = await this.mediaDevices.getUserMedia({ video: false, audio: {
        channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      } });
      if (this.active !== active) { stream.getTracks().forEach(track => track.stop()); return false; }
      active.stream = stream;
      for (const track of stream.getTracks()) track.onended = () => { if (this.active === active) this.fail('audio-capture'); };
      active.context.onstatechange = () => {
        if (this.active === active && active.context.state !== 'running') this.fail('audio_suspended');
      };
      await active.context.audioWorklet.addModule(new URL('../audio-capture.mjs', import.meta.url).href);
      if (this.active !== active) return false;
      active.source = active.context.createMediaStreamSource(stream);
      active.capture = new this.AudioWorkletNode(active.context, 'voice-capture');
      active.mute = active.context.createGain(); active.mute.gain.value = 0;
      active.capture.port.onmessage = ({ data }) => { if (this.active === active) this.capture(active, data); };
      active.source.connect(active.capture); active.capture.connect(active.mute); active.mute.connect(active.context.destination);
      this.onStatus('connecting');
      const bootstrap = await this.credentials(active);
      if (this.active !== active) return false;
      active.expected = bootstrap.session;
      active.socket = new this.WebSocket(bootstrap.endpoint, ['realtime', `openai-insecure-api-key.${bootstrap.credential}`]);
      active.socket.onmessage = event => {
        if (this.active !== active) return;
        try {
          if (typeof event.data !== 'string' || event.data.length > 262144) throw new Error('invalid_event');
          this.receive(active, JSON.parse(event.data));
        } catch { if (this.active === active) this.fail('lingxi_protocol_error'); }
      };
      active.socket.onerror = () => { if (this.active === active) this.fail('lingxi_network'); };
      active.socket.onclose = () => { if (this.active === active) this.fail('disconnected'); };
      return await active.started;
    } catch (error) {
      if (this.active === active) this.fail(error.name === 'NotAllowedError' ? 'not-allowed' :
        /^lingxi_|^session_rate_limited$|^origin_not_allowed$/.test(error.message) ? error.message : 'audio-capture');
      return false;
    }
  }

  send(active, event) {
    if (this.active !== active) return false;
    try {
      if (active.socket.readyState !== 1) throw new Error('closed');
      if (active.socket.bufferedAmount > MAX_BUFFERED_BYTES) { this.fail('lingxi_backpressure'); return false; }
      active.socket.send(JSON.stringify(event)); return true;
    } catch { this.fail('lingxi_network'); return false; }
  }

  capture(active, { samples, level, contextTime }) {
    this.onLevel(level);
    const state = this.getInputState();
    if (!active.ready || !sendingState(state.state) || !state.focused || !state.visible) {
      active.encoder = new PcmEncoder(active.context.sampleRate); return;
    }
    if (!Number.isFinite(contextTime)) { this.fail('lingxi_audio_clock'); return; }
    const capturedEnd = active.clockOrigin + contextTime * 1000;
    if (this.now() - capturedEnd > MAX_CAPTURE_LAG_MS || capturedEnd > this.now() + 50) {
      this.fail('lingxi_backpressure'); return;
    }
    try {
      const frames = active.encoder.push(samples);
      const duration = PCM_SAMPLES / PCM_RATE * 1000;
      frames.forEach((bytes, i) => {
        if (this.send(active, { type: 'input_audio_buffer.append', audio: pcmBase64(bytes) })) {
          active.timeline.append(duration, capturedEnd - (frames.length - i - 1) * duration, state.epoch);
        }
      });
    } catch { this.fail('audio-capture'); }
  }

  receive(active, event) {
    if (!isObject(event) || typeof event.type !== 'string') throw new Error('invalid_event');
    if (event.type === 'error') { this.fail('lingxi_service_error'); return; }
    if (event.type === 'session.created') {
      if (active.sessionID || !safeID(event.session?.id)) throw new Error('invalid_session');
      active.sessionID = event.session.id;
      this.send(active, { type: 'session.update', event_id: `voice-snake-init-${active.generation}`, session: active.expected });
      return;
    }
    if (event.type === 'session.updated') {
      if (!active.sessionID || event.session?.id !== active.sessionID || !matchesSession(event.session, active.expected)) {
        this.fail('lingxi_config_mismatch'); return;
      }
      if (active.ready) return;
      active.ready = true; clearTimeout(active.timer); active.resolve(true); this.onStatus('listening'); return;
    }
    if (event.type.startsWith('response.')) { this.fail('lingxi_unexpected_response'); return; }
    if (!active.ready) return;
    if (event.type === 'input_audio_buffer.speech_started') {
      if (!safeID(event.item_id) || !Number.isFinite(event.audio_start_ms)) throw new Error('invalid_item');
      if (active.finished.has(event.item_id) || active.items.has(event.item_id)) return;
      if (active.items.size >= MAX_ITEMS) { this.fail('lingxi_protocol_error'); return; }
      active.items.set(event.item_id, { start: active.timeline.locate(event.audio_start_ms), end: null });
    } else if (event.type === 'input_audio_buffer.speech_stopped') {
      const item = active.items.get(event.item_id);
      if (item) item.end = active.timeline.locate(event.audio_end_ms);
    } else if (event.type === PREFIX + 'completed' || event.type === PREFIX + 'failed') {
      if (!safeID(event.item_id) || event.content_index !== 0) throw new Error('invalid_item');
      if (active.finished.has(event.item_id)) return;
      const item = active.items.get(event.item_id);
      active.items.delete(event.item_id); active.finished.add(event.item_id);
      if (active.finished.size > MAX_ITEMS) active.finished.delete(active.finished.values().next().value);
      const state = this.getInputState();
      const valid = item?.start && item.end && item.start.epoch === state.epoch && item.end.epoch === state.epoch &&
        item.start.at >= state.boundaryAt && item.end.at >= item.start.at && this.now() - item.end.at <= INPUT_TTL_MS &&
        state.focused && state.visible && sendingState(state.state);
      // Delete settled conversation audio after capturing the result; pending items remain untouched.
      if (!this.send(active, { type: 'conversation.item.delete', item_id: event.item_id })) return;
      if (!valid) { this.onIssue('old_interaction'); return; }
      if (event.type.endsWith('.failed')) { this.onIssue('lingxi_transcription_failed'); return; }
      if (typeof event.transcript !== 'string' || event.transcript.length > 8192) throw new Error('invalid_transcript');
      this.onText({ text: event.transcript, resultId: `lingxi:${active.generation}:${active.sessionID}:${event.item_id}:0`,
        receivedAt: this.now(), isFinal: true, source: 'lingxi', inputEpoch: state.epoch, audioEndAt: item.end.at });
    }
  }

  fail(reason) { this.stop(); this.onFailure(reason); }

  stop() {
    const active = this.active; this.active = null;
    if (active) {
      clearTimeout(active.timer); active.abort.abort(); active.resolve(false);
      if (active.socket) {
        active.socket.onmessage = active.socket.onerror = active.socket.onclose = null;
        try { active.socket.close(1000, 'game_stopped'); } catch {}
      }
      if (active.capture) { active.capture.port.onmessage = null; active.capture.disconnect(); }
      active.source?.disconnect(); active.mute?.disconnect();
      active.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
      if (active.context) { active.context.onstatechange = null; active.context.close().catch(() => {}); }
    }
    this.onLevel(0); this.onStatus('stopped');
  }
}
