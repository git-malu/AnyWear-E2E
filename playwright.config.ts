import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(repositoryRoot, '.env') });

const clientRoot = path.resolve(
  repositoryRoot,
  process.env.ANYWEAR_CLIENT_DIR ?? '../AnyWear-Client',
);
const serviceRoot = path.resolve(
  repositoryRoot,
  process.env.ANYWEAR_SERVICE_DIR ?? '../AnyWear-Service',
);
const clientUrl = process.env.E2E_CLIENT_URL ?? 'http://127.0.0.1:1420';
const serviceUrl = process.env.E2E_SERVICE_URL ?? 'http://127.0.0.1:3000';
const useExternalServers = process.env.E2E_EXTERNAL_SERVERS === 'true';
const inheritedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => (
    typeof entry[1] === 'string'
  )),
);

export default defineConfig({
  testDir: './tests',
  outputDir: 'test-results',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: clientUrl,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: useExternalServers
    ? undefined
    : [
        {
          name: 'Service',
          command: 'pnpm dev',
          cwd: serviceRoot,
          url: `${serviceUrl}/health`,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          stdout: 'pipe',
          stderr: 'pipe',
          env: {
            ...inheritedEnvironment,
            PORT: new URL(serviceUrl).port || '3000',
          },
        },
        {
          name: 'Client',
          command: 'pnpm dev --host 127.0.0.1',
          cwd: clientRoot,
          url: clientUrl,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          stdout: 'pipe',
          stderr: 'pipe',
          env: {
            ...inheritedEnvironment,
            VITE_API_BASE_URL: serviceUrl,
            VITE_COGNITO_USER_POOL_ID:
              process.env.VITE_COGNITO_USER_POOL_ID ?? process.env.USER_POOL_ID ?? '',
            VITE_COGNITO_CLIENT_ID: process.env.VITE_COGNITO_CLIENT_ID ?? '',
            VITE_COGNITO_IDENTITY_POOL_ID:
              process.env.VITE_COGNITO_IDENTITY_POOL_ID ?? '',
          },
        },
      ],
});
