import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store } from '../src/main/store'
import type { AgentEvent } from '../src/shared/types'
const locations: string[] = []
const stores: Store[] = []
function setup() {
  const location = mkdtempSync(join(tmpdir(), 'hub-store-'))
  locations.push(location)
  const store = new Store(join(location, 'test.db'))
  stores.push(store)
  const project = store.addProject(location, '项目')
  const session = store.createSession(project.id, 'codex')
  return { store, project, session, location }
}
afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close()
    } catch {}
  }
  for (const location of locations.splice(0)) rmSync(location, { recursive: true, force: true })
})
describe('persistent conversation state', () => {
  it('does not let late completion of an old turn change a newer turn or its approvals', () => {
    const { store, session, location } = setup()
    const event = (turnId: string, extra: Partial<AgentEvent>) =>
      store.append({
        id: randomUUID(),
        sessionId: session.id,
        turnId,
        kind: 'user',
        timestamp: Date.now(),
        ...extra,
      })
    event('old', { text: 'first' })
    event('new', { text: 'second' })
    event('new', { kind: 'approval', requestId: 'new-approval' })
    event('old', { kind: 'done', status: 'idle' })
    expect(store.session(session.id).status).toBe('waiting')
    expect(
      store.view(session.id).events.find((e) => e.requestId === 'new-approval')?.state,
    ).not.toBe('completed')
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const reopened = new Store(join(location, 'test.db'))
    stores.push(reopened)
    expect(reopened.session(session.id).status).toBe('interrupted')
  })
  it('searches message content while treating LIKE wildcard characters literally', () => {
    const { store, session } = setup()
    store.append({
      id: randomUUID(),
      sessionId: session.id,
      turnId: 'turn',
      kind: 'text',
      itemId: 'message',
      text: 'A unique topic: 100%_safe',
      timestamp: Date.now(),
    })
    expect(store.searchSessions('unique topic').map((s) => s.id)).toContain(session.id)
    expect(store.searchSessions('100%_safe')).toHaveLength(1)
    expect(store.searchSessions('100%Zsafe')).toHaveLength(0)
  })
  it('coalesces streaming text by turn and item without combining turns', () => {
    const { store, session } = setup()
    const emit = (turnId: string, text: string, delta = true) =>
      store.append({
        id: randomUUID(),
        sessionId: session.id,
        turnId,
        kind: 'text',
        itemId: 'message',
        text,
        delta,
        timestamp: Date.now(),
      })
    emit('one', '你好')
    emit('one', '世界')
    emit('two', '第二轮')
    expect(store.view(session.id).events.map((e) => e.text)).toEqual(['你好世界', '第二轮'])
    emit('one', '最终内容', false)
    expect(store.view(session.id).events[0].text).toBe('最终内容')
  })
  it('retains native IDs and resolves stale approvals when a turn ends', () => {
    const { store, session } = setup()
    const event = (extra: Partial<AgentEvent>) =>
      store.append({
        id: randomUUID(),
        sessionId: session.id,
        turnId: 'turn',
        kind: 'status',
        timestamp: Date.now(),
        ...extra,
      })
    event({ kind: 'session', nativeId: 'native-123' })
    event({ kind: 'approval', requestId: 'request' })
    expect(store.session(session.id).status).toBe('waiting')
    event({ kind: 'done' })
    expect(store.session(session.id).nativeId).toBe('native-123')
    expect(store.session(session.id).status).toBe('idle')
    expect(store.view(session.id).events.find((e) => e.requestId)?.state).toBe('completed')
  })
  it('recovers active conversations after reopening and cascades project removal', () => {
    const { store, session, project, location } = setup()
    store.patchSession(session.id, { status: 'running' })
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const reopened = new Store(join(location, 'test.db'))
    stores.push(reopened)
    expect(reopened.session(session.id).status).toBe('interrupted')
    reopened.removeProject(project.id)
    expect(reopened.sessions()).toEqual([])
  })
  it('retires pending approvals after an abrupt restart and exposes a stream cursor', () => {
    const { store, session, location } = setup()
    const event: AgentEvent = {
      id: randomUUID(),
      sessionId: session.id,
      turnId: 'old-turn',
      kind: 'approval',
      requestId: 'old-request',
      timestamp: Date.now(),
    }
    store.append(event)
    expect(event.sequence).toBeGreaterThan(0)
    expect(store.view(session.id).cursor).toBeGreaterThanOrEqual(event.sequence!)
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const reopened = new Store(join(location, 'test.db'))
    stores.push(reopened)
    expect(reopened.session(session.id).status).toBe('interrupted')
    expect(reopened.view(session.id).events.find((e) => e.requestId)?.state).toBe('completed')
  })
  it('deduplicates projects and persists settings', () => {
    const { store, project } = setup()
    expect(store.addProject(project.path, 'alias').id).toBe(project.id)
    store.saveSettings({ theme: 'dark', cliPaths: { claude: '/custom/claude' } })
    expect(store.settings().cliPaths.claude).toBe('/custom/claude')
  })
})
