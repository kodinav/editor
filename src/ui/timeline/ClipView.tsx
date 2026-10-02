import { memo, useEffect, useRef, useSyncExternalStore } from 'react';
import { AlertTriangle, Captions, Gauge, Layers, Shapes, Snowflake, Sparkles, Type, VolumeX } from 'lucide-react';
import { allKeyframeTimes } from '@/core/keyframes';
import type { Asset, Clip } from '@/core/types';
import { media } from '@/media/registry';
import { formatShort } from '@/core/time';

/**
 * One clip on the timeline. Only the horizontally visible slice of the clip
 * is painted (filmstrip / waveform) so very long clips at high zoom stay
 * cheap. Interaction is handled by the timeline via data attributes.
 */

export interface ClipViewProps {
  clip: Clip;
  asset?: Asset;
  pxPerSec: number;
  top: number;
  height: number;
  selected: boolean;
  /** Visible content-space x range (px) for partial painting. */
  viewX0: number;
  viewX1: number;
  trackMuted: boolean;
  trackHidden: boolean;
}

const LABEL_H = 18;

function ClipViewInner({ clip, asset, pxPerSec, top, height, selected, viewX0, viewX1, trackMuted, trackHidden }: ClipViewProps) {
  const left = clip.start * pxPerSec;
  const width = Math.max(2, clip.duration * pxPerSec);
  const hasAudio = (clip.type === 'video' || clip.type === 'audio') && !!asset?.audio;
  const muted = (clip.type === 'video' || clip.type === 'audio') && clip.muted;
  const offline = asset && (asset.status === 'missing' || asset.status === 'error');
  const kfTimes = selected ? allKeyframeTimes(clip) : [];
  const narrow = width < 36;
  const speed = clip.type === 'video' || clip.type === 'audio' ? clip.speed : 1;
  const effects = 'effects' in clip ? clip.effects.filter((e) => e.enabled).length : 0;

  const label = (() => {
    switch (clip.type) {
      case 'text':
      case 'caption':
        return clip.text.replace(/\n/g, ' ') || ' ';
      default:
        return clip.name;
    }
  })();

  return (
    <div
      className={`clip type-${clip.type}${selected ? ' selected' : ''}${clip.disabled ? ' disabled' : ''}${offline ? ' offline' : ''}${trackHidden ? ' hidden-track' : ''}`}
      style={{ left, width, top: top + 2, height: height - 4 }}
      data-clip={clip.id}
      role="button"
      tabIndex={-1}
      aria-pressed={selected}
      aria-label={`${clip.type} clip ${clip.name}, starts ${formatShort(clip.start)}, length ${formatShort(clip.duration)}`}
    >
      {(clip.type === 'video' || clip.type === 'image' || clip.type === 'audio') && asset && (
        <ClipCanvas clip={clip} asset={asset} pxPerSec={pxPerSec} width={width} height={height - 4} viewX0={viewX0 - left} viewX1={viewX1 - left} hasAudio={hasAudio && !muted && !trackMuted} />
      )}
      {clip.type === 'shape' && <div className="clip-swatch" style={{ background: clip.fill2 ? `linear-gradient(90deg, ${clip.fill}, ${clip.fill2})` : clip.fill }} />}
      {!narrow && (
        <div className="clip-label" style={{ height: LABEL_H }}>
          {clip.type === 'text' && <Type size={11} />}
          {clip.type === 'caption' && <Captions size={11} />}
          {clip.type === 'shape' && <Shapes size={11} />}
          {clip.type === 'adjustment' && <Layers size={11} />}
          {offline && <AlertTriangle size={11} color="var(--warning)" />}
          <span className="ellipsis">{label}</span>
          {speed !== 1 && (
            <span className="clip-badge" title={`${speed}× speed`}>
              <Gauge size={10} />
              {speed}×
            </span>
          )}
          {clip.type === 'video' && clip.freeze && (
            <span className="clip-badge">
              <Snowflake size={10} />
            </span>
          )}
          {effects > 0 && (
            <span className="clip-badge" title={`${effects} effect(s)`}>
              <Sparkles size={10} />
              {effects}
            </span>
          )}
          {muted && (
            <span className="clip-badge">
              <VolumeX size={10} />
            </span>
          )}
        </div>
      )}
      {(clip.type === 'video' || clip.type === 'audio') && hasAudio && (
        <>
          <FadeShape side="in" px={clip.fadeIn * pxPerSec} height={height - 4} />
          <FadeShape side="out" px={clip.fadeOut * pxPerSec} height={height - 4} />
          {selected && width > 50 && (
            <>
              <div className="fade-handle in" data-handle="fade-in" style={{ left: Math.max(2, clip.fadeIn * pxPerSec - 5) }} title="Drag to fade in" />
              <div className="fade-handle out" data-handle="fade-out" style={{ right: Math.max(2, clip.fadeOut * pxPerSec - 5) }} title="Drag to fade out" />
            </>
          )}
        </>
      )}
      {kfTimes.map((t) => (
        <div key={t} className="kf-diamond" data-kf={t} style={{ left: t * pxPerSec }} title="Keyframe — drag to retime, click to jump, right-click to delete" />
      ))}
      <div className="trim-handle start" data-handle="trim-start" aria-hidden="true" />
      <div className="trim-handle end" data-handle="trim-end" aria-hidden="true" />
    </div>
  );
}

export const ClipView = memo(ClipViewInner);

function FadeShape({ side, px, height }: { side: 'in' | 'out'; px: number; height: number }) {
  if (px < 1) return null;
  return (
    <svg className={`fade-shape ${side}`} width={px} height={height} viewBox={`0 0 ${px} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={side === 'in' ? `M0 0 L${px} 0 L0 ${height} Z` : `M0 0 L${px} 0 L${px} ${height} Z`} />
    </svg>
  );
}

/** Paints filmstrip and/or waveform for the visible slice of a clip. */
function ClipCanvas({
  clip,
  asset,
  pxPerSec,
  width,
  height,
  viewX0,
  viewX1,
  hasAudio,
}: {
  clip: Clip;
  asset: Asset;
  pxPerSec: number;
  width: number;
  height: number;
  viewX0: number;
  viewX1: number;
  hasAudio: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const thumbs = useSyncExternalStore(media.subscribe, () => (asset.kind === 'video' || asset.kind === 'image' ? media.getThumbs(asset.id) : null));
  const peaks = useSyncExternalStore(media.subscribe, () => (asset.audio ? media.getPeaks(asset.id) : null));

  // Visible slice, padded to reduce repaints while scrolling.
  const pad = 300;
  const x0 = Math.max(0, Math.floor(viewX0 - pad));
  const x1 = Math.min(width, Math.ceil(viewX1 + pad));
  const w = Math.max(0, x1 - x0);

  useEffect(() => {
    const c = ref.current;
    if (!c || w <= 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.max(1, Math.round(w * dpr));
    c.height = Math.max(1, Math.round(height * dpr));
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, height);
    const speed = clip.type === 'video' || clip.type === 'audio' ? clip.speed : 1;
    const sourceIn = clip.type === 'video' || clip.type === 'audio' ? clip.sourceIn : 0;
    const freeze = clip.type === 'video' && !!clip.freeze;
    const filmH = clip.type === 'audio' ? 0 : hasAudio && clip.type === 'video' ? Math.max(0, height - LABEL_H - Math.min(22, height * 0.32)) : height - LABEL_H;
    const filmTop = LABEL_H;

    if (filmH > 6 && thumbs && asset.kind === 'image') {
      const b = thumbs.bitmap;
      const tileW = (b.width / b.height) * filmH;
      for (let x = Math.floor(x0 / tileW) * tileW; x < x1; x += tileW) ctx.drawImage(b, x - x0, filmTop, tileW, filmH);
    } else if (filmH > 6 && thumbs) {
      const m = thumbs.meta;
      const tileW = (m.thumbWidth / m.thumbHeight) * filmH;
      const firstTile = Math.floor(x0 / tileW);
      for (let i = firstTile; i * tileW < x1; i++) {
        const xLocal = i * tileW;
        const tAtTile = freeze ? sourceIn : sourceIn + ((xLocal + tileW / 2) / pxPerSec) * speed;
        const idx = Math.max(0, Math.min(m.count - 1, Math.round((tAtTile - m.start) / m.interval)));
        const sx = (idx % m.cols) * m.thumbWidth;
        const sy = Math.floor(idx / m.cols) * m.thumbHeight;
        ctx.drawImage(thumbs.bitmap, sx, sy, m.thumbWidth, m.thumbHeight, xLocal - x0, filmTop, tileW + 0.5, filmH);
      }
    }

    if (hasAudio && peaks) {
      const waveTop = clip.type === 'audio' ? LABEL_H : filmTop + filmH;
      const waveH = height - waveTop;
      if (waveH > 4) {
        const mid = waveTop + waveH / 2;
        ctx.fillStyle = clip.type === 'audio' ? 'rgba(130, 236, 186, 0.85)' : 'rgba(170, 200, 255, 0.75)';
        const rate = peaks.rate;
        const data = peaks.data;
        for (let x = 0; x < w; x++) {
          const lx = x0 + x;
          const sA = sourceIn + (lx / pxPerSec) * speed;
          const sB = sourceIn + ((lx + 1) / pxPerSec) * speed;
          let a = Math.floor(sA * rate);
          const b = Math.max(a + 1, Math.ceil(sB * rate));
          let mx = 0;
          for (; a < b && a < data.length; a++) if (a >= 0 && data[a] > mx) mx = data[a];
          const h = (mx / 255) * (waveH - 2);
          if (h > 0.3) ctx.fillRect(x, mid - h / 2, 1, h);
        }
      }
    }
  }, [thumbs, peaks, clip, pxPerSec, x0, x1, w, height, hasAudio, asset.kind]);

  if (w <= 0) return null;
  return <canvas ref={ref} className="clip-canvas" style={{ left: x0, width: w, height }} aria-hidden="true" />;
}
