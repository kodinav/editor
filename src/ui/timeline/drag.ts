import { deepClone } from '@/core/clone';
import { uid } from '@/core/ids';
import { addTrack, maxTransitionDuration, moveClips, nextAdjacent, q, shiftTrackFrom, splitClip, trimEnd, trimStart } from '@/core/ops';
import { clipEnd, isVisualTrackKind, trackById } from '@/core/project';
import type { Clip, Project, Track } from '@/core/types';
import { isVisualClip } from '@/core/types';
import { player } from '@/playback/player';
import { editor, usePlayback } from '@/state/store';
import { RULER_H, rowAtY, snapDelta, snapPoints, type TrackRowLayout } from './layout';

/**
 * Pointer interaction engine for the timeline. Every drag runs inside an
 * editor "gesture": each pointermove recomputes the edit from the state at
 * drag start, so results never drift, and the whole drag is one undo step.
 */

export interface TimelineCtx {
  scroller: () => HTMLElement;
  headerW: () => number;
  rows: () => TrackRowLayout[];
  setSnapLine: (t: number | null) => void;
  setMarquee: (r: { x0: number; y0: number; x1: number; y1: number } | null) => void;
}

const SNAP_PX = 8;
const DRAG_THRESHOLD = 4;

function pps() {
  return editor().pxPerSec;
}

export function timeAtClientX(ctx: TimelineCtx, clientX: number): number {
  const el = ctx.scroller();
  const r = el.getBoundingClientRect();
  return (clientX - r.left - ctx.headerW() + el.scrollLeft) / pps();
}

export function yInTracks(ctx: TimelineCtx, clientY: number): number {
  const el = ctx.scroller();
  const r = el.getBoundingClientRect();
  return clientY - r.top - RULER_H + el.scrollTop;
}

function snapEnabled(ev: PointerEvent | MouseEvent) {
  return editor().snapping !== ev.shiftKey;
}

/** Generic drag runner with threshold, autoscroll and cleanup. */
function runDrag(
  e: React.PointerEvent,
  ctx: TimelineCtx,
  handlers: {
    move: (ev: PointerEvent, started: boolean) => void;
    end: (ev: PointerEvent, moved: boolean) => void;
    cancel?: () => void;
  },
  immediate = false,
) {
  const el = ctx.scroller();
  const startX = e.clientX;
  const startY = e.clientY;
  let moved = immediate;
  let last: PointerEvent | null = null;
  let raf = 0;
  const pointerId = e.pointerId;
  try {
    el.setPointerCapture(pointerId);
  } catch {
    /* pointer may already be released */
  }

  const autoscroll = () => {
    raf = 0;
    if (!last || !moved) return;
    const r = el.getBoundingClientRect();
    const left = r.left + ctx.headerW();
    const edge = 40;
    let dx = 0;
    if (last.clientX < left + edge) dx = -Math.ceil((left + edge - last.clientX) / 3);
    else if (last.clientX > r.right - edge) dx = Math.ceil((last.clientX - (r.right - edge)) / 3);
    if (dx !== 0) {
      el.scrollLeft = Math.max(0, el.scrollLeft + dx);
      handlers.move(last, true);
      raf = requestAnimationFrame(autoscroll);
    }
  };

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    last = ev;
    if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
    moved = true;
    handlers.move(ev, true);
    if (!raf) raf = requestAnimationFrame(autoscroll);
  };
  const cleanup = () => {
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey, true);
    cancelAnimationFrame(raf);
    ctx.setSnapLine(null);
    ctx.setMarquee(null);
  };
  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    cleanup();
    handlers.end(ev, moved);
  };
  const onCancel = () => {
    cleanup();
    handlers.cancel?.();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      onCancel();
    }
  };
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', onKey, true);
}

function lockedTrack(p: Project, c: Clip): boolean {
  return !!trackById(p, c.trackId)?.locked;
}

/* -------------------------------- move -------------------------------- */

export function beginClipDrag(e: React.PointerEvent, ctx: TimelineCtx, clipId: string) {
  const s = editor();
  const p0 = s.project;
  const clip = p0.clips[clipId];
  if (!clip) return;
  const additive = e.shiftKey || e.metaKey || e.ctrlKey;
  const wasSelected = s.selection.includes(clipId);
  if (additive) s.select([clipId], { toggle: true });
  else if (!wasSelected) s.select([clipId]);

  if (s.tool === 'razor') {
    // Blade: split where clicked.
    runDrag(e, ctx, {
      move: () => {},
      end: (ev) => {
        let at = timeAtClientX(ctx, ev.clientX);
        if (snapEnabled(ev)) at += snapDelta([at], 0, snapPoints(p0, new Set([clipId]), usePlayback.getState().time), SNAP_PX / pps()).dt;
        editor().commit('Split', (d) => void splitClip(d, clipId, at));
      },
    });
    return;
  }

  if (lockedTrack(p0, clip) || additive) {
    runDrag(e, ctx, { move: () => {}, end: () => {} });
    return;
  }

  const selection = editor().selection.includes(clipId) ? editor().selection : [clipId];
  const ids = selection.filter((id) => p0.clips[id] && !lockedTrack(p0, p0.clips[id]));
  const clips = ids.map((id) => p0.clips[id]);
  const t0 = timeAtClientX(ctx, e.clientX);
  const edges = clips.flatMap((c) => [c.start, clipEnd(c)]);
  const points = snapPoints(p0, new Set(ids), usePlayback.getState().time);
  const dupIds = e.altKey ? ids.map(() => uid('clp')) : null;
  const origin = trackById(p0, clip.trackId)!;
  const visual = isVisualTrackKind(origin.kind);
  const sectionOf = (tracks: Track[]) => tracks.filter((t) => (visual ? isVisualTrackKind(t.kind) : t.kind === 'audio'));
  const section0 = sectionOf(p0.tracks);
  const originIdx = section0.findIndex((t) => t.id === origin.id);
  let began = false;

  runDrag(e, ctx, {
    move: (ev) => {
      if (!began) {
        editor().beginGesture(dupIds ? 'Duplicate clips' : 'Move clips');
        began = true;
      }
      let dt = timeAtClientX(ctx, ev.clientX) - t0;
      let snapAt: number | null = null;
      if (snapEnabled(ev)) {
        const r = snapDelta(edges, dt, points, SNAP_PX / pps());
        dt = r.dt;
        snapAt = r.at;
      }
      ctx.setSnapLine(snapAt);
      // Which track is under the pointer?
      const y = yInTracks(ctx, ev.clientY);
      const rows = ctx.rows();
      const sectionRows = rows.filter((r) => (visual ? isVisualTrackKind(r.track.kind) : r.track.kind === 'audio'));
      let newTrack: 'above' | 'below' | null = null;
      let hoveredIdx = originIdx;
      if (sectionRows.length) {
        const first = sectionRows[0];
        const last = sectionRows[sectionRows.length - 1];
        if (visual && y < first.top - 6 && clip.type !== 'caption') newTrack = 'above';
        else if (!visual && y > last.top + last.height + 6) newTrack = 'below';
        else {
          const row = rowAtY(rows, y);
          if (row && sectionRows.includes(row)) hoveredIdx = sectionRows.indexOf(row);
          else hoveredIdx = y < first.top ? 0 : sectionRows.length - 1;
        }
      }
      const insert = editor().ripple !== (ev.metaKey || ev.ctrlKey);
      editor().updateGesture((d) => {
        let moving = ids;
        if (dupIds) {
          moving = dupIds;
          ids.forEach((id, i) => {
            const copy = deepClone(d.clips[id]);
            copy.id = dupIds[i];
            d.clips[copy.id] = copy;
          });
        }
        let trackDelta = hoveredIdx - originIdx;
        if (newTrack) {
          const nt = addTrack(d, visual ? 'video' : 'audio');
          const sect = sectionOf(d.tracks);
          trackDelta = sect.indexOf(nt) - sect.findIndex((t) => t.id === origin.id);
        }
        moveClips(d, { clipIds: moving, dt: q(d, dt), trackDelta, mode: insert ? 'insert' : 'overwrite' });
      });
    },
    end: (_ev, moved) => {
      if (began) editor().endGesture();
      if (moved && dupIds) editor().select(dupIds.filter((id) => editor().project.clips[id]));
      if (!moved && wasSelected && !additive && editor().selection.length > 1) editor().select([clipId]);
    },
    cancel: () => began && editor().cancelGesture(),
  });
}

/* -------------------------------- trim -------------------------------- */

export function beginTrim(e: React.PointerEvent, ctx: TimelineCtx, clipId: string, edge: 'start' | 'end') {
  const s = editor();
  const p0 = s.project;
  const c0 = p0.clips[clipId];
  if (!c0 || lockedTrack(p0, c0)) return;
  if (!s.selection.includes(clipId)) s.select([clipId]);
  const points = snapPoints(p0, new Set([clipId]), usePlayback.getState().time);
  const siblings = Object.values(p0.clips).filter((c) => c.trackId === c0.trackId && c.id !== clipId);
  const prevEnd = Math.max(0, ...siblings.filter((c) => clipEnd(c) <= c0.start + 1e-6).map(clipEnd));
  const nextStart = Math.min(Infinity, ...siblings.filter((c) => c.start >= clipEnd(c0) - 1e-6).map((c) => c.start));
  const ripple = s.ripple;
  // Preserve the offset between the pointer and the edge being dragged.
  const grabOffset = (edge === 'start' ? c0.start : clipEnd(c0)) - timeAtClientX(ctx, e.clientX);
  let began = false;
  runDrag(
    e,
    ctx,
    {
      move: (ev) => {
        if (!began) {
          editor().beginGesture(edge === 'start' ? 'Trim start' : 'Trim end');
          began = true;
        }
        let t = timeAtClientX(ctx, ev.clientX) + grabOffset;
        let snapAt: number | null = null;
        if (snapEnabled(ev)) {
          const r = snapDelta([t], 0, points, SNAP_PX / pps());
          t += r.dt;
          snapAt = r.at;
        }
        ctx.setSnapLine(snapAt);
        const rippleNow = ripple !== (ev.metaKey || ev.ctrlKey);
        editor().updateGesture((d) => {
          if (edge === 'end') {
            const oldEnd = clipEnd(c0);
            const limit = rippleNow ? Infinity : nextStart;
            trimEnd(d, clipId, Math.min(t, limit), { ignoreNeighbors: rippleNow });
            if (rippleNow) {
              const delta = clipEnd(d.clips[clipId]) - oldEnd;
              if (Math.abs(delta) > 1e-9) shiftTrackFrom(d, c0.trackId, oldEnd - 1e-6, delta, new Set([clipId]));
            }
          } else {
            const limit = rippleNow ? 0 : prevEnd;
            trimStart(d, clipId, Math.max(t, limit), { ignoreNeighbors: rippleNow });
            if (rippleNow) {
              const c = d.clips[clipId];
              const delta = c.start - c0.start;
              if (Math.abs(delta) > 1e-9) {
                shiftTrackFrom(d, c0.trackId, clipEnd(c0) - 1e-6, -delta, new Set([clipId]));
                c.start = c0.start;
              }
            }
          }
        });
      },
      end: () => began && editor().endGesture(),
      cancel: () => began && editor().cancelGesture(),
    },
    false,
  );
}

/* -------------------------------- fades -------------------------------- */

export function beginFade(e: React.PointerEvent, ctx: TimelineCtx, clipId: string, which: 'fadeIn' | 'fadeOut') {
  const p0 = editor().project;
  const c0 = p0.clips[clipId];
  if (!c0 || !('fadeIn' in c0) || lockedTrack(p0, c0)) return;
  e.stopPropagation();
  editor().beginGesture(which === 'fadeIn' ? 'Fade in' : 'Fade out');
  runDrag(
    e,
    ctx,
    {
      move: (ev) => {
        const t = timeAtClientX(ctx, ev.clientX);
        const v = which === 'fadeIn' ? t - c0.start : clipEnd(c0) - t;
        const clamped = Math.max(0, Math.min(c0.duration, Math.round(v * 20) / 20));
        editor().updateGesture((d) => {
          const c = d.clips[clipId];
          if (c && 'fadeIn' in c) c[which] = clamped;
        });
      },
      end: () => editor().endGesture(),
      cancel: () => editor().cancelGesture(),
    },
    true,
  );
}

/* ----------------------------- transitions ----------------------------- */

export function beginTransitionResize(e: React.PointerEvent, ctx: TimelineCtx, clipId: string) {
  const p0 = editor().project;
  const a = p0.clips[clipId];
  if (!a || !isVisualClip(a) || !a.transitionOut) return;
  const b = nextAdjacent(p0, a);
  if (!b) return;
  e.stopPropagation();
  editor().set('selectedTransition', clipId);
  const cut = clipEnd(a);
  const max = maxTransitionDuration(a, b);
  const fps = p0.settings.fps;
  editor().beginGesture('Transition duration');
  runDrag(
    e,
    ctx,
    {
      move: (ev) => {
        const t = timeAtClientX(ctx, ev.clientX);
        const dur = Math.max(2 / fps, Math.min(max, Math.round(Math.abs(t - cut) * 2 * fps) / fps));
        editor().updateGesture((d) => {
          const c = d.clips[clipId];
          if (c && isVisualClip(c) && c.transitionOut) c.transitionOut.duration = dur;
        });
      },
      end: () => editor().endGesture(),
      cancel: () => editor().cancelGesture(),
    },
    true,
  );
}

/* ------------------------------ keyframes ------------------------------ */

export function beginKeyframeDrag(e: React.PointerEvent, ctx: TimelineCtx, clipId: string, kfTime: number) {
  const p0 = editor().project;
  const c0 = p0.clips[clipId];
  if (!c0) return;
  e.stopPropagation();
  const tol = 1 / 2000 * 20;
  let began = false;
  runDrag(e, ctx, {
    move: (ev) => {
      if (!began) {
        editor().beginGesture('Move keyframes');
        began = true;
      }
      let t = timeAtClientX(ctx, ev.clientX) - c0.start;
      const ph = usePlayback.getState().time - c0.start;
      if (snapEnabled(ev) && Math.abs(t - ph) * pps() < SNAP_PX) t = ph;
      t = Math.max(0, Math.min(c0.duration, q(p0, t)));
      editor().updateGesture((d) => {
        const c = d.clips[clipId];
        if (!c) return;
        for (const list of Object.values(c.keyframes)) {
          for (const k of list) if (Math.abs(k.t - kfTime) < tol) k.t = t;
          list.sort((x, y) => x.t - y.t);
        }
      });
    },
    end: (_ev, moved) => {
      if (began) editor().endGesture();
      if (!moved) player.seek(c0.start + kfTime);
    },
    cancel: () => began && editor().cancelGesture(),
  });
}

/* -------------------------------- markers ------------------------------- */

export function beginMarkerDrag(e: React.PointerEvent, ctx: TimelineCtx, markerId: string) {
  const p0 = editor().project;
  const m0 = p0.markers.find((m) => m.id === markerId);
  if (!m0) return;
  e.stopPropagation();
  let began = false;
  runDrag(e, ctx, {
    move: (ev) => {
      if (!began) {
        editor().beginGesture('Move marker');
        began = true;
      }
      const t = Math.max(0, q(p0, timeAtClientX(ctx, ev.clientX)));
      editor().updateGesture((d) => {
        const m = d.markers.find((x) => x.id === markerId);
        if (m) m.t = t;
        d.markers.sort((a, b) => a.t - b.t);
      });
    },
    end: (_ev, moved) => {
      if (began) editor().endGesture();
      if (!moved) player.seek(m0.t);
    },
    cancel: () => began && editor().cancelGesture(),
  });
}

/* ------------------------------ scrubbing ------------------------------ */

export function beginScrub(e: React.PointerEvent, ctx: TimelineCtx) {
  const p0 = editor().project;
  const points = snapPoints(p0, new Set(), -1);
  const wasPlaying = usePlayback.getState().playing;
  if (wasPlaying) player.pause();
  const seekTo = (ev: PointerEvent | React.PointerEvent) => {
    let t = Math.max(0, timeAtClientX(ctx, ev.clientX));
    if (editor().snapping && !ev.shiftKey) {
      const r = snapDelta([t], 0, points, 6 / pps());
      t += r.dt;
    }
    player.seek(q(p0, t), { scrub: true });
  };
  seekTo(e);
  runDrag(
    e,
    ctx,
    {
      move: (ev) => seekTo(ev),
      end: () => {},
    },
    true,
  );
}

/* ------------------------------ marquee ------------------------------ */

export function beginMarquee(e: React.PointerEvent, ctx: TimelineCtx) {
  const el = ctx.scroller();
  const r = el.getBoundingClientRect();
  const toContent = (cx: number, cy: number) => ({ x: cx - r.left + el.scrollLeft - ctx.headerW(), y: cy - r.top + el.scrollTop - RULER_H });
  const start = toContent(e.clientX, e.clientY);
  const additive = e.shiftKey || e.metaKey || e.ctrlKey;
  const base = additive ? editor().selection : [];
  runDrag(e, ctx, {
    move: (ev) => {
      const cur = toContent(ev.clientX, ev.clientY);
      const rect = { x0: Math.min(start.x, cur.x), y0: Math.min(start.y, cur.y), x1: Math.max(start.x, cur.x), y1: Math.max(start.y, cur.y) };
      ctx.setMarquee(rect);
      const pp = pps();
      const t0 = rect.x0 / pp;
      const t1 = rect.x1 / pp;
      const p = editor().project;
      const hit: string[] = [];
      for (const row of ctx.rows()) {
        if (row.top + row.height < rect.y0 || row.top > rect.y1) continue;
        for (const c of Object.values(p.clips)) {
          if (c.trackId !== row.track.id) continue;
          if (clipEnd(c) > t0 && c.start < t1) hit.push(c.id);
        }
      }
      editor().select([...new Set([...base, ...hit])]);
    },
    end: (ev, moved) => {
      if (!moved) {
        if (!additive) editor().select([]);
        editor().set('selectedTrackId', null);
        // A plain click on empty timeline also moves the playhead there.
        const t = Math.max(0, timeAtClientX(ctx, ev.clientX));
        player.seek(q(editor().project, t));
      }
    },
  });
}
