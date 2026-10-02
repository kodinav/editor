import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Download, FolderDown, Play, RotateCcw, XCircle } from 'lucide-react';
import { canEncodeAudio, canEncodeVideo } from 'mediabunny';
import { projectDuration } from '@/core/project';
import { formatDuration } from '@/core/time';
import { ExportError, preflight, runExport, type ExportProgress, type ExportResult } from '@/export/exporter';
import { estimateBytes, videoBitrate, type ExportContainer, type ExportOptions, type ExportQuality } from '@/export/types';
import { editor, useEditor } from '@/state/store';
import { downloadBlob } from '@/ui/download';
import { Modal } from '../common/Modal';
import { Segmented } from '../common/fields';

type Phase = 'setup' | 'running' | 'done' | 'error';

const CONTAINERS: { value: ExportContainer; label: string; hint: string }[] = [
  { value: 'mp4', label: 'MP4', hint: 'H.264 + AAC. Plays everywhere.' },
  { value: 'webm', label: 'WebM', hint: 'VP9 + Opus. Open format, great for the web.' },
  { value: 'mov', label: 'MOV', hint: 'QuickTime container (H.264).' },
  { value: 'm4a', label: 'M4A audio', hint: 'Audio only, AAC.' },
  { value: 'wav', label: 'WAV audio', hint: 'Audio only, uncompressed 16-bit.' },
];

function evenFloor(n: number) {
  return Math.max(2, Math.floor(n / 2) * 2);
}

export default function ExportDialog() {
  const project = useEditor((s) => s.project);
  const close = () => editor().set('dialog', null);
  const { width: PW, height: PH, fps: PF } = project.settings;
  const total = projectDuration(project);
  const hasRange = project.inPoint !== null || project.outPoint !== null;

  const [container, setContainer] = useState<ExportContainer>('mp4');
  const [resIdx, setResIdx] = useState(0);
  const [quality, setQuality] = useState<ExportQuality>('high');
  const [fps, setFps] = useState(PF);
  const [useRange, setUseRange] = useState(hasRange);
  const [includeAudio, setIncludeAudio] = useState(true);
  const [phase, setPhase] = useState<Phase>('setup');
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  // The rendered file is only kept while this dialog can still offer it for download.
  useEffect(() => () => result?.discard?.(), [result]);
  const [error, setError] = useState<string | null>(null);
  const [support, setSupport] = useState<Record<string, boolean>>({});
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const cancelRef = useRef<() => void>(() => {});

  const audioOnly = container === 'm4a' || container === 'wav';

  // Resolution choices: project size and common downscales with the same aspect ratio.
  const resolutions = useMemo(() => {
    const short = Math.min(PW, PH);
    const targets = [short, 2160, 1440, 1080, 720, 480, 360].filter((t, i, a) => t <= short && a.indexOf(t) === i);
    return targets.map((t) => {
      const s = t / short;
      return { w: evenFloor(PW * s), h: evenFloor(PH * s), label: t === short ? `${evenFloor(PW)}×${evenFloor(PH)} (project)` : `${t}p — ${evenFloor(PW * s)}×${evenFloor(PH * s)}` };
    });
  }, [PW, PH]);
  const res = resolutions[Math.min(resIdx, resolutions.length - 1)];

  const start = project.inPoint !== null && useRange ? project.inPoint : 0;
  const end = project.outPoint !== null && useRange ? Math.min(project.outPoint, total || project.outPoint) : total;

  const options: ExportOptions = {
    container,
    width: res.w,
    height: res.h,
    fps,
    quality,
    start,
    end,
    includeAudio: audioOnly ? true : includeAudio,
    fileName: `${project.name.replace(/[\\/:*?"<>|]+/g, '').trim() || 'video'}.${container}`,
    hardware: 'no-preference',
  };

  // Probe codec support for honest options.
  useEffect(() => {
    let alive = true;
    (async () => {
      const w = res.w;
      const h = res.h;
      const br = videoBitrate(w, h, fps, quality, 'avc');
      const [avc, vp9, aac, opus] = await Promise.all([
        canEncodeVideo('avc', { width: w, height: h, bitrate: br, frameRate: fps }).catch(() => false),
        canEncodeVideo('vp9', { width: w, height: h, bitrate: br, frameRate: fps }).catch(() => false),
        canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000, bitrate: 160000 }).catch(() => false),
        canEncodeAudio('opus', { numberOfChannels: 2, sampleRate: 48000, bitrate: 160000 }).catch(() => false),
      ]);
      if (alive) setSupport({ avc, vp9, aac, opus });
    })();
    return () => {
      alive = false;
    };
  }, [res.w, res.h, fps, quality]);

  const issues = preflight(project, options);
  const unsupported =
    (container === 'mp4' || container === 'mov') && support.avc === false
      ? `This browser can’t encode H.264 at ${res.w}×${res.h}. Try a lower resolution or WebM.`
      : container === 'webm' && support.vp9 === false
        ? 'This browser can’t encode VP9. Try MP4.'
        : container === 'm4a' && support.aac === false
          ? 'This browser has no AAC encoder. Try WAV.'
          : null;
  const audioNote = (container === 'mp4' || container === 'mov') && support.aac === false && support.opus ? 'AAC encoding isn’t available here, so audio will be Opus (plays in browsers and VLC, but not QuickTime).' : null;

  const est = estimateBytes(options, container === 'webm' ? 'vp9' : 'avc');

  const begin = async () => {
    let handle: FileSystemFileHandle | null = null;
    const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
    // For big exports, write straight to disk when the browser supports it.
    if (picker && est > 1.5e9) {
      try {
        handle = await picker({ suggestedName: options.fileName });
      } catch (e) {
        if ((e as DOMException).name === 'AbortError') return;
      }
    }
    setPhase('running');
    setError(null);
    setProgress({ phase: 'preparing', frame: 0, totalFrames: 1, fps: 0, elapsed: 0 });
    const job = runExport(editor().project, options, handle, setProgress);
    cancelRef.current = job.cancel;
    try {
      const r = await job.promise;
      setResult(r);
      setPhase('done');
      if (r.file) {
        downloadBlob(r.file, options.fileName);
      }
    } catch (e) {
      if (e instanceof ExportError && e.message === 'cancelled') {
        setPhase('setup');
        return;
      }
      setError((e as Error).message);
      setPhase('error');
    }
  };

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const pct = progress ? Math.round((progress.frame / Math.max(1, progress.totalFrames)) * 100) : 0;
  const eta = progress && progress.fps > 0 ? (progress.totalFrames - progress.frame) / progress.fps : null;

  return (
    <Modal
      title={phase === 'done' ? 'Export complete' : phase === 'running' ? 'Exporting…' : 'Export'}
      onClose={() => {
        if (phase === 'running') {
          if (!window.confirm('Cancel the export in progress?')) return;
          cancelRef.current();
        }
        close();
      }}
      footer={
        phase === 'setup' ? (
          <>
            <button className="btn" onClick={close}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => void begin()} disabled={issues.length > 0 || !!unsupported || end - start <= 0}>
              <Download size={15} /> Export {audioOnly ? 'audio' : 'video'}
            </button>
          </>
        ) : phase === 'running' ? (
          <button className="btn danger" onClick={() => cancelRef.current()}>
            Cancel export
          </button>
        ) : phase === 'done' ? (
          <>
            <button className="btn" onClick={() => setPhase('setup')}>
              <RotateCcw size={14} /> Export again
            </button>
            <button className="btn primary" onClick={close}>
              Done
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={close}>
              Close
            </button>
            <button className="btn primary" onClick={() => setPhase('setup')}>
              Back to settings
            </button>
          </>
        )
      }
    >
      {phase === 'setup' && (
        <div className="col" style={{ gap: 12 }}>
          <div className="field">
            <span className="label">Format</span>
            <select className="select" aria-label="Format" value={container} onChange={(e) => setContainer(e.target.value as ExportContainer)}>
              {CONTAINERS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label} — {c.hint}
                </option>
              ))}
            </select>
          </div>
          {!audioOnly && (
            <>
              <div className="field">
                <span className="label">Resolution</span>
                <select className="select" aria-label="Resolution" value={resIdx} onChange={(e) => setResIdx(Number(e.target.value))}>
                  {resolutions.map((r, i) => (
                    <option key={i} value={i}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <span className="label">Frame rate</span>
                <select className="select" aria-label="Frame rate" value={fps} onChange={(e) => setFps(Number(e.target.value))}>
                  {[...new Set([PF, 24, 25, 30, 50, 60])].sort((a, b) => a - b).map((f) => (
                    <option key={f} value={f}>
                      {f} fps{f === PF ? ' (project)' : ''}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}
          <div className="field">
            <span className="label">Quality</span>
            <Segmented<ExportQuality>
              ariaLabel="Quality"
              value={quality}
              onChange={setQuality}
              options={[
                { value: 'low', label: 'Smaller' },
                { value: 'medium', label: 'Good' },
                { value: 'high', label: 'High' },
                { value: 'best', label: 'Best' },
              ]}
            />
          </div>
          {!audioOnly && (
            <div className="field">
              <span className="label">Audio</span>
              <label className="row" style={{ fontSize: 12.5 }}>
                <input type="checkbox" checked={includeAudio} onChange={(e) => setIncludeAudio(e.target.checked)} /> Include audio
              </label>
            </div>
          )}
          {hasRange && (
            <div className="field">
              <span className="label">Range</span>
              <label className="row" style={{ fontSize: 12.5 }}>
                <input type="checkbox" checked={useRange} onChange={(e) => setUseRange(e.target.checked)} /> Only the in/out range
              </label>
            </div>
          )}
          <div className="export-summary">
            <div>
              <span className="subtle">Length</span>
              <strong>{formatDuration(end - start)}</strong>
            </div>
            <div>
              <span className="subtle">Estimated size</span>
              <strong>~{est > 1e9 ? `${(est / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(est / 1e6))} MB`}</strong>
            </div>
            <div>
              <span className="subtle">Output</span>
              <strong>{audioOnly ? '48 kHz stereo' : `${res.w}×${res.h} · ${fps} fps`}</strong>
            </div>
          </div>
          {unsupported && <div className="callout err">{unsupported}</div>}
          {audioNote && <div className="callout warn">{audioNote}</div>}
          {issues.map((i) => (
            <div key={i} className="callout warn">
              {i}
            </div>
          ))}
          <p className="subtle" style={{ margin: 0, fontSize: 12 }}>
            Rendering happens on this device using your browser’s video encoder. No watermark, nothing uploaded. Keep this tab open until it finishes — it’s fine to switch to other tabs.
          </p>
        </div>
      )}
      {phase === 'running' && progress && (
        <div className="col" style={{ gap: 12 }} aria-live="polite">
          <div className="row">
            <strong className="grow">{progress.phase === 'preparing' ? 'Preparing media…' : progress.phase === 'finalizing' ? 'Finishing file…' : `Rendering frame ${progress.frame} of ${progress.totalFrames}`}</strong>
            <span className="mono">{pct}%</span>
          </div>
          <div className={`progress${progress.phase !== 'rendering' ? ' indeterminate' : ''}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div style={{ width: `${pct}%` }} />
          </div>
          <div className="row subtle" style={{ fontSize: 12 }}>
            <span>Elapsed {formatDuration(progress.elapsed)}</span>
            {progress.fps > 0 && <span>· {progress.fps.toFixed(1)} fps</span>}
            {eta !== null && <span>· about {formatDuration(eta)} left</span>}
          </div>
        </div>
      )}
      {phase === 'done' && result && (
        <div className="col" style={{ gap: 12 }}>
          <div className="row">
            <CheckCircle2 color="var(--success)" size={22} />
            <div className="grow">
              <strong>{options.fileName}</strong>
              <div className="subtle" style={{ fontSize: 12 }}>
                {(result.bytes / 1e6).toFixed(1)} MB · rendered in {formatDuration(result.elapsed)}
                {result.videoCodec ? ` · ${result.videoCodec.toUpperCase()}` : ''}
                {result.audioCodec ? ` + ${result.audioCodec.toUpperCase()}` : ''}
              </div>
            </div>
          </div>
          {result.savedToDisk ? (
            <div className="callout">
              <FolderDown size={14} /> Saved to the location you chose.
            </div>
          ) : (
            <>
              <p className="subtle" style={{ margin: 0, fontSize: 12.5 }}>
                Your download should have started. If not, use the button below.
              </p>
              <div className="row">
                <button className="btn" onClick={() => result.file && downloadBlob(result.file, options.fileName)}>
                  <Download size={14} /> Download again
                </button>
                {!audioOnly && result.file && !previewUrl && (
                  <button className="btn" onClick={() => setPreviewUrl(URL.createObjectURL(result.file!))}>
                    <Play size={14} /> Watch here
                  </button>
                )}
              </div>
              {previewUrl && <video className="export-preview" src={previewUrl} controls autoPlay />}
            </>
          )}
        </div>
      )}
      {/* Spoken status for screen readers: the dialog's visual state changes silently otherwise. */}
      <div className="sr-only" role="status" aria-live="polite">
        {phase === 'done' ? `Export complete. ${result?.savedToDisk ? 'Saved to your chosen location.' : 'Your download has started.'}` : phase === 'error' ? `The export didn’t finish. ${error ?? ''}` : phase === 'running' ? 'Export started.' : ''}
      </div>
      {phase === 'error' && (
        <div className="col" style={{ gap: 10 }}>
          <div className="row">
            <XCircle color="var(--danger)" size={20} />
            <strong>The export didn’t finish.</strong>
          </div>
          <div className="callout err">{error}</div>
          <p className="subtle" style={{ margin: 0, fontSize: 12.5 }}>
            Try a lower resolution, a different format, or close other heavy tabs. Your project is unchanged.
          </p>
        </div>
      )}
    </Modal>
  );
}
