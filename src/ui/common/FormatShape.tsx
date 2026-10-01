/** Outline of a canvas format, fitted into a fixed box so every ratio reads correctly. */
export function FormatShape({ width, height, box = { w: 56, h: 34 } }: { width: number; height: number; box?: { w: number; h: number } }) {
  const s = Math.min(box.w / width, box.h / height);
  return <span className="format-shape" style={{ width: Math.round(width * s), height: Math.round(height * s) }} aria-hidden="true" />;
}
