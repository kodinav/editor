import base from './playwright.config';
import { defineConfig } from '@playwright/test';

/**
 * The same E2E suite in Playwright's WebKit (Safari's engine). Its profile has
 * no file storage (like Safari private browsing), no fake microphone and no
 * touch emulation over CDP, so the tests that need any of those are left out:
 * anything that waits for media to be stored, reopens stored media, or unpacks
 * a project package to storage.
 */
export default defineConfig({
  ...base,
  grepInvert:
    /voiceover recording|offline media can be relinked|survives storage cleanup|after their local copy is saved|project package with media reopens|imported fonts belong to their project|duplicated project is independent|long press opens context menus/,
  use: { ...base.use, channel: undefined, browserName: 'webkit', launchOptions: {} },
});
