import { defineConfig } from '@playwright/test'

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000'
const pnpmCommand = process.env.npm_execpath
  ? `${JSON.stringify(process.execPath)} ${JSON.stringify(process.env.npm_execpath)}`
  : 'pnpm'

export default defineConfig({
  testDir: './apps/app/e2e',
  timeout: 30_000,
  expect: {
    timeout: 8_000,
  },
  use: {
    baseURL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: `${pnpmCommand} --filter @dohc/web run dev:vite -- --host 127.0.0.1`,
        reuseExistingServer: true,
        timeout: 120_000,
        url: `${baseURL}/playground`,
      },
})
