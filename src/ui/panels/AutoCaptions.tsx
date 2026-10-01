import { useRef, useState } from 'react';
import { Lock, Sparkles, X } from 'lucide-react';
import { CancelledError, generateCaptions, LANGUAGES, MODEL_INFO, type AutoCaptionProgress } from '@/ai/autoCaptions';
import type { ModelSize } from '@/ai/transcribe.worker';
import { editor, toast, useEditor } from '@/state/store';
import { Segmented } from '../common/fields';

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

/** On-device speech-to-text captions (Whisper in a worker). */
export function AutoCaptions({ onClose }: { onClose: () => void }) {
  const selection = useEditor((s) => s.selection);
  const clips = useEditor((s) => s.project.clips);
  const speechClips = selection.filter((id) => clips[id]?.type === 'video' || clips[id]?.type === 'audio');
  const [model, setModel] = useState<ModelSize>(() => load('ac.model', 'base'));
  const [language, setLanguage] = useState<string | null>(() => load('ac.lang', null));
  const [task, setTask] = useState<'transcribe' | 'translate'>('transcribe');
  const [source, setSource] = useState<'selection' | 'mix'>(speechClips.length ? 'selection' : 'mix');
  const [progress, setProgress] = useState<AutoCaptionProgress | null>(null);
  const [running, setRunning] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const start = async () => {
    save('ac.model', model);
    save('ac.lang', language);
    setRunning(true);
    setProgress({ stage: 'audio', value: 0 });
    const ac = new AbortController();
    abort.current = ac;
    try {
      const res = await generateCaptions({ model, language, task, clipIds: source === 'selection' && speechClips.length ? speechClips : null }, setProgress, ac.signal);
      const langName = LANGUAGES.find((l) => l.code === res.language)?.name ?? res.language.toUpperCase();
      toast({
        kind: 'success',
        message: `Created ${res.cues} captions${language ? '' : ` (detected ${langName})`}.`,
        detail: 'Edit any caption’s text in this panel; drag edges on the timeline to adjust timing.',
      });
      editor().set('selectedTrackId', res.trackId);
      onClose();
    } catch (e) {
      if (!(e instanceof CancelledError)) toast({ kind: 'error', message: 'Auto captions failed.', detail: (e as Error).message });
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  const label = (() => {
    if (!progress) return '';
    if (progress.stage === 'audio') return `Preparing audio… ${Math.round(progress.value * 100)}%`;
    if (progress.stage === 'download') return `Downloading speech model… ${Math.round((progress.loaded / Math.max(1, progress.total)) * 100)}% (${(progress.loaded / 1e6).toFixed(0)} of ${(progress.total / 1e6).toFixed(0)} MB)`;
    return `Transcribing… ${progress.done} of ${progress.total} parts`;
  })();
  const pct = !progress ? 0 : progress.stage === 'download' ? progress.loaded / Math.max(1, progress.total) : progress.value;

  return (
    <div className="recorder" role="region" aria-label="Automatic captions">
      <div className="row">
        <Sparkles size={15} />
        <strong className="grow">Auto captions</strong>
        <button className="icon-btn tiny" aria-label="Close" onClick={() => (running ? abort.current?.abort() : onClose())}>
          <X size={14} />
        </button>
      </div>
      {!running ? (
        <>
          {speechClips.length > 0 && (
            <Segmented
              ariaLabel="Audio source"
              value={source}
              onChange={setSource}
              options={[
                { value: 'selection', label: `Selected clip${speechClips.length > 1 ? 's' : ''}` },
                { value: 'mix', label: 'Whole timeline' },
              ]}
            />
          )}
          <div className="field" style={{ gridTemplateColumns: '80px 1fr' }}>
            <span className="label" aria-hidden="true">Language</span>
            <select className="select" aria-label="Language" value={language ?? ''} onChange={(e) => setLanguage(e.target.value || null)}>
              {LANGUAGES.map((l) => (
                <option key={l.code ?? 'auto'} value={l.code ?? ''}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ gridTemplateColumns: '80px 1fr' }}>
            <span className="label" aria-hidden="true">Output</span>
            <select className="select" aria-label="Output language" value={task} onChange={(e) => setTask(e.target.value as 'transcribe' | 'translate')}>
              <option value="transcribe">Same language as spoken</option>
              <option value="translate">Translate to English</option>
            </select>
          </div>
          <div className="field" style={{ gridTemplateColumns: '80px 1fr' }}>
            <span className="label">Model</span>
            <Segmented
              ariaLabel="Model"
              value={model}
              onChange={setModel}
              options={(['tiny', 'base'] as ModelSize[]).map((m) => ({ value: m, label: `${MODEL_INFO[m].label} · ${MODEL_INFO[m].size}` }))}
            />
          </div>
          <div className="callout" style={{ display: 'flex', gap: 8 }}>
            <Lock size={14} style={{ flexShrink: 0, marginTop: 2 }} />
            <span>
              Runs on this device. The first time, the speech model ({MODEL_INFO[model].size}) is downloaded from Hugging Face and cached. Your audio is never uploaded.
            </span>
          </div>
          <button className="btn primary" onClick={() => void start()}>
            <Sparkles size={14} /> Generate captions
          </button>
        </>
      ) : (
        <>
          <div className="row" style={{ fontSize: 12.5 }} aria-live="polite">
            <span className="spinner" />
            <span className="grow">{label}</span>
          </div>
          <div className="progress">
            <div style={{ width: `${Math.round(pct * 100)}%` }} />
          </div>
          <button className="btn small" onClick={() => abort.current?.abort()}>
            Cancel
          </button>
        </>
      )}
    </div>
  );
}
