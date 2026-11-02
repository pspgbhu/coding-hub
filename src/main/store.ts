import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  AgentEvent,
  Project,
  ProviderId,
  Session,
  Settings,
  SessionView,
} from '../shared/types'

export class Store {
  readonly db: Database.Database
  private sequence = Date.now() * 1000
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, stream_key TEXT, ordinal INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_session ON events(session_id, ordinal);
      CREATE INDEX IF NOT EXISTS events_stream ON events(stream_key);
      CREATE INDEX IF NOT EXISTS events_ordinal ON events(ordinal);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      PRAGMA user_version = 1;`)
    for (const session of this.sessions()) {
      if (session.status === 'running' || session.status === 'waiting') {
        this.resolveRequests(session.id)
        const turnId =
          session.activeTurnId ?? this.view(session.id).events.at(-1)?.turnId ?? randomUUID()
        this.append({
          id: randomUUID(),
          sessionId: session.id,
          turnId,
          timestamp: Date.now(),
          kind: 'done',
          status: 'interrupted',
        })
      }
    }
  }
  projects(): Project[] {
    return (
      this.db.prepare('SELECT data FROM projects ORDER BY rowid').all() as { data: string }[]
    ).map((r) => JSON.parse(r.data))
  }
  project(id: string): Project {
    const row = this.db.prepare('SELECT data FROM projects WHERE id = ?').get(id) as
      { data: string } | undefined
    if (!row) throw new Error('项目不存在，请重新打开项目。')
    return JSON.parse(row.data)
  }
  addProject(path: string, name: string): Project {
    const existing = this.projects().find((p) => p.path === path)
    if (existing) return existing
    const project: Project = { id: randomUUID(), path, name, createdAt: Date.now() }
    this.db
      .prepare('INSERT INTO projects VALUES (?, ?, ?)')
      .run(project.id, path, JSON.stringify(project))
    return project
  }
  removeProject(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  }
  sessions(): Session[] {
    return (
      this.db.prepare('SELECT data FROM sessions ORDER BY rowid DESC').all() as { data: string }[]
    )
      .map((r) => JSON.parse(r.data))
      .sort((a: Session, b: Session) => b.updatedAt - a.updatedAt)
  }
  searchSessions(query: string): Session[] {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return this.sessions()
    const needle = '%' + normalized.replace(/[\\%_]/g, (value) => '\\' + value) + '%'
    const matches = new Set(
      (
        this.db
          .prepare(
            "SELECT DISTINCT session_id FROM events WHERE LOWER(json_extract(data, '$.text')) LIKE ? ESCAPE '\\'",
          )
          .all(needle) as { session_id: string }[]
      ).map((row) => row.session_id),
    )
    const projectNames = new Map(
      this.projects().map((project) => [project.id, project.name.toLocaleLowerCase()]),
    )
    return this.sessions().filter(
      (session) =>
        matches.has(session.id) ||
        session.title.toLocaleLowerCase().includes(normalized) ||
        projectNames.get(session.projectId)?.includes(normalized),
    )
  }
  session(id: string): Session {
    const row = this.db.prepare('SELECT data FROM sessions WHERE id = ?').get(id) as
      { data: string } | undefined
    if (!row) throw new Error('会话不存在。')
    return JSON.parse(row.data)
  }
  createSession(projectId: string, provider: ProviderId, model?: string): Session {
    this.project(projectId)
    const now = Date.now()
    const session: Session = {
      id: randomUUID(),
      projectId,
      provider,
      model,
      title: '新会话',
      status: 'idle',
      archived: false,
      createdAt: now,
      updatedAt: now,
    }
    this.db
      .prepare('INSERT INTO sessions VALUES (?, ?, ?)')
      .run(session.id, projectId, JSON.stringify(session))
    return session
  }
  patchSession(id: string, patch: Partial<Session>): Session {
    const session = { ...this.session(id), ...patch, id, updatedAt: Date.now() }
    this.db.prepare('UPDATE sessions SET data = ? WHERE id = ?').run(JSON.stringify(session), id)
    return session
  }
  view(id: string): SessionView {
    return {
      session: this.session(id),
      cursor: this.sequence,
      events: (
        this.db
          .prepare('SELECT data FROM events WHERE session_id = ? ORDER BY ordinal')
          .all(id) as { data: string }[]
      ).map((r) => JSON.parse(r.data)),
    }
  }
  append(event: AgentEvent): void {
    event.sequence = this.sequence = Math.max(this.sequence + 1, Date.now() * 1000)
    this.db.transaction(() => {
      const session = this.session(event.sessionId)
      const streamKey = ['text', 'tool'].includes(event.kind)
        ? `${event.sessionId}:${event.turnId}:${event.kind}:${event.itemId ?? 'main'}`
        : null
      const existing = streamKey
        ? (this.db
            .prepare(
              'SELECT id, data FROM events WHERE stream_key = ? ORDER BY ordinal DESC LIMIT 1',
            )
            .get(streamKey) as { id: string; data: string } | undefined)
        : undefined
      if (existing) {
        const previous: AgentEvent = JSON.parse(existing.data)
        const updated = {
          ...previous,
          ...event,
          id: previous.id,
          delta: false,
          text:
            event.kind === 'text' && event.delta
              ? (previous.text ?? '') + (event.text ?? '')
              : (event.text ?? previous.text),
        }
        this.db
          .prepare('UPDATE events SET data = ? WHERE id = ?')
          .run(JSON.stringify(updated), existing.id)
      } else {
        this.db
          .prepare(
            'INSERT OR IGNORE INTO events VALUES (?, ?, ?, (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM events), ?)',
          )
          .run(event.id, event.sessionId, streamKey, JSON.stringify({ ...event, delta: false }))
      }
      const currentTurn = !session.activeTurnId || session.activeTurnId === event.turnId
      if (event.kind === 'session' && event.nativeId && currentTurn)
        this.patchSession(session.id, { nativeId: event.nativeId })
      if (event.kind === 'status' && event.status && currentTurn)
        this.patchSession(session.id, { status: event.status })
      if ((event.kind === 'approval' || event.kind === 'question') && currentTurn)
        this.patchSession(session.id, { status: 'waiting' })
      if (event.kind === 'error' && currentTurn) this.patchSession(session.id, { status: 'error' })
      if (event.kind === 'done') {
        this.resolveRequests(session.id, undefined, event.turnId)
        if (currentTurn)
          this.patchSession(session.id, {
            status: event.status ?? (session.status === 'error' ? 'error' : 'idle'),
          })
      }
      if (event.kind === 'user')
        this.patchSession(session.id, {
          activeTurnId: event.turnId,
          ...(session.title === '新会话'
            ? { title: (event.text ?? '').replace(/\s+/g, ' ').slice(0, 42) || '新会话' }
            : {}),
        })
    })()
  }
  resolveRequests(sessionId: string, requestId?: string, turnId?: string): void {
    for (const event of this.view(sessionId).events) {
      if (
        (event.kind === 'approval' || event.kind === 'question') &&
        (!requestId || event.requestId === requestId) &&
        (!turnId || event.turnId === turnId)
      ) {
        this.db
          .prepare('UPDATE events SET data = ? WHERE id = ?')
          .run(JSON.stringify({ ...event, state: 'completed' }), event.id)
      }
    }
  }
  settings(): Settings {
    const row = this.db.prepare("SELECT data FROM settings WHERE key = 'app'").get() as
      { data: string } | undefined
    return row
      ? { theme: 'system', cliPaths: {}, ...JSON.parse(row.data) }
      : { theme: 'system', cliPaths: {} }
  }
  saveSettings(settings: Settings): Settings {
    this.db
      .prepare(
        "INSERT INTO settings VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data",
      )
      .run(JSON.stringify(settings))
    return settings
  }
  close(): void {
    this.db.close()
  }
}
