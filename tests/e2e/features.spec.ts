import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { countPixels, exportVia, importFiles, meanVolume, openEditor, probe, regionColor, seek, state, waitForMediaReady, fixture } from './helpers';

const out = (name: string) => {
  const dir = path.join(os.tmpdir(), 'cutline-e2e');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
};
const near = (c: number[], target: number[], tol = 40) => c.every((v, i) => Math.abs(v - target[i]) <= tol);

async function selectFirst(page: Page, type: string) {
  await page.evaluate((t) => {
    const s = (window as any).__cutline.editor.getState();
    const c = Object.values(s.project.clips).find((x: any) => x.type === t) as any;
    s.select([c.id]);
  }, type);
}

/** Apply an edit through the editor's command API (the same path the UI uses). */
async function commit(page: Page, recipe: (d: any) => void) {
  await page.evaluate(`(() => {
    const s = window.__cutline.editor.getState();
    s.commit('test edit', ${recipe.toString()});
  })()`);
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
});

test('remove pauses cuts silent gaps and closes them', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['pauses.wav']);
  await waitForMediaReady(page);
  await selectFirst(page, 'audio');
  await page.getByRole('button', { name: 'Remove pauses' }).click();
  await expect.poll(async () => (await state(page)).clips.length).toBe(3);
  const s = await state(page);
  // Three 1 s tones survive with 0.15 s padding on each side of each gap.
  const total = s.clips.reduce((n, c) => n + c.duration, 0);
  expect(total).toBeGreaterThan(3.7);
  expect(total).toBeLessThan(4.1);
  for (let i = 1; i < s.clips.length; i++) expect(s.clips[i].start).toBeCloseTo(s.clips[i - 1].start + s.clips[i - 1].duration, 3);
  const file = await exportVia(page, out('pauses.wav'), async () => {
    await page.getByRole('dialog').getByLabel('Format', { exact: true }).selectOption('wav');
  });
  const info = probe(file);
  expect(info.duration).toBeGreaterThan(3.7);
  expect(info.duration).toBeLessThan(4.1);
  // Output: tone 0-1, 0.3 s breath, tone 1.3-2.3, 0.3 s breath, tone 2.6-3.6.
  expect(meanVolume(file, 1.5, 0.25)).toBeGreaterThan(-35);
  expect(meanVolume(file, 2.9, 0.25)).toBeGreaterThan(-35);
  expect(meanVolume(file, 1.05, 0.2)).toBeLessThan(-60);
});

test('voiceover recording lands on the timeline at the playhead', async ({ page }) => {
  await openEditor(page);
  await page.getByRole('button', { name: 'Record voiceover' }).click();
  const rec = page.getByRole('button', { name: /Record at playhead/ });
  await expect(rec).toBeEnabled();
  await page.getByLabel('Play the timeline while recording').uncheck();
  await rec.click();
  await page.waitForTimeout(2200);
  await page.getByRole('button', { name: /Stop/ }).click();
  await expect.poll(async () => (await state(page)).clips.filter((c) => c.type === 'audio').length, { timeout: 30_000 }).toBe(1);
  await waitForMediaReady(page);
  const s = await state(page);
  const clip = s.clips.find((c) => c.type === 'audio');
  expect(clip.start).toBe(0);
  expect(clip.duration).toBeGreaterThan(1.5);
  expect(s.assets[0].audio.conformed).toBe(true);
});

test('chroma key reveals the track below', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['blue.mp4']);
  await waitForMediaReady(page);
  // Add the green-screen clip, then move it to the track above.
  await importFiles(page, ['greenscreen.mp4']);
  await waitForMediaReady(page);
  await page.getByRole('button', { name: 'Add greenscreen.mp4 to timeline' }).click();
  await commit(page, (d) => {
    const tracks = d.tracks.filter((t: any) => t.kind === 'video');
    const gs: any = Object.values(d.clips).find((c: any) => c.name === 'greenscreen.mp4');
    gs.trackId = tracks[0].id;
    gs.start = 0;
    gs.duration = 3;
    gs.effects.push({ id: 'fx1', type: 'chromaKey', enabled: true, params: { keyColor: '#00ff00', similarity: 40, smoothness: 10, spill: 50 } });
  });
  const file = await exportVia(page, out('chroma.mp4'));
  // Corners: green keyed out -> blue below. Center: the red box survives.
  expect(near(regionColor(file, 1, 0.05, 0.05), [0, 15, 255], 50)).toBe(true);
  expect(near(regionColor(file, 1, 0.47, 0.47, 0.06, 0.06), [255, 0, 0], 60)).toBe(true);
});

test('keyframed position animates in the export', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['square.png']);
  await waitForMediaReady(page);
  await commit(page, (d) => {
    const c: any = Object.values(d.clips)[0];
    c.fit = 'none';
    c.start = 0;
    c.duration = 2;
    c.keyframes['transform.x'] = [
      { id: 'a', t: 0, v: -800, ease: 'linear' },
      { id: 'b', t: 2, v: 800, ease: 'linear' },
    ];
  });
  const file = await exportVia(page, out('motion.mp4'));
  // Square (white, 200 px on a 1920 canvas) starts on the left and ends on the right.
  const w = probe(file).video!.width;
  const leftAt = (t: number) => regionColor(file, t, 0.5 - 800 / w - 0.01, 0.48, 0.02, 0.04)[0];
  expect(leftAt(0.05)).toBeGreaterThan(200);
  expect(regionColor(file, 1.9, 0.5 + 760 / w - 0.01, 0.48, 0.02, 0.04)[0]).toBeGreaterThan(200);
  expect(regionColor(file, 1.9, 0.5 - 800 / w - 0.01, 0.48, 0.02, 0.04)[0]).toBeLessThan(40);
});

test('dip-to-black transition goes dark at the cut and audio fades are applied', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['red.mp4', 'blue.mp4']);
  await waitForMediaReady(page);
  await commit(page, (d) => {
    const a: any = Object.values(d.clips).find((c: any) => c.name === 'red.mp4');
    a.transitionOut = { type: 'dipBlack', duration: 1 };
    a.fadeIn = 1;
  });
  const file = await exportVia(page, out('dip.mp4'));
  const atCut = regionColor(file, 3.0, 0.3, 0.3, 0.4, 0.4);
  expect(Math.max(...atCut)).toBeLessThan(40);
  expect(near(regionColor(file, 2.0, 0.1, 0.1), [250, 25, 0])).toBe(true);
  // Fade-in: the first 0.25 s is much quieter than the middle of the red clip.
  expect(meanVolume(file, 0, 0.25)).toBeLessThan(meanVolume(file, 1.5, 0.5) - 6);
});

test('export can be cancelled', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['landscape.mp4', 'clip60.webm']);
  await waitForMediaReady(page);
  await page.keyboard.press('ControlOrMeta+e');
  await page.getByRole('button', { name: /^Export video/ }).click();
  await expect(page.getByRole('button', { name: 'Cancel export' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel export' }).click();
  await expect(page.getByRole('button', { name: /^Export video/ })).toBeVisible();
});

test('a project open in two tabs is protected from conflicting saves', async ({ page, context }) => {
  await openEditor(page);
  await importFiles(page, ['red.mp4']);
  await waitForMediaReady(page);
  await page.waitForFunction(() => (window as any).__cutline.editor.getState().saveState === 'saved');
  const second = await context.newPage();
  await second.goto('/?debug');
  await expect(second.getByText(/open in another tab/)).toBeVisible();
  await second.getByRole('button', { name: 'Edit here instead' }).click();
  await expect(second.getByText(/open in another tab/)).toHaveCount(0);
});

test('offline media can be relinked', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['red.mp4']);
  await waitForMediaReady(page);
  await page.waitForFunction(() => (window as any).__cutline.editor.getState().saveState === 'saved');
  const id = (await state(page)).assets[0].id;
  // Simulate the browser evicting stored media.
  await page.evaluate(async (assetId) => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('media');
    await dir.removeEntry(assetId);
  }, id);
  await page.reload();
  await page.waitForFunction(() => (window as any).__cutline?.editor.getState().project.assets && Object.values((window as any).__cutline.editor.getState().project.assets).some((a: any) => a.status === 'missing'));
  const card = page.getByRole('listitem').filter({ hasText: 'red.mp4' });
  await card.getByRole('button', { name: /More options/ }).click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('menuitem', { name: 'Relink file…' }).click()]);
  await chooser.setFiles(fixture('red.mp4'));
  await expect.poll(async () => (await state(page)).assets[0].status).toBe('ready');
  await waitForMediaReady(page);
  await seek(page, 1);
  const file = await exportVia(page, out('relinked.mp4'));
  expect(near(regionColor(file, 1, 0.1, 0.1), [250, 25, 0])).toBe(true);
});

test('ripple mode closes gaps on delete and pushes clips on trim', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['red.mp4', 'blue.mp4', 'red.mp4']);
  await waitForMediaReady(page);
  let s = await state(page);
  const vids = s.clips.filter((c) => c.type === 'video');
  expect(vids.map((c) => c.start)).toEqual([0, 3, 6]);
  await page.keyboard.press('r'); // ripple on
  // Delete the middle clip: the last one slides left to close the gap.
  await page.evaluate((id) => (window as any).__cutline.editor.getState().select([id]), vids[1].id);
  await page.keyboard.press('Delete');
  s = await state(page);
  expect(s.clips.filter((c) => c.type === 'video').map((c) => c.start)).toEqual([0, 3]);
  // Trim the first clip's end 1 s shorter by dragging: the follower moves with it.
  const first = s.clips.find((c) => c.type === 'video' && c.start === 0)!;
  const pps = await page.evaluate(() => (window as any).__cutline.editor.getState().pxPerSec);
  const b = (await page.locator(`[data-clip="${first.id}"]`).boundingBox())!;
  await page.mouse.move(b.x + b.width - 2, b.y + 12);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 2 - pps / 2, b.y + 12, { steps: 4 });
  await page.mouse.move(b.x + b.width - 2 - pps, b.y + 12, { steps: 4 });
  await page.mouse.up();
  s = await state(page);
  const after = s.clips.filter((c) => c.type === 'video');
  expect(after[0].duration).toBeCloseTo(2, 1);
  expect(after[1].start).toBeCloseTo(after[0].start + after[0].duration, 3);
});

test('auto-ducking lowers music under speech', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['speech.wav', 'music.mp3']);
  await waitForMediaReady(page);
  // Put the music on its own track, starting with the speech.
  await commit(page, (d) => {
    const music: any = Object.values(d.clips).find((c: any) => c.name === 'music.mp3');
    const t = { id: 'trk_music', kind: 'audio', name: 'Music', hidden: false, muted: false, locked: false, volume: 1, height: 56 };
    d.tracks.push(t);
    music.trackId = t.id;
    music.start = 0;
  });
  await selectFirstNamed(page, 'music.mp3');
  await page.getByRole('tab', { name: 'Audio' }).click();
  await page.getByRole('button', { name: /Duck this clip under other audio/ }).click();
  await expect.poll(async () => (await state(page)).clips.find((c) => c.name === 'music.mp3')?.keyframes?.volume?.length ?? 0).toBeGreaterThan(3);
  // Export the music alone (speech track muted) and compare levels.
  await commit(page, (d) => {
    const speech: any = Object.values(d.clips).find((c: any) => c.name === 'speech.wav');
    d.tracks.find((t: any) => t.id === speech.trackId).muted = true;
  });
  const file = await exportVia(page, out('ducked.wav'), async () => {
    await page.getByRole('dialog').getByLabel('Format', { exact: true }).selectOption('wav');
  });
  const during = meanVolume(file, 1.0, 2.0); // speech is talking here
  const after = meanVolume(file, 14, 3); // speech ended at ~11.5 s
  expect(after - during).toBeGreaterThan(10);
});

async function selectFirstNamed(page: Page, name: string) {
  await page.evaluate((n) => {
    const s = (window as any).__cutline.editor.getState();
    const c = Object.values(s.project.clips).find((x: any) => x.name === n) as any;
    s.select([c.id]);
  }, name);
}

test('scene detection splits a multi-shot clip at the exact cuts', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['scenes.mp4']); // shots change at 2.0, 4.5 and 6.0 s
  await waitForMediaReady(page);
  await selectFirst(page, 'video');
  const scenes = page.getByRole('button', { name: 'Scenes', exact: true });
  if ((await scenes.getAttribute('aria-expanded')) === 'false') await scenes.click();
  await page.getByRole('button', { name: /Detect & split at scene changes/ }).click();
  await expect.poll(async () => (await state(page)).clips.length, { timeout: 60_000 }).toBe(4);
  const starts = (await state(page)).clips.map((c) => c.start);
  const expected = [0, 2, 4.5, 6];
  starts.forEach((s, i) => expect(Math.abs(s - expected[i])).toBeLessThanOrEqual(1 / 30 + 1e-6));
});

test('scene detection leaves continuous footage alone', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['clip60.webm']); // one continuous moving shot
  await waitForMediaReady(page);
  await selectFirst(page, 'video');
  const scenes = page.getByRole('button', { name: 'Scenes', exact: true });
  if ((await scenes.getAttribute('aria-expanded')) === 'false') await scenes.click();
  await page.getByRole('button', { name: /Detect & split at scene changes/ }).click();
  await expect.poll(async () => (await state(page)).toasts.some((t) => /No scene changes/.test(t.message)), { timeout: 60_000 }).toBe(true);
  expect((await state(page)).clips).toHaveLength(1);
});

test('animated GIFs play and loop in the export', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['anim.gif']); // red, green, blue — 0.5 s each, looping
  await waitForMediaReady(page);
  const s = await state(page);
  expect(s.assets[0].image.animated).toBe(true);
  expect(s.assets[0].duration).toBeCloseTo(1.5, 1);
  await commit(page, (d) => {
    const c: any = Object.values(d.clips)[0];
    c.fit = 'fill';
    c.duration = 3;
  });
  const file = await exportVia(page, out('anim.mp4'));
  const at = (t: number) => regionColor(file, t, 0.4, 0.4, 0.2, 0.2);
  expect(near(at(0.25), [255, 0, 0], 60)).toBe(true);
  expect(near(at(0.75), [0, 255, 0], 60)).toBe(true);
  expect(near(at(1.25), [0, 0, 255], 60)).toBe(true);
  expect(near(at(1.75), [255, 0, 0], 60)).toBe(true); // looped
});

test('noise reduction cleans steady background noise and keeps the voice', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['noisy_speech.wav']);
  await waitForMediaReady(page);
  const wav = async (name: string) =>
    exportVia(page, out(name), async () => {
      await page.getByRole('dialog').getByLabel('Format', { exact: true }).selectOption('wav');
    });
  const before = await wav('noisy.wav');
  await page.getByRole('button', { name: 'Close' }).click();
  await selectFirst(page, 'audio');
  await page.getByRole('tab', { name: 'Audio' }).click();
  await page.getByRole('button', { name: 'Medium', exact: true }).click();
  await expect.poll(async () => (await state(page)).clips[0].denoise, { timeout: 60_000 }).toBe(true);
  const after = await wav('denoised.wav');
  // The pause between sentences (≈6.35–6.95 s) is pure noise.
  const pauseDrop = meanVolume(before, 6.35, 0.6) - meanVolume(after, 6.35, 0.6);
  const speechDrop = meanVolume(before, 1.0, 2.0) - meanVolume(after, 1.0, 2.0);
  expect(pauseDrop).toBeGreaterThan(8);
  expect(speechDrop).toBeLessThan(3);
});

test('cleaned audio survives storage cleanup, and is rebuilt if it goes missing', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['noisy_speech.wav']);
  await waitForMediaReady(page);
  await selectFirst(page, 'audio');
  await page.getByRole('tab', { name: 'Audio' }).click();
  await page.getByRole('button', { name: 'Medium', exact: true }).click();
  await expect.poll(async () => (await state(page)).clips[0].denoise, { timeout: 60_000 }).toBe(true);
  await page.waitForFunction(() => (window as any).__cutline.editor.getState().saveState === 'saved');
  const pcmFiles = () =>
    page.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('pcm');
      const names: string[] = [];
      for await (const name of (dir as any).keys()) names.push(name);
      return names.sort();
    });
  const id = (await state(page)).assets[0].id;
  expect(await pcmFiles()).toEqual([`${id}.nr.pcm`, `${id}.pcm`]);

  // Cleanup an hour later must keep both: the project still uses them.
  await page.evaluate(async () => {
    const real = Date.now;
    Date.now = () => real() + 3600_000;
    try {
      await (window as any).__cutline.storage.collectGarbage();
    } finally {
      Date.now = real;
    }
  });
  expect(await pcmFiles()).toEqual([`${id}.nr.pcm`, `${id}.pcm`]);

  // If the cleaned audio is lost anyway, reopening the project rebuilds it instead of
  // quietly playing (and exporting) the noisy original.
  await page.evaluate(async (name) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('pcm');
    await dir.removeEntry(name);
  }, `${id}.nr.pcm`);
  await page.reload();
  await page.waitForFunction((aid) => !!(window as any).__cutline?.media.getPcm(aid, 'nr'), id, { timeout: 60_000 });
  expect(await pcmFiles()).toEqual([`${id}.nr.pcm`, `${id}.pcm`]);
  const after = await exportVia(page, out('restored-denoise.wav'), async () => {
    await page.getByRole('dialog').getByLabel('Format', { exact: true }).selectOption('wav');
  });
  // Same pause as above: pure noise in the source (≈ -42 dB), well below that once cleaned.
  expect(meanVolume(after, 6.35, 0.6)).toBeLessThan(-50);
});

test('starter templates render their titles and save cleanly', async ({ page }) => {
  await openEditor(page);
  for (const name of ['Bold intro', 'Quote card', 'Countdown']) {
    await page.getByRole('group', { name: 'Start from a template' }).getByRole('button', { name, exact: true }).click();
    const s = await state(page);
    expect(s.clips.filter((c) => c.type === 'text').length, name).toBeGreaterThanOrEqual(2);
    // Autosave (in development this also checks the saved data reopens unchanged).
    await page.waitForFunction(() => (window as any).__cutline.editor.getState().saveState === 'saved');
    const file = await exportVia(page, out(`template-${name.replace(/\s+/g, '-')}.mp4`));
    await page.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click();
    // Light title text over a colored/dark background, 1.5 s in.
    const light = countPixels(file, 1.5, 0, 0, 1, 1, (r, g, b) => r + g + b > 600);
    expect(light, name).toBeGreaterThan(1500);
    const dark = countPixels(file, 1.5, 0, 0, 1, 1, (r, g, b) => r + g + b < 600);
    expect(dark, name).toBeGreaterThan(light);
    await page.keyboard.press('ControlOrMeta+z'); // back to the empty project for the next template
    await expect.poll(async () => (await state(page)).clips.length).toBe(0);
  }
});
