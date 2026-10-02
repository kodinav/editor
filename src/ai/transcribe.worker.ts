import { env, pipeline, Tensor } from '@huggingface/transformers';

/**
 * On-device speech recognition (Whisper via ONNX Runtime Web).
 *
 * Privacy: audio arrives from the page as raw samples and never leaves this
 * worker. The only network traffic is the one-time model download from
 * Hugging Face, cached by the browser afterwards.
 */

export type ModelSize = 'tiny' | 'base';

export interface LoadMsg {
  type: 'load';
  model: ModelSize;
}
export interface TranscribeMsg {
  type: 'transcribe';
  id: number;
  audio: Float32Array;
  language: string | null;
  task: 'transcribe' | 'translate';
}
export interface DetectMsg {
  type: 'detect';
  id: number;
  audio: Float32Array;
}
export type WorkerIn = LoadMsg | TranscribeMsg | DetectMsg;

export interface WordChunk {
  text: string;
  timestamp: [number, number | null];
}

export type WorkerOut =
  | { type: 'download'; loaded: number; total: number; file: string }
  | { type: 'ready'; device: string }
  | { type: 'result'; id: number; text: string; chunks: WordChunk[] }
  | { type: 'language'; id: number; code: string; confidence: number }
  | { type: 'error'; id?: number; message: string };

const MODELS: Record<ModelSize, string> = {
  tiny: 'onnx-community/whisper-tiny_timestamped',
  base: 'onnx-community/whisper-base_timestamped',
};

const base = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');
env.allowLocalModels = false;
env.useBrowserCache = true;
// Load the runtime from our own origin (no CDN code, CSP-friendly).
env.useWasmCache = false;
if (env.backends.onnx?.wasm) {
  env.backends.onnx.wasm.wasmPaths = {
    mjs: new URL(`${base}ort/ort-wasm-simd-threaded.asyncify.mjs`, self.location.origin).href,
    wasm: new URL(`${base}ort/ort-wasm-simd-threaded.asyncify.wasm`, self.location.origin).href,
  };
}

type Asr = ((audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string; chunks?: WordChunk[] }>) & {
  processor: (audio: Float32Array) => Promise<{ input_features: unknown }>;
  model: ((inputs: Record<string, unknown>) => Promise<{ logits: { data: Float32Array; dims: number[] } }>) & {
    generation_config: { decoder_start_token_id: number; lang_to_id?: Record<string, number> };
  };
};

let asr: Asr | null = null;
let loaded: ModelSize | null = null;
let loading: Promise<void> | null = null;
const fileProgress = new Map<string, { loaded: number; total: number }>();

const post = (m: WorkerOut) => (self as unknown as { postMessage(m: WorkerOut): void }).postMessage(m);

async function load(model: ModelSize) {
  if (asr && loaded === model) return;
  if (loading) await loading;
  if (asr && loaded === model) return;
  loading = (async () => {
    fileProgress.clear();
    const p = await pipeline('automatic-speech-recognition', MODELS[model], {
      device: 'wasm',
      dtype: 'q8',
      progress_callback: (ev: { status: string; file?: string; loaded?: number; total?: number }) => {
        if (ev.status === 'progress' && ev.file && ev.total) {
          fileProgress.set(ev.file, { loaded: ev.loaded ?? 0, total: ev.total });
          let l = 0;
          let t = 0;
          for (const v of fileProgress.values()) {
            l += v.loaded;
            t += v.total;
          }
          post({ type: 'download', loaded: l, total: t, file: ev.file });
        }
      },
    });
    asr = p as unknown as Asr;
    loaded = model;
  })();
  try {
    await loading;
  } finally {
    loading = null;
  }
}

/**
 * Whisper's own language identification: one decoder step from
 * <|startoftranscript|>, then the most probable language token.
 */
async function detectLanguage(audio: Float32Array): Promise<{ code: string; confidence: number }> {
  if (!asr) throw new Error('Model not loaded');
  const cfg = asr.model.generation_config;
  const langs = cfg.lang_to_id;
  if (!langs) return { code: 'en', confidence: 1 };
  const { input_features } = await asr.processor(audio.subarray(0, 30 * 16000));
  const sot = BigInt(cfg.decoder_start_token_id);
  const out = await asr.model({ input_features, decoder_input_ids: new Tensor('int64', BigInt64Array.from([sot]), [1, 1]) });
  const logits = out.logits.data;
  const vocab = out.logits.dims[out.logits.dims.length - 1];
  const row = logits.subarray(logits.length - vocab);
  let best = '';
  let bestV = -Infinity;
  let sum = 0;
  const entries = Object.entries(langs);
  const max = Math.max(...entries.map(([, id]) => row[id]));
  for (const [tok, id] of entries) {
    const v = row[id];
    sum += Math.exp(v - max);
    if (v > bestV) {
      bestV = v;
      best = tok;
    }
  }
  const confidence = 1 / sum; // softmax probability of the best language among languages
  return { code: best.replace(/^<\|/, '').replace(/\|>$/, ''), confidence };
}

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      // Answer every load request, including when the model is already loaded (a second run).
      await load(m.model);
      post({ type: 'ready', device: 'wasm' });
    } else if (m.type === 'detect') {
      const r = await detectLanguage(m.audio);
      post({ type: 'language', id: m.id, code: r.code, confidence: r.confidence });
    } else if (m.type === 'transcribe') {
      if (!asr) throw new Error('Model not loaded');
      const out = await asr(m.audio, {
        return_timestamps: 'word',
        language: m.language ?? undefined,
        task: m.task,
      });
      post({ type: 'result', id: m.id, text: out.text, chunks: out.chunks ?? [] });
    }
  } catch (err) {
    post({ type: 'error', id: m.type === 'load' ? undefined : m.id, message: String((err as Error)?.message ?? err) });
  }
};
