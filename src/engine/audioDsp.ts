import type { Effect } from '@/core/types';
import { AUDIO_EFFECT_MAP } from '@/core/audioEffects';

/**
 * Audio processing shared by the preview and the export mixer: clip effects
 * (filters, EQ, compressor), a peak limiter and an ITU-R BS.1770 loudness
 * meter. Everything works on stereo float blocks and keeps its state between
 * blocks, so a long render sounds like one continuous pass.
 */

/* ------------------------------ Biquad ------------------------------ */

interface Coeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** RBJ "Audio EQ Cookbook" designs, normalized so a0 = 1. */
export function biquadCoeffs(kind: 'lowshelf' | 'highshelf' | 'peaking' | 'highpass' | 'lowpass', freq: number, sr: number, gainDb = 0, q = Math.SQRT1_2): Coeffs {
  const f = Math.min(freq, sr * 0.49);
  const w = (2 * Math.PI * f) / sr;
  const cos = Math.cos(w);
  const sin = Math.sin(w);
  const A = Math.pow(10, gainDb / 40);
  const alpha = sin / (2 * q);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  switch (kind) {
    case 'lowpass':
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = (1 - cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case 'highpass':
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = (1 + cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case 'peaking':
      b0 = 1 + alpha * A;
      b1 = -2 * cos;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cos;
      a2 = 1 - alpha / A;
      break;
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 - (A - 1) * cos + s);
      b1 = 2 * A * (A - 1 - (A + 1) * cos);
      b2 = A * (A + 1 - (A - 1) * cos - s);
      a0 = A + 1 + (A - 1) * cos + s;
      a1 = -2 * (A - 1 + (A + 1) * cos);
      a2 = A + 1 + (A - 1) * cos - s;
      break;
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 + (A - 1) * cos + s);
      b1 = -2 * A * (A - 1 + (A + 1) * cos);
      b2 = A * (A + 1 + (A - 1) * cos - s);
      a0 = A + 1 - (A - 1) * cos + s;
      a1 = 2 * (A - 1 - (A + 1) * cos);
      a2 = A + 1 - (A - 1) * cos - s;
      break;
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** Stereo biquad (transposed direct form II). */
export class Biquad {
  private zl1 = 0;
  private zl2 = 0;
  private zr1 = 0;
  private zr2 = 0;
  constructor(private c: Coeffs) {}

  process(l: Float32Array, r: Float32Array, n: number) {
    const { b0, b1, b2, a1, a2 } = this.c;
    let zl1 = this.zl1,
      zl2 = this.zl2,
      zr1 = this.zr1,
      zr2 = this.zr2;
    for (let i = 0; i < n; i++) {
      const xl = l[i];
      const yl = b0 * xl + zl1;
      zl1 = b1 * xl - a1 * yl + zl2;
      zl2 = b2 * xl - a2 * yl;
      l[i] = yl;
      const xr = r[i];
      const yr = b0 * xr + zr1;
      zr1 = b1 * xr - a1 * yr + zr2;
      zr2 = b2 * xr - a2 * yr;
      r[i] = yr;
    }
    // Flush denormals so silence after loud audio stays cheap.
    this.zl1 = Math.abs(zl1) < 1e-20 ? 0 : zl1;
    this.zl2 = Math.abs(zl2) < 1e-20 ? 0 : zl2;
    this.zr1 = Math.abs(zr1) < 1e-20 ? 0 : zr1;
    this.zr2 = Math.abs(zr2) < 1e-20 ? 0 : zr2;
  }
}

/* ---------------------------- Compressor ---------------------------- */

export interface CompressorParams {
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  makeupDb: number;
  /** Soft-knee width in dB. */
  kneeDb?: number;
}

/**
 * Feed-forward, stereo-linked compressor. The gain reduction uses a "smooth
 * decoupled" peak detector (Giannoulis, Massberg & Reiss 2012): it holds
 * through the gaps between waveform peaks and releases smoothly.
 */
export class Compressor {
  private y1 = 0;
  private yL = 0;
  private readonly att: number;
  private readonly rel: number;
  private readonly makeup: number;

  constructor(
    private readonly p: CompressorParams,
    sr: number,
  ) {
    this.att = Math.exp(-1 / (Math.max(0.05, p.attackMs) * 0.001 * sr));
    this.rel = Math.exp(-1 / (Math.max(1, p.releaseMs) * 0.001 * sr));
    this.makeup = Math.pow(10, p.makeupDb / 20);
  }

  /** Static curve: gain change (dB, <= 0) for an input level (dB). */
  static curve(levelDb: number, thresholdDb: number, ratio: number, kneeDb: number): number {
    const over = levelDb - thresholdDb;
    const slope = 1 / Math.max(1, ratio) - 1;
    if (kneeDb > 0 && Math.abs(over) <= kneeDb / 2) return (slope * (over + kneeDb / 2) ** 2) / (2 * kneeDb);
    return over > 0 ? slope * over : 0;
  }

  process(l: Float32Array, r: Float32Array, n: number) {
    const { thresholdDb, ratio } = this.p;
    const knee = this.p.kneeDb ?? 6;
    const { att, rel } = this;
    let y1 = this.y1;
    let yL = this.yL;
    for (let i = 0; i < n; i++) {
      const peak = Math.max(Math.abs(l[i]), Math.abs(r[i]));
      const level = peak > 1e-6 ? 20 * Math.log10(peak) : -120;
      const want = -Compressor.curve(level, thresholdDb, ratio, knee); // dB of reduction, >= 0
      y1 = Math.max(want, rel * y1 + (1 - rel) * want);
      yL = att * yL + (1 - att) * y1;
      const g = Math.pow(10, -yL / 20) * this.makeup;
      l[i] *= g;
      r[i] *= g;
    }
    this.y1 = y1 < 1e-9 ? 0 : y1;
    this.yL = yL < 1e-9 ? 0 : yL;
  }
}

/* ------------------------------ Limiter ------------------------------ */

/**
 * Look-ahead peak limiter: the output never exceeds `ceiling` (linear).
 * The required gain is min-filtered over the look-ahead window and then
 * averaged over the same length, so gain changes are smooth ramps that
 * reach their value by the time the peak arrives. Output is delayed by
 * `latency` samples.
 */
export class Limiter {
  readonly latency: number;
  private readonly bufL: Float32Array;
  private readonly bufR: Float32Array;
  private readonly ring: Float64Array;
  private readonly dqIdx: Float64Array;
  private readonly dqVal: Float64Array;
  private head = 0;
  private tail = 0;
  private sum: number;
  private k = 0;
  private gain = 1;
  private readonly rel: number;

  constructor(
    private readonly ceiling: number,
    sr: number,
    lookaheadMs = 5,
    releaseMs = 80,
  ) {
    const L = (this.latency = Math.max(1, Math.round(lookaheadMs * 0.001 * sr)));
    this.bufL = new Float32Array(L);
    this.bufR = new Float32Array(L);
    this.ring = new Float64Array(L).fill(1);
    this.sum = L;
    this.dqIdx = new Float64Array(L + 2);
    this.dqVal = new Float64Array(L + 2);
    this.rel = Math.exp(-1 / (releaseMs * 0.001 * sr));
  }

  process(l: Float32Array, r: Float32Array, n: number) {
    const L = this.latency;
    const cap = L + 2;
    const { dqIdx, dqVal } = this;
    for (let i = 0; i < n; i++) {
      const k = this.k++;
      const a = Math.max(Math.abs(l[i]), Math.abs(r[i]));
      const need = a > this.ceiling ? this.ceiling / a : 1;
      // Sliding minimum of the required gain over inputs k-L..k (the sample leaving the delay and the L after it).
      while (this.tail !== this.head && dqVal[(this.tail - 1 + cap) % cap] >= need) this.tail = (this.tail - 1 + cap) % cap;
      dqIdx[this.tail] = k;
      dqVal[this.tail] = need;
      this.tail = (this.tail + 1) % cap;
      while (dqIdx[this.head] < k - L) this.head = (this.head + 1) % cap;
      const m = dqVal[this.head];
      // Average of the last L minima: every one of them covers the outgoing sample, so the ramp never overshoots.
      const slot = k % L;
      this.sum += m - this.ring[slot];
      this.ring[slot] = m;
      const s = Math.min(1, this.sum / L);
      this.gain = s < this.gain ? s : s + (this.gain - s) * this.rel;
      const p = k % L;
      const outL = this.bufL[p];
      const outR = this.bufR[p];
      this.bufL[p] = l[i];
      this.bufR[p] = r[i];
      l[i] = outL * this.gain;
      r[i] = outR * this.gain;
    }
    // Re-sum now and then so rounding never accumulates.
    if (this.k % (L * 4096) < n) this.sum = this.ring.reduce((x, y) => x + y, 0);
  }
}

/* ---------------------------- Clip effects ---------------------------- */

interface Processor {
  process(l: Float32Array, r: Float32Array, n: number): void;
}

const num = (fx: Effect, key: string): number => {
  const v = fx.params[key];
  if (typeof v === 'number') return v;
  const d = AUDIO_EFFECT_MAP[fx.type]?.params.find((p) => p.key === key);
  return d && d.kind === 'number' ? d.default : 0;
};

const BUTTERWORTH4 = [0.5411961, 1.3065630];

function processorsFor(fx: Effect, sr: number): Processor[] {
  switch (fx.type) {
    case 'highpass':
    case 'lowpass':
      // Two stages with Butterworth Qs: a clean 24 dB/octave cut.
      return BUTTERWORTH4.map((q) => new Biquad(biquadCoeffs(fx.type === 'highpass' ? 'highpass' : 'lowpass', num(fx, 'frequency'), sr, 0, q)));
    case 'eq': {
      const out: Processor[] = [];
      if (Math.abs(num(fx, 'low')) > 0.01) out.push(new Biquad(biquadCoeffs('lowshelf', 120, sr, num(fx, 'low'))));
      if (Math.abs(num(fx, 'mid')) > 0.01) out.push(new Biquad(biquadCoeffs('peaking', num(fx, 'midFrequency'), sr, num(fx, 'mid'), 0.9)));
      if (Math.abs(num(fx, 'high')) > 0.01) out.push(new Biquad(biquadCoeffs('highshelf', 6000, sr, num(fx, 'high'))));
      return out;
    }
    case 'compressor':
      return [
        new Compressor(
          { thresholdDb: num(fx, 'threshold'), ratio: num(fx, 'ratio'), attackMs: num(fx, 'attack'), releaseMs: num(fx, 'release'), makeupDb: num(fx, 'makeup') },
          sr,
        ),
      ];
    default:
      return [];
  }
}

/** A clip's effect chain with its running state. */
export class EffectChain {
  private readonly stages: Processor[];
  /** Absolute output sample the next block must start at to continue seamlessly. */
  next = -1;

  constructor(effects: Effect[], sr: number) {
    this.stages = effects.filter((e) => e.enabled).flatMap((e) => processorsFor(e, sr));
  }

  get empty() {
    return this.stages.length === 0;
  }

  process(l: Float32Array, r: Float32Array, n: number) {
    for (const s of this.stages) s.process(l, r, n);
  }
}

/** Identity of an effect list: a chain is rebuilt when this changes. */
export function chainSignature(effects: Effect[] | undefined): string {
  if (!effects?.length) return '';
  return JSON.stringify(effects.filter((e) => e.enabled).map((e) => [e.type, e.params]));
}

/* ------------------------- Loudness (BS.1770) ------------------------- */

/**
 * Integrated loudness meter (ITU-R BS.1770-4 / EBU R128): K-weighting,
 * 400 ms blocks with 75 % overlap, absolute gate at -70 LUFS and a relative
 * gate 10 LU below the ungated level.
 */
export class LoudnessMeter {
  private readonly pre: Biquad;
  private readonly rlb: Biquad;
  private readonly step: number;
  private readonly blockLen: number;
  /** Mean square of each 100 ms quarter-block. */
  private quarters: number[] = [];
  private acc = 0;
  private accN = 0;
  private bufL = new Float32Array(0);
  private bufR = new Float32Array(0);
  peak = 0;

  constructor(sr: number) {
    // The two K-weighting stages from BS.1770 (redesigned for any sample rate).
    this.pre = new Biquad(kShelf(sr));
    this.rlb = new Biquad(kHighpass(sr));
    this.step = Math.round(sr * 0.1);
    this.blockLen = 4;
  }

  push(l: Float32Array, r: Float32Array, n: number) {
    if (this.bufL.length < n) {
      this.bufL = new Float32Array(n);
      this.bufR = new Float32Array(n);
    }
    const L = this.bufL;
    const R = this.bufR;
    for (let i = 0; i < n; i++) {
      L[i] = l[i];
      R[i] = r[i];
      const a = Math.max(Math.abs(l[i]), Math.abs(r[i]));
      if (a > this.peak) this.peak = a;
    }
    this.pre.process(L, R, n);
    this.rlb.process(L, R, n);
    for (let i = 0; i < n; i++) {
      this.acc += L[i] * L[i] + R[i] * R[i];
      if (++this.accN === this.step) {
        this.quarters.push(this.acc / this.step);
        this.acc = 0;
        this.accN = 0;
      }
    }
  }

  /** Integrated loudness in LUFS (-Infinity for silence or under 400 ms). */
  integrated(): number {
    const blocks: number[] = [];
    for (let i = 0; i + this.blockLen <= this.quarters.length; i++) {
      let s = 0;
      for (let j = 0; j < this.blockLen; j++) s += this.quarters[i + j];
      blocks.push(s / this.blockLen);
    }
    const lufs = (z: number) => -0.691 + 10 * Math.log10(z);
    const abs = blocks.filter((z) => z > 0 && lufs(z) > -70);
    if (!abs.length) return -Infinity;
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    const rel = lufs(mean(abs)) - 10;
    const gated = abs.filter((z) => lufs(z) > rel);
    return gated.length ? lufs(mean(gated)) : -Infinity;
  }
}

/** BS.1770 stage-1 high shelf (+4 dB above ~1.5 kHz), computed for any sample rate. */
function kShelf(sr: number): Coeffs {
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;
  const K = Math.tan((Math.PI * f0) / sr);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / Q + K * K;
  return {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
}

/** BS.1770 stage-2 "RLB" high-pass (as in libebur128). */
function kHighpass(sr: number): Coeffs {
  const f0 = 38.13547087602444;
  const Q = 0.5003270373238773;
  const K = Math.tan((Math.PI * f0) / sr);
  const a0 = 1 + K / Q + K * K;
  return { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
}
