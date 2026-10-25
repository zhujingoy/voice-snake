import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PcmEncoder, pcmBase64, AudioTimeline } from '../src/pcm.mjs';

test('PCM is clipped, signed little-endian and Base64 encodes exactly those bytes', () => {
  const samples = new Float32Array(256);
  samples.set([-2, -1, -.5, 0, .5, 1, 2]);
  const [bytes] = new PcmEncoder(16000).push(samples);
  assert.deepEqual([...bytes.slice(0, 14)], [0, 128, 0, 128, 0, 192, 0, 0, 0, 64, 255, 127, 255, 127]);
  assert.deepEqual(Buffer.from(pcmBase64(bytes), 'base64'), Buffer.from(bytes));
  assert.throws(() => new PcmEncoder(0), /sample_rate/);
  assert.throws(() => new PcmEncoder(16000).push([NaN]), /audio/);
});

test('44.1k and 48k streaming resampling is invariant to input chunk boundaries', () => {
  for (const rate of [44100, 48000]) {
    const samples = Float32Array.from({ length: rate }, (_, i) => Math.sin(2 * Math.PI * 440 * i / rate));
    const all = Buffer.concat(new PcmEncoder(rate).push(samples).map(Buffer.from));
    const encoder = new PcmEncoder(rate), frames = [];
    for (let i = 0; i < samples.length; i += 137) frames.push(...encoder.push(samples.slice(i, i + 137)));
    assert.deepEqual(Buffer.concat(frames.map(Buffer.from)), all);
    assert.equal(all.length, Math.floor(16000 / 256) * 512);
    assert.notEqual(frames[0].buffer, frames[1].buffer);
  }
});

test('resampling preserves constant signal amplitude at either input rate', () => {
  for (const rate of [16000, 24000, 44100, 48000]) {
    const frames = new PcmEncoder(rate).push(new Float32Array(rate).fill(.25));
    for (const frame of frames) {
      const view = new DataView(frame.buffer);
      for (let i = 0; i < frame.length; i += 2) assert.equal(view.getInt16(i, true), 8192);
    }
  }
});

test('audio timeline preserves capture time across upload gaps and bounds history', () => {
  const timeline = new AudioTimeline();
  timeline.append(16, 1016, 1); timeline.append(16, 5016, 2);
  assert.deepEqual(timeline.locate(8), { at: 1008, epoch: 1 });
  assert.deepEqual(timeline.locate(24), { at: 5008, epoch: 2 });
  assert.equal(timeline.locate(33), null);
  for (let i = 0; i < 1100; i += 1) timeline.append(16, 5032 + 16 * i, 2);
  assert.equal(timeline.segments.length, 1024);
  assert.equal(timeline.locate(8), null);
});
