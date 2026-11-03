import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  mkdir,
  readFile,
  readdir,
  lstat,
  realpath,
  open,
  rename,
  unlink,
  readlink,
} from 'node:fs/promises'
import { join, relative, dirname, sep, isAbsolute } from 'node:path'
import type { TurnReview } from '../shared/types'
import { WorkspaceService } from './workspace'

const ignored = new Set([
  '.git',
  'node_modules',
  '.next',
  '.cache',
  'dist',
  'build',
  'coverage',
  'target',
  '.venv',
  'venv',
])
const sensitive = /^(\.env(?:\..*)?|\.npmrc|\.netrc|credentials(?:\..*)?|auth\.json)$/i
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
interface Entry {
  fingerprint: string
  mode: number
  text?: string
}
type ReviewFile = TurnReview['files'][number] & { beforeMode?: number; afterMode?: number }
interface Snapshot {
  review: TurnReview
  before: Record<string, string>
  seen: string[]
  root: string
  entries?: Record<string, Entry>
}

export class ReviewService {
  private readonly workspace = new WorkspaceService()
  private readonly operations = new Map<string, Promise<unknown>>()
  private async serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const pending = (this.operations.get(key) ?? Promise.resolve()).catch(() => {}).then(operation)
    this.operations.set(key, pending)
    try {
      return await pending
    } finally {
      if (this.operations.get(key) === pending) this.operations.delete(key)
    }
  }
  private async files(
    root: string,
  ): Promise<{ entries: Record<string, Entry>; warnings: string[] }> {
    const entries: Record<string, Entry> = Object.create(null)
    const warnings = new Set<string>()
    let bytes = 0
    let count = 0
    const walk = async (folder: string): Promise<void> => {
      const resolved = await realpath(folder)
      const scope = relative(root, resolved)
      if (scope === '..' || scope.startsWith(`..${sep}`) || isAbsolute(scope)) {
        warnings.add('捕获期间目录指向项目外，已跳过且不提供自动撤销。')
        return
      }
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (ignored.has(entry.name) || entry.name.startsWith('.coding-hub-save-')) continue
        const absolute = join(folder, entry.name)
        const path = relative(root, absolute).split(sep).join('/')
        let info
        try {
          info = await lstat(absolute)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw error
        }
        if (info.isSymbolicLink()) {
          entries[path] = {
            fingerprint: 'symlink:' + hash(await readlink(absolute)),
            mode: info.mode & 0o777,
          }
          continue
        }
        if (info.isDirectory()) {
          await walk(absolute)
          continue
        }
        if (!info.isFile()) continue
        entries[path] = {
          fingerprint: `stat:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`,
          mode: info.mode & 0o777,
        }
        if (sensitive.test(entry.name)) {
          warnings.add('敏感配置仅记录变更标识，不保存内容，也不提供自动撤销。')
          continue
        }
        if (count >= 5000 || bytes + info.size > 64 * 1024 * 1024) {
          warnings.add('快照达到容量限制，未捕获文件不提供自动撤销。')
          continue
        }
        if (info.size > 2 * 1024 * 1024) {
          warnings.add('超过 2 MB 的文件仅记录变更标识，不提供自动撤销。')
          continue
        }
        try {
          const physical = await realpath(absolute)
          const scope = relative(root, physical)
          if (scope === '..' || scope.startsWith(`..${sep}`) || isAbsolute(scope)) {
            warnings.add('捕获期间文件指向项目外，已跳过且不提供自动撤销。')
            continue
          }
          const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
          let buffer: Buffer
          try {
            const actual = await handle.stat()
            if (!actual.isFile() || actual.ino !== info.ino || actual.size > 2 * 1024 * 1024) {
              warnings.add('捕获期间发生变化的文件没有自动撤销能力，请手动比较。')
              continue
            }
            buffer = await handle.readFile()
          } finally {
            await handle.close()
          }
          const latest = await lstat(absolute)
          if (
            !latest.isFile() ||
            latest.ino !== info.ino ||
            latest.mtimeMs !== info.mtimeMs ||
            latest.size !== info.size
          ) {
            warnings.add('捕获期间发生变化的文件没有自动撤销能力，请手动比较。')
            continue
          }
          bytes += buffer.length
          count++
          entries[path].fingerprint = createHash('sha256').update(buffer).digest('hex')
          if (!buffer.includes(0)) {
            try {
              entries[path].text = new TextDecoder('utf-8', {
                fatal: true,
                ignoreBOM: true,
              }).decode(buffer)
            } catch {
              /* Fingerprints identify binary changes without retaining their contents. */
            }
          }
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
            (error as NodeJS.ErrnoException).code !== 'ELOOP'
          )
            throw error
          delete entries[path]
        }
      }
    }
    await walk(root)
    return { entries, warnings: [...warnings] }
  }
  private path(dataDir: string, sessionId: string, turnId: string): string {
    if (![sessionId, turnId].every((id) => /^[\da-f-]{36}$/.test(id)))
      throw new Error('无效回合标识。')
    return join(dataDir, 'reviews', sessionId, `${turnId}.json`)
  }
  private async persist(file: string, value: Snapshot): Promise<void> {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify(value))
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, file)
    } finally {
      await unlink(temporary).catch(() => {})
    }
  }
  async capture(
    root: string,
    dataDir: string,
    sessionId: string,
    workspaceId: string,
    turnId: string,
  ): Promise<void> {
    const canonical = await realpath(root)
    const snapshot = await this.files(canonical)
    const before: Record<string, string> = Object.create(null)
    for (const [path, entry] of Object.entries(snapshot.entries))
      if (entry.text !== undefined) before[path] = entry.text
    const entries = Object.fromEntries(
      Object.entries(snapshot.entries).map(([path, entry]) => [
        path,
        { fingerprint: entry.fingerprint, mode: entry.mode },
      ]),
    )
    const value: Snapshot = {
      root: canonical,
      before,
      seen: Object.keys(snapshot.entries),
      entries,
      review: {
        sessionId,
        workspaceId,
        turnId,
        startedAt: Date.now(),
        files: [],
        warnings: snapshot.warnings,
      },
    }
    await this.persist(this.path(dataDir, sessionId, turnId), value)
  }
  async finish(
    root: string,
    dataDir: string,
    sessionId: string,
    turnId: string,
  ): Promise<TurnReview | null> {
    const file = this.path(dataDir, sessionId, turnId)
    return this.serialize(file, async () => {
      let value: Snapshot
      try {
        value = JSON.parse(await readFile(file, 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw new Error('无法读取完整审阅基线，请保留本地数据并手动比较。')
      }
      if (value.review.finishedAt) return value.review
      if (value.root !== (await realpath(root))) throw new Error('会话目录与审阅基线不一致。')
      const current = await this.files(value.root)
      const baseline: Record<string, Entry> = Object.create(null)
      for (const path of value.seen)
        baseline[path] = {
          fingerprint:
            value.entries?.[path]?.fingerprint ??
            (Object.hasOwn(value.before, path) ? hash(value.before[path]) : 'uncaptured'),
          mode: value.entries?.[path]?.mode ?? 0o644,
          text: Object.hasOwn(value.before, path) ? value.before[path] : undefined,
        }
      value.review.finishedAt = Date.now()
      value.review.warnings = [...new Set([...value.review.warnings, ...current.warnings])]
      value.review.files = [...new Set([...Object.keys(baseline), ...Object.keys(current.entries)])]
        .sort()
        .flatMap((path): ReviewFile[] => {
          const before = baseline[path]
          const after = current.entries[path]
          if (before?.fingerprint === after?.fingerprint && before?.mode === after?.mode) return []
          return [
            {
              path,
              before: before?.text ?? null,
              after: after?.text ?? null,
              beforeFingerprint: before?.fingerprint ?? 'missing',
              afterFingerprint: after?.fingerprint ?? 'missing',
              beforeMode: before?.mode,
              afterMode: after?.mode,
              reviewable:
                (!before || before.text !== undefined) && (!after || after.text !== undefined),
            },
          ]
        })
      await this.persist(file, value)
      return value.review
    })
  }
  async get(dataDir: string, sessionId: string, turnId: string): Promise<TurnReview | null> {
    try {
      return (JSON.parse(await readFile(this.path(dataDir, sessionId, turnId), 'utf8')) as Snapshot)
        .review
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error('审阅数据已损坏，请保留数据并从备份恢复。')
    }
  }
  async revert(
    root: string,
    dataDir: string,
    sessionId: string,
    turnId: string,
    paths: string[],
    restoredReview?: TurnReview,
  ): Promise<void> {
    const canonical = await realpath(root)
    return this.serialize(`revert:${canonical}`, async () => {
      const review = restoredReview ?? (await this.get(dataDir, sessionId, turnId))
      if (!review?.finishedAt) throw new Error('本轮尚无可撤销的审阅结果。')
      if (review.sessionId !== sessionId || review.turnId !== turnId)
        throw new Error('审阅标识与会话不一致。')
      const selected = (review.files as ReviewFile[]).filter((file) => paths.includes(file.path))
      if (!selected.length || selected.length !== new Set(paths).size)
        throw new Error('请仅选择审阅列表中的文件。')
      if (selected.some((file) => !file.reviewable))
        throw new Error('所选文件没有完整文本快照，请使用外部工具比较，不能自动撤销。')
      if (selected.some((file) => sensitive.test(file.path.split('/').at(-1)!)))
        throw new Error('敏感路径不能自动撤销。')
      await this.workspace.restoreFiles(
        canonical,
        selected.map((file) => ({
          path: file.path,
          content: file.before,
          mode: file.beforeMode,
          expectedFingerprint: file.afterFingerprint,
          expectedMode: file.afterMode,
        })),
      )
      review.warnings = [
        ...new Set([...review.warnings, '已撤销选中文件；审阅仍保留原始前后快照。']),
      ]
      const file = this.path(dataDir, sessionId, turnId)
      let value: Snapshot
      try {
        value = JSON.parse(await readFile(file, 'utf8'))
        value.review = review
      } catch {
        value = { root: canonical, before: {}, seen: [], review }
      }
      await this.persist(file, value)
    })
  }
}
