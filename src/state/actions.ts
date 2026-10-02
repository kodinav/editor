import { deepClone } from '@/core/clone';
import { createEffect, FILTER_PRESETS, NEUTRAL_COLOR } from '@/core/effects';
import { isActiveAt } from '@/core/evaluate';
import { uid } from '@/core/ids';
import {
  addTrack,
  closeGapAt,
  deleteClips,
  detachAudio,
  duplicateClips,
  makeRoomFor,
  maxTransitionDuration,
  nextAdjacent,
  pasteClips,
  q,
  splitAt,
  trimEnd,
  trimStart,
  shiftTrackFrom,
  setSpeed,
} from '@/core/ops';
import {
  clipEnd,
  clipsOnTrack,
  createAdjustmentClip,
  createCaptionClip,
  createShapeClip,
  createTextClip,
  projectDuration,
  scaledCaptionStyle,
} from '@/core/project';
import { evalProp, setStaticValue } from '@/core/keyframes';
import { TEXT_PRESETS } from '@/core/textPresets';
import { DEFAULT_TRANSITION_DURATION } from '@/core/transitions';
import type { Clip, ShapeKind, VideoClip, Project } from '@/core/types';
import { isVisualClip } from '@/core/types';
import { player } from '@/playback/player';
import { editor, toast, usePlayback } from './store';

/**
 * High-level editing commands. Each is one undoable step. UI controls,
 * context menus and keyboard shortcuts all route through these.
 */

const now = () => usePlayback.getState().time;

function selectedClips(): Clip[] {
  const { project, selection } = editor();
  return selection.map((id) => project.clips[id]).filter(Boolean);
}

function editableClipIds(p: Project, ids: string[]): string[] {
  return ids.filter((id) => {
    const c = p.clips[id];
    const t = c && p.tracks.find((x) => x.id === c.trackId);
    return c && t && !t.locked;
  });
}

export function splitAtPlayhead() {
  const t = now();
  const { selection, project } = editor();
  const sel = editableClipIds(project, selection).filter((id) => isActiveAt(project.clips[id], t));
  let created: string[] = [];
  editor().commit('Split', (d) => {
    created = splitAt(d, t, sel.length ? sel : undefined);
  });
  if (created.length === 0) toast({ kind: 'info', message: 'Move the playhead over a clip to split it.' });
}

export function deleteSelection(ripple = editor().ripple) {
  const { project, selection, selectedTransition } = editor();
  if (selectedTransition) {
    removeTransition(selectedTransition);
    return;
  }
  const ids = editableClipIds(project, selection);
  if (!ids.length) return;
  editor().commit(ripple ? 'Ripple delete' : 'Delete', (d) => deleteClips(d, ids, ripple));
  editor().select([]);
}

export function duplicateSelection() {
  const ids = editableClipIds(editor().project, editor().selection);
  if (!ids.length) return;
  let out: string[] = [];
  editor().commit('Duplicate', (d) => {
    out = duplicateClips(d, ids);
  });
  editor().select(out);
}

let clipboard: Clip[] = [];

export function copySelection(): boolean {
  const clips = selectedClips();
  if (!clips.length) return false;
  clipboard = deepClone(clips);
  toast({ kind: 'info', message: `Copied ${clips.length} clip${clips.length > 1 ? 's' : ''}.`, timeout: 1500 });
  return true;
}

export function cutSelection() {
  if (copySelection()) deleteSelection(false);
}

export function paste() {
  if (!clipboard.length) return;
  let out: string[] = [];
  editor().commit('Paste', (d) => {
    out = pasteClips(d, clipboard, now());
  });
  editor().select(out);
}

export function hasClipboard() {
  return clipboard.length > 0;
}

export function selectAll() {
  editor().select(Object.keys(editor().project.clips));
}

/** Q / W: trim the start/end of clips under the playhead to the playhead, closing the gap (ripple). */
export function trimToPlayhead(edge: 'start' | 'end', ripple = true) {
  const t = now();
  const { project, selection } = editor();
  const under = Object.values(project.clips).filter((c) => isActiveAt(c, t) && c.start < t - 1e-6);
  const targets = selection.length ? under.filter((c) => selection.includes(c.id)) : under;
  const ids = editableClipIds(project, targets.map((c) => c.id));
  if (!ids.length) return;
  editor().commit(edge === 'start' ? 'Trim start' : 'Trim end', (d) => {
    for (const id of ids) {
      const c = d.clips[id];
      if (!c) continue;
      if (edge === 'start') {
        const removed = t - c.start;
        const trackId = c.trackId;
        const oldStart = c.start;
        trimStart(d, id, t);
        if (ripple) {
          shiftTrackFrom(d, trackId, oldStart + 1e-6, -removed);
          const cc = d.clips[id];
          if (cc) cc.start = q(d, oldStart);
        }
      } else {
        const oldEnd = clipEnd(c);
        trimEnd(d, id, t);
        if (ripple) shiftTrackFrom(d, c.trackId, oldEnd, -(oldEnd - clipEnd(d.clips[id])));
      }
    }
  });
  if (edge === 'start' && ripple) {
    const first = editor().project.clips[ids[0]];
    if (first) player.seek(first.start);
  }
}

export function nudgeSelection(frames: number) {
  const ids = editableClipIds(editor().project, editor().selection);
  if (!ids.length) return;
  const fps = editor().project.settings.fps;
  editor().commit('Nudge', (d) => {
    for (const id of ids) {
      const c = d.clips[id];
      if (c) c.start = Math.max(0, q(d, c.start + frames / fps));
    }
    makeRoomFor(d, ids, 'overwrite');
  });
}

export function closeGap(trackId: string, t: number) {
  let closed = false;
  editor().commit('Close gap', (d) => {
    closed = closeGapAt(d, trackId, t);
  });
  if (!closed) toast({ kind: 'info', message: 'No gap at that position.' });
}

function topFreeVideoTrack(d: Project, start: number, end: number): string {
  // Prefer the top-most video track that is free (overlays go above footage).
  const vids = d.tracks.filter((t) => t.kind === 'video' && !t.locked);
  for (const t of vids) {
    const free = clipsOnTrack(d, t.id).every((c) => clipEnd(c) <= start + 1e-6 || c.start >= end - 1e-6);
    if (free) return t.id;
  }
  return addTrack(d, 'video').id;
}

export function addTextPreset(presetId: string, at = now()): string | null {
  const preset = TEXT_PRESETS.find((p) => p.id === presetId) ?? TEXT_PRESETS[0];
  let id: string | null = null;
  editor().commit('Add text', (d) => {
    const dur = 4;
    const trackId = topFreeVideoTrack(d, at, at + dur);
    // Scale presets authored for 1080p to the project size.
    const k = Math.min(d.settings.width, d.settings.height) / 1080;
    const style = { ...preset.style, fontSize: Math.round((preset.style.fontSize ?? 96) * k) };
    const c = createTextClip({ trackId, start: q(d, at), duration: dur }, preset.text, style);
    c.name = preset.name;
    if (preset.y) c.transform.y = preset.y * d.settings.height;
    if (preset.x) c.transform.x = preset.x * d.settings.width;
    if (preset.animIn) c.animIn = { ...preset.animIn };
    if (preset.animOut) c.animOut = { ...preset.animOut };
    if (preset.effects) c.effects = preset.effects.map((e) => ({ ...createEffect(e.type), params: { ...createEffect(e.type).params, ...(e.params ?? {}) } }));
    d.clips[c.id] = c;
    makeRoomFor(d, [c.id], 'overwrite');
    id = c.id;
  });
  if (id) {
    editor().select([id]);
    revealAfterIntro(id);
  }
  return id;
}

/** Park the playhead where a just-added layer is fully visible (past its intro animation). */
function revealAfterIntro(id: string) {
  const c = editor().project.clips[id];
  if (!c || !isVisualClip(c) || usePlayback.getState().playing) return;
  if (c.animIn.preset !== 'none' && c.animIn.duration > 0) {
    player.seek(c.start + Math.min(c.animIn.duration, c.duration / 2));
  }
}

/** A track for a full-frame background: below every layer that is visible in [start, end). */
function backgroundTrack(d: Project, start: number, end: number): string {
  const free = (id: string) => clipsOnTrack(d, id).every((c) => clipEnd(c) <= start + 1e-6 || c.start >= end - 1e-6);
  const vids = d.tracks.filter((t) => t.kind === 'video');
  let pick: string | null = null;
  // From the bottom up, as long as nothing below is in the way.
  for (let i = vids.length - 1; i >= 0 && free(vids[i].id); i--) if (!vids[i].locked) pick = vids[i].id;
  if (pick) return pick;
  const lastVideo = d.tracks.map((t) => t.kind).lastIndexOf('video');
  return addTrack(d, 'video', lastVideo + 1).id;
}

export function addShape(kind: ShapeKind, opts: { fullFrame?: boolean; fill?: string; fill2?: string | null } = {}) {
  const at = now();
  let id: string | null = null;
  editor().commit('Add shape', (d) => {
    const dur = 5;
    const trackId = opts.fullFrame ? backgroundTrack(d, at, at + dur) : topFreeVideoTrack(d, at, at + dur);
    const k = Math.min(d.settings.width, d.settings.height) / 1080;
    const c = createShapeClip({ trackId, start: q(d, at), duration: dur }, kind, {
      width: opts.fullFrame ? d.settings.width : Math.round((kind === 'line' ? 600 : kind === 'arrow' ? 420 : 360) * k),
      height: opts.fullFrame ? d.settings.height : Math.round((kind === 'line' ? 10 : kind === 'arrow' ? 160 : 360) * k),
      fill: opts.fill ?? '#4f8cff',
      fill2: opts.fill2 ?? null,
      radius: kind === 'rectangle' && !opts.fullFrame ? Math.round(24 * k) : 0,
    });
    if (opts.fullFrame) c.name = opts.fill2 ? 'Gradient background' : 'Color background';
    d.clips[c.id] = c;
    makeRoomFor(d, [c.id], 'overwrite');
    id = c.id;
  });
  if (id) editor().select([id]);
}

export function addAdjustmentLayer() {
  const at = now();
  let id: string | null = null;
  editor().commit('Add adjustment layer', (d) => {
    const dur = Math.max(3, Math.min(10, projectDuration(d) - at || 5));
    const trackId = topFreeVideoTrack(d, at, at + dur);
    const c = createAdjustmentClip({ trackId, start: q(d, at), duration: q(d, dur) });
    d.clips[c.id] = c;
    id = c.id;
  });
  if (id) editor().select([id]);
}

export function addCaptionAt(t = now(), text = 'New caption'): string | null {
  let id: string | null = null;
  editor().commit('Add caption', (d) => {
    let track = d.tracks.find((x) => x.kind === 'caption');
    if (!track) {
      track = addTrack(d, 'caption');
      track.captionStyle = scaledCaptionStyle(d.settings.height);
    }
    const existing = clipsOnTrack(d, track.id);
    const next = existing.find((c) => c.start > t + 1e-6);
    const maxDur = next ? next.start - t : 3;
    const dur = q(d, Math.max(0.5, Math.min(3, maxDur)));
    const c = createCaptionClip({ trackId: track.id, start: q(d, t), duration: dur }, text);
    d.clips[c.id] = c;
    makeRoomFor(d, [c.id], 'overwrite');
    id = c.id;
  });
  if (id) editor().select([id]);
  return id;
}

export function addMarker() {
  const t = now();
  editor().commit('Add marker', (d) => {
    if (d.markers.some((m) => Math.abs(m.t - t) < 1 / d.settings.fps)) return;
    d.markers.push({ id: uid('mk'), t: q(d, t), label: `Marker ${d.markers.length + 1}`, color: '#f5c542' });
    d.markers.sort((a, b) => a.t - b.t);
  });
}

export function setInPoint(t: number | null = now()) {
  editor().commit('Set in point', (d) => {
    d.inPoint = t === null ? null : q(d, t);
    if (d.outPoint !== null && d.inPoint !== null && d.outPoint <= d.inPoint) d.outPoint = null;
  });
}

export function setOutPoint(t: number | null = now()) {
  editor().commit('Set out point', (d) => {
    d.outPoint = t === null ? null : q(d, t);
    if (d.inPoint !== null && d.outPoint !== null && d.inPoint >= d.outPoint) d.inPoint = null;
  });
}

export function detachAudioSelection() {
  const ids = editor().selection.filter((id) => editor().project.clips[id]?.type === 'video');
  if (!ids.length) return;
  let n = 0;
  editor().commit('Detach audio', (d) => {
    for (const id of ids) if (detachAudio(d, id)) n++;
  });
  if (n === 0) {
    const muted = ids.some((id) => (editor().project.clips[id] as VideoClip).muted);
    toast({ kind: 'info', message: muted ? 'This clip’s audio is already detached or muted.' : 'The selected clip has no audio.' });
  }
}

/** Add (or replace) a transition at the cut after `clipId`. */
export function addTransition(clipId: string, type: string): boolean {
  const p = editor().project;
  const c = p.clips[clipId];
  if (!c || !isVisualClip(c)) return false;
  const next = nextAdjacent(p, c);
  if (!next || !isVisualClip(next)) {
    toast({ kind: 'info', message: 'Transitions go between two touching clips on the same track.', detail: 'For a fade at the start or end, use the clip’s In/Out animation.' });
    return false;
  }
  const max = maxTransitionDuration(c, next);
  editor().commit('Add transition', (d) => {
    const cc = d.clips[clipId];
    if (cc && isVisualClip(cc)) cc.transitionOut = { type, duration: Math.min(cc.transitionOut?.duration ?? DEFAULT_TRANSITION_DURATION, max) };
  });
  editor().set('selectedTransition', clipId);
  return true;
}

export function removeTransition(clipId: string) {
  editor().commit('Remove transition', (d) => {
    const c = d.clips[clipId];
    if (c && isVisualClip(c)) c.transitionOut = undefined;
  });
  editor().set('selectedTransition', null);
}

/** Apply a transition to every cut between selected clips (or all cuts on their tracks). */
export function addTransitionToSelection(type: string) {
  const { project, selection } = editor();
  let count = 0;
  editor().commit('Add transitions', (d) => {
    for (const id of selection) {
      const c = d.clips[id];
      if (!c || !isVisualClip(c)) continue;
      const next = nextAdjacent(project, project.clips[id]);
      if (!next || !isVisualClip(next)) continue;
      c.transitionOut = { type, duration: Math.min(DEFAULT_TRANSITION_DURATION, maxTransitionDuration(c, next)) };
      count++;
    }
  });
  if (count === 0) toast({ kind: 'info', message: 'Select a clip that touches the next clip to add a transition.' });
}

export function applyEffectToSelection(type: string) {
  const ids = editor().selection.filter((id) => {
    const c = editor().project.clips[id];
    return c && 'effects' in c;
  });
  if (!ids.length) {
    toast({ kind: 'info', message: 'Select a clip first, then add an effect.' });
    return;
  }
  editor().commit('Add effect', (d) => {
    for (const id of ids) {
      const c = d.clips[id];
      if (c && 'effects' in c) c.effects.push(createEffect(type));
    }
  });
}

export function applyFilterPreset(presetId: string, ids = editor().selection) {
  const preset = FILTER_PRESETS.find((f) => f.id === presetId);
  if (!preset) return;
  const targets = ids.filter((id) => {
    const c = editor().project.clips[id];
    return c && 'color' in c;
  });
  if (!targets.length) {
    toast({ kind: 'info', message: 'Select a video or image clip to apply a filter.' });
    return;
  }
  editor().commit(`Filter: ${preset.name}`, (d) => {
    for (const id of targets) {
      const c = d.clips[id];
      if (!c || !(isVisualClip(c) || c.type === 'adjustment')) continue;
      c.color = { ...NEUTRAL_COLOR, ...preset.color };
      // Replace effects previously added by a filter preset.
      c.effects = c.effects.filter((e) => !e.look);
      for (const e of preset.effects ?? []) {
        const fx = createEffect(e.type);
        fx.params = { ...fx.params, ...(e.params ?? {}) };
        fx.look = true;
        c.effects.push(fx);
      }
    }
  });
}

/** Insert a 2-second still of the current frame of the selected (or topmost) video clip. */
export function freezeFrame() {
  const t = now();
  const p = editor().project;
  const candidates = Object.values(p.clips).filter((c): c is VideoClip => c.type === 'video' && isActiveAt(c, t));
  const target = candidates.find((c) => editor().selection.includes(c.id)) ?? candidates[0];
  if (!target) {
    toast({ kind: 'info', message: 'Move the playhead over a video clip to freeze a frame.' });
    return;
  }
  let id: string | null = null;
  editor().commit('Freeze frame', (d) => {
    const tq = q(d, t);
    const c = d.clips[target.id] as VideoClip;
    const srcT = c.sourceIn + (tq - c.start) * c.speed;
    const hold = 2;
    // Split at the playhead and push the remainder right by the freeze length; what comes
    // later on the other unlocked tracks moves too, so it stays in sync.
    if (tq > c.start + 1e-6 && tq < clipEnd(c) - 1e-6) splitAt(d, tq, [c.id]);
    for (const tr of d.tracks) if (tr.id === c.trackId || !tr.locked) shiftTrackFrom(d, tr.id, tq, hold);
    for (const m of d.markers) if (m.t >= tq) m.t += hold;
    const still: VideoClip = {
      ...deepClone(c),
      id: uid('clp'),
      start: tq,
      duration: hold,
      sourceIn: srcT,
      freeze: true,
      muted: true,
      transitionOut: undefined,
      keyframes: {},
      animIn: { ...c.animIn, preset: 'none' },
      animOut: { ...c.animOut, preset: 'none' },
      name: `${c.name} (freeze)`,
    };
    // The still holds the picture exactly as it was at that moment, animated values included.
    for (const path of Object.keys(target.keyframes)) setStaticValue(still, path, evalProp(target, path, tq - target.start));
    d.clips[still.id] = still;
    id = still.id;
  });
  if (id) editor().select([id]);
}

export function setClipSpeedPreset(speed: number) {
  const ids = editor().selection.filter((id) => {
    const c = editor().project.clips[id];
    return c && (c.type === 'video' || c.type === 'audio');
  });
  if (!ids.length) return;
  editor().commit('Change speed', (d) => {
    for (const id of ids) setSpeed(d, id, speed);
  });
}

/** D: select the clip under the playhead; pressing again moves down through stacked clips. */
export function selectClipAtPlayhead() {
  const t = now();
  const p = editor().project;
  const order = p.tracks.map((t) => t.id);
  const under = Object.values(p.clips)
    .filter((c) => isActiveAt(c, t))
    .sort((a, b) => order.indexOf(a.trackId) - order.indexOf(b.trackId));
  if (!under.length) return;
  const sel = editor().selection;
  const i = sel.length === 1 ? under.findIndex((c) => c.id === sel[0]) : -1;
  editor().select([under[(i + 1) % under.length].id]);
}

const byStart = (a: Clip, b: Clip) => a.start - b.start;

/** [ / ]: the previous / next clip on the selected clip's track (from the playhead if nothing is selected). */
export function selectSiblingClip(dir: 1 | -1) {
  const p = editor().project;
  const cur = p.clips[editor().selection[0] ?? ''];
  const trackId = cur?.trackId ?? p.tracks.find((tr) => Object.values(p.clips).some((c) => c.trackId === tr.id))?.id;
  if (!trackId) return;
  const list = Object.values(p.clips)
    .filter((c) => c.trackId === trackId)
    .sort(byStart);
  let next: Clip | undefined;
  if (cur) next = list[list.indexOf(cur) + dir];
  else {
    const t = now();
    next = dir > 0 ? list.find((c) => clipEnd(c) > t) : [...list].reverse().find((c) => c.start < t);
  }
  if (next) editor().select([next.id]);
}

/** Alt+Up / Alt+Down: the clip on the nearest track above / below that is closest in time. */
export function selectClipOnAdjacentTrack(dir: 1 | -1) {
  const p = editor().project;
  const cur = p.clips[editor().selection[0] ?? ''];
  const t = cur ? cur.start + cur.duration / 2 : now();
  let i = cur ? p.tracks.findIndex((tr) => tr.id === cur.trackId) : dir > 0 ? -1 : p.tracks.length;
  for (i += dir; i >= 0 && i < p.tracks.length; i += dir) {
    const list = Object.values(p.clips).filter((c) => c.trackId === p.tracks[i].id);
    if (!list.length) continue;
    const dist = (c: Clip) => (t >= c.start && t < clipEnd(c) ? 0 : Math.min(Math.abs(c.start - t), Math.abs(clipEnd(c) - t)));
    editor().select([list.reduce((a, b) => (dist(b) < dist(a) ? b : a)).id]);
    return;
  }
}

export function jumpToEdit(dir: 1 | -1) {
  const p = editor().project;
  const t = now();
  const points = new Set<number>([0]);
  for (const c of Object.values(p.clips)) {
    points.add(c.start);
    points.add(clipEnd(c));
  }
  for (const m of p.markers) points.add(m.t);
  const sorted = [...points].sort((a, b) => a - b);
  const eps = 0.5 / p.settings.fps;
  const target = dir > 0 ? sorted.find((x) => x > t + eps) : [...sorted].reverse().find((x) => x < t - eps);
  if (target !== undefined) player.seek(target);
}
