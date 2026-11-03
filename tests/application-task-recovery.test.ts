import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import type { TaskRun, SessionView, BackupInfo } from '../src/shared/types'
import type { RuntimeClient } from '../src/main/runtime-client'
import { Store } from '../src/main/store'
import { ApplicationServices } from '../src/main/application'

const fixture = vi.hoisted(() => ({ dataDir: '', cleanup: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => fixture.dataDir, getVersion: () => 'test' },
  dialog: {},
  shell: {},
  Notification: { isSupported: () => false },
}))
vi.mock('../src/main/updates', () => ({
  UpdateService: class {
    get() {
      return { status: 'unconfigured' }
    }
  },
}))
vi.mock('../src/runtime/process', () => ({
  terminateOwnedProcesses: fixture.cleanup,
  resolveCommand: vi.fn(),
}))

class Runtime extends EventEmitter {
  calls: { method: string; args: unknown[] }[] = []
  async start() {}
  async close() {}
  resumeAfterFailedClose() {}
  async call(method: string, ...args: unknown[]): Promise<any> {
    this.calls.push({ method, args })
    if (method === 'workspace.inspect')
      return { rootPath: args[0], canonicalId: args[0], hasHead: true }
    if (method === 'task.run') {
      const definition = args[3] as { name: string; command: string; args: string[] }
      const run: TaskRun = {
        id: randomUUID(),
        workspaceId: String(args[2]),
        ...definition,
        status: 'running',
        startedAt: Date.now(),
        output: 'partial check output',
      }
      this.emit('task', run)
      return run
    }
  }
}
let directory: string, store: Store, runtime: Runtime, services: ApplicationServices
const sent = vi.fn()
const window = { isDestroyed: () => false, webContents: { send: sent } } as unknown as BrowserWindow
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'hub-task-recovery-'))
  fixture.dataDir = directory
  fixture.cleanup.mockReset().mockResolvedValue(undefined)
  sent.mockClear()
  store = new Store(join(directory, 'test.db'))
  runtime = new Runtime()
  services = new ApplicationServices(runtime as unknown as RuntimeClient, store, () => window)
})
afterEach(async () => {
  fixture.cleanup.mockResolvedValue(undefined)
  await services.close()
  vi.restoreAllMocks()
  store.close()
  rmSync(directory, { recursive: true, force: true })
})
const definition = { id: 'check', name: 'verification', command: 'fixture-check', args: [] }
const startTask = (workspaceId: string) =>
  services.handlers.runTask(workspaceId, definition) as Promise<TaskRun>
const listTasks = (workspaceId: string) => services.handlers.listTasks(workspaceId) as TaskRun[]
function setup() {
  const project = store.addProject(join(directory, 'project'), 'fixture')
  store.patchProject(project.id, { trusted: true })
  return project
}
function ownProcess() {
  const process = {
    id: randomUUID(),
    pid: 12345,
    started: 'Tue Nov 3 10:00:00 2026',
    isolatedGroup: true,
  }
  runtime.emit('ownership', { action: 'register', process })
  return process
}
function storedTask(taskId: string): TaskRun {
  return JSON.parse(
    (
      store.db.prepare('SELECT data FROM settings WHERE key=?').get('task:' + taskId) as {
        data: string
      }
    ).data,
  )
}
type ArtifactWriter = { saveArtifact(key: string, value: unknown): void }
function failOneTaskWrite(status: TaskRun['status']) {
  const target = services as unknown as ArtifactWriter
  const original = target.saveArtifact.bind(target)
  let failed = false
  return vi.spyOn(target, 'saveArtifact').mockImplementation((key, value) => {
    if (!failed && key.startsWith('task:') && (value as TaskRun).status === status) {
      failed = true
      throw new Error('SQLITE_FULL fixture')
    }
    original(key, value)
  })
}

describe('verification task recovery after runtime loss', () => {
  it('waits for confirmed owned cleanup, persists cancellation and permits a new explicit task', async () => {
    const project = setup()
    const run = await startTask(project.id)
    ownProcess()
    let confirm!: () => void
    fixture.cleanup.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          confirm = resolve
        }),
    )
    runtime.emit('exit', 1)
    expect(listTasks(project.id)[0].status).toBe('running')
    expect(storedTask(run.id).status).toBe('running')
    confirm()
    await services.ready()

    const cancelled = listTasks(project.id).find((entry) => entry.id === run.id)!
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      output: expect.stringContaining('未自动重发'),
    })
    expect(cancelled.finishedAt).toBeGreaterThanOrEqual(run.startedAt)
    expect(cancelled.output).toContain('partial check output')
    expect(storedTask(run.id)).toEqual(cancelled)
    expect(
      sent.mock.calls.some(
        ([channel, value]) =>
          channel === 'hub:task' && value.id === run.id && value.status === 'cancelled',
      ),
    ).toBe(true)
    expect(runtime.calls.filter((entry) => entry.method === 'task.run')).toHaveLength(1)
    await expect(startTask(project.id)).resolves.toMatchObject({ status: 'running' })
    expect(runtime.calls.filter((entry) => entry.method === 'task.run')).toHaveLength(2)
  })

  it('keeps the running task locked on failed cleanup and reconciles it after an explicit recovery', async () => {
    const project = setup()
    const run = await startTask(project.id)
    ownProcess()
    fixture.cleanup.mockRejectedValueOnce(new Error('owned cleanup failed'))
    runtime.emit('exit', 1)
    await services.ready()
    expect(listTasks(project.id)[0].status).toBe('running')
    expect(storedTask(run.id).status).toBe('running')
    await expect(startTask(project.id)).rejects.toThrow('WORKSPACE_BUSY')

    await services.handlers.retryStorage()
    expect(listTasks(project.id)[0].status).toBe('cancelled')
    expect(storedTask(run.id).status).toBe('cancelled')
    await expect(startTask(project.id)).resolves.toMatchObject({ status: 'running' })
  })

  it('keeps the latest memory state visible and resaves it after a recovered cancellation hits storage failure', async () => {
    const project = setup()
    const run = await startTask(project.id)
    ownProcess()
    failOneTaskWrite('cancelled')
    runtime.emit('exit', 1)
    await services.ready()
    const cancelled = listTasks(project.id)[0]
    expect(cancelled.status).toBe('cancelled')
    expect(storedTask(run.id).status).toBe('running')
    expect(services.healthState.storage).toBe('error')

    await services.handlers.retryStorage()
    expect(storedTask(run.id)).toEqual(cancelled)
    expect(services.healthState.storage).toBe('ready')
    await expect(startTask(project.id)).resolves.toMatchObject({ status: 'running' })
  })

  it('retries terminal task writes without cancelling a healthy running task outside recovery', async () => {
    const project = setup()
    const run = await startTask(project.id)
    failOneTaskWrite('passed')
    const completed: TaskRun = {
      ...run,
      status: 'passed',
      finishedAt: Date.now(),
      output: 'CHECK_OK',
    }
    runtime.emit('task', completed)
    expect(listTasks(project.id)[0]).toEqual(completed)
    expect(storedTask(run.id).status).toBe('running')
    await services.handlers.retryStorage()
    expect(storedTask(run.id)).toEqual(completed)

    await services.ready()
    const healthy = await startTask(project.id)
    ownProcess()
    fixture.cleanup.mockClear()
    await services.handlers.retryStorage()
    expect(listTasks(project.id).find((entry) => entry.id === healthy.id)?.status).toBe('running')
    expect(storedTask(healthy.id).status).toBe('running')
    expect(fixture.cleanup).not.toHaveBeenCalled()
    expect(runtime.calls.some((entry) => entry.method === 'task.cancel')).toBe(false)
  })

  it('reconciles a live owned task when storage recovery must stop its process', async () => {
    const project = setup()
    await services.ready()
    const run = await startTask(project.id)
    ownProcess()
    failOneTaskWrite('running')
    runtime.emit('task', { ...run, output: 'latest progress before storage failure' })
    expect(services.healthState.storage).toBe('error')
    expect(listTasks(project.id)[0].status).toBe('running')
    await services.handlers.retryStorage()
    expect(fixture.cleanup).toHaveBeenCalledOnce()
    expect(storedTask(run.id)).toMatchObject({
      status: 'cancelled',
      finishedAt: expect.any(Number),
    })
    expect(listTasks(project.id)[0].output).toContain('latest progress before storage failure')
    await expect(startTask(project.id)).resolves.toMatchObject({ status: 'running' })
  })

  it('archives persisted running tasks on startup only after owned cleanup has confirmed', async () => {
    const project = setup()
    const run = await startTask(project.id)
    const owned = ownProcess()
    await services.close()
    runtime.removeAllListeners()
    writeFileSync(join(directory, 'owned-processes.json'), JSON.stringify([owned]))
    let confirm!: () => void
    fixture.cleanup.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          confirm = resolve
        }),
    )
    runtime = new Runtime()
    services = new ApplicationServices(runtime as unknown as RuntimeClient, store, () => window)
    expect(listTasks(project.id)[0].status).toBe('running')
    const starting = services.ready()
    confirm()
    await starting
    expect(storedTask(run.id)).toMatchObject({
      status: 'cancelled',
      finishedAt: expect.any(Number),
    })
    expect(runtime.calls.some((entry) => entry.method === 'task.run')).toBe(false)
  })
})

describe('running task snapshots restored from backups', () => {
  it('refuses active execution, then archives the old task state without stopping healthy idle CLI servers or resending work', async () => {
    const project = setup()
    await services.ready()
    const run = await startTask(project.id)
    const owned = ownProcess()
    const backup = services.handlers.createBackup() as BackupInfo
    await expect(services.handlers.restoreBackup(backup.id)).rejects.toThrow('WORKSPACE_BUSY')
    expect(storedTask(run.id).status).toBe('running')
    expect(fixture.cleanup).not.toHaveBeenCalled()
    expect(runtime.calls.some((entry) => entry.method === 'task.cancel')).toBe(false)

    runtime.emit('task', {
      ...run,
      status: 'passed',
      finishedAt: Date.now(),
      output: 'CURRENT_CHECK_COMPLETED',
    })
    runtime.emit('ownership', { action: 'release', process: owned })
    ownProcess() // A healthy idle CLI server is distinct from active verification execution.
    await services.handlers.restoreBackup(backup.id)
    const restored = storedTask(run.id)
    expect(restored.status).toBe('cancelled')
    expect(restored.finishedAt).toBeGreaterThanOrEqual(run.startedAt)
    expect(restored.output).toContain('partial check output')
    expect(restored.output).toContain('备份中的运行状态已中断，未自动重发')
    expect(restored.output).not.toContain('后台服务已退出')
    expect(listTasks(project.id)[0]).toEqual(restored)
    expect(fixture.cleanup).not.toHaveBeenCalled()
    expect(runtime.calls.some((entry) => entry.method === 'task.cancel')).toBe(false)
    expect(runtime.calls.filter((entry) => entry.method === 'task.run')).toHaveLength(1)
    await expect(startTask(project.id)).resolves.toMatchObject({ status: 'running' })
  })

  it('rotates the data generation immediately after replacement and retries every restored task after a write failure', async () => {
    const project = setup()
    const secondProject = store.addProject(join(directory, 'second'), 'second')
    store.patchProject(secondProject.id, { trusted: true })
    const session = store.createSession(project.id, 'codex')
    store.saveDraft(session.id, { text: 'BACKUP_DRAFT', context: [], updatedAt: 1 })
    const runs = [await startTask(project.id), await startTask(secondProject.id)]
    const backup = services.handlers.createBackup() as BackupInfo
    for (const run of runs)
      runtime.emit('task', { ...run, status: 'passed', finishedAt: Date.now() })
    store.saveDraft(session.id, { text: 'CURRENT_DRAFT', context: [], updatedAt: 2 })
    const oldGeneration = (services.handlers.bootstrap() as { dataGeneration: string })
      .dataGeneration
    failOneTaskWrite('cancelled')
    const failure = await Promise.resolve(services.handlers.restoreBackup(backup.id)).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('[DATA_RESTORE_APPLIED]')
    expect((failure as Error).message).not.toContain('SQLITE_FULL')
    expect((services.handlers.bootstrap() as { dataGeneration: string }).dataGeneration).not.toBe(
      oldGeneration,
    )
    expect(() =>
      services.handlers.saveDraft(
        session.id,
        { text: 'STALE_WRITE', context: [], updatedAt: 100 },
        oldGeneration,
      ),
    ).toThrow('STALE_DATA_GENERATION')
    expect(store.getDraft(session.id).text).toBe('BACKUP_DRAFT')
    expect(services.healthState.storage).toBe('error')
    expect(
      (services.handlers.listTasks() as TaskRun[]).every((run) => run.status === 'cancelled'),
    ).toBe(true)
    await services.handlers.retryStorage()
    for (const run of runs) {
      expect(storedTask(run.id).status).toBe('cancelled')
      expect(storedTask(run.id).output).toContain('备份中的运行状态已中断，未自动重发')
      expect(storedTask(run.id).output).not.toContain('后台服务已退出')
    }
    expect(services.healthState.storage).toBe('ready')
    expect(runtime.calls.filter((entry) => entry.method === 'task.run')).toHaveLength(2)
    await expect(startTask(project.id)).resolves.toMatchObject({ status: 'running' })
  })
})

it('allows cleaned workspace history reads but rejects resumed execution with a clear explanation', async () => {
  const project = setup()
  const workspace = store.addWorkspace({
    id: randomUUID(),
    projectId: project.id,
    kind: 'worktree',
    cwd: join(directory, 'removed-worktree'),
    name: 'removed',
    createdAt: Date.now(),
  })
  const session = store.createSession(project.id, 'codex', undefined, workspace.id)
  store.removeWorkspace(workspace.id)
  expect((services.handlers.getSession(session.id) as SessionView).session.id).toBe(session.id)
  await expect(services.handlers.sendMessage(session.id, 'resume')).rejects.toThrow(
    '工作区已清理，历史可查看导出，请新建会话',
  )
  expect(runtime.calls.some((entry) => entry.method === 'agent.send')).toBe(false)
})
