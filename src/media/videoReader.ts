import { ALL_FORMATS, BlobSource, Input, VideoSampleSink, type InputVideoTrack, type VideoSample } from 'mediabunny';

/**
 * Frame-accurate sequential/random access to one video track.
 *
 * - Moving forward by small amounts (playback, export, forward scrubbing)
 *   reuses a running decode stream, so each packet is decoded once.
 * - Jumping backwards or far ahead restarts decoding at the nearest keyframe.
 * - Requests are "latest wins": while a decode is in flight, newer requests
 *   replace older ones, so fast scrubbing never builds a backlog.
 *
 * The reader owns at most two decoded frames at a time (current + lookahead),
 * which keeps hardware decoder pools from stalling.
 */

const FORWARD_REUSE_LIMIT = 3; // seconds
const EPS = 1e-4;

export class VideoReader {
  private iter: AsyncGenerator<VideoSample, void, unknown> | null = null;
  private cur: VideoSample | null = null;
  private nxt: VideoSample | null = null;
  private ended = false;
  private target = 0;
  private running: Promise<void> | null = null;
  private disposed = false;
  private waiters: { t: number; resolve: (s: VideoSample | null) => void; reject: (e: unknown) => void }[] = [];
  lastError: unknown = null;
  firstTimestamp = 0;
  /** How often decoding restarted from a keyframe (a seek); continuous playback shouldn't add any. */
  restarts = 0;

  constructor(
    private readonly sink: VideoSampleSink,
    readonly track: InputVideoTrack,
  ) {}

  static async open(file: Blob): Promise<{ reader: VideoReader; input: Input }> {
    const input = new Input({ source: new BlobSource(file, { maxCacheSize: 32 * 1024 * 1024 }), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) {
      input.dispose();
      throw new Error('No video track');
    }
    const reader = new VideoReader(new VideoSampleSink(track), track);
    reader.firstTimestamp = await track.getFirstTimestamp().catch(() => 0);
    return { reader, input };
  }

  /** Latest decoded frame (may lag behind the most recent request during playback). */
  get current(): VideoSample | null {
    return this.cur;
  }

  /** Request the frame at time t and wait for it. Older pending requests resolve with whatever is current. */
  seek(t: number): Promise<VideoSample | null> {
    if (this.disposed) return Promise.resolve(null);
    t = Math.max(t, this.firstTimestamp);
    this.target = t;
    if (this.satisfies(t)) {
      return Promise.resolve(this.cur);
    }
    const p = new Promise<VideoSample | null>((resolve, reject) => this.waiters.push({ t, resolve, reject }));
    this.kick();
    return p;
  }

  /** Non-blocking: aim decoding at t (for playback); render with `current`. */
  request(t: number): void {
    if (this.disposed) return;
    t = Math.max(t, this.firstTimestamp);
    this.target = t;
    if (!this.satisfies(t)) this.kick();
  }

  private satisfies(t: number): boolean {
    if (!this.cur) return false;
    if (this.cur.timestamp > t + EPS) return false;
    if (this.nxt) return this.nxt.timestamp > t + EPS;
    if (this.ended) return true;
    // Without a lookahead frame we can't be sure; trust the frame's duration.
    return this.cur.timestamp + Math.max(this.cur.duration, 1 / 240) > t + EPS;
  }

  private kick() {
    if (this.running) return;
    this.running = this.loop()
      .catch((e) => {
        this.lastError = e;
        const ws = this.waiters;
        this.waiters = [];
        for (const w of ws) w.reject(e);
        this.resetStream();
      })
      .finally(() => {
        this.running = null;
        // A request may have arrived after the loop's last check.
        if (!this.disposed && this.waiters.length > 0) this.kick();
      });
  }

  private async loop() {
    while (!this.disposed) {
      const t = this.target;
      const canReuse =
        this.iter !== null && this.cur !== null && this.cur.timestamp <= t + EPS && t - this.cur.timestamp < FORWARD_REUSE_LIMIT;
      if (!canReuse) await this.restart(t);
      await this.advanceTo(t);
      if (this.target === t || this.disposed) {
        this.resolveWaiters();
        return;
      }
      // Target moved while we were decoding; resolve stale waiters and continue.
      this.resolveWaiters();
    }
  }

  private resolveWaiters() {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w.resolve(this.cur);
  }

  private resetStream() {
    void this.iter?.return();
    this.iter = null;
    this.nxt?.close();
    this.nxt = null;
    this.ended = false;
  }

  private async restart(t: number) {
    this.restarts++;
    this.resetStream();
    this.cur?.close();
    this.cur = null;
    this.iter = this.sink.samples(t);
    const first = await this.iter.next();
    if (first.done) {
      this.ended = true;
      // Past the end: hold the last frame of the stream.
      const last = await this.sink.getSample(t);
      this.cur = last;
      return;
    }
    this.cur = first.value;
  }

  private async advanceTo(t: number) {
    if (!this.iter) return;
    for (;;) {
      if (this.disposed) return;
      if (!this.nxt) {
        if (this.ended) return;
        const r = await this.iter.next();
        if (r.done) {
          this.ended = true;
          return;
        }
        this.nxt = r.value;
      }
      if (this.nxt.timestamp <= t + EPS) {
        this.cur?.close();
        this.cur = this.nxt;
        this.nxt = null;
        // Abort early if a much newer target arrived far away (scrub jump).
        if (this.target !== t && (this.target < this.cur.timestamp - EPS || this.target - this.cur.timestamp > FORWARD_REUSE_LIMIT)) return;
      } else {
        return;
      }
    }
  }

  dispose() {
    this.disposed = true;
    this.resetStream();
    this.cur?.close();
    this.cur = null;
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w.resolve(null);
  }
}
