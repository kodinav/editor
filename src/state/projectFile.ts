import { uid } from '@/core/ids';
import { parseProject, ProjectValidationError } from '@/core/schema';
import type { Project } from '@/core/types';
import { media } from '@/media/registry';
import { saveProject } from '@/storage/db';
import { DIRS, getFileHandle } from '@/storage/opfs';
import { readZip, ZipError, ZipWriter } from '@/storage/zip';
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
  const parts: (Blob | Uint8Array<ArrayBuffer>)[] = [];
  const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
  if (picker && includeMedia) {
    try {
      const handle = await picker({ suggestedName: fileName, types: [{ description: 'Cutline project', accept: { 'application/zip': ['.cutline'] } }] });
      writable = await handle.createWritable();
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return;
    }
  }

  try {
    // Without a file handle the parts are Blobs (media files are referenced, not copied).
    const zip = new ZipWriter(async (part) => {
      if (writable) await writable.write(part);
      else parts.push(part);
    });
    const doc = { format: 'cutline-project', version: 1, includesMedia: includeMedia, project: p };
    await zip.add(MANIFEST, new TextEncoder().encode(JSON.stringify(doc)));
    if (includeMedia) {
      for (const a of Object.values(p.assets)) {
        const f = media.getFile(a.id);
        if (!f) missing.push(a.name);
        else await zip.add(`media/${a.id}`, f);
      }
    }
    await zip.finish();
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
  const idMap = new Map<string, string>();
  try {
    const entries = await readZip(file);
    // Packages re-zipped by hand may be wrapped in one folder (plus macOS metadata).
    const named = entries
      .filter((e) => !e.name.startsWith('__MACOSX/'))
      .map((e) => ({ e, name: e.name.replace(/^[^/]+\/(?=(?:project\.json|media\/[^/]+)$)/, '') }));
    const manifest = named.find((x) => x.name === MANIFEST);
    if (!manifest) throw new ProjectValidationError('This file does not contain a Cutline project.');
    const doc = JSON.parse(await manifest.e.text()) as { format?: string; project?: unknown };
    if (doc.format !== 'cutline-project' || !doc.project) throw new ProjectValidationError('This file is not a Cutline project.');
    const parsed = parseProject(doc.project);
    for (const { e, name } of named) {
      const m = /^media\/([\w-]{1,64})$/.exec(name);
      if (!m || !parsed.assets[m[1]]) continue; // ignore unexpected entries
      const newId = uid('ast');
      const handle = await getFileHandle(DIRS.media, newId, true);
      if (!handle) throw new Error('Local storage is not available, so media can’t be unpacked.');
      const w = await handle.createWritable();
      try {
        await e.stream().pipeTo(w);
      } catch (err) {
        await w.abort().catch(() => {});
        throw err;
      }
      idMap.set(m[1], newId);
    }
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
    const msg = e instanceof ProjectValidationError || e instanceof SyntaxError || e instanceof ZipError ? e.message : String((e as Error).message ?? e);
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
