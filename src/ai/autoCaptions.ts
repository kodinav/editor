import { startBusy } from '@/state/busy';
import { produce } from 'immer';
import { addTrack, clearTrackRange, frameCues, makeRoomFor } from '@/core/ops';
import { clipEnd, createCaptionClip, projectDuration, scaledCaptionStyle } from '@/core/project';
import type { Project } from '@/core/types';
import { AudioMixer } from '@/engine/audioMixer';
import { media } from '@/media/registry';
import { editor, toast } from '@/state/store';
import { chooseWindows, groupWords, NO_SPACE_LANGUAGES, type Word } from './words';
import type { ModelSize, WorkerIn, WorkerOut } from './transcribe.worker';

/**
 * Automatic captions, computed entirely on this device:
 *  1. render the speech audio with the project mixer (48 kHz) and low-pass /
 *     decimate it to the 16 kHz mono Whisper expects,
 *  2. split it into ≤30 s windows at quiet moments,
 *  3. transcribe each window in a worker (word timestamps),
 *  4. group words into readable caption clips with per-word timing.
 */

export interface AutoCaptionOptions {
  model: ModelSize;
  /** ISO code, or null to auto-detect. */
  language: string | null;
  task: 'transcribe' | 'translate';
  /** Only these clips' audio (e.g. the selected voice clip); null = full mix. */
  clipIds: string[] | null;
}

export type AutoCaptionProgress =
  | { stage: 'audio'; value: number }
  | { stage: 'download'; loaded: number; total: number }
  | { stage: 'transcribe'; value: number; done: number; total: number };

export const LANGUAGES: { code: string | null; name: string }[] = [
  { code: null, name: 'Detect automatically' },
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'nl', name: 'Dutch' },
  { code: 'hi', name: 'Hindi' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ru', name: 'Russian' },
  { code: 'ar', name: 'Arabic' },
  { code: 'tr', name: 'Turkish' },
  { code: 'pl', name: 'Polish' },
  { code: 'id', name: 'Indonesian' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'sv', name: 'Swedish' },
];

export const MODEL_INFO: Record<ModelSize, { label: string; size: string }> = {
  tiny: { label: 'Fast', size: '41 MB' },
  base: { label: 'Accurate', size: '77 MB' },
};

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
  }
}

/* ------------------------------ audio render ------------------------------ */

/** Streaming 3:1 decimator with a windowed-sinc low-pass (cutoff ~7 kHz at 48 kHz). */
class Decimator3 {
  private taps: Float32Array;
  private hist: Float32Array;
  private phase = 0;

  constructor(n = 63) {
    const fc = 7000 / 48000;
    this.taps = new Float32Array(n);
    const m = (n - 1) / 2;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const x = i - m;
      const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
      this.taps[i] = sinc * w;
      sum += this.taps[i];
    }
    for (let i = 0; i < n; i++) this.taps[i] /= sum;
    this.hist = new Float32Array(n - 1);
  }

  push(input: Float32Array): Float32Array {
    const n = this.taps.length;
    const buf = new Float32Array(this.hist.length + input.length);
    buf.set(this.hist, 0);
    buf.set(input, this.hist.length);
    const out: number[] = [];
    // Output sample k corresponds to input index (hist.length + j) with j ≡ phase (mod 3).
    let j = this.phase;
    for (; j < input.length; j += 3) {
      const end = this.hist.length + j; // newest sample index in buf
      let acc = 0;
      for (let t = 0; t < n; t++) acc += this.taps[t] * buf[end - t];
      out.push(acc);
    }
    this.phase = j - input.length;
    this.hist = buf.slice(buf.length - (n - 1));
    return Float32Array.from(out);
  }
}

/** Project copy in which only the given clips are audible. */
function isolate(p: Project, clipIds: string[] | null): Project {
  if (!clipIds) return p;
  const keep = new Set(clipIds);
  return produce(p, (d) => {
    for (const c of Object.values(d.clips)) {
      if ((c.type === 'video' || c.type === 'audio') && !keep.has(c.id)) c.muted = true;
    }
    for (const t of d.tracks) t.muted = false;
    d.masterVolume = 1;
  });
}

export async function renderSpeechAudio(
  p: Project,
  range: { start: number; end: number },
  clipIds: string[] | null,
  onProgress: (f: number) => void,
  signal?: AbortSignal,
): Promise<Float32Array> {
  const proj = isolate(p, clipIds);
  const SR = 48000;
  const mixer = new AudioMixer(media, SR);
  const dec = new Decimator3();
  const block = SR * 4;
  const L = new Float32Array(block);
  const R = new Float32Array(block);
  const total = Math.max(0, Math.round((range.end - range.start) * SR));
  const out = new Float32Array(Math.ceil(total / 3) + 8);
  let written = 0;
  for (let pos = 0; pos < total; pos += block) {
    if (signal?.aborted) throw new CancelledError();
    const n = Math.min(block, total - pos);
    const t = range.start + pos / SR;
    await mixer.prepare(proj, t, n);
    mixer.mix(proj, t, n, L, R);
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) mono[i] = (L[i] + R[i]) * 0.5;
    const d = dec.push(mono);
    out.set(d.subarray(0, Math.min(d.length, out.length - written)), written);
    written += d.length;
    onProgress(Math.min(1, (pos + n) / total));
    await new Promise((r) => setTimeout(r, 0));
  }
  return out.subarray(0, Math.min(written, out.length));
}

/* ------------------------------ worker client ------------------------------ */

let worker: Worker | null = null;
let seq = 0;

function getWorker(): Worker {
  if (!worker) worker = new Worker(new URL('./transcribe.worker.ts', import.meta.url), { type: 'module', name: 'transcribe' });
  return worker;
}

function call<T extends WorkerOut['type']>(msg: WorkerIn, until: T, onMsg?: (m: WorkerOut) => void, signal?: AbortSignal): Promise<Extract<WorkerOut, { type: T }>> {
  const w = getWorker();
  return new Promise((resolve, reject) => {
    const id = msg.type === 'load' ? undefined : msg.id;
    const onAbort = () => {
      cleanup();
      // A running inference can't be interrupted; restart the worker instead.
      w.terminate();
      worker = null;
      reject(new CancelledError());
    };
    const handler = (ev: MessageEvent<WorkerOut>) => {
      const m = ev.data;
      if (m.type === 'error' && (m.id === undefined || m.id === id)) {
        cleanup();
        reject(new Error(m.message));
        return;
      }
      if (m.type === until && (!('id' in m) || m.id === id)) {
        cleanup();
        resolve(m as Extract<WorkerOut, { type: T }>);
        return;
      }
      onMsg?.(m);
    };
    const onError = (e: ErrorEvent) => {
      cleanup();
      worker?.terminate();
      worker = null;
      reject(new Error(e.message || 'The speech recognition worker crashed.'));
    };
    const cleanup = () => {
      w.removeEventListener('message', handler);
      w.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    w.addEventListener('message', handler);
    w.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort);
    w.postMessage(msg, msg.type === 'load' ? [] : [msg.audio.buffer]);
  });
}

/* --------------------------------- pipeline -------------------------------- */

export interface AutoCaptionResult {
  cues: number;
  words: number;
  trackId: string;
  /** Language used (detected or chosen). */
  language: string;
}

export async function generateCaptions(opts: AutoCaptionOptions, onProgress: (p: AutoCaptionProgress) => void, signal?: AbortSignal): Promise<AutoCaptionResult> {
  const done = startBusy('automatic captions');
  try {
    return await runCaptions(opts, onProgress, signal);
  } finally {
    done();
  }
}

async function runCaptions(opts: AutoCaptionOptions, onProgress: (p: AutoCaptionProgress) => void, signal?: AbortSignal): Promise<AutoCaptionResult> {
  const p = editor().project;
  const clips = opts.clipIds?.map((id) => p.clips[id]).filter(Boolean) ?? [];
  const range = clips.length ? { start: Math.min(...clips.map((c) => c.start)), end: Math.max(...clips.map(clipEnd)) } : { start: 0, end: projectDuration(p) };
  if (range.end - range.start < 0.3) throw new Error('There is no audio to caption yet.');
  for (const c of clips.length ? clips : Object.values(p.clips)) {
    if ((c.type === 'video' || c.type === 'audio') && p.assets[c.assetId]?.audio && !p.assets[c.assetId].audio!.conformed) {
      throw new Error(`Audio for “${p.assets[c.assetId].name}” is still being prepared. Try again in a moment.`);
    }
  }

  // Start loading the model while the audio renders.
  const loadPromise = call({ type: 'load', model: opts.model }, 'ready', (m) => {
    if (m.type === 'download') onProgress({ stage: 'download', loaded: m.loaded, total: m.total });
  }, signal);
  loadPromise.catch(() => {});

  const audio = await renderSpeechAudio(p, range, opts.clipIds, (v) => onProgress({ stage: 'audio', value: v }), signal);
  const SR = 16000;
  const winS = 0.02;
  const win = SR * winS;
  const rms = new Float32Array(Math.ceil(audio.length / win));
  let peak = 0;
  for (let i = 0; i < rms.length; i++) {
    let acc = 0;
    const a = i * win;
    const b = Math.min(audio.length, a + win);
    for (let j = a; j < b; j++) acc += audio[j] * audio[j];
    rms[i] = Math.sqrt(acc / Math.max(1, b - a));
    if (rms[i] > peak) peak = rms[i];
  }
  if (peak < 0.003) throw new Error('The selected audio is silent.');

  await loadPromise;
  const windows = chooseWindows(rms, winS, audio.length / SR);
  const hasSpeech = ([a, b]: [number, number]) => {
    let maxR = 0;
    for (let k = Math.floor(a / winS); k < Math.min(rms.length, Math.ceil(b / winS)); k++) maxR = Math.max(maxR, rms[k]);
    return maxR >= 0.01;
  };
  // Detect the spoken language once (Whisper's own language identification).
  let language = opts.language;
  if (!language) {
    const first = windows.find(hasSpeech) ?? windows[0];
    const det = await call({ type: 'detect', id: ++seq, audio: audio.slice(Math.floor(first[0] * SR), Math.floor(first[1] * SR)) }, 'language', undefined, signal);
    language = det.code;
  }
  const words: Word[] = [];
  for (let i = 0; i < windows.length; i++) {
    if (signal?.aborted) throw new CancelledError();
    const [a, b] = windows[i];
    onProgress({ stage: 'transcribe', value: i / windows.length, done: i, total: windows.length });
    // Skip windows without speech-level energy (Whisper hallucinates on silence).
    if (!hasSpeech([a, b])) continue;
    const slice = audio.slice(Math.floor(a * SR), Math.floor(b * SR));
    const res = await call({ type: 'transcribe', id: ++seq, audio: slice, language, task: opts.task }, 'result', undefined, signal);
    for (const ch of res.chunks) {
      const s = ch.timestamp[0] ?? 0;
      const e = ch.timestamp[1] ?? s + 0.3;
      if (!ch.text.trim()) continue;
      words.push({ text: ch.text, start: range.start + a + s, end: range.start + a + Math.max(e, s + 0.05) });
    }
  }
  onProgress({ stage: 'transcribe', value: 1, done: windows.length, total: windows.length });

  const noSpaces = NO_SPACE_LANGUAGES.has(language ?? '');
  const cues = groupWords(words, {
    // Characters in these scripts carry about two Latin letters' worth of meaning.
    maxChars: Math.round((noSpaces ? 20 : 42) * Math.max(0.6, Math.min(1, p.settings.width / p.settings.height))),
    maxDuration: 3.5,
    maxGap: 0.6,
    minDuration: 0.8,
    noSpaces,
  });
  if (cues.length === 0) throw new Error('No speech was recognized.');
  // Transcription takes a while: the captions belong to the project (and timing) it started from.
  if (editor().project.id !== p.id) throw new Error('A different project was opened while transcribing, so the captions were not added.');
  const timing = (q: typeof p) => JSON.stringify(Object.values(q.clips).flatMap((c) => ('assetId' in c ? [c.id, c.start, c.duration, 'sourceIn' in c ? c.sourceIn : 0] : [])));
  if (timing(editor().project) !== timing(p)) {
    toast({ kind: 'warning', message: 'Clips moved while captions were being made.', detail: 'Check that the new captions still line up with the speech.' });
  }
  let trackId = '';
  editor().commit('Auto captions', (d) => {
    // Running again replaces the earlier result for this range rather than stacking a new track.
    let t = d.tracks.find((x) => x.kind === 'caption' && x.name === 'Auto captions');
    if (t) clearTrackRange(d, t.id, range.start, range.end);
    else {
      t = addTrack(d, 'caption');
      t.name = 'Auto captions';
      t.captionStyle = { ...scaledCaptionStyle(d.settings.height), activeWordColor: '#ffd84d' };
    }
    trackId = t.id;
    const ids: string[] = [];
    for (const c of frameCues(d, cues)) {
      const shift = c.start - c.qStart;
      const clip = createCaptionClip({ trackId: t.id, start: c.qStart, duration: c.qEnd - c.qStart }, c.text);
      clip.words = c.words.map((w) => ({ text: w.text, start: Math.max(0, w.start + shift), end: w.end + shift }));
      d.clips[clip.id] = clip;
      ids.push(clip.id);
    }
    makeRoomFor(d, ids, 'overwrite');
  });
  return { cues: cues.length, words: words.length, trackId, language: language ?? 'en' };
}
