import { create } from 'zustand';
import { enableMapSet, produce, setAutoFreeze } from 'immer';
import { createProject } from '@/core/project';
import type { Asset, Project } from '@/core/types';
import { normalize } from '@/core/ops';

enableMapSet();
// Immutable snapshots are shared between history entries; freezing them in
// production is unnecessary overhead.
setAutoFreeze(import.meta.env.DEV);

const HISTORY_LIMIT = 200;

export type LeftPanel = 'media' | 'text' | 'elements' | 'transitions' | 'effects' | 'filters' | 'captions';
export type Tool = 'select' | 'razor';
export type SaveState = 'saved' | 'saving' | 'unsaved' | 'error';
export type PreviewQuality = 'auto' | 'full' | 'half' | 'quarter';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  message: string;
  detail?: string;
  action?: { label: string; run: () => void };
  /** ms; 0 = sticky */
  timeout: number;
}

export interface SelectedKeyframe {
  clipId: string;
  path: string;
  kfId: string;
}

export interface HistoryEntry {
  project: Project;
  label: string;
}

export interface EditorState {
  project: Project;
  past: HistoryEntry[];
  future: HistoryEntry[];
  /** Snapshot taken at gesture start; gesture updates are applied relative to it. */
  gestureBase: Project | null;
  gestureLabel: string;
  lastLabel: string;

  selection: string[];
  selectedTrackId: string | null;
  selectedKeyframe: SelectedKeyframe | null;
  selectedTransition: string | null;

  pxPerSec: number;
  scrollX: number;
  snapping: boolean;
  ripple: boolean;
  tool: Tool;

  leftPanel: LeftPanel;
  leftOpen: boolean;
  inspectorOpen: boolean;
  dialog: null | 'export' | 'projects' | 'shortcuts' | 'settings' | 'newProject';
  toasts: Toast[];
  saveState: SaveState;
  previewQuality: PreviewQuality;
  showSafeArea: boolean;
  /** Crop handles are shown on the canvas for the selected clip. */
  cropMode: boolean;
  /** Asset shown in the source preview (watch and choose a part before adding). */
  sourcePreview: string | null;
  loop: boolean;
  /** True when the open project failed to acquire the cross-tab lock. */
  readOnlyReason: string | null;

  /* actions */
  loadProject(p: Project): void;
  /**
   * Apply an undoable edit. With `coalesce`, consecutive edits that share the
   * key (typing, picking a colour, arrow-key nudges) merge into one undo step
   * while they keep coming.
   */
  commit(label: string, recipe: (draft: Project) => void, opts?: { coalesce?: string }): void;
  /** Mutate without creating an undo entry (asset status, autosave metadata, ...). */
  silent(recipe: (draft: Project) => void): void;
  beginGesture(label: string): void;
  updateGesture(recipe: (draft: Project) => void): void;
  endGesture(): void;
  cancelGesture(): void;
  undo(): void;
  redo(): void;
  select(ids: string[], opts?: { add?: boolean; toggle?: boolean }): void;
  set<K extends keyof EditorState>(key: K, value: EditorState[K]): void;
  toast(t: Omit<Toast, 'id' | 'timeout'> & { timeout?: number }): number;
  dismissToast(id: number): void;
}

let toastSeq = 1;

/** The name of a locked track whose clips `after` changes, if any. */
function lockedTrackTouched(before: Project, after: Project): string | null {
  const locked = new Map(before.tracks.filter((t) => t.locked).map((t) => [t.id, t.name]));
  if (!locked.size || before.clips === after.clips) return null;
  for (const id of new Set([...Object.keys(before.clips), ...Object.keys(after.clips)])) {
    const a = before.clips[id];
    const b = after.clips[id];
    if (a === b) continue;
    const hit = (a && locked.get(a.trackId)) || (b && locked.get(b.trackId));
    if (hit) return hit;
  }
  return null;
}

/** Edits with the same coalesce key this close together share an undo step. */
const COALESCE_MS = 1500;
let coalescing: { key: string; at: number } | null = null;

/**
 * Undo/redo: the snapshot decides which assets exist (so removing media is
 * undoable and redoable), while the current metadata wins for the ones it has
 * (analysis results and storage state are never rolled back). Imports reach
 * every snapshot through silent(), so undo never removes them.
 */
function restoreAssets(snapshot: Project, current: Project): Project {
  return produce(snapshot, (d) => {
    for (const id of Object.keys(d.assets)) {
      const now = current.assets[id];
      if (now && now !== snapshot.assets[id]) d.assets[id] = now as Asset;
    }
    d.name = current.name;
  });
}

export const useEditor = create<EditorState>()((set, get) => ({
  project: createProject(),
  past: [],
  future: [],
  gestureBase: null,
  gestureLabel: '',
  lastLabel: '',

  selection: [],
  selectedTrackId: null,
  selectedKeyframe: null,
  selectedTransition: null,

  pxPerSec: 80,
  scrollX: 0,
  snapping: true,
  ripple: false,
  tool: 'select',

  leftPanel: 'media',
  leftOpen: true,
  // On narrower screens the inspector is a drawer over the preview; start closed there.
  inspectorOpen: typeof window === 'undefined' || window.innerWidth > 1180,
  dialog: null,
  toasts: [],
  saveState: 'saved',
  previewQuality: 'auto',
  showSafeArea: false,
  cropMode: false,
  sourcePreview: null,
  loop: false,
  readOnlyReason: null,

  loadProject(p) {
    coalescing = null;
    set({
      project: p,
      past: [],
      future: [],
      gestureBase: null,
      selection: [],
      selectedTrackId: null,
      selectedKeyframe: null,
      selectedTransition: null,
      scrollX: 0,
      saveState: 'saved',
    });
  },

  commit(label, recipe, opts = {}) {
    const { project, past, gestureBase } = get();
    const apply = (base: Project) =>
      produce(base, (d) => {
        recipe(d);
        normalize(d);
        d.updatedAt = Date.now();
      });
    if (gestureBase) {
      // Something else changed the project mid-gesture (a finished background job, a
      // shortcut): keep it in both the gesture's base and the current state, as its own
      // undo step before the gesture's.
      const base = apply(gestureBase);
      const next = apply(project);
      if (base === gestureBase && next === project) return;
      coalescing = null;
      set({ project: next, gestureBase: base, past: [...past.slice(-HISTORY_LIMIT + 1), { project: gestureBase, label }], future: [], saveState: 'unsaved' });
      pruneSelection();
      return;
    }
    const next = apply(project);
    if (next === project) return;
    // Locked tracks are protected here, whatever the edit came from (inspector, tools, shortcuts).
    const locked = lockedTrackTouched(project, next);
    if (locked) {
      get().toast({ kind: 'warning', message: `“${locked}” is locked. Unlock the track to change its clips.` });
      return;
    }
    const now = Date.now();
    const merge = !!opts.coalesce && coalescing?.key === opts.coalesce && now - coalescing.at < COALESCE_MS && past.length > 0;
    coalescing = opts.coalesce ? { key: opts.coalesce, at: now } : null;
    set({
      project: next,
      past: merge ? past : [...past.slice(-HISTORY_LIMIT + 1), { project, label }],
      future: [],
      lastLabel: label,
      saveState: 'unsaved',
    });
    pruneSelection();
  },

  silent(recipe) {
    const { project, past, future, gestureBase } = get();
    const next = produce(project, recipe);
    if (next === project) return;
    // New assets (imports) join every snapshot and metadata updates reach the snapshots that
    // have the asset; nothing is deleted from history here.
    const before = project.assets;
    const changed = Object.keys(next.assets).filter((id) => next.assets[id] !== before[id]);
    const patch = (p: Project) =>
      changed.length === 0
        ? p
        : produce(p, (d) => {
            for (const id of changed) if (!before[id] || d.assets[id]) d.assets[id] = next.assets[id] as Asset;
          });
    set({
      project: next,
      gestureBase: gestureBase ? patch(gestureBase) : null,
      past: past.map((e) => ({ ...e, project: patch(e.project) })),
      future: future.map((e) => ({ ...e, project: patch(e.project) })),
      saveState: 'unsaved',
    });
  },

  beginGesture(label) {
    const { gestureBase, gestureLabel } = get();
    if (gestureBase && gestureLabel === label) return; // re-entrant (key repeat)
    // A gesture left open by a lost pointer must not swallow the next one.
    if (gestureBase) get().endGesture();
    coalescing = null;
    set({ gestureBase: get().project, gestureLabel: label });
  },

  updateGesture(recipe) {
    const base = get().gestureBase;
    if (!base) return;
    const next = produce(base, (d) => {
      recipe(d);
      normalize(d);
      d.updatedAt = Date.now();
    });
    const locked = lockedTrackTouched(base, next);
    if (locked) {
      get().toast({ kind: 'warning', message: `“${locked}” is locked. Unlock the track to change its clips.` });
      return;
    }
    set({ project: next, saveState: 'unsaved' });
  },

  endGesture() {
    const { gestureBase, project, past, gestureLabel } = get();
    if (!gestureBase) return;
    if (project === gestureBase) {
      set({ gestureBase: null });
      return;
    }
    set({
      gestureBase: null,
      past: [...past.slice(-HISTORY_LIMIT + 1), { project: gestureBase, label: gestureLabel }],
      future: [],
      lastLabel: gestureLabel,
      saveState: 'unsaved',
    });
    pruneSelection();
  },

  cancelGesture() {
    const { gestureBase } = get();
    if (!gestureBase) return;
    set({ project: gestureBase, gestureBase: null });
  },

  undo() {
    if (get().gestureBase) get().endGesture();
    coalescing = null;
    const { past, future, project } = get();
    if (past.length === 0) return;
    const entry = past[past.length - 1];
    set({
      project: restoreAssets(entry.project, project),
      past: past.slice(0, -1),
      future: [{ project, label: entry.label }, ...future],
      lastLabel: entry.label,
      saveState: 'unsaved',
    });
    pruneSelection();
  },

  redo() {
    if (get().gestureBase) get().endGesture();
    coalescing = null;
    const { past, future, project } = get();
    if (future.length === 0) return;
    const entry = future[0];
    set({
      project: restoreAssets(entry.project, project),
      past: [...past, { project, label: entry.label }],
      future: future.slice(1),
      lastLabel: entry.label,
      saveState: 'unsaved',
    });
    pruneSelection();
  },

  select(ids, opts = {}) {
    const cur = get().selection;
    let next: string[];
    if (opts.toggle) {
      const s = new Set(cur);
      for (const id of ids) {
        if (s.has(id)) s.delete(id);
        else s.add(id);
      }
      next = [...s];
    } else if (opts.add) {
      next = [...new Set([...cur, ...ids])];
    } else {
      next = ids;
    }
    // Working on the timeline again: the program view comes back from any source preview.
    set({ selection: next, selectedKeyframe: null, selectedTransition: null, cropMode: false, sourcePreview: null });
  },

  set(key, value) {
    set({ [key]: value } as Partial<EditorState>);
  },

  toast(t) {
    // The same message already on screen isn't repeated (e.g. typing into a locked clip).
    const same = get().toasts.find((x) => x.message === t.message);
    if (same) return same.id;
    const id = toastSeq++;
    const timeout = t.timeout ?? (t.kind === 'error' ? 8000 : 4000);
    set({ toasts: [...get().toasts.slice(-4), { ...t, id, timeout }] });
    if (timeout > 0) setTimeout(() => get().dismissToast(id), timeout);
    return id;
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

/** Drop selected ids that no longer exist. */
function pruneSelection() {
  const s = useEditor.getState();
  const sel = s.selection.filter((id) => s.project.clips[id]);
  const patch: Partial<EditorState> = {};
  if (sel.length !== s.selection.length) patch.selection = sel;
  if (s.selectedKeyframe && !s.project.clips[s.selectedKeyframe.clipId]) patch.selectedKeyframe = null;
  if (s.selectedTransition && !s.project.clips[s.selectedTransition]) patch.selectedTransition = null;
  if (Object.keys(patch).length) useEditor.setState(patch);
}

export const editor = () => useEditor.getState();
export const toast = (t: Parameters<EditorState['toast']>[0]) => useEditor.getState().toast(t);

/* ------------------------------ playback store ----------------------------- */

export interface PlaybackState {
  time: number;
  playing: boolean;
  /** Seconds of audio/video decode underrun in the last second (for a perf hint). */
  dropped: number;
  /** Shuttle speed while playing (1 = normal). */
  rate: number;
  set(p: Partial<Omit<PlaybackState, 'set'>>): void;
}

export const usePlayback = create<PlaybackState>()((set) => ({
  time: 0,
  playing: false,
  dropped: 0,
  rate: 1,
  set: (p) => set(p),
}));
