import { defineConfig } from '@playwright/test'

// Click-through tests against the built app (out/). Run with `npm run test:e2e`, which builds first.
// Each test launches its own Electron instance with a throwaway profile, so they run one at a time.
export default defineConfig({
  testDir: '.',
  testMatch: '*.e2e.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: '../../test-results/e2e'
})
