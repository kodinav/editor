import { Unzip, UnzipInflate, UnzipPassThrough, Zip, ZipPassThrough, strToU8, strFromU8 } from 'fflate';
import { uid } from '@/core/ids';
import { parseProject, ProjectValidationError } from '@/core/schema';
import type { Project } from '@/core/types';
import { media } from '@/media/registry';
import { saveProject } from '@/storage/db';
import { DIRS, getFileHandle } from '@/storage/opfs';
import { openProject, projectMeta } from './projectManager';
import { editor, toast } from './store';
import { downloadBlob } from '@/ui/download';

/**
 * Portable project packages (.cutline): a zip with `project.json` and,
 * optionally, the media files. Media is stored uncompressed (it is already
 * compressed) and streamed so large projects don't need to fit in memory.
 */

const MANIFEST = 'project.json';

export async function exportProjectPackage(includeMedia: boolean): Promise<void> {
  const p = editor().project;
  const fileName = `${p.name.replace(/[^\w\- ]+/g, '').trim() || 'project'}.cutline`;
  const missing: string[] = [];

  let writable: FileSystemWritableFileStream | null = null;
  const parts: Uint8Array[] = [];
  const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
  if (picker && includeMedia) {
    try {
      const handle = await picker({ suggestedName: fileName, types: [{ description: 'Cutline project', accept: { 'application/zip': ['.cutline'] } }] });
      writable = await handle.createWritable();
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return;
    }
  }

  let pending: Promise<void> = Promise.resolve();
  let failed: unknown = null;
  const done = new Promise<void>((resolve, reject) => {
    const zip = new Zip((err, chunk, final) => {
      if (err) {
        failed = err;
        reject(err);
        return;
      }
      if (writable) {
        const w = writable;
        pending = pending.then(() => w.write(chunk as Uint8Array<ArrayBuffer>));
      } else parts.push(chunk);
      if (final) pending.then(resolve, reject);
    });
    (async () => {
      const manifest = new ZipPassThrough(MANIFEST);
      zip.add(manifest);
      const doc = { format: 'cutline-project', version: 1, includesMedia: includeMedia, project: p };
      manifest.push(strToU8(JSON.stringify(doc)), true);
      if (includeMedia) {
        for (const a of Object.values(p.assets)) {
          const f = media.getFile(a.id);
          if (!f) {
            missing.push(a.name);
            continue;
          }
          const entry = new ZipPassThrough(`media/${a.id}`);
          zip.add(entry);
          const reader = f.stream().getReader();
          for (;;) {
            if (failed) return;
            const { done: d, value } = await reader.read();
            if (d) break;
            entry.push(value);
            await pending;
          }
          entry.push(new Uint8Array(0), true);
        }
      }
      zip.end();
    })().catch(reject);
  });

  try {
    await done;
    if (writable) await writable.close();
    else downloadBlob(new Blob(parts as BlobPart[], { type: 'application/zip' }), fileName);
    toast({
      kind: missing.length ? 'warning' : 'success',
      message: missing.length ? `Project saved, but ${missing.length} offline file(s) were not included.` : 'Project file saved.',
    });
  } catch (e) {
    await writable?.abort().catch(() => {});
    toast({ kind: 'error', message: 'Could not save the project file.', detail: String((e as Error).message ?? e) });
  }
}


/** Import a .cutline package as a new project (never overwrites an existing one). */
export async function importProjectPackage(file: File): Promise<void> {
  let manifestText = '';
  const writers = new Map<string, Promise<FileSystemWritableFileStream | null>>();
  const writes: Promise<unknown>[] = [];
  const idMap = new Map<string, string>();

  try {
    await new Promise<void>((resolve, reject) => {
      const unzip = new Unzip((entry) => {
        // Packages re-zipped by hand may be compressed and wrapped in one folder (plus macOS metadata).
        if (entry.name.startsWith('__MACOSX/')) return;
        const name = entry.name.replace(/^[^/]+\/(?=(?:project\.json|media\/[^/]+)$)/, '');
        if (name === MANIFEST) {
          const chunks: Uint8Array[] = [];
          entry.ondata = (err, data, final) => {
            if (err) return reject(err);
            chunks.push(data);
            if (final) {
              const total = chunks.reduce((n, c) => n + c.length, 0);
              const all = new Uint8Array(total);
              let o = 0;
              for (const c of chunks) {
                all.set(c, o);
                o += c.length;
              }
              manifestText = strFromU8(all);
            }
          };
          entry.start();
          return;
        }
        const m = /^media\/([\w-]{1,64})$/.exec(name);
        if (!m) return; // ignore unexpected entries
        const oldId = m[1];
        const newId = uid('ast');
        idMap.set(oldId, newId);
        const w = getFileHandle(DIRS.media, newId, true).then((h) => (h ? h.createWritable() : null));
        writers.set(oldId, w);
        let chain: Promise<unknown> = w;
        entry.ondata = (err, data, final) => {
          if (err) return reject(err);
          chain = chain.then(async () => {
            const ws = await w;
            if (!ws) return;
            if (data.length) await ws.write(data as Uint8Array<ArrayBuffer>);
            if (final) await ws.close();
          });
          if (final) writes.push(chain);
        };
        entry.start();
      });
      unzip.register(UnzipPassThrough);
      unzip.register(UnzipInflate);
      const reader = file.stream().getReader();
      (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            unzip.push(new Uint8Array(0), true);
            break;
          }
          unzip.push(value);
        }
        await Promise.all(writes);
        resolve();
      })().catch(reject);
    });

    if (!manifestText) throw new ProjectValidationError('This file does not contain a Cutline project.');
    const doc = JSON.parse(manifestText) as { format?: string; project?: unknown };
    if (doc.format !== 'cutline-project' || !doc.project) throw new ProjectValidationError('This file is not a Cutline project.');
    const parsed = parseProject(doc.project);
    const project = remapIds(parsed, idMap);
    await saveProject(project, projectMeta(project));
    await openProject(project);
    // Damaged entries are dropped by the repair pass; say so rather than losing them silently.
    const given = doc.project as { clips?: object; assets?: object };
    const dropped = Object.keys(given.clips ?? {}).length - Object.keys(parsed.clips).length + (Object.keys(given.assets ?? {}).length - Object.keys(parsed.assets).length);
    if (dropped > 0) {
      toast({
        kind: 'warning',
        message: `Opened “${project.name}”, but ${dropped} damaged item${dropped > 1 ? 's' : ''} couldn’t be restored.`,
        detail: 'The rest of the project was recovered. Check the timeline before exporting.',
        timeout: 10000,
      });
    } else {
      toast({ kind: 'success', message: `Opened “${project.name}”.` });
    }
  } catch (e) {
    const raw = String((e as Error).message ?? e);
    const msg =
      e instanceof ProjectValidationError || e instanceof SyntaxError
        ? e.message
        : /compression type|invalid zip|unexpected EOF/i.test(raw)
          ? 'The file is damaged or uses a compression method Cutline can’t read. Save the project from Cutline again.'
          : raw;
    toast({ kind: 'error', message: 'Could not open the project file.', detail: msg });
  }
}

function remapIds(p: Project, assetMap: Map<string, string>): Project {
  const out: Project = structuredClone(p);
  out.id = uid('prj');
  out.name = p.name;
  out.createdAt = Date.now();
  out.updatedAt = Date.now();
  const assets: Project['assets'] = {};
  for (const [oldId, a] of Object.entries(p.assets)) {
    const newId = assetMap.get(oldId);
    const id = newId ?? uid('ast');
    assets[id] = {
      ...a,
      id,
      stored: !!newId,
      status: newId ? 'ready' : 'missing',
      audio: a.audio ? { ...a.audio, conformed: false } : undefined,
    };
    assetMap.set(oldId, id);
  }
  out.assets = assets;
  for (const c of Object.values(out.clips)) {
    if ('assetId' in c) c.assetId = assetMap.get(c.assetId) ?? c.assetId;
  }
  return out;
}
