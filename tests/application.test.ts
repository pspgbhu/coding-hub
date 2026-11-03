import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store } from '../src/main/store'
import { ApplicationServices } from '../src/main/application'
import type { RuntimeClient } from '../src/main/runtime-client'

const env = vi.hoisted(() => ({ dataDir: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => env.dataDir, getVersion: () => '0.1.1' },
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
class FixtureRuntime extends EventEmitter {
  calls: { method: string; args: unknown[] }[] = []
  stopFails = false
  async start() {}
  async close() {}
  resumeAfterFailedClose() {}
  async call(method: string, ...args: unknown[]): Promise<any> {
    this.calls.push({ method, args })
    if (method === 'workspace.inspect')
      return {
        rootPath: args[0],
        canonicalId: 'canonical',
        gitDir: join(env.dataDir, '.git'),
        repositoryId: 'repository',
        hasHead: true,
      }
    if (method === 'agent.interrupt' && this.stopFails) throw new Error('native abort failed')
    return undefined
  }
}
let directory: string, store: Store, runtime: FixtureRuntime, services: ApplicationServices
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'hub-application-'))
  env.dataDir = directory
  store = new Store(join(directory, 'test.db'))
  runtime = new FixtureRuntime()
  services = new ApplicationServices(runtime as unknown as RuntimeClient, store, () => undefined)
})
afterEach(async () => {
  runtime.stopFails = false
  await services.close()
  vi.restoreAllMocks()
  store.close()
  rmSync(directory, { recursive: true, force: true })
})
function session(trusted = true) {
  const project = store.addProject(join(directory, randomUUID()), 'fixture')
  store.patchProject(project.id, { trusted })
  return store.createSession(project.id, 'codex')
}

describe('desktop orchestration safety', () => {
  it('persists only sanitized native tool and permission copies without modifying native inputs', () => {
    const current = session()
    const input = {
      env: { OPENAI_API_KEY: 'native-secret' },
      headers: { Authorization: 'Bearer native-secret' },
      code: 'const password = "example"',
    }
    runtime.emit('event', {
      id: randomUUID(),
      sessionId: current.id,
      turnId: randomUUID(),
      kind: 'tool',
      input,
      timestamp: Date.now(),
    })
    runtime.emit('event', {
      id: randomUUID(),
      sessionId: current.id,
      turnId: randomUUID(),
      kind: 'approval',
      name: 'Run command',
      input: 'curl --token native-command-secret',
      timestamp: Date.now(),
    })
    const history = store.view(current.id).events
    expect(JSON.stringify(history)).not.toContain('native-secret')
    expect(JSON.stringify(history)).not.toContain('native-command-secret')
    expect((history[0].input as typeof input).code).toBe('const password = "example"')
    expect(input.env.OPENAI_API_KEY).toBe('native-secret')
    expect(input.headers.Authorization).toBe('Bearer native-secret')
  })
  it('refuses untrusted execution without sending a request to an Agent', async () => {
    const current = session(false)
    await expect(services.handlers.sendMessage(current.id, 'do work')).rejects.toThrow(
      'PROJECT_UNTRUSTED',
    )
    expect(runtime.calls.some((c) => c.method === 'agent.send')).toBe(false)
    expect(store.view(current.id).events).toEqual([])
  })
  it('persists the user turn before dispatch and never executes when persistence fails', async () => {
    const current = session()
    const append = vi.spyOn(store, 'append').mockImplementationOnce(() => {
      throw new Error('SQLITE_FULL')
    })
    await expect(services.handlers.sendMessage(current.id, 'do work')).rejects.toThrow(
      'SQLITE_FULL',
    )
    expect(append).toHaveBeenCalled()
    expect(runtime.calls.some((c) => c.method === 'agent.send')).toBe(false)
    expect(services.healthState.storage).toBe('error')
    expect(store.session(current.id).status).toBe('idle')
  })
  it('coordinates different projects pointing into one actual working tree', async () => {
    const first = session()
    const second = session()
    const results = await Promise.allSettled([
      services.handlers.sendMessage(first.id, 'first'),
      services.handlers.sendMessage(second.id, 'second'),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(runtime.calls.filter((c) => c.method === 'agent.send')).toHaveLength(1)
    const current = store.sessions().find((s) => s.status === 'starting')!
    expect(store.view(current.id).events[0].kind).toBe('user')
  })
  it('keeps a failed native cancellation locked rather than reporting completion', async () => {
    const current = session()
    store.patchSession(current.id, { status: 'running', activeTurnId: randomUUID() })
    runtime.stopFails = true
    await expect(services.handlers.interrupt(current.id)).rejects.toThrow('native abort failed')
    expect(store.session(current.id).status).toBe('stop_failed')
    await expect(services.handlers.sendMessage(current.id, 'another task')).rejects.toThrow(
      'WORKSPACE_BUSY',
    )
    expect(store.view(current.id).events.some((e) => e.kind === 'done')).toBe(false)
  })
  it('does not mark an approval resolved before the native response succeeds', async () => {
    const current = session()
    const turnId = randomUUID()
    store.patchSession(current.id, { activeTurnId: turnId })
    store.append({
      id: randomUUID(),
      sessionId: current.id,
      turnId,
      kind: 'approval',
      requestId: 'native-request',
      timestamp: Date.now(),
    })
    await services.handlers.respond(current.id, 'native-request', { decision: 'accept' })
    expect(store.view(current.id).events.find((e) => e.kind === 'approval')?.state).not.toBe(
      'completed',
    )
    runtime.emit('event', {
      id: randomUUID(),
      sessionId: current.id,
      turnId,
      kind: 'requestResolved',
      requestId: 'native-request',
      resolution: 'approved',
      decision: 'accept',
      timestamp: Date.now(),
    })
    expect(store.view(current.id).events.find((e) => e.kind === 'approval')?.resolution).toBe(
      'approved',
    )
  })
  it('keeps trashed sessions trashed when their title is edited', async () => {
    const current = session()
    store.patchSession(current.id, { deletedAt: 123 })
    await services.handlers.updateSession(current.id, { title: 'renamed' })
    expect(store.session(current.id).deletedAt).toBe(123)
    await services.handlers.updateSession(current.id, { deletedAt: null })
    expect(store.session(current.id).deletedAt).toBeUndefined()
  })
  it('rejects delayed draft saves from the pre-restore renderer generation', async () => {
    const current = session()
    const old = services.handlers.bootstrap() as { dataGeneration: string }
    store.saveDraft(current.id, { text: 'backup draft', context: [], updatedAt: 1 })
    const backup = store.createBackup()
    store.saveDraft(current.id, { text: 'new draft', context: [], updatedAt: 2 })
    await services.handlers.restoreBackup(backup.id)
    expect(() =>
      services.handlers.saveDraft(
        current.id,
        { text: 'stale future timestamp', context: [], updatedAt: Date.now() + 100000 },
        old.dataGeneration,
      ),
    ).toThrow('STALE_DATA_GENERATION')
    expect(store.getDraft(current.id).text).toBe('backup draft')
  })
  it('accepts an unresolved native request older than the current history page', async () => {
    const current = session()
    const turnId = randomUUID()
    store.patchSession(current.id, { activeTurnId: turnId })
    store.append({
      id: randomUUID(),
      sessionId: current.id,
      turnId,
      kind: 'approval',
      requestId: 'old-request',
      timestamp: Date.now(),
    })
    store.db.transaction(() => {
      for (let i = 0; i < 550; i++)
        store.append({
          id: randomUUID(),
          sessionId: current.id,
          turnId,
          kind: 'text',
          itemId: String(i),
          text: String(i),
          timestamp: Date.now(),
        })
    })()
    expect(
      store.view(current.id, { limit: 100 }).events.filter((e) => e.kind === 'text'),
    ).toHaveLength(100)
    await services.handlers.respond(current.id, 'old-request', { decision: 'accept' })
    expect(
      runtime.calls.some((c) => c.method === 'agent.respond' && c.args[1] === 'old-request'),
    ).toBe(true)
  })
  it('retries archived native output through the normal event pipeline after a failed database write', async () => {
    const current = session()
    const event = {
      id: randomUUID(),
      sessionId: current.id,
      turnId: randomUUID(),
      kind: 'tool' as const,
      itemId: 'command',
      output: 'Authorization: Bearer secretcredential123456789\ncomplete\n',
      state: 'completed' as const,
      timestamp: Date.now(),
    }
    vi.spyOn(store, 'append').mockImplementationOnce(() => {
      throw new Error('SQLITE_FULL')
    })
    runtime.emit('event', event)
    expect(services.healthState.storage).toBe('error')
    await services.handlers.retryStorage()
    const saved = store.view(current.id).events[0]
    expect(saved.outputRef).toBeDefined()
    const full = (await services.handlers.getEventOutput(current.id, saved.id)) as { text: string }
    expect(full.text).toContain('complete')
    expect(full.text).not.toContain('secretcredential')
    expect(services.healthState.storage).toBe('ready')
  })
  it('queues subsequent native events after a write failure and replays stream chunks in protocol order', async () => {
    const current = session()
    await services.handlers.sendMessage(current.id, 'first task')
    const turnId = store.session(current.id).activeTurnId!
    vi.spyOn(store, 'append').mockImplementationOnce(() => {
      throw new Error('transient SQLITE_FULL')
    })
    const emit = (extra: Record<string, unknown>) =>
      runtime.emit('event', {
        id: randomUUID(),
        sessionId: current.id,
        turnId,
        timestamp: Date.now(),
        ...extra,
      })
    emit({ kind: 'text', itemId: 'answer', text: 'first ', delta: true })
    emit({ kind: 'status', status: 'running' })
    emit({ kind: 'text', itemId: 'answer', text: 'second', delta: true })
    emit({ kind: 'done', status: 'idle' })
    expect(store.session(current.id).status).toBe('starting')
    await services.handlers.retryStorage()
    expect(store.view(current.id).events.find((event) => event.kind === 'text')?.text).toBe(
      'first second',
    )
    expect(store.session(current.id).status).toBe('idle')
  })
  it('does not replace a confirmed completed turn with a late cancellation failure', async () => {
    const current = session()
    const turnId = randomUUID()
    store.patchSession(current.id, { status: 'running', activeTurnId: turnId })
    const original = runtime.call.bind(runtime)
    vi.spyOn(runtime, 'call').mockImplementation(async (method, ...args) => {
      if (method === 'agent.interrupt') {
        runtime.emit('event', {
          id: randomUUID(),
          sessionId: current.id,
          turnId,
          kind: 'done',
          status: 'idle',
          timestamp: Date.now(),
        })
        throw new Error('late transport failure')
      }
      return original(method, ...args)
    })
    await services.handlers.interrupt(current.id)
    expect(store.session(current.id).status).toBe('idle')
  })
  it('keeps native errors locked until the runtime confirms that the turn has ended', async () => {
    const current = session()
    await services.handlers.sendMessage(current.id, 'first task')
    const turnId = store.session(current.id).activeTurnId!
    runtime.emit('event', {
      id: randomUUID(),
      sessionId: current.id,
      turnId,
      kind: 'error',
      text: 'native stream failed; cleanup pending',
      timestamp: Date.now(),
    })
    expect(store.session(current.id).status).toBe('starting')
    await expect(services.handlers.sendMessage(current.id, 'second task')).rejects.toThrow(
      'WORKSPACE_BUSY',
    )
    runtime.emit('event', {
      id: randomUUID(),
      sessionId: current.id,
      turnId,
      kind: 'done',
      status: 'error',
      timestamp: Date.now(),
    })
    expect(store.session(current.id).status).toBe('error')
  })
})
