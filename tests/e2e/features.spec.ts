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
  // The first tab keeps working and saves a marker before the second takes over.
  await page.evaluate(() => (window as any).__cutline.editor.getState().commit('Marker', (d: any) => d.markers.push({ id: 'm1', t: 1, label: 'From tab 1', color: '#fff' })));
  await page.waitForFunction(() => (window as any).__cutline.editor.getState().saveState === 'saved');
  await second.getByRole('button', { name: 'Edit here instead' }).click();
  await expect(second.getByText(/open in another tab/)).toHaveCount(0);
  // The second tab continues from the latest saved version, not its stale copy…
  await second.waitForFunction(() => (window as any).__cutline.editor.getState().project.markers.some((m: any) => m.label === 'From tab 1'));
  // …and the first tab now knows it lost the project and stops saving.
  await expect(page.getByText(/now being edited in another tab/)).toBeVisible();
  await second.evaluate(() => (window as any).__cutline.editor.getState().commit('Marker', (d: any) => d.markers.push({ id: 'm2', t: 2, label: 'From tab 2', color: '#fff' })));
  await second.waitForFunction(() => (window as any).__cutline.editor.getState().saveState === 'saved');
  // When the second tab closes, the first takes over again with tab 2's work.
  await second.close();
  await expect(page.getByText(/now being edited in another tab/)).toHaveCount(0);
  await page.waitForFunction(() => (window as any).__cutline.editor.getState().project.markers.some((m: any) => m.label === 'From tab 2'));
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

test('typing is saved as you go, even without leaving the field', async ({ page }) => {
  await openEditor(page);
  await page.keyboard.press('t'); // add a title (selected)
  const box = page.locator('#text-content-input');
  await box.click();
  await box.fill('Hello from a reload');
  // No blur: the text must still reach storage, and the indicator must not claim "Saved" early.
  await page.waitForFunction(() => {
    const s = (window as any).__cutline.editor.getState();
    return s.saveState === 'saved' && (Object.values(s.project.clips) as any[]).some((c) => c.text === 'Hello from a reload');
  });
  await page.reload();
  await page.waitForFunction(() => (Object.values((window as any).__cutline?.editor.getState().project.clips ?? {}) as any[]).some((c) => c.text === 'Hello from a reload'));
});

test('a canvas drag interrupted by Escape still lands, and undo keeps working', async ({ page }) => {
  await openEditor(page);
  await page.keyboard.press('t');
  const id = (await state(page)).clips[0].id;
  const box = (await page.locator('polygon.gizmo-box').first().boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 40, cy, { steps: 4 });
  await page.keyboard.press('Escape'); // deselects: the handle that started the drag unmounts
  await page.mouse.move(cx + 80, cy, { steps: 4 });
  await page.mouse.up();
  const moved = await page.evaluate((cid) => {
    const s = (window as any).__cutline.editor.getState();
    return { open: !!s.gestureBase, x: s.project.clips[cid].transform.x, undo: s.past.length };
  }, id);
  expect(moved.open).toBe(false);
  expect(moved.x).toBeGreaterThan(0);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await page.evaluate((cid) => (window as any).__cutline.editor.getState().project.clips[cid].transform.x, id)).toBe(0);
});

test('projects can be duplicated and deleted from the Projects dialog', async ({ page }) => {
  await openEditor(page);
  await page.keyboard.press('t');
  await page.waitForFunction(() => (window as any).__cutline.editor.getState().saveState === 'saved');
  page.on('dialog', (d) => d.accept());
  const cards = () => page.getByRole('dialog').getByRole('button', { name: /^More options for / });
  await page.getByRole('button', { name: 'Project menu' }).click();
  await page.getByRole('menuitem', { name: 'All projects…' }).click();
  await expect(cards()).toHaveCount(1);
  await cards().first().click();
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect(cards()).toHaveCount(2);
  await page.getByRole('dialog').getByRole('button', { name: /^More options for .*\(copy\)$/ }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(cards()).toHaveCount(1);
});

test('italic works for every font and keeps the chosen weight', async ({ page }) => {
  await openEditor(page);
  await page.keyboard.press('t');
  const id = (await state(page)).clips[0].id;
  // Render the title with a style and return its white-pixel mask from the preview.
  const render = (style: Record<string, unknown>) =>
    page.evaluate(
      async ({ id, style }) => {
        const { editor, player } = (window as any).__cutline;
        editor.getState().commit('Style', (d: any) => Object.assign(d.clips[id].style, { text: undefined, ...style }));
        for (let i = 0; i < 2; i++) {
          await new Promise((r) => setTimeout(r, 400)); // font loads, then redraws
          player.requestRender();
        }
        await new Promise((r) => setTimeout(r, 200));
        const bmp = await createImageBitmap(await player.snapshot());
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = c.getContext('2d')!;
        ctx.drawImage(bmp, 0, 0);
        const px = ctx.getImageData(0, 0, c.width, c.height).data;
        const mask: number[] = [];
        for (let i = 0; i < px.length; i += 4) mask.push(px[i] > 200 && px[i + 1] > 200 && px[i + 2] > 200 ? 1 : 0);
        return mask;
      },
      { id, style },
    );
  const count = (m: number[]) => m.reduce((a, b) => a + b, 0);
  const diff = (a: number[], b: number[]) => a.reduce((n, v, i) => n + (v !== b[i] ? 1 : 0), 0);
  const anton = await render({ fontFamily: 'Anton', fontWeight: 400, italic: false });
  const antonItalic = await render({ fontFamily: 'Anton', fontWeight: 400, italic: true });
  expect(count(anton)).toBeGreaterThan(500);
  expect(diff(anton, antonItalic)).toBeGreaterThan(count(anton) * 0.2); // visibly slanted
  const light = await render({ fontFamily: 'Roboto', fontWeight: 400, italic: true });
  const black = await render({ fontFamily: 'Roboto', fontWeight: 900, italic: true });
  expect(count(black)).toBeGreaterThan(count(light) * 1.3); // bold stays bold in italic
});

test('imported fonts belong to their project: used by titles, gone in other projects', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['BrandFont.woff2']);
  await waitForMediaReady(page);
  await page.keyboard.press('t');
  const id = (await state(page)).clips.find((c) => c.type === 'text').id;
  await page.evaluate((cid) => (window as any).__cutline.editor.getState().commit('Font', (d: any) => (d.clips[cid].style.fontFamily = 'BrandFont')), id);
  const faces = () => page.evaluate(() => [...(document as any).fonts].filter((f: any) => f.family.replace(/"/g, '') === 'BrandFont' && f.status === 'loaded').length);
  await expect.poll(faces).toBe(1);
  await expect(page.getByRole('button', { name: 'More options for BrandFont.woff2' })).toBeVisible();
  await page.getByRole('button', { name: 'More options for BrandFont.woff2' }).click();
  await expect(page.getByRole('menuitem', { name: /Remove \(used 1×\)/ })).toBeVisible(); // counted as used by the title
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => (window as any).__cutline.editor.getState().saveState === 'saved');
  const first = (await page.evaluate(() => (window as any).__cutline.editor.getState().project.id)) as string;
  // A new project doesn't see it (so its preview can't use a font its export wouldn't have).
  await page.getByRole('button', { name: 'Project menu' }).click();
  await page.getByRole('menuitem', { name: 'New project…' }).click();
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForFunction((pid) => (window as any).__cutline.editor.getState().project.id !== pid, first);
  await expect.poll(faces).toBe(0);
  // Back in the first project it is available again.
  await page.getByRole('button', { name: 'Project menu' }).click();
  await page.getByRole('menuitem', { name: 'All projects…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^More options for / }).last().click();
  await page.getByRole('menuitem', { name: 'Open' }).click();
  await page.waitForFunction((pid) => (window as any).__cutline.editor.getState().project.id === pid, first);
  await expect.poll(faces).toBe(1);
});

test('every clip can be selected from the keyboard, including stacked ones', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['landscape.mp4', 'music.mp3']);
  await waitForMediaReady(page);
  await seek(page, 1);
  await page.keyboard.press('t'); // a title over the video, music underneath
  await page.keyboard.press('Escape');
  await page.locator('.tl-scroll').focus();
  const selected = async () => {
    const s = await state(page);
    return s.clips.find((c) => c.id === s.selection[0])?.type;
  };
  await page.keyboard.press('d');
  expect(await selected()).toBe('text');
  await page.keyboard.press('d');
  expect(await selected()).toBe('video');
  await page.keyboard.press('d');
  expect(await selected()).toBe('audio');
  await page.keyboard.press('Alt+ArrowUp');
  expect(await selected()).toBe('video');
  await page.keyboard.press('Alt+ArrowUp');
  expect(await selected()).toBe('text');
  await page.keyboard.press('Alt+ArrowDown');
  await page.keyboard.press('Alt+ArrowDown');
  expect(await selected()).toBe('audio');
  // …and then edited: the music, which sits under the footage, is deleted from the keyboard.
  await page.keyboard.press('Delete');
  expect((await state(page)).clips.map((c) => c.type).sort()).toEqual(['text', 'video']);
});

test('keys go where users expect: Escape closes dialogs, Space plays after clicking a button, undo works from a slider', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['landscape.mp4']);
  await waitForMediaReady(page);
  await selectFirst(page, 'video');
  await page.keyboard.press('ControlOrMeta+e');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await state(page)).selection).toHaveLength(1); // Escape closed the dialog, not the selection

  await page.keyboard.press('m'); // two undoable steps
  await page.keyboard.press('m');
  const before = (await state(page)).past;
  await page.getByRole('button', { name: /^Undo/ }).click();
  await page.keyboard.press('Space'); // plays; doesn't press Undo again
  await page.waitForFunction(() => (window as any).__cutline.playback.getState().playing);
  await page.keyboard.press('Space');
  expect((await state(page)).past).toBe(before - 1);

  await page.getByRole('tab', { name: 'Video', exact: true }).click();
  const slider = page.getByRole('slider', { name: 'Opacity' }).first();
  await slider.focus();
  await page.keyboard.press('ArrowLeft'); // an edit from the slider
  const opacity = () => page.evaluate(() => {
    const s = (window as any).__cutline.editor.getState();
    return s.project.clips[s.selection[0]].transform.opacity;
  });
  expect(await opacity()).toBeLessThan(1);
  await page.keyboard.press('ControlOrMeta+z'); // reaches the app while the slider has focus
  expect(await opacity()).toBe(1);
});

test('a typed value lands on the clip it was typed for, and just tabbing through fields changes nothing', async ({ page }) => {
  await openEditor(page);
  await page.keyboard.press('t'); // clip A at 0
  await seek(page, 6);
  await page.keyboard.press('t'); // clip B at 6
  await expect.poll(async () => (await state(page)).clips.length).toBe(2);
  const [a, b] = (await state(page)).clips.map((c) => c.id);
  await page.evaluate((id) => (window as any).__cutline.editor.getState().select([id]), a);
  const x = page.locator('.xy-field').first().getByRole('textbox', { name: 'X' });
  await x.waitFor();
  const past = (await state(page)).past;
  await x.focus();
  await x.blur(); // focus and leave: no edit, no undo step
  expect((await state(page)).past).toBe(past);
  await x.fill('123');
  await page.locator(`[data-clip="${b}"]`).click(); // select B before the field commits
  const xs = await page.evaluate(([a, b]) => {
    const c = (window as any).__cutline.editor.getState().project.clips;
    return [c[a].transform.x, c[b].transform.x];
  }, [a, b]);
  expect(xs).toEqual([123, 0]);
});

test('a colour background added over footage goes underneath it', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['landscape.mp4']);
  await waitForMediaReady(page);
  await seek(page, 1);
  await page.getByRole('tab', { name: 'Elements' }).click();
  await page.getByRole('button', { name: /^Add .* background$/ }).first().click();
  const s = await state(page);
  const index = (type: string) => s.tracks.findIndex((t) => t.id === s.clips.find((c) => c.type === type).trackId);
  expect(index('shape')).toBeGreaterThan(index('video')); // tracks are listed top to bottom
});

test('a format picked before importing is kept', async ({ page }) => {
  await openEditor(page);
  await page.getByRole('group', { name: 'Canvas format' }).getByRole('button').nth(1).click();
  const chosen = (await state(page)).settings;
  expect(chosen.chosen).toBe(true);
  await importFiles(page, ['landscape.mp4']);
  await waitForMediaReady(page);
  const s = (await state(page)).settings;
  expect([s.width, s.height]).toEqual([chosen.width, chosen.height]);
});

test('a video transition crossfades the sound instead of dipping it to silence', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['red.mp4']); // a steady tone
  await waitForMediaReady(page);
  await seek(page, 1.5);
  await page.keyboard.press('s');
  await commit(page, (d) => {
    const a: any = (Object.values(d.clips) as any[]).sort((x, y) => x.start - y.start)[0];
    a.transitionOut = { type: 'crossfade', duration: 1 };
  });
  const file = await exportVia(page, out('xfade.mp4'));
  const steady = meanVolume(file, 0.3, 0.6);
  const atCut = meanVolume(file, 1.4, 0.2);
  expect(atCut).toBeGreaterThan(steady - 3);
});

test('a freeze frame holds the picture as it was, animation included', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['landscape.mp4']);
  await waitForMediaReady(page);
  await commit(page, (d) => {
    const c: any = Object.values(d.clips)[0];
    c.keyframes['transform.opacity'] = [
      { id: 'k1', t: 0, v: 1, ease: 'linear' },
      { id: 'k2', t: 4, v: 0.2, ease: 'linear' },
    ];
    c.animIn = { preset: 'fade', duration: 1 };
  });
  await seek(page, 2);
  await page.keyboard.press('Shift+F');
  const still = (await state(page)).clips.find((c) => c.freeze);
  expect(still.transform.opacity).toBeCloseTo(0.6, 2); // value at 2 s of the 1 → 0.2 ramp
  expect(still.animIn.preset).toBe('none'); // doesn't replay the clip's intro
});

test('clicking a layer drawn above the selected one selects it', async ({ page }) => {
  await openEditor(page);
  await page.keyboard.press('t'); // bottom title
  await page.keyboard.press('t'); // a second title on top, same place
  const [top, bottom] = await page.evaluate(() => {
    const s = (window as any).__cutline.editor.getState();
    const ids = s.project.tracks.flatMap((t: any) => (Object.values(s.project.clips) as any[]).filter((c) => c.trackId === t.id).map((c) => c.id));
    return [ids[0], ids[ids.length - 1]];
  });
  await page.evaluate((id) => (window as any).__cutline.editor.getState().select([id]), bottom);
  // The box follows the last rendered frame (fonts load first): let it settle.
  await page.locator('polygon.gizmo-box').first().waitFor();
  await page.waitForTimeout(500);
  const box = (await page.locator('polygon.gizmo-box').first().boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  expect((await state(page)).selection).toEqual([top]);
});

test('a duplicated project is independent: its media survives deleting the original', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['red.mp4']);
  await waitForMediaReady(page);
  await page.waitForFunction(() => (Object.values((window as any).__cutline.editor.getState().project.assets) as any[]).every((a) => a.stored));
  await page.waitForFunction(() => (window as any).__cutline.editor.getState().saveState === 'saved');
  const original = await page.evaluate(() => {
    const p = (window as any).__cutline.editor.getState().project;
    return { id: p.id, asset: Object.keys(p.assets)[0] };
  });
  page.on('dialog', (d) => d.accept());
  const cards = () => page.getByRole('dialog').getByRole('button', { name: /^More options for / });
  await page.getByRole('button', { name: 'Project menu' }).click();
  await page.getByRole('menuitem', { name: 'All projects…' }).click();
  await cards().first().click();
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect(cards()).toHaveCount(2);
  // Open the copy, then delete the original.
  await cards().first().click();
  await page.getByRole('menuitem', { name: 'Open' }).click();
  await page.waitForFunction((id) => (window as any).__cutline.editor.getState().project.id !== id, original.id);
  const copyAsset = await page.evaluate(() => Object.keys((window as any).__cutline.editor.getState().project.assets)[0]);
  expect(copyAsset).not.toBe(original.asset);
  await page.getByRole('button', { name: 'Project menu' }).click();
  await page.getByRole('menuitem', { name: 'All projects…' }).click();
  await cards().last().click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(cards()).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    const real = Date.now;
    Date.now = () => real() + 3600_000;
    try {
      await (window as any).__cutline.storage.collectGarbage();
    } finally {
      Date.now = real;
    }
  });
  const file = await exportVia(page, out('dup-copy.mp4'));
  expect(near(regionColor(file, 1, 0.05, 0.05), [250, 25, 0])).toBe(true);
});

test('a translucent text background is even across lines (no darker bands)', async ({ page }) => {
  await openEditor(page);
  await page.keyboard.press('t');
  const id = (await state(page)).clips[0].id;
  await commit(page, (d) => {
    const c: any = d.clips[Object.keys(d.clips)[0]];
    c.text = 'WWWW\nWWWW\nWWWW';
    Object.assign(c.style, { backgroundColor: '#ff0000', backgroundOpacity: 0.5, backgroundPadding: 0.6, lineHeight: 1.0 });
  });
  const reds = await page.evaluate(async (cid) => {
    const { player, editor } = (window as any).__cutline;
    editor.getState().select([]);
    player.requestRender();
    await new Promise((r) => setTimeout(r, 600));
    player.requestRender();
    await new Promise((r) => setTimeout(r, 200));
    const bmp = await createImageBitmap(await player.snapshot(640));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    // Scan the left padding of the box (no glyphs there) from top to bottom.
    const out: number[] = [];
    const x = Math.round(bmp.width / 2);
    const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    let left = x;
    while (left > 0 && px[(Math.round(bmp.height / 2) * bmp.width + left) * 4] > 60) left--;
    for (let y = 0; y < bmp.height; y++) {
      const i = (y * bmp.width + left + 3) * 4;
      if (px[i] > 60 && px[i + 1] < 40) out.push(px[i]);
    }
    return out;
  }, id);
  expect(reds.length).toBeGreaterThan(40);
  // Inside the box (away from its rounded top and bottom edges) the colour is uniform; a
  // doubled overlap between lines would read far brighter.
  const inner = reds.slice(10, -10);
  expect(Math.max(...inner) - Math.min(...inner)).toBeLessThanOrEqual(10);
});

test('blur on a title spreads past the letters instead of being cut off at their box', async ({ page }) => {
  await openEditor(page);
  await page.keyboard.press('t');
  const extent = async (blur: number) => {
    await page.evaluate((amount) => {
      (window as any).__cutline.editor.getState().commit('Blur', (d: any) => {
        const c: any = d.clips[Object.keys(d.clips)[0]];
        c.text = 'II';
        c.effects = amount ? [{ id: 'fx1', type: 'blur', enabled: true, params: { amount } }] : [];
      });
    }, blur);
    return page.evaluate(async () => {
      const { player, editor } = (window as any).__cutline;
      editor.getState().select([]);
      for (let i = 0; i < 2; i++) {
        await new Promise((r) => setTimeout(r, 400));
        player.requestRender();
      }
      await new Promise((r) => setTimeout(r, 200));
      const bmp = await createImageBitmap(await player.snapshot(640));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0);
      const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
      let x0 = bmp.width;
      let x1 = 0;
      for (let y = 0; y < bmp.height; y++)
        for (let x = 0; x < bmp.width; x++) {
          if (px[(y * bmp.width + x) * 4] > 12) {
            x0 = Math.min(x0, x);
            x1 = Math.max(x1, x);
          }
        }
      return x1 - x0;
    });
  };
  const sharp = await extent(0);
  const blurred = await extent(40);
  expect(sharp).toBeGreaterThan(10);
  expect(blurred).toBeGreaterThan(sharp + 15); // clipped at the text box it reached only ~+7
});

test('a clip’s start and duration can be typed', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['landscape.mp4']); // 30 fps project
  await waitForMediaReady(page);
  await selectFirst(page, 'video');
  await page.getByRole('textbox', { name: 'Clip start' }).fill('2');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Clip duration' }).fill('00:00:01:15');
  await page.keyboard.press('Enter');
  const c = (await state(page)).clips[0];
  expect(c.start).toBeCloseTo(2, 6);
  expect(c.duration).toBeCloseTo(1.5, 6);
  await page.keyboard.press('ControlOrMeta+z');
  expect((await state(page)).clips[0].duration).toBeCloseTo(10, 6);
});

test('pressing L again fast-forwards (2×) and K stops', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['landscape.mp4']); // 10 s
  await waitForMediaReady(page);
  await seek(page, 0);
  await page.locator('.tl-scroll').focus();
  await page.keyboard.press('l');
  await page.waitForFunction(() => (window as any).__cutline.playback.getState().playing);
  await page.keyboard.press('l');
  await expect(page.getByRole('status', { name: 'Playing at 2 times speed' })).toBeVisible();
  const t0 = await page.evaluate(() => (window as any).__cutline.playback.getState().time);
  await page.waitForTimeout(1000);
  const t1 = await page.evaluate(() => (window as any).__cutline.playback.getState().time);
  expect(t1 - t0).toBeGreaterThan(1.6);
  await page.keyboard.press('k');
  const s = await page.evaluate(() => (window as any).__cutline.playback.getState());
  expect([s.playing, s.rate]).toEqual([false, 1]);
});

test('attributes can be copied between clips, and context menus open from the keyboard', async ({ page }) => {
  await openEditor(page);
  await page.keyboard.press('t'); // A
  await seek(page, 6);
  await page.keyboard.press('t'); // B
  const [a, b] = (await state(page)).clips.map((c) => c.id);
  await page.evaluate((id) => {
    (window as any).__cutline.editor.getState().commit('Style A', (d: any) => {
      const c = d.clips[id];
      c.effects = [{ id: 'fxA', type: 'blur', enabled: true, params: { amount: 12 } }];
      c.keyframes = { 'transform.opacity': [{ id: 'k1', t: 0, v: 0, ease: 'linear' }, { id: 'k2', t: 1, v: 1, ease: 'linear' }], 'fx.fxA.amount': [{ id: 'k3', t: 0, v: 30, ease: 'linear' }] };
      c.style.color = '#ff00aa';
    });
    (window as any).__cutline.editor.getState().select([id]);
  }, a);
  await page.locator('.tl-scroll').focus();
  await page.keyboard.press('ControlOrMeta+c');
  await page.evaluate((id) => (window as any).__cutline.editor.getState().select([id]), b);
  await page.keyboard.press('ControlOrMeta+Alt+v');
  const pasted = await page.evaluate((id) => (window as any).__cutline.editor.getState().project.clips[id], b);
  expect(pasted.effects.map((e: any) => e.type)).toEqual(['blur']);
  expect(pasted.effects[0].id).not.toBe('fxA');
  expect(Object.keys(pasted.keyframes).sort()).toEqual([`fx.${pasted.effects[0].id}.amount`, 'transform.opacity']);
  expect(pasted.style.color).toBe('#ff00aa');
  // Shift+F10 opens the selected clip's menu without a mouse.
  await page.locator('.tl-scroll').focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: /Split at playhead/ })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('a long press opens context menus on touch screens', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['red.mp4']);
  await waitForMediaReady(page);
  const card = (await page.getByRole('listitem', { name: /red\.mp4/ }).boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const point = { x: card.x + card.width / 2, y: card.y + card.height / 3 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.waitForTimeout(800);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.getByRole('menuitem', { name: /Relink file/ })).toBeVisible();
});

test('on a phone, Edit opens without a selection and Record audio opens the recorder', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openEditor(page);
  await page.getByRole('navigation', { name: 'Editor tools' }).getByRole('button', { name: 'Edit' }).click();
  const sheet = page.getByRole('dialog', { name: 'Edit' });
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await page.getByRole('button', { name: 'Record audio' }).click();
  await expect(page.getByRole('region', { name: 'Voiceover recorder' })).toBeVisible();
});
