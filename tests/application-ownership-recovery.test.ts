import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RuntimeClient } from '../src/main/runtime-client'
import type { ProcessOwnership } from '../src/runtime/process'
import type { Session, SessionView, TaskRun } from '../src/shared/types'
import { Store } from '../src/main/store'
import { ApplicationServices } from '../src/main/application'

const fixture = vi.hoisted(() => ({ dataDir: '', cleanup: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => fixture.dataDir, getVersion: () => 'test' },
  dialog: {},
  shell: {},
  Notification: { isSupported: () => false },
}))
vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }))
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
  start = vi.fn(async () => {})
  close = vi.fn(async () => {})
  resumeAfterFailedClose() {}
  call = vi.fn(async (method: string, ...args: unknown[]): Promise<any> => {
    if (method === 'workspace.inspect')
      return { rootPath: args[0], canonicalId: args[0], hasHead: true }
  })
}
let directory: string,
  file: string,
  store: Store,
  runtime: Runtime,
  services: ApplicationServices | undefined
let session: Session, task: TaskRun
const nativeRecord = (extra: Partial<ProcessOwnership> = {}): ProcessOwnership => ({
  id: 'opaque/native/process-tree',
  pid: 12345,
  started: 'Tue Nov 3 10:00:00 2026',
  isolatedGroup: true,
  members: [{ pid: 12346, started: 'Tue Nov 3 10:00:00 2026' }],
  ...extra,
})
beforeEach(() => {
  directory = fs.mkdtempSync(join(tmpdir(), 'hub-ownership-recovery-'))
  fixture.dataDir = directory
  file = join(directory, 'owned-processes.json')
  fixture.cleanup.mockReset().mockResolvedValue(undefined)
  store = new Store(join(directory, 'test.db'))
  const project = store.addProject(join(directory, 'project'), 'fixture')
  store.patchProject(project.id, { trusted: true })
  session = store.createSession(project.id, 'codex')
  task = {
    id: randomUUID(),
    workspaceId: project.id,
    name: 'verification',
    command: 'fixture',
    args: [],
    status: 'running',
    startedAt: 1,
    output: 'pending output',
  }
  runtime = new Runtime()
  services = undefined
})
afterEach(async () => {
  vi.restoreAllMocks()
  if (services?.healthState.code === 'OWNERSHIP_RECORD_INVALID') {
    // Explicitly repair the isolated fixture for orderly cleanup; production never resets this file automatically.
    fs.writeFileSync(file, JSON.stringify([nativeRecord()]))
    await services.handlers.retryStorage()
  }
  await services?.close()
  store.close()
  fs.rmSync(directory, { recursive: true, force: true })
})
function persistRunningTask() {
  store.db
    .prepare('INSERT INTO settings(key,data) VALUES (?,?)')
    .run('task:' + task.id, JSON.stringify(task))
}
function open() {
  services = new ApplicationServices(runtime as unknown as RuntimeClient, store, () => undefined)
  return services
}
function readTask(): TaskRun {
  return JSON.parse(
    (
      store.db.prepare('SELECT data FROM settings WHERE key=?').get('task:' + task.id) as {
        data: string
      }
    ).data,
  )
}
async function blocked(service: ApplicationServices) {
  await expect(service.ready()).rejects.toThrow('无法确认旧执行已停止')
  await expect(service.handlers.sendMessage(session.id, 'must not execute')).rejects.toThrow(
    'OWNERSHIP_RECORD_INVALID',
  )
  await expect(
    service.handlers.runTask(session.projectId, {
      id: 'check',
      name: 'check',
      command: 'fixture',
      args: [],
    }),
  ).rejects.toThrow('OWNERSHIP_RECORD_INVALID')
  await expect(service.handlers.terminalCreate(session.projectId, 80, 24)).rejects.toThrow(
    'OWNERSHIP_RECORD_INVALID',
  )
  expect(() => service.handlers.providers()).toThrow('OWNERSHIP_RECORD_INVALID')
  expect(runtime.start).not.toHaveBeenCalled()
  expect(runtime.call).not.toHaveBeenCalled()
  expect(fixture.cleanup).not.toHaveBeenCalled()
  expect(service.healthState).toMatchObject({
    runtime: 'error',
    code: 'OWNERSHIP_RECORD_INVALID',
    message: expect.stringContaining(file),
  })
  expect(readTask().status).toBe('running')
  expect((service.handlers.listTasks() as TaskRun[])[0].status).toBe('running')
  expect((service.handlers.getSession(session.id) as SessionView).session.id).toBe(session.id)
}

describe('process ownership ledger recovery is fail closed', () => {
  it('preserves corrupt bytes through startup, retry, runtime events and close until a valid external repair', async () => {
    persistRunningTask()
    const original = Buffer.from('[{"id":"original-owned-process","pid":12345, BROKEN_JSON')
    fs.writeFileSync(file, original)
    const service = open()
    await blocked(service)
    runtime.emit('ownership', { action: 'register', process: nativeRecord() })
    service.reportBackupFailure(new Error('independent backup error'))
    expect(service.healthState.code).toBe('OWNERSHIP_RECORD_INVALID')
    await expect(service.handlers.retryStorage()).rejects.toThrow('OWNERSHIP_RECORD_INVALID')
    await expect(service.close()).rejects.toThrow('OWNERSHIP_RECORD_INVALID')
    expect(fs.readFileSync(file)).toEqual(original)
    expect(fixture.cleanup).not.toHaveBeenCalled()
    expect(readTask().status).toBe('running')

    fs.writeFileSync(file, JSON.stringify([nativeRecord()]))
    await service.handlers.retryStorage()
    expect(fixture.cleanup).toHaveBeenCalledOnce()
    expect(fixture.cleanup.mock.calls[0][0]).toEqual([nativeRecord()])
    expect(readTask()).toMatchObject({ status: 'cancelled', finishedAt: expect.any(Number) })
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual([])
    expect(service.healthState).toMatchObject({ runtime: 'ready', storage: 'ready' })
    expect(
      runtime.call.mock.calls.some(([method]) => method === 'agent.send' || method === 'task.run'),
    ).toBe(false)
  })

  it.each([
    null,
    { id: 'not-an-array' },
    [nativeRecord({ pid: 0 })],
    [nativeRecord({ pid: 1.5 })],
    [nativeRecord({ started: '', members: undefined })],
    [nativeRecord({ started: '', members: [] })],
    [nativeRecord({ started: '', members: [{ pid: 12345, started: 'Tue Nov 3 10:00:00 2026' }] })],
    [nativeRecord({ started: '', members: [{ pid: 12346, started: 'invalid birth' }] })],
    [nativeRecord({ started: 'not a process birth identity' })],
    [nativeRecord({ members: [{ pid: 4567, started: '' }] })],
    [nativeRecord({ uncertainMembers: [{ pid: -1, started: 'Tue Nov 3 10:00:00 2026' }] })],
    [nativeRecord({ uncertainMembers: [{ pid: 12347, started: 'invalid birth' }] })],
    [nativeRecord(), nativeRecord({ id: 'invalid-tail', pid: -1 })],
  ])('does not accept malformed records or partially clean an invalid ledger: %j', async (raw) => {
    persistRunningTask()
    const original = Buffer.from(JSON.stringify(raw))
    fs.writeFileSync(file, original)
    const service = open()
    await blocked(service)
    await expect(service.handlers.retryStorage()).rejects.toThrow('OWNERSHIP_RECORD_INVALID')
    expect(fs.readFileSync(file)).toEqual(original)
    expect(fixture.cleanup).not.toHaveBeenCalled()
  })

  it('distinguishes an unreadable existing ledger from ENOENT and retries after permissions are repaired', async () => {
    persistRunningTask()
    const original = Buffer.from(JSON.stringify([nativeRecord()]))
    fs.writeFileSync(file, original)
    const actualRead = fs.readFileSync
    const failingRead = vi.spyOn(fs, 'readFileSync').mockImplementation(((
      path: fs.PathOrFileDescriptor,
      ...args: unknown[]
    ) => {
      if (path === file)
        throw Object.assign(new Error('permission denied fixture'), { code: 'EACCES' })
      return (actualRead as (...args: unknown[]) => unknown)(path, ...args)
    }) as typeof fs.readFileSync)
    const service = open()
    await blocked(service)
    await expect(service.handlers.retryStorage()).rejects.toThrow('OWNERSHIP_RECORD_INVALID')
    expect(actualRead(file)).toEqual(original)
    failingRead.mockRestore()
    await service.handlers.retryStorage()
    expect(fixture.cleanup).toHaveBeenCalledOnce()
    expect(readTask().status).toBe('cancelled')
  })

  it('blocks a missing ledger with running history until a trusted file is supplied', async () => {
    persistRunningTask()
    const service = open()
    await blocked(service)
    await expect(service.handlers.retryStorage()).rejects.toThrow('OWNERSHIP_RECORD_INVALID')
    expect(fs.existsSync(file)).toBe(false)
    fs.writeFileSync(file, JSON.stringify([nativeRecord()]))
    await service.handlers.retryStorage()
    expect(fixture.cleanup).toHaveBeenCalledOnce()
    expect(readTask().status).toBe('cancelled')
  })

  it('recovers an exited leader only through a separately verified surviving member identity', async () => {
    persistRunningTask()
    const record = nativeRecord({ started: '' })
    fs.writeFileSync(file, JSON.stringify([record]))
    const service = open()
    await service.ready()
    expect(fixture.cleanup).toHaveBeenCalledOnce()
    expect(fixture.cleanup).toHaveBeenCalledWith([record])
    expect(readTask().status).toBe('cancelled')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual([])
  })

  it.each([false, true])(
    'preserves uncertain descendants across restart and retry without promoting them to verified members (leader birth missing: %s)',
    async (missingLeaderBirth) => {
      persistRunningTask()
      const record = nativeRecord({
        ...(missingLeaderBirth ? { started: '' } : {}),
        uncertainMembers: [{ pid: 12347, started: 'Tue Nov 3 10:00:01 2026' }],
      })
      fs.writeFileSync(file, JSON.stringify([record]))
      fixture.cleanup.mockRejectedValue(new Error('Cannot verify late process descendants'))
      const service = open()
      await expect(service.ready()).rejects.toThrow('Cannot verify late process descendants')
      expect(fixture.cleanup).toHaveBeenCalledWith([record])
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual([record])
      expect(service.healthState.code).toBe('PROCESS_CLEANUP_FAILED')
      expect(readTask().status).toBe('running')
      await expect(service.handlers.retryStorage()).rejects.toThrow(
        'Cannot verify late process descendants',
      )
      expect(fixture.cleanup.mock.calls.at(-1)?.[0]).toEqual([record])
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))[0].members).toEqual(record.members)
      fixture.cleanup.mockResolvedValue(undefined)
      await service.handlers.retryStorage()
      expect(readTask().status).toBe('cancelled')
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual([])
    },
  )

  it('allows a genuine first launch without a ledger or running task history', async () => {
    const service = open()
    await service.ready()
    expect(runtime.start).toHaveBeenCalledOnce()
    expect(fixture.cleanup).not.toHaveBeenCalled()
    expect(fs.existsSync(file)).toBe(false)
  })

  it.each(['周二 11月 3 10:00:00 2026', '639293256000000000'])(
    'accepts native localized ps and Windows CIM birth values without constraining opaque IDs: %s',
    async (started) => {
      persistRunningTask()
      const record = nativeRecord({ started, members: [{ pid: 12346, started }] })
      fs.writeFileSync(file, JSON.stringify([record]))
      const service = open()
      await service.ready()
      expect(fixture.cleanup).toHaveBeenCalledWith([record])
      expect(readTask().status).toBe('cancelled')
    },
  )
})
