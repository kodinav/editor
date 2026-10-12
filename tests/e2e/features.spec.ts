import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { brightFrames, countPixels, exportVia, importFiles, loudness, meanVolume, openEditor, probe, regionColor, seek, state, waitForMediaReady, fixture } from './helpers';

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

test('media can be previewed and just a chosen part added to the timeline', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['landscape.mp4', 'red.mp4']); // first import lays both out; we add another part below
  await waitForMediaReady(page);
  const before = (await state(page)).clips.length;
  await page.getByRole('listitem', { name: /landscape\.mp4/ }).click();
  const monitor = page.getByRole('region', { name: /Source preview: landscape\.mp4/ });
  await expect(monitor).toBeVisible();
  // The picture really loads (not just the controls).
  await page.waitForFunction(() => ((document.querySelector('.source-media video') as HTMLVideoElement | null)?.videoWidth ?? 0) > 0);
  await page.getByRole('slider', { name: 'Position in source' }).fill('2');
  await page.keyboard.press('i');
  await page.getByRole('slider', { name: 'Position in source' }).fill('5');
  await page.keyboard.press('o');
  await monitor.getByRole('button', { name: /Add to timeline/ }).click();
  await expect(monitor).toHaveCount(0); // back to the program view
  const s = await state(page);
  expect(s.clips.length).toBe(before + 1);
  const added = s.clips.find((c) => c.id === s.selection[0]);
  expect(added.sourceIn).toBeCloseTo(2, 1);
  expect(added.duration).toBeCloseTo(3, 1);
});

test('single-key shortcuts can be turned off (WCAG 2.1.4)', async ({ page }) => {
  await openEditor(page);
  await page.keyboard.press('Shift+?');
  await page.getByRole('switch', { name: 'Single-key shortcuts' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('t'); // would add a title
  expect((await state(page)).clips).toHaveLength(0);
  await page.keyboard.press('ControlOrMeta+e'); // shortcuts with a modifier still work
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('a mask shows only part of a layer, and limits where an adjustment layer applies', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['blue.mp4']);
  await waitForMediaReady(page);
  await importFiles(page, ['red.mp4']);
  await waitForMediaReady(page);
  await page.getByRole('button', { name: 'Add red.mp4 to timeline' }).click();
  await commit(page, (d) => {
    const tracks = d.tracks.filter((t: any) => t.kind === 'video');
    const red: any = Object.values(d.clips).find((c: any) => c.name === 'red.mp4');
    red.trackId = tracks[0].id;
    red.start = 0;
    red.duration = 2;
  });
  await page.evaluate(() => {
    const s = (window as any).__cutline.editor.getState();
    const red: any = Object.values(s.project.clips).find((c: any) => c.name === 'red.mp4');
    s.select([red.id]);
  });
  const library = page.getByRole('tablist', { name: 'Library' });
  await library.getByRole('tab', { name: 'Effects' }).click();
  await page.getByRole('button', { name: /^Mask/ }).click();
  const fx = await page.evaluate(() => {
    const s = (window as any).__cutline.editor.getState();
    const red: any = Object.values(s.project.clips).find((c: any) => c.name === 'red.mp4');
    return red.effects.map((e: any) => e.type);
  });
  expect(fx).toEqual(['mask']);
  // A rectangle in the top-left quarter: red there, the blue track below everywhere else.
  await commit(page, (d) => {
    const red: any = Object.values(d.clips).find((c: any) => c.name === 'red.mp4');
    Object.assign(red.effects[0].params, { x: 25, y: 25, width: 50, height: 50, feather: 0 });
  });
  let file = await exportVia(page, out('mask-rect.mp4'));
  expect(near(regionColor(file, 1, 0.2, 0.2), [255, 0, 0], 60)).toBe(true);
  expect(near(regionColor(file, 1, 0.75, 0.2), [0, 15, 255], 60)).toBe(true);
  expect(near(regionColor(file, 1, 0.2, 0.75), [0, 15, 255], 60)).toBe(true);
  // An inverted ellipse cuts a hole in the middle instead.
  await commit(page, (d) => {
    const red: any = Object.values(d.clips).find((c: any) => c.name === 'red.mp4');
    Object.assign(red.effects[0].params, { shape: 'ellipse', x: 50, y: 50, width: 40, height: 40, invert: true });
  });
  file = await exportVia(page, out('mask-ellipse.mp4'));
  expect(near(regionColor(file, 1, 0.47, 0.47, 0.06, 0.06), [0, 15, 255], 60)).toBe(true);
  expect(near(regionColor(file, 1, 0.02, 0.02), [255, 0, 0], 60)).toBe(true);
  // Ellipse, not rectangle: the box's corner (inside a rectangle mask) stays red.
  expect(near(regionColor(file, 1, 0.31, 0.31, 0.02, 0.02), [255, 0, 0], 60)).toBe(true);

  // Adjustment layer: invert colours on the left half of the frame only.
  await commit(page, (d) => {
    const red: any = Object.values(d.clips).find((c: any) => c.name === 'red.mp4');
    delete d.clips[red.id];
  });
  await page.keyboard.press('Escape'); // close the export dialog
  await library.getByRole('tab', { name: 'Elements' }).click();
  await page.getByRole('button', { name: /Adjustment layer/ }).click();
  await commit(page, (d) => {
    const adj: any = Object.values(d.clips).find((c: any) => c.type === 'adjustment');
    adj.start = 0;
    adj.duration = 2;
    adj.effects = [
      { id: 'i', type: 'invert', enabled: true, params: { amount: 100 } },
      { id: 'm', type: 'mask', enabled: true, params: { shape: 'rectangle', x: 25, y: 50, width: 50, height: 200, feather: 0, roundness: 0, invert: false } },
    ];
  });
  file = await exportVia(page, out('mask-adjust.mp4'));
  expect(near(regionColor(file, 1, 0.2, 0.5), [255, 240, 0], 60)).toBe(true); // blue inverted → yellow
  expect(near(regionColor(file, 1, 0.75, 0.5), [0, 15, 255], 60)).toBe(true); // untouched, not black
});

test('audio effects change the exported sound (added from the inspector)', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['music.mp3']);
  await waitForMediaReady(page);
  const id = (await state(page)).clips[0].id;
  await page.evaluate((cid) => (window as any).__cutline.editor.getState().select([cid]), id);
  await page.getByRole('tablist', { name: 'Clip properties' }).getByRole('tab', { name: 'Audio' }).click();
  await page.getByRole('button', { name: 'Add audio effect' }).click();
  await page.getByRole('menuitem', { name: 'Telephone' }).click();
  await expect(page.getByRole('button', { name: 'Bypass Low cut' })).toBeVisible();
  const types = await page.evaluate((cid) => (window as any).__cutline.editor.getState().project.clips[cid].audioEffects.map((e: any) => e.type), id);
  expect(types).toEqual(['highpass', 'lowpass', 'eq']);
  const wet = await exportVia(page, out('telephone.wav'), async () => {
    await page.getByLabel('Format').selectOption('wav');
  });
  // The music is almost all bass: a telephone band (400 Hz – 3.2 kHz) leaves little of it.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Bypass Low cut' }).click();
  await page.getByRole('button', { name: 'Bypass High cut' }).click();
  await page.getByRole('button', { name: 'Bypass Equalizer' }).click();
  const dry = await exportVia(page, out('telephone-bypassed.wav'), async () => {
    await page.getByLabel('Format').selectOption('wav');
  });
  expect(meanVolume(dry, 1, 5)).toBeGreaterThan(-30);
  expect(meanVolume(wet, 1, 5)).toBeLessThan(meanVolume(dry, 1, 5) - 8);
  // The same chain built from ffmpeg's own filters lands on the same level.
  const reference = 'highpass=f=400:p=2:w=0.5412:t=q,highpass=f=400:p=2:w=1.3066:t=q,lowpass=f=3200:p=2:w=0.5412:t=q,lowpass=f=3200:p=2:w=1.3066:t=q,equalizer=f=1500:t=q:w=0.9:g=6';
  expect(Math.abs(meanVolume(wet, 1, 5) - meanVolume(dry, 1, 5, reference))).toBeLessThan(1);
});

test('loudness: a clip can be normalized, and so can the whole export', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['speech.wav']);
  await waitForMediaReady(page);
  const id = (await state(page)).clips[0].id;
  await page.evaluate((cid) => (window as any).__cutline.editor.getState().select([cid]), id);
  await page.getByRole('tablist', { name: 'Clip properties' }).getByRole('tab', { name: 'Audio' }).click();
  await page.getByLabel('Loudness target').selectOption('-23');
  await page.getByRole('button', { name: 'Normalize loudness' }).click();
  await expect(page.getByText(/Measured -?[\d.]+ LUFS/)).toBeVisible();
  let file = await exportVia(page, out('clip-normalized.wav'), async () => {
    await page.getByLabel('Format').selectOption('wav');
  });
  expect(Math.abs(loudness(file).lufs - -23)).toBeLessThan(0.7);

  // Now make it far too quiet and let the export bring the whole mix to -14 LUFS without clipping.
  await page.keyboard.press('Escape');
  await commit(page, (d) => {
    const c: any = Object.values(d.clips)[0];
    c.volume *= 0.3;
  });
  file = await exportVia(page, out('export-normalized.wav'), async () => {
    await page.getByLabel('Format').selectOption('wav');
    await page.getByLabel('Loudness', { exact: true }).selectOption('-14');
  });
  const m = loudness(file);
  expect(Math.abs(m.lufs - -14)).toBeLessThan(1);
  expect(m.peak).toBeLessThanOrEqual(-1);
  await expect(page.getByText(/LUFS → -14 LUFS/)).toBeVisible();
});

/** Horizontal extent (0..1 of the frame) of pixels of one colour in the live preview, within a vertical band. */
async function inkExtent(page: Page, color: 'white' | 'yellow', y0 = 0, y1 = 1) {
  return page.evaluate(
    async ({ color, y0, y1 }) => {
      const { player } = (window as any).__cutline;
      player.requestRender();
      await new Promise((r) => setTimeout(r, 250));
      const src = player.compositor.canvas as HTMLCanvasElement;
      const c = new OffscreenCanvas(src.width, src.height);
      const ctx = c.getContext('2d')!;
      ctx.drawImage(src, 0, 0);
      const px = ctx.getImageData(0, 0, c.width, c.height).data;
      let min = Infinity;
      let max = -Infinity;
      let count = 0;
      for (let y = Math.floor(y0 * c.height); y < Math.floor(y1 * c.height); y++) {
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          const hit = color === 'white' ? px[i] > 200 && px[i + 1] > 200 && px[i + 2] > 200 : px[i] > 200 && px[i + 1] > 170 && px[i + 2] < 110;
          if (!hit) continue;
          count++;
          if (x < min) min = x;
          if (x > max) max = x;
        }
      }
      return { min: min / c.width, max: max / c.width, count };
    },
    { color, y0, y1 },
  );
}

test('right-to-left text: reveals from the right, highlights the spoken word in place, and uses the bundled Hebrew font', async ({ page }) => {
  await openEditor(page);
  await page.keyboard.press('t');
  const id = (await state(page)).clips[0].id;
  await page.evaluate((cid) => {
    (window as any).__cutline.editor.getState().commit('rtl', (d: any) => {
      const c = d.clips[cid];
      c.text = 'שלום עולם';
      c.start = 0;
      c.duration = 5;
      c.style.fontFamily = 'Rubik';
      c.style.fontWeight = 700;
      c.style.color = '#ffffff';
      c.animIn = { preset: 'typewriter', duration: 2 };
    });
  }, id);
  // The Hebrew subset of the bundled font is fetched because this text needs it (and only then).
  await expect
    .poll(() => page.evaluate(() => [...(document as any).fonts].some((f: FontFace) => f.family.includes('Rubik') && f.status === 'loaded' && /U\+0?590/i.test(f.unicodeRange))))
    .toBe(true);
  expect(await page.evaluate(() => [...(document as any).fonts].some((f: FontFace) => f.family.includes('Rubik') && /U\+0?600/i.test(f.unicodeRange)))).toBe(false); // Arabic not needed
  await seek(page, 3);
  const full = await inkExtent(page, 'white', 0.3, 0.7);
  expect(full.count).toBeGreaterThan(300);
  // Half-way through the typewriter reveal only the first word shows — and in Hebrew that is the right-hand one.
  await seek(page, 1);
  const half = await inkExtent(page, 'white', 0.3, 0.7);
  expect(half.count).toBeGreaterThan(100);
  expect(Math.abs(half.max - full.max)).toBeLessThan(0.01);
  expect(half.min).toBeGreaterThan(full.min + (full.max - full.min) * 0.15);

  // Karaoke captions: the first spoken word is the right-hand one, and it is the one that lights up.
  await page.getByRole('tablist', { name: 'Library' }).getByRole('tab', { name: 'Captions' }).click();
  await seek(page, 0);
  await page.getByRole('button', { name: /Add caption at playhead/ }).click();
  await page.evaluate(() => {
    (window as any).__cutline.editor.getState().commit('rtl caption', (d: any) => {
      const cap: any = Object.values(d.clips).find((c: any) => c.type === 'caption');
      cap.text = 'שלום עולם';
      cap.start = 0;
      cap.duration = 4;
      cap.words = [
        { text: 'שלום', start: 0, end: 2 },
        { text: 'עולם', start: 2, end: 4 },
      ];
      const track = d.tracks.find((t: any) => t.id === cap.trackId);
      track.captionStyle.activeWordColor = '#ffee00';
      track.captionStyle.fontFamily = 'Rubik';
      const title: any = Object.values(d.clips).find((c: any) => c.type === 'text');
      delete d.clips[title.id];
    });
  });
  await seek(page, 1);
  const all = await inkExtent(page, 'white', 0.6, 1);
  const first = await inkExtent(page, 'yellow', 0.6, 1);
  expect(first.count).toBeGreaterThan(30);
  expect(first.min).toBeGreaterThan(all.max - 0.005); // the yellow word sits to the right of the white one
  await seek(page, 3);
  const second = await inkExtent(page, 'yellow', 0.6, 1);
  expect(second.max).toBeLessThan(first.min);

  // The export worker lays it out the same way.
  const file = await exportVia(page, out('rtl.mp4'));
  const yellow = (t: number, x: number) => countPixels(file, t, x, 0.6, 0.5, 0.4, (r, g, b) => r > 190 && g > 160 && b < 120);
  expect(yellow(1, 0.5)).toBeGreaterThan(50);
  expect(yellow(1, 0)).toBeLessThan(5);
  expect(yellow(3, 0)).toBeGreaterThan(50);
  expect(yellow(3, 0.5)).toBeLessThan(5);
});

test('colour tools: a .cube LUT, levels and curves all reach the export', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['red.mp4']);
  await waitForMediaReady(page);
  const id = (await state(page)).clips[0].id;
  await page.evaluate((cid) => (window as any).__cutline.editor.getState().select([cid]), id);
  // Add a LUT effect from the inspector and give it a file that sends red to green.
  await page.getByRole('tablist', { name: 'Clip properties' }).getByRole('tab', { name: 'Effects' }).click();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('menuitem', { name: 'LUT', exact: true }).click();
  let cube = 'TITLE "Swap"\nLUT_3D_SIZE 2\n';
  for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) cube += `${b} ${r} ${g}\n`;
  await page.getByLabel('LUT file').setInputFiles({ name: 'swap.cube', mimeType: 'text/plain', buffer: Buffer.from(cube) });
  await expect(page.getByLabel('LUT', { exact: true })).toHaveValue(/lut/);
  let file = await exportVia(page, out('lut.mp4'));
  expect(near(regionColor(file, 0.5, 0.4, 0.4), [0, 255, 0], 60)).toBe(true);

  // A file that isn't a LUT is refused with a reason, and nothing changes.
  await page.keyboard.press('Escape');
  await page.getByLabel('LUT file').setInputFiles({ name: 'notes.cube', mimeType: 'text/plain', buffer: Buffer.from('LUT_1D_SIZE 4\n0 0 0\n') });
  await expect(page.getByText('couldn’t be used as a LUT')).toBeVisible();

  // The LUT is saved with the project and survives a reload.
  await page.waitForFunction(() => (window as any).__cutline.editor.getState().saveState === 'saved');
  await page.reload();
  await page.waitForFunction(() => Object.keys((window as any).__cutline?.editor.getState().project.clips ?? {}).length === 1);
  await waitForMediaReady(page);
  const kept = await page.evaluate(() => {
    const p = (window as any).__cutline.editor.getState().project;
    const fx = (Object.values(p.clips)[0] as any).effects[0];
    return { has: !!p.luts?.[fx.params.lut], size: p.luts?.[fx.params.lut]?.size };
  });
  expect(kept).toEqual({ has: true, size: 2 });

  // Levels and curves: halve the output white, then pull the red channel's whites down.
  await commit(page, (d) => {
    const c: any = Object.values(d.clips)[0];
    c.effects = [{ id: 'lv', type: 'levels', enabled: true, params: { inBlack: 0, inWhite: 100, gamma: 1, outBlack: 0, outWhite: 50 } }];
  });
  file = await exportVia(page, out('levels.mp4'));
  expect(near(regionColor(file, 0.5, 0.4, 0.4), [128, 0, 0], 30)).toBe(true);
  await page.keyboard.press('Escape');
  await commit(page, (d) => {
    const c: any = Object.values(d.clips)[0];
    c.effects = [{ id: 'cv', type: 'curves', enabled: true, params: { channel: 'green', blacks: 100, shadows: 0, midtones: 0, highlights: 0, whites: 0 } }];
  });
  file = await exportVia(page, out('curves.mp4'));
  // Lifting green's blacks adds green to pure red (0 → about a quarter), and leaves red alone.
  const c = regionColor(file, 0.5, 0.4, 0.4);
  expect(c[0]).toBeGreaterThan(200);
  expect(c[1]).toBeGreaterThan(35);
  expect(c[1]).toBeLessThan(110);
});

test('roll, slip and slide edits, with the edit point shown in the preview while dragging', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['landscape.mp4']);
  await waitForMediaReady(page);
  for (const t of [3, 6]) {
    await seek(page, t);
    await page.keyboard.press('s');
  }
  const vids = async () => (await state(page)).clips.filter((c) => c.type === 'video');
  let [a, b, c] = await vids();
  expect([a.start, b.start, c.start]).toEqual([0, 3, 6]);
  const pps = await page.evaluate(() => (window as any).__cutline.editor.getState().pxPerSec);
  const box = async (id: string) => (await page.locator(`[data-clip="${id}"]`).boundingBox())!;
  const drag = async (x: number, y: number, dx: number, during?: () => Promise<void>) => {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx / 2, y, { steps: 4 });
    await page.mouse.move(x + dx, y, { steps: 4 });
    if (during) await during();
    await page.mouse.up();
  };
  const peek = () => page.evaluate(() => (window as any).__cutline.player.peekTime as number | null);

  // Roll: Alt-drag the cut between A and B one second later.
  let r = await box(b.id);
  await page.keyboard.down('Alt');
  await drag(r.x + 2, r.y + 12, pps, async () => {
    expect(await peek()).toBeCloseTo(4, 1); // the preview shows the frame at the cut, the playhead stays put
  });
  await page.keyboard.up('Alt');
  expect(await peek()).toBeNull();
  [a, b, c] = await vids();
  expect(a.duration).toBeCloseTo(4, 1);
  expect([b.start, b.duration, b.sourceIn].map((v) => Math.round(v * 10) / 10)).toEqual([4, 2, 4]);
  expect([c.start, c.duration]).toEqual([6, 4]);
  expect(await page.evaluate(() => (window as any).__cutline.playback.getState().time)).toBe(6);

  // Slip: with the slip tool, drag B's content half a second to the left (later media), B stays where it is.
  await page.keyboard.press('y');
  r = await box(b.id);
  await drag(r.x + r.width / 2, r.y + 12, -pps / 2);
  [a, b, c] = await vids();
  expect([b.start, b.duration].map((v) => Math.round(v * 10) / 10)).toEqual([4, 2]);
  expect(b.sourceIn).toBeCloseTo(4.5, 1);

  // Slide: move B a second to the right; A grows and C shrinks so no gap opens.
  await page.keyboard.press('u');
  r = await box(b.id);
  await drag(r.x + r.width / 2, r.y + 12, pps);
  [a, b, c] = await vids();
  expect(a.duration).toBeCloseTo(5, 1);
  expect([b.start, b.duration].map((v) => Math.round(v * 10) / 10)).toEqual([5, 2]);
  expect(b.sourceIn).toBeCloseTo(4.5, 1);
  expect([c.start, c.duration, c.sourceIn].map((v) => Math.round(v * 10) / 10)).toEqual([7, 3, 7]);

  // Each drag is one undo step.
  await page.keyboard.press('v');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ControlOrMeta+z');
  [a, b, c] = await vids();
  expect([a.duration, b.start, b.duration, b.sourceIn, c.start]).toEqual([3, 3, 3, 3, 6]);
});

test('the preview can be zoomed and panned, and layers stay editable where they appear', async ({ page }) => {
  await openEditor(page);
  await page.keyboard.press('t');
  const id = (await state(page)).clips[0].id;
  const stage = page.locator('.preview-stage');
  const viewport = page.locator('.preview-viewport');
  const fit = (await stage.boundingBox())!;
  // Zoom from the menu.
  await page.getByRole('button', { name: /^Preview zoom/ }).click();
  await page.getByRole('menuitemcheckbox', { name: '200%' }).click();
  const settings = (await state(page)).settings;
  let big = (await stage.boundingBox())!;
  expect(big.width).toBeCloseTo(settings.width * 2, -1);
  // The wheel pans when zoomed in…
  const vp = (await viewport.boundingBox())!;
  await page.mouse.move(vp.x + vp.width / 2, vp.y + vp.height / 2);
  await page.mouse.wheel(120, 60);
  const panned = (await stage.boundingBox())!;
  expect(panned.x).toBeCloseTo(big.x - 120, 0);
  expect(panned.y).toBeCloseTo(big.y - 60, 0);
  // …and Ctrl + wheel zooms around the pointer: the point under it stays put.
  const px = vp.x + vp.width * 0.3;
  const py = vp.y + vp.height * 0.6;
  const under = { x: (px - panned.x) / panned.width, y: (py - panned.y) / panned.height };
  await page.mouse.move(px, py);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 200);
  await page.keyboard.up('Control');
  const out = (await stage.boundingBox())!;
  expect(out.width).toBeLessThan(panned.width * 0.8);
  expect((px - out.x) / out.width).toBeCloseTo(under.x, 2);
  expect((py - out.y) / out.height).toBeCloseTo(under.y, 2);

  // Zoomed out, a layer can be dragged with the frame scaled down: it moves by project pixels, not screen pixels.
  await page.getByRole('button', { name: /^Preview zoom/ }).click();
  await page.getByRole('menuitemcheckbox', { name: '25%' }).click();
  const small = (await stage.boundingBox())!;
  expect(small.width).toBeCloseTo(settings.width * 0.25, -1);
  const before = (await state(page)).clips.find((c) => c.id === id).transform;
  await page.mouse.move(small.x + small.width / 2, small.y + small.height / 2);
  await page.mouse.down();
  await page.mouse.move(small.x + small.width / 2 + 20, small.y + small.height / 2 + 10, { steps: 4 });
  await page.mouse.move(small.x + small.width / 2 + 50, small.y + small.height / 2 + 25, { steps: 4 });
  await page.mouse.up();
  const after = (await state(page)).clips.find((c) => c.id === id).transform;
  expect(after.x - before.x).toBeCloseTo(200, -1); // 50 screen px at 25 %
  expect(after.y - before.y).toBeCloseTo(100, -1);

  // Fit puts it back.
  await page.getByRole('button', { name: /^Preview zoom/ }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Fit' }).click();
  const back = (await stage.boundingBox())!;
  expect([back.x, back.y, back.width, back.height]).toEqual([fit.x, fit.y, fit.width, fit.height]);
});

test('a clip can be reversed: picture and sound run backwards together, in preview and export', async ({ page }) => {
  await openEditor(page);
  await importFiles(page, ['sync.mp4']); // flash + beep together at 1, 3, 5, 7, 9 s
  await waitForMediaReady(page);
  const id = (await state(page)).clips[0].id;
  // Use media 0.5 s .. 4.5 s (flashes at 1 s and 3 s), then reverse it from the Speed tab.
  await commit(page, (d) => {
    const c: any = Object.values(d.clips)[0];
    c.sourceIn = 0.5;
    c.duration = 4;
  });
  await page.evaluate((cid) => (window as any).__cutline.editor.getState().select([cid]), id);
  await page.getByRole('tablist', { name: 'Clip properties' }).getByRole('tab', { name: 'Speed' }).click();
  await page.getByRole('switch', { name: 'Play backwards' }).click();
  expect((await state(page)).clips[0].reversed).toBe(true);

  const file = await exportVia(page, out('reversed.mp4'));
  expect(probe(file).duration).toBeGreaterThan(3.9);
  // Forwards the flashes would start at 0.5 s and 2.5 s. Backwards they END where media 3 s and 1 s
  // play: timeline 1.5 s and 3.5 s.
  const flashes = brightFrames(file);
  const ends = flashes.filter((t, i) => i === flashes.length - 1 || flashes[i + 1] - t > 0.5).map((t) => t + 1 / 30);
  expect(ends).toHaveLength(2);
  expect(Math.abs(ends[0] - 1.5)).toBeLessThan(0.02);
  expect(Math.abs(ends[1] - 3.5)).toBeLessThan(0.02);
  // The beeps end with them: sound just before each point, silence right after.
  for (const t of [1.5, 3.5]) {
    expect(meanVolume(file, t - 0.06, 0.05), `beep before ${t}`).toBeGreaterThan(-35);
    expect(meanVolume(file, t + 0.03, 0.1), `quiet after ${t}`).toBeLessThan(-50);
  }
  // Nothing where the forward flashes would have been.
  expect(flashes.some((t) => Math.abs(t - 0.55) < 0.04 || Math.abs(t - 2.55) < 0.04)).toBe(false);

  // Preview: playing a reversed clip steps down through the media without re-decoding for every frame.
  await page.keyboard.press('Escape');
  await seek(page, 0.2);
  await page.keyboard.press('Space');
  const samples: number[] = [];
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(200);
    const ts = await page.evaluate((cid) => (window as any).__cutline.player.sources.stats().frames[cid] as number | null, id);
    if (ts !== null) samples.push(ts);
  }
  await page.keyboard.press('Space');
  const stats = await page.evaluate(() => (window as any).__cutline.player.sources.stats());
  expect(samples.length).toBeGreaterThan(4);
  for (let i = 1; i < samples.length; i++) expect(samples[i]).toBeLessThanOrEqual(samples[i - 1] + 1e-6);
  expect(samples[0] - samples[samples.length - 1]).toBeGreaterThan(0.8); // really moved back through the media
  expect(stats.restarts).toBeLessThan(12); // ~1.6 s played: a handful of windows, not one decode per frame
});
