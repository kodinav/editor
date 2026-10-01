import { expect, test } from '@playwright/test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import {
  audioOnsets,
  audioOnsetsByTimestamp,
  brightFrames,
  countPixels,
  decodesCleanly,
  dominantFrequency,
  exportVia,
  importFiles,
  meanVolume,
  openEditor,
  probe,
  regionColor,
  seek,
  state,
  waitForMediaReady,
} from './helpers';

const out = (name: string) => {
  const dir = path.join(os.tmpdir(), 'cutline-e2e');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
};

const near = (c: number[], target: number[], tol = 40) => c.every((v, i) => Math.abs(v - target[i]) <= tol);

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
});

test('first import adapts the canvas and lays media out sensibly', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['portrait_rot.mp4', 'music.mp3', 'photo.jpg']);
  await waitForMediaReady(page);
  const s = await state(page);
  // Rotation metadata makes this a portrait video.
  expect(s.settings.width).toBe(720);
  expect(s.settings.height).toBe(1280);
  const video = s.clips.find((c) => c.type === 'video');
  const audio = s.clips.find((c) => c.type === 'audio');
  const image = s.clips.find((c) => c.type === 'image');
  expect(video.start).toBe(0);
  expect(audio.start).toBe(0); // music goes underneath, not after
  expect(image.start).toBeCloseTo(5, 3);
});

test('broken and unsupported files fail gracefully with clear messages', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['old.avi', 'truncated.mp4', 'garbage.mp4', 'landscape.mp4']);
  await waitForMediaReady(page);
  const s = await state(page);
  const byName = Object.fromEntries(s.assets.map((a) => [a.name, a]));
  expect(byName['old.avi'].status).toBe('error');
  expect(byName['old.avi'].error).toMatch(/AVI files aren’t supported/);
  expect(byName['truncated.mp4'].status).toBe('error');
  expect(byName['truncated.mp4'].error).toMatch(/incomplete|damaged/);
  expect(byName['garbage.mp4'].error).toMatch(/incomplete|damaged/);
  expect(byName['landscape.mp4'].status).toBe('ready');
  // The good file still made it to the timeline.
  expect(s.clips.filter((c) => c.type === 'video')).toHaveLength(1);
});

test('edits made in the UI are present in the exported MP4', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['red.mp4', 'blue.mp4']);
  await waitForMediaReady(page);
  await seek(page, 1);
  await page.keyboard.press('t'); // add a title
  const file = await exportVia(page, out('basic.mp4'));
  const info = probe(file);
  expect(info.video).toMatchObject({ codec: 'h264', width: 1280, height: 720 });
  expect(info.audio?.codec).toBe('aac');
  expect(info.duration).toBeGreaterThan(5.9);
  expect(info.duration).toBeLessThan(6.2);
  expect(decodesCleanly(file)).toBe(true);
  expect(near(regionColor(file, 2, 0.05, 0.05), [250, 25, 0])).toBe(true); // red clip
  expect(near(regionColor(file, 4.5, 0.05, 0.05), [0, 15, 255])).toBe(true); // blue clip
  // White title in the middle of the frame while it's on screen.
  const center = regionColor(file, 2, 0.47, 0.47, 0.06, 0.06);
  expect(center[1]).toBeGreaterThan(60); // red background has ~25 green; white text raises it
  expect(meanVolume(file, 0.3, 2.4)).toBeGreaterThan(-30); // tone in the red clip
  expect(meanVolume(file, 3.3, 2.4)).toBeLessThan(-70); // blue clip is silent
});

test('split, trim, undo/redo and reload keep the project intact', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['landscape.mp4']);
  await waitForMediaReady(page);
  await seek(page, 4);
  await page.keyboard.press('s');
  let s = await state(page);
  expect(s.clips).toHaveLength(2);
  expect(s.clips[1].start).toBe(4);
  expect(s.clips[1].sourceIn).toBeCloseTo(4, 3);

  // Trim the head of the second clip by dragging its edge 1 s to the right.
  const pps = await page.evaluate(() => (window as any).__cutline.editor.getState().pxPerSec);
  const b = (await page.locator(`[data-clip="${s.clips[1].id}"]`).boundingBox())!;
  await page.mouse.move(b.x + 1, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 1 + pps / 2, b.y + b.height / 2, { steps: 4 });
  await page.mouse.move(b.x + 1 + pps, b.y + b.height / 2, { steps: 4 });
  await page.mouse.up();
  s = await state(page);
  expect(s.clips[1].start).toBeCloseTo(5, 3);
  expect(s.clips[1].sourceIn).toBeCloseTo(5, 3);

  await page.keyboard.press('ControlOrMeta+z');
  s = await state(page);
  expect(s.clips[1].start).toBe(4);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  s = await state(page);
  expect(s.clips[1].start).toBeCloseTo(5, 3);

  // Wait for autosave, reload, verify.
  await page.waitForFunction(() => (window as any).__cutline.editor.getState().saveState === 'saved');
  await page.reload();
  await page.waitForFunction(() => Object.keys((window as any).__cutline?.editor.getState().project.clips ?? {}).length === 2);
  const after = await state(page);
  expect(after.clips.map((c) => [c.start, c.duration])).toEqual(s.clips.map((c) => [c.start, c.duration]));
  // Media survives a reload wherever the browser lets us store files (not in private browsing,
  // where it's honestly reported as missing instead).
  const canStoreFiles = await page.evaluate(async () => {
    try {
      await (await navigator.storage.getDirectory()).getDirectoryHandle('media', { create: true });
      return true;
    } catch {
      return false;
    }
  });
  expect(after.assets[0].status).toBe(canStoreFiles ? 'ready' : 'missing');
});

test('rotated phone video exports upright', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['portrait_rot.mp4']);
  await waitForMediaReady(page);
  const file = await exportVia(page, out('portrait.mp4'));
  const info = probe(file);
  expect(info.video?.width).toBe(720);
  expect(info.video?.height).toBe(1280);
  // ffmpeg's auto-rotated reference: cyan band at the top, red band at the bottom.
  expect(near(regionColor(file, 1.5, 0.3, 0.05, 0.2, 0.05), [0, 255, 255], 60)).toBe(true);
  expect(near(regionColor(file, 1.5, 0.3, 0.9, 0.2, 0.05), [255, 0, 0], 60)).toBe(true);
});

test('speed change keeps audio pitch when "keep pitch" is on', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['voice.wav']); // 880 Hz tone, 8 s
  await waitForMediaReady(page);
  const id = (await state(page)).clips[0].id;
  await page.evaluate((cid) => {
    const { editor } = (window as any).__cutline;
    editor.getState().select([cid]);
  }, id);
  await page.getByRole('tab', { name: 'Speed' }).click();
  await page.getByRole('button', { name: '2×', exact: true }).click();
  const s = await state(page);
  expect(s.clips[0].duration).toBeCloseTo(4, 2);
  const file = await exportVia(page, out('speed.wav'), async () => {
    await page.getByRole('dialog').getByLabel('Format', { exact: true }).selectOption('wav');
  });
  const info = probe(file);
  expect(info.duration).toBeGreaterThan(3.9);
  expect(info.duration).toBeLessThan(4.2);
  const f = dominantFrequency(file, 0.5, 3);
  expect(f).toBeGreaterThan(820);
  expect(f).toBeLessThan(940);
});

test('WebM export uses VP9 + Opus', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['clip60.webm']);
  await waitForMediaReady(page);
  const file = await exportVia(page, out('clip.webm'), async () => {
    await page.getByRole('dialog').getByLabel('Format', { exact: true }).selectOption('webm');
  });
  const info = probe(file);
  expect(info.video?.codec).toBe('vp9');
  expect(info.audio?.codec).toBe('opus');
  expect(decodesCleanly(file)).toBe(true);
});

test('captions import, burn in, and export as SRT', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['blue.mp4', 'captions.srt']);
  await waitForMediaReady(page);
  const s = await state(page);
  const caps = s.clips.filter((c) => c.type === 'caption');
  expect(caps.map((c) => c.text)).toEqual(['Hello from Cutline', 'Captions are burned in on export']);
  const file = await exportVia(page, out('captions.mp4'));
  // Caption box (dark background) near the bottom center at 1 s, plain blue at the top.
  const bottom = regionColor(file, 1, 0.45, 0.85, 0.1, 0.04);
  expect(bottom[2]).toBeLessThan(200);
  expect(near(regionColor(file, 1, 0.45, 0.1, 0.1, 0.05), [0, 15, 255])).toBe(true);
});

test('project file round-trips with media', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['red.mp4']);
  await waitForMediaReady(page);
  await page.getByRole('button', { name: 'Project menu' }).click();
  const dl = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /Save project file \(without media\)/ }).click();
  const d = await dl;
  const p = out('proj.cutline');
  await d.saveAs(p);
  expect(fs.statSync(p).size).toBeGreaterThan(200);
  // Re-open it: it becomes a new project with the media offline (not included).
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), (async () => {
    await page.getByRole('button', { name: 'Project menu' }).click();
    await page.getByRole('menuitem', { name: 'Open project file…' }).click();
  })()]);
  await chooser.setFiles(p);
  await page.waitForFunction(() => (window as any).__cutline.editor.getState().toasts.some((t: any) => /Opened/.test(t.message)));
  const s = await state(page);
  expect(s.clips).toHaveLength(1);
  expect(s.assets[0].status).toBe('missing');
});

test('audio and video stay in sync in every export format (including after a timeline offset)', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['sync.mp4']); // flash + beep together at 1, 3, 5, 7, 9 s
  await waitForMediaReady(page);
  // Move the clip 0.5 s later on the timeline so source and output times differ.
  await page.evaluate(() => {
    const s = (window as any).__cutline.editor.getState();
    s.commit('offset', (d: any) => {
      const c: any = Object.values(d.clips)[0];
      c.start = 0.5;
    });
  });
  for (const fmt of ['mp4', 'webm', 'mov'] as const) {
    const file = await exportVia(page, out(`sync.${fmt}`), async () => {
      await page.getByRole('dialog').getByLabel('Format', { exact: true }).selectOption(fmt);
    });
    const flashes = brightFrames(file);
    // Group consecutive flash frames into flash starts.
    const starts = flashes.filter((t, i) => i === 0 || t - flashes[i - 1] > 0.5);
    expect(starts).toHaveLength(5);
    // ffmpeg shifts both streams by Opus's codec delay (start -0.007 s), hence the loose absolute check.
    expect(Math.abs(starts[0] - 1.5)).toBeLessThan(0.01);
    // Check both how players lay samples out (back to back) and the file's own audio timestamps.
    const beeps = audioOnsets(file);
    expect(beeps, fmt).toHaveLength(5);
    const stamped = audioOnsetsByTimestamp(file);
    starts.forEach((f, i) => {
      // Uncompensated AAC priming shows up as a 44 ms lag, undeclared Opus pre-skip as 7 ms; real sync is ~0.
      expect(Math.abs(beeps[i] - f), `${fmt}: beep vs flash at ${f}s`).toBeLessThan(0.004);
      const nearest = stamped.reduce((a, b) => (Math.abs(b - f) < Math.abs(a - f) ? b : a));
      expect(Math.abs(nearest - f), `${fmt} timestamps: beep vs flash at ${f}s`).toBeLessThan(0.004);
    });
  }
  // Audio-only AAC starts exactly on time too (the beeps sit 0.5 s after the source's 1, 3, 5… s).
  const m4a = await exportVia(page, out('sync.m4a'), async () => {
    await page.getByRole('dialog').getByLabel('Format', { exact: true }).selectOption('m4a');
  });
  const beeps = audioOnsets(m4a);
  expect(beeps).toHaveLength(5);
  beeps.forEach((t, i) => expect(Math.abs(t - (1.5 + 2 * i)), `m4a beep ${i}`).toBeLessThan(0.004));
});

test('exporting the in/out range renders just that part, still in sync', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['sync.mp4']); // flash + beep together at 1, 3, 5, 7, 9 s
  await waitForMediaReady(page);
  await seek(page, 2);
  await page.keyboard.press('i');
  await seek(page, 6);
  await page.keyboard.press('o');
  const s = await state(page);
  expect([s.inPoint, s.outPoint]).toEqual([2, 6]);
  const file = await exportVia(page, out('range.mp4'), async () => {
    await expect(page.getByRole('checkbox', { name: /Only the in\/out range/ })).toBeChecked();
  });
  const info = probe(file);
  expect(info.duration).toBeGreaterThan(3.95);
  expect(info.duration).toBeLessThan(4.1);
  // The flashes at 3 s and 5 s land at 1 s and 3 s of the export, with their beeps.
  const flashes = brightFrames(file);
  const starts = flashes.filter((t, i) => i === 0 || t - flashes[i - 1] > 0.5);
  expect(starts.length).toBe(2);
  expect(Math.abs(starts[0] - 1)).toBeLessThan(0.01);
  expect(Math.abs(starts[1] - 3)).toBeLessThan(0.01);
  const beeps = audioOnsets(file);
  expect(beeps).toHaveLength(2);
  beeps.forEach((t, i) => expect(Math.abs(t - starts[i]), `beep ${i}`).toBeLessThan(0.004));
});

test('exporting at a lower resolution and frame rate scales everything consistently', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['red.mp4', 'blue.mp4']);
  await waitForMediaReady(page);
  await seek(page, 1);
  await page.keyboard.press('t'); // add a title
  const full = await exportVia(page, out('scale-full.mp4'));
  const small = await exportVia(page, out('scale-small.mp4'), async () => {
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Resolution').selectOption({ label: '360p — 640×360' });
    await dialog.getByLabel('Frame rate').selectOption('24');
  });
  const info = probe(small);
  expect(info.video).toMatchObject({ width: 640, height: 360 });
  expect(info.video?.fps).toBeCloseTo(24, 1);
  expect(info.duration).toBeGreaterThan(5.9);
  expect(info.duration).toBeLessThan(6.2);
  expect(near(regionColor(small, 2, 0.05, 0.05), [250, 25, 0])).toBe(true);
  expect(near(regionColor(small, 4.5, 0.05, 0.05), [0, 15, 255])).toBe(true);
  // The title covers the same share of the frame: a quarter of the pixels at half the size.
  const white = (r: number, g: number, b: number) => r > 200 && g > 200 && b > 200;
  const a = countPixels(full, 2, 0, 0, 1, 1, white);
  const b = countPixels(small, 2, 0, 0, 1, 1, white);
  expect(a).toBeGreaterThan(2000);
  expect(b / a).toBeGreaterThan(0.2);
  expect(b / a).toBeLessThan(0.3);
});

test('a damaged project file opens with what can be recovered, and says so', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['red.mp4']);
  await waitForMediaReady(page);
  await seek(page, 1);
  await page.keyboard.press('t');
  await page.getByRole('button', { name: 'Project menu' }).click();
  const dl = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /Save project file \(without media\)/ }).click();
  const saved = out('damaged.cutline');
  await (await dl).saveAs(saved);

  // Corrupt it the way a bad disk, a buggy tool or a hostile file might…
  const files = unzipSync(fs.readFileSync(saved));
  const doc = JSON.parse(strFromU8(files['project.json']));
  const clips = Object.values(doc.project.clips) as any[];
  const text = clips.find((c) => c.type === 'text');
  text.style = 'garbage';
  text.transform = null;
  text.effects = { not: 'a list' };
  text.keyframes = { 'transform.x': [{ t: 'soon', v: 1 }, { id: 'k', t: 0.5, v: 40, ease: 'linear' }] };
  const video = clips.find((c) => c.type === 'video');
  doc.project.clips.ghost = { ...video, id: 'ghost', assetId: 'nope', start: 50 };
  // …and re-zipped by hand: compressed, inside a folder, with macOS metadata alongside.
  fs.writeFileSync(
    saved,
    zipSync({
      'My project/project.json': strToU8(JSON.stringify(doc)),
      '__MACOSX/My project/._project.json': new Uint8Array([0, 5, 22, 7]),
    }),
  );

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    (async () => {
      await page.getByRole('button', { name: 'Project menu' }).click();
      await page.getByRole('menuitem', { name: 'Open project file…' }).click();
    })(),
  ]);
  await chooser.setFiles(saved);
  await page.waitForFunction(() => (window as any).__cutline.editor.getState().toasts.some((t: any) => /1 damaged item/.test(t.message)));
  const s = await state(page);
  expect(s.clips.map((c) => c.type).sort()).toEqual(['text', 'video']);
  const t = s.clips.find((c) => c.type === 'text');
  expect(t.style.fontSize).toBeGreaterThan(0);
  expect(t.transform).toMatchObject({ x: 0, y: 0, scale: 1, opacity: 1 });
  expect(t.effects).toEqual([]);
  expect(t.keyframes['transform.x']).toHaveLength(1);
  // The recovered project renders (page errors fail the test).
  await seek(page, 1.5);
  await page.waitForTimeout(300);
});
