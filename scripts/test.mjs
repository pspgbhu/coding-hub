import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
const require = createRequire(import.meta.url)
const electron = require('electron')
const args = [resolve('node_modules/vitest/vitest.mjs'), 'run', ...process.argv.slice(2)]
const result = spawnSync(electron, args, {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
})
process.exit(result.status ?? 1)
