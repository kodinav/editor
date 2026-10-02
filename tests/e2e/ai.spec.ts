import { expect, test } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { countPixels, exportVia, importFiles, openEditor, state, waitForMediaReady } from './helpers';

// Downloads the speech model (~77 MB) from Hugging Face on first run.
test.skip(!!process.env.OFFLINE, 'needs network for the one-time model download');

const out = (name: string) => {
  const dir = path.join(os.tmpdir(), 'cutline-e2e');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
};

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
});

test('auto captions transcribe speech on-device with word timing', async ({ page }) => {
  test.setTimeout(600_000);
  await openEditor(page);
  await importFiles(page, ['talking.mp4']);
  await waitForMediaReady(page);
  await page.getByRole('tab', { name: 'Captions' }).click();
  await page.getByRole('button', { name: /Generate automatically/ }).click();
  await page.getByRole('button', { name: 'Generate captions', exact: true }).click();
  await expect.poll(async () => (await state(page)).clips.filter((c) => c.type === 'caption').length, { timeout: 540_000 }).toBeGreaterThan(2);
  const caps = (await state(page)).clips.filter((c) => c.type === 'caption');
  const text = caps.map((c) => c.text).join(' ').toLowerCase();
  for (const word of ['welcome', 'edited', 'browser', 'uploaded', 'server', 'captions', 'device', 'word']) expect(text).toContain(word);
  // Every caption carries word timings inside its own span.
  for (const c of caps) {
    expect(c.words.length).toBeGreaterThan(0);
    for (const w of c.words) {
      expect(w.start).toBeGreaterThanOrEqual(0);
      expect(w.end).toBeLessThanOrEqual(c.duration + 0.05);
    }
  }
  // A second run reuses the loaded model (this used to wait forever) and replaces the
  // earlier captions on the same track instead of stacking another.
  const firstIds = caps.map((c) => c.id);
  const tab = page.getByRole('tab', { name: 'Captions' });
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click(); // clicking the open tab collapses it
  await page.getByRole('button', { name: 'Generate captions automatically' }).click();
  await page.getByRole('button', { name: 'Generate captions', exact: true }).click();
  await expect
    .poll(async () => (await state(page)).clips.filter((c) => c.type === 'caption' && !firstIds.includes(c.id)).length, { timeout: 120_000 })
    .toBe(caps.length);
  expect((await state(page)).tracks.filter((t) => t.name === 'Auto captions')).toHaveLength(1);
  expect((await state(page)).clips.filter((c) => c.type === 'caption')).toHaveLength(caps.length);
  // The highlighted (active) word is burned into the export in yellow.
  const file = await exportVia(page, out('autocaptions.mp4'));
  const first = caps[0];
  const mid = first.start + (first.words[1].start + first.words[1].end) / 2;
  // Caption box sits near the bottom; count highlight-yellow glyph pixels inside it.
  const yellow = countPixels(file, mid, 0.15, 0.8, 0.7, 0.15, (r, g, b) => r > 200 && g > 170 && b < 120);
  expect(yellow).toBeGreaterThan(80);
});
