import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WorkspaceService } from '../src/runtime/workspace'
import { resolveCommand, runCommand } from '../src/runtime/process'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}))

let directory: string
let root: string
let service: WorkspaceService

async function gitAt(cwd: string, ...args: string[]): Promise<string> {
  const executable = await resolveCommand('git')
  if (!executable) throw new Error('Git is required for workspace tests')
  const result = await runCommand(executable, args, cwd)
  if (result.code !== 0) throw new Error(result.stderr || result.stdout)
  return result.stdout.trim()
}

async function repository(): Promise<void> {
  await gitAt(root, 'init', '-b', 'main')
  await gitAt(root, 'config', 'user.name', 'Workspace Tests')
  await gitAt(root, 'config', 'user.email', 'workspace@example.invalid')
  await gitAt(root, 'config', 'commit.gpgsign', 'false')
  await gitAt(root, 'config', 'core.hooksPath', path.join(directory, 'empty-hooks'))
}

async function commit(): Promise<void> {
  await gitAt(root, 'add', '-A')
  await gitAt(root, 'commit', '-m', 'test: baseline')
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'coding-hub-workspace-advanced-'))
  root = path.join(directory, 'project')
  await fs.mkdir(root)
  service = new WorkspaceService()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(directory, { recursive: true, force: true })
})

describe('safe editor writes and CRUD', () => {
  it('preserves BOM, CRLF, executable mode and an internal symlink when saving', async () => {
    const filename = path.join(root, 'script.sh')
    await fs.writeFile(filename, '\uFEFF#!/bin/sh\r\necho before\r\n')
    await fs.chmod(filename, 0o755)
    let input = 'script.sh'
    if (process.platform !== 'win32') {
      await fs.symlink('script.sh', path.join(root, 'link.sh'))
      input = 'link.sh'
    }
    const original = await service.readFile(root, input)
    const saved = await service.saveFile(
      root,
      input,
      '#!/bin/sh\necho after\n',
      original.fingerprint,
    )
    expect(saved.content).toBe('\uFEFF#!/bin/sh\r\necho after\r\n')
    expect(await fs.readFile(filename, 'utf8')).toBe(saved.content)
    if (process.platform !== 'win32') {
      expect((await fs.lstat(path.join(root, input))).isSymbolicLink()).toBe(true)
      expect((await fs.stat(filename)).mode & 0o777).toBe(0o755)
    }
  })

  it('keeps the original file and removes staging files when atomic replacement fails', async () => {
    const filename = path.join(root, 'file.txt')
    await fs.writeFile(filename, 'original')
    const original = await service.readFile(root, 'file.txt')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('simulated replace failure'))
    await expect(
      service.saveFile(root, 'file.txt', 'replacement', original.fingerprint),
    ).rejects.toThrow('simulated replace failure')
    expect(await fs.readFile(filename, 'utf8')).toBe('original')
    expect(await fs.readdir(root)).toEqual(['file.txt'])
  })

  it('detects a second external modification even during an explicit overwrite', async () => {
    const filename = path.join(root, 'file.txt')
    await fs.writeFile(filename, 'original')
    const actualOpen = fs.open
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await actualOpen(...args)
      if (String(args[0]).includes('.coding-hub-save-')) {
        const actualSync = handle.sync.bind(handle)
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          await fs.writeFile(filename, 'external during save')
          await actualSync()
        })
      }
      return handle
    })
    await expect(service.saveFile(root, 'file.txt', 'client', 'stale', true)).rejects.toMatchObject(
      { code: 'FILE_CONFLICT' },
    )
    expect(await fs.readFile(filename, 'utf8')).toBe('external during save')
    expect(await fs.readdir(root)).toEqual(['file.txt'])
  })

  it.skipIf(process.platform === 'win32')(
    'restores the original if directory durability fails after replacement',
    async () => {
      const filename = path.join(root, 'file.txt')
      await fs.writeFile(filename, 'original')
      const original = await service.readFile(root, 'file.txt')
      const actualOpen = fs.open
      const realRoot = await fs.realpath(root)
      vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await actualOpen(...args)
        if (String(args[0]) === realRoot)
          vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('directory durability failure'))
        return handle
      })
      await expect(
        service.saveFile(root, 'file.txt', 'replacement', original.fingerprint),
      ).rejects.toThrow('directory durability failure')
      expect(await fs.readFile(filename, 'utf8')).toBe('original')
      expect(await fs.readdir(root)).toEqual(['file.txt'])
    },
  )

  it('creates, renames and fingerprint-deletes files without overwriting another path', async () => {
    const created = await service.createFile(root, 'new.txt', 'new')
    await expect(service.createFile(root, 'new.txt', 'overwrite')).rejects.toMatchObject({
      code: 'FILE_CONFLICT',
    })
    await service.createFile(root, 'existing.txt', 'keep')
    await expect(service.renameFile(root, 'new.txt', 'existing.txt')).rejects.toThrow()
    expect(await fs.readFile(path.join(root, 'existing.txt'), 'utf8')).toBe('keep')
    const moved = await service.renameFile(root, 'new.txt', 'renamed.txt')
    expect(moved.content).toBe(created.content)
    await fs.writeFile(path.join(root, 'renamed.txt'), 'external')
    await expect(service.deleteFile(root, 'renamed.txt', moved.fingerprint)).rejects.toMatchObject({
      code: 'FILE_CONFLICT',
    })
    const current = await service.readFile(root, 'renamed.txt')
    await service.deleteFile(root, 'renamed.txt', current.fingerprint)
    await expect(fs.stat(path.join(root, 'renamed.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(service.createFile(root, '.git/config', 'bad')).rejects.toMatchObject({
      code: 'INVALID_PATH',
    })
    await expect(service.createFile(root, '../outside', 'bad')).rejects.toMatchObject({
      code: 'INVALID_PATH',
    })
  })

  it('resolves binary and large files for explicit external editing without reading their contents', async () => {
    await fs.writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 255, 1]))
    await fs.writeFile(path.join(root, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 65))
    expect(await service.resolveFile(root, 'binary.bin')).toBe(
      await fs.realpath(path.join(root, 'binary.bin')),
    )
    expect(await service.resolveFile(root, 'large.txt')).toBe(
      await fs.realpath(path.join(root, 'large.txt')),
    )
    expect(await service.resolveFile(root)).toBe(await fs.realpath(root))
    await expect(service.resolveFile(root, '../outside')).rejects.toMatchObject({
      code: 'INVALID_PATH',
    })
    await fs.mkdir(path.join(root, '.git'))
    await fs.writeFile(path.join(root, '.git', 'config'), 'metadata')
    await expect(service.resolveFile(root, '.git/config')).rejects.toMatchObject({
      code: 'INVALID_PATH',
    })
  })

  it.skipIf(process.platform === 'win32')(
    'refuses writes through an internal alias into Git metadata',
    async () => {
      await fs.mkdir(path.join(root, '.git'))
      await fs.writeFile(path.join(root, '.git', 'config'), 'original metadata')
      await fs.symlink('.git', path.join(root, 'alias'), 'dir')
      const original = await service.readFile(root, 'alias/config')
      await expect(
        service.saveFile(root, 'alias/config', 'changed', original.fingerprint),
      ).rejects.toMatchObject({ code: 'INVALID_PATH' })
      await expect(service.createFile(root, 'alias/new', 'changed')).rejects.toMatchObject({
        code: 'INVALID_PATH',
      })
      expect(await fs.readFile(path.join(root, '.git', 'config'), 'utf8')).toBe('original metadata')
    },
  )
})

describe('canonical repositories and bounded search', () => {
  it('suppresses hooks only for automatic worktree creation without changing Git configuration', async () => {
    await repository()
    await fs.writeFile(path.join(root, 'file.txt'), 'baseline')
    await commit()
    const hooks = path.join(directory, 'configured hooks')
    await fs.mkdir(hooks)
    for (const event of ['post-checkout', 'pre-commit']) {
      const filename = path.join(hooks, event)
      await fs.writeFile(filename, `#!/bin/sh\nprintf '%s\\n' '${event}' >> .${event}-marker\n`)
      await fs.chmod(filename, 0o755)
    }
    // Override the fixture's empty hooks path with real executable repository hooks.
    await gitAt(root, 'config', 'core.hooksPath', hooks)
    const localConfiguration = await fs.readFile(path.join(root, '.git', 'config'))
    const globalConfiguration = async () => {
      const executable = await resolveCommand('git')
      if (!executable) throw new Error('Git is required for workspace tests')
      const result = await runCommand(executable, ['config', '--global', '--null', '--list'], root)
      return {
        code: result.code,
        // Never include the user's global configuration values in assertion output.
        digest: createHash('sha256')
          .update(result.stdoutBuffer)
          .update(result.stderr)
          .digest('hex'),
      }
    }
    const globalBefore = await globalConfiguration()
    const original = await service.inspect(root)
    const head = await gitAt(root, 'rev-parse', 'HEAD')

    // Prove this native Git actually executes the configured hook before testing suppression.
    await gitAt(root, 'checkout', 'main')
    expect(await fs.readFile(path.join(root, '.post-checkout-marker'), 'utf8')).toBe(
      'post-checkout\n',
    )
    await fs.rm(path.join(root, '.post-checkout-marker'))

    const isolated = await service.createWorktree(
      root,
      path.join(directory, 'isolated'),
      'task/no-automatic-hooks',
    )
    await expect(
      fs.stat(path.join(isolated.rootPath, '.post-checkout-marker')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await fs.readFile(path.join(isolated.rootPath, 'file.txt'), 'utf8')).toBe('baseline')
    expect(isolated).toMatchObject({
      branch: 'task/no-automatic-hooks',
      repositoryId: original.repositoryId,
      hasHead: true,
    })
    expect(isolated.canonicalId).not.toBe(original.canonicalId)
    expect(isolated.gitDir).not.toBe(original.gitDir)
    expect(await gitAt(isolated.rootPath, 'rev-parse', 'HEAD')).toBe(head)
    expect(await service.listWorktrees(root)).toHaveLength(2)
    expect(await fs.readFile(path.join(root, '.git', 'config'))).toEqual(localConfiguration)
    expect(await globalConfiguration()).toEqual(globalBefore)

    // Explicit user Git actions must continue to run the same repository hooks.
    await service.gitAction(isolated.rootPath, 'checkout', 'task/no-automatic-hooks')
    expect(await fs.readFile(path.join(isolated.rootPath, '.post-checkout-marker'), 'utf8')).toBe(
      'post-checkout\n',
    )
    await fs.writeFile(path.join(isolated.rootPath, 'file.txt'), 'user change')
    await service.gitAction(isolated.rootPath, 'stage', 'file.txt')
    await service.gitAction(isolated.rootPath, 'commit', 'test: explicit commit runs hooks')
    expect(await fs.readFile(path.join(isolated.rootPath, '.pre-commit-marker'), 'utf8')).toBe(
      'pre-commit\n',
    )
    expect(await gitAt(root, 'rev-parse', 'HEAD')).toBe(head)
    expect(await gitAt(isolated.rootPath, 'rev-parse', 'HEAD^')).toBe(head)
    expect(await fs.readFile(path.join(root, '.git', 'config'))).toEqual(localConfiguration)
    expect(await globalConfiguration()).toEqual(globalBefore)
  })

  it('shares a repository identity for a subproject and worktree while preserving distinct cwd identities', async () => {
    await repository()
    await fs.mkdir(path.join(root, 'nested'))
    await fs.writeFile(path.join(root, 'nested', 'file.txt'), 'baseline')
    await commit()
    const main = await service.inspect(root)
    const nested = await service.inspect(path.join(root, 'nested'))
    const isolated = await service.createWorktree(
      path.join(root, 'nested'),
      path.join(directory, 'isolated'),
      'task/isolated',
    )
    expect(nested.repositoryId).toBe(main.repositoryId)
    expect(isolated.repositoryId).toBe(main.repositoryId)
    expect(isolated.canonicalId).not.toBe(nested.canonicalId)
    expect(isolated.gitDir).not.toBe(main.gitDir)
    expect(isolated.rootPath).toBe(await fs.realpath(path.join(directory, 'isolated', 'nested')))
    expect(isolated.branch).toBe('task/isolated')
    expect(isolated.hasHead).toBe(true)
    expect(await service.listWorktrees(root)).toHaveLength(2)
  })

  it('refuses to commit another subproject staged changes, including an unborn index', async () => {
    await repository()
    await fs.mkdir(path.join(root, 'nested'))
    await fs.writeFile(path.join(root, 'nested', 'inside.txt'), 'inside')
    await fs.writeFile(path.join(root, 'outside.txt'), 'outside')
    await gitAt(root, 'add', '-A')
    await expect(
      service.gitAction(path.join(root, 'nested'), 'commit', 'test: scoped'),
    ).rejects.toThrow('outside this project')
    expect(await gitAt(root, 'diff', '--cached', '--name-only')).toContain('outside.txt')
    await gitAt(root, 'rm', '--cached', 'outside.txt')
    await service.gitAction(path.join(root, 'nested'), 'commit', 'test: scoped')
    expect(await gitAt(root, 'show', '--format=', '--name-only', 'HEAD')).toBe('nested/inside.txt')
  })

  it('honors Git ignores and limits search to the opened subdirectory and text files', async () => {
    await repository()
    await fs.mkdir(path.join(root, 'nested'))
    await fs.writeFile(path.join(root, '.gitignore'), 'ignored.txt\n')
    await fs.writeFile(path.join(root, 'outside.txt'), 'needle outside')
    await fs.writeFile(path.join(root, 'nested', 'hello.ts'), 'first\nneedle inside\n')
    await fs.writeFile(path.join(root, 'nested', 'ignored.txt'), 'needle ignored')
    await fs.writeFile(path.join(root, 'nested', 'binary.bin'), Buffer.from([0, 1, 2]))
    const nested = path.join(root, 'nested')
    expect(await service.searchFiles(nested, 'hello')).toEqual([{ path: 'hello.ts' }])
    expect(await service.searchFiles(nested, 'needle', true)).toEqual([
      { path: 'hello.ts', line: 2, text: 'needle inside' },
    ])
  })

  it('keeps filename results fresh when files and ignore rules change between queries', async () => {
    await gitAt(root, 'init', '-b', 'main', '--template=')
    await fs.writeFile(path.join(root, 'first-result.ts'), 'first')
    expect(await service.searchFiles(root, 'RESULT')).toEqual([{ path: 'first-result.ts' }])
    await fs.writeFile(path.join(root, 'next-result.ts'), 'new')
    expect(await service.searchFiles(root, 'result')).toEqual([
      { path: 'first-result.ts' },
      { path: 'next-result.ts' },
    ])
    await fs.rm(path.join(root, 'first-result.ts'))
    expect(await service.searchFiles(root, 'result')).toEqual([{ path: 'next-result.ts' }])
    await fs.writeFile(path.join(root, '.gitignore'), 'next-result.ts\n')
    expect(await service.searchFiles(root, 'result')).toEqual([])
    await fs.writeFile(path.join(root, '.gitignore'), '')
    expect(await service.searchFiles(root, 'result')).toEqual([{ path: 'next-result.ts' }])
  })

  it('preserves ordered bounded results for narrow, broad and empty filename queries', async () => {
    await gitAt(root, 'init', '-b', 'main', '--template=')
    await fs.writeFile(path.join(root, 'FILE_A.ts'), '')
    for (let group = 0; group < 11; group++)
      await Promise.all(
        Array.from({ length: 50 }, (_, offset) =>
          fs.writeFile(
            path.join(root, `file-${String(group * 50 + offset).padStart(5, '0')}.ts`),
            '',
          ),
        ),
      )
    expect(await service.searchFiles(root, 'FILE-00549')).toEqual([{ path: 'file-00549.ts' }])
    const broad = await service.searchFiles(root, 'FILE')
    expect(broad).toHaveLength(500)
    expect(broad[0]).toEqual({ path: 'FILE_A.ts' })
    expect(broad[1]).toEqual({ path: 'file-00000.ts' })
    expect(broad.at(-1)).toEqual({ path: 'file-00498.ts' })
    expect(await service.searchFiles(root, '')).toEqual(broad)
  })

  it('rejects a commit when staged contents changed after the review preview', async () => {
    await repository()
    await fs.writeFile(path.join(root, 'file.txt'), 'previewed')
    await gitAt(root, 'add', 'file.txt')
    const preview = await service.gitStatus(root)
    expect(preview.indexFingerprint).toMatch(/^[a-f0-9]{64}$/)
    await fs.writeFile(path.join(root, 'file.txt'), 'changed after preview')
    await gitAt(root, 'add', 'file.txt')
    await expect(
      service.gitAction(root, 'commit', 'test: stale preview', preview.indexFingerprint),
    ).rejects.toMatchObject({ code: 'FILE_CONFLICT' })
    const current = await service.gitStatus(root)
    await service.gitAction(root, 'commit', 'test: refreshed preview', current.indexFingerprint)
    expect(await gitAt(root, 'show', 'HEAD:file.txt')).toBe('changed after preview')
  })

  it('honors nested Git ignore rules without initializing a non-Git project', async () => {
    await fs.mkdir(path.join(root, 'nested'))
    await fs.writeFile(path.join(root, '.gitignore'), '*.secret\n')
    await fs.writeFile(path.join(root, 'nested', '.gitignore'), 'ignored.txt\n')
    await fs.writeFile(path.join(root, 'nested', 'ignored.txt'), 'needle ignored')
    await fs.writeFile(path.join(root, 'private.secret'), 'needle private')
    await fs.writeFile(path.join(root, 'nested', 'source.txt'), 'needle source')
    expect(await service.searchFiles(root, 'needle', true)).toEqual([
      { path: 'nested/source.txt', line: 1, text: 'needle source' },
    ])
    await expect(fs.stat(path.join(root, '.git'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await service.inspect(root)).toMatchObject({ hasHead: false })
  })
})

describe('isolated worktree delivery', () => {
  async function isolated(): Promise<string> {
    await repository()
    await fs.writeFile(path.join(root, 'file.txt'), 'baseline\n')
    await fs.writeFile(path.join(root, 'deleted.txt'), 'delete me\n')
    await commit()
    return (await service.createWorktree(root, path.join(directory, 'worktree'), 'task/review'))
      .rootPath
  }

  it('compares and applies committed, uncommitted, added and deleted files from the common baseline', async () => {
    const source = await isolated()
    await fs.writeFile(path.join(source, 'file.txt'), 'agent committed\n')
    await gitAt(source, 'add', 'file.txt')
    await gitAt(source, 'commit', '-m', 'test: agent change')
    await fs.mkdir(path.join(source, 'new'))
    await fs.writeFile(path.join(source, 'new', 'binary.bin'), Buffer.from([0, 1, 2, 3]))
    await fs.rm(path.join(source, 'deleted.txt'))
    const comparison = await service.compareWorktree(root, source)
    expect(comparison.conflicts).toEqual([])
    expect(comparison.files.map((file) => file.path)).toEqual([
      'deleted.txt',
      'file.txt',
      'new/binary.bin',
    ])
    expect(await service.applyWorktree(root, source)).toEqual({
      applied: ['deleted.txt', 'file.txt', 'new/binary.bin'],
      conflicts: [],
    })
    expect(await fs.readFile(path.join(root, 'file.txt'), 'utf8')).toBe('agent committed\n')
    expect(await fs.readFile(path.join(root, 'new', 'binary.bin'))).toEqual(
      Buffer.from([0, 1, 2, 3]),
    )
    await expect(fs.stat(path.join(root, 'deleted.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    // Applying an already delivered source is a harmless no-op.
    expect(await service.applyWorktree(root, source)).toEqual({ applied: [], conflicts: [] })
  })

  it('blocks the complete batch when the receiving workspace also changed a file', async () => {
    const source = await isolated()
    await fs.writeFile(path.join(source, 'file.txt'), 'agent change')
    await fs.writeFile(path.join(source, 'added.txt'), 'must not be applied')
    await fs.writeFile(path.join(root, 'file.txt'), 'user change')
    const result = await service.applyWorktree(root, source)
    expect(result.applied).toEqual([])
    expect(result.conflicts.map((conflict) => conflict.path)).toEqual(['file.txt'])
    expect(await fs.readFile(path.join(root, 'file.txt'), 'utf8')).toBe('user change')
    await expect(fs.stat(path.join(root, 'added.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rolls back earlier files when a later atomic replacement fails', async () => {
    const source = await isolated()
    await fs.writeFile(path.join(source, 'deleted.txt'), 'first change')
    await fs.writeFile(path.join(source, 'file.txt'), 'second change')
    const actualRename = fs.rename
    let calls = 0
    vi.spyOn(fs, 'rename').mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
      if (++calls === 2) throw new Error('simulated second replacement failure')
      return actualRename(...args)
    })
    await expect(service.applyWorktree(root, source)).rejects.toThrow('rolled back')
    expect(await fs.readFile(path.join(root, 'deleted.txt'), 'utf8')).toBe('delete me\n')
    expect(await fs.readFile(path.join(root, 'file.txt'), 'utf8')).toBe('baseline\n')
  })

  it('refuses dirty/ignored worktree removal and never removes the main workspace', async () => {
    const source = await isolated()
    await expect(service.removeWorktree(source, root)).rejects.toThrow('linked worktree')
    await fs.writeFile(path.join(source, '.gitignore'), '.env\n')
    await gitAt(source, 'add', '.gitignore')
    await gitAt(source, 'commit', '-m', 'test: ignore secrets')
    await fs.writeFile(path.join(source, '.env'), 'private')
    await expect(service.removeWorktree(root, source)).rejects.toThrow('ignored files')
    await fs.rm(path.join(source, '.env'))
    await service.removeWorktree(root, source)
    expect(await service.listWorktrees(root)).toHaveLength(1)
    await expect(fs.stat(source)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('local Git synchronization', () => {
  it('reports unavailable binary/large text previews without blocking staged asset delivery', async () => {
    await repository()
    await fs.writeFile(path.join(root, 'image.bin'), Buffer.from([0, 1, 2, 3]))
    await fs.writeFile(path.join(root, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 65))
    await gitAt(root, 'add', '-A')
    expect(await service.gitDiff(root, 'image.bin', true)).toMatchObject({
      original: '',
      modified: '',
      previewUnavailable: 'binary',
    })
    expect(await service.gitDiff(root, 'large.txt', true)).toMatchObject({
      original: '',
      modified: '',
      previewUnavailable: 'large',
    })
    const preview = await service.gitStatus(root)
    await service.gitAction(root, 'commit', 'test: binary asset delivery', preview.indexFingerprint)
    expect(await gitAt(root, 'ls-tree', '--name-only', 'HEAD')).toContain('image.bin')
  })

  it.skipIf(process.platform === 'win32')(
    'redacts credentials from failing local Git hook diagnostics',
    async () => {
      await repository()
      await fs.writeFile(path.join(root, 'file.txt'), 'baseline')
      await gitAt(root, 'add', 'file.txt')
      const hooks = path.join(directory, 'empty-hooks')
      await fs.mkdir(hooks)
      const hook = path.join(hooks, 'pre-commit')
      await fs.writeFile(
        hook,
        '#!/bin/sh\nprintf "https://fixture-user:fixture-password@example.invalid/repo\\n" >&2\nexit 1\n',
      )
      await fs.chmod(hook, 0o755)
      await expect(service.gitAction(root, 'commit', 'test: hook failure')).rejects.toThrow(
        '[redacted]',
      )
      await expect(service.gitAction(root, 'commit', 'test: hook failure')).rejects.not.toThrow(
        'fixture-password',
      )
    },
  )

  it('creates branches, pushes and fetches against a local bare remote and reports upstream counts/history', async () => {
    await repository()
    await fs.writeFile(path.join(root, 'file.txt'), 'baseline')
    await commit()
    const remote = path.join(directory, 'remote.git')
    await gitAt(directory, 'init', '--bare', remote)
    await gitAt(root, 'remote', 'add', 'origin', remote)
    await service.gitAction(root, 'createBranch', 'feature/sync')
    await service.gitAction(root, 'push', '')
    expect(await service.gitStatus(root)).toMatchObject({
      remote: 'origin',
      upstream: 'origin/feature/sync',
      ahead: 0,
      behind: 0,
    })
    await fs.writeFile(path.join(root, 'file.txt'), 'local commit')
    await commit()
    expect(await service.gitStatus(root)).toMatchObject({ ahead: 1, behind: 0 })
    await service.gitAction(root, 'fetch', '')
    await service.gitAction(root, 'push', '')
    await service.gitAction(root, 'pull', '')
    expect(await service.gitStatus(root)).toMatchObject({ ahead: 0, behind: 0 })
    const history = await service.gitHistory(root)
    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({ subject: 'test: baseline', author: 'Workspace Tests' })
    expect(history[0].hash).toMatch(/^[a-f0-9]{40}$/)
    expect(history[0].timestamp).toBeGreaterThan(0)
    await expect(service.gitAction(root, 'createBranch', '--orphan')).rejects.toThrow()
    await fs.writeFile(path.join(root, 'file.txt'), 'uncommitted')
    await expect(service.gitAction(root, 'pull', '')).rejects.toThrow('Commit or stash')
  })

  it('fast-forwards clean workspaces and leaves divergent histories untouched', async () => {
    await repository()
    await fs.writeFile(path.join(root, 'file.txt'), 'baseline')
    await commit()
    const remote = path.join(directory, 'remote.git')
    await gitAt(directory, 'init', '--bare', remote)
    await gitAt(root, 'remote', 'add', 'origin', remote)
    await service.gitAction(root, 'push', '')
    const other = path.join(directory, 'other')
    await gitAt(directory, 'clone', '--branch', 'main', remote, other)
    await gitAt(other, 'config', 'user.name', 'Other Developer')
    await gitAt(other, 'config', 'user.email', 'other@example.invalid')
    await gitAt(other, 'config', 'commit.gpgsign', 'false')
    await fs.writeFile(path.join(other, 'remote.txt'), 'remote change')
    await gitAt(other, 'add', '-A')
    await gitAt(other, 'commit', '-m', 'test: remote commit')
    await gitAt(other, 'push')
    await service.gitAction(root, 'fetch', '')
    expect(await service.gitStatus(root)).toMatchObject({ ahead: 0, behind: 1 })
    await service.gitAction(root, 'pull', '')
    expect(await fs.readFile(path.join(root, 'remote.txt'), 'utf8')).toBe('remote change')
    await fs.writeFile(path.join(root, 'local.txt'), 'local change')
    await commit()
    await fs.writeFile(path.join(other, 'another.txt'), 'another remote change')
    await gitAt(other, 'add', '-A')
    await gitAt(other, 'commit', '-m', 'test: diverge')
    await gitAt(other, 'push')
    const head = await gitAt(root, 'rev-parse', 'HEAD')
    await expect(service.gitAction(root, 'pull', '')).rejects.toMatchObject({ code: 'GIT_ERROR' })
    expect(await gitAt(root, 'rev-parse', 'HEAD')).toBe(head)
    expect(await fs.readFile(path.join(root, 'local.txt'), 'utf8')).toBe('local change')
    await expect(service.gitAction(root, 'push', '')).rejects.toMatchObject({ code: 'GIT_ERROR' })
  })
})
