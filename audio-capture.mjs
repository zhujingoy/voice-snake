class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(256);
    this.offset = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i += 1) {
      const sample = channel[i];
      this.samples[this.offset++] = sample;
      if (this.offset === this.samples.length) {
        const samples = this.samples;
        const level = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
        const contextTime = typeof currentFrame === 'number' ? (currentFrame + i + 1) / sampleRate : null;
        this.port.postMessage({ samples, level, contextTime }, [samples.buffer]);
        this.samples = new Float32Array(256);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('voice-capture', VoiceCapture);
