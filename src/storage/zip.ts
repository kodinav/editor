/**
 * Minimal ZIP support for .cutline packages.
 *
 * Writing: entries are stored (media is already compressed) with exact sizes
 * and a CRC-32; ZIP64 records are added when an entry or the archive passes
 * 4 GB. Entry data is passed as Blobs, so multi-GB media is streamed, never
 * copied into memory.
 *
 * Reading: entries are located through the central directory (as unzip tools
 * do), not by scanning for signatures, so binary media that happens to contain
 * ZIP signature bytes can't cut an entry short. Stored and deflated entries
 * are supported.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

async function crcOf(blob: Blob, onBytes?: (n: number) => void): Promise<number> {
  let crc = 0;
  const reader = blob.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return crc;
    crc = crc32(value, crc);
    onBytes?.(value.length);
  }
}

const U32 = 0xffffffff;

class Bytes {
  private b: Uint8Array<ArrayBuffer>;
  private v: DataView;
  private o = 0;
  constructor(n: number) {
    this.b = new Uint8Array(n);
    this.v = new DataView(this.b.buffer);
  }
  u16(x: number) {
    this.v.setUint16(this.o, x, true);
    this.o += 2;
    return this;
  }
  u32(x: number) {
    this.v.setUint32(this.o, x >>> 0, true);
    this.o += 4;
    return this;
  }
  u64(x: number) {
    this.v.setUint32(this.o, x % 0x100000000, true);
    this.v.setUint32(this.o + 4, Math.floor(x / 0x100000000), true);
    this.o += 8;
    return this;
  }
  raw(x: Uint8Array) {
    this.b.set(x, this.o);
    this.o += x.length;
    return this;
  }
  get bytes(): Uint8Array<ArrayBuffer> {
    return this.b;
  }
}

interface Written {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
}

export type ZipSink = (part: Blob | Uint8Array<ArrayBuffer>) => Promise<void>;

export class ZipWriter {
  private offset = 0;
  private entries: Written[] = [];

  /** `zip64At` lowers the ZIP64 threshold (tests only). */
  constructor(
    private readonly sink: ZipSink,
    private readonly zip64At = U32,
  ) {}

  private async put(part: Blob | Uint8Array<ArrayBuffer>) {
    await this.sink(part);
    this.offset += part instanceof Blob ? part.size : part.length;
  }

  /** Add a stored entry. `onBytes` reports progress while the checksum is computed. */
  async add(name: string, data: Blob | Uint8Array<ArrayBuffer>, onBytes?: (n: number) => void): Promise<void> {
    const blob = data instanceof Blob ? data : new Blob([data]);
    const crc = await crcOf(blob, onBytes);
    const nameBytes = new TextEncoder().encode(name);
    const size = blob.size;
    const offset = this.offset;
    const big = size >= this.zip64At;
    const header = new Bytes(30 + nameBytes.length + (big ? 20 : 0))
      .u32(0x04034b50)
      .u16(big ? 45 : 20)
      .u16(0x0800) // UTF-8 names
      .u16(0) // stored
      .u16(0)
      .u16(0x21) // 1980-01-01
      .u32(crc)
      .u32(big ? U32 : size)
      .u32(big ? U32 : size)
      .u16(nameBytes.length)
      .u16(big ? 20 : 0)
      .raw(nameBytes);
    if (big) header.u16(0x0001).u16(16).u64(size).u64(size);
    await this.put(header.bytes);
    await this.put(blob);
    this.entries.push({ name: nameBytes, crc, size, offset });
  }

  async finish(): Promise<void> {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const bigSize = e.size >= this.zip64At;
      const bigOff = e.offset >= this.zip64At;
      const extraLen = bigSize || bigOff ? 4 + (bigSize ? 16 : 0) + (bigOff ? 8 : 0) : 0;
      const h = new Bytes(46 + e.name.length + extraLen)
        .u32(0x02014b50)
        .u16(45)
        .u16(extraLen ? 45 : 20)
        .u16(0x0800)
        .u16(0)
        .u16(0)
        .u16(0x21)
        .u32(e.crc)
        .u32(bigSize ? U32 : e.size)
        .u32(bigSize ? U32 : e.size)
        .u16(e.name.length)
        .u16(extraLen)
        .u16(0)
        .u16(0)
        .u16(0)
        .u32(0)
        .u32(bigOff ? U32 : e.offset)
        .raw(e.name);
      if (extraLen) {
        h.u16(0x0001).u16(extraLen - 4);
        if (bigSize) h.u64(e.size).u64(e.size);
        if (bigOff) h.u64(e.offset);
      }
      await this.put(h.bytes);
    }
    const cdSize = this.offset - cdStart;
    const n = this.entries.length;
    if (cdStart >= this.zip64At || cdSize >= this.zip64At || n >= 0xffff) {
      const z64 = this.offset;
      await this.put(new Bytes(56).u32(0x06064b50).u64(44).u16(45).u16(45).u32(0).u32(0).u64(n).u64(n).u64(cdSize).u64(cdStart).bytes);
      await this.put(new Bytes(20).u32(0x07064b50).u32(0).u64(z64).u32(1).bytes);
    }
    await this.put(
      new Bytes(22)
        .u32(0x06054b50)
        .u16(0)
        .u16(0)
        .u16(Math.min(n, 0xffff))
        .u16(Math.min(n, 0xffff))
        .u32(Math.min(cdSize, U32))
        .u32(Math.min(cdStart, U32))
        .u16(0).bytes,
    );
  }
}

export interface ZipEntry {
  name: string;
  /** Uncompressed size. */
  size: number;
  /** The entry's bytes, decompressed if needed. */
  stream(): ReadableStream<Uint8Array>;
  text(): Promise<string>;
}

export class ZipError extends Error {}

async function read(file: Blob, start: number, len: number): Promise<DataView> {
  return new DataView(await file.slice(start, start + len).arrayBuffer());
}

const u64 = (v: DataView, o: number) => v.getUint32(o, true) + v.getUint32(o + 4, true) * 0x100000000;

/** List the entries of a ZIP file using its central directory. */
export async function readZip(file: Blob): Promise<ZipEntry[]> {
  const tailLen = Math.min(file.size, 22 + 0xffff + 20);
  const tail = await read(file, file.size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('The file is not a valid project package (no ZIP directory found). It may be incomplete.');
  let count = tail.getUint16(eocd + 10, true);
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdStart = tail.getUint32(eocd + 16, true);
  if (eocd >= 20 && tail.getUint32(eocd - 20, true) === 0x07064b50) {
    const z = await read(file, u64(tail, eocd - 12), 56);
    if (z.getUint32(0, true) !== 0x06064b50) throw new ZipError('The package directory is damaged.');
    count = u64(z, 32);
    cdSize = u64(z, 40);
    cdStart = u64(z, 48);
  }
  if (cdStart + cdSize > file.size) throw new ZipError('The package is incomplete (it may not have finished downloading).');
  const cd = await read(file, cdStart, cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cdSize || cd.getUint32(p, true) !== 0x02014b50) throw new ZipError('The package directory is damaged.');
    const method = cd.getUint16(p + 10, true);
    let compSize = cd.getUint32(p + 20, true);
    let size = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    let local = cd.getUint32(p + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(cd.buffer, p + 46, nameLen));
    // ZIP64 extended information: only the fields that overflowed are present, in this order.
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = cd.getUint16(e, true);
      const len = cd.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === U32) (size = u64(cd, q)), (q += 8);
        if (compSize === U32) (compSize = u64(cd, q)), (q += 8);
        if (local === U32) local = u64(cd, q);
      }
      e += 4 + len;
    }
    p = extraEnd + commentLen;
    if (method !== 0 && method !== 8) {
      entries.push(unsupported(name, size));
      continue;
    }
    entries.push(entry(file, name, method, local, compSize, size));
  }
  return entries;
}

function unsupported(name: string, size: number): ZipEntry {
  const fail = () => {
    throw new ZipError('The package uses a compression method Cutline can’t read. Save the project from Cutline again.');
  };
  return { name, size, stream: fail, text: fail };
}

function entry(file: Blob, name: string, method: number, local: number, compSize: number, size: number): ZipEntry {
  let start: Promise<number> | null = null;
  const dataStart = () =>
    (start ??= read(file, local, 30).then((h) => {
      if (h.getUint32(0, true) !== 0x04034b50) throw new ZipError('The package is damaged.');
      return local + 30 + h.getUint16(26, true) + h.getUint16(28, true);
    }));
  const stream = (): ReadableStream<Uint8Array> => {
    let inner: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let seen = 0;
    return new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        if (!inner) {
          const s = await dataStart();
          if (s + compSize > file.size) throw new ZipError(`“${name}” is cut short in the package. The file may be incomplete.`);
          const raw = file.slice(s, s + compSize).stream();
          inner = (method === 8 ? raw.pipeThrough(new DecompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>) : raw).getReader();
        }
        const { done, value } = await inner.read();
        if (done) {
          if (seen !== size) throw new ZipError(`“${name}” is damaged in the package (${seen} of ${size} bytes).`);
          ctrl.close();
          return;
        }
        seen += value.length;
        ctrl.enqueue(value);
      },
      cancel() {
        void inner?.cancel();
      },
    });
  };
  return {
    name,
    size,
    stream,
    async text() {
      return new Response(stream()).text();
    },
  };
}
