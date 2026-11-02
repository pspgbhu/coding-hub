import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  chmod,
  stat,
  symlink,
  rm,
  rename,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { WorkspaceService, MAX_FILE_BYTES, parsePorcelain } from '../src/runtime/workspace'
import {
  closeAllProcesses,
  launch,
  resolveCommand,
  runCommand,
  terminateProcessTree,
} from '../src/runtime/process'
import { TerminalService } from '../src/runtime/terminal'

let directory: string
let root: string
let service: WorkspaceService

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'coding-hub-workspace-'))
  root = path.join(directory, 'project')
  await mkdir(root)
  service = new WorkspaceService()
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function git(...args: string[]): Promise<string> {
  const executable = await resolveCommand('git')
  if (!executable) throw new Error('Git is required for workspace integration tests')
  const result = await runCommand(executable, args, root)
  if (result.code !== 0) throw new Error(result.stderr)
  return result.stdout
}

async function repository(): Promise<void> {
  await git('init', '-b', 'main')
  await git('config', 'user.name', 'Coding Hub Tests')
  await git('config', 'user.email', 'coding-hub-test@example.invalid')
  await git('config', 'commit.gpgsign', 'false')
  await git('config', 'core.hooksPath', path.join(directory, 'empty-hooks'))
}

describe('project files', () => {
  it('lists directories first and omits generated directories without hiding source dotfiles', async () => {
    await Promise.all([
      mkdir(path.join(root, 'src')),
      mkdir(path.join(root, 'node_modules')),
      mkdir(path.join(root, '.git')),
      writeFile(path.join(root, 'z.ts'), ''),
      writeFile(path.join(root, 'a.ts'), ''),
      writeFile(path.join(root, '.gitignore'), ''),
    ])
    expect((await service.listFiles(root)).map((entry) => entry.name)).toEqual([
      'src',
      '.gitignore',
      'a.ts',
      'z.ts',
    ])
  })

  it('rejects traversal, absolute paths and symlinks escaping the project', async () => {
    await writeFile(path.join(directory, 'secret'), 'private')
    for (const value of [
      '../secret',
      'src/../../secret',
      '/etc/passwd',
      'C:\\Windows\\file',
      '..\\secret',
    ]) {
      await expect(service.readFile(root, value)).rejects.toMatchObject({ code: 'INVALID_PATH' })
    }
    await mkdir(path.join(directory, 'outside'))
    await writeFile(path.join(directory, 'outside', 'secret'), 'private')
    await symlink(
      path.join(directory, 'outside'),
      path.join(root, 'secret-link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    await expect(service.readFile(root, 'secret-link/secret')).rejects.toMatchObject({
      code: 'OUTSIDE_PROJECT',
    })
    await expect(
      service.saveFile(root, 'secret-link/secret', 'changed', '', true),
    ).rejects.toMatchObject({ code: 'OUTSIDE_PROJECT' })
    expect(await service.listFiles(root)).toEqual([])
  })

  it('reads UTF-8, preserves a BOM and line endings, and identifies the language', async () => {
    const content = '\uFEFFconst value = "你好"\r\n'
    await writeFile(path.join(root, 'hello.tsx'), content)
    const file = await service.readFile(root, 'hello.tsx')
    expect(file.content).toBe(content)
    expect(file.language).toBe('typescript')
    expect(file.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects binary data, invalid UTF-8 and oversized files', async () => {
    await writeFile(path.join(root, 'nul.bin'), Buffer.from([65, 0, 66]))
    await writeFile(path.join(root, 'invalid.bin'), Buffer.from([0xff, 0xfe]))
    await writeFile(path.join(root, 'large.txt'), Buffer.alloc(MAX_FILE_BYTES + 1, 65))
    for (const file of ['nul.bin', 'invalid.bin'])
      await expect(service.readFile(root, file)).rejects.toMatchObject({ code: 'BINARY_FILE' })
    await expect(service.readFile(root, 'large.txt')).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE',
    })
  })

  it('detects an external edit, permits explicit overwrite and preserves the executable mode', async () => {
    const filename = path.join(root, 'script.sh')
    await writeFile(filename, '#!/bin/sh\necho before\n')
    await chmod(filename, 0o755)
    const opened = await service.readFile(root, 'script.sh')
    await writeFile(filename, 'external edit\n')
    await expect(
      service.saveFile(root, 'script.sh', 'client edit\n', opened.fingerprint),
    ).rejects.toMatchObject({ code: 'FILE_CONFLICT' })
    expect(await readFile(filename, 'utf8')).toBe('external edit\n')
    const saved = await service.saveFile(
      root,
      'script.sh',
      'client edit\n',
      opened.fingerprint,
      true,
    )
    expect(saved.content).toBe('client edit\n')
    expect(saved.fingerprint).not.toBe(opened.fingerprint)
    if (process.platform !== 'win32') expect((await stat(filename)).mode & 0o777).toBe(0o755)
  })

  it('serializes concurrent saves so the stale second save cannot overwrite the first', async () => {
    await writeFile(path.join(root, 'file.txt'), 'baseline')
    const opened = await service.readFile(root, 'file.txt')
    const results = await Promise.allSettled([
      service.saveFile(root, 'file.txt', 'first', opened.fingerprint),
      service.saveFile(root, 'file.txt', 'second', opened.fingerprint),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      status: 'rejected',
      reason: { code: 'FILE_CONFLICT' },
    })
    const winner = results[0].status === 'fulfilled' ? 'first' : 'second'
    expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe(winner)
  })
})

describe('Git workspace integration', () => {
  it('reports a directory that is not a repository', async () => {
    expect(await service.gitStatus(root)).toEqual({
      branch: '',
      files: [],
      branches: [],
      isRepo: false,
    })
  })

  it('parses rename records without treating the original path as another file', () => {
    expect(parsePorcelain('R  new name.ts\0old name.ts\0 M next.ts\0?? a\nfile.txt\0')).toEqual([
      { path: 'new name.ts', originalPath: 'old name.ts', index: 'R', working: ' ' },
      { path: 'next.ts', index: ' ', working: 'M' },
      { path: 'a\nfile.txt', index: '?', working: '?' },
    ])
  })

  it('stages and unstages on an unborn branch, then commits and checks out a local branch', async () => {
    await repository()
    await writeFile(path.join(root, 'first.txt'), 'initial\n')
    expect((await service.gitStatus(root)).branch).toBe('main')
    await service.gitAction(root, 'stage', 'first.txt')
    expect(await service.gitDiff(root, 'first.txt', true)).toMatchObject({
      original: '',
      modified: 'initial\n',
      staged: true,
    })
    await service.gitAction(root, 'unstage', 'first.txt')
    expect((await service.gitStatus(root)).files).toEqual([
      { path: 'first.txt', index: '?', working: '?' },
    ])
    expect(await readFile(path.join(root, 'first.txt'), 'utf8')).toBe('initial\n')
    await service.gitAction(root, 'stage', 'first.txt')
    await service.gitAction(root, 'commit', 'test: initial workspace')
    await git('branch', 'feature')
    await service.gitAction(root, 'checkout', 'feature')
    expect((await service.gitStatus(root)).branch).toBe('feature')
    await expect(service.gitAction(root, 'checkout', '--orphan')).rejects.toMatchObject({
      code: 'GIT_ERROR',
    })
  })

  it('distinguishes staged, working and deleted contents, including renamed paths', async () => {
    await repository()
    await writeFile(path.join(root, 'before.txt'), 'baseline\n')
    await service.gitAction(root, 'stage', 'before.txt')
    await service.gitAction(root, 'commit', 'test: baseline')
    await rename(path.join(root, 'before.txt'), path.join(root, 'after.txt'))
    await git('add', '-A')
    expect((await service.gitStatus(root)).files).toEqual([
      { path: 'after.txt', index: 'R', working: ' ' },
    ])
    expect(await service.gitDiff(root, 'after.txt', true)).toMatchObject({
      original: 'baseline\n',
      modified: 'baseline\n',
    })
    await writeFile(path.join(root, 'after.txt'), 'working\n')
    expect(await service.gitDiff(root, 'after.txt')).toMatchObject({
      original: 'baseline\n',
      modified: 'working\n',
    })
    await rm(path.join(root, 'after.txt'))
    expect(await service.gitDiff(root, 'after.txt')).toMatchObject({
      original: 'baseline\n',
      modified: '',
    })
  })

  it('treats pathspec magic and option-looking filenames literally', async () => {
    await repository()
    if (process.platform !== 'win32') await writeFile(path.join(root, ':(glob)*.txt'), 'literal\n')
    await writeFile(path.join(root, 'other.txt'), 'untouched\n')
    await writeFile(path.join(root, '--all'), 'option filename\n')
    if (process.platform !== 'win32') await service.gitAction(root, 'stage', ':(glob)*.txt')
    await service.gitAction(root, 'stage', '--all')
    const status = await service.gitStatus(root)
    expect(status.files.find((file) => file.path === 'other.txt')?.index).toBe('?')
    if (process.platform !== 'win32')
      expect(status.files.find((file) => file.path === ':(glob)*.txt')?.index).toBe('A')
    expect(status.files.find((file) => file.path === '--all')?.index).toBe('A')
  })

  it('returns paths relative to an opened subdirectory of a repository', async () => {
    await repository()
    await mkdir(path.join(root, 'nested'))
    await writeFile(path.join(root, 'nested', 'file.txt'), 'nested\n')
    await writeFile(path.join(root, 'outside.txt'), 'outside\n')
    const nested = path.join(root, 'nested')
    expect((await service.gitStatus(nested)).files).toEqual([
      { path: 'file.txt', index: '?', working: '?' },
    ])
  })
})

async function isRunning(pid: number): Promise<boolean> {
  if (process.platform === 'win32') {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  return new Promise((resolve) =>
    execFile('/bin/ps', ['-p', String(pid), '-o', 'stat='], (_error, stdout) =>
      resolve(Boolean(stdout.trim()) && !stdout.trim().startsWith('Z')),
    ),
  )
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3000
  while (await isRunning(pid)) {
    if (Date.now() > deadline) throw new Error(`Process ${pid} did not exit`)
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
}

async function readChildPid(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    let stderr = ''
    let complete = false
    const timer = setTimeout(
      () => reject(new Error(`Child process did not start: ${buffer} ${stderr}`)),
      5000,
    )
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.once('close', (code) => {
      if (!complete) {
        clearTimeout(timer)
        reject(new Error(`Child exited (${code}): ${buffer} ${stderr}`))
      }
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk)
      const line = /^(\d+)\r?\n/m.exec(buffer)
      if (line) {
        complete = true
        clearTimeout(timer)
        resolve(Number(line[1]))
      }
    })
  })
}

describe('owned process lifecycle', () => {
  it('passes shell metacharacters as literal native executable arguments', async () => {
    const args = ['two words', '$(never execute)', 'a&b', 'a"quote', 'line\nbreak']
    const result = await runCommand(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args],
      root,
    )
    expect(JSON.parse(result.stdout)).toEqual(args)
  })

  it('terminates its child and grandchild while leaving an unrelated process alive', async () => {
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'pipe',
    })
    const grandchildCode =
      'process.on("SIGTERM",()=>{});process.send("ready");setInterval(()=>{},1000)'
    const parentCode = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(grandchildCode)}],{stdio:['ignore','ignore','ignore','ipc']});child.once('message',()=>console.log(child.pid));setInterval(()=>{},1000)`
    const child = launch(process.execPath, ['-e', parentCode], root)
    let descendant: number | undefined
    try {
      descendant = await readChildPid(child)
      expect(await isRunning(descendant)).toBe(true)
      await terminateProcessTree(child)
      await waitForExit(child.pid!)
      await waitForExit(descendant)
      expect(await isRunning(unrelated.pid!)).toBe(true)
      await expect(terminateProcessTree(unrelated)).rejects.toThrow('not launched by Coding Hub')
    } finally {
      await terminateProcessTree(child, true)
      if (descendant && (await isRunning(descendant))) process.kill(descendant, 'SIGKILL')
      unrelated.kill('SIGKILL')
    }
  }, 10_000)

  it('cleans descendants before rejecting a timed out command', async () => {
    const marker = path.join(directory, 'child.pid')
    const code = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(marker)},String(child.pid));setInterval(()=>{},1000)`
    let descendant: number | undefined
    try {
      await expect(
        runCommand(process.execPath, ['-e', code], root, { timeoutMs: 1500 }),
      ).rejects.toThrow('timed out')
      descendant = Number(await readFile(marker, 'utf8'))
      await waitForExit(descendant)
    } finally {
      if (descendant && (await isRunning(descendant))) process.kill(descendant, 'SIGKILL')
    }
  }, 10_000)

  it.skipIf(process.platform === 'win32')(
    'closes a real PTY and its background job, then refuses new terminals',
    async () => {
      const originalShell = process.env.SHELL
      process.env.SHELL = '/bin/sh'
      let output = ''
      let descendant: number | undefined
      const terminal = new TerminalService((message) => {
        if (message.data) {
          output += message.data
          terminal.ack(message.id, Buffer.byteLength(message.data, 'utf8'))
        }
      })
      try {
        const id = await terminal.create(root, 80, 24)
        terminal.write(id, "sleep 30 & printf '__CODING_HUB_CHILD__'; jobs -p\r")
        const deadline = Date.now() + 5000
        while (!descendant) {
          const match = /__CODING_HUB_CHILD__(\d+)/.exec(output)
          if (match) descendant = Number(match[1])
          else if (Date.now() > deadline)
            throw new Error(`Terminal did not produce a child PID: ${output}`)
          else await new Promise((resolve) => setTimeout(resolve, 40))
        }
        expect(await isRunning(descendant)).toBe(true)
        await terminal.closeAll()
        await waitForExit(descendant)
        await expect(terminal.create(root, 80, 24)).rejects.toThrow('closing')
        expect(() => terminal.write('unknown-terminal', 'anything')).toThrow('does not exist')
      } finally {
        await terminal.closeAll()
        if (descendant && (await isRunning(descendant))) process.kill(descendant, 'SIGKILL')
        if (originalShell === undefined) delete process.env.SHELL
        else process.env.SHELL = originalShell
      }
    },
    10_000,
  )

  it('closes all registered processes and prevents launches after shutdown', async () => {
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'pipe',
    })
    const child = launch(
      process.execPath,
      ['-e', 'console.log(process.pid);setInterval(() => {},1000)'],
      root,
    )
    try {
      await readChildPid(child)
      await closeAllProcesses()
      await waitForExit(child.pid!)
      expect(await isRunning(unrelated.pid!)).toBe(true)
      expect(() => launch(process.execPath, ['--version'])).toThrow('shutting down')
    } finally {
      unrelated.kill('SIGKILL')
      await terminateProcessTree(child, true)
    }
  }, 10_000)
})
