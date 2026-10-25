export class SessionRecorder {
  constructor({ board, snapshot, feedback, kind = 'microphone',
    Recorder = globalThis.MediaRecorder, Stream = globalThis.MediaStream,
    now = () => performance.now(), onStatus = () => {} }) {
    Object.assign(this, { board, snapshot, feedback, kind, Recorder, Stream, now, onStatus });
    this.active = null;
    this.result = null;
  }

  start(microphone, engine) {
    if (this.active) throw new Error('already_recording');
    if (!this.Recorder || !this.board.captureStream) throw new Error('recording_unsupported');
    const audio = microphone?.getAudioTracks().filter(track => track.readyState === 'live') || [];
    if (!audio.length || !['local', 'lingxi'].includes(engine)) throw new Error('microphone_required');
    const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm']
      .find(type => this.Recorder.isTypeSupported(type));
    if (!mimeType) throw new Error('recording_unsupported');
    const canvas = document.createElement('canvas');
    canvas.width = 1000; canvas.height = 1000;
    const video = canvas.captureStream(30);
    const stream = new this.Stream([...video.getVideoTracks(), ...audio]);
    const recorder = new this.Recorder(stream, { mimeType, videoBitsPerSecond: 2400000 });
    const active = { recorder, video, canvas, chunks: [], events: [], startedAt: this.now(),
      startedAtISO: new Date().toISOString(), engine, audio };
    this.active = active;
    this.result = null;
    active.finished = new Promise(resolve => { active.resolve = resolve; });
    recorder.ondataavailable = event => { if (event.data.size) active.chunks.push(event.data); };
    recorder.onerror = () => { active.failed = true; this.stop(); };
    recorder.onstop = () => {
      clearInterval(active.timer); clearTimeout(active.limit);
      video.getTracks().forEach(track => track.stop());
      audio.forEach(track => track.removeEventListener('ended', active.ended));
      // Audio tracks belong to the voice adapter, not the recorder.
      this.result = {
        video: new Blob(active.chunks, { type: mimeType }),
        report: { kind: this.kind, engine, startedAt: active.startedAtISO,
          durationMs: Math.round(this.now() - active.startedAt),
          status: active.failed ? 'failed' : 'recorded', events: active.events,
          endToEndLatency: 'not_measured', microphoneAccuracy: 'not_automatically_scored' },
      };
      this.active = null;
      this.onStatus(active.failed ? 'failed' : 'recorded');
      active.resolve(this.result);
    };
    active.ended = () => this.stop();
    audio.forEach(track => track.addEventListener('ended', active.ended));
    this.paint();
    try {
      recorder.start(250);
      active.timer = setInterval(() => this.paint(), 1000 / 30);
      active.limit = setTimeout(() => this.stop(), 5 * 60 * 1000);
    } catch (error) {
      this.active = null;
      video.getTracks().forEach(track => track.stop());
      audio.forEach(track => track.removeEventListener('ended', active.ended));
      throw error;
    }
    this.onStatus('recording');
  }

  event(type, data) {
    if (!this.active) return;
    if (this.active.events.length >= 5000) { this.stop(); return; }
    this.active.events.push({ atMs: Math.round(this.now() - this.active.startedAt), type, ...data });
  }

  paint() {
    if (!this.active) return;
    const { canvas, startedAt } = this.active;
    const ctx = canvas.getContext('2d'), s = this.snapshot(), f = this.feedback();
    ctx.fillStyle = '#f4f7f4'; ctx.fillRect(0, 0, 1000, 1000);
    ctx.fillStyle = '#173b29'; ctx.font = 'bold 28px sans-serif';
    ctx.fillText('VOICE SNAKE', 36, 46);
    ctx.fillStyle = this.kind === 'synthetic' ? '#a13e26' : '#148451';
    ctx.font = '22px sans-serif';
    const engine = this.active.engine === 'lingxi' ? '灵矽 Realtime' : '本地 Vosk';
    ctx.fillText(this.kind === 'synthetic' ? `合成音频预演 · ${engine} · 非真人验收` : `麦克风录制 · ${engine} · 未自动评分`, 36, 84);
    ctx.fillStyle = '#173b29'; ctx.font = '20px sans-serif';
    ctx.fillText(`${s.state}   得分 ${s.score}   蛇长 ${s.snake.length}`, 36, 120);
    ctx.fillText(`${((this.now() - startedAt) / 1000).toFixed(1)}s`, 870, 46);
    ctx.drawImage(this.board, 160, 146, 680, 680);
    ctx.font = '22px sans-serif';
    ctx.fillText(`识别：${(f.text || '—').slice(0, 32)}`, 36, 872);
    ctx.fillText(`命令：${f.command || '—'}    ${f.receipt || ''}`, 36, 912);
    ctx.font = '18px sans-serif'; ctx.fillStyle = '#56665a';
    ctx.fillText('原始音轨随录像保存；端到端延迟需人工标注，不以模块耗时代替。', 36, 958);
  }

  stop() {
    const active = this.active;
    if (!active) return Promise.resolve(this.result);
    if (active.recorder.state !== 'inactive') {
      this.paint();
      active.recorder.stop();
    }
    return active.finished;
  }
}
