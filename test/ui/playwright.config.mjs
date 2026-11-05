// The dashboard in a real browser. Apart from `npm test`: npm run test:ui
// (after npm install). Your own Chrome here; in CI the Chromium Playwright
// installs, or the browser in PLAYWRIGHT_CHANNEL.

import { defineConfig } from '@playwright/test'

const channel = process.env.PLAYWRIGHT_CHANNEL ?? (process.env.CI ? undefined : 'chrome')

export default defineConfig({
  testDir: '.',
  outputDir: '../../test-results',
  // One server per file, with the sessions its tests expect.
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  use: {
    ...(channel ? { channel } : {}),
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
})
