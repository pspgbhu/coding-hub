import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store } from '../src/main/store'
import { OutputStore } from '../src/main/output-store'
import { exportSessionFile } from '../src/main/session-export'
import type { AgentEvent } from '../src/shared/types'

const directories: string[] = []
const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'hub-export-'))
  directories.push(directory)
  const store = new Store(join(directory, 'test.db'))
  stores.push(store)
  const project = store.addProject(directory, 'fixture')
  const session = store.createSession(project.id, 'codex')
  const outputs = new OutputStore(directory)
  const append = (extra: Partial<AgentEvent>) =>
    store.append({
      id: randomUUID(),
      sessionId: session.id,
      turnId: randomUUID(),
      timestamp: Date.now(),
      kind: 'text',
      ...extra,
    })
  return { directory, store, session, outputs, append }
}
describe('complete session exports', () => {
  it('exports every page and full paginated Unicode tool output in valid JSON', async () => {
    const { directory, store, session, outputs, append } = fixture()
    store.db.transaction(() => {
      for (let i = 0; i < 550; i++) append({ text: `message ${i}` })
    })()
    const full = '中文🙂\\"\n'.repeat(15000)
    const tool = outputs.ingest({
      id: randomUUID(),
      sessionId: session.id,
      turnId: randomUUID(),
      timestamp: Date.now(),
      kind: 'tool',
      output: full,
      state: 'completed',
    })
    store.append(tool)
    const path = join(directory, 'session.json')
    await exportSessionFile(store, outputs, session, path, 'json')
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    expect(parsed.events).toHaveLength(551)
    expect(parsed.events[0].text).toBe('message 0')
    expect(parsed.events[549].text).toBe('message 549')
    expect(parsed.events[550].output).toBe(full)
    expect(parsed.events[550].outputRef).toBeUndefined()
  })
  it('retains the existing destination when a referenced full output is missing', async () => {
    const { directory, store, session, outputs, append } = fixture()
    append({ kind: 'tool', output: 'preview', outputRef: 'a'.repeat(64) })
    const destination = join(directory, 'existing.md')
    writeFileSync(destination, 'original')
    await expect(
      exportSessionFile(store, outputs, session, destination, 'markdown'),
    ).rejects.toThrow()
    expect(readFileSync(destination, 'utf8')).toBe('original')
    expect(readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})
