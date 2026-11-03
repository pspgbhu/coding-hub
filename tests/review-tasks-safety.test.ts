import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as processes from '../src/runtime/process'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { ReviewService } from '../src/runtime/review'
import { TaskService } from '../src/runtime/tasks'
import type { TaskRun } from '../src/shared/types'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}))
vi.mock('../src/runtime/process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/runtime/process')>()),
}))

let folder: string, root: string, data: string
let tasks: TaskService
beforeEach(async () => {
  folder = await fs.mkdtemp(join(tmpdir(), 'hub-review-safety-'))
  root = join(folder, 'project')
  data = join(folder, 'data')
  await fs.mkdir(root)
  tasks = new TaskService(() => {})
})
afterEach(async () => {
  vi.restoreAllMocks()
  await tasks.close()
  await fs.rm(folder, { recursive: true, force: true })
})

async function baseline(): Promise<{ review: ReviewService; session: string; turn: string }> {
  const review = new ReviewService(),
    session = randomUUID(),
    turn = randomUUID()
  await fs.writeFile(join(root, 'a.ts'), 'before a')
  await fs.writeFile(join(root, 'b.ts'), 'before b')
  await review.capture(root, data, session, randomUUID(), turn)
  await fs.writeFile(join(root, 'a.ts'), 'after a')
  await fs.writeFile(join(root, 'b.ts'), 'after b')
  await review.finish(root, data, session, turn)
  return { review, session, turn }
}

describe('safe immutable review baselines', () => {
  it('does not mark unchanged binary, symlink or excluded configuration files as changed', async () => {
    const review = new ReviewService(),
      session = randomUUID(),
      turn = randomUUID()
    await fs.writeFile(join(root, 'binary.dat'), Buffer.from([0, 1, 2]))
    await fs.writeFile(join(root, '.env'), 'private-token-value')
    await fs.writeFile(join(root, 'text.ts'), 'before')
    await review.capture(root, data, session, randomUUID(), turn)
    await fs.writeFile(join(root, 'text.ts'), 'after')
    expect(
      (await review.finish(root, data, session, turn))?.files.map((file) => file.path),
    ).toEqual(['text.ts'])
    await fs.writeFile(join(root, 'text.ts'), 'later user edit')
    // Repeated finish is idempotent and never absorbs subsequent edits into the completed turn.
    expect((await review.finish(root, data, session, turn))?.files[0].after).toBe('after')
    expect(await fs.readFile(join(data, 'reviews', session, `${turn}.json`), 'utf8')).not.toContain(
      'private-token-value',
    )
  })

  it('restores captured BOM, CRLF and executable mode exactly', async () => {
    const review = new ReviewService(),
      session = randomUUID(),
      turn = randomUUID()
    const before = '\uFEFF#!/bin/sh\r\necho before\r\n'
    await fs.writeFile(join(root, 'script.sh'), before)
    await fs.chmod(join(root, 'script.sh'), 0o755)
    await review.capture(root, data, session, randomUUID(), turn)
    await fs.writeFile(join(root, 'script.sh'), '#!/bin/sh\necho after\n')
    await fs.chmod(join(root, 'script.sh'), 0o644)
    await review.finish(root, data, session, turn)
    await review.revert(root, data, session, turn, ['script.sh'])
    expect(await fs.readFile(join(root, 'script.sh'), 'utf8')).toBe(before)
    if (process.platform !== 'win32')
      expect((await fs.stat(join(root, 'script.sh'))).mode & 0o777).toBe(0o755)
  })

  it.skipIf(process.platform === 'win32')('reviews and reverses mode-only changes', async () => {
    const review = new ReviewService(),
      session = randomUUID(),
      turn = randomUUID()
    await fs.writeFile(join(root, 'script.sh'), 'unchanged content')
    await fs.chmod(join(root, 'script.sh'), 0o644)
    await review.capture(root, data, session, randomUUID(), turn)
    await fs.chmod(join(root, 'script.sh'), 0o755)
    const result = await review.finish(root, data, session, turn)
    expect(result?.files.map((file) => file.path)).toEqual(['script.sh'])
    await review.revert(root, data, session, turn, ['script.sh'])
    expect((await fs.stat(join(root, 'script.sh'))).mode & 0o777).toBe(0o644)
  })

  it('rolls back earlier files when a later revert fails', async () => {
    const { review, session, turn } = await baseline()
    const actualRename = fs.rename
    let replacements = 0
    vi.spyOn(fs, 'rename').mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
      if (
        String(args[0]).includes('.coding-hub-save-') &&
        ['a.ts', 'b.ts'].includes(basename(String(args[1]))) &&
        ++replacements === 2
      )
        throw new Error('simulated second-file failure')
      return actualRename(...args)
    })
    await expect(review.revert(root, data, session, turn, ['a.ts', 'b.ts'])).rejects.toThrow(
      '已恢复操作前',
    )
    expect(await fs.readFile(join(root, 'a.ts'), 'utf8')).toBe('after a')
    expect(await fs.readFile(join(root, 'b.ts'), 'utf8')).toBe('after b')
  })

  it('preserves a concurrent user edit when rolling back an interrupted batch', async () => {
    const { review, session, turn } = await baseline()
    const actualRename = fs.rename
    let replacements = 0
    vi.spyOn(fs, 'rename').mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
      if (
        String(args[0]).includes('.coding-hub-save-') &&
        ['a.ts', 'b.ts'].includes(basename(String(args[1]))) &&
        ++replacements === 2
      ) {
        await fs.writeFile(join(root, 'a.ts'), 'user concurrent edit')
        throw new Error('simulated second-file failure')
      }
      return actualRename(...args)
    })
    await expect(review.revert(root, data, session, turn, ['a.ts', 'b.ts'])).rejects.toThrow(
      '未自动回滚',
    )
    expect(await fs.readFile(join(root, 'a.ts'), 'utf8')).toBe('user concurrent edit')
    expect(await fs.readFile(join(root, 'b.ts'), 'utf8')).toBe('after b')
  })

  it('handles prototype-looking filenames and reports corrupt baselines visibly', async () => {
    const review = new ReviewService(),
      session = randomUUID(),
      turn = randomUUID()
    await fs.writeFile(join(root, '__proto__'), 'before')
    await review.capture(root, data, session, randomUUID(), turn)
    await fs.writeFile(join(root, '__proto__'), 'after')
    const result = await review.finish(root, data, session, turn)
    expect(result?.files[0]).toMatchObject({
      path: '__proto__',
      before: 'before',
      after: 'after',
      reviewable: true,
    })
    await review.revert(root, data, session, turn, ['__proto__'])
    expect(await fs.readFile(join(root, '__proto__'), 'utf8')).toBe('before')
    await fs.writeFile(join(data, 'reviews', session, `${turn}.json`), 'broken')
    await expect(review.get(data, session, turn)).rejects.toThrow('损坏')
  })
})

const definition = (code: string) => ({
  id: 'fixture',
  name: 'fixture',
  command: process.execPath,
  args: ['-e', code],
})

describe('task lifecycle and persistence boundaries', () => {
  it('reports malformed script discovery and redacts credential arguments in persisted task history', async () => {
    await fs.writeFile(join(root, 'package.json'), '{broken')
    await expect(tasks.definitions(root)).rejects.toThrow('检查脚本')
    const workspace = randomUUID()
    const run = await tasks.run(root, data, workspace, {
      id: 'credentials',
      name: 'credential fixture',
      command: process.execPath,
      args: ['-e', 'process.exit(0)', '--', '--token', 'fixture-private-token'],
    })
    await expect
      .poll(async () => (await tasks.list(data, workspace))[0].status, { timeout: 5000 })
      .toBe('passed')
    const stored = await fs.readFile(join(data, 'tasks', `${run.id}.json`), 'utf8')
    expect(stored).not.toContain('fixture-private-token')
    expect(stored).toContain('[redacted]')
  })

  it('reserves a workspace before asynchronous startup', async () => {
    const workspace = randomUUID()
    const results = await Promise.allSettled([
      tasks.run(root, data, workspace, definition('setInterval(()=>{},1000)')),
      tasks.run(root, data, workspace, definition('setInterval(()=>{},1000)')),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const run = results.find(
      (result) => result.status === 'fulfilled',
    ) as PromiseFulfilledResult<TaskRun>
    await tasks.cancel(run.value.id)
  })

  it('does not launch or leave a stale running reservation when initial persistence fails', async () => {
    await fs.mkdir(data)
    await fs.writeFile(join(data, 'tasks'), 'blocks directory creation')
    const workspace = randomUUID(),
      marker = join(root, 'executed')
    await expect(
      tasks.run(
        root,
        data,
        workspace,
        definition(`require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`),
      ),
    ).rejects.toThrow()
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    await fs.rm(join(data, 'tasks'))
    const run = await tasks.run(root, data, workspace, definition('process.exit(0)'))
    await expect.poll(async () => (await tasks.list(data))[0].status).toBe('passed')
    expect(run.id).toBeTruthy()
  })

  it('retains running status on a failed stop and allows a confirmed retry', async () => {
    const workspace = randomUUID()
    const run = await tasks.run(root, data, workspace, definition('setInterval(()=>{},1000)'))
    vi.spyOn(processes, 'terminateProcessTree').mockRejectedValueOnce(
      new Error('fixture stop failure'),
    )
    await expect(tasks.cancel(run.id)).rejects.toThrow('stop failure')
    expect((await tasks.list(data, workspace))[0].status).toBe('running')
    await tasks.cancel(run.id)
    expect((await tasks.list(data, workspace))[0].status).toBe('cancelled')
  })

  it('blocks startup during shutdown without running the command', async () => {
    const marker = join(root, 'executed')
    const starting = tasks.run(
      root,
      data,
      randomUUID(),
      definition(`require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`),
    )
    const closing = tasks.close()
    await expect(starting).rejects.toThrow('退出')
    await closing
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('persists a failed spawn as failed rather than permanently running', async () => {
    const workspace = randomUUID()
    const readRun = async (id: string): Promise<TaskRun> =>
      JSON.parse(await fs.readFile(join(data, 'tasks', `${id}.json`), 'utf8'))
    const failed = await tasks.run(
      join(root, 'missing'),
      data,
      workspace,
      definition('process.exit(0)'),
    )
    // Natural exit waits for verified process-tree cleanup, then atomically persists the
    // terminal state. A 1s UI-poll deadline can race legitimate cleanup under parallel CI.
    await expect
      .poll(async () => (await readRun(failed.id)).status, { timeout: 8000 })
      .toBe('failed')
    const failedResult = await readRun(failed.id)
    expect(failedResult.exitCode).toBeTypeOf('number')
    expect(failedResult.exitCode).not.toBe(0)
    expect(failedResult.finishedAt).toBeGreaterThanOrEqual(failed.startedAt)
    expect(failedResult.output).toMatch(/ENOENT|not found|no such/i)
    // The failed attempt must release the workspace so a real command can run next.
    const run = await tasks.run(root, data, workspace, definition('process.exit(0)'))
    await expect.poll(async () => (await readRun(run.id)).status, { timeout: 8000 }).toBe('passed')
    expect(await readRun(run.id)).toMatchObject({ id: run.id, status: 'passed', exitCode: 0 })
    expect((await readRun(run.id)).finishedAt).toBeGreaterThanOrEqual(run.startedAt)
    expect((await tasks.list(data, workspace)).find((entry) => entry.id === run.id)).toMatchObject({
      status: 'passed',
      exitCode: 0,
    })
  })

  it.skipIf(process.platform === 'win32')(
    'confirms natural-exit descendant cleanup before declaring a task passed',
    async () => {
      let completed: TaskRun | undefined
      tasks = new TaskService((run) => {
        if (run.status !== 'running') completed = run
      })
      const grandchild = 'setInterval(()=>{},1000)'
      const code = `const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'inherit'});console.log('GRANDCHILD='+child.pid);setTimeout(()=>process.exit(0),150)`
      const run = await tasks.run(root, data, randomUUID(), definition(code))
      await expect.poll(() => completed?.status, { timeout: 8000 }).toBe('passed')
      const pid = Number(/GRANDCHILD=(\d+)/.exec(completed!.output)?.[1])
      expect(pid).toBeGreaterThan(1)
      const alive = await new Promise<boolean>((resolve) =>
        execFile('/bin/ps', ['-p', String(pid), '-o', 'stat='], (_error, stdout) =>
          resolve(Boolean(stdout.trim()) && !stdout.trim().startsWith('Z')),
        ),
      )
      expect(alive).toBe(false)
      expect((await tasks.list(data)).find((entry) => entry.id === run.id)?.status).toBe('passed')
    },
  )
})
