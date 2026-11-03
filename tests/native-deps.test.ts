import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { stageNodePtyAssets } = require('../scripts/native-deps.cjs') as {
  stageNodePtyAssets: (options: {
    platform: string
    arch: string
    nodePtyDir: string
    run?: typeof spawnSync
  }) => void
}
const directories: string[] = []

function pe(arch: 'x64' | 'arm64', payload: string) {
  const bytes = Buffer.alloc(128)
  bytes.write('MZ')
  bytes.writeUInt32LE(64, 60)
  bytes.write('PE\0\0', 64)
  bytes.writeUInt16LE(arch === 'x64' ? 0x8664 : 0xaa64, 68)
  bytes.write(payload, 72)
  return bytes
}

function fixture(arch: 'x64' | 'arm64') {
  const root = mkdtempSync(join(tmpdir(), 'coding-hub-native-assets-'))
  directories.push(root)
  const source = join(root, 'third_party', 'conpty', 'pinned-version', `win10-${arch}`)
  mkdirSync(source, { recursive: true })
  for (const file of ['conpty.dll', 'OpenConsole.exe']) {
    writeFileSync(join(source, file), pe(arch, `pinned ${file}`))
  }
  mkdirSync(join(root, 'build', 'Release', 'conpty'), { recursive: true })
  const binding = pe(arch, 'Electron native binding')
  writeFileSync(join(root, 'build', 'Release', 'conpty.node'), binding)
  writeFileSync(join(root, 'build', 'Release', 'conpty', 'conpty.dll'), 'stale')
  mkdirSync(join(root, 'scripts'))
  // Exercise the pinned dependency's real post-install program in an isolated package tree.
  const upstreamRoot = dirname(require.resolve('node-pty/package.json'))
  writeFileSync(
    join(root, 'scripts', 'post-install.js'),
    readFileSync(join(upstreamRoot, 'scripts', 'post-install.js')),
  )
  const platformShim = join(root, 'windows-fixture.cjs')
  writeFileSync(platformShim, "require('node:os').platform = () => 'win32'\n")
  const run = vi.fn((executable, args, options) =>
    spawnSync(executable, ['--require', platformShim, ...args], { ...options, stdio: 'pipe' }),
  ) as unknown as typeof spawnSync
  return { root, source, binding, run }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Electron native dependency asset setup', () => {
  it.each(['x64', 'arm64'] as const)(
    'replays the official installer with same-architecture pinned assets (%s)',
    (arch) => {
      const { root, source, binding, run } = fixture(arch)
      stageNodePtyAssets({ platform: 'win32', arch, nodePtyDir: root, run })
      expect(run).toHaveBeenCalledOnce()
      expect(run).toHaveBeenCalledWith(
        process.execPath,
        [join(root, 'scripts', 'post-install.js')],
        expect.objectContaining({
          cwd: root,
          env: expect.objectContaining({ npm_config_arch: arch, ELECTRON_RUN_AS_NODE: '1' }),
        }),
      )
      expect(readFileSync(join(root, 'build', 'Release', 'conpty.node'))).toEqual(binding)
      for (const file of ['conpty.dll', 'OpenConsole.exe']) {
        expect(readFileSync(join(root, 'build', 'Release', 'conpty', file))).toEqual(
          readFileSync(join(source, file)),
        )
      }
    },
  )

  it('does not resolve dependencies or invoke their cleanup program on macOS', () => {
    const run = vi.fn() as unknown as typeof spawnSync
    stageNodePtyAssets({ platform: 'darwin', arch: 'arm64', nodePtyDir: '/not-present', run })
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects a source architecture mismatch before running the installer', () => {
    const { root, source, run } = fixture('x64')
    writeFileSync(join(source, 'conpty.dll'), pe('arm64', 'wrong architecture'))
    expect(() =>
      stageNodePtyAssets({ platform: 'win32', arch: 'x64', nodePtyDir: root, run }),
    ).toThrow('Expected a Windows x64 native asset')
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects missing or different installed assets even if the installer reports success', () => {
    const { root } = fixture('x64')
    const run = vi.fn(() => ({ status: 0 })) as unknown as typeof spawnSync
    expect(() =>
      stageNodePtyAssets({ platform: 'win32', arch: 'x64', nodePtyDir: root, run }),
    ).toThrow('Expected a Windows x64 native asset')
    const target = join(root, 'build', 'Release', 'conpty')
    writeFileSync(join(target, 'conpty.dll'), pe('x64', 'unrelated binary'))
    writeFileSync(join(target, 'OpenConsole.exe'), pe('x64', 'unrelated executable'))
    expect(() =>
      stageNodePtyAssets({ platform: 'win32', arch: 'x64', nodePtyDir: root, run }),
    ).toThrow('differs from the pinned dependency')
  })

  it('fails explicitly on upstream installation failure and unsupported Windows architectures', () => {
    const { root } = fixture('x64')
    const run = vi.fn(() => ({ status: 1 })) as unknown as typeof spawnSync
    expect(() =>
      stageNodePtyAssets({ platform: 'win32', arch: 'x64', nodePtyDir: root, run }),
    ).toThrow('official node-pty ConPTY asset installation failed')
    expect(() =>
      stageNodePtyAssets({ platform: 'win32', arch: 'ia32', nodePtyDir: root, run }),
    ).toThrow('Unsupported Windows architecture')
  })
})
