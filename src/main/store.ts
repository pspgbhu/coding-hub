import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { existsSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  AgentEvent,
  BackupInfo,
  ComposerDraft,
  EditorState,
  Project,
  ProviderId,
  Session,
  Settings,
  SessionView,
  SessionPage,
  SessionSearchResult,
  StorageInfo,
  Workspace,
} from '../shared/types'
import { ACTIVE_STATUSES } from '../shared/types'
import {
  backupDirectory,
  archiveDamagedOutputs,
  listDatabaseBackups,
  openDatabase,
  outputStorageBytes,
  OutputAttachmentError,
  replaceDatabase,
  SCHEMA_VERSION,
  snapshotDatabase,
  verifiedBackupPath,
} from './storage'

interface SessionFilter {
  includeDeleted?: boolean
  includeRemoved?: boolean
}
interface SearchOptions extends SessionFilter {
  limit?: number
  offset?: number
}

export class Store {
  db: Database.Database
  backupError?: string
  restoreWarning?: string
  private sequence = Date.now() * 1000
  private dailyTimer?: NodeJS.Timeout
  constructor(
    private readonly path: string,
    private readonly onBackupError?: (error: Error) => void,
  ) {
    this.db = openDatabase(path)
    try {
      this.recoverInterrupted()
      this.runDailyBackup()
      this.dailyTimer = setInterval(() => this.runDailyBackup(), 60 * 60 * 1000)
      this.dailyTimer.unref()
    } catch (error) {
      this.db.close()
      throw error
    }
  }
  private recoverInterrupted(): void {
    for (const session of this.sessions({ includeDeleted: true, includeRemoved: true })) {
      if (ACTIVE_STATUSES.includes(session.status)) {
        this.resolveRequests(session.id, undefined, undefined, { resolution: 'cancelled' })
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
  projects(options: { includeRemoved?: boolean } = {}): Project[] {
    return (this.db.prepare('SELECT data FROM projects ORDER BY rowid').all() as { data: string }[])
      .map((r) => JSON.parse(r.data) as Project)
      .filter((project) => options.includeRemoved || !project.removedAt)
  }
  project(id: string): Project {
    const row = this.db.prepare('SELECT data FROM projects WHERE id = ?').get(id) as
      { data: string } | undefined
    if (!row) throw new Error('项目不存在，请重新打开项目。')
    return JSON.parse(row.data)
  }
  addProject(path: string, name: string): Project {
    const existing = this.projects({ includeRemoved: true }).find((p) => p.path === path)
    if (existing)
      return existing.removedAt
        ? this.patchProject(existing.id, { removedAt: undefined })
        : existing
    const project: Project = { id: randomUUID(), path, name, createdAt: Date.now(), trusted: false }
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO projects VALUES (?, ?, ?)')
        .run(project.id, path, JSON.stringify(project))
      this.addWorkspace({
        id: project.id,
        projectId: project.id,
        kind: 'shared',
        cwd: path,
        name: '共享工作区',
        createdAt: project.createdAt,
      })
    })()
    return project
  }
  patchProject(id: string, patch: Partial<Project>): Project {
    const previous = this.project(id)
    const project = { ...previous, ...patch, id, createdAt: previous.createdAt }
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE projects SET path = ?, data = ? WHERE id = ?')
        .run(project.path, JSON.stringify(project), id)
      if (project.path !== previous.path) {
        // Existing native sessions retain their original cwd. Only unused workspaces relocate.
        for (const workspace of this.workspaces(id)) {
          const used = this.db
            .prepare(
              "SELECT 1 FROM sessions WHERE project_id = ? AND json_extract(data, '$.workspaceId') = ? AND json_extract(data, '$.nativeId') IS NOT NULL LIMIT 1",
            )
            .get(id, workspace.id)
          if (workspace.kind === 'shared' && !used)
            this.addWorkspace({ ...workspace, cwd: project.path })
        }
      }
    })()
    return project
  }
  removeProject(id: string): void {
    this.patchProject(id, { removedAt: Date.now() })
  }
  workspaces(projectId?: string): Workspace[] {
    const rows = (
      projectId
        ? this.db
            .prepare('SELECT data FROM workspaces WHERE project_id = ? ORDER BY rowid')
            .all(projectId)
        : this.db.prepare('SELECT data FROM workspaces ORDER BY rowid').all()
    ) as { data: string }[]
    return rows
      .map((row) => JSON.parse(row.data) as Workspace)
      .filter((workspace) => !workspace.deletedAt)
  }
  workspace(id: string): Workspace {
    const row = this.db.prepare('SELECT data FROM workspaces WHERE id = ?').get(id) as
      { data: string } | undefined
    if (!row) throw new Error('工作区不存在。')
    return JSON.parse(row.data)
  }
  addWorkspace(input: Workspace): Workspace {
    const project = this.project(input.projectId)
    if (project.removedAt) throw new Error('请先恢复项目，再添加工作区。')
    const previous = this.db
      .prepare('SELECT project_id FROM workspaces WHERE id = ?')
      .get(input.id) as { project_id: string } | undefined
    if (previous && previous.project_id !== input.projectId)
      throw new Error('工作区不能移动到其他项目。')
    this.db
      .prepare(
        'INSERT INTO workspaces VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
      )
      .run(input.id, input.projectId, JSON.stringify(input))
    return input
  }
  removeWorkspace(id: string): void {
    const workspace = this.workspace(id)
    this.db
      .prepare('UPDATE workspaces SET data = ? WHERE id = ?')
      .run(JSON.stringify({ ...workspace, deletedAt: Date.now() }), id)
  }
  sessions(options: SessionFilter = {}): Session[] {
    const projects = new Set(
      this.projects({ includeRemoved: options.includeRemoved }).map((project) => project.id),
    )
    return (
      this.db.prepare('SELECT data FROM sessions ORDER BY rowid DESC').all() as { data: string }[]
    )
      .map((r) => JSON.parse(r.data))
      .filter(
        (session: Session) =>
          projects.has(session.projectId) && (options.includeDeleted || !session.deletedAt),
      )
      .sort(
        (a: Session, b: Session) =>
          Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
          b.updatedAt - a.updatedAt ||
          b.id.localeCompare(a.id),
      )
  }
  searchSessions(query: string, options: SearchOptions = {}): SessionSearchResult[] {
    const normalized = query.trim().toLocaleLowerCase()
    const offset = Math.max(0, Math.trunc(options.offset ?? 0))
    const limit =
      options.limit === undefined ? -1 : Math.max(1, Math.min(500, Math.trunc(options.limit)))
    const needle = '%' + normalized.replace(/[\\%_]/g, (value) => '\\' + value) + '%'
    const trigram = [...normalized].length >= 3
    const matchQuery = !normalized
      ? '0'
      : trigram
        ? 'events_search MATCH ?'
        : "hub_lower(text) LIKE ? ESCAPE '\\'"
    const parameters: (number | string)[] = normalized
      ? [trigram ? `"${normalized.replaceAll('"', '""')}"` : needle]
      : []
    parameters.push(
      Number(Boolean(options.includeDeleted)),
      Number(Boolean(options.includeRemoved)),
      Number(!normalized),
      needle,
      needle,
      limit,
      offset,
    )
    const rows = this.db
      .prepare(
        `WITH matches AS MATERIALIZED (
      SELECT event_id, session_id, text FROM events_search WHERE ${matchQuery}
    ) SELECT s.data,
      (SELECT text FROM matches WHERE session_id = s.id LIMIT 1) AS text,
      (SELECT event_id FROM matches WHERE session_id = s.id LIMIT 1) AS event_id
      FROM sessions s JOIN projects p ON s.project_id = p.id
      WHERE (? OR json_extract(s.data, '$.deletedAt') IS NULL)
        AND (? OR json_extract(p.data, '$.removedAt') IS NULL)
        AND (? OR s.id IN (SELECT session_id FROM matches)
          OR hub_lower(json_extract(s.data, '$.title')) LIKE ? ESCAPE '\\'
          OR hub_lower(json_extract(p.data, '$.name')) LIKE ? ESCAPE '\\')
      ORDER BY COALESCE(json_extract(s.data, '$.pinned'), 0) DESC,
        json_extract(s.data, '$.updatedAt') DESC, s.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...parameters) as { data: string; text: string | null; event_id: string | null }[]
    return rows.map((row) => {
      const session = JSON.parse(row.data) as Session
      if (!normalized) return session
      const text = row.text ?? session.title
      const index = Math.max(0, text.toLocaleLowerCase().indexOf(normalized))
      const start = Math.max(0, index - 48)
      return {
        ...session,
        snippet: `${start ? '…' : ''}${text.slice(start, start + 180)}${text.length > start + 180 ? '…' : ''}`,
        matchEventId: row.event_id ?? undefined,
      }
    })
  }
  session(id: string): Session {
    const row = this.db.prepare('SELECT data FROM sessions WHERE id = ?').get(id) as
      { data: string } | undefined
    if (!row) throw new Error('会话不存在。')
    return JSON.parse(row.data)
  }
  createSession(
    projectId: string,
    provider: ProviderId,
    model?: string,
    workspaceId = projectId,
  ): Session {
    const project = this.project(projectId)
    const workspace = this.workspace(workspaceId)
    if (project.removedAt || workspace.deletedAt || workspace.projectId !== projectId)
      throw new Error('会话需要此项目中可用的工作区。')
    const now = Date.now()
    const session: Session = {
      id: randomUUID(),
      projectId,
      workspaceId,
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
    const previous = this.session(id)
    const session = {
      ...previous,
      ...patch,
      id,
      projectId: previous.projectId,
      workspaceId: previous.workspaceId,
      provider: previous.provider,
      createdAt: previous.createdAt,
      updatedAt: Object.keys(patch).every((key) => key === 'readAt')
        ? previous.updatedAt
        : Date.now(),
    }
    this.db.prepare('UPDATE sessions SET data = ? WHERE id = ?').run(JSON.stringify(session), id)
    return session
  }
  view(id: string, options: SessionPage = {}): SessionView {
    if (
      [options.before, options.after, options.aroundEventId].filter((value) => value !== undefined)
        .length > 1
    )
      throw new Error('历史分页只能指定一个定位边界。')
    const session = this.session(id)
    const paged =
      options.limit !== undefined ||
      options.before !== undefined ||
      options.after !== undefined ||
      options.aroundEventId !== undefined
    const limit = Math.max(1, Math.min(1000, Math.trunc(options.limit ?? 100)))
    type Row = { data: string; ordinal: number }
    const older = (before: number, count: number) =>
      this.db
        .prepare(
          'SELECT data, ordinal FROM events WHERE session_id = ? AND ordinal < ? ORDER BY ordinal DESC LIMIT ?',
        )
        .all(id, before, count) as Row[]
    const newer = (after: number, count: number, inclusive = false) =>
      this.db
        .prepare(
          `SELECT data, ordinal FROM events WHERE session_id = ? AND ordinal ${inclusive ? '>=' : '>'} ? ORDER BY ordinal LIMIT ?`,
        )
        .all(id, after, count) as Row[]
    const anchor =
      options.aroundEventId === undefined
        ? undefined
        : (this.db
            .prepare('SELECT ordinal FROM events WHERE id = ? AND session_id = ?')
            .get(options.aroundEventId, id) as { ordinal: number } | undefined)
    let page: Row[]
    if (!paged)
      page = this.db
        .prepare('SELECT data, ordinal FROM events WHERE session_id = ? ORDER BY ordinal')
        .all(id) as Row[]
    else if (anchor) {
      let leading = older(anchor.ordinal, Math.floor(limit / 2))
      const trailing = newer(anchor.ordinal, limit - leading.length, true)
      if (leading.length + trailing.length < limit)
        leading = older(anchor.ordinal, limit - trailing.length)
      page = [...leading.reverse(), ...trailing]
    } else if (options.after !== undefined) page = newer(options.after, limit)
    else page = older(options.before ?? Number.MAX_SAFE_INTEGER, limit).reverse()
    const before = page[0]?.ordinal
    const after = page.at(-1)?.ordinal
    const exists = (operator: '<' | '>', boundary: number | undefined) =>
      boundary !== undefined &&
      Boolean(
        this.db
          .prepare(`SELECT 1 FROM events WHERE session_id = ? AND ordinal ${operator} ? LIMIT 1`)
          .get(id, boundary),
      )
    return {
      session,
      cursor: this.sequence,
      events: page.map((row) => JSON.parse(row.data)),
      before,
      after,
      hasMore: paged && exists('<', before),
      hasNewer: paged && exists('>', after),
      anchorFound: options.aroundEventId === undefined ? undefined : Boolean(anchor),
    }
  }
  getDraft(sessionId: string): ComposerDraft {
    this.session(sessionId)
    const row = this.db
      .prepare('SELECT data FROM composer_drafts WHERE session_id = ?')
      .get(sessionId) as { data: string } | undefined
    return row ? JSON.parse(row.data) : { text: '', context: [], updatedAt: 0 }
  }
  saveDraft(sessionId: string, draft: ComposerDraft): ComposerDraft {
    this.session(sessionId)
    const previous = this.getDraft(sessionId)
    if (previous.updatedAt > draft.updatedAt) return previous
    this.db
      .prepare(
        'INSERT INTO composer_drafts VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET data = excluded.data',
      )
      .run(sessionId, JSON.stringify(draft))
    return draft
  }
  getEditorState(workspaceId: string): EditorState {
    this.workspace(workspaceId)
    const row = this.db
      .prepare('SELECT data FROM editor_states WHERE workspace_id = ?')
      .get(workspaceId) as { data: string } | undefined
    return row ? JSON.parse(row.data) : { files: [], active: '', mode: 'files', updatedAt: 0 }
  }
  saveEditorState(workspaceId: string, state: EditorState): EditorState {
    this.workspace(workspaceId)
    const previous = this.getEditorState(workspaceId)
    if (previous.updatedAt > state.updatedAt) return previous
    this.db
      .prepare(
        'INSERT INTO editor_states VALUES (?, ?) ON CONFLICT(workspace_id) DO UPDATE SET data = excluded.data',
      )
      .run(workspaceId, JSON.stringify(state))
    return state
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
          output: event.output ?? previous.output,
          outputRef: event.outputRef ?? previous.outputRef,
          outputBytes: event.outputBytes ?? previous.outputBytes,
          outputTruncated: event.outputTruncated ?? previous.outputTruncated,
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
      if (event.kind === 'error' && currentTurn && !ACTIVE_STATUSES.includes(session.status))
        this.patchSession(session.id, { status: 'error' })
      if (event.kind === 'requestResolved')
        this.resolveRequests(session.id, event.requestId, event.turnId, {
          decision: event.decision,
          resolution: event.resolution,
          scope: event.scope,
          answers: event.answers,
        })
      if (event.kind === 'done') {
        this.resolveRequests(session.id, undefined, event.turnId, {
          resolution: event.status === 'interrupted' ? 'cancelled' : 'expired',
        })
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
  resolveRequests(
    sessionId: string,
    requestId?: string,
    turnId?: string,
    result: Pick<AgentEvent, 'decision' | 'resolution' | 'scope' | 'answers'> = {},
  ): void {
    const rows = this.db
      .prepare(
        "SELECT data FROM events WHERE session_id = ? AND json_extract(data, '$.kind') IN ('approval', 'question')",
      )
      .all(sessionId) as { data: string }[]
    for (const row of rows) {
      const event = JSON.parse(row.data) as AgentEvent
      if (
        (event.kind === 'approval' || event.kind === 'question') &&
        event.state !== 'completed' &&
        (!requestId || event.requestId === requestId) &&
        (!turnId || event.turnId === turnId)
      ) {
        this.db.prepare('UPDATE events SET data = ? WHERE id = ?').run(
          JSON.stringify({
            ...event,
            ...result,
            state: result.resolution === 'failed' ? 'error' : 'completed',
          }),
          event.id,
        )
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
  listBackups(): BackupInfo[] {
    return listDatabaseBackups(this.path)
  }
  createBackup(): BackupInfo {
    return snapshotDatabase(this.db, this.path, 'manual')
  }
  verifyBackup(id: string): BackupInfo {
    verifiedBackupPath(this.path, id)
    const backup = this.listBackups().find((item) => item.id === id)
    if (!backup) throw new Error('备份不存在。')
    return backup
  }
  restoreBackup(id: string): BackupInfo | undefined {
    if (
      this.sessions({ includeDeleted: true, includeRemoved: true }).some((session) =>
        ACTIVE_STATUSES.includes(session.status),
      )
    )
      throw new Error('请先停止所有运行中的任务，再恢复备份。')
    const source = verifiedBackupPath(this.path, id)
    this.restoreWarning = undefined
    let beforeRestore: BackupInfo | undefined
    try {
      beforeRestore = snapshotDatabase(this.db, this.path, 'before-restore')
    } catch (error) {
      if (!(error instanceof OutputAttachmentError)) throw error
      const archive = archiveDamagedOutputs(this.db, this.path)
      this.restoreWarning = `当前工具输出存在缺失或损坏；原数据库与仍可读取的输出已保存在 ${archive}，此归档不能作为完整备份恢复。`
    }
    const checkpoint = this.db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[]
    if (checkpoint.some((result) => result.busy))
      throw new Error('数据库仍被其他操作占用，请稍后重试恢复。')
    this.db.close()
    let replacement: ReturnType<typeof replaceDatabase> | undefined
    try {
      replacement = replaceDatabase(this.path, source)
      this.db = openDatabase(this.path)
      this.recoverInterrupted()
      replacement.commit()
      this.sequence = Math.max(this.sequence + 1, Date.now() * 1000)
      return beforeRestore
    } catch (error) {
      if (this.db.open) this.db.close()
      replacement?.rollback()
      this.db = openDatabase(this.path)
      throw error
    }
  }
  storageInfo(): StorageInfo {
    const backups = this.listBackups()
    const size = (path: string): number => (existsSync(path) ? statSync(path).size : 0)
    const count = (table: string): number =>
      (this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
    return {
      databaseBytes:
        size(this.path) +
        size(`${this.path}-wal`) +
        size(`${this.path}-shm`) +
        outputStorageBytes(join(dirname(this.path), 'outputs')),
      backupBytes: backups.reduce((sum, backup) => sum + backup.bytes, 0),
      backups: backups.length,
      projects: count('projects'),
      sessions: count('sessions'),
      events: count('events'),
      schemaVersion: SCHEMA_VERSION,
    }
  }
  private runDailyBackup(): void {
    try {
      this.createDailyBackup()
      this.backupError = undefined
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('自动备份失败。')
      this.backupError = failure.message
      this.onBackupError?.(failure)
    }
  }
  private createDailyBackup(): void {
    const day = (timestamp: number): string => {
      const date = new Date(timestamp)
      return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
    }
    const daily = this.listBackups().filter((backup) => backup.reason === 'daily')
    if (
      !daily.some((backup) => {
        if (day(backup.createdAt) !== day(Date.now())) return false
        try {
          verifiedBackupPath(this.path, backup.id)
          return true
        } catch {
          return false
        }
      })
    )
      snapshotDatabase(this.db, this.path, 'daily')
    for (const backup of this.listBackups()
      .filter((item) => item.reason === 'daily')
      .slice(7)) {
      const location = join(backupDirectory(this.path), backup.id)
      rmSync(location, { force: true })
      rmSync(`${location}.outputs`, { force: true, recursive: true })
    }
  }
  close(): void {
    if (this.dailyTimer) clearInterval(this.dailyTimer)
    this.dailyTimer = undefined
    this.db.close()
  }
}
