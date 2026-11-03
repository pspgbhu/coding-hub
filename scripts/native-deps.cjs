const { spawnSync } = require('node:child_process')
const { existsSync, readdirSync, readFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const { dirname, join, resolve } = require('node:path')

const machines = { x64: 0x8664, arm64: 0xaa64 }
const conptyFiles = ['conpty.dll', 'OpenConsole.exe']

function assertArchitecture(file, arch) {
  const bytes = readFileSync(file)
  const offset = bytes.length >= 64 ? bytes.readUInt32LE(60) : -1
  if (
    bytes.toString('ascii', 0, 2) !== 'MZ' ||
    offset < 0 ||
    offset + 6 > bytes.length ||
    bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0' ||
    bytes.readUInt16LE(offset + 4) !== machines[arch]
  ) {
    throw new Error(`Expected a Windows ${arch} native asset: ${file}`)
  }
}

/** Replay node-pty's own asset installation after Electron rebuild replaces build/Release. */
function stageNodePtyAssets({
  platform = process.platform,
  arch = process.arch,
  projectDir = resolve(__dirname, '..'),
  nodePtyDir,
  run = spawnSync,
} = {}) {
  // Do not rerun node-pty's cleanup script on macOS: it would mutate build/Release.
  if (platform !== 'win32') return
  if (!Object.hasOwn(machines, arch)) throw new Error(`Unsupported Windows architecture: ${arch}`)
  const appRequire = createRequire(join(projectDir, 'package.json'))
  const root = nodePtyDir ?? dirname(appRequire.resolve('node-pty/package.json'))
  const versions = readdirSync(join(root, 'third_party', 'conpty'))
  if (versions.length !== 1) throw new Error('Expected one pinned node-pty ConPTY asset version.')
  const source = join(root, 'third_party', 'conpty', versions[0], `win10-${arch}`)
  for (const file of conptyFiles) assertArchitecture(join(source, file), arch)

  const result = run(process.execPath, [join(root, 'scripts', 'post-install.js')], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', npm_config_arch: arch },
  })
  if (result.error || result.status !== 0) {
    throw new Error('The official node-pty ConPTY asset installation failed.', {
      cause: result.error,
    })
  }

  // Match node-pty's loader priority. Never accept DLLs for a different binding/architecture.
  const bindingDir = ['build/Release', 'build/Debug', `prebuilds/win32-${arch}`]
    .map((directory) => join(root, directory))
    .find((directory) => existsSync(join(directory, 'conpty.node')))
  if (!bindingDir) throw new Error('No Windows node-pty native binding was installed.')
  assertArchitecture(join(bindingDir, 'conpty.node'), arch)
  for (const file of conptyFiles) {
    const installed = join(bindingDir, 'conpty', file)
    assertArchitecture(installed, arch)
    if (!readFileSync(installed).equals(readFileSync(join(source, file)))) {
      throw new Error(`The installed ConPTY asset differs from the pinned dependency: ${installed}`)
    }
  }
}

// afterExtract runs after electron-builder's native rebuild and before application file copying.
async function afterExtract(context) {
  if (context.electronPlatformName !== 'win32') return
  const { Arch } = require('electron-builder')
  stageNodePtyAssets({
    platform: context.electronPlatformName,
    arch: Arch[context.arch],
    projectDir: context.packager.info.appDir,
  })
}

module.exports = afterExtract
module.exports.stageNodePtyAssets = stageNodePtyAssets

if (require.main === module) {
  const result = spawnSync(
    process.execPath,
    [require.resolve('electron-builder/cli.js'), 'install-app-deps', '--arch', process.arch],
    { stdio: 'inherit' },
  )
  if (result.error || result.status !== 0) process.exit(result.status ?? 1)
  stageNodePtyAssets()
}
