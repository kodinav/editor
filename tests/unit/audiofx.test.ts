import { describe, expect, it } from 'vitest';
import { biquadCoeffs, Biquad, Compressor, Limiter, LoudnessMeter } from '../../src/engine/audioDsp';
import { AudioMixer } from '../../src/engine/audioMixer';
import { createAudioEffect } from '../../src/core/audioEffects';
import { createAudioClip, createProject } from '../../src/core/project';
import type { Asset, Project } from '../../src/core/types';
import { PcmSource } from '../../src/media/pcm';

const SR = 48000;

function sine(freq: number, amp: number, seconds: number, sr = SR): Float32Array {
  const x = new Float32Array(Math.round(seconds * sr));
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return x;
}
const peak = (a: Float32Array, from = 0, to = a.length) => {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i]));
  return m;
};
const db = (g: number) => 20 * Math.log10(g);

describe('loudness meter (BS.1770 / EBU R128)', () => {
  it('reads a -23 dBFS 1 kHz stereo sine as -23 LUFS (EBU Tech 3341 case 1)', () => {
    for (const sr of [48000, 44100]) {
      const m = new LoudnessMeter(sr);
      const x = sine(1000, Math.pow(10, -23 / 20), 20, sr);
      for (let i = 0; i < x.length; i += 4096) {
        const n = Math.min(4096, x.length - i);
        m.push(x.subarray(i, i + n), x.subarray(i, i + n), n);
      }
      expect(m.integrated()).toBeCloseTo(-23, 1);
    }
  });
  it('gates out silence, so pauses do not drag the reading down', () => {
    const m = new LoudnessMeter(SR);
    const tone = sine(1000, Math.pow(10, -20 / 20), 5);
    const silence = new Float32Array(SR * 10);
    m.push(tone, tone, tone.length);
    m.push(silence, silence, silence.length);
    expect(m.integrated()).toBeCloseTo(-20, 0);
  });
});

describe('filters and dynamics', () => {
  it('a low cut removes rumble and keeps the voice band', () => {
    const run = (f: number) => {
      const x = sine(f, 0.5, 1);
      const y = x.slice();
      new Biquad(biquadCoeffs('highpass', 400, SR)).process(x, y, x.length);
      return db(peak(x, SR / 2) / 0.5);
    };
    expect(run(50)).toBeLessThan(-30);
    expect(run(3000)).toBeGreaterThan(-0.5);
  });
  it('EQ shelves boost by the requested amount', () => {
    const x = sine(60, 0.1, 1);
    const y = x.slice();
    new Biquad(biquadCoeffs('lowshelf', 120, SR, 6)).process(x, y, x.length);
    expect(db(peak(x, SR / 2) / 0.1)).toBeCloseTo(6, 0);
  });
  it('a compressor turns loud passages down by the ratio', () => {
    const x = sine(500, Math.pow(10, -6 / 20), 1);
    const y = x.slice();
    new Compressor({ thresholdDb: -24, ratio: 4, attackMs: 5, releaseMs: 100, makeupDb: 0, kneeDb: 0 }, SR).process(x, y, x.length);
    // 18 dB over the threshold at 4:1 leaves 4.5 dB over: about -19.5 dBFS.
    expect(db(peak(x, SR / 2))).toBeCloseTo(-19.5, 0);
  });
  it('the limiter never lets a peak through', () => {
    const x = sine(220, 1.5, 1);
    const y = x.slice();
    const lim = new Limiter(0.5, SR);
    lim.process(x, y, x.length);
    expect(peak(x)).toBeLessThanOrEqual(0.5 + 1e-6);
    expect(peak(x, SR / 2)).toBeGreaterThan(0.45);
  });
});

/** A project with one audio clip playing a test signal through `fx`. */
function setup(signal: Float32Array, effects: ReturnType<typeof createAudioEffect>[]) {
  const p: Project = createProject('t');
  const asset: Asset = {
    id: 'a1',
    kind: 'audio',
    name: 'tone.wav',
    mimeType: 'audio/wav',
    size: 0,
    lastModified: 0,
    duration: signal.length / SR,
    audio: { sampleRate: SR, channels: 1, codec: 'pcm', conformed: true },
    status: 'ready',
    stored: true,
  } as Asset;
  p.assets[asset.id] = asset;
  const track = p.tracks.find((t) => t.kind === 'audio')!;
  const clip = createAudioClip(asset, { trackId: track.id, start: 0, duration: asset.duration });
  clip.audioEffects = effects;
  p.clips[clip.id] = clip;
  const i16 = new Int16Array(signal.length);
  for (let i = 0; i < signal.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(signal[i] * 32767)));
  const pcm = new PcmSource('t' + Math.random(), new Blob([i16.buffer]), SR, 1);
  const mixer = new AudioMixer({ getPcm: () => pcm }, SR);
  return { p, mixer };
}

async function render(mixer: AudioMixer, p: Project, t0: number, frames: number) {
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  await mixer.prepare(p, t0, frames);
  expect(mixer.mix(p, t0, frames, l, r)).toBe(true);
  return l;
}

describe('clip audio effects in the mixer', () => {
  // Noise-like test signal with lots of low end, so filter state matters.
  const signal = new Float32Array(SR * 3);
  let s = 1;
  for (let i = 0; i < signal.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    signal[i] = 0.3 * Math.sin((2 * Math.PI * 80 * i) / SR) + 0.2 * (s / 4294967296 - 0.5);
  }

  it('block-by-block playback equals one long render', async () => {
    const fx = [createAudioEffect('highpass'), createAudioEffect('compressor')];
    fx[0].params.frequency = 200;
    const a = setup(signal, fx);
    const whole = await render(a.mixer, a.p, 0, SR * 2);
    const b = setup(signal, fx);
    const pieces = new Float32Array(SR * 2);
    for (let i = 0; i < pieces.length; i += 1024) pieces.set(await render(b.mixer, b.p, i / SR, Math.min(1024, pieces.length - i)), i);
    let maxDiff = 0;
    for (let i = 0; i < whole.length; i++) maxDiff = Math.max(maxDiff, Math.abs(whole[i] - pieces[i]));
    expect(maxDiff).toBeLessThan(1e-5);
  });

  it('after a jump, the effect sounds as if it had been playing all along', async () => {
    const fx = [createAudioEffect('highpass')];
    fx[0].params.frequency = 200;
    const a = setup(signal, fx);
    const whole = await render(a.mixer, a.p, 0, SR * 2);
    const b = setup(signal, fx);
    const jumped = await render(b.mixer, b.p, 1.5, SR / 2);
    let maxDiff = 0;
    for (let i = 0; i < jumped.length; i++) maxDiff = Math.max(maxDiff, Math.abs(jumped[i] - whole[SR * 1.5 + i]));
    expect(maxDiff).toBeLessThan(1e-3);
  });

  it('really changes the sound: a low cut removes the 80 Hz hum', async () => {
    const dry = setup(signal, []);
    const fx = [createAudioEffect('highpass')];
    fx[0].params.frequency = 300;
    const wet = setup(signal, fx);
    const a = await render(dry.mixer, dry.p, 0.5, SR);
    const b = await render(wet.mixer, wet.p, 0.5, SR);
    const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
    expect(rms(b)).toBeLessThan(rms(a) * 0.5);
  });

  it('disabled effects are bypassed', async () => {
    const fx = [createAudioEffect('lowpass')];
    fx[0].enabled = false;
    const dry = setup(signal, []);
    const off = setup(signal, fx);
    const a = await render(dry.mixer, dry.p, 0, SR / 4);
    const b = await render(off.mixer, off.p, 0, SR / 4);
    expect(Array.from(b)).toEqual(Array.from(a));
  });
});

describe('limiter', () => {
  it('holds the ceiling on sudden transients and passes quiet audio untouched (after its delay)', () => {
    const n = SR;
    const x = new Float32Array(n);
    let s = 7;
    for (let i = 0; i < n; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      x[i] = (s / 4294967296 - 0.5) * (i % 9000 < 40 ? 4 : 0.2); // clicks 8x louder than the ceiling
    }
    const l = x.slice();
    const r = x.slice();
    const lim = new Limiter(0.25, SR, 5, 20);
    for (let i = 0; i < n; i += 777) lim.process(l.subarray(i, i + 777), r.subarray(i, i + 777), Math.min(777, n - i));
    expect(peak(l)).toBeLessThanOrEqual(0.25 + 1e-6);
    // Quiet audio well after a click (released) and before the next (no look-ahead yet) comes through, just delayed.
    const quiet = 8000;
    expect(Math.abs(l[quiet + lim.latency] - x[quiet])).toBeLessThan(1e-4);
  });
});

describe('reversed audio', () => {
  it('is the same samples in the opposite order, block by block', async () => {
    const signal = new Float32Array(SR);
    for (let i = 0; i < signal.length; i++) signal[i] = (i / signal.length) * 0.8 * Math.sin((2 * Math.PI * 300 * i) / SR);
    const { p, mixer } = setup(signal, []);
    (Object.values(p.clips)[0] as any).reversed = true;
    const out = new Float32Array(SR);
    for (let i = 0; i < SR; i += 4096) out.set(await render(mixer, p, i / SR, Math.min(4096, SR - i)), i);
    let maxDiff = 0;
    for (let i = 0; i < SR; i++) maxDiff = Math.max(maxDiff, Math.abs(out[i] - signal[SR - 1 - i]));
    expect(maxDiff).toBeLessThan(2e-4); // 16-bit storage
  });
});
