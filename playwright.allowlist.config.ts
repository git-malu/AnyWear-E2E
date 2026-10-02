import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';

export default defineConfig({
  ...base,
  testDir: './tests/controlled',
  testIgnore: [],
  testMatch: 'beta-tester-allowlist.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30 * 60_000,
  use: { ...base.use, trace: 'off', screenshot: 'off', video: 'off' },
});
