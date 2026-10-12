import { ALL_FORMATS, BlobSource, Input, VideoSample, VideoSampleSink, type InputVideoTrack } from 'mediabunny';

/**
 * Frames for a clip that plays backwards.
 *
 * Video can only be decoded forwards from a keyframe, so stepping back one
 * frame at a time would decode the same stretch over and over. This reader
 * decodes a short window of frames once, keeps copies of them, and serves
 * frames from it in any order; while playback walks down through a window it
 * fetches the one below in the background.
 *
 * The copies live in ordinary graphics memory, not in the video decoder's
 * small pool of frames, so holding a window of them never stalls decoding.
 * A window is sized by a memory budget: about two thirds of a second of
 * 1080p, fewer frames for 4K.
 */

const WINDOW_BYTES = 144 * 1024 * 1024;
const MIN_FRAMES = 4;
const MAX_FRAMES = 30;
const EPS = 1e-4;

interface Win {
  /** Covers source times [start, end). */
  start: number;
  end: number;
  frames: VideoSample[];
}

export class ReverseReader {
  private wins: Win[] = [];
  private cur: VideoSample | null = null;
  private loading: Promise<void> | null = null;
  private want = 0;
  private disposed = false;
  private scratch: OffscreenCanvas | null = null;
  /** Seconds of video one window holds (learned from the first frames decoded). */
  private span = 0.5;
  lastError: unknown = null;
  firstTimestamp = 0;
  /** Windows decoded so far (each costs one decode from a keyframe). */
  restarts = 0;

  constructor(
    private readonly sink: VideoSampleSink,
    readonly track: InputVideoTrack,
  ) {}

  static async open(file: Blob): Promise<{ reader: ReverseReader; input: Input }> {
    const input = new Input({ source: new BlobSource(file, { maxCacheSize: 32 * 1024 * 1024 }), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) {
      input.dispose();
      throw new Error('No video track');
    }
    const reader = new ReverseReader(new VideoSampleSink(track), track);
    reader.firstTimestamp = await track.getFirstTimestamp().catch(() => 0);
    return { reader, input };
  }

  get current(): VideoSample | null {
    return this.cur;
  }

  private find(t: number): Win | undefined {
    return this.wins.find((w) => t >= w.start - EPS && t < w.end - EPS);
  }

  private pick(w: Win, t: number) {
    let best = w.frames[0];
    for (const f of w.frames) if (f.timestamp <= t + EPS) best = f;
    const prev = this.cur;
    this.cur = best;
    // A frame kept alive only because it was on screen can go once it is replaced.
    if (prev && prev !== best && !this.wins.some((x) => x.frames.includes(prev))) prev.close();
  }

  /** The frame at time t, waiting for its window to decode if needed. */
  async seek(t: number): Promise<VideoSample | null> {
    if (this.disposed) return null;
    t = Math.max(t, this.firstTimestamp);
    this.want = t;
    for (;;) {
      const w = this.find(t);
      if (w) {
        if (this.want === t) this.pick(w, t);
        this.lookBehind(w, t);
        return this.cur;
      }
      if (this.disposed) return null;
      if (!this.loading) this.loading = this.load(t).finally(() => (this.loading = null));
      await this.loading;
    }
  }

  /** Non-blocking: aim at t (for playback); render with `current`. */
  request(t: number): void {
    if (this.disposed) return;
    t = Math.max(t, this.firstTimestamp);
    const w = this.find(t);
    if (w) {
      this.want = t;
      this.pick(w, t);
      this.lookBehind(w, t);
      return;
    }
    void this.seek(t).catch((e) => (this.lastError = e));
  }

  /** Playback is heading down: once past the middle of a window, decode the one below it. */
  private lookBehind(w: Win, t: number) {
    if (this.loading || w.start <= this.firstTimestamp + EPS) return;
    if (t - w.start > this.span / 2) return;
    const below = w.start - 2 * EPS;
    if (this.find(below)) return;
    this.loading = this.load(below)
      .catch((e) => void (this.lastError = e))
      .finally(() => (this.loading = null));
  }

  /** Decode and keep the window of frames that ends with the frame shown at time t. */
  private async load(t: number): Promise<void> {
    this.restarts++;
    const from = Math.max(this.firstTimestamp, t - this.span);
    const frames: VideoSample[] = [];
    let limit = MAX_FRAMES;
    try {
      for await (const s of this.sink.samples(from, t + 2 * EPS)) {
        if (this.disposed) {
          s.close();
          break;
        }
        if (frames.length === 0) limit = Math.max(MIN_FRAMES, Math.min(MAX_FRAMES, Math.floor(WINDOW_BYTES / Math.max(1, s.codedWidth * s.codedHeight * 4))));
        frames.push(this.copy(s));
        s.close();
        // Too many for the budget: let go of the earliest (the window simply starts later).
        while (frames.length > limit) frames.shift()!.close();
      }
      if (frames.length === 0) {
        // Past the end of the stream: hold its last frame.
        const last = await this.sink.getSample(t);
        if (last) {
          frames.push(this.copy(last));
          last.close();
        }
      }
    } catch (e) {
      for (const f of frames) f.close();
      throw e;
    }
    if (this.disposed || frames.length === 0) {
      for (const f of frames) f.close();
      if (!this.disposed) throw new Error('No video frame could be decoded.');
      return;
    }
    const first = frames[0];
    const lastFrame = frames[frames.length - 1];
    if (frames.length > 1) this.span = Math.max(0.1, ((lastFrame.timestamp - first.timestamp) / (frames.length - 1)) * limit);
    // The window always covers the time that was asked for, so the caller's wait ends.
    const win: Win = { start: Math.min(first.timestamp, t), end: Math.max(t + 4 * EPS, lastFrame.timestamp + Math.max(lastFrame.duration, 1 / 240)), frames };
    // Keep this window and the one being played; drop the rest.
    const playing = this.find(this.want);
    for (const w of this.wins) {
      if (w === playing) continue;
      for (const f of w.frames) if (f !== this.cur) f.close();
    }
    this.wins = playing ? [playing, win] : [win];
  }

  /** A copy of a decoded frame that doesn't hold on to the decoder's own frame. */
  private copy(s: VideoSample): VideoSample {
    const w = s.codedWidth;
    const h = s.codedHeight;
    if (!this.scratch || this.scratch.width !== w || this.scratch.height !== h) this.scratch = new OffscreenCanvas(w, h);
    const ctx = this.scratch.getContext('2d')!;
    ctx.drawImage(s.toCanvasImageSource() as CanvasImageSource, 0, 0, w, h);
    return new VideoSample(this.scratch, { timestamp: s.timestamp, duration: s.duration, rotation: s.rotation, flip: s.flip });
  }

  dispose() {
    this.disposed = true;
    for (const w of this.wins) for (const f of w.frames) f.close();
    this.wins = [];
    this.cur = null;
  }
}
