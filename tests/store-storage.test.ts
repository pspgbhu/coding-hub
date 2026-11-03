import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store } from '../src/main/store'
import { backupDirectory, SCHEMA_VERSION } from '../src/main/storage'
import type { AgentEvent, ComposerDraft, EditorState } from '../src/shared/types'

const directories: string[] = []
const stores: Store[] = []
function location() {
  const directory = mkdtempSync(join(tmpdir(), 'hub-storage-'))
  directories.push(directory)
  return { directory, path: join(directory, 'hub.db') }
}
function open(path: string) {
  const store = new Store(path)
  stores.push(store)
  return store
}
function close(store: Store) {
  store.close()
  stores.splice(stores.indexOf(store), 1)
}
function setup() {
  const { directory, path } = location()
  const store = open(path)
  const project = store.addProject(join(directory, 'project'), '项目')
  const session = store.createSession(project.id, 'codex')
  return { directory, path, store, project, session }
}
function emit(store: Store, sessionId: string, text: string, extra: Partial<AgentEvent> = {}) {
  store.append({
    id: randomUUID(),
    sessionId,
    turnId: randomUUID(),
    kind: 'text',
    timestamp: Date.now(),
    text,
    ...extra,
  })
}
function createV1(path: string, directory: string) {
  const project = {
    id: randomUUID(),
    path: join(directory, '中文 project'),
    name: '原项目',
    createdAt: 123,
  }
  const session = {
    id: randomUUID(),
    projectId: project.id,
    provider: 'codex',
    title: '原会话',
    nativeId: 'native-original',
    activeTurnId: 'original-turn',
    status: 'idle',
    archived: false,
    createdAt: 234,
    updatedAt: 456,
  }
  const db = new Database(path)
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,path TEXT UNIQUE NOT NULL,data TEXT NOT NULL);
    CREATE TABLE sessions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,data TEXT NOT NULL);
    CREATE TABLE events(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,stream_key TEXT,ordinal INTEGER NOT NULL,data TEXT NOT NULL);
    CREATE TABLE settings(key TEXT PRIMARY KEY,data TEXT NOT NULL);
    PRAGMA user_version=1;`)
  db.prepare('INSERT INTO projects VALUES(?,?,?)').run(
    project.id,
    project.path,
    JSON.stringify(project),
  )
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(
    session.id,
    project.id,
    JSON.stringify(session),
  )
  const event = {
    id: randomUUID(),
    sessionId: session.id,
    turnId: 'original-turn',
    kind: 'text',
    timestamp: 345,
    text: '迁移前的完整对话',
  }
  db.prepare('INSERT INTO events VALUES(?,?,NULL,1,?)').run(
    event.id,
    session.id,
    JSON.stringify(event),
  )
  db.close()
  return { project, session, event }
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) if (store.db.open) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('versioned local storage', () => {
  it('migrates v1 with a verified pre-migration snapshot while preserving native identity and cwd', () => {
    const { directory, path } = location()
    const original = createV1(path, directory)
    const store = open(path)
    expect(store.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(store.session(original.session.id)).toMatchObject({
      ...original.session,
      workspaceId: original.project.id,
    })
    expect(store.workspace(original.project.id)).toMatchObject({
      id: original.project.id,
      projectId: original.project.id,
      cwd: original.project.path,
      kind: 'shared',
    })
    expect(store.project(original.project.id).trusted).toBe(true)
    expect(store.view(original.session.id).events[0]).toEqual(original.event)
    expect(store.searchSessions('完整对话')[0].matchEventId).toBe(original.event.id)
    const backup = store.listBackups().find((item) => item.reason === 'migration')!
    expect(store.verifyBackup(backup.id).schemaVersion).toBe(1)
    const snapshot = new Database(join(backupDirectory(path), backup.id), { readonly: true })
    expect(snapshot.pragma('user_version', { simple: true })).toBe(1)
    expect(
      JSON.parse((snapshot.prepare('SELECT data FROM sessions').get() as { data: string }).data),
    ).toEqual(original.session)
    snapshot.close()
  })

  it('rejects future schema versions without changing the file', () => {
    const { path } = location()
    const db = new Database(path)
    db.pragma('user_version = 999')
    db.close()
    const before = readFileSync(path)
    expect(() => new Store(path)).toThrow('更新版本')
    expect(readFileSync(path)).toEqual(before)
  })

  it('rejects damaged databases and invalid records without replacing user data', () => {
    const first = location()
    writeFileSync(first.path, 'original damaged database')
    expect(() => new Store(first.path)).toThrow()
    expect(readFileSync(first.path, 'utf8')).toBe('original damaged database')
    const second = location()
    createV1(second.path, second.directory)
    const db = new Database(second.path)
    db.prepare("UPDATE sessions SET data = 'null'").run()
    db.close()
    const before = readFileSync(second.path)
    expect(() => new Store(second.path)).toThrow('无效的记录')
    expect(readFileSync(second.path)).toEqual(before)
  })

  it('persists independent composer drafts and unsaved editor buffers and rejects stale writes', () => {
    const { path, store, project, session } = setup()
    const other = store.createSession(project.id, 'claude')
    const draft: ComposerDraft = {
      text: '尚未发送',
      context: [
        {
          id: 'context',
          kind: 'selection',
          name: '引用',
          content: '引用内容',
          path: 'hello.ts',
          startLine: 1,
          endLine: 2,
        },
      ],
      updatedAt: 20,
    }
    const editor: EditorState = {
      files: [
        {
          path: 'hello.ts',
          content: 'disk',
          edited: 'unsaved',
          fingerprint: 'original',
          language: 'typescript',
          viewState: { scrollTop: 42 },
        },
      ],
      active: 'hello.ts',
      mode: 'files',
      updatedAt: 20,
    }
    store.saveDraft(session.id, draft)
    store.saveEditorState(project.id, editor)
    expect(store.saveDraft(session.id, { ...draft, text: 'stale', updatedAt: 10 })).toEqual(draft)
    expect(store.saveEditorState(project.id, { ...editor, files: [], updatedAt: 10 })).toEqual(
      editor,
    )
    expect(store.getDraft(other.id)).toEqual({ text: '', context: [], updatedAt: 0 })
    close(store)
    const reopened = open(path)
    expect(reopened.getDraft(session.id)).toEqual(draft)
    expect(reopened.getEditorState(project.id)).toEqual(editor)
    expect(reopened.workspace(project.id).cwd).toBe(project.path)
  })

  it('keeps project removal and session trash reversible without changing native sessions', () => {
    const { store, project, session } = setup()
    emit(store, session.id, 'retained history')
    store.patchSession(session.id, { nativeId: 'native', pinned: true, readAt: 123 })
    const other = store.createSession(project.id, 'claude')
    expect(store.sessions()[0].id).toBe(session.id)
    store.patchSession(session.id, { deletedAt: Date.now() })
    expect(store.sessions().map((item) => item.id)).toEqual([other.id])
    expect(store.sessions({ includeDeleted: true })).toHaveLength(2)
    store.patchSession(session.id, { deletedAt: undefined })
    expect(store.sessions()[0]).toMatchObject({
      id: session.id,
      nativeId: 'native',
      pinned: true,
      readAt: 123,
    })
    store.removeProject(project.id)
    expect(store.projects()).toEqual([])
    expect(store.sessions()).toEqual([])
    expect(store.projects({ includeRemoved: true })).toHaveLength(1)
    expect(store.view(session.id).events[0].text).toBe('retained history')
    expect(store.addProject(project.path, 'duplicate')).toMatchObject({
      id: project.id,
      removedAt: undefined,
    })
    expect(store.sessions()).toHaveLength(2)
    expect(store.project(project.id).trusted).toBe(false)
  })

  it('validates workspace ownership and retains cwd when a project with native history relocates', () => {
    const { store, project, session } = setup()
    const another = store.addProject('/another-project', 'another')
    expect(() => store.createSession(project.id, 'codex', undefined, another.id)).toThrow('工作区')
    store.patchSession(session.id, { nativeId: 'original-native-session' })
    store.patchProject(project.id, { path: '/relocated-project', trusted: true })
    expect(store.workspace(project.id).cwd).toBe(project.path)
    store.patchSession(session.id, { workspaceId: another.id, projectId: another.id })
    expect(store.session(session.id)).toMatchObject({
      workspaceId: project.id,
      projectId: project.id,
    })
    const custom = {
      id: randomUUID(),
      projectId: project.id,
      kind: 'worktree' as const,
      cwd: '/temporary-worktree',
      name: '独立任务',
      createdAt: Date.now(),
      ownedByHub: true,
    }
    store.addWorkspace(custom)
    store.createSession(project.id, 'codex', undefined, custom.id)
    store.removeWorkspace(custom.id)
    expect(store.workspaces(project.id).map((item) => item.id)).not.toContain(custom.id)
    expect(store.workspace(custom.id).cwd).toBe(custom.cwd)
    store.createSession(another.id, 'codex')
    store.patchProject(another.id, { path: '/relocated-unused-project' })
    expect(store.workspace(another.id).cwd).toBe('/relocated-unused-project')
  })

  it('paginates history without duplicates while maintaining full-view compatibility', () => {
    const { store, session } = setup()
    for (let i = 0; i < 7; i++) emit(store, session.id, `message ${i}`)
    const newest = store.view(session.id, { limit: 3 })
    const middle = store.view(session.id, { limit: 3, before: newest.before })
    const oldest = store.view(session.id, { limit: 3, before: middle.before })
    expect(newest.events.map((event) => event.text)).toEqual([
      'message 4',
      'message 5',
      'message 6',
    ])
    expect(middle.hasMore).toBe(true)
    expect(oldest.hasMore).toBe(false)
    expect([...oldest.events, ...middle.events, ...newest.events].map((event) => event.id)).toEqual(
      store.view(session.id).events.map((event) => event.id),
    )
  })

  it('indexes literal Unicode search with snippets, paging, updates and soft-deletion filters', () => {
    const { store, project, session } = setup()
    emit(store, session.id, 'prefix '.repeat(20) + '中文目标 100%_safe suffix', {
      turnId: 'stream',
      itemId: 'answer',
    })
    const result = store.searchSessions('中文目标')[0]
    expect(result.snippet).toContain('中文目标')
    expect(result.snippet?.startsWith('…')).toBe(true)
    expect(result.matchEventId).toBeTruthy()
    expect(store.searchSessions('100%_safe')).toHaveLength(1)
    expect(store.searchSessions('100%Zsafe')).toHaveLength(0)
    expect(store.searchSessions('中文')).toHaveLength(1)
    emit(store, session.id, '😊a quoted "value"', { turnId: 'emoji' })
    expect(store.searchSessions('😊a')).toHaveLength(1)
    expect(store.searchSessions('"value"')).toHaveLength(1)
    emit(store, session.id, 'replacement target', { turnId: 'stream', itemId: 'answer' })
    expect(store.searchSessions('中文目标')).toEqual([])
    expect(store.searchSessions('REPLACEMENT')).toHaveLength(1)
    const other = store.createSession(project.id, 'claude')
    emit(store, other.id, 'replacement second')
    expect(store.searchSessions('replacement', { limit: 1 })).toHaveLength(1)
    expect(store.searchSessions('replacement', { limit: 1, offset: 1 })).toHaveLength(1)
    store.patchSession(session.id, { deletedAt: Date.now() })
    expect(store.searchSessions('replacement')).toHaveLength(1)
    expect(store.searchSessions('replacement', { includeDeleted: true })).toHaveLength(2)
  })

  it('records actual request resolutions without allowing completion to overwrite decisions', () => {
    const { path, store, session } = setup()
    emit(store, session.id, '', {
      kind: 'approval',
      requestId: 'permission',
      turnId: 'turn',
      state: 'running',
    })
    emit(store, session.id, '', {
      kind: 'requestResolved',
      requestId: 'permission',
      turnId: 'turn',
      decision: 'decline',
      resolution: 'denied',
      scope: 'once',
    })
    emit(store, session.id, '', { kind: 'done', turnId: 'turn', status: 'idle' })
    expect(store.view(session.id).events.find((event) => event.kind === 'approval')).toMatchObject({
      state: 'completed',
      decision: 'decline',
      resolution: 'denied',
      scope: 'once',
    })
    emit(store, session.id, '', {
      kind: 'question',
      requestId: 'format',
      turnId: 'question-turn',
      state: 'running',
      questions: [{ id: 'format', title: '选择格式' }],
    })
    emit(store, session.id, '', {
      kind: 'requestResolved',
      requestId: 'format',
      turnId: 'question-turn',
      answers: { format: ['JSON'] },
      resolution: 'approved',
    })
    emit(store, session.id, '', { kind: 'done', turnId: 'question-turn', status: 'idle' })
    close(store)
    expect(
      open(path)
        .view(session.id)
        .events.find((event) => event.kind === 'question'),
    ).toMatchObject({
      state: 'completed',
      answers: { format: ['JSON'] },
      resolution: 'approved',
    })
  })

  it('preserves coalesced tool output and external references when completion omits them', () => {
    const { store, session } = setup()
    emit(store, session.id, '', {
      kind: 'tool',
      turnId: 'output-turn',
      itemId: 'command',
      state: 'running',
      output: 'bounded preview',
      outputRef: 'opaque-output-reference',
      outputBytes: 90000,
      outputTruncated: true,
    })
    emit(store, session.id, '', {
      kind: 'tool',
      turnId: 'output-turn',
      itemId: 'command',
      state: 'completed',
      output: undefined,
      outputRef: undefined,
      outputBytes: undefined,
      outputTruncated: undefined,
    })
    const events = store.view(session.id).events
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      state: 'completed',
      output: 'bounded preview',
      outputRef: 'opaque-output-reference',
      outputBytes: 90000,
      outputTruncated: true,
    })
  })
})

describe('consistent backups and recovery', () => {
  it('validates a WAL-consistent snapshot, restores it and preserves the replaced database as a backup', () => {
    const { path, store, project, session } = setup()
    emit(store, session.id, 'snapshot message')
    store.saveDraft(session.id, { text: 'snapshot draft', context: [], updatedAt: 10 })
    const backup = store.createBackup()
    expect(backup.bytes).toBeGreaterThan(0)
    expect(store.verifyBackup(backup.id).schemaVersion).toBe(SCHEMA_VERSION)
    emit(store, session.id, 'after snapshot')
    store.saveDraft(session.id, { text: 'new draft', context: [], updatedAt: 20 })
    const safeguard = store.restoreBackup(backup.id)!
    expect(safeguard.reason).toBe('before-restore')
    expect(store.verifyBackup(safeguard.id)).toEqual(safeguard)
    expect(store.getDraft(session.id).text).toBe('snapshot draft')
    expect(store.view(session.id).events.map((event) => event.text)).toEqual(['snapshot message'])
    expect(store.project(project.id).id).toBe(project.id)
    store.restoreBackup(safeguard.id)
    expect(store.getDraft(session.id).text).toBe('new draft')
    expect(store.storageInfo()).toMatchObject({
      projects: 1,
      sessions: 1,
      events: 2,
      schemaVersion: SCHEMA_VERSION,
    })
    expect(store.storageInfo().databaseBytes).toBeGreaterThan(0)
    close(store)
    expect(open(path).view(session.id).events).toHaveLength(2)
  })

  it('refuses corrupt or untrusted backup paths without changing current records', () => {
    const { path, store, session } = setup()
    emit(store, session.id, 'do not lose this')
    const backup = store.createBackup()
    writeFileSync(join(backupDirectory(path), backup.id), 'damaged backup')
    expect(() => store.restoreBackup(backup.id)).toThrow('备份验证失败')
    expect(() => store.restoreBackup('../../hub.db')).toThrow('无效的备份标识')
    expect(store.view(session.id).events[0].text).toBe('do not lose this')
    store.patchSession(session.id, { status: 'running' })
    expect(() => store.restoreBackup(backup.id)).toThrow('停止所有运行中的任务')
  })

  it('retains the latest seven daily snapshots and keeps manual backups separately', () => {
    const { path } = location()
    const now = vi.spyOn(Date, 'now')
    let manualId = ''
    for (let day = 1; day <= 10; day++) {
      now.mockReturnValue(new Date(2026, 0, day, 12).getTime())
      const store = open(path)
      if (day === 1) manualId = store.createBackup().id
      store.createBackup()
      close(store)
    }
    const store = open(path)
    const daily = store.listBackups().filter((item) => item.reason === 'daily')
    expect(daily).toHaveLength(7)
    expect(new Date(daily.at(-1)!.createdAt).getDate()).toBe(4)
    expect(store.listBackups().some((item) => item.id === manualId)).toBe(true)
    close(store)
    expect(
      open(path)
        .listBackups()
        .filter((item) => item.reason === 'daily'),
    ).toHaveLength(7)
  })
})
