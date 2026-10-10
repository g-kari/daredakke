import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const results = fileURLToPath(new URL('../../test-results/', import.meta.url));

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.mjs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : 1,
  timeout: 30000,
  globalTimeout: 180000,
  reporter: [['list'], ['json', { outputFile: results + 'browser-results.json' }]],
  outputDir: results + 'browser',
  use: { baseURL: 'http://127.0.0.1:4317', serviceWorkers: 'block', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop-chromium', use: { browserName: 'chromium', viewport: { width: 1280, height: 900 } } },
    { name: 'mobile-chromium', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    cwd: repoRoot,
    command: 'npm run build && npm exec -- vite preview --host 127.0.0.1 --port 4317 --strictPort',
    url: 'http://127.0.0.1:4317',
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
