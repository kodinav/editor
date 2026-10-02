import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { crc32, readZip, ZipWriter } from '../../src/storage/zip';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s >>> 24;
  };
}

/** Random "media" that contains every ZIP signature (these used to cut entries short). */
function media(n: number, seed: number) {
  const r = rng(seed);
  const b = new Uint8Array(n).map(() => r());
  const sigs = [
    [0x50, 0x4b, 0x03, 0x04],
    [0x50, 0x4b, 0x07, 0x08],
    [0x50, 0x4b, 0x01, 0x02],
    [0x50, 0x4b, 0x05, 0x06],
  ];
  sigs.forEach((sig, i) => b.set(sig, Math.floor((n * (i + 1)) / 5)));
  return b;
}

async function write(entries: [string, Uint8Array<ArrayBuffer>][], zip64At?: number): Promise<Blob> {
  const parts: (Blob | Uint8Array<ArrayBuffer>)[] = [];
  const z = new ZipWriter(async (p) => void parts.push(p), zip64At);
  for (const [name, data] of entries) await z.add(name, new Blob([data]));
  await z.finish();
  return new Blob(parts as BlobPart[]);
}

async function bytes(s: ReadableStream<Uint8Array>) {
  return new Uint8Array(await new Response(s).arrayBuffer());
}

function tmp(blob: Uint8Array) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cutline-zip-')), 'p.zip');
  fs.writeFileSync(f, blob);
  return f;
}

describe('zip', () => {
  it('computes standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  for (const zip64 of [false, true]) {
    it(`round-trips binary media exactly${zip64 ? ' with ZIP64 records' : ''}, and other tools accept it`, async () => {
      const a = media(300_000, 1);
      const b = media(70_001, 2);
      const blob = await write(
        [
          ['project.json', new TextEncoder().encode('{"x":1}')],
          ['media/a', a],
          ['media/ü', b],
        ],
        zip64 ? 0 : undefined,
      );
      const entries = await readZip(blob);
      expect(entries.map((e) => e.name)).toEqual(['project.json', 'media/a', 'media/ü']);
      expect(await entries[0].text()).toBe('{"x":1}');
      expect(await bytes(entries[1].stream())).toEqual(a);
      expect(await bytes(entries[2].stream())).toEqual(b);
      // The system unzip checks structure and every CRC.
      const out = execFileSync('unzip', ['-t', tmp(new Uint8Array(await blob.arrayBuffer()))]).toString();
      expect(out).toMatch(/No errors detected/);
    });
  }

  it('reads deflated packages re-zipped by other tools', async () => {
    const a = media(50_000, 3);
    const z = zipSync({ 'My project/project.json': strToU8('{"y":2}'), 'My project/media/a': a }, { level: 6 });
    const entries = await readZip(new Blob([z]));
    expect(await entries[0].text()).toBe('{"y":2}');
    expect(await bytes(entries[1].stream())).toEqual(a);
  });

  it('reads ZIP64 archives made by other tools', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutline-zip64-'));
    fs.writeFileSync(path.join(dir, 'm.bin'), media(10_000, 4));
    execFileSync('zip', ['-q', '-fz', '-0', 'out.zip', 'm.bin'], { cwd: dir });
    const entries = await readZip(new Blob([fs.readFileSync(path.join(dir, 'out.zip'))]));
    expect(entries[0].name).toBe('m.bin');
    expect(await bytes(entries[0].stream())).toEqual(media(10_000, 4));
  });

  it('reports truncated packages instead of returning short data', async () => {
    const blob = await write([['media/a', media(100_000, 5)]]);
    await expect(readZip(blob.slice(0, 60_000))).rejects.toThrow(/not a valid project package|incomplete/);
  });
});
