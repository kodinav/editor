import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, AudioLines, Film, Image as ImageIcon, Link2, Mic, MoreHorizontal, Plus, Search, Trash2, Type, Upload, Play } from 'lucide-react';
import type { Asset } from '@/core/types';
import { formatDuration } from '@/core/time';
import { media } from '@/media/registry';
import { codecLabel } from '@/media/probe';
import { addAssetsToTimeline, relinkAsset } from '@/state/importer';
import { editor, toast, useEditor } from '@/state/store';
import { openContextMenu, openMenuBelow, type MenuItem } from '../common/Menu';
import { openImportPicker, pickFile } from '../importPicker';
import { endDrag, startDrag } from '../dnd';
import { PanelHead } from './LeftDock';
import { VoiceoverRecorder } from './VoiceoverRecorder';

type Filter = 'all' | 'video' | 'audio' | 'image';

export function MediaPanel() {
  const assets = useEditor((s) => s.project.assets);
  const clips = useEditor((s) => s.project.clips);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [recording, setRecording] = useState(false);
  const list = useMemo(
    () =>
      Object.values(assets)
        .filter((a) => filter === 'all' || a.kind === filter)
        .filter((a) => !query || a.name.toLowerCase().includes(query.toLowerCase()))
        .sort((a, b) => a.createdAt - b.createdAt),
    [assets, filter, query],
  );
  const tracks = useEditor((s) => s.project.tracks);
  const usage = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of Object.values(clips)) if ('assetId' in c) m.set(c.assetId, (m.get(c.assetId) ?? 0) + 1);
    // Fonts are "used" by every title and caption track styled with them.
    const fontAsset = new Map(Object.values(assets).flatMap((a) => (a.kind === 'font' && a.font ? [[a.font.family, a.id] as const] : [])));
    const families = [...Object.values(clips).flatMap((c) => (c.type === 'text' ? [c.style.fontFamily] : [])), ...tracks.flatMap((t) => (t.captionStyle ? [t.captionStyle.fontFamily] : []))];
    for (const f of families) {
      const id = fontAsset.get(f);
      if (id) m.set(id, (m.get(id) ?? 0) + 1);
    }
    return m;
  }, [clips, assets, tracks]);
  const total = Object.keys(assets).length;

  return (
    <>
      <PanelHead title="Media">
        <button className="icon-btn small" aria-label="Record voiceover" data-tip="Record voiceover" onClick={() => setRecording(true)}>
          <Mic size={16} />
        </button>
        <button className="btn small primary" onClick={() => openImportPicker()} data-tip="Import files" data-kbd="⌘I">
          <Upload size={14} /> Import
        </button>
      </PanelHead>
      {recording && <VoiceoverRecorder onClose={() => setRecording(false)} />}
      <div className="panel-body">
        {total === 0 ? (
          <EmptyMedia />
        ) : (
          <>
            <div className="row" style={{ marginBottom: 8 }}>
              <div className="search">
                <Search size={14} />
                <input className="input" placeholder="Search media" aria-label="Search media" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
              </div>
            </div>
            <div className="segmented" style={{ marginBottom: 10 }} role="group" aria-label="Filter media">
              {(['all', 'video', 'audio', 'image'] as Filter[]).map((f) => (
                <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                  {f === 'all' ? 'All' : f === 'video' ? 'Video' : f === 'audio' ? 'Audio' : 'Images'}
                </button>
              ))}
            </div>
            <div className="asset-grid" role="list" aria-label="Media files">
              {list.map((a) => (
                <AssetCard key={a.id} asset={a} uses={usage.get(a.id) ?? 0} />
              ))}
            </div>
            {list.length === 0 && <p className="subtle" style={{ textAlign: 'center' }}>No matching media.</p>}
          </>
        )}
      </div>
    </>
  );
}

function EmptyMedia() {
  return (
    <div className="empty-media">
      <button className="drop-card" onClick={() => openImportPicker()}>
        <Upload size={26} />
        <strong>Import media</strong>
        <span>or drag files anywhere</span>
      </button>
      <ul className="hints">
        <li>
          <Film size={14} /> MP4, MOV, WebM, MKV video
        </li>
        <li>
          <AudioLines size={14} /> MP3, WAV, M4A, AAC, OGG, FLAC audio
        </li>
        <li>
          <ImageIcon size={14} /> JPG, PNG, WebP, GIF, AVIF, SVG images
        </li>
        <li>
          <Type size={14} /> Fonts and SRT/VTT captions too
        </li>
      </ul>
      <p className="subtle" style={{ fontSize: 12 }}>
        Files stay on this device. Nothing is uploaded.
      </p>
    </div>
  );
}

function AssetCard({ asset, uses }: { asset: Asset; uses: number }) {
  // Subscribe to this asset's progress only, so other imports don't re-render every card.
  const progress = useSyncExternalStore(media.subscribe, () => media.getProgress(asset.id));
  const selection = useEditor((s) => s.selection);
  const clips = useEditor((s) => s.project.clips);
  const highlighted = selection.some((id) => {
    const c = clips[id];
    return c && 'assetId' in c && c.assetId === asset.id;
  });
  const usable = asset.status === 'ready' && asset.kind !== 'font';

  const menu: MenuItem[] = [
    { label: 'Add to timeline at playhead', icon: <Plus size={14} />, disabled: !usable, onClick: () => addAssetsToTimeline([asset.id]) },
    ...(asset.kind === 'video' || asset.kind === 'audio'
      ? [{ label: 'Preview and choose a part…', icon: <Play size={14} />, disabled: !usable, onClick: () => editor().set('sourcePreview', asset.id) }]
      : []),
    { label: 'Relink file…', icon: <Link2 size={14} />, onClick: () => void relink(asset) },
    { kind: 'separator' },
    { label: uses ? `Remove (used ${uses}×)` : 'Remove from project', icon: <Trash2 size={14} />, danger: true, onClick: () => removeAsset(asset, uses) },
  ];

  return (
    <div
      role="listitem"
      className={`asset-card${highlighted ? ' highlighted' : ''}${asset.status === 'error' || asset.status === 'missing' ? ' bad' : ''}`}
      draggable={usable}
      tabIndex={0}
      aria-label={`${asset.name}, ${asset.kind}${asset.duration ? `, ${formatDuration(asset.duration)}` : ''}${asset.status !== 'ready' ? `, ${asset.status}` : ''}`}
      onDragStart={(e) => startDrag(e, { kind: 'assets', ids: [asset.id] })}
      onDragEnd={endDrag}
      onClick={() => usable && (asset.kind === 'video' || asset.kind === 'audio') && editor().set('sourcePreview', asset.id)}
      onDoubleClick={() => usable && addAssetsToTimeline([asset.id])}
      onKeyDown={(e) => {
        // Only Enter on the card itself: its buttons handle their own Enter.
        if (e.key === 'Enter' && usable && e.target === e.currentTarget) addAssetsToTimeline([asset.id]);
      }}
      onContextMenu={(e) => openContextMenu(e, menu)}
      data-tip={asset.status === 'error' ? asset.error : asset.status === 'missing' ? 'File is offline — relink it' : undefined}
    >
      <div className="asset-thumb">
        <AssetThumb asset={asset} />
        {asset.duration > 0 && <span className="asset-dur mono">{formatDuration(asset.duration)}</span>}
        {(asset.status === 'error' || asset.status === 'missing') && (
          <span className="asset-warn">
            <AlertTriangle size={16} />
            {asset.status === 'missing' ? 'Offline' : 'Error'}
          </span>
        )}
        {asset.status === 'processing' && (
          <span className="asset-warn">
            <span className="spinner" />
          </span>
        )}
        {usable && (
          <button
            className="asset-add"
            aria-label={`Add ${asset.name} to timeline`}
            data-tip="Add at playhead"
            onClick={(e) => {
              e.stopPropagation();
              addAssetsToTimeline([asset.id]);
            }}
          >
            <Plus size={14} />
          </button>
        )}
        {uses > 0 && <span className="asset-used" aria-hidden="true" data-tip={`Used ${uses}× in timeline`} />}
      </div>
      <div className="asset-meta">
        <span className="ellipsis grow" title={asset.name}>
          {asset.name}
        </span>
        <button
          className="icon-btn tiny"
          aria-label={`More options for ${asset.name}`}
          onClick={(e) => {
            e.stopPropagation();
            openMenuBelow(e.currentTarget, menu, 'right');
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
      {progress && progress.stage !== 'probe' && (
        <div className="asset-progress" aria-label={`Preparing ${progress.stage} ${Math.round(progress.value * 100)}%`}>
          <div className="progress">
            <div style={{ width: `${Math.round(progress.value * 100)}%` }} />
          </div>
        </div>
      )}
      {asset.status === 'ready' && asset.video && (
        <div className="asset-sub subtle">
          {asset.video.width}×{asset.video.height} · {Math.round(asset.video.fps * 100) / 100} fps · {codecLabel(asset.video.codec)}
        </div>
      )}
    </div>
  );
}

async function relink(asset: Asset) {
  const accept = asset.kind === 'image' ? 'image/*' : asset.kind === 'audio' ? 'audio/*,video/*' : asset.kind === 'font' ? '.ttf,.otf,.woff,.woff2' : 'video/*';
  const f = await pickFile(accept);
  if (f) await relinkAsset(asset.id, f);
}

function removeAsset(asset: Asset, uses: number) {
  const question =
    asset.kind === 'font'
      ? `“${asset.name}” is used by ${uses} title or caption style(s). Remove it? They will switch to a default font.`
      : `“${asset.name}” is used ${uses} time(s) in the timeline. Remove it and its clips?`;
  if (uses > 0 && !window.confirm(question)) return;
  // One undoable step: Undo brings back the media and its clips together.
  editor().commit('Remove media', (d) => {
    for (const c of Object.values(d.clips)) if ('assetId' in c && c.assetId === asset.id) delete d.clips[c.id];
    delete d.assets[asset.id];
  });
  toast({ kind: 'info', message: `Removed “${asset.name}”.`, detail: 'Undo (Ctrl/⌘+Z) brings it back.' });
}

/** Small poster for an asset: video thumbnail, image, or audio waveform. */
export function AssetThumb({ asset }: { asset: Asset }) {
  const ref = useRef<HTMLCanvasElement>(null);
  // Targeted subscriptions: repaint only when this asset's own data changes.
  const thumbs = useSyncExternalStore(media.subscribe, () => (asset.kind === 'video' || asset.kind === 'image' ? media.getThumbs(asset.id) : null));
  const peaks = useSyncExternalStore(media.subscribe, () => (asset.kind === 'audio' ? media.getPeaks(asset.id) : null));
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    const W = (c.width = c.clientWidth * devicePixelRatio || 160);
    const H = (c.height = c.clientHeight * devicePixelRatio || 90);
    ctx.fillStyle = '#121316';
    ctx.fillRect(0, 0, W, H);
    if (asset.kind === 'video') {
      const t = thumbs;
      if (t) {
        const i = Math.min(t.meta.count - 1, Math.floor(t.meta.count * 0.15));
        const sx = (i % t.meta.cols) * t.meta.thumbWidth;
        const sy = Math.floor(i / t.meta.cols) * t.meta.thumbHeight;
        const s = Math.max(W / t.meta.thumbWidth, H / t.meta.thumbHeight);
        const dw = t.meta.thumbWidth * s;
        const dh = t.meta.thumbHeight * s;
        ctx.drawImage(t.bitmap, sx, sy, t.meta.thumbWidth, t.meta.thumbHeight, (W - dw) / 2, (H - dh) / 2, dw, dh);
      } else drawIcon(ctx, W, H, '#36598f');
    } else if (asset.kind === 'image') {
      const t = thumbs;
      if (t) {
        // Checkerboard shows transparency.
        const sz = 8;
        for (let y = 0; y < H; y += sz) for (let x = 0; x < W; x += sz) {
          ctx.fillStyle = ((x + y) / sz) % 2 ? '#2a2c31' : '#1f2126';
          ctx.fillRect(x, y, sz, sz);
        }
        const bmp = t.bitmap;
        const s = Math.max(W / bmp.width, H / bmp.height);
        ctx.drawImage(bmp, (W - bmp.width * s) / 2, (H - bmp.height * s) / 2, bmp.width * s, bmp.height * s);
      } else drawIcon(ctx, W, H, '#5f4a99');
    } else if (asset.kind === 'audio') {
      const pk = peaks;
      ctx.fillStyle = '#1b3a2d';
      ctx.fillRect(0, 0, W, H);
      if (pk) {
        ctx.fillStyle = '#4fd39a';
        const n = pk.data.length;
        for (let x = 0; x < W; x++) {
          const a = Math.floor((x / W) * n);
          const b = Math.max(a + 1, Math.floor(((x + 1) / W) * n));
          let m = 0;
          for (let i = a; i < b; i++) m = Math.max(m, pk.data[i]);
          const h = (m / 255) * H * 0.8;
          ctx.fillRect(x, (H - h) / 2, 1, Math.max(1, h));
        }
      }
    } else {
      ctx.fillStyle = '#2b2f36';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#d6d9df';
      ctx.font = `${Math.round(H * 0.45)}px "${asset.font?.family ?? 'Inter'}", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Aa', W / 2, H / 2);
    }
  }, [asset, thumbs, peaks]);
  return <canvas ref={ref} className="asset-canvas" aria-hidden="true" />;
}

function drawIcon(ctx: CanvasRenderingContext2D, W: number, H: number, color: string) {
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.35;
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 1;
}
