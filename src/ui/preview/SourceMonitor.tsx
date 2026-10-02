import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Pause, Play, Plus } from 'lucide-react';
import { formatTimecode } from '@/core/time';
import { media } from '@/media/registry';
import { addAssetsToTimeline } from '@/state/importer';
import { editor, useEditor } from '@/state/store';

/**
 * Source preview: watch a video or audio file from the media bin before it is
 * on the timeline, mark the part you want (I / O), and add just that part.
 * Uses the browser's own media element on the local file — nothing uploads.
 */
export function SourceMonitor({ assetId }: { assetId: string }) {
  const asset = useEditor((s) => s.project.assets[assetId]);
  const fps = useEditor((s) => s.project.settings.fps);
  const file = media.getFile(assetId);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) return;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  const el = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const duration = asset?.duration ?? 0;
  const [range, setRange] = useState({ start: 0, end: duration });
  useEffect(() => setRange({ start: 0, end: duration }), [assetId, duration]);

  const close = () => editor().set('sourcePreview', null);
  const seek = (v: number) => {
    const m = el.current;
    if (!m) return;
    m.currentTime = Math.max(0, Math.min(duration, v));
    setT(m.currentTime);
  };
  const toggle = () => {
    const m = el.current;
    if (!m) return;
    if (m.paused) void m.play();
    else m.pause();
  };
  const markIn = () => setRange((r) => ({ start: Math.min(t, r.end - 1 / fps), end: r.end }));
  const markOut = () => setRange((r) => ({ start: r.start, end: Math.max(t, r.start + 1 / fps) }));
  const add = () => {
    el.current?.pause();
    const ids = addAssetsToTimeline([assetId], undefined, undefined, range);
    if (ids.length) close();
  };

  // While it is open, the playback keys act on the source (not the timeline).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const typing = (tag === 'INPUT' && (target as HTMLInputElement).type !== 'range') || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable;
      if (typing || document.querySelector('dialog[open]') || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      const handled = k === ' ' || k === 'i' || k === 'o' || k === 'escape' || k === 'arrowleft' || k === 'arrowright' || k === 'k' || k === 'l' || k === 'j';
      if (!handled) return;
      e.preventDefault();
      e.stopPropagation();
      const m = el.current;
      if (k === ' ' || k === 'k' || k === 'l') {
        if (k === 'k') m?.pause();
        else if (k === 'l') void m?.play();
        else toggle();
      } else if (k === 'i') markIn();
      else if (k === 'o') markOut();
      else if (k === 'escape') close();
      else if (k === 'j') seek((m?.currentTime ?? 0) - 1);
      else seek((m?.currentTime ?? 0) + (k === 'arrowright' ? 1 : -1) / fps);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  if (!asset || !url) return null;
  const isVideo = asset.kind === 'video';
  const pct = (v: number) => `${duration ? (v / duration) * 100 : 0}%`;
  const bind = {
    ref: (m: HTMLVideoElement | HTMLAudioElement | null) => void (el.current = m),
    src: url,
    onTimeUpdate: (e: React.SyntheticEvent<HTMLMediaElement>) => setT(e.currentTarget.currentTime),
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    preload: 'auto' as const,
  };
  return (
    <div className="source-monitor" role="region" aria-label={`Source preview: ${asset.name}`}>
      <div className="source-head">
        <button className="btn small" onClick={close}>
          <ArrowLeft size={14} /> Timeline
        </button>
        <span className="ellipsis grow" title={asset.name}>
          {asset.name}
        </span>
        <span className="subtle mono">
          {formatTimecode(range.start, fps)} – {formatTimecode(range.end, fps)} ({(range.end - range.start).toFixed(1)} s)
        </span>
      </div>
      <div className="source-media">{isVideo ? <video {...bind} playsInline /> : <audio {...bind} />}</div>
      <div className="source-bar">
        <input
          type="range"
          className="slider grow"
          aria-label="Position in source"
          min={0}
          max={duration}
          step={1 / fps}
          value={t}
          onChange={(e) => seek(Number(e.target.value))}
          style={{ ['--fill' as string]: pct(t) }}
        />
        <div className="source-range" aria-hidden="true" style={{ left: pct(range.start), width: `calc(${pct(range.end)} - ${pct(range.start)})` }} />
      </div>
      <div className="source-controls">
        <button className="icon-btn" aria-label={playing ? 'Pause source' : 'Play source'} data-kbd="Space" onClick={toggle}>
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <span className="mono subtle">{formatTimecode(t, fps)}</span>
        <span className="grow" />
        <button className="btn small" onClick={markIn} data-tip="Mark in (I)">
          Mark in
        </button>
        <button className="btn small" onClick={markOut} data-tip="Mark out (O)">
          Mark out
        </button>
        <button className="btn small primary" onClick={add} data-tip="Add the marked part at the playhead">
          <Plus size={14} /> Add to timeline
        </button>
      </div>
    </div>
  );
}
