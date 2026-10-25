class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(256);
    this.offset = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const sample of channel) {
      this.samples[this.offset++] = sample;
      if (this.offset === this.samples.length) {
        const samples = this.samples;
        const level = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
        this.port.postMessage({ samples, level }, [samples.buffer]);
        this.samples = new Float32Array(256);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('voice-capture', VoiceCapture);
