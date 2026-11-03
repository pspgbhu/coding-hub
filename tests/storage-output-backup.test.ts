import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { Store } from '../src/main/store'
import { OutputStore } from '../src/main/output-store'
import { backupDirectory, replaceDatabase, verifiedBackupPath } from '../src/main/storage'

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  renameSync: vi.fn((await importOriginal<typeof import('node:fs')>()).renameSync),
}))
const locations: string[] = []
const stores: Store[] = []
function setup() {
  const directory = fs.mkdtempSync(join(tmpdir(), 'hub-output-backup-'))
  locations.push(directory)
  const path = join(directory, 'hub.db')
  const store = new Store(path)
  stores.push(store)
  const project = store.addProject(join(directory, 'project'), 'project')
  const session = store.createSession(project.id, 'codex')
  const outputs = new OutputStore(directory)
  const text = '长输出和中文\n'.repeat(18000)
  const event = outputs.ingest({
    id: randomUUID(),
    sessionId: session.id,
    turnId: randomUUID(),
    itemId: 'tool',
    kind: 'tool',
    timestamp: Date.now(),
    state: 'completed',
    output: text,
  })
  store.append(event)
  return {
    directory,
    path,
    store,
    outputs,
    event,
    text,
    file: join(directory, 'outputs', event.outputRef! + '.txt'),
  }
}
function close(store: Store) {
  store.close()
  stores.splice(stores.indexOf(store), 1)
}
afterEach(async () => {
  vi.restoreAllMocks()
  const real = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.mocked(fs.renameSync).mockImplementation(real.renameSync)
  for (const store of stores.splice(0)) if (store.db.open) store.close()
  for (const directory of locations.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})

describe('database backups with complete output attachments', () => {
  it('snapshots committed output bytes and restores long output with its event', async () => {
    const { store, path, directory, outputs, event, text, file } = setup()
    fs.appendFileSync(file, 'not committed to the event')
    const backup = store.createBackup()
    const location = join(backupDirectory(path), backup.id)
    expect(fs.readFileSync(join(location + '.outputs', event.outputRef! + '.txt'), 'utf8')).toBe(
      text,
    )
    expect(backup.bytes).toBe(fs.statSync(location).size + Buffer.byteLength(text))
    expect(store.listBackups().find((item) => item.id === backup.id)?.bytes).toBe(backup.bytes)
    fs.writeFileSync(file, 'later replacement\n'.repeat(50000))
    fs.writeFileSync(join(directory, 'outputs', 'unrelated.txt'), 'later output')
    store.restoreBackup(backup.id)
    expect(fs.readFileSync(file, 'utf8')).toBe(text)
    expect(fs.existsSync(join(directory, 'outputs', 'unrelated.txt'))).toBe(false)
    expect(store.view(event.sessionId).events.find((item) => item.id === event.id)?.outputRef).toBe(
      event.outputRef,
    )
    let result = '',
      offset = 0
    for (;;) {
      const page = await outputs.read(event.outputRef!, offset)
      result += page.text
      offset = page.nextOffset
      if (!page.hasMore) break
    }
    expect(result).toBe(text)
  })

  it('rejects missing or short attachments before touching current data', () => {
    const { store, path, event, file } = setup()
    const backup = store.createBackup()
    const asset = join(backupDirectory(path), backup.id + '.outputs', event.outputRef! + '.txt')
    const current = fs.readFileSync(file)
    fs.writeFileSync(asset, 'short')
    expect(() => verifiedBackupPath(path, backup.id)).toThrow('备份验证失败')
    expect(() => store.restoreBackup(backup.id)).toThrow('备份验证失败')
    expect(fs.readFileSync(file)).toEqual(current)
    fs.rmSync(asset)
    expect(() => store.verifyBackup(backup.id)).toThrow('备份验证失败')
  })

  it('refuses a failed snapshot and publishes no partial backup manifest or assets', () => {
    const { store, file } = setup()
    fs.rmSync(file)
    const before = store.listBackups().map((backup) => backup.id)
    expect(() => store.createBackup()).toThrow()
    expect(store.listBackups().map((backup) => backup.id)).toEqual(before)
  })

  it('does not delete an original when the first DB rename fails', async () => {
    const { store, path, file } = setup()
    const backup = store.createBackup()
    close(store)
    const beforeDB = fs.readFileSync(path),
      beforeOutput = fs.readFileSync(file)
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (String(from) === path) throw new Error('first rename failure')
      return actual.renameSync(from, to)
    })
    expect(() => replaceDatabase(path, join(backupDirectory(path), backup.id))).toThrow(
      'first rename failure',
    )
    expect(fs.readFileSync(path)).toEqual(beforeDB)
    expect(fs.readFileSync(file)).toEqual(beforeOutput)
  })

  it('rolls back the DB and output directory when attachment installation fails', async () => {
    const { store, path, directory, file } = setup()
    const backup = store.createBackup()
    fs.writeFileSync(file, 'current output')
    close(store)
    const beforeDB = fs.readFileSync(path),
      beforeOutput = fs.readFileSync(file)
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (String(from).includes('outputs.restore-') && String(to) === join(directory, 'outputs'))
        throw new Error('asset rename failure')
      return actual.renameSync(from, to)
    })
    expect(() => replaceDatabase(path, join(backupDirectory(path), backup.id))).toThrow(
      'asset rename failure',
    )
    expect(fs.readFileSync(path)).toEqual(beforeDB)
    expect(fs.readFileSync(file)).toEqual(beforeOutput)
  })

  it('rolls back an initially empty damaged-DB recovery including newly created WAL/SHM', () => {
    const { store, path, directory } = setup()
    const backup = store.createBackup()
    close(store)
    fs.rmSync(path)
    fs.rmSync(join(directory, 'outputs'), { recursive: true })
    const replacement = replaceDatabase(path, join(backupDirectory(path), backup.id))
    fs.writeFileSync(path + '-wal', 'new WAL')
    fs.writeFileSync(path + '-shm', 'new SHM')
    replacement.rollback()
    expect(fs.existsSync(path)).toBe(false)
    expect(fs.existsSync(path + '-wal')).toBe(false)
    expect(fs.existsSync(path + '-shm')).toBe(false)
    expect(fs.existsSync(join(directory, 'outputs'))).toBe(false)
  })

  it('supports old backups without output references and refuses path-like references', () => {
    const { store, path, event, file } = setup()
    store.db.prepare('DELETE FROM events').run()
    const backup = store.createBackup()
    fs.rmSync(join(backupDirectory(path), backup.id + '.outputs'), { recursive: true })
    expect(verifiedBackupPath(path, backup.id)).toContain(backup.id)
    store.restoreBackup(backup.id)
    expect(fs.existsSync(file)).toBe(false)
    store.append({ ...event, id: randomUUID(), outputRef: '../private' })
    expect(() => store.createBackup()).toThrow('无效的工具输出引用')
  })

  it.each(['short', 'missing', 'invalid'] as const)(
    'preserves a damaged %s current output before restoring a valid backup',
    (damage) => {
      const { store, path, directory, file, event, text } = setup()
      const backup = store.createBackup()
      if (damage === 'short') fs.writeFileSync(file, 'remaining bytes')
      else if (damage === 'missing') fs.rmSync(file)
      else {
        store.db
          .prepare(
            "UPDATE events SET data = json_set(data, '$.outputRef', '../invalid') WHERE id=?",
          )
          .run(event.id)
      }
      const extraName = 'a'.repeat(64) + '.txt'
      fs.writeFileSync(join(directory, 'outputs', extraName), 'unreferenced original bytes')
      store.append({
        id: randomUUID(),
        sessionId: event.sessionId,
        turnId: randomUUID(),
        kind: 'text',
        timestamp: Date.now(),
        text: 'current DB evidence',
      })
      expect(store.restoreBackup(backup.id)).toBeUndefined()
      const archiveName = fs
        .readdirSync(directory)
        .find((name) => name.startsWith('.damaged-restore-') && !name.endsWith('.tmp'))!
      expect(archiveName).toBeTruthy()
      const archive = join(directory, archiveName)
      expect(store.restoreWarning).toContain(archive)
      expect(store.listBackups().every((item) => !item.id.includes('damaged-restore'))).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).toBe(text)
      expect(fs.readFileSync(join(archive, 'outputs', extraName), 'utf8')).toBe(
        'unreferenced original bytes',
      )
      if (damage === 'short')
        expect(fs.readFileSync(join(archive, 'outputs', event.outputRef! + '.txt'), 'utf8')).toBe(
          'remaining bytes',
        )
      const manifest = JSON.parse(fs.readFileSync(join(archive, 'manifest.json'), 'utf8'))
      expect(manifest.restorableBackup).toBe(false)
      expect(manifest.outputs[0].status).toBe(damage)
      const original = new Database(join(archive, 'coding-hub.db'), { readonly: true })
      try {
        expect(
          original
            .prepare(
              "SELECT 1 FROM events WHERE json_extract(data, '$.text')='current DB evidence'",
            )
            .get(),
        ).toBeTruthy()
      } finally {
        original.close()
      }
      expect(
        store.view(event.sessionId).events.some((item) => item.text === 'current DB evidence'),
      ).toBe(false)
      expect(fs.existsSync(path)).toBe(true)
    },
  )

  it('refuses recovery when preserving the damaged current data fails', async () => {
    const { store, path, directory, file } = setup()
    const backup = store.createBackup()
    fs.writeFileSync(file, 'remaining original bytes')
    const beforeDB = store.db.prepare('SELECT data FROM events').all()
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (String(to).includes('.damaged-restore-') && !String(to).endsWith('.tmp'))
        throw new Error('archive publish failed')
      return actual.renameSync(from, to)
    })
    expect(() => store.restoreBackup(backup.id)).toThrow('archive publish failed')
    expect(store.db.prepare('SELECT data FROM events').all()).toEqual(beforeDB)
    expect(fs.readFileSync(file, 'utf8')).toBe('remaining original bytes')
    expect(fs.readdirSync(directory).some((name) => name.startsWith('.damaged-restore-'))).toBe(
      false,
    )
    expect(fs.existsSync(path)).toBe(true)
  })

  it('does not treat ordinary backup write failures as damaged attachments', async () => {
    const { store, path, directory, file } = setup()
    const backup = store.createBackup()
    const before = fs.readFileSync(file)
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (String(to).includes('-before-restore-') && String(to).endsWith('.sqlite'))
        throw new Error('disk write failed')
      return actual.renameSync(from, to)
    })
    expect(() => store.restoreBackup(backup.id)).toThrow('disk write failed')
    expect(fs.readFileSync(file)).toEqual(before)
    expect(fs.readdirSync(directory).some((name) => name.startsWith('.damaged-restore-'))).toBe(
      false,
    )
    expect(fs.existsSync(path)).toBe(true)
  })
})
