import { describe, expect, it } from 'vitest';
import { FFT, FRAME, HOP, noiseProfile, SpectralGate } from '../../src/core/dsp';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

/** Run a gate over a whole signal with the same framing the worker uses. */
function runGate(x: Float32Array, gate: SpectralGate): Float32Array {
  const y = new Float32Array(x.length);
  const frame = new Float32Array(FRAME);
  for (let k = -3; k * HOP < x.length; k++) {
    for (let i = 0; i < FRAME; i++) {
      const n = k * HOP + i;
      frame[i] = n >= 0 && n < x.length ? x[n] : 0;
    }
    const out = gate.process(frame);
    if (k < 0) continue;
    for (let i = 0; i < HOP && k * HOP + i < x.length; i++) y[k * HOP + i] = out[i];
  }
  return y;
}

const rms = (a: Float32Array, from = 0, to = a.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / (to - from));
};

describe('FFT', () => {
  it('round-trips', () => {
    const f = new FFT(64);
    const re = Float32Array.from({ length: 64 }, (_, i) => Math.sin(i) + 0.3 * Math.cos(3 * i));
    const orig = re.slice();
    const im = new Float32Array(64);
    f.transform(re, im);
    f.transform(re, im, true);
    for (let i = 0; i < 64; i++) expect(re[i] / 64).toBeCloseTo(orig[i], 4);
  });
});

describe('spectral gate', () => {
  it('reconstructs the input when nothing is gated', () => {
    const r = rng(1);
    const x = Float32Array.from({ length: 48000 }, () => r() * 0.5);
    const gate = new SpectralGate(new Float32Array(FRAME / 2 + 1).fill(1e-12), { reductionDb: -30, thresholdDb: 0 });
    const y = runGate(x, gate);
    let maxErr = 0;
    for (let i = 0; i < x.length; i++) maxErr = Math.max(maxErr, Math.abs(y[i] - x[i]));
    expect(maxErr).toBeLessThan(1e-3);
  });

  it('suppresses steady noise and keeps a tone', () => {
    const sr = 48000;
    const r = rng(7);
    const n = sr * 3;
    const noise = Float32Array.from({ length: n }, () => r() * 0.05);
    const x = new Float32Array(n);
    // Tone only in the middle second; noise everywhere.
    for (let i = 0; i < n; i++) x[i] = noise[i] + (i >= sr && i < 2 * sr ? 0.3 * Math.sin((2 * Math.PI * 440 * i) / sr) : 0);
    const frames: Float32Array[] = [];
    for (let k = 0; (k + 1) * HOP + FRAME < n; k += 2) frames.push(x.slice(k * HOP, k * HOP + FRAME));
    const prof = noiseProfile(frames);
    const y = runGate(x, new SpectralGate(prof, { reductionDb: -18, thresholdDb: 6 }));
    const noiseBefore = rms(x, 0, sr * 0.9);
    const noiseAfter = rms(y, 0, sr * 0.9);
    expect(20 * Math.log10(noiseAfter / noiseBefore)).toBeLessThan(-10);
    const toneBefore = rms(x, sr * 1.2, sr * 1.8);
    const toneAfter = rms(y, sr * 1.2, sr * 1.8);
    expect(Math.abs(20 * Math.log10(toneAfter / toneBefore))).toBeLessThan(1.5);
  });
});
