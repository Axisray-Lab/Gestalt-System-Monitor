import { defineConfig, devices } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, '../..');
const resultsRoot = resolve(here, 'test-results');
const externalBaseUrl = process.env.GSM_E2E_BASE_URL;
const baseURL = externalBaseUrl
  ? `${externalBaseUrl.replace(/\/+$/, '')}/`
  : 'http://127.0.0.1:4173/';

export default defineConfig({
  testDir: here,
  testMatch: '**/*.spec.ts',
  outputDir: resolve(resultsRoot, 'playwright-artifacts'),
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [
    ['line'],
    ['html', { outputFolder: resolve(resultsRoot, 'playwright-report'), open: 'never' }],
    ['json', { outputFile: resolve(resultsRoot, 'playwright-results.json') }],
  ],
  use: {
    baseURL,
    headless: true,
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
    launchOptions: {
      args: [
        '--enable-precise-memory-info',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
        '--use-angle=swiftshader',
      ],
    },
  },
  projects: [
    {
      name: 'chromium-pages',
      use: {
        ...devices['Desktop Chrome'],
        channel: undefined,
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 1,
      },
    },
  ],
  webServer: process.env.GSM_E2E_BASE_URL
    ? undefined
    : {
        command: 'npm run preview:e2e',
        cwd: repositoryRoot,
        url: 'http://127.0.0.1:4173',
        reuseExistingServer: false,
        timeout: 120_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
