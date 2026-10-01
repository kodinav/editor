import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  CanvasSource,
  canEncodeAudio,
  canEncodeVideo,
  Input,
  MovOutputFormat,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  WavOutputFormat,
  WebMOutputFormat,
  type AudioCodec,
  type StreamTargetChunk,
  type VideoCodec,
  type VideoSample,
} from 'mediabunny';
import { evaluateFrame, videoSourcesIn } from '@/core/evaluate';
import type { Project } from '@/core/types';
import { AudioMixer } from '@/engine/audioMixer';
import { Compositor, type FrameSources } from '@/engine/compositor';
import { ensureFont, registerCustomFont } from '@/engine/fonts';
import { decodeImage } from '@/media/probe';
import { AnimatedImage } from '@/media/animatedImage';
import { PcmSource } from '@/media/pcm';
import { VideoReader } from '@/media/videoReader';
import { encoderDelay } from '@/export/encoderDelay';
import { opusCodecDelayPatch, WEBM_HEAD_BYTES } from '@/export/webmCodecDelay';
import { audioBitrate, videoBitrate, type ExportStartMessage, type ExportWorkerMessage } from '@/export/types';

/**
 * Offline renderer. Runs the same evaluate → composite → mix pipeline as the
 * preview, frame by frame, and encodes with WebCodecs. Runs in a worker so
 * long exports never block the editor UI and aren't throttled in background
 * tabs.
 */

const scope = self as unknown as { postMessage(m: ExportWorkerMessage): void; onmessage: ((e: MessageEvent) => void) | null };
let cancelled = false;

scope.onmessage = (e: MessageEvent<ExportStartMessage | { type: 'cancel' }>) => {
  if (e.data.type === 'cancel') {
    cancelled = true;
    return;
  }
  if (e.data.type === 'start') {
    cancelled = false;
    run(e.data).catch((err) => {
      if (cancelled) scope.postMessage({ type: 'cancelled' });
      else scope.postMessage({ type: 'error', message: describe(err) });
    });
  }
};

function describe(err: unknown): string {
  const m = String((err as Error)?.message ?? err);
  if ((err as DOMException)?.name === 'QuotaExceededError') return 'Not enough disk space to write the export.';
  return m;
}

class ExportSources implements FrameSources {
  readers = new Map<string, { reader: VideoReader; input: Input }>();
  opening = new Map<string, Promise<void>>();
  images = new Map<string, ImageBitmap>();
  animations = new Map<string, AnimatedImage>();
  constructor(private files: Record<string, File>) {}

  video = (clipId: string): VideoSample | null => this.readers.get(clipId)?.reader.current ?? null;
  image = (assetId: string, time: number): ImageBitmap | null => this.animations.get(assetId)?.frameAt(time) ?? this.images.get(assetId) ?? null;

  async loadImages(p: Project) {
    for (const a of Object.values(p.assets)) {
      if (a.kind !== 'image' || !this.files[a.id]) continue;
      const used = Object.values(p.clips).some((c) => c.type === 'image' && c.assetId === a.id);
      if (!used) continue;
      if (a.image?.animated) {
        const anim = await AnimatedImage.decode(this.files[a.id]).catch(() => null);
        if (anim) {
          this.animations.set(a.id, anim);
          continue;
        }
      }
      this.images.set(a.id, await decodeImage(this.files[a.id]));
    }
  }

  async prepare(p: Project, t: number) {
    const desc = evaluateFrame(p, t);
    const active = new Set<string>();
    await Promise.all(
      videoSourcesIn(desc).map(async (w) => {
        active.add(w.key);
        let entry = this.readers.get(w.key);
        if (!entry) {
          let op = this.opening.get(w.key);
          if (!op) {
            const file = this.files[w.assetId];
            if (!file) return;
            op = VideoReader.open(file).then((r) => void this.readers.set(w.key, r));
            this.opening.set(w.key, op);
          }
          await op;
          entry = this.readers.get(w.key);
          if (!entry) return;
        }
        await entry.reader.seek(w.time);
        if (entry.reader.lastError) throw entry.reader.lastError;
      }),
    );
    // Close readers for clips that have finished (export time only moves forward).
    for (const [key, entry] of this.readers) {
      const clip = p.clips[key];
      if (!active.has(key) && (!clip || clip.start + clip.duration < t - 2)) {
        entry.reader.dispose();
        entry.input.dispose();
        this.readers.delete(key);
        this.opening.delete(key);
      }
    }
    return desc;
  }

  dispose() {
    for (const e of this.readers.values()) {
      e.reader.dispose();
      e.input.dispose();
    }
    for (const b of this.images.values()) b.close();
    for (const a of this.animations.values()) a.close();
  }
}

interface Writable {
  stream: WritableStream<StreamTargetChunk>;
  /** The first WEBM_HEAD_BYTES written, for header fix-ups after muxing. */
  head: () => Uint8Array;
  patch: (position: number, bytes: Uint8Array<ArrayBuffer>) => Promise<void>;
  close: () => Promise<number>;
  abort: () => Promise<void>;
}

function makeWritable(target: ExportStartMessage['target']): Promise<Writable> {
  const head = new Uint8Array(WEBM_HEAD_BYTES);
  let headLen = 0;
  const mirror = (chunk: StreamTargetChunk) => {
    if (chunk.position >= head.length) return;
    const n = Math.min(chunk.data.byteLength, head.length - chunk.position);
    head.set(chunk.data.subarray(0, n), chunk.position);
    headLen = Math.max(headLen, chunk.position + n);
  };
  return (async () => {
    if (target.kind === 'opfs') {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('exports', { create: true });
      const fh = await dir.getFileHandle(target.name, { create: true });
      const sync = await fh.createSyncAccessHandle();
      sync.truncate(0);
      let size = 0;
      const stream = new WritableStream<StreamTargetChunk>({
        write(chunk) {
          sync.write(chunk.data, { at: chunk.position });
          mirror(chunk);
          size = Math.max(size, chunk.position + chunk.data.byteLength);
        },
      });
      return {
        stream,
        head: () => head.subarray(0, headLen),
        patch: async (position, bytes) => {
          sync.write(bytes, { at: position });
        },
        close: async () => {
          sync.flush();
          const s = sync.getSize();
          sync.close();
          return s;
        },
        abort: async () => {
          sync.close();
          await dir.removeEntry(target.name).catch(() => {});
        },
      };
    }
    const writable = await target.handle.createWritable();
    let size = 0;
    const stream = new WritableStream<StreamTargetChunk>({
      async write(chunk) {
        await writable.write({ type: 'write', position: chunk.position, data: chunk.data });
        mirror(chunk);
        size = Math.max(size, chunk.position + chunk.data.byteLength);
      },
    });
    return {
      stream,
      head: () => head.subarray(0, headLen),
      patch: async (position, bytes) => {
        await writable.write({ type: 'write', position, data: bytes });
      },
      close: async () => {
        await writable.close();
        return size;
      },
      abort: async () => {
        await writable.abort().catch(() => {});
      },
    };
  })();
}

/** Smallest H.264 level that fits the frame size and macroblock rate. */
function avcLevel(w: number, h: number, fps: number): string {
  const fs = Math.ceil(w / 16) * Math.ceil(h / 16);
  const mbps = fs * Math.min(fps, 120);
  const levels: [number, number, number][] = [
    [0x1f, 3600, 108000],
    [0x20, 5120, 216000],
    [0x28, 8192, 245760],
    [0x2a, 8704, 522240],
    [0x32, 22080, 589824],
    [0x33, 36864, 983040],
    [0x34, 36864, 2073600],
    [0x3c, 139264, 4177920],
    [0x3d, 139264, 8355840],
    [0x3e, 139264, 16711680],
  ];
  const l = levels.find(([, maxFs, maxMbps]) => fs <= maxFs && mbps <= maxMbps) ?? levels[levels.length - 1];
  return l[0].toString(16).padStart(2, '0');
}

/** Candidate full codec strings, best first. */
function codecCandidates(codec: VideoCodec, w: number, h: number, fps: number): (string | undefined)[] {
  if (codec === 'avc') {
    const lv = avcLevel(w, h, fps);
    return [`avc1.6400${lv}`, `avc1.4d00${lv}`, `avc1.4200${lv}`];
  }
  return [undefined];
}

/**
 * Some encoders accept a configuration and then never emit a frame (e.g.
 * H.264 High profile in some WebKit builds). Encode a few real frames and
 * require output before committing to a configuration.
 */
async function encoderProduces(codecString: string, w: number, h: number, fps: number, bitrate: number, hw: ExportStartMessage['options']['hardware']): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let outputs = 0;
    let enc: VideoEncoder | null = null;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        enc?.close();
      } catch {
        /* already closed */
      }
      resolve(ok);
    };
    try {
      enc = new VideoEncoder({ output: () => void (++outputs >= 1 && finish(true)), error: () => finish(false) });
      enc.configure({ codec: codecString, width: w, height: h, bitrate, framerate: fps, latencyMode: 'quality', hardwareAcceleration: hw });
      const c = new OffscreenCanvas(w, h);
      const g = c.getContext('2d')!;
      for (let i = 0; i < 6; i++) {
        g.fillStyle = i % 2 ? '#334' : '#a53';
        g.fillRect(0, 0, w, h);
        const f = new VideoFrame(c, { timestamp: Math.round((i * 1e6) / fps) });
        enc.encode(f, { keyFrame: i === 0 });
        f.close();
      }
      enc.flush().then(() => finish(outputs > 0), () => finish(false));
      setTimeout(() => finish(outputs > 0), 4000);
    } catch {
      finish(false);
    }
  });
}

interface VideoChoice {
  codec: VideoCodec;
  fullCodecString?: string;
}

async function pickVideoCodec(container: string, w: number, h: number, fps: number, bitrate: number, hw: ExportStartMessage['options']['hardware']): Promise<VideoChoice> {
  const prefs: VideoCodec[] = container === 'webm' ? ['vp9', 'vp8', 'av1'] : ['avc', 'hevc', 'av1', 'vp9'];
  for (const c of prefs) {
    if (!(await canEncodeVideo(c, { width: w, height: h, bitrate, frameRate: fps, hardwareAcceleration: hw }).catch(() => false))) continue;
    for (const full of codecCandidates(c, w, h, fps)) {
      // Without an explicit string, trust the library's choice (VP9/AV1/HEVC are reliable where reported).
      if (!full) return { codec: c };
      if (await encoderProduces(full, w, h, fps, bitrate, hw)) return { codec: c, fullCodecString: full };
    }
  }
  if (hw !== 'no-preference') return pickVideoCodec(container, w, h, fps, bitrate, 'no-preference');
  throw new Error(`This browser can't encode ${w}×${h} video in ${container.toUpperCase()}. Try a lower resolution or a different format.`);
}

async function pickAudioCodec(container: string, bitrate: number): Promise<AudioCodec> {
  if (container === 'wav') return 'pcm-s16';
  const prefs: AudioCodec[] = container === 'webm' ? ['opus', 'vorbis'] : ['aac', 'opus', 'mp3'];
  for (const c of prefs) {
    if (await canEncodeAudio(c, { numberOfChannels: 2, sampleRate: 48000, bitrate }).catch(() => false)) return c;
  }
  throw new Error('This browser has no audio encoder for this format. Try WebM or export without audio.');
}

async function run(msg: ExportStartMessage) {
  const t0 = performance.now();
  const { project: p, options: o } = msg;
  scope.postMessage({ type: 'progress', frame: 0, totalFrames: 1, fps: 0, elapsed: 0, phase: 'preparing' });

  const audioOnly = o.container === 'wav' || o.container === 'm4a';
  const duration = Math.max(0, o.end - o.start);
  if (duration <= 0) throw new Error('Nothing to export: the timeline is empty.');
  const totalFrames = Math.max(1, Math.round(duration * o.fps));

  // Fonts used by text and captions must be loaded before the first frame.
  for (const [family, buf] of Object.entries(msg.fonts)) await registerCustomFont(family, buf);
  const fontLoads: Promise<void>[] = [];
  for (const c of Object.values(p.clips)) {
    if (c.type === 'text') fontLoads.push(ensureFont(c.style.fontFamily, c.style.fontWeight, c.style.italic));
  }
  for (const t of p.tracks) if (t.captionStyle) fontLoads.push(ensureFont(t.captionStyle.fontFamily, t.captionStyle.fontWeight, t.captionStyle.italic));
  await Promise.all(fontLoads);

  const sources = new ExportSources(msg.files);
  await sources.loadImages(p);
  const pcm = new Map<string, PcmSource>();
  for (const [id, info] of Object.entries(msg.pcm)) pcm.set(id, new PcmSource(id, info.file, info.sampleRate, info.channels));
  const mixer = new AudioMixer({ getPcm: (id, variant) => pcm.get(variant ? `${id}:${variant}` : id) }, 48000);

  const vBitrate = audioOnly ? 0 : videoBitrate(o.width, o.height, o.fps, o.quality, o.container === 'webm' ? 'vp9' : 'avc');
  const aBitrate = audioBitrate(o.quality);
  const vChoice = audioOnly ? null : await pickVideoCodec(o.container, o.width, o.height, o.fps, vBitrate, o.hardware);
  const vCodec = vChoice?.codec ?? null;
  const aCodec = o.includeAudio ? await pickAudioCodec(o.container, aBitrate) : null;

  // Stream to disk when possible; fall back to memory where OPFS is unavailable (private browsing).
  const writable = await makeWritable(msg.target).catch((e) => {
    if (msg.target.kind === 'handle') throw e;
    return null;
  });
  const memoryTarget = writable ? null : new BufferTarget();
  const format =
    o.container === 'webm'
      ? new WebMOutputFormat()
      : o.container === 'wav'
        ? new WavOutputFormat({ large: duration > 3 * 3600 })
        : o.container === 'mov'
          ? new MovOutputFormat({ fastStart: 'reserve' })
          : new Mp4OutputFormat({ fastStart: 'reserve' });
  const output = new Output({ format, target: writable ? new StreamTarget(writable.stream, { chunked: true, chunkSize: 8 * 1024 * 1024 }) : memoryTarget! });

  let canvas: OffscreenCanvas | null = null;
  let compositor: Compositor | null = null;
  let videoSource: CanvasSource | null = null;
  if (vCodec) {
    canvas = new OffscreenCanvas(o.width, o.height);
    compositor = new Compositor(canvas, { preserveDrawingBuffer: true });
    videoSource = new CanvasSource(canvas, {
      codec: vCodec,
      fullCodecString: vChoice?.fullCodecString,
      quality: new Quality({ bitrate: vBitrate }),
      keyFrameInterval: 2,
      hardwareAcceleration: o.hardware,
      latencyMode: 'quality',
    });
    output.addVideoTrack(videoSource, { frameRate: o.fps, maximumPacketCount: Math.ceil(totalFrames * 1.05) + 16 });
  }
  let audioSource: AudioSampleSource | null = null;
  if (aCodec) {
    audioSource = new AudioSampleSource({ codec: aCodec, quality: aCodec.startsWith('pcm') ? undefined : new Quality({ bitrate: aBitrate }) });
    output.addAudioTrack(audioSource, { maximumPacketCount: Math.ceil(duration * 100 * 1.4) + 64 });
  }

  const SR = 48000;
  // A whole number of codec frames (AAC 1024, Opus 960, MP3 1152 samples): WebKit's AAC encoder
  // mis-stamps packets that straddle two input buffers, which breaks the file's audio timing.
  const AUDIO_BLOCK = 46080;
  const totalAudioFrames = Math.round(duration * SR);
  // Start the audio early by the encoder's priming; the muxer then writes an edit list that
  // tells players to skip it, so sound lines up with picture.
  const priming = aCodec ? (await encoderDelay(aCodec, aBitrate)) / SR : 0;
  let audioWritten = 0;
  const L = new Float32Array(AUDIO_BLOCK);
  const R = new Float32Array(AUDIO_BLOCK);
  const planar = new Float32Array(AUDIO_BLOCK * 2);
  const writeAudioUntil = async (tRel: number) => {
    if (!audioSource) return;
    const targetFrames = Math.min(totalAudioFrames, Math.ceil(tRel * SR));
    while (audioWritten < targetFrames) {
      if (cancelled) throw new Error('cancelled');
      const n = Math.min(AUDIO_BLOCK, totalAudioFrames - audioWritten);
      const tAbs = o.start + audioWritten / SR;
      await mixer.prepare(p, tAbs, n);
      mixer.mix(p, tAbs, n, L, R);
      planar.set(L.subarray(0, n), 0);
      planar.set(R.subarray(0, n), n);
      const sample = new AudioSample({
        data: planar.subarray(0, n * 2),
        format: 'f32-planar',
        numberOfChannels: 2,
        sampleRate: SR,
        timestamp: audioWritten / SR - priming,
      });
      await audioSource.add(sample);
      sample.close();
      audioWritten += n;
    }
  };

  try {
    await output.start();
    const scale = o.width / p.settings.width;
    let lastReport = 0;
    if (videoSource && compositor) {
      for (let n = 0; n < totalFrames; n++) {
        if (cancelled) throw new Error('cancelled');
        const tRel = n / o.fps;
        const t = o.start + tRel;
        // Keep audio ~1s ahead so the muxer can interleave without buffering everything.
        await writeAudioUntil(tRel + 1);
        const desc = await sources.prepare(p, t);
        compositor.render(desc, sources, scale);
        if (compositor.gl.isContextLost()) throw new Error('The graphics device was reset during export. Please try again.');
        await videoSource.add(tRel, 1 / o.fps);
        const now = performance.now();
        if (now - lastReport > 250 || n === totalFrames - 1) {
          lastReport = now;
          const elapsed = (now - t0) / 1000;
          scope.postMessage({ type: 'progress', frame: n + 1, totalFrames, fps: (n + 1) / Math.max(0.001, elapsed), elapsed, phase: 'rendering' });
        }
      }
    }
    // Audio-only exports (and any audio tail) are written here.
    const audioChunk = 10;
    for (let tRel = 0; audioWritten < totalAudioFrames; tRel += audioChunk) {
      await writeAudioUntil(tRel + audioChunk);
      if (audioOnly) {
        const elapsed = (performance.now() - t0) / 1000;
        scope.postMessage({ type: 'progress', frame: Math.round((audioWritten / totalAudioFrames) * totalFrames), totalFrames, fps: 0, elapsed, phase: 'rendering' });
      }
    }
    scope.postMessage({ type: 'progress', frame: totalFrames, totalFrames, fps: 0, elapsed: (performance.now() - t0) / 1000, phase: 'finalizing' });
    await output.finalize();
    if (o.container === 'webm' && aCodec === 'opus') {
      const buf = memoryTarget?.buffer;
      const fix = opusCodecDelayPatch(writable ? writable.head() : new Uint8Array(buf!, 0, Math.min(WEBM_HEAD_BYTES, buf!.byteLength)));
      if (fix && writable) await writable.patch(fix.position, fix.bytes);
      else if (fix) new Uint8Array(buf!).set(fix.bytes, fix.position);
    }
    const mimeType = await output.getMimeType().catch(() => format.mimeType);
    if (writable) {
      const bytes = await writable.close();
      scope.postMessage({ type: 'done', bytes, mimeType, elapsed: (performance.now() - t0) / 1000, videoCodec: vCodec, audioCodec: aCodec });
    } else {
      const buffer = memoryTarget!.buffer!;
      (scope as unknown as { postMessage(m: ExportWorkerMessage, t: Transferable[]): void }).postMessage(
        { type: 'done', bytes: buffer.byteLength, mimeType, elapsed: (performance.now() - t0) / 1000, videoCodec: vCodec, audioCodec: aCodec, buffer },
        [buffer],
      );
    }
  } catch (e) {
    await output.cancel().catch(() => {});
    await writable?.abort();
    throw e;
  } finally {
    sources.dispose();
    compositor?.dispose();
    for (const s of pcm.values()) s.dispose();
  }
}
