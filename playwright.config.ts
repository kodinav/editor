import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests drive real Chrome (WebCodecs, WebGL2, OPFS) and verify
 * exported files independently with ffmpeg.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  // One retry absorbs timing flakes on a loaded machine; Playwright still reports them as "flaky".
  retries: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE ?? 'http://localhost:5174',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  },
  webServer: process.env.E2E_BASE ? undefined : {
    command: 'npx vite --port 5174 --strictPort',
    port: 5174,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
