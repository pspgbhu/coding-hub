import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store } from '../src/main/store'
import { ApplicationServices } from '../src/main/application'
import type { RuntimeClient } from '../src/main/runtime-client'
import type { NewSessionDraft, Session } from '../src/shared/types'

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
    if (method === 'workspace.createWorktree')
      return {
        rootPath: args[1],
        canonicalId: 'isolated',
        repositoryId: 'repository',
        hasHead: true,
      }
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
function pendingDraft(projectId: string, patch: Partial<NewSessionDraft> = {}) {
  const draft = {
    ...(services.handlers.getNewSessionDraft(projectId) as NewSessionDraft),
    text: 'first task',
    updatedAt: 10,
    ...patch,
  }
  services.handlers.saveNewSessionDraft(projectId, draft)
  return draft
}

describe('new session draft handoff', () => {
  it('round-trips optional model defaults through validated settings and creates only on handoff', async () => {
    const current = session()
    services.handlers.saveSettings({
      theme: 'system',
      cliPaths: {},
      newSessionDefaults: {
        [current.projectId]: { provider: 'claude', model: 'sonnet', reasoningOption: 'high' },
      },
    })
    const draft = pendingDraft(current.projectId)
    expect(draft).toMatchObject({
      provider: 'claude',
      model: 'sonnet',
      reasoningOption: 'high',
      workspace: { kind: 'shared' },
    })
    expect(store.findSession(draft.id)).toBeUndefined()
    const created = (await services.handlers.createSessionFromDraft(
      current.projectId,
      draft.id,
    )) as Session
    expect(created).toMatchObject({
      id: draft.id,
      workspaceId: current.projectId,
      model: 'sonnet',
      reasoningOption: 'high',
    })
    expect(store.getDraft(created.id).text).toBe('first task')
    expect(runtime.calls.some((call) => call.method === 'agent.send')).toBe(false)
    expect(await services.handlers.createSessionFromDraft(current.projectId, draft.id)).toEqual(
      created,
    )
  })

  it('coalesces concurrent isolated handoffs and reuses their worktree on retries', async () => {
    const current = session()
    const draft = pendingDraft(current.projectId, { workspace: { kind: 'isolated' } })
    const [first, second] = (await Promise.all([
      services.handlers.createSessionFromDraft(current.projectId, draft.id),
      services.handlers.createSessionFromDraft(current.projectId, draft.id),
    ])) as Session[]
    expect(first).toEqual(second)
    expect(first.workspaceId).toBe(draft.id)
    expect(runtime.calls.filter((call) => call.method === 'workspace.createWorktree')).toHaveLength(
      1,
    )
    await services.handlers.createSessionFromDraft(current.projectId, draft.id)
    expect(runtime.calls.filter((call) => call.method === 'workspace.createWorktree')).toHaveLength(
      1,
    )
  })

  it('reuses an already created worktree after a failed handoff is recovered', async () => {
    const current = session()
    const draft = pendingDraft(current.projectId, { workspace: { kind: 'isolated' } })
    vi.spyOn(store, 'saveSettings').mockImplementationOnce(() => {
      throw new Error('SQLITE_FULL')
    })
    await expect(
      services.handlers.createSessionFromDraft(current.projectId, draft.id),
    ).rejects.toThrow('SQLITE_FULL')
    expect(store.findSession(draft.id)).toBeUndefined()
    expect(store.getNewSessionDraft(current.projectId)).toEqual(draft)
    await services.handlers.retryStorage()
    const created = (await services.handlers.createSessionFromDraft(
      current.projectId,
      draft.id,
    )) as Session
    expect(created.workspaceId).toBe(draft.id)
    expect(runtime.calls.filter((call) => call.method === 'workspace.createWorktree')).toHaveLength(
      1,
    )
  })

  it('preserves the existing create-session API while accepting a reasoning option', async () => {
    const current = session()
    const created = (await services.handlers.createSession({
      projectId: current.projectId,
      provider: 'codex',
      model: 'selected-model',
      reasoningOption: 'high',
    })) as Session
    expect(created).toMatchObject({
      projectId: current.projectId,
      workspaceId: current.projectId,
      model: 'selected-model',
      reasoningOption: 'high',
    })
    expect(store.getDraft(created.id)).toEqual({ text: '', context: [], updatedAt: 0 })
  })

  it('rejects another project workspace while preserving the pending draft', async () => {
    const current = session()
    const other = session()
    const draft = pendingDraft(current.projectId, {
      workspace: { kind: 'existing', id: other.projectId },
    })
    await expect(
      services.handlers.createSessionFromDraft(current.projectId, draft.id),
    ).rejects.toThrow('工作区不属于')
    expect(store.findSession(draft.id)).toBeUndefined()
    expect(store.getNewSessionDraft(current.projectId)).toEqual(draft)
    expect(services.healthState.storage).toBe('ready')
  })

  it('rejects untrusted handoffs and invalid pending draft shapes before creating a session', async () => {
    const current = session(false)
    const draft = pendingDraft(current.projectId)
    expect(() =>
      services.handlers.saveNewSessionDraft(current.projectId, {
        ...draft,
        workspace: { kind: 'existing', id: 'not-an-id' },
      }),
    ).toThrow()
    await expect(
      services.handlers.createSessionFromDraft(current.projectId, draft.id),
    ).rejects.toThrow('PROJECT_UNTRUSTED')
    expect(store.findSession(draft.id)).toBeUndefined()
    expect(store.getNewSessionDraft(current.projectId)).toEqual(draft)
  })

  it('accepts the first message once and clears its matching draft before dispatch returns', async () => {
    const current = session()
    const draft = pendingDraft(current.projectId)
    const created = (await services.handlers.createSessionFromDraft(
      current.projectId,
      draft.id,
    )) as Session
    const dispatch = runtime.call.bind(runtime)
    vi.spyOn(runtime, 'call').mockImplementation(async (method, ...args) => {
      if (method === 'agent.send') {
        expect(store.getDraft(created.id).text).toBe('')
        expect(store.view(created.id).events[0].id).toBe(created.id)
      }
      return dispatch(method, ...args)
    })
    const input = { text: draft.text, context: draft.context }
    const options = { firstMessage: true, draftUpdatedAt: draft.updatedAt }
    await services.handlers.sendMessage(created.id, input, options)
    await services.handlers.sendMessage(created.id, input, options)
    store.patchSession(created.id, { status: 'idle' })
    await services.handlers.sendMessage(created.id, input, options)
    expect(runtime.calls.filter((call) => call.method === 'agent.send')).toHaveLength(1)
    expect(store.view(created.id).events.filter((event) => event.kind === 'user')).toHaveLength(1)
  })

  it('preserves the first draft when dispatch preparation fails, then retries in the same session', async () => {
    const current = session()
    const draft = pendingDraft(current.projectId)
    const created = (await services.handlers.createSessionFromDraft(
      current.projectId,
      draft.id,
    )) as Session
    const dispatch = runtime.call.bind(runtime)
    let fail = true
    vi.spyOn(runtime, 'call').mockImplementation(async (method, ...args) => {
      if (method === 'review.capture' && fail) {
        fail = false
        throw new Error('capture failed')
      }
      return dispatch(method, ...args)
    })
    const input = { text: draft.text, context: draft.context }
    const options = { firstMessage: true, draftUpdatedAt: draft.updatedAt }
    await expect(services.handlers.sendMessage(created.id, input, options)).rejects.toThrow(
      'capture failed',
    )
    expect(store.getDraft(created.id).text).toBe(draft.text)
    expect(store.view(created.id).events).toHaveLength(0)
    await services.handlers.sendMessage(created.id, input, options)
    expect(store.getDraft(created.id).text).toBe('')
    expect(runtime.calls.filter((call) => call.method === 'agent.send')).toHaveLength(1)
  })

  it('does not redispatch an accepted first message when the native dispatch response fails', async () => {
    const current = session()
    const draft = pendingDraft(current.projectId)
    const created = (await services.handlers.createSessionFromDraft(
      current.projectId,
      draft.id,
    )) as Session
    const dispatch = runtime.call.bind(runtime)
    let attempts = 0
    vi.spyOn(runtime, 'call').mockImplementation(async (method, ...args) => {
      if (method === 'agent.send') {
        attempts++
        throw new Error('native response lost')
      }
      return dispatch(method, ...args)
    })
    const input = { text: draft.text, context: draft.context }
    const options = { firstMessage: true, draftUpdatedAt: draft.updatedAt }
    await expect(services.handlers.sendMessage(created.id, input, options)).rejects.toThrow(
      'native response lost',
    )
    expect(store.getDraft(created.id).text).toBe('')
    await services.handlers.sendMessage(created.id, input, options)
    expect(attempts).toBe(1)
    expect(store.view(created.id).events.filter((event) => event.kind === 'user')).toHaveLength(1)
  })

  it('preserves a newer session draft edited while the first submission is preparing', async () => {
    const current = session()
    const draft = pendingDraft(current.projectId)
    const created = (await services.handlers.createSessionFromDraft(
      current.projectId,
      draft.id,
    )) as Session
    const dispatch = runtime.call.bind(runtime)
    vi.spyOn(runtime, 'call').mockImplementation(async (method, ...args) => {
      if (method === 'review.capture')
        store.saveDraft(created.id, {
          text: 'newer task',
          context: [],
          updatedAt: draft.updatedAt + 1,
        })
      return dispatch(method, ...args)
    })
    await services.handlers.sendMessage(
      created.id,
      { text: draft.text, context: draft.context },
      { firstMessage: true, draftUpdatedAt: draft.updatedAt },
    )
    expect(store.getDraft(created.id).text).toBe('newer task')
  })

  it('rolls back first-message acceptance when clearing its draft cannot be persisted', async () => {
    const current = session()
    const draft = pendingDraft(current.projectId)
    const created = (await services.handlers.createSessionFromDraft(
      current.projectId,
      draft.id,
    )) as Session
    vi.spyOn(store, 'saveDraft').mockImplementationOnce(() => {
      throw new Error('SQLITE_FULL')
    })
    await expect(
      services.handlers.sendMessage(
        created.id,
        { text: draft.text, context: [] },
        { firstMessage: true, draftUpdatedAt: draft.updatedAt },
      ),
    ).rejects.toThrow('SQLITE_FULL')
    expect(store.getDraft(created.id).text).toBe(draft.text)
    expect(store.view(created.id).events).toHaveLength(0)
    expect(store.session(created.id).status).toBe('idle')
    expect(runtime.calls.some((call) => call.method === 'agent.send')).toBe(false)
  })

  it('rejects pre-restore pending writes, creation and sends without replacing restored drafts', async () => {
    const current = session()
    const draft = pendingDraft(current.projectId)
    const old = services.handlers.bootstrap() as { dataGeneration: string }
    const backup = store.createBackup()
    services.handlers.saveNewSessionDraft(current.projectId, {
      ...draft,
      text: 'later',
      updatedAt: 20,
    })
    await services.handlers.restoreBackup(backup.id)
    expect(() =>
      services.handlers.saveNewSessionDraft(
        current.projectId,
        { ...draft, text: 'stale', updatedAt: 100 },
        old.dataGeneration,
      ),
    ).toThrow('STALE_DATA_GENERATION')
    await expect(
      services.handlers.createSessionFromDraft(current.projectId, draft.id, old.dataGeneration),
    ).rejects.toThrow('STALE_DATA_GENERATION')
    await expect(
      services.handlers.sendMessage(current.id, 'stale', undefined, old.dataGeneration),
    ).rejects.toThrow('STALE_DATA_GENERATION')
    expect(store.getNewSessionDraft(current.projectId)).toEqual(draft)
  })

  it('supports idle reasoning changes and clears old reasoning on model changes', async () => {
    const current = session()
    services.handlers.updateSession(current.id, { reasoningOption: 'high' })
    expect(store.session(current.id).reasoningOption).toBe('high')
    services.handlers.updateSession(current.id, { model: 'another-model' })
    expect(store.session(current.id).reasoningOption).toBeUndefined()
    services.handlers.updateSession(current.id, { reasoningOption: 'low' })
    services.handlers.updateSession(current.id, { reasoningOption: null })
    expect(store.session(current.id).reasoningOption).toBeUndefined()
    store.patchSession(current.id, { status: 'running' })
    expect(() => services.handlers.updateSession(current.id, { reasoningOption: 'high' })).toThrow(
      '请先停止',
    )
  })
})

describe('versioned ordinary message acceptance', () => {
  it('rejects model and reasoning edits while review capture holds a startup reservation', async () => {
    const current = session()
    store.patchSession(current.id, { model: 'original-model', reasoningOption: 'low' })
    let release!: () => void
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    let captured!: () => void
    const captureStarted = new Promise<void>((resolve) => {
      captured = resolve
    })
    const dispatch = runtime.call.bind(runtime)
    vi.spyOn(runtime, 'call').mockImplementation(async (method, ...args) => {
      if (method === 'review.capture') {
        captured()
        await paused
      }
      return dispatch(method, ...args)
    })
    const sending = services.handlers.sendMessage(current.id, 'ordinary task')
    await captureStarted
    try {
      expect(store.session(current.id).status).toBe('idle')
      expect(() => services.handlers.updateSession(current.id, { model: 'changed-model' })).toThrow(
        'WORKSPACE_BUSY',
      )
      expect(() =>
        services.handlers.updateSession(current.id, { reasoningOption: 'high' }),
      ).toThrow('WORKSPACE_BUSY')
      expect(() =>
        services.handlers.updateSession(current.id, { title: 'renamed while preparing' }),
      ).not.toThrow()
    } finally {
      release()
    }
    await sending
    const sent = runtime.calls.find((call) => call.method === 'agent.send')!
    expect((sent.args[0] as { session: Session }).session).toMatchObject({
      model: 'original-model',
      reasoningOption: 'low',
    })
  })

  it('dispatches the latest configuration changed before the startup reservation is acquired', async () => {
    const current = session()
    store.patchSession(current.id, { model: 'original-model', reasoningOption: 'low' })
    let release!: () => void
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    let inspecting!: () => void
    const inspectStarted = new Promise<void>((resolve) => {
      inspecting = resolve
    })
    const dispatch = runtime.call.bind(runtime)
    let firstInspection = true
    vi.spyOn(runtime, 'call').mockImplementation(async (method, ...args) => {
      if (method === 'workspace.inspect' && firstInspection) {
        firstInspection = false
        inspecting()
        await paused
      }
      return dispatch(method, ...args)
    })
    const sending = services.handlers.sendMessage(current.id, 'ordinary task')
    await inspectStarted
    try {
      services.handlers.updateSession(current.id, {
        model: 'changed-model',
        reasoningOption: 'high',
      })
    } finally {
      release()
    }
    await sending
    const sent = runtime.calls.find((call) => call.method === 'agent.send')!
    expect((sent.args[0] as { session: Session }).session).toMatchObject({
      model: 'changed-model',
      reasoningOption: 'high',
    })
  })

  it('clears a matching draft in the user event transaction before ordinary dispatch', async () => {
    const current = session()
    const draft = { text: 'ordinary task', context: [], updatedAt: 10 }
    store.saveDraft(current.id, draft)
    const dispatch = runtime.call.bind(runtime)
    vi.spyOn(runtime, 'call').mockImplementation(async (method, ...args) => {
      if (method === 'agent.send') {
        expect(store.getDraft(current.id).text).toBe('')
        expect(store.view(current.id).events[0].text).toBe(draft.text)
      }
      return dispatch(method, ...args)
    })
    await services.handlers.sendMessage(
      current.id,
      { text: draft.text, context: draft.context },
      { draftUpdatedAt: draft.updatedAt },
    )
    expect(store.getDraft(current.id).updatedAt).toBeGreaterThan(draft.updatedAt)
    expect(store.view(current.id).events[0].id).not.toBe(current.id)
  })

  it('preserves a newer draft saved while an ordinary submission is preparing', async () => {
    const current = session()
    const draft = { text: 'ordinary task', context: [], updatedAt: 10 }
    const newer = { text: 'next task typed after switching back', context: [], updatedAt: 11 }
    store.saveDraft(current.id, draft)
    const dispatch = runtime.call.bind(runtime)
    vi.spyOn(runtime, 'call').mockImplementation(async (method, ...args) => {
      if (method === 'review.capture') store.saveDraft(current.id, newer)
      return dispatch(method, ...args)
    })
    await services.handlers.sendMessage(
      current.id,
      { text: draft.text, context: draft.context },
      { draftUpdatedAt: draft.updatedAt },
    )
    expect(store.getDraft(current.id)).toEqual(newer)
    expect(store.view(current.id).events[0].text).toBe(draft.text)
  })

  it('keeps existing callers responsible for draft clearing when no version is supplied', async () => {
    const current = session()
    const draft = { text: 'legacy task', context: [], updatedAt: 10 }
    store.saveDraft(current.id, draft)
    await services.handlers.sendMessage(current.id, { text: draft.text, context: draft.context })
    expect(store.getDraft(current.id)).toEqual(draft)
    expect(store.view(current.id).events[0].text).toBe(draft.text)
  })
})

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
