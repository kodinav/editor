import { produce } from 'immer';
import { uid } from '@/core/ids';
import { createProject, projectDuration } from '@/core/project';
import { migrateProject } from '@/core/schema';
import { PROJECT_SCHEMA_VERSION, type Project, type ProjectSettings } from '@/core/types';
import { analysis } from '@/media/analysis';
import { customFontFamilies, registerCustomFont, unregisterCustomFont } from '@/engine/fonts';
import { media } from '@/media/registry';
import { player } from '@/playback/player';
import {
  allProjects,
  getProjectMeta,
  deleteDerived,
  deleteProjectRecord,
  kvGet,
  kvSet,
  listProjects,
  loadProject,
  putPeaks,
  saveProject,
  type ProjectMeta,
} from '@/storage/db';
import { deleteFile, DIRS, getFile, listFiles, opfsUsable, requestPersistence } from '@/storage/opfs';
import { restoreNoiseReduction } from './denoiseTools';
import { audioUnusable } from './importer';
import { editor, toast, useEditor, usePlayback } from './store';

/**
 * Project lifecycle: open/create/duplicate/delete, autosave with crash
 * recovery, cross-tab locking, and garbage collection of orphaned media.
 */

const LAST_PROJECT_KEY = 'lastProjectId';
const SAVE_DEBOUNCE = 700;

let saveTimer: number | null = null;
let saving: Promise<void> | null = null;
let lastThumbAt = 0;
let releaseLock: (() => void) | null = null;

export function projectMeta(p: Project, thumbnail?: Blob): ProjectMeta {
  return {
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    duration: projectDuration(p),
    width: p.settings.width,
    height: p.settings.height,
    thumbnail,
  };
}

async function writeNow(): Promise<void> {
  const s = editor();
  if (s.readOnlyReason) return;
  // Always the state on screen, including an edit that's still in progress.
  const p = s.project;
  let thumb: Blob | undefined;
  if (Date.now() - lastThumbAt > 15000 && Object.keys(p.clips).length > 0) {
    lastThumbAt = Date.now();
    thumb = (await player.snapshot().catch(() => null)) ?? undefined;
  }
  if (!thumb) thumb = (await getProjectMeta(p.id).catch(() => undefined))?.thumbnail;
  useEditor.setState({ saveState: 'saving' });
  try {
    await saveProject(p, projectMeta(p, thumb));
    if (import.meta.env.DEV) assertReloadsUnchanged(p);
    await kvSet(LAST_PROJECT_KEY, p.id);
    if (editor().project === p) useEditor.setState({ saveState: 'saved' });
    else useEditor.setState({ saveState: 'unsaved' });
  } catch (e) {
    console.error('Save failed', e);
    useEditor.setState({ saveState: 'error' });
    toast({ kind: 'error', message: 'Could not save your project locally.', detail: String((e as Error).message ?? e) });
  }
}

/**
 * Development safety net: everything the app saves must load back unchanged
 * through the repair pass in core/sanitize.ts (a mismatch fails the E2E run).
 */
function assertReloadsUnchanged(p: Project) {
  const saved = JSON.parse(JSON.stringify(p));
  const where = firstDifference(saved, JSON.parse(JSON.stringify(migrateProject(JSON.parse(JSON.stringify(p))))));
  if (where !== null) {
    setTimeout(() => {
      throw new Error(`A saved project would change when reopened (at ${where || 'root'}).`);
    });
  }
}

function firstDifference(a: unknown, b: unknown, path = ''): string | null {
  if (a === b) return null;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return path;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const d = firstDifference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
    if (d !== null) return d;
  }
  return null;
}

export function saveSoon() {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void flushSave();
  }, SAVE_DEBOUNCE);
}

export async function flushSave(): Promise<void> {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  while (saving) await saving;
  if (editor().saveState === 'saved') return;
  saving = writeNow().finally(() => (saving = null));
  await saving;
}

/** Keep the registered custom fonts equal to the open project's font assets (preview = export). */
function syncFonts(p: Project) {
  const want = new Map<string, string>();
  for (const a of Object.values(p.assets)) if (a.kind === 'font' && a.font) want.set(a.font.family, a.id);
  for (const f of customFontFamilies()) if (!want.has(f)) unregisterCustomFont(f);
  const have = new Set(customFontFamilies());
  for (const [family, id] of want) {
    const file = have.has(family) ? null : media.getFile(id);
    if (file) void file.arrayBuffer().then((buf) => registerCustomFont(family, buf)).catch(() => {});
  }
}

function startAutosave() {
  useEditor.subscribe((s, prev) => {
    if (s.project.assets !== prev.project.assets) syncFonts(s.project);
    if (s.project !== prev.project && s.project.id === prev.project.id) saveSoon();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushSave();
  });
  window.addEventListener('pagehide', () => void flushSave());
  window.addEventListener('beforeunload', (e) => {
    void flushSave();
    const busy = Object.values(editor().project.assets).some((a) => a.status === 'processing' || (!a.stored && a.status === 'ready' && media.getProgress(a.id)));
    if (busy) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

/*
 * Cross-tab editing lock (Web Locks). One tab edits a project; another tab
 * opening it is read-only and waits in line. "Edit here instead" steals the
 * lock; the tab that loses it goes read-only immediately, so the two never
 * save over each other. Whoever takes over reloads the latest saved version.
 */
const READ_ONLY_OTHER_TAB = 'This project is open in another tab. Changes here will not be saved.';
const READ_ONLY_TAKEN = 'This project is now being edited in another tab. Changes here will not be saved.';
let lockGen = 0;
let lockWait: AbortController | null = null;

function lockName(id: string) {
  return `cutline-project-${id}`;
}

/** Hold the lock for `id` (or steal it). Resolves true once held, false if another tab has it. */
function holdLock(id: string, steal = false): Promise<boolean> {
  releaseLock?.();
  releaseLock = null;
  lockWait?.abort();
  lockWait = null;
  if (!('locks' in navigator)) return Promise.resolve(true);
  const gen = ++lockGen;
  return new Promise<boolean>((resolve) => {
    navigator.locks
      .request(lockName(id), steal ? { steal: true } : { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          waitForLock(id, gen);
          return undefined;
        }
        resolve(true);
        return new Promise<void>((release) => (releaseLock = release));
      })
      .catch(() => {
        // Another tab stole the lock we held.
        resolve(false);
        if (gen !== lockGen || editor().project.id !== id) return;
        releaseLock = null;
        if (saveTimer !== null) clearTimeout(saveTimer);
        saveTimer = null;
        useEditor.setState({ readOnlyReason: READ_ONLY_TAKEN });
        waitForLock(id, gen);
      });
  });
}

/** Queue for the lock; when the other tab lets go, continue here from the latest saved version. */
function waitForLock(id: string, gen: number) {
  lockWait?.abort();
  const ac = new AbortController();
  lockWait = ac;
  navigator.locks
    .request(lockName(id), { signal: ac.signal }, () => {
      if (gen !== lockGen || editor().project.id !== id) return undefined;
      const held = new Promise<void>((release) => (releaseLock = release));
      void continueFromStorage(id);
      return held;
    })
    .catch(() => {});
}

/** Reopen the latest saved version of `id` while keeping the lock this tab now holds. */
async function continueFromStorage(id: string) {
  const latest = await loadProject(id).catch(() => undefined);
  if (editor().project.id !== id) return;
  if (latest) await openProject(latest, { keepLock: true });
  else useEditor.setState({ readOnlyReason: null });
}

/** Take over a project that is open in another tab. */
export async function stealLock(): Promise<void> {
  const id = editor().project.id;
  await holdLock(id, true);
  await continueFromStorage(id);
}

/** Re-run analysis for assets whose conformed audio/thumbnails are missing. */
function repairDerivedData(ids: string[]) {
  for (const id of ids) {
    const a = editor().project.assets[id];
    const file = media.getFile(id);
    if (!a || !file) continue;
    media.setProgress(id, { stage: 'audio', value: 0 });
    analysis
      .analyze(id, file, { copy: false, thumbs: false, audio: true }, (stage, value) => media.setProgress(id, { stage, value }))
      .promise.then(async (res) => {
        if (res.pcm) {
          editor().silent((d) => {
            const x = d.assets[id];
            if (x?.audio) x.audio.conformed = true;
          });
          await media.openPcm(editor().project.assets[id]);
          await restoreNoiseReduction(id, true);
        }
        if (res.peaks) {
          const pk = { assetId: id, rate: res.peaks.rate, data: res.peaks.data };
          await putPeaks(pk);
          media.setPeaks(id, pk);
        }
      })
      .catch((e) => audioUnusable(id, String((e as Error)?.message ?? e)))
      .finally(() => media.setProgress(id, null));
  }
}

export async function openProject(p: Project, opts: { keepLock?: boolean } = {}): Promise<void> {
  if ((p.schemaVersion ?? 0) > PROJECT_SCHEMA_VERSION) {
    // Opening it here would drop whatever the newer version added; leave it untouched.
    toast({ kind: 'error', message: `“${p.name}” was saved by a newer version of Cutline.`, detail: 'Reload the page to update the app, then open it again.', timeout: 0 });
    return;
  }
  await flushSave();
  player.pause();
  media.reset();
  const migrated = migrateProject(p);
  const { missing, needsConform } = await media.attachProject(migrated);
  const fixed = produce(migrated, (d) => {
    for (const a of Object.values(d.assets)) {
      if (missing.includes(a.id)) a.status = 'missing';
      else if (a.status === 'missing' || a.status === 'processing') a.status = 'ready';
    }
  });
  editor().loadProject(fixed);
  usePlayback.getState().set({ time: 0, playing: false });
  const locked = opts.keepLock ? true : await holdLock(fixed.id);
  useEditor.setState({ readOnlyReason: locked ? null : READ_ONLY_OTHER_TAB });
  await kvSet(LAST_PROJECT_KEY, fixed.id);
  if (missing.length > 0) {
    toast({
      kind: 'warning',
      message: `${missing.length} media file${missing.length > 1 ? 's are' : ' is'} offline.`,
      detail: 'Relink them from the Media panel to restore playback.',
      timeout: 8000,
    });
  }
  repairDerivedData(needsConform);
  for (const a of Object.values(fixed.assets)) {
    if (a.audio?.denoise && !missing.includes(a.id) && !needsConform.includes(a.id)) void restoreNoiseReduction(a.id);
  }
  player.requestRender();
}

export async function newProject(settings: Partial<ProjectSettings> = {}, name?: string): Promise<void> {
  const projects = await listProjects();
  const p = createProject(name ?? nextUntitled(projects), settings);
  await openProject(p);
  useEditor.setState({ saveState: 'unsaved' });
  await flushSave();
}

function nextUntitled(list: ProjectMeta[]): string {
  const names = new Set(list.map((m) => m.name));
  if (!names.has('Untitled project')) return 'Untitled project';
  let n = 2;
  while (names.has(`Untitled project ${n}`)) n++;
  return `Untitled project ${n}`;
}

export async function openProjectById(id: string): Promise<void> {
  const p = await loadProject(id);
  if (!p) {
    toast({ kind: 'error', message: 'That project could not be found.' });
    return;
  }
  await openProject(p);
}

export async function duplicateProject(id: string): Promise<void> {
  await flushSave();
  const src = id === editor().project.id ? editor().project : await loadProject(id);
  if (!src) return;
  const copy: Project = { ...structuredClone(src), id: uid('prj'), name: `${src.name} (copy)`, createdAt: Date.now(), updatedAt: Date.now() };
  const meta = (await getProjectMeta(id))?.thumbnail;
  await saveProject(copy, projectMeta(copy, meta));
  toast({ kind: 'success', message: `Duplicated “${src.name}”.` });
}

export async function deleteProject(id: string): Promise<void> {
  await deleteProjectRecord(id);
  if (id === editor().project.id) {
    const rest = await listProjects();
    if (rest.length > 0) await openProjectById(rest[0].id);
    else await newProject();
  }
  void collectGarbage();
}

export function renameProject(name: string) {
  const trimmed = name.trim().slice(0, 120) || 'Untitled project';
  editor().silent((d) => {
    d.name = trimmed;
    d.updatedAt = Date.now();
  });
}

/** Delete OPFS media and derived data no longer referenced by any project. */
export async function collectGarbage(): Promise<void> {
  if (!(await opfsUsable())) return;
  try {
    const projects = await allProjects();
    const referenced = new Set<string>();
    const denoised = new Set<string>();
    for (const p of [...projects, editor().project]) {
      for (const a of Object.values(p.assets)) {
        referenced.add(a.id);
        if (a.audio?.denoise) denoised.add(a.id);
      }
    }
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const name of await listFiles(DIRS.media)) {
      if (referenced.has(name)) continue;
      const f = await getFile(DIRS.media, name);
      if (f && f.lastModified > cutoff) continue;
      await deleteFile(DIRS.media, name);
      await deleteDerived(name);
    }
    for (const name of await listFiles(DIRS.pcm)) {
      // "<id>.pcm", or "<id>.nr.pcm" for the noise-reduced variant.
      const [id, variant] = name.split('.');
      if (variant === 'nr' ? denoised.has(id) : referenced.has(id)) continue;
      const f = await getFile(DIRS.pcm, name);
      if (f && f.lastModified > cutoff) continue;
      await deleteFile(DIRS.pcm, name);
    }
    // Rendered exports are temporary; anything older than a few minutes is left over from an
    // earlier session (or one still downloading right now, which gets those minutes).
    for (const name of await listFiles(DIRS.exports)) {
      const f = await getFile(DIRS.exports, name);
      if (f && f.lastModified < Date.now() - 10 * 60 * 1000) await deleteFile(DIRS.exports, name);
    }
  } catch (e) {
    console.warn('Storage cleanup failed', e);
  }
}

export async function bootstrap(): Promise<void> {
  startAutosave();
  let opened = false;
  try {
    const lastId = await kvGet<string>(LAST_PROJECT_KEY);
    if (lastId) {
      const p = await loadProject(lastId);
      if (p) {
        await openProject(p);
        opened = editor().project.id === p.id;
      }
    }
    if (!opened) {
      const list = await listProjects();
      if (list.length > 0) {
        await openProjectById(list[0].id);
        opened = true;
      }
    }
  } catch (e) {
    console.error('Could not restore the last project', e);
    toast({ kind: 'error', message: 'Your last project could not be restored.', detail: String((e as Error).message ?? e) });
  }
  if (!opened) await newProject();
  if (!(await opfsUsable())) {
    toast({
      kind: 'warning',
      message: 'Media can’t be stored in this browser window.',
      detail: 'This is common in private browsing. You can edit and export normally, but imported files will need to be re-linked after the window is closed.',
      timeout: 0,
    });
  }
  void requestPersistence();
  setTimeout(() => void collectGarbage(), 5000);
}
