import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AudioLines,
  Captions,
  Eye,
  EyeOff,
  Film,
  Diamond,
  Headphones,
  Lock,
  Magnet,
  MousePointer2,
  Plus,
  Scissors,
  SplitSquareHorizontal,
  Trash2,
  Unlock,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
  Maximize2,
  WrapText,
  Copy,
  Unlink,
  Snowflake,
  ClipboardPaste,
  ArrowUp,
  ArrowDown,
  Pencil,
} from 'lucide-react';
import { addTrack, nextAdjacent, removeTrack, reorderTrack, setSpeed } from '@/core/ops';
import { clipEnd, projectDuration, scaledCaptionStyle } from '@/core/project';
import { createEffect } from '@/core/effects';
import type { Clip, Track } from '@/core/types';
import { isVisualClip } from '@/core/types';
import * as A from '@/state/actions';
import { importFiles, addAssetsToTimeline } from '@/state/importer';
import { editor, toast, useEditor, usePlayback } from '@/state/store';
import { openContextMenu, openMenuBelow, type MenuItem } from '../common/Menu';
import { isInternalDrag, readDrag } from '../dnd';
import { MOD, SHIFT } from '../shortcuts';
import { ClipView } from './ClipView';
import {
  beginClipDrag,
  beginFade,
  beginKeyframeDrag,
  beginMarkerDrag,
  beginMarquee,
  beginScrub,
  beginTransitionResize,
  beginTrim,
  timeAtClientX,
  yInTracks,
  type TimelineCtx,
} from './drag';
import { BOTTOM_PAD, HEADER_W, HEADER_W_COMPACT, layoutTracks, RULER_H, rowAtY, tickInterval, formatRuler, type TrackRowLayout } from './layout';
import { MAX_PX_PER_SEC, MIN_PX_PER_SEC, timelineViewport, zoomTimeline, zoomToFit } from './zoom';
import { player } from '@/playback/player';

export function Timeline({ compact }: { compact?: boolean }) {
  const project = useEditor((s) => s.project);
  const pxPerSec = useEditor((s) => s.pxPerSec);
  const selection = useEditor((s) => s.selection);
  const selectedTransition = useEditor((s) => s.selectedTransition);
  const tool = useEditor((s) => s.tool);
  const scrollX = useEditor((s) => s.scrollX);
  const headerW = compact ? HEADER_W_COMPACT : HEADER_W;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(800);
  const [viewH, setViewH] = useState(300);
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [dropHint, setDropHint] = useState<{ t: number; rowTop: number; rowH: number } | null>(null);

  const { rows, total } = useMemo(() => layoutTracks(project), [project]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const duration = useMemo(() => projectDuration(project), [project]);
  const contentW = Math.max((duration + 30) * pxPerSec, viewW + scrollX + 200);
  const selSet = useMemo(() => new Set(selection), [selection]);

  const ctx: TimelineCtx = useMemo(
    () => ({
      scroller: () => scrollerRef.current!,
      headerW: () => headerW,
      rows: () => rowsRef.current,
      setSnapLine,
      setMarquee,
    }),
    [headerW],
  );

  // Track viewport size.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setViewW(el.clientWidth - headerW);
      setViewH(el.clientHeight);
      timelineViewport.width = el.clientWidth - headerW;
      timelineViewport.headerWidth = headerW;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [headerW]);

  // When the first media lands on an empty timeline (or a project opens), frame it all.
  const clipCount = Object.keys(project.clips).length;
  const prevCount = useRef(-1);
  const projectId = project.id;
  const prevProject = useRef(projectId);
  useEffect(() => {
    const opened = prevProject.current !== projectId;
    if ((prevCount.current === 0 && clipCount > 0) || (opened && clipCount > 0) || (prevCount.current === -1 && clipCount > 0)) {
      requestAnimationFrame(() => zoomToFit());
    }
    prevCount.current = clipCount;
    prevProject.current = projectId;
  }, [clipCount, projectId]);

  // Store scrollX -> DOM (zoom anchoring writes the store).
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el && Math.abs(el.scrollLeft - scrollX) > 1) el.scrollLeft = scrollX;
  }, [scrollX, pxPerSec]);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (el) editor().set('scrollX', el.scrollLeft);
  }, []);

  // Ctrl/⌘ + wheel (and trackpad pinch) zooms around the pointer.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const t = timeAtClientX(ctx, e.clientX);
        const factor = Math.exp(-e.deltaY * 0.0025);
        const s = editor();
        const next = Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, s.pxPerSec * factor));
        const screenX = e.clientX - el.getBoundingClientRect().left - headerW;
        s.set('pxPerSec', next);
        s.set('scrollX', Math.max(0, t * next - screenX));
      } else if (e.altKey) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [ctx, headerW]);

  // Keep the playhead visible: page-turn scrolling during playback, and jumps (keyboard
  // stepping, edit points, typed timecode) bring it into view too.
  useEffect(
    () =>
      usePlayback.subscribe((s, prev) => {
        if (s.time === prev.time) return;
        const el = scrollerRef.current;
        if (!el) return;
        const x = s.time * editor().pxPerSec;
        const vw = el.clientWidth - headerW;
        if (x <= el.scrollLeft + vw - 40 && x >= el.scrollLeft) return;
        el.scrollLeft = Math.max(0, s.playing ? x - 40 : x - vw / 3);
      }),
    [headerW],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('.track-header, .tl-corner, button, input, select')) return;
    const handle = target.closest<HTMLElement>('[data-handle]');
    const clipEl = target.closest<HTMLElement>('[data-clip]');
    const kfEl = target.closest<HTMLElement>('[data-kf]');
    const trEl = target.closest<HTMLElement>('[data-transition]');
    const markerEl = target.closest<HTMLElement>('[data-marker]');
    if (markerEl) return beginMarkerDrag(e, ctx, markerEl.dataset.marker!);
    if (target.closest('[data-ruler]')) return beginScrub(e, ctx);
    if (trEl) {
      if (handle?.dataset.handle === 'transition-edge') return beginTransitionResize(e, ctx, trEl.dataset.transition!);
      editor().select([]);
      editor().set('selectedTransition', trEl.dataset.transition!);
      return;
    }
    if (clipEl) {
      const id = clipEl.dataset.clip!;
      if (kfEl) return beginKeyframeDrag(e, ctx, id, Number(kfEl.dataset.kf));
      const h = handle?.dataset.handle;
      if (h === 'trim-start' && editor().tool === 'select') return beginTrim(e, ctx, id, 'start');
      if (h === 'trim-end' && editor().tool === 'select') return beginTrim(e, ctx, id, 'end');
      if (h === 'fade-in') return beginFade(e, ctx, id, 'fadeIn');
      if (h === 'fade-out') return beginFade(e, ctx, id, 'fadeOut');
      return beginClipDrag(e, ctx, id);
    }
    if (e.pointerType === 'touch') return;
    beginMarquee(e, ctx);
  };

  const onContextMenu = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const clipEl = target.closest<HTMLElement>('[data-clip]');
    const t = timeAtClientX(ctx, e.clientX);
    const row = rowAtY(rows, yInTracks(ctx, e.clientY));
    const kfEl = target.closest<HTMLElement>('[data-kf]');
    if (kfEl && clipEl) {
      const id = clipEl.dataset.clip!;
      const kt = Number(kfEl.dataset.kf);
      openContextMenu(e, [
        { label: 'Go to keyframe', icon: <Diamond size={14} />, onClick: () => player.seek(editor().project.clips[id].start + kt) },
        {
          label: 'Delete keyframes here',
          icon: <Trash2 size={14} />,
          danger: true,
          onClick: () =>
            editor().commit('Delete keyframes', (d) => {
              const c = d.clips[id];
              if (!c) return;
              for (const [path, list] of Object.entries(c.keyframes)) {
                const keep = list.filter((k) => Math.abs(k.t - kt) >= 0.01);
                if (keep.length) c.keyframes[path] = keep;
                else delete c.keyframes[path];
              }
            }),
        },
      ]);
      return;
    }
    if (clipEl) {
      const id = clipEl.dataset.clip!;
      if (!editor().selection.includes(id)) editor().select([id]);
      openContextMenu(e, clipMenu(id));
      return;
    }
    const trEl = target.closest<HTMLElement>('[data-transition]');
    if (trEl) {
      openContextMenu(e, [{ label: 'Remove transition', icon: <Trash2 size={14} />, danger: true, onClick: () => A.removeTransition(trEl.dataset.transition!) }]);
      return;
    }
    const markerEl = target.closest<HTMLElement>('[data-marker]');
    if (markerEl) {
      const id = markerEl.dataset.marker!;
      openContextMenu(e, [
        {
          label: 'Rename marker…',
          icon: <Pencil size={14} />,
          onClick: () => {
            const m = editor().project.markers.find((x) => x.id === id);
            const name = window.prompt('Marker name', m?.label ?? '');
            if (name !== null)
              editor().commit('Rename marker', (d) => {
                const mm = d.markers.find((x) => x.id === id);
                if (mm) mm.label = name.slice(0, 80);
              });
          },
        },
        { label: 'Delete marker', icon: <Trash2 size={14} />, danger: true, onClick: () => editor().commit('Delete marker', (d) => void (d.markers = d.markers.filter((x) => x.id !== id))) },
      ]);
      return;
    }
    if (target.closest('.track-header')) return;
    openContextMenu(e, [
      { label: 'Paste here', icon: <ClipboardPaste size={14} />, kbd: `${MOD}V`, disabled: !A.hasClipboard(), onClick: () => {
        player.seek(Math.max(0, t));
        A.paste();
      } },
      { label: 'Close gap', icon: <WrapText size={14} />, disabled: !row, onClick: () => row && A.closeGap(row.track.id, t) },
      { kind: 'separator' },
      { label: 'Add marker here', onClick: () => {
        player.seek(Math.max(0, t));
        A.addMarker();
      } },
      { label: 'Add video track', icon: <Film size={14} />, onClick: () => editor().commit('Add track', (d) => void addTrack(d, 'video')) },
      { label: 'Add audio track', icon: <AudioLines size={14} />, onClick: () => editor().commit('Add track', (d) => void addTrack(d, 'audio')) },
    ]);
  };

  /* -------- drops from the library or the OS -------- */
  const dropTarget = (e: React.DragEvent) => {
    const t = Math.max(0, timeAtClientX(ctx, e.clientX));
    const row = rowAtY(rows, yInTracks(ctx, e.clientY));
    return { t, row };
  };
  const onDragOver = (e: React.DragEvent) => {
    const files = [...e.dataTransfer.types].includes('Files');
    if (!files && !isInternalDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const { t, row } = dropTarget(e);
    setDropHint({ t, rowTop: row?.top ?? total, rowH: row?.height ?? 40 });
  };
  const onDrop = (e: React.DragEvent) => {
    setDropHint(null);
    const { t, row } = dropTarget(e);
    const files = [...(e.dataTransfer.files ?? [])];
    if (files.length) {
      e.preventDefault();
      void importFiles(files, { place: { time: t, trackId: row?.track.id } });
      return;
    }
    const p = readDrag(e);
    if (!p) return;
    e.preventDefault();
    const clipUnder = row ? Object.values(editor().project.clips).find((c) => c.trackId === row.track.id && c.start <= t && clipEnd(c) > t) : undefined;
    switch (p.kind) {
      case 'assets':
        addAssetsToTimeline(p.ids, t, row?.track.id);
        break;
      case 'text':
        A.addTextPreset(p.preset, t);
        break;
      case 'shape':
        player.seek(t);
        A.addShape(p.shape, { fullFrame: p.fullFrame, fill: p.fill, fill2: p.fill2 });
        break;
      case 'adjustment':
        player.seek(t);
        A.addAdjustmentLayer();
        break;
      case 'transition': {
        // Attach to the cut nearest the drop point on that track.
        if (!row) return;
        const p2 = editor().project;
        const candidates = Object.values(p2.clips).filter((c) => c.trackId === row.track.id && isVisualClip(c) && nextAdjacent(p2, c));
        let best: Clip | null = null;
        for (const c of candidates) if (!best || Math.abs(clipEnd(c) - t) < Math.abs(clipEnd(best) - t)) best = c;
        if (best && Math.abs(clipEnd(best) - t) * editor().pxPerSec < 120) A.addTransition(best.id, p.type);
        else toast({ kind: 'info', message: 'Drop transitions onto a cut between two touching clips.' });
        break;
      }
      case 'effect':
        if (clipUnder && 'effects' in clipUnder) {
          editor().commit('Add effect', (d) => {
            const c = d.clips[clipUnder.id];
            if (c && 'effects' in c) c.effects.push(createEffect(p.type));
          });
          editor().select([clipUnder.id]);
        } else toast({ kind: 'info', message: 'Drop effects onto a video, image, text or shape clip.' });
        break;
      case 'filter':
        if (clipUnder) {
          A.applyFilterPreset(p.id, [clipUnder.id]);
          editor().select([clipUnder.id]);
        }
        break;
    }
  };

  const x0 = scrollX - 200;
  const x1 = scrollX + viewW + 200;
  const tMin = x0 / pxPerSec;
  const tMax = x1 / pxPerSec;
  const visibleClips = useMemo(
    () => Object.values(project.clips).filter((c) => clipEnd(c) >= tMin && c.start <= tMax),
    [project.clips, tMin, tMax],
  );
  const clipsByTrack = useMemo(() => {
    const m = new Map<string, Clip[]>();
    for (const c of visibleClips) {
      const arr = m.get(c.trackId) ?? [];
      arr.push(c);
      m.set(c.trackId, arr);
    }
    return m;
  }, [visibleClips]);

  const innerH = RULER_H + total + BOTTOM_PAD;

  return (
    <div className={`timeline${compact ? ' compact' : ''}`} data-tool={tool}>
      <Toolbar compact={compact} />
      <div
        className="tl-scroll"
        ref={scrollerRef}
        onScroll={onScroll}
        onPointerDown={onPointerDown}
        onContextMenu={onContextMenu}
        onDragOver={onDragOver}
        onDragLeave={() => setDropHint(null)}
        onDrop={onDrop}
        data-drop-zone="timeline"
        role="application"
        aria-label="Timeline. D selects the clip at the playhead, [ and ] the previous and next clip, Alt+Up and Alt+Down change track."
        tabIndex={0}
      >
        <div className="tl-inner" style={{ width: headerW + contentW, height: Math.max(innerH, viewH) }}>
          <Ruler headerW={headerW} pxPerSec={pxPerSec} x0={Math.max(0, scrollX - 100)} x1={scrollX + viewW + 100} />
          <div className="tl-tracks" style={{ top: RULER_H, height: Math.max(total + BOTTOM_PAD, viewH - RULER_H) }}>
            {rows.map((r) => (
              <TrackRow
                key={r.track.id}
                row={r}
                headerW={headerW}
                compact={compact}
                clips={clipsByTrack.get(r.track.id) ?? []}
                pxPerSec={pxPerSec}
                selSet={selSet}
                assets={project.assets}
                viewX0={x0}
                viewX1={x1}
                selectedTransition={selectedTransition}
                allClips={project.clips}
              />
            ))}
            <InOutShade headerW={headerW} pxPerSec={pxPerSec} height={total + BOTTOM_PAD} />
            {snapLine !== null && <div className="snap-line" style={{ left: headerW + snapLine * pxPerSec }} />}
            {marquee && (
              <div className="marquee" style={{ left: headerW + marquee.x0, top: marquee.y0, width: marquee.x1 - marquee.x0, height: marquee.y1 - marquee.y0 }} />
            )}
            {dropHint && <div className="drop-hint" style={{ left: headerW + dropHint.t * pxPerSec, top: dropHint.rowTop, height: dropHint.rowH }} />}
            {rows.length > 0 && Object.keys(project.clips).length === 0 && (
              <div className="tl-empty" style={{ left: headerW + 16, top: 12 }}>
                Drag media here, or use <strong>Import</strong>. Tip: press <kbd>?</kbd> for shortcuts.
              </div>
            )}
          </div>
          <Playhead headerW={headerW} height={Math.max(innerH, viewH)} />
        </div>
      </div>
    </div>
  );
}

/* --------------------------------- Toolbar -------------------------------- */

function Toolbar({ compact }: { compact?: boolean }) {
  const tool = useEditor((s) => s.tool);
  const snapping = useEditor((s) => s.snapping);
  const ripple = useEditor((s) => s.ripple);
  const pxPerSec = useEditor((s) => s.pxPerSec);
  const hasSel = useEditor((s) => s.selection.length > 0);
  const set = useEditor((s) => s.set);
  const zoomVal = Math.log(pxPerSec / MIN_PX_PER_SEC) / Math.log(MAX_PX_PER_SEC / MIN_PX_PER_SEC);
  return (
    <div className="tl-toolbar" role="toolbar" aria-label="Timeline tools">
      <div className="segmented" role="group" aria-label="Tool">
        <button aria-pressed={tool === 'select'} onClick={() => set('tool', 'select')} aria-label="Selection tool" data-tip="Select" data-kbd="V">
          <MousePointer2 size={14} />
        </button>
        <button aria-pressed={tool === 'razor'} onClick={() => set('tool', 'razor')} aria-label="Blade tool" data-tip="Blade — click a clip to cut" data-kbd="C">
          <Scissors size={14} />
        </button>
      </div>
      <button className="icon-btn small" aria-label="Split at playhead" data-tip="Split at playhead" data-kbd="S" onClick={() => A.splitAtPlayhead()}>
        <SplitSquareHorizontal size={15} />
      </button>
      <button className="icon-btn small" aria-label="Delete selection" data-tip="Delete" data-kbd="Del" disabled={!hasSel} onClick={() => A.deleteSelection()}>
        <Trash2 size={15} />
      </button>
      {!compact && (
        <>
          <button className="icon-btn small" aria-label="Duplicate selection" data-tip="Duplicate" data-kbd={`${MOD}D`} disabled={!hasSel} onClick={() => A.duplicateSelection()}>
            <Copy size={15} />
          </button>
          <button className="icon-btn small" aria-label="Freeze frame" data-tip="Freeze frame" data-kbd={`${SHIFT}F`} onClick={() => A.freezeFrame()}>
            <Snowflake size={15} />
          </button>
        </>
      )}
      <div className="tl-divider" />
      <button className={`icon-btn small${snapping ? ' active' : ''}`} aria-pressed={snapping} aria-label="Snapping" data-tip="Snapping (hold Shift to invert)" data-kbd="N" onClick={() => set('snapping', !snapping)}>
        <Magnet size={15} />
      </button>
      <button className={`icon-btn small${ripple ? ' active' : ''}`} aria-pressed={ripple} aria-label="Ripple editing" data-tip="Ripple: deletes and trims close gaps, moves insert" data-kbd="R" onClick={() => set('ripple', !ripple)}>
        <WrapText size={15} />
      </button>
      <div className="grow" />
      <button
        className="icon-btn small"
        aria-label="Add track"
        data-tip="Add track"
        onClick={(e) =>
          openMenuBelow(
            e.currentTarget,
            [
              { label: 'Video track', icon: <Film size={14} />, onClick: () => editor().commit('Add track', (d) => void addTrack(d, 'video')) },
              { label: 'Audio track', icon: <AudioLines size={14} />, onClick: () => editor().commit('Add track', (d) => void addTrack(d, 'audio')) },
              {
                label: 'Caption track',
                icon: <Captions size={14} />,
                onClick: () =>
                  editor().commit('Add track', (d) => {
                    const t = addTrack(d, 'caption');
                    t.captionStyle = scaledCaptionStyle(d.settings.height);
                  }),
              },
            ],
            'right',
          )
        }
      >
        <Plus size={15} />
      </button>
      <div className="tl-divider" />
      <button className="icon-btn small" aria-label="Zoom out" data-tip="Zoom out" data-kbd="−" onClick={() => zoomTimeline(0.75)}>
        <ZoomOut size={15} />
      </button>
      {!compact && (
        <input
          type="range"
          className="slider zoom-slider"
          aria-label="Timeline zoom"
          min={0}
          max={1}
          step={0.001}
          value={zoomVal}
          style={{ ['--fill' as string]: `${zoomVal * 100}%` }}
          onChange={(e) => {
            const v = Number(e.target.value);
            const next = MIN_PX_PER_SEC * Math.pow(MAX_PX_PER_SEC / MIN_PX_PER_SEC, v);
            zoomTimeline(next / editor().pxPerSec);
          }}
          onKeyDown={(e) => e.stopPropagation()}
        />
      )}
      <button className="icon-btn small" aria-label="Zoom in" data-tip="Zoom in" data-kbd="=" onClick={() => zoomTimeline(1.33)}>
        <ZoomIn size={15} />
      </button>
      <button className="icon-btn small" aria-label="Zoom to fit" data-tip="Fit timeline" data-kbd="\" onClick={() => zoomToFit()}>
        <Maximize2 size={14} />
      </button>
    </div>
  );
}

/* ---------------------------------- Ruler --------------------------------- */

function Ruler({ headerW, pxPerSec, x0, x1 }: { headerW: number; pxPerSec: number; x0: number; x1: number }) {
  const fps = useEditor((s) => s.project.settings.fps);
  const markers = useEditor((s) => s.project.markers);
  const { major, minor } = tickInterval(pxPerSec, fps);
  const ticks: { x: number; major: boolean; t: number }[] = [];
  const tStart = Math.floor(x0 / pxPerSec / minor) * minor;
  for (let t = Math.max(0, tStart); t * pxPerSec <= x1; t += minor) {
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    ticks.push({ x: t * pxPerSec, major: isMajor, t });
    if (ticks.length > 2000) break;
  }
  return (
    <div className="tl-ruler" data-ruler style={{ height: RULER_H }}>
      <div className="tl-corner" style={{ width: headerW }} />
      <div className="tl-ruler-ticks" style={{ left: headerW }}>
        {ticks.map((tk) => (
          <div key={tk.t.toFixed(4)} className={`tick${tk.major ? ' major' : ''}`} style={{ left: tk.x }}>
            {tk.major && <span>{formatRuler(tk.t, major)}</span>}
          </div>
        ))}
        <PlayheadHead pxPerSec={pxPerSec} />
        {markers.map((m) => (
          <div key={m.id} className="marker" data-marker={m.id} style={{ left: m.t * pxPerSec, ['--mc' as string]: m.color }} title={`${m.label} — drag to move, right-click for options`}>
            <span />
          </div>
        ))}
      </div>
    </div>
  );
}

function InOutShade({ headerW, pxPerSec, height }: { headerW: number; pxPerSec: number; height: number }) {
  const inP = useEditor((s) => s.project.inPoint);
  const outP = useEditor((s) => s.project.outPoint);
  if (inP === null && outP === null) return null;
  return (
    <>
      {inP !== null && inP > 0 && <div className="io-shade" style={{ left: headerW, width: inP * pxPerSec, height }} />}
      {outP !== null && <div className="io-shade" style={{ left: headerW + outP * pxPerSec, right: 0, height }} />}
      {inP !== null && <div className="io-edge in" style={{ left: headerW + inP * pxPerSec, height }} />}
      {outP !== null && <div className="io-edge out" style={{ left: headerW + outP * pxPerSec, height }} />}
    </>
  );
}

/** Playhead line, updated imperatively (no React re-render per frame). */
function Playhead({ headerW, height }: { headerW: number; height: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const pxPerSec = useEditor((s) => s.pxPerSec);
  useLayoutEffect(() => {
    const place = (t: number) => {
      if (ref.current) ref.current.style.transform = `translateX(${headerW + t * pxPerSec}px)`;
    };
    place(usePlayback.getState().time);
    return usePlayback.subscribe((s) => place(s.time));
  }, [headerW, pxPerSec]);
  return <div className="playhead" ref={ref} style={{ height }} aria-hidden="true" />;
}

/** Playhead handle drawn inside the (sticky) ruler. */
function PlayheadHead({ pxPerSec }: { pxPerSec: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const place = (t: number) => {
      if (ref.current) ref.current.style.transform = `translateX(${t * pxPerSec}px)`;
    };
    place(usePlayback.getState().time);
    return usePlayback.subscribe((s) => place(s.time));
  }, [pxPerSec]);
  return <div className="playhead-head" ref={ref} aria-hidden="true" />;
}

/* -------------------------------- Track row -------------------------------- */

interface TrackRowProps {
  row: TrackRowLayout;
  headerW: number;
  compact?: boolean;
  clips: Clip[];
  pxPerSec: number;
  selSet: Set<string>;
  assets: ReturnType<typeof editor>['project']['assets'];
  viewX0: number;
  viewX1: number;
  selectedTransition: string | null;
  allClips: Record<string, Clip>;
}

const TrackRow = memo(function TrackRow({ row, headerW, compact, clips, pxPerSec, selSet, assets, viewX0, viewX1, selectedTransition, allClips }: TrackRowProps) {
  const { track } = row;
  const transitions = clips.filter((c) => isVisualClip(c) && c.transitionOut);
  // Cuts between touching visual clips that don't have a transition yet.
  const sorted = [...clips].sort((a, b) => a.start - b.start);
  const openCuts: { a: Clip; at: number }[] = [];
  if (track.kind === 'video' && !track.locked) {
    for (let i = 0; i + 1 < sorted.length; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      const end = clipEnd(a);
      if (isVisualClip(a) && isVisualClip(b) && !a.transitionOut && Math.abs(b.start - end) < 1e-3 && a.duration * pxPerSec > 40 && b.duration * pxPerSec > 40) openCuts.push({ a, at: end });
    }
  }
  return (
    <div className={`track-row kind-${track.kind}${track.locked ? ' locked' : ''}`} style={{ top: row.top, height: row.height }}>
      <TrackHeader track={track} width={headerW} compact={compact} />
      <div className="lane" data-lane={track.id} style={{ left: headerW }}>
        {clips.map((c) => (
          <ClipView
            key={c.id}
            clip={c}
            asset={'assetId' in c ? assets[c.assetId] : undefined}
            pxPerSec={pxPerSec}
            top={0}
            height={row.height}
            selected={selSet.has(c.id)}
            viewX0={viewX0}
            viewX1={viewX1}
            trackMuted={track.muted}
            trackHidden={track.hidden}
          />
        ))}
        {openCuts.map(({ a, at }) => (
          <button
            key={`cut-${a.id}`}
            className="cut-add"
            style={{ left: at * pxPerSec - 8, top: row.height - 17 }}
            aria-label={`Add transition after ${a.name}`}
            data-tip="Add cross dissolve"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              A.addTransition(a.id, 'crossfade');
            }}
          >
            <Plus size={12} />
          </button>
        ))}
        {transitions.map((c) => {
          if (!isVisualClip(c) || !c.transitionOut) return null;
          const next = Object.values(allClips).find((o) => o.trackId === c.trackId && Math.abs(o.start - clipEnd(c)) < 1e-3);
          if (!next) return null;
          const d = c.transitionOut.duration;
          const cut = clipEnd(c);
          return (
            <div
              key={`tr-${c.id}`}
              className={`tl-transition${selectedTransition === c.id ? ' selected' : ''}`}
              data-transition={c.id}
              style={{ left: (cut - d / 2) * pxPerSec, width: Math.max(10, d * pxPerSec), top: row.height / 2 - 11 }}
              title={`${c.transitionOut.type} · ${d.toFixed(2)}s — click to edit, drag edges to resize`}
            >
              <div className="tr-edge l" data-handle="transition-edge" />
              <span className="tr-icon" />
              <div className="tr-edge r" data-handle="transition-edge" />
            </div>
          );
        })}
      </div>
    </div>
  );
});

function TrackHeader({ track, width, compact }: { track: Track; width: number; compact?: boolean }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(track.name);
  const selectedTrackId = useEditor((s) => s.selectedTrackId);
  const toggle = (key: 'hidden' | 'muted' | 'locked' | 'solo', label: string) =>
    editor().commit(label, (d) => {
      const t = d.tracks.find((x) => x.id === track.id);
      if (t) t[key] = !t[key];
    });
  const idx = editor().project.tracks.findIndex((t) => t.id === track.id);
  const menu: MenuItem[] = [
    { label: 'Rename', icon: <Pencil size={14} />, onClick: () => setRenaming(true) },
    { label: 'Move up', icon: <ArrowUp size={14} />, onClick: () => editor().commit('Move track', (d) => reorderTrack(d, track.id, idx - 1)) },
    { label: 'Move down', icon: <ArrowDown size={14} />, onClick: () => editor().commit('Move track', (d) => reorderTrack(d, track.id, idx + 1)) },
    { kind: 'separator' },
    {
      label: 'Taller',
      onClick: () => editor().commit('Resize track', (d) => {
        const t = d.tracks.find((x) => x.id === track.id);
        if (t) t.height = Math.min(160, t.height + 16);
      }),
    },
    {
      label: 'Shorter',
      onClick: () => editor().commit('Resize track', (d) => {
        const t = d.tracks.find((x) => x.id === track.id);
        if (t) t.height = Math.max(32, t.height - 16);
      }),
    },
    { kind: 'separator' },
    {
      label: 'Delete track',
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: () => {
        const n = Object.values(editor().project.clips).filter((c) => c.trackId === track.id).length;
        if (n > 0 && !window.confirm(`Delete “${track.name}” and its ${n} clip(s)?`)) return;
        editor().commit('Delete track', (d) => removeTrack(d, track.id));
      },
    },
  ];
  const icon = track.kind === 'video' ? <Film size={13} /> : track.kind === 'audio' ? <AudioLines size={13} /> : <Captions size={13} />;
  return (
    <div
      className={`track-header${selectedTrackId === track.id ? ' selected' : ''}`}
      style={{ width }}
      onContextMenu={(e) => openContextMenu(e, menu)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, input')) return;
        editor().select([]);
        editor().set('selectedTrackId', track.id);
      }}
    >
      <span className={`track-kind kind-${track.kind}`} aria-hidden="true">
        {icon}
      </span>
      {!compact &&
        (renaming ? (
          <input
            className="input track-name-input"
            autoFocus
            aria-label="Track name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              setRenaming(false);
              if (name.trim() && name !== track.name)
                editor().commit('Rename track', (d) => {
                  const t = d.tracks.find((x) => x.id === track.id);
                  if (t) t.name = name.trim().slice(0, 40);
                });
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') {
                setName(track.name);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <span className="track-name ellipsis" onDoubleClick={() => setRenaming(true)} title="Double-click to rename">
            {track.name}
          </span>
        ))}
      <div className="track-btns">
        {track.kind !== 'audio' && (
          <button className={`icon-btn tiny${track.hidden ? ' warn' : ''}`} aria-pressed={track.hidden} aria-label={track.hidden ? `Show ${track.name}` : `Hide ${track.name}`} data-tip={track.hidden ? 'Show track' : 'Hide track'} onClick={() => toggle('hidden', track.hidden ? 'Show track' : 'Hide track')}>
            {track.hidden ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        )}
        {track.kind !== 'caption' && (
          <button className={`icon-btn tiny${track.muted ? ' warn' : ''}`} aria-pressed={track.muted} aria-label={track.muted ? `Unmute ${track.name}` : `Mute ${track.name}`} data-tip={track.muted ? 'Unmute track' : 'Mute track'} onClick={() => toggle('muted', track.muted ? 'Unmute track' : 'Mute track')}>
            {track.muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </button>
        )}
        {track.kind !== 'caption' && (
          <button className="icon-btn tiny" aria-pressed={!!track.solo} aria-label={track.solo ? `Unsolo ${track.name}` : `Solo ${track.name}`} data-tip={track.solo ? 'Stop soloing' : 'Solo: hear only soloed tracks'} onClick={() => toggle('solo', track.solo ? 'Unsolo track' : 'Solo track')}>
            <Headphones size={14} />
          </button>
        )}
        <button className={`icon-btn tiny${track.locked ? ' warn' : ''}`} aria-pressed={track.locked} aria-label={track.locked ? `Unlock ${track.name}` : `Lock ${track.name}`} data-tip={track.locked ? 'Unlock track' : 'Lock track'} onClick={() => toggle('locked', track.locked ? 'Unlock track' : 'Lock track')}>
          {track.locked ? <Lock size={14} /> : <Unlock size={14} />}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------- Clip menu -------------------------------- */

function clipMenu(id: string): MenuItem[] {
  const p = editor().project;
  const c = p.clips[id];
  if (!c) return [];
  const t = usePlayback.getState().time;
  const under = c.start < t && clipEnd(c) > t;
  const items: MenuItem[] = [
    { label: 'Split at playhead', icon: <Scissors size={14} />, kbd: 'S', disabled: !under, onClick: () => A.splitAtPlayhead() },
    { label: 'Copy', kbd: `${MOD}C`, onClick: () => A.copySelection() },
    { label: 'Paste attributes', kbd: `${MOD}⌥V`, disabled: !A.hasClipboard(), onClick: () => A.pasteAttributes() },
    { label: 'Cut', kbd: `${MOD}X`, onClick: () => A.cutSelection() },
    { label: 'Duplicate', icon: <Copy size={14} />, kbd: `${MOD}D`, onClick: () => A.duplicateSelection() },
  ];
  if (c.type === 'video' || c.type === 'audio') {
    items.push({ kind: 'separator' }, { kind: 'label', label: 'Speed' });
    for (const s of [0.5, 1, 2]) items.push({ label: `${s}×`, checked: Math.abs(c.speed - s) < 1e-6, onClick: () => editor().commit('Change speed', (d) => setSpeed(d, id, s)) });
  }
  if (c.type === 'video') {
    items.push(
      { kind: 'separator' },
      { label: 'Detach audio', icon: <Unlink size={14} />, disabled: !p.assets[c.assetId]?.audio || c.muted, onClick: () => A.detachAudioSelection() },
      { label: 'Freeze frame at playhead', icon: <Snowflake size={14} />, disabled: !under, onClick: () => A.freezeFrame() },
    );
  }
  if (isVisualClip(c)) {
    const next = nextAdjacent(p, c);
    items.push({ kind: 'separator' });
    if (c.transitionOut) items.push({ label: 'Remove transition', onClick: () => A.removeTransition(id) });
    else items.push({ label: 'Add cross dissolve to next clip', disabled: !next || !isVisualClip(next), onClick: () => A.addTransition(id, 'crossfade') });
  }
  items.push(
    { kind: 'separator' },
    {
      label: c.disabled ? 'Enable clip' : 'Disable clip',
      onClick: () =>
        editor().commit(c.disabled ? 'Enable clip' : 'Disable clip', (d) => {
          for (const sid of editor().selection) if (d.clips[sid]) d.clips[sid].disabled = !c.disabled;
        }),
    },
    { label: 'Delete', icon: <Trash2 size={14} />, kbd: 'Del', danger: true, onClick: () => A.deleteSelection(false) },
    { label: 'Ripple delete', kbd: `${SHIFT}Del`, danger: true, onClick: () => A.deleteSelection(true) },
  );
  return items;
}
