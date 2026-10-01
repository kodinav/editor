/// <reference types="vite/client" />

// APIs available in workers / Chromium that are missing from the DOM lib.
interface FileSystemSyncAccessHandle {
  read(buffer: AllowSharedBufferSource, options?: { at?: number }): number;
  write(buffer: AllowSharedBufferSource, options?: { at?: number }): number;
  truncate(newSize: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

interface FileSystemFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
}

interface DedicatedWorkerGlobalScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent) => unknown) | null;
  fonts: FontFaceSet;
}

declare module '*.woff2?url' {
  const url: string;
  export default url;
}
