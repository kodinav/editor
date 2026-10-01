import { describe, expect, it } from 'vitest';
import { BufferTarget, EncodedAudioPacketSource, EncodedPacket, Output, WebMOutputFormat } from 'mediabunny';
import { findLag } from '../../src/export/encoderDelay';
import { opusCodecDelayPatch } from '../../src/export/webmCodecDelay';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

describe('encoder delay measurement', () => {
  const r = rng(7);
  const sig = new Float32Array(1024).map(() => r());

  it('finds where the probe landed, even under coding noise', () => {
    for (const lag of [0, 1, 2112, 1105, -300]) {
      const y = new Float32Array(16384).map(() => r() * 0.05);
      for (let i = 0; i < sig.length; i++) y[4096 + lag + i] += sig[i];
      expect(findLag(sig, y, 4096)).toBe(lag);
    }
  });

  it('refuses to guess when the probe is not there', () => {
    const y = new Float32Array(16384).map(() => r());
    expect(findLag(sig, y, 4096)).toBeNull();
    expect(findLag(sig, new Float32Array(16384), 4096)).toBeNull();
  });
});

/** An OpusHead like Chrome's encoder produces (pre-skip 312). */
function opusHead(preSkip = 312) {
  const h = new Uint8Array(19);
  h.set(new TextEncoder().encode('OpusHead'));
  h[8] = 1;
  h[9] = 2;
  h[10] = preSkip & 0xff;
  h[11] = preSkip >> 8;
  new DataView(h.buffer).setUint32(12, 48000, true);
  return h;
}

async function muxOpusWebm(description: Uint8Array): Promise<Uint8Array> {
  const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
  const source = new EncodedAudioPacketSource('opus');
  output.addAudioTrack(source);
  await output.start();
  for (let i = 0; i < 50; i++) {
    const packet = new EncodedPacket(new Uint8Array([0xfc, 0xff, 0xfe]), 'key', i * 0.02, 0.02);
    await source.add(packet, i === 0 ? { decoderConfig: { codec: 'opus', numberOfChannels: 2, sampleRate: 48000, description } } : undefined);
  }
  await output.finalize();
  return new Uint8Array(output.target.buffer!);
}

describe('WebM Opus codec delay', () => {
  it('turns the pre-skip the muxer stores as SeekPreRoll into CodecDelay', async () => {
    const file = await muxOpusWebm(opusHead(312));
    const fix = opusCodecDelayPatch(file);
    expect(fix).not.toBeNull();
    // The element being renamed is SeekPreRoll (0x56BB) holding 6.5 ms in nanoseconds.
    expect([file[fix!.position], file[fix!.position + 1]]).toEqual([0x56, 0xbb]);
    expect(Array.from(file.subarray(fix!.position + 2, fix!.position + 6))).toEqual([0x83, 0x63, 0x2e, 0xa0]);
    file.set(fix!.bytes, fix!.position);
    // Once declared, it's never patched twice.
    expect(opusCodecDelayPatch(file)).toBeNull();
  });

  it('leaves files alone when the header is not what it expects', async () => {
    expect(opusCodecDelayPatch(new Uint8Array(0))).toBeNull();
    expect(opusCodecDelayPatch(new Uint8Array(4096).map((_, i) => (i * 37) & 0xff))).toBeNull();
    const file = await muxOpusWebm(opusHead(312));
    // Truncated before the Tracks element ends: unsure, so no patch.
    expect(opusCodecDelayPatch(file.subarray(0, 120))).toBeNull();
  });
});
