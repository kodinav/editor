import base from './playwright.config';
import { defineConfig } from '@playwright/test';

/**
 * The same E2E suite in Playwright's WebKit (Safari's engine). Its profile has
 * no file storage (like Safari private browsing) and no fake microphone, so
 * the tests that need either are left out.
 */
export default defineConfig({
  ...base,
  grepInvert: /voiceover recording|offline media can be relinked|survives storage cleanup/,
  use: { ...base.use, channel: undefined, browserName: 'webkit', launchOptions: {} },
});
