import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  fullyParallel: false,
  timeout: 40000,
  use: { baseURL: 'http://127.0.0.1:3001', browserName: 'chromium', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
  webServer: { command: 'node tests/support/whatsapp-server.mjs', url: 'http://127.0.0.1:3001/api/health', reuseExistingServer: false, env: { PORT: '3001', APP_URL: 'http://127.0.0.1:3001', DATABASE_PATH: ':memory:', NODE_ENV: 'test', PLATFORM_ADMIN_EMAILS: 'operator@example.com' } }
});
