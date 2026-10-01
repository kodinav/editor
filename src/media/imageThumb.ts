import type { ThumbSprite } from '@/storage/db';

/** Small single-tile "sprite" for a still image, so bins and timelines never hold full-size photos. */
export async function makeImageThumb(assetId: string, bmp: ImageBitmap, height = 180): Promise<ThumbSprite> {
  const h = Math.max(1, Math.min(height, bmp.height));
  const w = Math.max(1, Math.round((bmp.width / bmp.height) * h));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  // PNG keeps transparency (logos, stickers).
  const blob = await c.convertToBlob({ type: 'image/png' });
  return { assetId, blob, cols: 1, rows: 1, count: 1, thumbWidth: w, thumbHeight: h, interval: 1, start: 0 };
}
