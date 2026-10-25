export const PCM_RATE = 16000;
export const PCM_SAMPLES = 256;

// Integrate input samples over each output interval; retain phase across chunks.
export class PcmEncoder {
  constructor(inputRate, outputRate = PCM_RATE) {
    if (![inputRate, outputRate].every(n => Number.isFinite(n) && n >= 8000 && n <= 96000)) throw new Error('invalid_sample_rate');
    this.ratio = inputRate / outputRate;
    this.remaining = this.ratio;
    this.sum = 0;
    this.offset = 0;
    this.bytes = new Uint8Array(PCM_SAMPLES * 2);
  }

  push(samples) {
    const frames = [];
    for (const sample of samples) {
      if (!Number.isFinite(sample)) throw new Error('invalid_audio');
      let available = 1;
      while (available > 1e-9) {
        const take = Math.min(available, this.remaining);
        this.sum += Math.max(-1, Math.min(1, sample)) * take;
        this.remaining -= take; available -= take;
        if (this.remaining < 1e-9) {
          const value = this.sum / this.ratio;
          const pcm = Math.round(value * (value < 0 ? 32768 : 32767));
          this.bytes[this.offset++] = pcm & 255;
          this.bytes[this.offset++] = (pcm >> 8) & 255;
          this.remaining = this.ratio; this.sum = 0;
          if (this.offset === this.bytes.length) {
            frames.push(this.bytes); this.bytes = new Uint8Array(PCM_SAMPLES * 2); this.offset = 0;
          }
        }
      }
    }
    return frames;
  }
}

export function pcmBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

// Source positions are in milliseconds of audio actually sent, not wall time.
export class AudioTimeline {
  constructor() { this.end = 0; this.segments = []; }
  append(duration, capturedEnd, epoch) {
    this.segments.push({ start: this.end, end: this.end + duration, at: capturedEnd - duration, epoch });
    this.end += duration;
    while (this.segments.length > 1024) this.segments.shift();
  }
  locate(position) {
    if (!Number.isFinite(position) || position < 0 || position > this.end + .1) return null;
    const segment = this.segments.find(s => position >= s.start && position <= s.end);
    return segment ? { at: segment.at + position - segment.start, epoch: segment.epoch } : null;
  }
}
