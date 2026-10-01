/**
 * WebM/Opus: the encoder's pre-skip has to be declared with the Matroska
 * CodecDelay element, otherwise demuxers place the audio ~6.5 ms late. The
 * muxer writes the pre-skip value under SeekPreRoll instead (an element that
 * only matters for seeking), and both IDs are two bytes long, so the fix is
 * to rename that element in place: no sizes or offsets change.
 *
 * Returns the patch for a file whose first bytes are `head`, or null when the
 * header doesn't look exactly as expected (then the file is left alone).
 */

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Cluster: 0x1f43b675,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  CodecDelay: 0x56aa,
  SeekPreRoll: 0x56bb,
} as const;

/** How much of the file start the patcher needs to see. */
export const WEBM_HEAD_BYTES = 64 * 1024;

interface El {
  id: number;
  /** Offset of the ID. */
  at: number;
  /** Offset of the data. */
  data: number;
  /** Data size, or -1 when unknown. */
  size: number;
}

function vint(b: Uint8Array, at: number, keepMarker: boolean): { value: number; len: number } | null {
  const first = b[at];
  if (first === undefined || first === 0) return null;
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || at + len > b.length) return null;
  let value = keepMarker ? first : first & (0xff >> len);
  let allOnes = value === (0xff >> len);
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[at + i];
    if (b[at + i] !== 0xff) allOnes = false;
  }
  if (!keepMarker && allOnes) value = -1; // unknown size
  return { value, len };
}

function element(b: Uint8Array, at: number): El | null {
  const id = vint(b, at, true);
  if (!id) return null;
  const size = vint(b, at + id.len, false);
  if (!size) return null;
  return { id: id.value, at, data: at + id.len + size.len, size: size.value };
}

function children(b: Uint8Array, parent: El): El[] {
  const out: El[] = [];
  const end = parent.size < 0 ? b.length : Math.min(b.length, parent.data + parent.size);
  let p = parent.data;
  while (p < end) {
    const e = element(b, p);
    if (!e || e.size < 0) {
      // Clusters of unknown size end the header; anything else is unexpected.
      if (e?.id === ID.Cluster) out.push(e);
      break;
    }
    out.push(e);
    p = e.data + e.size;
  }
  return out;
}

function uint(b: Uint8Array, e: El): number {
  let v = 0;
  for (let i = 0; i < e.size; i++) v = v * 256 + b[e.data + i];
  return v;
}

export function opusCodecDelayPatch(head: Uint8Array): { position: number; bytes: Uint8Array<ArrayBuffer> } | null {
  const ebml = element(head, 0);
  if (!ebml || ebml.id !== ID.EBML || ebml.size < 0) return null;
  const segment = element(head, ebml.data + ebml.size);
  if (!segment || segment.id !== ID.Segment) return null;
  const tracks = children(head, segment).find((e) => e.id === ID.Tracks);
  if (!tracks || tracks.data + tracks.size > head.length) return null;
  for (const entry of children(head, tracks)) {
    if (entry.id !== ID.TrackEntry) continue;
    const fields = children(head, entry);
    const codec = fields.find((e) => e.id === ID.CodecID);
    if (!codec || new TextDecoder().decode(head.subarray(codec.data, codec.data + codec.size)) !== 'A_OPUS') continue;
    if (fields.some((e) => e.id === ID.CodecDelay)) return null; // already declared
    const priv = fields.find((e) => e.id === ID.CodecPrivate);
    const preRoll = fields.find((e) => e.id === ID.SeekPreRoll);
    if (!priv || !preRoll || priv.size < 19) return null;
    const magic = new TextDecoder().decode(head.subarray(priv.data, priv.data + 8));
    if (magic !== 'OpusHead') return null;
    const preSkip = head[priv.data + 10] | (head[priv.data + 11] << 8);
    // Only rename it when it really holds the pre-skip (not a genuine 80 ms seek pre-roll).
    if (preSkip === 0 || uint(head, preRoll) !== Math.round((1e9 * preSkip) / 48000)) return null;
    return { position: preRoll.at, bytes: new Uint8Array([0x56, 0xaa]) };
  }
  return null;
}
