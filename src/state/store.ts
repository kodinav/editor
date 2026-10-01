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
  loop: boolean;
  /** True when the open project failed to acquire the cross-tab lock. */
  readOnlyReason: string | null;

  /* actions */
  loadProject(p: Project): void;
  commit(label: string, recipe: (draft: Project) => void): void;
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

/** Undo/redo swap clips/tracks/settings but never lose asset metadata (imports aren't undoable). */
function restoreKeepingAssets(snapshot: Project, current: Project): Project {
  return produce(snapshot, (d) => {
    const merged: Record<string, Asset> = { ...current.assets };
    for (const c of Object.values(d.clips)) {
      if ('assetId' in c && !merged[c.assetId] && snapshot.assets[c.assetId]) merged[c.assetId] = snapshot.assets[c.assetId];
    }
    d.assets = merged as typeof d.assets;
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
  loop: false,
  readOnlyReason: null,

  loadProject(p) {
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

  commit(label, recipe) {
    const { project, past, gestureBase } = get();
    if (gestureBase) {
      // Edits during a gesture fold into it.
      get().updateGesture(recipe);
      return;
    }
    const next = produce(project, (d) => {
      recipe(d);
      normalize(d);
      d.updatedAt = Date.now();
    });
    if (next === project) return;
    set({
      project: next,
      past: [...past.slice(-HISTORY_LIMIT + 1), { project, label }],
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
    // Keep asset changes visible across history too.
    const patch = (p: Project) => produce(p, (d) => void (d.assets = next.assets as typeof d.assets));
    set({
      project: next,
      gestureBase: gestureBase ? patch(gestureBase) : null,
      past: past.map((e) => ({ ...e, project: patch(e.project) })),
      future: future.map((e) => ({ ...e, project: patch(e.project) })),
      saveState: 'unsaved',
    });
  },

  beginGesture(label) {
    if (get().gestureBase) return;
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
    set({ project: next });
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
    const { past, future, project, gestureBase } = get();
    if (gestureBase || past.length === 0) return;
    const entry = past[past.length - 1];
    set({
      project: restoreKeepingAssets(entry.project, project),
      past: past.slice(0, -1),
      future: [{ project, label: entry.label }, ...future],
      lastLabel: entry.label,
      saveState: 'unsaved',
    });
    pruneSelection();
  },

  redo() {
    const { past, future, project, gestureBase } = get();
    if (gestureBase || future.length === 0) return;
    const entry = future[0];
    set({
      project: restoreKeepingAssets(entry.project, project),
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
    set({ selection: next, selectedKeyframe: null, selectedTransition: null, cropMode: false });
  },

  set(key, value) {
    set({ [key]: value } as Partial<EditorState>);
  },

  toast(t) {
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
  set(p: Partial<Omit<PlaybackState, 'set'>>): void;
}

export const usePlayback = create<PlaybackState>()((set) => ({
  time: 0,
  playing: false,
  dropped: 0,
  set: (p) => set(p),
}));
