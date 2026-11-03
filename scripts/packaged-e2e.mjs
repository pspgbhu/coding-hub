import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const target =
  process.platform === 'darwin' && ['x64', 'arm64'].includes(process.arch)
    ? `release/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/Coding Hub.app/Contents/MacOS/Coding Hub`
    : process.platform === 'win32' && process.arch === 'x64'
      ? 'release/win-unpacked/Coding Hub.exe'
      : undefined
if (!target) throw new Error('Packaged checks support native macOS x64/arm64 and Windows x64 only.')
const executable = resolve(target)
if (!existsSync(executable))
  throw new Error(`No native packaged executable found at ${target}. Package this target first.`)
console.log(`Packaged application: ${executable}`)
const result = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['test:e2e'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, CODING_HUB_PACKAGED_APP: executable },
})
process.exit(result.status ?? 1)
