import type { AudioCodec } from 'mediabunny';

/**
 * Lossy audio encoders prepend "priming" samples (AAC usually 2112), so the
 * decoded audio starts late unless the file tells players how much to skip.
 * MP4 says that with an edit list, which the muxer writes when the first audio
 * packet has a negative timestamp. WebCodecs doesn't report the delay, so we
 * measure it: encode a short chirp, decode it again and see where it lands.
 *
 * Opus and Vorbis declare their own pre-skip in the codec header and every
 * decoder honours it, so only codecs that rely on the container are measured.
 */

const SR = 48000;
const CODEC_STRING: Partial<Record<AudioCodec, string>> = { aac: 'mp4a.40.2', mp3: 'mp3' };
/** Typical priming, used when the measurement can't run. */
const FALLBACK: Partial<Record<AudioCodec, number>> = { aac: 2112, mp3: 1105 };

const cache = new Map<string, Promise<number>>();

/** Encoder delay in samples at 48 kHz (0 for codecs that signal it themselves). */
export function encoderDelay(codec: AudioCodec, bitrate: number, channels = 2): Promise<number> {
  const codecString = CODEC_STRING[codec];
  if (!codecString) return Promise.resolve(0);
  const key = `${codec}:${bitrate}:${channels}`;
  let p = cache.get(key);
  if (!p) {
    p = withTimeout(measure(codecString, bitrate, channels), 5000)
      .then((d) => d ?? FALLBACK[codec] ?? 0)
      .catch(() => FALLBACK[codec] ?? 0);
    cache.set(key, p);
  }
  return p;
}

const N = 16384; // total input frames
const AT = 4096; // where the chirp starts
const LEN = 1024; // chirp length

function chirp(): Float32Array {
  const s = new Float32Array(LEN);
  const T = LEN / SR;
  const f0 = 200;
  const f1 = 4000;
  for (let i = 0; i < LEN; i++) {
    const t = i / SR;
    const phase = 2 * Math.PI * (f0 * t + ((f1 - f0) / (2 * T)) * t * t);
    s[i] = 0.5 * Math.sin(phase) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (LEN - 1)));
  }
  return s;
}

async function measure(codec: string, bitrate: number, channels: number): Promise<number | null> {
  if (typeof AudioEncoder === 'undefined' || typeof AudioDecoder === 'undefined') return null;
  const sig = chirp();
  const planar = new Float32Array(N * channels);
  for (let c = 0; c < channels; c++) planar.set(sig, c * N + AT);

  const chunks: EncodedAudioChunk[] = [];
  let config = null as AudioDecoderConfig | null;
  let failure = null as unknown;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      chunks.push(chunk);
      if (meta?.decoderConfig) config = meta.decoderConfig;
    },
    error: (e) => (failure = e),
  });
  try {
    enc.configure({ codec, sampleRate: SR, numberOfChannels: channels, bitrate });
    const data = new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfChannels: channels, numberOfFrames: N, timestamp: 0, data: planar });
    enc.encode(data);
    data.close();
    await enc.flush();
  } finally {
    if (enc.state !== 'closed') enc.close();
  }
  if (failure || !config || chunks.length === 0) return null;
  // WebKit hands out a whole MPEG-4 ES descriptor instead of an AudioSpecificConfig for AAC.
  if (codec.startsWith('mp4a') && !validAsc(config.description)) config = { ...config, description: lcAsc(channels) };

  const decoded: Float32Array[] = [];
  const dec = new AudioDecoder({
    output: (a) => {
      const f = new Float32Array(a.numberOfFrames);
      a.copyTo(f, { planeIndex: 0, format: 'f32-planar' });
      decoded.push(f);
      a.close();
    },
    error: (e) => (failure = e),
  });
  try {
    dec.configure(config);
    for (const c of chunks) dec.decode(c);
    await dec.flush();
  } finally {
    if (dec.state !== 'closed') dec.close();
  }
  if (failure) return null;

  const y = new Float32Array(decoded.reduce((n, f) => n + f.length, 0));
  let o = 0;
  for (const f of decoded) {
    y.set(f, o);
    o += f.length;
  }
  return findLag(sig, y);
}

function validAsc(d: AllowSharedBufferSource | undefined): boolean {
  if (!d || d.byteLength < 2) return false;
  const b = ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d);
  return b[0] >> 3 !== 0; // audio object type
}

/** AudioSpecificConfig for AAC-LC at 48 kHz. */
function lcAsc(channels: number): Uint8Array<ArrayBuffer> {
  const objectType = 2;
  const freqIndex = 3; // 48000 Hz
  return new Uint8Array([(objectType << 3) | (freqIndex >> 1), ((freqIndex & 1) << 7) | (channels << 3)]);
}

/** Lag (samples) at which `sig`, placed at AT, best matches `y`; null if unsure. */
export function findLag(sig: Float32Array, y: Float32Array, at = AT): number | null {
  let best = -Infinity;
  let lag = 0;
  for (let L = -1024; L < 8192; L++) {
    if (at + L < 0 || at + L + sig.length > y.length) continue;
    let s = 0;
    for (let i = 0; i < sig.length; i++) s += sig[i] * y[at + L + i];
    if (s > best) {
      best = s;
      lag = L;
    }
  }
  if (!isFinite(best)) return null;
  let ex = 0;
  let ey = 0;
  for (let i = 0; i < sig.length; i++) {
    ex += sig[i] * sig[i];
    ey += y[at + lag + i] * y[at + lag + i];
  }
  // A clean match correlates well above 0.9; anything weak means the codec mangled the probe.
  return ey > 0 && best / Math.sqrt(ex * ey) > 0.6 ? lag : null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
