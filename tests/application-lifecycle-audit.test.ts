import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { Store } from '../src/main/store'
import { ApplicationServices } from '../src/main/application'
import { backupDirectory } from '../src/main/storage'
import type { RuntimeClient } from '../src/main/runtime-client'
import type { AgentEvent, SessionView, TurnReview } from '../src/shared/types'

const env = vi.hoisted(() => ({ dataDir: '', exportPath: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => env.dataDir, getVersion: () => 'test' },
  dialog: { showSaveDialog: async () => ({ canceled: false, filePath: env.exportPath }) },
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
class Runtime extends EventEmitter {
  review?: Promise<null>
  async start() {}
  async close() {}
  resumeAfterFailedClose() {}
  async call(method: string, ...args: unknown[]): Promise<any> {
    if (method === 'workspace.inspect')
      return { rootPath: args[0], canonicalId: 'root', hasHead: true }
    if (method === 'review.finish') return this.review ?? null
    if (method === 'terminal.create') return randomUUID()
  }
}
let store: Store, runtime: Runtime, services: ApplicationServices, directory: string
let window: BrowserWindow | undefined
const externalDirectories: string[] = []
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'hub-lifecycle-audit-'))
  env.dataDir = directory
  env.exportPath = ''
  store = new Store(join(directory, 'test.db'))
  runtime = new Runtime()
  window = undefined
  services = new ApplicationServices(runtime as unknown as RuntimeClient, store, () => window)
})
afterEach(async () => {
  await services.close()
  store.close()
  for (const external of externalDirectories.splice(0))
    rmSync(external, { recursive: true, force: true })
  rmSync(directory, { recursive: true, force: true })
})

function externalDirectory() {
  const location = mkdtempSync(join(tmpdir(), 'hub-export-outside-'))
  externalDirectories.push(location)
  return location
}
const exportKinds = ['session', 'diagnostics'] as const
const protectedKinds = ['database', 'output', 'backup', 'ownership'] as const
async function requestExport(kind: (typeof exportKinds)[number], sessionId: string) {
  return kind === 'session'
    ? services.handlers.exportSession(sessionId, 'json')
    : services.handlers.exportDiagnostics()
}
describe('native export destination protection', () => {
  for (const kind of exportKinds) {
    it.each(protectedKinds)(
      `refuses ${kind} export over the managed %s file without changing its bytes`,
      async (protectedKind) => {
        const { session } = setup()
        const backup = protectedKind === 'backup' ? store.createBackup() : undefined
        const target = {
          database: join(directory, 'test.db'),
          output: join(directory, 'outputs', 'a'.repeat(64) + '.txt'),
          backup: backup ? join(backupDirectory(join(directory, 'test.db')), backup.id) : '',
          ownership: join(directory, 'owned-processes.json'),
        }[protectedKind]
        mkdirSync(dirname(target), { recursive: true })
        if (!['database', 'backup'].includes(protectedKind))
          writeFileSync(target, 'PROTECTED_ORIGINAL_BYTES')
        const before = readFileSync(target)
        env.exportPath = target
        await expect(requestExport(kind, session.id)).rejects.toThrow('应用数据目录以外')
        expect(readFileSync(target)).toEqual(before)
      },
    )
    it(`refuses ${kind} export through an external directory alias into managed data`, async () => {
      const { session } = setup()
      const alias = join(externalDirectory(), 'data-alias')
      // A native Windows junction exercises directory aliases without requiring
      // elevated privileges to create a file symlink on Windows CI.
      symlinkSync(directory, alias, process.platform === 'win32' ? 'junction' : 'dir')
      const target = join(directory, 'test.db'),
        before = readFileSync(target)
      env.exportPath = join(alias, 'test.db')
      await expect(requestExport(kind, session.id)).rejects.toThrow('应用数据目录以外')
      expect(readFileSync(target)).toEqual(before)
    })
  }
  it('refuses session export while its native turn is still active and preserves the chosen destination', async () => {
    const { session } = setup()
    env.exportPath = join(externalDirectory(), 'existing.json')
    writeFileSync(env.exportPath, 'EXISTING_EXPORT')
    store.patchSession(session.id, { status: 'running', activeTurnId: randomUUID() })
    await expect(requestExport('session', session.id)).rejects.toThrow('WORKSPACE_BUSY')
    expect(readFileSync(env.exportPath, 'utf8')).toBe('EXISTING_EXPORT')
  })
  it('still permits complete session and diagnostics exports to an ordinary external directory', async () => {
    const { session } = setup()
    env.exportPath = join(externalDirectory(), 'session.json')
    await expect(requestExport('session', session.id)).resolves.toBe(true)
    expect(JSON.parse(readFileSync(env.exportPath, 'utf8')).session.id).toBe(session.id)
    env.exportPath = join(externalDirectory(), 'diagnostics.json')
    await expect(requestExport('diagnostics', session.id)).resolves.toBe(true)
    expect(JSON.parse(readFileSync(env.exportPath, 'utf8')).health.storage).toBe('ready')
  })
})
function setup() {
  const project = store.addProject(directory, 'lifecycle')
  store.patchProject(project.id, { trusted: true })
  return { project, session: store.createSession(project.id, 'codex') }
}
function emit(sessionId: string, extra: Partial<AgentEvent>) {
  runtime.emit('event', {
    id: randomUUID(),
    sessionId,
    turnId: 'turn',
    timestamp: Date.now(),
    kind: 'text',
    ...extra,
  })
}
describe('integrated lifecycle boundaries', () => {
  it.each([true, false])(
    'persists the complete final review before runtime shutdown (native done emitted: %s)',
    async (nativeDone) => {
      const { project, session } = setup()
      const turnId = randomUUID()
      store.patchSession(session.id, { status: 'running', activeTurnId: turnId })
      const review: TurnReview = {
        sessionId: session.id,
        workspaceId: project.id,
        turnId,
        startedAt: 1,
        finishedAt: 2,
        warnings: [],
        files: [
          {
            path: 'hello.ts',
            before: 'before quit',
            after: 'after native interruption',
            beforeFingerprint: 'original',
            afterFingerprint: 'updated',
            reviewable: true,
          },
        ],
      }
      const order: string[] = []
      let finishReview!: (value: TurnReview) => void
      const pendingReview = new Promise<TurnReview>((resolve) => {
        finishReview = resolve
      })
      const originalCall = runtime.call.bind(runtime)
      vi.spyOn(runtime, 'call').mockImplementation(async (method, ...args) => {
        if (method === 'agent.interrupt') {
          order.push('native interrupt confirmed')
          if (nativeDone) emit(session.id, { kind: 'done', status: 'interrupted', turnId })
          return
        }
        if (method === 'review.finish') {
          order.push('review.finish')
          return pendingReview
        }
        return originalCall(method, ...args)
      })
      const shutdown = vi.spyOn(runtime, 'close').mockImplementation(async () => {
        expect(services.handlers.getReview(session.id, turnId)).toEqual(review)
        order.push('runtime.close')
      })
      const closing = services.close()
      // Attach immediately so an incorrectly early shutdown is reported through
      // the assertion below rather than an unhandled rejection.
      const result = closing.then(
        () => undefined,
        (error) => error,
      )
      try {
        await expect.poll(() => order.includes('review.finish')).toBe(true)
        expect(store.view(session.id).events.find((event) => event.kind === 'done')).toMatchObject({
          status: 'interrupted',
          turnId,
        })
        expect(shutdown).not.toHaveBeenCalled()
        expect(services.handlers.getReview(session.id, turnId)).toBeNull()
      } finally {
        order.push('review completed')
        finishReview(review)
        expect(await result).toBeUndefined()
      }
      expect(order).toEqual([
        'native interrupt confirmed',
        'review.finish',
        'review completed',
        'runtime.close',
      ])
      expect(services.handlers.getReview(session.id, turnId)).toEqual(review)
      expect(services.healthState.code).not.toBe('REVIEW_FAILED')
    },
  )
  it('rejects new native processes while close waits for an existing review', async () => {
    const { project, session } = setup()
    let finish!: (review: null) => void
    runtime.review = new Promise((resolve) => {
      finish = resolve
    })
    emit(session.id, { kind: 'done', status: 'idle', turnId: randomUUID() })
    const closing = services.close()
    try {
      await expect(services.handlers.terminalCreate(project.id, 80, 24)).rejects.toThrow(
        /退出|关闭/,
      )
    } finally {
      finish(null)
      await closing
    }
  })
  it('keeps the public history API paged even when a valid caller supplies empty options', () => {
    const { session } = setup()
    store.db.transaction(() => {
      for (let i = 0; i < 150; i++)
        store.append({
          id: randomUUID(),
          sessionId: session.id,
          turnId: randomUUID(),
          kind: 'text',
          text: String(i),
          timestamp: Date.now(),
        })
    })()
    expect((services.handlers.getSession(session.id) as SessionView).events).toHaveLength(100)
    expect((services.handlers.getSession(session.id, {}) as SessionView).events).toHaveLength(100)
  })
  it('does not replay a committed text delta after delivery to a reloading renderer fails', async () => {
    const { session } = setup()
    let fail = true
    window = {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string) => {
          if (fail && channel === 'hub:event') {
            fail = false
            throw new Error('Render frame was disposed')
          }
        },
      },
    } as unknown as BrowserWindow
    emit(session.id, { itemId: 'answer', delta: true, text: 'persist exactly once' })
    emit(session.id, { kind: 'status', status: 'idle' }) // protocol boundary flushes the batch
    await services.handlers.retryStorage()
    expect(store.view(session.id).events.find((value) => value.kind === 'text')?.text).toBe(
      'persist exactly once',
    )
  })
})
