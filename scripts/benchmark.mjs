import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'

const options = process.argv.slice(2)
if (options.some((option) => option !== '--desktop')) {
  console.error('Usage: node scripts/benchmark.mjs [--desktop]')
  process.exit(2)
}

// Run through the existing Electron Node launcher so native SQLite/PTY ABI stays correct.
const result = spawnSync(
  process.execPath,
  [resolve('scripts/test.mjs'), 'tests/performance.test.ts'],
  {
    stdio: 'inherit',
    env: { ...process.env, CODING_HUB_BENCHMARK: '1' },
  },
)
if (result.status !== 0) process.exit(result.status ?? 1)
if (options.includes('--desktop')) {
  // Requires a fresh `pnpm build`; fixture setup and process shutdown are excluded
  // from the separately recorded real Electron restart/startup measurement.
  const requireModule = createRequire(resolve('package.json'))
  const desktop = spawnSync(
    process.execPath,
    [
      requireModule.resolve('@playwright/test/cli'),
      'test',
      'tests/e2e/product-ui.spec.ts',
      '--grep',
      'one thousand stored sessions',
    ],
    { stdio: 'inherit', env: { ...process.env, CODING_HUB_BENCHMARK: '1' } },
  )
  if (desktop.status !== 0) process.exit(desktop.status ?? 1)
}
console.log('Service results: coverage/benchmarks/performance-full.json')
if (options.includes('--desktop'))
  console.log('Desktop results: coverage/benchmarks/desktop-full.json')
