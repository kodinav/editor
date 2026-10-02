import type { Project } from '@/core/types';
import { AudioMixer } from '@/engine/audioMixer';
import { media } from '@/media/registry';

/**
 * Realtime audio for the preview. The AudioContext clock is the master clock
 * during playback; video frames are chosen to match what is being heard.
 * Audio is produced by the same deterministic mixer as export, in small
 * blocks scheduled slightly ahead of the playhead.
 */

const SR = 48000;
const BLOCK = 2048;
const LOOKAHEAD = 0.25;

export interface MeterReading {
  l: number;
  r: number;
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  readonly mixer = new AudioMixer(media, SR);
  private playing = false;
  private startT = 0;
  private startCtx = 0;
  private nextT = 0;
  private nextCtx = 0;
  private timer: number | null = null;
  private pumping = false;
  private nodes: AudioBufferSourceNode[] = [];
  private meters: { at: number; l: number; r: number }[] = [];
  private bufL = new Float32Array(BLOCK);
  private bufR = new Float32Array(BLOCK);
  private generation = 0;
  private lastScrub = 0;
  /** Shuttle speed: the timeline runs this many times faster (audio pitched up, like tape). */
  private rate = 1;
  private wide: { l: Float32Array; r: Float32Array } | null = null;
  underruns = 0;

  constructor(private readonly getProject: () => Project) {
    // Create the context on the first user gesture so pressing play later is instant.
    if (typeof window !== 'undefined') {
      const warm = () => {
        window.removeEventListener('pointerdown', warm, true);
        window.removeEventListener('keydown', warm, true);
        try {
          const ctx = this.ensure();
          if (!this.playing) void ctx.suspend().catch(() => {});
        } catch {
          /* audio unavailable */
        }
      };
      window.addEventListener('pointerdown', warm, true);
      window.addEventListener('keydown', warm, true);
    }
  }

  private ensure(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: SR, latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  get available(): boolean {
    return typeof AudioContext !== 'undefined';
  }

  /** Begin playback from project time t. Resolves once the clock is running. */
  async start(t: number, rate = 1): Promise<void> {
    this.stop();
    this.rate = rate;
    const ctx = this.ensure();
    const gen = ++this.generation;
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    // Pre-load just enough audio to start glitch-free; the pump keeps ahead from there.
    await this.mixer.prepare(this.getProject(), t, Math.round(SR * 0.3)).catch(() => {});
    if (gen !== this.generation) return;
    this.playing = true;
    this.startT = t;
    this.startCtx = ctx.currentTime + 0.03;
    this.nextT = t;
    this.nextCtx = this.startCtx;
    this.underruns = 0;
    void this.pump();
    this.timer = window.setInterval(() => void this.pump(), 20);
  }

  stop() {
    this.generation++;
    this.playing = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
        /* not started */
      }
      n.disconnect();
    }
    this.nodes = [];
    this.meters = [];
  }

  /** Current project time as heard through the speakers. */
  time(): number {
    if (!this.ctx || !this.playing) return this.startT;
    const latency = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    const heard = this.ctx.currentTime - latency - this.startCtx;
    return this.startT + Math.max(0, heard) * this.rate;
  }

  private async pump() {
    if (this.pumping || !this.playing || !this.ctx) return;
    this.pumping = true;
    const gen = this.generation;
    try {
      const ctx = this.ctx;
      while (this.playing && gen === this.generation && this.nextCtx < ctx.currentTime + LOOKAHEAD) {
        if (this.nextCtx < ctx.currentTime + 0.005) {
          // We fell behind (tab was busy): skip ahead instead of drifting out of sync.
          const skip = ctx.currentTime + 0.02 - this.nextCtx;
          this.nextCtx += skip;
          this.nextT += skip * this.rate;
          this.underruns++;
        }
        const p = this.getProject();
        const r = this.rate;
        await this.mixer.prepare(p, this.nextT, BLOCK * r);
        if (!this.playing || gen !== this.generation) return;
        if (r === 1) this.mixer.mix(p, this.nextT, BLOCK, this.bufL, this.bufR);
        else {
          // Mix r blocks of timeline audio and keep every r-th (averaged) sample.
          if (!this.wide || this.wide.l.length < BLOCK * r) this.wide = { l: new Float32Array(BLOCK * r), r: new Float32Array(BLOCK * r) };
          this.mixer.mix(p, this.nextT, BLOCK * r, this.wide.l, this.wide.r);
          for (let i = 0; i < BLOCK; i++) {
            let l = 0;
            let rr = 0;
            for (let k = 0; k < r; k++) {
              l += this.wide.l[i * r + k];
              rr += this.wide.r[i * r + k];
            }
            this.bufL[i] = l / r;
            this.bufR[i] = rr / r;
          }
        }
        const buf = ctx.createBuffer(2, BLOCK, SR);
        buf.copyToChannel(this.bufL, 0);
        buf.copyToChannel(this.bufR, 1);
        const node = ctx.createBufferSource();
        node.buffer = buf;
        node.connect(this.master!);
        node.start(this.nextCtx);
        node.onended = () => {
          node.disconnect();
          const i = this.nodes.indexOf(node);
          if (i >= 0) this.nodes.splice(i, 1);
        };
        this.nodes.push(node);
        this.meters.push({ at: this.nextCtx, l: peak(this.bufL), r: peak(this.bufR) });
        if (this.meters.length > 64) this.meters.splice(0, this.meters.length - 64);
        this.nextT += (BLOCK / SR) * this.rate;
        this.nextCtx += BLOCK / SR;
      }
    } catch (e) {
      console.warn('Audio pump error', e);
    } finally {
      this.pumping = false;
    }
  }

  /** Peak level of the block currently being heard. */
  meter(): MeterReading {
    if (!this.ctx || !this.playing) return { l: 0, r: 0 };
    const now = this.ctx.currentTime - (this.ctx.outputLatency || 0);
    let m: MeterReading = { l: 0, r: 0 };
    for (const x of this.meters) if (x.at <= now) m = x;
    return m;
  }

  /** Play a short snippet at t (audio scrubbing while dragging the playhead). */
  async scrub(t: number) {
    if (this.playing) return;
    const now = performance.now();
    if (now - this.lastScrub < 60) return;
    this.lastScrub = now;
    const ctx = this.ensure();
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    const n = Math.round(SR * 0.08);
    const p = this.getProject();
    await this.mixer.prepare(p, t, n);
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    this.mixer.mix(p, t, n, L, R);
    // Short fades avoid clicks.
    const f = Math.round(SR * 0.008);
    for (let i = 0; i < f; i++) {
      const g = i / f;
      L[i] *= g;
      R[i] *= g;
      L[n - 1 - i] *= g;
      R[n - 1 - i] *= g;
    }
    const buf = ctx.createBuffer(2, n, SR);
    buf.copyToChannel(L, 0);
    buf.copyToChannel(R, 1);
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(this.master!);
    node.start();
    node.onended = () => node.disconnect();
  }

  setMasterGain(g: number) {
    if (this.master) this.master.gain.value = g;
  }

  dispose() {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
  }
}

function peak(a: Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i += 4) {
    const v = Math.abs(a[i]);
    if (v > m) m = v;
  }
  return m;
}
