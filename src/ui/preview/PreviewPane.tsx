import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ChevronFirst,
  ChevronLast,
  Expand,
  Grid3x3,
  Pause,
  Play,
  Repeat,
  SkipBack,
  SkipForward,
  Upload,
  Type,
  Square,
  Mic,
  Camera,
} from 'lucide-react';
import { projectDuration, FORMAT_PRESETS } from '@/core/project';
import { formatTimecode, parseTime } from '@/core/time';
import { player, usePreviewInfo } from '@/playback/player';
import { editor, useEditor, usePlayback, type PreviewQuality } from '@/state/store';
import * as A from '@/state/actions';
import { openMenuBelow } from '../common/Menu';
import { openImportPicker } from '../importPicker';
import { Gizmo } from './Gizmo';
import { FormatShape } from '../common/FormatShape';
import { usePreviewDrop } from './PreviewDrop';
import { applyTemplate, TEMPLATES } from '@/state/templates';

export function PreviewPane({ compact }: { compact?: boolean }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const width = useEditor((s) => s.project.settings.width);
  const height = useEditor((s) => s.project.settings.height);
  const empty = useEditor((s) => Object.keys(s.project.clips).length === 0);
  const showSafe = useEditor((s) => s.showSafeArea);
  const error = usePreviewInfo((s) => s.error);
  const [box, setBox] = useState({ w: 0, h: 0, left: 0, top: 0 });
  const drop = usePreviewDrop();

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    player.attach(c);
    return () => player.detach();
  }, []);

  useLayoutEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const update = () => {
      const pad = compact ? 8 : 16;
      const W = vp.clientWidth - pad * 2;
      const H = vp.clientHeight - pad * 2;
      const s = Math.max(0.01, Math.min(W / width, H / height));
      const w = Math.floor(width * s);
      const h = Math.floor(height * s);
      setBox({ w, h, left: Math.floor((vp.clientWidth - w) / 2), top: Math.floor((vp.clientHeight - h) / 2) });
      player.setDisplaySize(w, h, window.devicePixelRatio || 1);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(vp);
    return () => ro.disconnect();
  }, [width, height, compact]);

  return (
    <div className="preview">
      {!compact && <PreviewHeader />}
      <div className="preview-viewport" ref={viewportRef}>
        <div className={`preview-stage${drop.over ? ' drop-over' : ''}`} style={{ width: box.w, height: box.h, left: box.left, top: box.top }} {...drop.props}>
          <canvas ref={canvasRef} className="preview-canvas" style={{ width: box.w, height: box.h }} aria-label="Video preview" role="img" />
          {showSafe && <div className="safe-area" aria-hidden="true" />}
          <Gizmo stageW={box.w} stageH={box.h} />
        </div>
        {empty && <EmptyState />}
        {error && (
          <div className="preview-error callout err" role="alert">
            {error} Try a recent version of Chrome, Edge, Firefox or Safari with hardware acceleration enabled.
          </div>
        )}
      </div>
      <Transport compact={compact} />
    </div>
  );
}

function PreviewHeader() {
  const width = useEditor((s) => s.project.settings.width);
  const height = useEditor((s) => s.project.settings.height);
  const fps = useEditor((s) => s.project.settings.fps);
  const quality = useEditor((s) => s.previewQuality);
  const showSafe = useEditor((s) => s.showSafeArea);
  const set = useEditor((s) => s.set);
  const preset = FORMAT_PRESETS.find((p) => p.width === width && p.height === height);
  const qualityLabel: Record<PreviewQuality, string> = { auto: 'Auto', full: 'Full', half: '1/2', quarter: '1/4' };
  return (
    <div className="preview-head">
      <button
        className="chip"
        onClick={(e) =>
          openMenuBelow(e.currentTarget, [
            { kind: 'label', label: 'Canvas format' },
            ...FORMAT_PRESETS.map((p) => ({
              label: `${p.label} — ${p.hint}`,
              checked: p.width === width && p.height === height,
              onClick: () =>
                editor().commit('Change format', (d) => {
                  d.settings.width = p.width;
                  d.settings.height = p.height;
                  d.settings.chosen = true;
                }),
            })),
            { kind: 'separator' },
            { label: 'Custom size & frame rate…', onClick: () => set('dialog', 'settings') },
          ])
        }
        aria-haspopup="menu"
        data-tip="Canvas format"
      >
        {preset ? preset.id : `${width}×${height}`} · {width}×{height} · {fps} fps
      </button>
      <div className="grow" />
      <button className={`icon-btn small${showSafe ? ' active' : ''}`} aria-pressed={showSafe} aria-label="Safe area guides" data-tip="Safe area guides" onClick={() => set('showSafeArea', !showSafe)}>
        <Grid3x3 size={15} />
      </button>
      <button
        className="chip"
        aria-haspopup="menu"
        data-tip="Preview quality (export always renders at full quality)"
        onClick={(e) =>
          openMenuBelow(
            e.currentTarget,
            (['auto', 'full', 'half', 'quarter'] as PreviewQuality[]).map((q) => ({
              label: q === 'auto' ? 'Auto (match display)' : q === 'full' ? 'Full resolution' : q === 'half' ? 'Half resolution' : 'Quarter resolution',
              checked: quality === q,
              onClick: () => set('previewQuality', q),
            })),
            'right',
          )
        }
      >
        Preview: {qualityLabel[quality]}
      </button>
      <button
        className="icon-btn small"
        aria-label="Save frame as PNG"
        data-tip="Save this frame as an image"
        onClick={() => void import('@/export/snapshot').then((m) => m.exportCurrentFrame())}
      >
        <Camera size={15} />
      </button>
      <button
        className="icon-btn small"
        aria-label="Fullscreen preview"
        data-tip="Fullscreen"
        onClick={() => {
          const el = document.querySelector('.preview') as HTMLElement | null;
          if (document.fullscreenElement) void document.exitFullscreen();
          else void el?.requestFullscreen?.();
        }}
      >
        <Expand size={15} />
      </button>
    </div>
  );
}

function EmptyState() {
  const set = useEditor((s) => s.set);
  const width = useEditor((s) => s.project.settings.width);
  const height = useEditor((s) => s.project.settings.height);
  return (
    <div className="empty-state">
      <div className="empty-card">
        <h1>Start editing</h1>
        <p>Drop video, photos or music anywhere, or pick files. Everything stays on your device.</p>
        <button className="btn primary big" onClick={() => openImportPicker()}>
          <Upload size={16} /> Import media
        </button>
        <div className="empty-row">
          <button className="btn" onClick={() => A.addTextPreset('title')}>
            <Type size={14} /> Add a title
          </button>
          <button className="btn" onClick={() => A.addShape('rectangle', { fullFrame: true, fill: '#2f6bff', fill2: '#8f5bff' })}>
            <Square size={14} /> Color background
          </button>
          <button
            className="btn"
            onClick={() => {
              set('leftPanel', 'media');
              set('leftOpen', true);
              setTimeout(() => (document.querySelector('[aria-label="Record voiceover"]') as HTMLElement | null)?.click(), 50);
            }}
          >
            <Mic size={14} /> Record audio
          </button>
        </div>
        <div className="template-row" role="group" aria-label="Start from a template">
          <span className="subtle">Or start from a template:</span>
          {TEMPLATES.map((t) => (
            <button key={t.id} className="chip" onClick={() => applyTemplate(t.id)} data-tip={t.description}>
              {t.name}
            </button>
          ))}
        </div>
        <div className="format-pick" role="group" aria-label="Canvas format">
          {FORMAT_PRESETS.slice(0, 4).map((p) => (
            <button
              key={p.id}
              aria-pressed={p.width === width && p.height === height}
              onClick={() =>
                editor().commit('Change format', (d) => {
                  d.settings.width = p.width;
                  d.settings.height = p.height;
                  d.settings.chosen = true;
                })
              }
            >
              <FormatShape width={p.width} height={p.height} />
              <span>{p.id}</span>
              <span className="subtle">{p.hint.split(',')[0]}</span>
            </button>
          ))}
        </div>
        <p className="subtle" style={{ fontSize: 12, marginTop: 14 }}>
          No account needed · No watermark · Works offline after the first visit
        </p>
      </div>
    </div>
  );
}

function Transport({ compact }: { compact?: boolean }) {
  const playing = usePlayback((s) => s.playing);
  const time = usePlayback((s) => s.time);
  const fps = useEditor((s) => s.project.settings.fps);
  const duration = useEditor((s) => projectDuration(s.project));
  const loop = useEditor((s) => s.loop);
  const set = useEditor((s) => s.set);
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div className="transport" role="toolbar" aria-label="Playback controls">
      <div className="tc-wrap">
        {editing !== null ? (
          <input
            className="input mono tc-input"
            autoFocus
            aria-label="Go to timecode"
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            onBlur={() => setEditing(null)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                const t = parseTime(editing, fps);
                if (t !== null) player.seek(Math.max(0, t));
                setEditing(null);
              } else if (e.key === 'Escape') setEditing(null);
            }}
          />
        ) : (
          <button className="tc mono" onClick={() => setEditing(formatTimecode(time, fps))} data-tip="Click to type a time" aria-label={`Current time ${formatTimecode(time, fps)}. Click to jump to a time.`}>
            {formatTimecode(time, fps)}
          </button>
        )}
        {!compact && <span className="tc-total mono">/ {formatTimecode(duration, fps)}</span>}
      </div>
      <div className="transport-buttons">
        <button className="icon-btn" aria-label="Go to start" data-tip="Go to start" data-kbd="Home" onClick={() => player.seek(0)}>
          <ChevronFirst size={18} />
        </button>
        <button className="icon-btn" aria-label="Previous frame" data-tip="Previous frame" data-kbd="←" onClick={() => player.step(-1)}>
          <SkipBack size={16} />
        </button>
        <button className="play-btn" aria-label={playing ? 'Pause' : 'Play'} data-tip={playing ? 'Pause' : 'Play'} data-kbd="Space" onClick={() => player.toggle()}>
          {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" style={{ marginLeft: 2 }} />}
        </button>
        <button className="icon-btn" aria-label="Next frame" data-tip="Next frame" data-kbd="→" onClick={() => player.step(1)}>
          <SkipForward size={16} />
        </button>
        <button className="icon-btn" aria-label="Go to end" data-tip="Go to end" data-kbd="End" onClick={() => player.seek(player.endTime())}>
          <ChevronLast size={18} />
        </button>
      </div>
      <div className="transport-right">
        <button className={`icon-btn small${loop ? ' active' : ''}`} aria-pressed={loop} aria-label="Loop playback" data-tip="Loop" onClick={() => set('loop', !loop)}>
          <Repeat size={15} />
        </button>
        {!compact && <Meter />}
      </div>
    </div>
  );
}

/** Stereo peak meter driven by the audio engine. */
function Meter() {
  const lRef = useRef<HTMLDivElement>(null);
  const rRef = useRef<HTMLDivElement>(null);
  const playing = usePlayback((s) => s.playing);
  useEffect(() => {
    let raf = 0;
    let l = 0;
    let r = 0;
    const tick = () => {
      const m = player.audio.meter();
      l = Math.max(m.l, l * 0.9);
      r = Math.max(m.r, r * 0.9);
      const toPct = (v: number) => `${Math.min(100, Math.max(0, ((20 * Math.log10(Math.max(v, 1e-5)) + 48) / 48) * 100))}%`;
      if (lRef.current) lRef.current.style.width = toPct(l);
      if (rRef.current) rRef.current.style.width = toPct(r);
      if (playing || l > 0.001 || r > 0.001) raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  return (
    <div className="meter-stereo" aria-hidden="true" data-tip="Output level">
      <div className="bar">
        <div ref={lRef} />
      </div>
      <div className="bar">
        <div ref={rRef} />
      </div>
    </div>
  );
}
