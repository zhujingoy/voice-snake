// Match the Chinese model's word segmentation; include rejection phrases and OOV.
const grammar = JSON.stringify([
  '上', '下', '左', '右', '向上', '向下', '向 左', '向 右',
  '往 上', '往 下', '往 左', '往 右', '暂停', '停 一下',
  '继续', '继续 游戏', '重新 开始', '再来 一局', '结束 游戏', '不 玩 了',
  '不要 向上', '不要 向下', '不要 向 左', '不要 向 右',
  '上 还是 下', '左 还是 右', '[unk]',
]);

export class LocalVoice {
  constructor({ Vosk, onStatus, onText, onFailure, onLevel = () => {},
    mediaDevices = globalThis.navigator?.mediaDevices,
    AudioContext = globalThis.AudioContext, AudioWorkletNode = globalThis.AudioWorkletNode,
    now = () => performance.now() }) {
    Object.assign(this, { Vosk, onStatus, onText, onFailure, onLevel,
      mediaDevices, AudioContext, AudioWorkletNode, now });
    this.generation = 0;
    this.active = null;
    this.model = null;
    this.modelPromise = null;
  }

  loadModel() {
    if (!this.modelPromise) {
      this.modelPromise = new Promise((resolve, reject) => {
        const model = new this.Vosk.Model(new URL('../models/chinese-fast-v1.tar.gz', import.meta.url).href, -1);
        const timer = setTimeout(() => {
          model.terminate();
          reject(new Error('model_timeout'));
        }, 90000);
        model.on('load', message => {
          clearTimeout(timer);
          if (message.result) { this.model = model; resolve(model); }
          else { model.terminate(); reject(new Error('model_unavailable')); }
        });
        model.on('error', () => {
          clearTimeout(timer);
          if (this.model === model) {
            this.model = null; this.modelPromise = null;
            model.terminate();
            if (this.active) this.fail('recognition_error');
          } else { model.terminate(); reject(new Error('model_unavailable')); }
        });
      }).catch(error => { this.modelPromise = null; throw error; });
    }
    return this.modelPromise;
  }

  async start() {
    if (this.active) return false;
    if (!this.Vosk || !this.AudioContext || !this.AudioWorkletNode || !this.mediaDevices?.getUserMedia) {
      this.onFailure('local_unsupported'); return false;
    }
    const generation = ++this.generation;
    const active = { generation };
    this.active = active;
    this.onStatus('starting');
    try {
      active.context = new this.AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
      await active.context.resume();
      const model = await this.loadModel();
      if (this.active !== active) return false;
      this.onStatus('microphone');
      const stream = await this.mediaDevices.getUserMedia({ video: false, audio: {
        channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      } });
      if (this.active !== active) { stream.getTracks().forEach(track => track.stop()); return false; }
      active.stream = stream;
      await active.context.audioWorklet.addModule(new URL('../audio-capture.mjs', import.meta.url).href);
      if (this.active !== active) return false;
      const recognizer = active.recognizer = new model.KaldiRecognizer(active.context.sampleRate, grammar);
      let utterance = 0, lastPartial = '', speaking = false, silenceMs = 0;
      const text = (value, isFinal) => {
        if (this.active !== active) return;
        this.onText({ text: value, resultId: `local:${generation}:${utterance}`,
          receivedAt: this.now(), isFinal, source: 'local' });
      };
      recognizer.on('partialresult', message => {
        const partial = message.result.partial || '';
        if (partial !== lastPartial) { lastPartial = partial; text(partial, false); }
      });
      recognizer.on('result', message => {
        text(message.result.text || '', true);
        utterance += 1; lastPartial = '';
      });
      active.source = active.context.createMediaStreamSource(stream);
      active.capture = new this.AudioWorkletNode(active.context, 'voice-capture');
      active.mute = active.context.createGain();
      active.mute.gain.value = 0;
      active.capture.port.onmessage = ({ data }) => {
        if (this.active !== active) return;
        try {
          this.onLevel(data.level);
          recognizer.acceptWaveformFloat(data.samples, active.context.sampleRate);
          // Flush short isolated commands instead of waiting for a long ASR endpoint.
          if (data.level >= .008) { speaking = true; silenceMs = 0; }
          else if (speaking) {
            silenceMs += data.samples.length / active.context.sampleRate * 1000;
            if (silenceMs >= 128) {
              recognizer.retrieveFinalResult();
              speaking = false; silenceMs = 0;
            }
          }
        } catch { this.fail('recognition_error'); }
      };
      active.context.onstatechange = () => {
        if (this.active === active && active.context.state !== 'running') this.fail('audio_suspended');
      };
      stream.getTracks().forEach(track => {
        track.onended = () => { if (this.active === active) this.fail('audio-capture'); };
      });
      active.source.connect(active.capture);
      active.capture.connect(active.mute);
      active.mute.connect(active.context.destination);
      this.onStatus('listening');
      return true;
    } catch (error) {
      if (this.active === active) this.fail(error.name === 'NotAllowedError' ? 'not-allowed' :
        error.message?.startsWith('model_') ? error.message : 'audio-capture');
      return false;
    }
  }

  fail(reason) { this.stop(); this.onFailure(reason); }

  getMediaStream() { return this.active?.stream || null; }

  stop() {
    const active = this.active;
    this.active = null;
    if (active) {
      if (active.capture) { active.capture.port.onmessage = null; active.capture.disconnect(); }
      active.source?.disconnect(); active.mute?.disconnect();
      active.stream?.getTracks().forEach(track => track.stop());
      active.recognizer?.remove();
      active.context?.close().catch(() => {});
    }
    this.onLevel(0);
    this.onStatus('stopped');
  }
}
