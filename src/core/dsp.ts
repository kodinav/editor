/**
 * Small DSP toolkit: radix-2 FFT and a streaming spectral-gate noise reducer.
 * Pure TypeScript, deterministic, unit-tested; runs in a worker in the app.
 */

export class FFT {
  readonly n: number;
  private rev: Uint32Array;
  private cos: Float32Array;
  private sin: Float32Array;

  constructor(n: number) {
    if (n & (n - 1)) throw new Error('FFT size must be a power of two');
    this.n = n;
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float32Array(n / 2);
    this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
  }

  /** In-place complex FFT (inverse = true for the unscaled inverse transform). */
  transform(re: Float32Array, im: Float32Array, inverse = false): void {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    const sign = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step];
          const wi = sign * this.sin[k * step];
          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}

export function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

export interface GateOptions {
  /** Attenuation applied to noise (dB, negative). */
  reductionDb: number;
  /** How far above the noise floor a bin must be to pass (dB). */
  thresholdDb: number;
}

export const NOISE_PRESETS: Record<'light' | 'medium' | 'strong', GateOptions> = {
  light: { reductionDb: -10, thresholdDb: 0 },
  medium: { reductionDb: -18, thresholdDb: 1 },
  strong: { reductionDb: -30, thresholdDb: 3 },
};

export const FRAME = 2048;
export const HOP = 512;

/**
 * Per-bin noise threshold (linear magnitude) from the quietest frames:
 * mean + 1.5·σ of their dB spectrum, the standard stationary-noise estimate.
 */
export function noiseProfile(frames: Float32Array[], quietFraction = 0.12): Float32Array {
  const fft = new FFT(FRAME);
  const w = hann(FRAME);
  const energies = frames.map((f) => {
    let e = 0;
    for (let i = 0; i < f.length; i++) e += f[i] * f[i];
    return e;
  });
  const order = energies.map((e, i) => [e, i] as const).sort((a, b) => a[0] - b[0]);
  const take = Math.max(2, Math.min(order.length, Math.floor(order.length * quietFraction)));
  const bins = FRAME / 2 + 1;
  const sum = new Float64Array(bins);
  const sumSq = new Float64Array(bins);
  const re = new Float32Array(FRAME);
  const im = new Float32Array(FRAME);
  for (let q = 0; q < take; q++) {
    const f = frames[order[q][1]];
    for (let i = 0; i < FRAME; i++) {
      re[i] = f[i] * w[i];
      im[i] = 0;
    }
    fft.transform(re, im);
    for (let k = 0; k < bins; k++) {
      const db = 20 * Math.log10(Math.hypot(re[k], im[k]) + 1e-12);
      sum[k] += db;
      sumSq[k] += db * db;
    }
  }
  const prof = new Float32Array(bins);
  for (let k = 0; k < bins; k++) {
    const mean = sum[k] / take;
    const sd = Math.sqrt(Math.max(0, sumSq[k] / take - mean * mean));
    prof[k] = Math.pow(10, (mean + 1.5 * sd) / 20);
  }
  return prof;
}

/**
 * Streaming spectral gate. Feed consecutive analysis frames (hop HOP); it
 * returns HOP finished output samples per call after an initial latency of
 * FRAME - HOP samples.
 */
export class SpectralGate {
  private fft = new FFT(FRAME);
  private win = hann(FRAME);
  private re = new Float32Array(FRAME);
  private im = new Float32Array(FRAME);
  private gains: Float32Array;
  private acc = new Float32Array(FRAME);
  private thr: Float32Array;
  private floor: number;

  constructor(noise: Float32Array, opts: GateOptions) {
    const k = Math.pow(10, opts.thresholdDb / 20);
    this.thr = noise.map((v) => v * k);
    this.floor = Math.pow(10, opts.reductionDb / 20);
    this.gains = new Float32Array(FRAME / 2 + 1).fill(1);
  }

  /** Process one frame of FRAME input samples; returns HOP output samples. */
  process(frame: Float32Array): Float32Array {
    const { re, im, win } = this;
    for (let i = 0; i < FRAME; i++) {
      re[i] = frame[i] * win[i];
      im[i] = 0;
    }
    this.fft.transform(re, im);
    const half = FRAME / 2;
    const raw = new Float32Array(half + 1);
    for (let k = 0; k <= half; k++) raw[k] = Math.hypot(re[k], im[k]) > this.thr[k] ? 1 : 0;
    // Smooth the binary mask across frequency (triangular, ±3 bins) and time
    // (fast attack, slower release) so isolated bins don't "twinkle".
    for (let k = 0; k <= half; k++) {
      let acc = 0;
      let wsum = 0;
      for (let d = -3; d <= 3; d++) {
        const j = k + d;
        if (j < 0 || j > half) continue;
        const wt = 4 - Math.abs(d);
        acc += raw[j] * wt;
        wsum += wt;
      }
      const m = acc / wsum;
      const prev = this.gains[k];
      const next = m > prev ? prev + (m - prev) * 0.8 : prev + (m - prev) * 0.35;
      this.gains[k] = next;
    }
    for (let k = 0; k <= half; k++) {
      // Mask 1 = keep, 0 = attenuate to the floor.
      const g = this.floor + (1 - this.floor) * this.gains[k];
      re[k] *= g;
      im[k] *= g;
      if (k > 0 && k < half) {
        re[FRAME - k] *= g;
        im[FRAME - k] *= g;
      }
    }
    this.fft.transform(re, im, true);
    // Synthesis window + overlap-add. Hann² at 75% overlap sums to 1.5.
    const norm = 1 / (FRAME * 1.5);
    for (let i = 0; i < FRAME; i++) this.acc[i] += re[i] * win[i] * norm;
    const out = this.acc.slice(0, HOP);
    this.acc.copyWithin(0, HOP);
    this.acc.fill(0, FRAME - HOP);
    return out;
  }
}
