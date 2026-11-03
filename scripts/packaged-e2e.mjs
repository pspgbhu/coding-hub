import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
if (process.platform === 'win32') {
  const unpacked = join(dirname(executable), 'resources', 'app.asar.unpacked')
  const bindings = readdirSync(unpacked, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name === 'conpty.node' &&
        entry.parentPath.split(/[\\/]/).includes('node-pty'),
    )
    .map((entry) => join(entry.parentPath, entry.name))
  const complete = bindings.find((binding) =>
    ['conpty.dll', 'OpenConsole.exe'].every((file) =>
      existsSync(join(dirname(binding), 'conpty', file)),
    ),
  )
  if (!complete)
    throw new Error('The packaged Windows terminal is missing its vendored ConPTY DLLs.')
  console.log(`Vendored ConPTY: ${join(dirname(complete), 'conpty')}`)
}
const result = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['test:e2e'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, CODING_HUB_PACKAGED_APP: executable },
})
process.exit(result.status ?? 1)
