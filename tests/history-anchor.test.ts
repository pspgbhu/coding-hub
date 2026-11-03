import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/main/store'
import type { AgentEvent, SessionView } from '../src/shared/types'

const directories: string[] = []
const stores: Store[] = []

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'hub-history-anchor-'))
  directories.push(directory)
  const store = new Store(join(directory, 'hub.db'))
  stores.push(store)
  const project = store.addProject(join(directory, 'project'), '历史定位项目')
  const session = store.createSession(project.id, 'codex')
  store.patchSession(session.id, { nativeId: `native-${randomUUID()}` })
  return { store, project, session: store.session(session.id) }
}

// Use real persisted event rows and the production search triggers, without paying
// the per-delta session/update cost when exercising a long conversation.
function seedEvents(store: Store, sessionId: string, count: number, ordinalOffset = 0) {
  const events: AgentEvent[] = Array.from({ length: count }, (_, index) => ({
    id: randomUUID(),
    sessionId,
    turnId: `native-turn-${Math.floor(index / 2)}`,
    itemId: `native-item-${index}`,
    kind: index % 2 === 0 ? 'user' : 'text',
    timestamp: 1_700_000_000_000 + index,
    sequence: ordinalOffset + (index + 1) * 10 + 7,
    text: index === 5 ? '旧事件唯一锚点 early-anchor-needle' : `历史消息 ${index + 1}`,
  }))
  const insert = store.db.prepare(
    'INSERT INTO events (id, session_id, stream_key, ordinal, data) VALUES (?, ?, NULL, ?, ?)',
  )
  store.db.transaction(() => {
    for (const event of events)
      insert.run(event.id, sessionId, event.sequence, JSON.stringify(event))
  })()
  return events
}

function ids(events: AgentEvent[]) {
  return events.map((event) => event.id)
}

function expectBoundaries(page: SessionView) {
  expect(page.before).toBe(page.events[0]?.sequence)
  expect(page.after).toBe(page.events.at(-1)?.sequence)
}

afterEach(() => {
  for (const store of stores.splice(0)) if (store.db.open) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('anchored conversation history', () => {
  it('finds the sixth real search result in 10,000 events with a bounded page and unchanged native identity', () => {
    const { store, session } = setup()
    const events = seedEvents(store, session.id, 10_000)
    const match = store.searchSessions('early-anchor-needle').find((item) => item.id === session.id)
    expect(match?.matchEventId).toBe(events[5].id)

    const page = store.view(session.id, { aroundEventId: match!.matchEventId, limit: 100 })

    expect(page.anchorFound).toBe(true)
    expect(page.events).toHaveLength(100)
    expect(page.events).toEqual(events.slice(0, 100))
    expect(page.events.find((event) => event.id === events[5].id)).toEqual(events[5])
    expect(page.session.id).toBe(session.id)
    expect(page.session.nativeId).toBe(session.nativeId)
    expect(page.hasMore).toBe(false)
    expect(page.hasNewer).toBe(true)
    expectBoundaries(page)
    expect(store.session(session.id).nativeId).toBe(session.nativeId)
    expect(store.db.prepare('SELECT count(*) AS count FROM events').get()).toEqual({
      count: 10_000,
    })
  })

  it('balances a middle anchor and pages both ways through all 10,000 events without gaps or repeats', () => {
    const { store, session } = setup()
    const events = seedEvents(store, session.id, 10_000)
    const anchorIndex = 5_000
    const anchored = store.view(session.id, {
      aroundEventId: events[anchorIndex].id,
      limit: 100,
    })
    expect(anchored.anchorFound).toBe(true)
    expect(anchored.events).toHaveLength(100)
    expect(anchored.hasMore).toBe(true)
    expect(anchored.hasNewer).toBe(true)
    expectBoundaries(anchored)

    const anchorPosition = anchored.events.findIndex((event) => event.id === events[anchorIndex].id)
    expect(
      Math.abs(anchorPosition - (anchored.events.length - anchorPosition - 1)),
    ).toBeLessThanOrEqual(1)
    const firstIndex = events.findIndex((event) => event.id === anchored.events[0].id)
    expect(anchored.events).toEqual(events.slice(firstIndex, firstIndex + 100))

    const earlier: AgentEvent[] = []
    let older = anchored
    for (let pages = 0; older.hasMore; pages++) {
      expect(pages).toBeLessThan(100)
      const page = store.view(session.id, { before: older.before, limit: 100 })
      expect(page.events.length).toBeGreaterThan(0)
      expect(page.events.length).toBeLessThanOrEqual(100)
      expect(page.events.at(-1)!.sequence).toBeLessThan(older.before!)
      expect(page.hasNewer).toBe(true)
      expectBoundaries(page)
      earlier.unshift(...page.events)
      older = page
    }
    expect(older.events[0].id).toBe(events[0].id)

    const later: AgentEvent[] = []
    let newer = anchored
    for (let pages = 0; newer.hasNewer; pages++) {
      expect(pages).toBeLessThan(100)
      const page = store.view(session.id, { after: newer.after, limit: 100 })
      expect(page.events.length).toBeGreaterThan(0)
      expect(page.events.length).toBeLessThanOrEqual(100)
      expect(page.events[0].sequence).toBeGreaterThan(newer.after!)
      expect(page.hasMore).toBe(true)
      expectBoundaries(page)
      later.push(...page.events)
      newer = page
    }
    expect(newer.events.at(-1)!.id).toBe(events.at(-1)!.id)

    const reconstructed = [...earlier, ...anchored.events, ...later]
    expect(ids(reconstructed)).toEqual(ids(events))
    expect(new Set(ids(reconstructed)).size).toBe(10_000)
  })

  it('fills the requested window at the newest edge instead of returning only half a page', () => {
    const { store, session } = setup()
    const events = seedEvents(store, session.id, 240)
    const page = store.view(session.id, { aroundEventId: events.at(-1)!.id, limit: 100 })

    expect(page.anchorFound).toBe(true)
    expect(page.events).toEqual(events.slice(-100))
    expect(page.hasMore).toBe(true)
    expect(page.hasNewer).toBe(false)
    expectBoundaries(page)
  })

  it.each(['missing', 'foreign'] as const)(
    'falls back to only the requested session’s latest bounded page for a %s anchor',
    (anchorKind) => {
      const { store, project, session } = setup()
      const events = seedEvents(store, session.id, 240)
      const foreignSession = store.createSession(project.id, 'claude')
      const foreignEvents = seedEvents(store, foreignSession.id, 130, 1_000_000)
      const anchorId = anchorKind === 'foreign' ? foreignEvents[5].id : randomUUID()

      const page = store.view(session.id, { aroundEventId: anchorId, limit: 100 })

      expect(page.anchorFound).toBe(false)
      expect(page.events).toHaveLength(100)
      expect(page.events).toEqual(events.slice(-100))
      expect(page.events.every((event) => event.sessionId === session.id)).toBe(true)
      expect(page.events.some((event) => event.id === anchorId)).toBe(false)
      expect(page.session.id).toBe(session.id)
      expect(page.session.nativeId).toBe(session.nativeId)
      expect(page.hasMore).toBe(true)
      expect(page.hasNewer).toBe(false)
      expectBoundaries(page)
    },
  )

  it('keeps legacy before pagination exclusive and unpaged reads complete', () => {
    const { store, session } = setup()
    const events = seedEvents(store, session.id, 7)
    const newest = store.view(session.id, { limit: 3 })
    const middle = store.view(session.id, { before: newest.before, limit: 3 })
    const oldest = store.view(session.id, { before: middle.before, limit: 3 })

    expect(newest.events).toEqual(events.slice(4))
    expect(middle.events).toEqual(events.slice(1, 4))
    expect(oldest.events).toEqual(events.slice(0, 1))
    expect(newest.hasMore).toBe(true)
    expect(newest.hasNewer).toBe(false)
    expect(middle.hasMore).toBe(true)
    expect(middle.hasNewer).toBe(true)
    expect(oldest.hasMore).toBe(false)
    expect(oldest.hasNewer).toBe(true)
    for (const page of [newest, middle, oldest]) expectBoundaries(page)

    const full = store.view(session.id)
    expect(full.events).toEqual(events)
    expect(ids([...oldest.events, ...middle.events, ...newest.events])).toEqual(ids(full.events))
    expect(full.hasMore).toBe(false)
    expect(full.hasNewer).toBe(false)
  })

  it('rejects ambiguous paging boundaries and keeps a single-event window bounded', () => {
    const { store, session } = setup()
    const events = seedEvents(store, session.id, 7)
    for (const page of [
      { before: 100, after: 10 },
      { before: 100, aroundEventId: events[3].id },
      { after: 10, aroundEventId: events[3].id },
    ])
      expect(() => store.view(session.id, page)).toThrow('一个定位边界')
    const page = store.view(session.id, { aroundEventId: events[3].id, limit: 1 })
    expect(page.events).toEqual([events[3]])
    expect(page.hasMore).toBe(true)
    expect(page.hasNewer).toBe(true)
    expectBoundaries(page)
  })

  it('handles an anchor missing from an empty session without inventing page boundaries', () => {
    const { store, session } = setup()
    const page = store.view(session.id, { aroundEventId: randomUUID(), limit: 100 })
    expect(page.events).toEqual([])
    expect(page.anchorFound).toBe(false)
    expect(page.hasMore).toBe(false)
    expect(page.hasNewer).toBe(false)
    expect(page.before).toBeUndefined()
    expect(page.after).toBeUndefined()
  })
})
