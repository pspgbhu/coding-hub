import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ReviewService } from '../src/runtime/review'
import { TaskService } from '../src/runtime/tasks'
import type { TaskRun } from '../src/shared/types'

let folder: string, root: string, data: string
let tasks: TaskService
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'hub-review-'))
  root = join(folder, 'project')
  data = join(folder, 'data')
  await mkdir(root)
  tasks = new TaskService(() => {})
})
afterEach(async () => {
  await tasks.close()
  await rm(folder, { recursive: true, force: true })
})

describe('turn review protects work outside its captured changes', () => {
  it('captures existing dirty content as the baseline, reviews additions/deletions and reverts explicitly selected files', async () => {
    const review = new ReviewService()
    const session = randomUUID(),
      turn = randomUUID()
    await writeFile(join(root, 'dirty.ts'), 'user unsaved-to-git content')
    await writeFile(join(root, 'deleted.ts'), 'keep this baseline')
    await review.capture(root, data, session, randomUUID(), turn)
    await writeFile(join(root, 'dirty.ts'), 'agent changed content')
    await writeFile(join(root, 'new.ts'), 'new content')
    await rm(join(root, 'deleted.ts'))
    const result = await review.finish(root, data, session, turn)
    expect(result?.files.map((f) => f.path).sort()).toEqual(['deleted.ts', 'dirty.ts', 'new.ts'])
    await review.revert(root, data, session, turn, ['dirty.ts', 'new.ts', 'deleted.ts'])
    expect(await readFile(join(root, 'dirty.ts'), 'utf8')).toBe('user unsaved-to-git content')
    expect(await readFile(join(root, 'deleted.ts'), 'utf8')).toBe('keep this baseline')
    await expect(readFile(join(root, 'new.ts'))).rejects.toThrow()
  })
  it('refuses the entire selection when one file changed after the turn', async () => {
    const review = new ReviewService()
    const session = randomUUID(),
      turn = randomUUID()
    await writeFile(join(root, 'a.ts'), 'before a')
    await writeFile(join(root, 'b.ts'), 'before b')
    await review.capture(root, data, session, randomUUID(), turn)
    await writeFile(join(root, 'a.ts'), 'after a')
    await writeFile(join(root, 'b.ts'), 'after b')
    await review.finish(root, data, session, turn)
    await writeFile(join(root, 'b.ts'), 'user subsequent work')
    await expect(review.revert(root, data, session, turn, ['a.ts', 'b.ts'])).rejects.toThrow(
      '本轮后发生变化',
    )
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('after a')
    expect(await readFile(join(root, 'b.ts'), 'utf8')).toBe('user subsequent work')
  })
  it('does not follow external symlinks or capture credential/config/generated contents', async () => {
    const review = new ReviewService()
    const session = randomUUID(),
      turn = randomUUID()
    await writeFile(join(root, '.env'), 'SECRET=value')
    await writeFile(join(root, 'auth.json'), '{"token":"secret"}')
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'node_modules', 'dependency.js'), 'generated')
    await mkdir(join(folder, 'outside'))
    await writeFile(join(folder, 'outside', 'private.txt'), 'outside')
    await symlink(
      join(folder, 'outside'),
      join(root, 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    await review.capture(root, data, session, randomUUID(), turn)
    const stored = await readFile(join(data, 'reviews', session, turn + '.json'), 'utf8')
    expect(stored).not.toContain('SECRET=value')
    expect(stored).not.toContain('outside')
    expect(stored).not.toContain('generated')
  })
  it('never offers text-to-binary conversion as a safe deletion to undo', async () => {
    const review = new ReviewService()
    const session = randomUUID(),
      turn = randomUUID()
    await writeFile(join(root, 'changed.dat'), 'before text')
    await review.capture(root, data, session, randomUUID(), turn)
    await writeFile(join(root, 'changed.dat'), Buffer.from([0, 1, 2]))
    const result = await review.finish(root, data, session, turn)
    expect(result?.files[0].reviewable).toBe(false)
    await expect(review.revert(root, data, session, turn, ['changed.dat'])).rejects.toThrow(
      '完整文本快照',
    )
  })
})

describe('explicit project checks', () => {
  it('discovers scripts without running them and records actual output and exit status', async () => {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'node dangerous.js' }, packageManager: 'pnpm@11.24.0' }),
    )
    expect(await tasks.definitions(root)).toEqual([
      { id: 'test', name: 'test', command: 'pnpm', args: ['run', 'test'] },
    ])
    let resolveCompleted!: (run: TaskRun) => void
    const completed = new Promise<TaskRun>((resolve) => {
      resolveCompleted = resolve
    })
    tasks = new TaskService((run) => {
      if (run.status !== 'running') resolveCompleted(run)
    })
    const workspace = randomUUID()
    const marker = join(root, 'check-executed')
    const run = await tasks.run(root, data, workspace, {
      id: 'explicit',
      name: 'check fixture',
      command: process.execPath,
      args: [
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(marker)},'executed');console.log("中文验证");process.exit(3)`,
      ],
    })
    // Startup acknowledgement precedes verified process cleanup and persistence.
    // The terminal event is the completion barrier, within the existing test budget.
    const result = await completed
    expect(result).toMatchObject({
      id: run.id,
      workspaceId: workspace,
      status: 'failed',
      exitCode: 3,
    })
    expect(result.finishedAt).toBeGreaterThanOrEqual(run.startedAt)
    expect(result.output).toContain('中文验证')
    expect(await readFile(marker, 'utf8')).toBe('executed')
    const stored: TaskRun = JSON.parse(
      await readFile(join(data, 'tasks', run.id + '.json'), 'utf8'),
    )
    expect(stored).toEqual(result)
    const reopened = new TaskService(() => {})
    expect((await reopened.list(data, workspace))[0]).toEqual(result)
  })
  it('prevents a second check in the same workspace and allows explicit cancellation', async () => {
    const workspace = randomUUID()
    const run = await tasks.run(root, data, workspace, {
      id: 'wait',
      name: 'wait',
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
    })
    await expect(
      tasks.run(root, data, workspace, {
        id: 'other',
        name: 'other',
        command: process.execPath,
        args: ['-e', 'console.log("no")'],
      }),
    ).rejects.toThrow('正在运行')
    await tasks.cancel(run.id)
    expect((await tasks.list(data, workspace))[0].status).toBe('cancelled')
  })
})
