import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApplicationServices } from '../src/main/application'
import { Store } from '../src/main/store'
import type { RuntimeClient } from '../src/main/runtime-client'
import type { SessionView } from '../src/shared/types'

const fixture = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => fixture.directory, getVersion: () => 'test' },
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
class Runtime extends EventEmitter {
  async start() {}
  async call() {}
  async close() {}
}
let store: Store
let services: ApplicationServices
beforeEach(() => {
  fixture.directory = mkdtempSync(join(tmpdir(), 'hub-history-api-'))
  store = new Store(join(fixture.directory, 'hub.db'))
  services = new ApplicationServices(
    new Runtime() as unknown as RuntimeClient,
    store,
    () => undefined,
  )
})
afterEach(async () => {
  await services.close()
  store.close()
  rmSync(fixture.directory, { recursive: true, force: true })
})
function history(count: number) {
  const project = store.addProject(fixture.directory, 'History API')
  const session = store.createSession(project.id, 'codex')
  store.patchSession(session.id, { nativeId: 'original-native-session' })
  const events = Array.from({ length: count }, (_, index) => ({
    id: randomUUID(),
    sessionId: session.id,
    turnId: 'native-turn',
    itemId: `native-item-${index}`,
    timestamp: index,
    kind: 'text' as const,
    text: `message ${index}`,
  }))
  const insert = store.db.prepare('INSERT INTO events VALUES (?, ?, NULL, ?, ?)')
  store.db.transaction(() => {
    for (const [index, event] of events.entries())
      insert.run(event.id, session.id, index + 1, JSON.stringify(event))
  })()
  return { session, events }
}

describe('typed IPC history paging', () => {
  it('defaults to 100 rows while allowing a bounded anchored window and exclusive newer page', () => {
    const { session, events } = history(350)
    for (const page of [undefined, {}, null])
      expect((services.handlers.getSession(session.id, page) as SessionView).events).toEqual(
        events.slice(-100),
      )
    const anchored = services.handlers.getSession(session.id, {
      aroundEventId: events[5].id,
      limit: 100,
    }) as SessionView
    expect(anchored.events).toEqual(events.slice(0, 100))
    expect(anchored.anchorFound).toBe(true)
    const newer = services.handlers.getSession(session.id, {
      after: anchored.after,
      limit: 100,
    }) as SessionView
    expect(newer.events).toEqual(events.slice(100, 200))
    expect(newer.session.nativeId).toBe('original-native-session')
  })

  it('rejects ambiguous boundaries and malformed anchors before reading history', () => {
    const { session, events } = history(3)
    const view = vi.spyOn(store, 'view')
    for (const page of [
      { before: 3, after: 1 },
      { before: 3, aroundEventId: events[0].id },
      { after: 1, aroundEventId: events[0].id },
      { aroundEventId: '../other-session' },
      { after: 1.5 },
      { limit: 501 },
    ])
      expect(() => services.handlers.getSession(session.id, page)).toThrow()
    expect(view).not.toHaveBeenCalled()
  })
})
