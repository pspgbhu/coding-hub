import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Stats } from 'node:fs'
import type { BackupInfo, Project, Session, Workspace } from '../shared/types'

export const SCHEMA_VERSION = 2
type BackupReason = BackupInfo['reason']
const backupPattern = /^(\d+)-(manual|daily|migration|before-restore)-([a-f\d-]+)\.sqlite$/
const outputPattern = /^[a-f\d]{64}$/
type OutputReference = { ref: string; bytes: number }

/** Only source attachment defects may use the damaged-data archival recovery path. */
export class OutputAttachmentError extends Error {}

function attachmentStat(path: string): Stats {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new OutputAttachmentError('工具输出附件缺失。')
    throw error
  }
}

function outputReferences(db: Database.Database): OutputReference[] {
  const references = new Map<string, number>()
  for (const row of db
    .prepare("SELECT data FROM events WHERE json_type(data, '$.outputRef') IS NOT NULL")
    .iterate() as Iterable<{ data: string }>) {
    const event = JSON.parse(row.data) as { outputRef: unknown; outputBytes: unknown }
    if (
      typeof event.outputRef !== 'string' ||
      !outputPattern.test(event.outputRef) ||
      !Number.isSafeInteger(event.outputBytes) ||
      Number(event.outputBytes) < 0
    )
      throw new OutputAttachmentError('备份包含无效的工具输出引用或字节数。')
    references.set(
      event.outputRef,
      Math.max(references.get(event.outputRef) ?? 0, Number(event.outputBytes)),
    )
  }
  return [...references].map(([ref, bytes]) => ({ ref, bytes }))
}

/** Copy exactly the bytes committed in the SQLite snapshot, never a later appended tail. */
function copyOutputs(source: string, destination: string, references: OutputReference[]): number {
  if (references.length) {
    const directory = attachmentStat(source)
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new OutputAttachmentError('工具输出附件目录无效。')
  }
  mkdirSync(destination, { mode: 0o700 })
  let bytes = 0
  for (const reference of references) {
    const file = join(source, `${reference.ref}.txt`)
    const metadata = attachmentStat(file)
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new OutputAttachmentError('工具输出附件不是普通文件。')
    const input = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let output: number | undefined
    try {
      const opened = fstatSync(input)
      if (
        !opened.isFile() ||
        opened.ino !== metadata.ino ||
        opened.dev !== metadata.dev ||
        opened.size < reference.bytes
      )
        throw new OutputAttachmentError('工具输出附件缺失或不完整，无法创建或恢复备份。')
      output = openSync(join(destination, `${reference.ref}.txt`), 'wx', 0o600)
      const buffer = Buffer.alloc(Math.min(64 * 1024, reference.bytes))
      let position = 0
      while (position < reference.bytes) {
        const length = readSync(
          input,
          buffer,
          0,
          Math.min(buffer.length, reference.bytes - position),
          position,
        )
        if (!length) throw new OutputAttachmentError('工具输出附件读取不完整。')
        let written = 0
        while (written < length) {
          const count = writeSync(output, buffer, written, length - written, position + written)
          if (count <= 0) throw new Error('无法完整保存工具输出附件。')
          written += count
        }
        position += length
      }
      fsyncSync(output)
      bytes += reference.bytes
    } finally {
      closeSync(input)
      if (output !== undefined) closeSync(output)
    }
  }
  return bytes
}

function verifyOutputs(source: string, references: OutputReference[]): void {
  if (references.length) {
    const directory = lstatSync(source)
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error('工具输出附件目录无效。')
  }
  for (const reference of references) {
    const file = join(source, `${reference.ref}.txt`)
    const metadata = lstatSync(file)
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error('工具输出附件不是普通文件。')
    const input = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = fstatSync(input)
      if (
        !opened.isFile() ||
        opened.ino !== metadata.ino ||
        opened.dev !== metadata.dev ||
        opened.size < reference.bytes
      )
        throw new Error('工具输出附件缺失或不完整。')
    } finally {
      closeSync(input)
    }
  }
}

export function outputStorageBytes(path: string): number {
  if (!existsSync(path)) return 0
  const directory = lstatSync(path)
  if (!directory.isDirectory() || directory.isSymbolicLink()) return 0
  return readdirSync(path).reduce((total, file) => {
    const stat = lstatSync(join(path, file))
    return total + (stat.isFile() && !stat.isSymbolicLink() ? stat.size : 0)
  }, 0)
}

export function backupDirectory(path: string): string {
  return join(dirname(path), `${basename(path)}.backups`)
}

/** Validate without changing a database, including databases produced by older versions. */
export function checkDatabase(db: Database.Database): number {
  const version = Number(db.pragma('user_version', { simple: true }))
  if (version > SCHEMA_VERSION)
    throw new Error('数据由更新版本的 Coding Hub 创建，请升级应用后打开，原数据未更改。')
  if (version < 1) throw new Error('不是有效的 Coding Hub 数据备份。')
  if (db.pragma('integrity_check', { simple: true }) !== 'ok')
    throw new Error('数据库完整性检查失败。请保留原文件并从已验证的备份恢复。')
  if ((db.pragma('foreign_key_check') as unknown[]).length)
    throw new Error('数据库关联检查失败，原数据未更改。')
  const tables = ['projects', 'sessions', 'events', 'settings']
  if (version >= 2) tables.push('workspaces', 'composer_drafts', 'editor_states')
  for (const table of tables) {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table)
    if (!exists) throw new Error('备份缺少必要的数据表，无法恢复。')
    const invalid = db.prepare(`SELECT 1 FROM ${table} WHERE NOT json_valid(data) LIMIT 1`).get()
    if (invalid) throw new Error('数据库包含损坏的记录，原数据未更改。')
    // JSON scalar values are valid JSON but are not valid persisted records.
    if (db.prepare(`SELECT 1 FROM ${table} WHERE json_type(data) <> 'object' LIMIT 1`).get())
      throw new Error('数据库包含无效的记录，原数据未更改。')
  }
  const invalidRecord = (table: string, predicate: string): boolean =>
    Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE ${predicate} LIMIT 1`).get())
  const missingText = (name: string): string => `json_type(data, '$.${name}') IS NOT 'text'`
  const invalidIdentity = (key: string, column: string): string =>
    `${missingText(key)} OR json_extract(data, '$.${key}') IS NOT ${column}`
  if (
    invalidRecord(
      'projects',
      `${invalidIdentity('id', 'id')} OR ${missingText('path')} OR ${missingText('name')}`,
    ) ||
    invalidRecord(
      'sessions',
      `${invalidIdentity('id', 'id')} OR ${invalidIdentity('projectId', 'project_id')} OR ${missingText('title')} OR ${missingText('status')} OR ${missingText('provider')}`,
    ) ||
    invalidRecord(
      'events',
      `${invalidIdentity('id', 'id')} OR ${invalidIdentity('sessionId', 'session_id')} OR ${missingText('turnId')} OR ${missingText('kind')}`,
    )
  )
    throw new Error('数据库记录缺少必要字段或身份不一致，原数据未更改。')
  if (
    version >= 2 &&
    (invalidRecord(
      'workspaces',
      `${invalidIdentity('id', 'id')} OR ${invalidIdentity('projectId', 'project_id')} OR ${missingText('cwd')} OR ${missingText('kind')}`,
    ) ||
      invalidRecord(
        'composer_drafts',
        `${missingText('text')} OR json_type(data, '$.context') IS NOT 'array'`,
      ) ||
      invalidRecord(
        'editor_states',
        `${missingText('active')} OR json_type(data, '$.files') IS NOT 'array'`,
      ))
  )
    throw new Error('工作区或草稿记录损坏，原数据未更改。')
  if (version >= 2) {
    if (
      !db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events_search'")
        .get()
    )
      throw new Error('数据库搜索索引缺失，原数据未更改。')
    if (
      db
        .prepare(
          "SELECT 1 FROM sessions s LEFT JOIN workspaces w ON w.id = json_extract(s.data, '$.workspaceId') WHERE w.id IS NULL OR w.project_id <> s.project_id LIMIT 1",
        )
        .get()
    )
      throw new Error('会话工作区关联损坏，原数据未更改。')
  }
  return version
}

export function listDatabaseBackups(path: string): BackupInfo[] {
  const directory = backupDirectory(path)
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .flatMap((id): BackupInfo[] => {
      const match = backupPattern.exec(id)
      if (!match) return []
      const location = join(directory, id)
      const stat = statSync(location)
      if (!stat.isFile()) return []
      let schemaVersion = 0
      let db: Database.Database | undefined
      try {
        db = new Database(location, { readonly: true, fileMustExist: true })
        schemaVersion = Number(db.pragma('user_version', { simple: true }))
      } catch {
        // Keep a damaged backup visible; validation on restore explains the problem.
      } finally {
        db?.close()
      }
      return [
        {
          id,
          createdAt: Number(match[1]),
          bytes: stat.size + outputStorageBytes(`${location}.outputs`),
          schemaVersion,
          reason: match[2] as BackupReason,
        },
      ]
    })
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
}

export function snapshotDatabase(
  db: Database.Database,
  path: string,
  reason: BackupReason,
): BackupInfo {
  checkDatabase(db)
  const directory = backupDirectory(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const createdAt = Date.now()
  const id = `${createdAt}-${reason}-${randomUUID()}.sqlite`
  const destination = join(directory, id)
  const temporary = `${destination}.tmp`
  const temporaryOutputs = `${destination}.outputs.tmp`
  try {
    // VACUUM INTO creates one transactionally consistent file, including committed WAL data.
    db.prepare('VACUUM INTO ?').run(temporary)
    chmodSync(temporary, 0o600)
    const backup = new Database(temporary, { readonly: true, fileMustExist: true })
    let schemaVersion: number
    let outputBytes: number
    try {
      schemaVersion = checkDatabase(backup)
      outputBytes = copyOutputs(
        join(dirname(path), 'outputs'),
        temporaryOutputs,
        outputReferences(backup),
      )
    } finally {
      backup.close()
    }
    // Publish the manifest last, so a listed backup always has its completed attachment directory.
    renameSync(temporaryOutputs, `${destination}.outputs`)
    renameSync(temporary, destination)
    return { id, createdAt, bytes: statSync(destination).size + outputBytes, schemaVersion, reason }
  } catch (error) {
    rmSync(destination, { force: true })
    rmSync(temporary, { force: true })
    rmSync(temporaryOutputs, { force: true, recursive: true })
    rmSync(`${destination}.outputs`, { force: true, recursive: true })
    throw error
  }
}

export function verifiedBackupPath(path: string, id: string): string {
  if (!backupPattern.test(id) || basename(id) !== id) throw new Error('无效的备份标识。')
  const location = join(backupDirectory(path), id)
  let backup: Database.Database | undefined
  try {
    backup = new Database(location, { readonly: true, fileMustExist: true })
    checkDatabase(backup)
    verifyOutputs(`${location}.outputs`, outputReferences(backup))
  } catch (error) {
    throw new Error(`备份验证失败：${error instanceof Error ? error.message : '无法读取文件'}`)
  } finally {
    backup?.close()
  }
  return location
}

/** Preserve a valid DB and every remaining ordinary output when its references are damaged.
 * This evidence archive is deliberately not a restorable backup and is never listed as one.
 */
export function archiveDamagedOutputs(db: Database.Database, path: string): string {
  checkDatabase(db)
  const destination = join(dirname(path), `.damaged-restore-${randomUUID()}`)
  const temporary = `${destination}.tmp`
  mkdirSync(temporary, { mode: 0o700 })
  try {
    const manifestPath = join(temporary, 'coding-hub.db')
    db.prepare('VACUUM INTO ?').run(manifestPath)
    chmodSync(manifestPath, 0o600)
    const snapshot = new Database(manifestPath, { readonly: true, fileMustExist: true })
    try {
      checkDatabase(snapshot)
      const source = join(dirname(path), 'outputs')
      let directory: Stats | undefined
      try {
        directory = lstatSync(source)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const ordinaryDirectory = directory?.isDirectory() && !directory.isSymbolicLink()
      const references: OutputReference[] = []
      if (ordinaryDirectory)
        for (const name of readdirSync(source)) {
          if (!/^[a-f\d]{64}\.txt$/.test(name)) continue
          const stat = lstatSync(join(source, name))
          if (stat.isFile() && !stat.isSymbolicLink())
            references.push({ ref: name.slice(0, -4), bytes: stat.size })
        }
      copyOutputs(source, join(temporary, 'outputs'), references)
      const saved = new Map(references.map((reference) => [reference.ref, reference.bytes]))
      const outputs = [
        ...(snapshot
          .prepare("SELECT id,data FROM events WHERE json_type(data, '$.outputRef') IS NOT NULL")
          .iterate() as Iterable<{ id: string; data: string }>),
      ].map((row) => {
        const event = JSON.parse(row.data) as { outputRef: unknown; outputBytes: unknown }
        const validRef = typeof event.outputRef === 'string' && outputPattern.test(event.outputRef)
        const actualBytes = validRef ? saved.get(event.outputRef as string) : undefined
        const validSize = Number.isSafeInteger(event.outputBytes) && Number(event.outputBytes) >= 0
        return {
          eventId: row.id,
          outputRef: event.outputRef,
          expectedBytes: event.outputBytes,
          actualBytes,
          status:
            !validRef || !validSize
              ? 'invalid'
              : actualBytes === undefined
                ? 'missing'
                : actualBytes < Number(event.outputBytes)
                  ? 'short'
                  : 'preserved',
        }
      })
      const manifest = {
        kind: 'damaged-output-evidence',
        restorableBackup: false,
        createdAt: Date.now(),
        sourceDirectory: ordinaryDirectory ? 'ordinary' : directory ? 'invalid' : 'missing',
        outputs,
      }
      const handle = openSync(join(temporary, 'manifest.json'), 'wx', 0o600)
      try {
        writeFileSync(handle, JSON.stringify(manifest, null, 2))
        fsyncSync(handle)
      } finally {
        closeSync(handle)
      }
    } finally {
      snapshot.close()
    }
    renameSync(temporary, destination)
    return destination
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true })
    throw error
  }
}

export function openDatabase(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new Database(path)
  try {
    db.function('hub_lower', { deterministic: true }, (value: unknown) =>
      typeof value === 'string' ? value.toLocaleLowerCase() : '',
    )
    let version = Number(db.pragma('user_version', { simple: true }))
    if (version > SCHEMA_VERSION)
      throw new Error('数据由更新版本的 Coding Hub 创建，请升级应用后打开，原数据未更改。')
    if (version > 0) checkDatabase(db)
    else if (db.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get())
      throw new Error('数据库版本无法识别，原数据未更改。')
    if (version > 0 && version < SCHEMA_VERSION) snapshotDatabase(db, path, 'migration')
    db.pragma('foreign_keys = ON')
    db.transaction(() => {
      if (version < 1) {
        db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
          CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, data TEXT NOT NULL);
          CREATE TABLE events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, stream_key TEXT, ordinal INTEGER NOT NULL, data TEXT NOT NULL);
          CREATE INDEX events_session ON events(session_id, ordinal);
          CREATE INDEX events_stream ON events(stream_key);
          CREATE INDEX events_ordinal ON events(ordinal);
          CREATE TABLE settings (key TEXT PRIMARY KEY, data TEXT NOT NULL);
          PRAGMA user_version = 1;`)
        version = 1
      }
      if (version < 2) {
        db.exec(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, data TEXT NOT NULL);
          CREATE INDEX workspaces_project ON workspaces(project_id);
          CREATE TABLE composer_drafts (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, data TEXT NOT NULL);
          CREATE TABLE editor_states (workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE, data TEXT NOT NULL);
          CREATE VIRTUAL TABLE events_search USING fts5(event_id UNINDEXED, session_id UNINDEXED, text, tokenize='trigram');
          INSERT INTO events_search(rowid,event_id,session_id,text) SELECT rowid,id,session_id,json_extract(data,'$.text') FROM events WHERE json_type(data,'$.text') = 'text';
          CREATE TRIGGER events_search_insert AFTER INSERT ON events WHEN json_type(new.data,'$.text') = 'text' BEGIN
            INSERT INTO events_search(rowid,event_id,session_id,text) VALUES(new.rowid,new.id,new.session_id,json_extract(new.data,'$.text'));
          END;
          CREATE TRIGGER events_search_update AFTER UPDATE ON events BEGIN
            DELETE FROM events_search WHERE rowid=old.rowid;
            INSERT INTO events_search(rowid,event_id,session_id,text) SELECT new.rowid,new.id,new.session_id,json_extract(new.data,'$.text') WHERE json_type(new.data,'$.text') = 'text';
          END;
          CREATE TRIGGER events_search_delete AFTER DELETE ON events BEGIN
            DELETE FROM events_search WHERE rowid=old.rowid;
          END;`)
        const projects = db.prepare('SELECT data FROM projects').all() as { data: string }[]
        for (const row of projects) {
          const project = JSON.parse(row.data) as Project
          const workspace: Workspace = {
            id: project.id,
            projectId: project.id,
            kind: 'shared',
            cwd: project.path,
            name: '共享工作区',
            createdAt: project.createdAt,
          }
          db.prepare('INSERT INTO workspaces VALUES (?, ?, ?)').run(
            workspace.id,
            project.id,
            JSON.stringify(workspace),
          )
          db.prepare('UPDATE projects SET data = ? WHERE id = ?').run(
            JSON.stringify({ ...project, trusted: project.trusted ?? true }),
            project.id,
          )
        }
        for (const row of db.prepare('SELECT data FROM sessions').all() as { data: string }[]) {
          const session = JSON.parse(row.data) as Session
          db.prepare('UPDATE sessions SET data = ? WHERE id = ?').run(
            JSON.stringify({ ...session, workspaceId: session.workspaceId ?? session.projectId }),
            session.id,
          )
        }
        db.pragma('user_version = 2')
      }
      checkDatabase(db)
    })()
    db.pragma('journal_mode = WAL')
    chmodSync(path, 0o600)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

type Replacement = { rollback: () => void; commit: () => void }

function stageBackupOutputs(path: string, backup: string): string {
  const temporary = join(dirname(path), `outputs.restore-${randomUUID()}`)
  const copied = new Database(backup, { readonly: true, fileMustExist: true })
  try {
    checkDatabase(copied)
    copyOutputs(`${backup}.outputs`, temporary, outputReferences(copied))
    return temporary
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true })
    throw error
  } finally {
    copied.close()
  }
}

/** Install pre-staged files/directories together, retaining all originals until commit. */
function replacePaths(entries: { target: string; temporary?: string }[]): Replacement {
  const changes: {
    target: string
    previous: string
    existed: boolean
    moved: boolean
    installed: boolean
  }[] = []
  let settled = false
  const rollback = () => {
    if (settled) return
    const errors: unknown[] = []
    for (const change of [...changes].reverse()) {
      try {
        // Opening the replacement may have created fresh WAL/SHM files before failing.
        if (change.installed || change.moved || !change.existed)
          rmSync(change.target, { recursive: true, force: true })
        if (change.moved) renameSync(change.previous, change.target)
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length)
      throw new AggregateError(errors, '恢复回滚未完成，原资料保留在 rollback 文件中，请勿删除。')
    settled = true
  }
  try {
    for (const entry of entries) {
      const change = {
        target: entry.target,
        previous: `${entry.target}.rollback-${randomUUID()}`,
        existed: existsSync(entry.target),
        moved: false,
        installed: false,
      }
      changes.push(change)
      if (change.existed) {
        renameSync(entry.target, change.previous)
        change.moved = true
      }
      if (entry.temporary) {
        renameSync(entry.temporary, entry.target)
        change.installed = true
      }
    }
  } catch (error) {
    try {
      rollback()
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], '备份恢复失败，回滚资料已保留。')
    }
    throw error
  }
  return {
    rollback,
    commit: () => {
      if (settled) return
      settled = true
      // The replacement is already committed. Cleanup failure must never trigger an impossible rollback.
      for (const change of changes)
        if (change.moved) {
          try {
            rmSync(change.previous, { recursive: true, force: true })
          } catch {
            /* Retain the original rather than fail a committed restore. */
          }
        }
    },
  }
}

/** Restore attachments only; the caller can commit or roll back alongside its own DB recovery. */
export function restoreBackupAssets(path: string, backup: string): Replacement {
  const temporary = stageBackupOutputs(path, backup)
  try {
    return replacePaths([{ target: join(dirname(path), 'outputs'), temporary }])
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

/** The caller must close SQLite before replacing DB, WAL/SHM and output assets together. */
export function replaceDatabase(path: string, backup: string): Replacement {
  const temporary = `${path}.restore-${randomUUID()}`
  let temporaryOutputs: string | undefined
  try {
    copyFileSync(backup, temporary)
    chmodSync(temporary, 0o600)
    // Read attachments from the copied manifest, and close all handles before Windows renames.
    temporaryOutputs = stageBackupOutputs(path, backup)
    const copied = new Database(temporary, { readonly: true, fileMustExist: true })
    try {
      checkDatabase(copied)
    } finally {
      copied.close()
    }
    return replacePaths([
      { target: `${path}-wal` },
      { target: `${path}-shm` },
      { target: path, temporary },
      { target: join(dirname(path), 'outputs'), temporary: temporaryOutputs },
    ])
  } finally {
    rmSync(temporary, { force: true })
    if (temporaryOutputs) rmSync(temporaryOutputs, { recursive: true, force: true })
  }
}
