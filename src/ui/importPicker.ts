import { ACCEPT_ATTR } from '@/media/probe';
import { importFiles, type ImportOptions } from '@/state/importer';

/** Open the OS file picker and import the chosen files. */
export function openImportPicker(opts: ImportOptions = {}, accept = ACCEPT_ATTR, multiple = true): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = multiple;
  input.accept = accept;
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const files = [...(input.files ?? [])];
    input.remove();
    if (files.length) void importFiles(files, opts);
  });
  document.body.appendChild(input);
  input.click();
}

/** Pick a single file and hand it back (e.g. for relinking). */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve(input.files?.[0] ?? null);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve(null);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}
