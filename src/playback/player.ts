import { create } from 'zustand';
import { evaluateFrame } from '@/core/evaluate';
import type { LayerGeometry } from '@/core/geometry';
import { projectDuration } from '@/core/project';
import { snapToFrame } from '@/core/time';
import { Compositor } from '@/engine/compositor';
import { onFontLoaded } from '@/engine/fonts';
import { media } from '@/media/registry';
import { editor, useEditor, usePlayback } from '@/state/store';
import { AudioEngine } from './audioEngine';
import { PreviewSources } from './previewSources';

/**
 * Playback controller: owns the preview compositor, video sources and the
 * audio engine; keeps the playhead in sync with the audio clock while
 * playing; renders on demand while paused (latest-wins, so scrubbing never
 * queues up stale frames).
 */

interface PreviewInfo {
  bounds: Map<string, LayerGeometry>;
  /** Render pixels per project pixel. */
  scale: number;
  error: string | null;
  setBounds(b: Map<string, LayerGeometry>): void;
}

export const usePreviewInfo = create<PreviewInfo>()((set) => ({
  bounds: new Map(),
  scale: 1,
  error: null,
  setBounds: (bounds) => set({ bounds }),
}));

const QUALITY_SCALE = { full: 1, half: 0.5, quarter: 0.25 } as const;

class Player {
  private compositor: Compositor | null = null;
  readonly sources = new PreviewSources();
  readonly audio = new AudioEngine(() => editor().project);
  private raf = 0;
  private dirty = false;
  private rendering = false;
  private displayW = 640;
  private displayH = 360;
  private dpr = 1;
  private lastPrerollAt = 0;
  private frameTimes: number[] = [];

  constructor() {
    this.sources.onFrameReady = () => this.requestRender();
    // Re-render on any project change while paused.
    useEditor.subscribe((s, prev) => {
      if (s.project !== prev.project || s.previewQuality !== prev.previewQuality) this.requestRender();
    });
    media.subscribe(() => this.requestRender());
    onFontLoaded(() => this.requestRender());
  }

  attach(canvas: HTMLCanvasElement) {
    this.compositor?.dispose();
    this.createCompositor(canvas);
    // GPU resets (driver updates, sleep/wake) lose every texture and program: rebuild.
    canvas.addEventListener('webglcontextrestored', () => {
      this.createCompositor(canvas);
      this.requestRender();
    });
    this.requestRender();
  }

  private createCompositor(canvas: HTMLCanvasElement) {
    try {
      this.compositor = new Compositor(canvas, { preserveDrawingBuffer: true });
      usePreviewInfo.setState({ error: null });
    } catch (e) {
      this.compositor = null;
      usePreviewInfo.setState({ error: (e as Error).message });
    }
  }

  detach() {
    this.compositor?.dispose();
    this.compositor = null;
  }

  setDisplaySize(w: number, h: number, dpr: number) {
    this.displayW = w;
    this.displayH = h;
    this.dpr = dpr;
    this.requestRender();
  }

  /** Render pixels per project pixel. */
  renderScale(): number {
    const { project, previewQuality } = editor();
    const { width, height } = project.settings;
    const fit = Math.min(this.displayW / width, this.displayH / height) * this.dpr;
    if (previewQuality === 'auto') {
      // Never render more pixels than the display can show; cap 1080p-equivalent while playing.
      const cap = usePlayback.getState().playing ? Math.min(1, 1920 / Math.max(width, height)) : 1;
      return Math.max(0.1, Math.min(fit, cap, 1));
    }
    return Math.max(0.1, Math.min(QUALITY_SCALE[previewQuality], Math.max(fit, 0.25)));
  }

  get playing() {
    return usePlayback.getState().playing;
  }

  endTime(): number {
    const p = editor().project;
    const d = projectDuration(p);
    return p.outPoint !== null && p.outPoint > 0 ? Math.min(p.outPoint, d || p.outPoint) : d;
  }

  startTime(): number {
    const p = editor().project;
    return p.inPoint ?? 0;
  }

  async play() {
    if (this.playing) return;
    let t = usePlayback.getState().time;
    const end = this.endTime();
    if (end <= 0) return;
    if (t >= end - 1e-3 || t < this.startTime() - 1e-3) t = this.startTime();
    usePlayback.getState().set({ playing: true, time: t });
    try {
      await this.audio.start(t);
    } catch (e) {
      console.warn('Audio failed to start', e);
    }
    if (!this.playing) return;
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.tick);
  }

  pause() {
    if (!this.playing) return;
    const t = this.audio.time();
    this.audio.stop();
    cancelAnimationFrame(this.raf);
    usePlayback.getState().set({ playing: false, time: snapToFrame(t, editor().project.settings.fps) });
    this.requestRender();
  }

  toggle() {
    if (this.playing) this.pause();
    else void this.play();
  }

  seek(t: number, opts: { scrub?: boolean } = {}) {
    t = Math.max(0, t);
    const wasPlaying = this.playing;
    if (wasPlaying) {
      this.audio.stop();
      usePlayback.getState().set({ time: t });
      void this.audio.start(t);
    } else {
      usePlayback.getState().set({ time: t });
      if (opts.scrub) void this.audio.scrub(t);
    }
    this.requestRender();
  }

  /** Step by n frames (pauses playback). */
  step(n: number) {
    if (this.playing) this.pause();
    const fps = editor().project.settings.fps;
    const t = snapToFrame(usePlayback.getState().time + n / fps, fps);
    this.seek(Math.max(0, t));
  }

  private tick = () => {
    if (!this.playing) return;
    const t = this.audio.time();
    const end = this.endTime();
    if (t >= end) {
      if (editor().loop && end > 0) {
        this.seek(this.startTime());
        this.raf = requestAnimationFrame(this.tick);
        return;
      }
      this.audio.stop();
      usePlayback.getState().set({ playing: false, time: end });
      this.requestRender();
      return;
    }
    usePlayback.getState().set({ time: t });
    this.drawPlaying(t);
    this.raf = requestAnimationFrame(this.tick);
  };

  private drawPlaying(t: number) {
    const c = this.compositor;
    if (!c) return;
    const p = editor().project;
    const desc = evaluateFrame(p, t);
    void this.sources.prepare(desc, 'play');
    const now = performance.now();
    if (now - this.lastPrerollAt > 250) {
      this.lastPrerollAt = now;
      this.sources.preroll(evaluateFrame(p, t + 0.8));
    }
    const scale = this.renderScale();
    const res = c.render(desc, this.sources, scale);
    usePreviewInfo.setState({ scale });
    if (res.bounds.size || usePreviewInfo.getState().bounds.size) usePreviewInfo.getState().setBounds(res.bounds);
    this.frameTimes.push(now);
    while (this.frameTimes.length && now - this.frameTimes[0] > 1000) this.frameTimes.shift();
  }

  requestRender() {
    if (this.playing) return;
    this.dirty = true;
    if (!this.rendering) void this.renderLoop();
  }

  private async renderLoop() {
    this.rendering = true;
    try {
      while (this.dirty && !this.playing) {
        this.dirty = false;
        const c = this.compositor;
        if (!c) break;
        const p = editor().project;
        const t = usePlayback.getState().time;
        const desc = evaluateFrame(p, t);
        await this.sources.prepare(desc, 'seek');
        if (this.playing) break;
        // Re-evaluate with the latest project (frames for the same time are already decoded).
        const latest = editor().project;
        const latestT = usePlayback.getState().time;
        const finalDesc = latest === p && latestT === t ? desc : evaluateFrame(latest, t);
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        if (this.playing) break;
        const scale = this.renderScale();
        const res = c.render(finalDesc, this.sources, scale);
        usePreviewInfo.setState({ scale });
        usePreviewInfo.getState().setBounds(res.bounds);
      }
    } catch (e) {
      console.error('Preview render failed', e);
    } finally {
      this.rendering = false;
    }
  }

  /** Measured preview frame rate while playing. */
  fps(): number {
    return this.frameTimes.length;
  }

  /** Grab the current preview frame as a small JPEG (project thumbnails). */
  async snapshot(maxW = 320): Promise<Blob | null> {
    const canvas = this.compositor?.canvas as HTMLCanvasElement | undefined;
    if (!canvas || canvas.width === 0) return null;
    const s = Math.min(1, maxW / canvas.width);
    const off = new OffscreenCanvas(Math.max(1, Math.round(canvas.width * s)), Math.max(1, Math.round(canvas.height * s)));
    // The preview canvas does not preserve its drawing buffer; draw synchronously after a render.
    off.getContext('2d')!.drawImage(canvas, 0, 0, off.width, off.height);
    return off.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
  }
}

export const player = new Player();
