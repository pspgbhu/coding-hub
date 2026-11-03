import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { FileContent, FileEntry, GitDiff, GitFile, GitStatus } from '../shared/types'
import { redactDiagnostics } from '../shared/diagnostics'
import { resolveCommand, runCommand, type CommandResult } from './process'

export const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_SEARCH_RESULTS = 500
const MAX_SEARCH_FILES = 20000
export interface WorkspaceIdentity {
  rootPath: string
  canonicalId: string
  repositoryId?: string
  gitDir?: string
  repositoryRoot?: string
  branch?: string
  hasHead: boolean
}
export interface SearchResult {
  path: string
  line?: number
  text?: string
}
export interface WorktreeComparison {
  base: string
  files: {
    path: string
    status: 'added' | 'modified' | 'deleted'
    baseFingerprint: string | null
    targetFingerprint: string | null
    sourceFingerprint: string | null
  }[]
  conflicts: { path: string; reason: string }[]
}
export interface WorktreeApplyResult {
  applied: string[]
  conflicts: { path: string; reason: string }[]
  rolledBack?: boolean
}
export interface RestoreFile {
  path: string
  content: string | null
  expectedFingerprint: string
  mode?: number
  expectedMode?: number
}
export interface GitCommit {
  hash: string
  shortHash: string
  subject: string
  author: string
  timestamp: number
}
export type WorkspaceGitAction =
  'stage' | 'unstage' | 'commit' | 'checkout' | 'createBranch' | 'fetch' | 'pull' | 'push'
type ExtendedGitStatus = GitStatus & {
  remote?: string
  upstream?: string
  ahead?: number
  behind?: number
  conflicts?: string[]
  indexFingerprint?: string
}
interface FileSnapshot {
  content: Buffer
  mode: number
}
const hiddenDirectories = new Set([
  '.git',
  'node_modules',
  '.pnpm',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  'coverage',
  'target',
])
const languages: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  mdx: 'markdown',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  cs: 'csharp',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  sql: 'sql',
  vue: 'html',
  svelte: 'html',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin',
}

export class WorkspaceError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_PATH'
      | 'OUTSIDE_PROJECT'
      | 'BINARY_FILE'
      | 'FILE_TOO_LARGE'
      | 'FILE_CONFLICT'
      | 'GIT_ERROR',
    message: string,
  ) {
    super(message)
    this.name = 'WorkspaceError'
  }
}

function normalizeRelative(value: string, allowRoot = false): string {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    /^[a-z]:/i.test(value) ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.split(/[\\/]/).some((part) => part === '..')
  ) {
    throw new WorkspaceError(
      'INVALID_PATH',
      'Please use a relative project path without .. segments',
    )
  }
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (!allowRoot && (!normalized || normalized === '.'))
    throw new WorkspaceError('INVALID_PATH', 'A file path is required')
  return normalized === '.' ? '' : normalized
}

function assertEditable(relative: string): void {
  if (relative.split(/[\\/]/).some((segment) => segment.toLowerCase() === '.git'))
    throw new WorkspaceError('INVALID_PATH', 'Git metadata cannot be edited through the workspace')
}

function assertEditableLocation(location: {
  root: string
  relative: string
  absolute: string
}): void {
  assertEditable(location.relative)
  assertEditable(path.relative(location.root, location.absolute))
}

async function rejectSymlinkPath(root: string, input: string): Promise<void> {
  const relative = normalizeRelative(input)
  let current = await fs.realpath(root)
  for (const segment of relative.split('/')) {
    current = path.join(current, segment)
    try {
      if ((await fs.lstat(current)).isSymbolicLink())
        throw new WorkspaceError('INVALID_PATH', 'Symlink changes require manual review')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

function canonicalHash(value: string): string {
  return createHash('sha256')
    .update(process.platform === 'win32' ? value.toLowerCase() : value)
    .digest('hex')
}

function snapshotFingerprint(value: FileSnapshot | null): string | null {
  return value ? fingerprint(value.content) : null
}

function sameSnapshot(a: FileSnapshot | null, b: FileSnapshot | null): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      (a.mode === b.mode || process.platform === 'win32') &&
      a.content.equals(b.content))
  )
}

function preserveTextFormat(content: string, current: Buffer): Buffer {
  const original = decodeText(current)
  const bom = original.startsWith('\uFEFF')
  let text = content.replace(/^\uFEFF/, '')
  const endings = original.match(/\r\n|\n|\r/g)
  if (endings?.length && endings.every((ending) => ending === endings[0]))
    text = text.replace(/\r\n|\n|\r/g, endings[0])
  const buffer = Buffer.from((bom || content.startsWith('\uFEFF') ? '\uFEFF' : '') + text, 'utf8')
  decodeText(buffer)
  return buffer
}

async function syncDirectory(directory: string): Promise<void> {
  // Directory fsync is unsupported on Windows. The file itself is always fsynced first.
  if (process.platform === 'win32') return
  const handle = await fs.open(directory, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(root, target)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new WorkspaceError('OUTSIDE_PROJECT', 'The path points outside this project')
  }
}

async function safePath(
  root: string,
  input: string,
  allowMissing = false,
  allowRoot = false,
): Promise<{ root: string; absolute: string; relative: string }> {
  const relative = normalizeRelative(input, allowRoot)
  const realRoot = await fs.realpath(root)
  const candidate = path.resolve(realRoot, relative)
  assertInside(realRoot, candidate)
  try {
    const absolute = await fs.realpath(candidate)
    assertInside(realRoot, absolute)
    return { root: realRoot, absolute, relative }
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // Deleted Git paths are valid, but every existing parent must remain inside the project.
    let parent = path.dirname(candidate)
    while (true) {
      try {
        const realParent = await fs.realpath(parent)
        assertInside(realRoot, realParent)
        const absolute = path.join(realParent, path.relative(parent, candidate))
        assertInside(realRoot, absolute)
        return { root: realRoot, absolute, relative }
      } catch (parentError) {
        if ((parentError as NodeJS.ErrnoException).code !== 'ENOENT') throw parentError
        const next = path.dirname(parent)
        if (next === parent) throw parentError
        parent = next
      }
    }
  }
}

function fingerprint(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function decodeText(buffer: Buffer): string {
  if (buffer.length > MAX_FILE_BYTES)
    throw new WorkspaceError(
      'FILE_TOO_LARGE',
      'Files larger than 2 MB cannot be opened in the editor',
    )
  if (buffer.includes(0))
    throw new WorkspaceError('BINARY_FILE', 'Binary files cannot be opened in the text editor')
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer)
  } catch {
    throw new WorkspaceError('BINARY_FILE', 'Only UTF-8 text files can be opened in the editor')
  }
}

function describe(relative: string, buffer: Buffer): FileContent {
  const name = path.basename(relative).toLowerCase()
  return {
    path: relative,
    content: decodeText(buffer),
    fingerprint: fingerprint(buffer),
    language:
      name === 'dockerfile'
        ? 'dockerfile'
        : name === 'makefile'
          ? 'makefile'
          : languages[path.extname(name).slice(1)] || 'plaintext',
  }
}

interface PorcelainFile extends GitFile {
  originalPath?: string
}

/** With -z Git writes rename destination first, followed by the source as a separate field. */
export function parsePorcelain(output: string): PorcelainFile[] {
  const fields = output.split('\0')
  const files: PorcelainFile[] = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    if (!field || field.length < 4) continue
    const file: PorcelainFile = { path: field.slice(3), index: field[0], working: field[1] }
    if (/[RC]/.test(file.index + file.working)) file.originalPath = fields[++i]
    files.push(file)
  }
  return files
}

export class WorkspaceService {
  private gitPath: Promise<string> | undefined
  private saves = new Map<string, Promise<unknown>>()

  private async serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.saves.get(key) || Promise.resolve()
    const pending = previous.catch(() => {}).then(operation)
    this.saves.set(key, pending)
    try {
      return await pending
    } finally {
      if (this.saves.get(key) === pending) this.saves.delete(key)
    }
  }

  private async snapshot(root: string, input: string): Promise<FileSnapshot | null> {
    const location = await safePath(root, input, true)
    try {
      const stat = await fs.lstat(location.absolute)
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new WorkspaceError('INVALID_PATH', 'Only regular files can be changed')
      if (stat.size > MAX_FILE_BYTES)
        throw new WorkspaceError('FILE_TOO_LARGE', 'Files larger than 2 MB cannot be changed')
      return {
        content: await fs.readFile(location.absolute),
        mode: stat.mode & 0o777,
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private async atomicWrite(
    root: string,
    input: string,
    next: FileSnapshot,
    expected: FileSnapshot | null,
  ): Promise<void> {
    const location = await safePath(root, input, !expected)
    assertEditableLocation(location)
    const temporary = path.join(path.dirname(location.absolute), `.coding-hub-save-${randomUUID()}`)
    const backup = `${temporary}.previous`
    let temporaryCreated = false
    let backupCreated = false
    let preserveBackup = false
    let committed = false
    try {
      const handle = await fs.open(temporary, 'wx', next.mode)
      temporaryCreated = true
      try {
        await handle.writeFile(next.content)
        await handle.chmod(next.mode)
        await handle.sync()
      } finally {
        await handle.close()
      }
      if (expected) {
        const previous = await fs.open(backup, 'wx', expected.mode)
        backupCreated = true
        try {
          await previous.writeFile(expected.content)
          await previous.chmod(expected.mode)
          await previous.sync()
        } finally {
          await previous.close()
        }
      }
      const latest = await safePath(root, input, !expected)
      if (
        latest.absolute !== location.absolute ||
        !sameSnapshot(await this.snapshot(root, input), expected)
      )
        throw new WorkspaceError(
          'FILE_CONFLICT',
          'The file changed while saving. Compare before retrying.',
        )
      if (expected) {
        await fs.rename(temporary, location.absolute)
        committed = true
      } else {
        // link() fails if a concurrent writer created the destination. rename() would overwrite it.
        await fs.link(temporary, location.absolute)
        committed = true
        await fs.unlink(temporary)
      }
      temporaryCreated = false
      await syncDirectory(path.dirname(location.absolute))
    } catch (error) {
      if (committed) {
        try {
          if (sameSnapshot(await this.snapshot(root, input), next)) {
            if (expected) {
              await fs.rename(backup, location.absolute)
              backupCreated = false
            } else await fs.unlink(location.absolute)
          } else {
            throw new Error('The file changed after saving and was preserved')
          }
        } catch {
          preserveBackup = backupCreated
          throw new WorkspaceError(
            'FILE_CONFLICT',
            `Saving could not be completed or safely rolled back. ${backupCreated ? `The previous version is available at ${backup}.` : 'Review the current file before retrying.'}`,
          )
        }
      }
      throw error
    } finally {
      if (temporaryCreated) await fs.unlink(temporary).catch(() => {})
      if (backupCreated && !preserveBackup) await fs.unlink(backup).catch(() => {})
    }
  }

  async listFiles(root: string, relativePath = ''): Promise<FileEntry[]> {
    const location = await safePath(root, relativePath, false, true)
    const entries = await fs.readdir(location.absolute, { withFileTypes: true })
    const files = await Promise.all(
      entries.map(async (entry): Promise<FileEntry | null> => {
        if (
          entry.name === '.DS_Store' ||
          entry.name === 'Thumbs.db' ||
          entry.name.startsWith('.coding-hub-save-')
        )
          return null
        const relative = [location.relative, entry.name].filter(Boolean).join('/')
        try {
          const resolved = await safePath(location.root, relative)
          const directory = entry.isSymbolicLink()
            ? (await fs.stat(resolved.absolute)).isDirectory()
            : entry.isDirectory()
          if (directory && hiddenDirectories.has(entry.name)) return null
          if (!directory && !entry.isFile() && !entry.isSymbolicLink()) return null
          return { name: entry.name, path: relative, directory }
        } catch {
          return null
        }
      }),
    )
    return files
      .filter((entry): entry is FileEntry => entry !== null)
      .sort(
        (a, b) =>
          Number(b.directory) - Number(a.directory) ||
          a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' }) ||
          a.name.localeCompare(b.name),
      )
  }

  async readFile(root: string, input: string): Promise<FileContent> {
    const location = await safePath(root, input)
    const file = await fs.open(location.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    try {
      const info = await file.stat()
      if (!info.isFile())
        throw new WorkspaceError('INVALID_PATH', 'Only regular files can be opened')
      if (info.size > MAX_FILE_BYTES)
        throw new WorkspaceError(
          'FILE_TOO_LARGE',
          'Files larger than 2 MB cannot be opened in the editor',
        )
      return describe(location.relative, await file.readFile())
    } finally {
      await file.close()
    }
  }

  async resolveFile(root: string, input?: string): Promise<string> {
    const location = await safePath(root, input ?? '', false, input === undefined)
    if (input === undefined) return location.root
    assertEditableLocation(location)
    if (!(await fs.stat(location.absolute)).isFile())
      throw new WorkspaceError(
        'INVALID_PATH',
        'Only regular project files can be opened externally',
      )
    return location.absolute
  }

  async saveFile(
    root: string,
    input: string,
    content: string,
    expectedFingerprint: string,
    overwrite = false,
  ): Promise<FileContent> {
    const location = await safePath(root, input)
    assertEditableLocation(location)
    return this.serialize(location.absolute, async () => {
      const current = await this.snapshot(root, input)
      if (!current) throw new WorkspaceError('FILE_CONFLICT', 'The file was deleted before saving')
      if (!overwrite && fingerprint(current.content) !== expectedFingerprint)
        throw new WorkspaceError(
          'FILE_CONFLICT',
          'FILE_CONFLICT: This file changed on disk. Compare or reload it before saving, or explicitly overwrite it.',
        )
      const buffer = preserveTextFormat(content, current.content)
      await this.atomicWrite(root, input, { content: buffer, mode: current.mode }, current)
      return describe(location.relative, buffer)
    })
  }

  async createFile(root: string, input: string, content = ''): Promise<FileContent> {
    const location = await safePath(root, input, true)
    assertEditableLocation(location)
    const buffer = Buffer.from(content, 'utf8')
    decodeText(buffer)
    return this.serialize(location.absolute, async () => {
      // File creation does not implicitly create parent folders or replace another file.
      if (await this.snapshot(root, input))
        throw new WorkspaceError('FILE_CONFLICT', 'A file already exists at this path')
      await this.atomicWrite(root, input, { content: buffer, mode: 0o644 }, null)
      return describe(location.relative, buffer)
    })
  }

  async renameFile(root: string, input: string, destination: string): Promise<FileContent> {
    const source = await safePath(root, input)
    const target = await safePath(root, destination, true)
    assertEditableLocation(source)
    assertEditableLocation(target)
    if ((await fs.lstat(path.resolve(source.root, source.relative))).isSymbolicLink())
      throw new WorkspaceError('INVALID_PATH', 'Rename the symlink in your file manager instead')
    return this.serialize(source.absolute, async () => {
      const current = await this.snapshot(root, input)
      if (!current) throw new WorkspaceError('FILE_CONFLICT', 'The source file no longer exists')
      decodeText(current.content)
      // Exclusive hard-link creation avoids silently overwriting an existing destination.
      await fs.link(source.absolute, target.absolute)
      try {
        if (
          (await safePath(root, input)).absolute !== source.absolute ||
          (await fs.lstat(path.resolve(source.root, source.relative))).isSymbolicLink() ||
          !sameSnapshot(await this.snapshot(root, input), current)
        )
          throw new WorkspaceError('FILE_CONFLICT', 'The source file changed while renaming')
        await fs.unlink(source.absolute)
      } catch (error) {
        await fs.unlink(target.absolute).catch(() => {})
        throw error
      }
      return describe(target.relative, current.content)
    })
  }

  async deleteFile(root: string, input: string, expectedFingerprint: string): Promise<void> {
    const location = await safePath(root, input)
    assertEditableLocation(location)
    if ((await fs.lstat(path.resolve(location.root, location.relative))).isSymbolicLink())
      throw new WorkspaceError('INVALID_PATH', 'Delete the symlink in your file manager instead')
    await this.serialize(location.absolute, async () => {
      const current = await this.snapshot(root, input)
      if (!current || snapshotFingerprint(current) !== expectedFingerprint)
        throw new WorkspaceError(
          'FILE_CONFLICT',
          'The file changed before deletion. Review it again.',
        )
      const latest = await safePath(root, input)
      if (
        latest.absolute !== location.absolute ||
        !sameSnapshot(await this.snapshot(root, input), current)
      )
        throw new WorkspaceError('FILE_CONFLICT', 'The file changed while deleting')
      await fs.unlink(location.absolute)
    })
  }

  async restoreFiles(root: string, files: RestoreFile[]): Promise<void> {
    const destination = await fs.realpath(root)
    if (!files.length || new Set(files.map((file) => file.path)).size !== files.length)
      throw new WorkspaceError('INVALID_PATH', 'Select unique files to restore')
    return this.serialize(`restore:${destination}`, async () => {
      const changes: { path: string; before: FileSnapshot | null; after: FileSnapshot | null }[] =
        []
      for (const file of files) {
        const location = await safePath(destination, file.path, true)
        assertEditableLocation(location)
        await rejectSymlinkPath(destination, file.path)
        const before = await this.snapshot(destination, file.path)
        if (
          (snapshotFingerprint(before) ?? 'missing') !== file.expectedFingerprint ||
          (process.platform !== 'win32' &&
            before &&
            file.expectedMode !== undefined &&
            before.mode !== file.expectedMode)
        )
          throw new WorkspaceError(
            'FILE_CONFLICT',
            `${file.path} 在本轮后发生变化。请比较并手动合并，未覆盖任何文件。`,
          )
        let after: FileSnapshot | null = null
        if (file.content !== null) {
          const buffer = Buffer.from(file.content, 'utf8')
          decodeText(buffer)
          after = { content: buffer, mode: file.mode ?? before?.mode ?? 0o666 & ~process.umask() }
        }
        changes.push({ path: location.relative, before, after })
      }
      const applied: typeof changes = []
      try {
        for (const change of changes) {
          await rejectSymlinkPath(destination, change.path)
          const location = await safePath(destination, change.path, true)
          if (change.after) {
            await fs.mkdir(path.dirname(location.absolute), { recursive: true })
            // Unlike editor saves, restores preserve the captured bytes and line endings exactly.
            await this.atomicWrite(destination, change.path, change.after, change.before)
          } else {
            if (!sameSnapshot(await this.snapshot(destination, change.path), change.before))
              throw new WorkspaceError('FILE_CONFLICT', `${change.path} 撤销时再次改变。`)
            await fs.unlink(location.absolute)
          }
          applied.push(change)
        }
      } catch (error) {
        const conflicts: string[] = []
        for (const change of [...applied].reverse()) {
          try {
            await rejectSymlinkPath(destination, change.path)
            if (!sameSnapshot(await this.snapshot(destination, change.path), change.after))
              throw new Error('Subsequent edit was preserved')
            if (change.before)
              await this.atomicWrite(destination, change.path, change.before, change.after)
            else await fs.unlink((await safePath(destination, change.path)).absolute)
          } catch {
            conflicts.push(change.path)
          }
        }
        if (conflicts.length)
          throw new WorkspaceError(
            'FILE_CONFLICT',
            `撤销未全部完成。以下文件因后续修改或磁盘错误未自动回滚，请保留并手动比较：${conflicts.join('、')}`,
          )
        throw new WorkspaceError(
          'FILE_CONFLICT',
          `撤销失败，已恢复操作前的内容。${error instanceof Error ? error.message : '请重试。'}`,
        )
      }
    })
  }

  async searchFiles(root: string, query: string, content = false): Promise<SearchResult[]> {
    if (typeof query !== 'string' || query.length > 500)
      throw new WorkspaceError('INVALID_PATH', 'Search text must contain at most 500 characters')
    const location = await fs.realpath(root)
    let files: string[]
    let repository: string | null = null
    let hasGit = true
    try {
      repository = await this.repositoryRoot(location)
    } catch (error) {
      if (!(error instanceof WorkspaceError) || !error.message.startsWith('Git was not found'))
        throw error
      hasGit = false
    }
    if (repository) {
      const result = await this.requireGit(location, [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
        '--',
        '.',
      ])
      files = [...new Set(result.stdout.split('\0').filter(Boolean))]
    } else if (hasGit) {
      // A temporary empty index lets Git apply its own ignore semantics without initializing
      // or modifying the user's non-repository directory, or running configured templates.
      const gitDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'coding-hub-search-'))
      try {
        await this.requireGit(location, ['init', '--bare', '--template=', gitDirectory])
        const result = await this.requireGit(location, [
          `--git-dir=${gitDirectory}`,
          `--work-tree=${location}`,
          'ls-files',
          '--others',
          '--exclude-standard',
          ...[...hiddenDirectories].map((name) => `--exclude=${name}/`),
          '-z',
          '--',
          '.',
        ])
        files = result.stdout.split('\0').filter(Boolean)
      } finally {
        await fs.rm(gitDirectory, { recursive: true, force: true })
      }
    } else {
      files = []
      const visit = async (relative: string): Promise<void> => {
        if (content && files.length >= MAX_SEARCH_FILES) return
        for (const entry of await fs.readdir(path.join(location, relative), {
          withFileTypes: true,
        })) {
          if (entry.isSymbolicLink() || entry.name.startsWith('.coding-hub-save-')) continue
          const name = path.posix.join(relative, entry.name)
          if (entry.isDirectory() && !hiddenDirectories.has(entry.name)) await visit(name)
          else if (entry.isFile()) files.push(name)
          if (content && files.length >= MAX_SEARCH_FILES) return
        }
      }
      await visit('')
    }
    const needle = query.toLocaleLowerCase()
    const results: SearchResult[] = []
    const candidates = content ? files.slice(0, MAX_SEARCH_FILES) : files
    for (const file of candidates.sort()) {
      if (results.length >= MAX_SEARCH_RESULTS) break
      if (!content) {
        if (file.toLocaleLowerCase().includes(needle)) results.push({ path: file })
        continue
      }
      if (!needle) continue
      try {
        const value = await this.readFile(location, file)
        for (const [index, line] of value.content.split(/\r\n|\n|\r/).entries()) {
          if (line.toLocaleLowerCase().includes(needle))
            results.push({ path: file, line: index + 1, text: line.slice(0, 500) })
          if (results.length >= MAX_SEARCH_RESULTS) break
        }
      } catch {
        // Binary, oversized, deleted and out-of-project symlink files are not searchable text.
      }
    }
    return results
  }

  private async git(root: string, args: string[]): Promise<CommandResult> {
    this.gitPath ||= resolveCommand('git').then((value) => {
      if (!value)
        throw new WorkspaceError(
          'GIT_ERROR',
          'Git was not found. Install Git and restart Coding Hub.',
        )
      return value
    })
    let executable: string
    try {
      executable = await this.gitPath
    } catch (error) {
      this.gitPath = undefined
      throw error
    }
    return runCommand(executable, ['--literal-pathspecs', ...args], root)
  }

  private async requireGit(root: string, args: string[]): Promise<CommandResult> {
    const result = await this.git(root, args)
    if (result.code !== 0)
      throw new WorkspaceError(
        'GIT_ERROR',
        redactDiagnostics(result.stderr.trim() || result.stdout.trim() || 'Git command failed'),
      )
    return result
  }

  private async repositoryRoot(root: string): Promise<string | null> {
    const result = await this.git(root, ['rev-parse', '--show-toplevel'])
    return result.code === 0 ? fs.realpath(result.stdout.trim()) : null
  }

  async inspect(root: string): Promise<WorkspaceIdentity> {
    const rootPath = await fs.realpath(root)
    const identity: WorkspaceIdentity = {
      rootPath,
      canonicalId: canonicalHash(rootPath),
      hasHead: false,
    }
    let repositoryRoot: string | null
    try {
      repositoryRoot = await this.repositoryRoot(rootPath)
    } catch (error) {
      if (error instanceof WorkspaceError && error.message.startsWith('Git was not found'))
        return identity
      throw error
    }
    if (!repositoryRoot) return identity
    const [gitDir, commonDir, branch, head] = await Promise.all([
      this.requireGit(rootPath, ['rev-parse', '--path-format=absolute', '--git-dir']),
      this.requireGit(rootPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      this.git(rootPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      this.git(rootPath, ['rev-parse', '--verify', 'HEAD']),
    ])
    return {
      ...identity,
      gitDir: await fs.realpath(gitDir.stdout.trim()),
      repositoryRoot,
      repositoryId: canonicalHash(await fs.realpath(commonDir.stdout.trim())),
      branch: branch.code === 0 ? branch.stdout.trim() : undefined,
      hasHead: head.code === 0,
    }
  }

  private async assertIndexScope(root: string, repo: string): Promise<void> {
    if (root === repo) return
    const staged = await this.requireGit(repo, [
      'diff',
      '--cached',
      '--name-only',
      '--no-renames',
      '-z',
    ])
    for (const file of staged.stdout.split('\0').filter(Boolean)) {
      try {
        assertInside(root, path.resolve(repo, file))
      } catch {
        throw new WorkspaceError(
          'GIT_ERROR',
          'The index contains staged changes outside this project. Open the repository root to review and commit them.',
        )
      }
    }
  }

  private async validateBranch(root: string, value: string): Promise<void> {
    if (
      !value ||
      value === 'HEAD' ||
      value.startsWith('-') ||
      value.length > 250 ||
      value.includes('\0')
    )
      throw new WorkspaceError('GIT_ERROR', 'A valid local branch name is required')
    await this.requireGit(root, ['check-ref-format', `refs/heads/${value}`])
  }

  async createWorktree(
    root: string,
    destination: string,
    branch: string,
    base = 'HEAD',
  ): Promise<WorkspaceIdentity> {
    const identity = await this.inspect(root)
    if (!identity.repositoryRoot || !identity.hasHead)
      throw new WorkspaceError(
        'GIT_ERROR',
        'An initial Git commit is required before creating an isolated workspace',
      )
    await this.validateBranch(identity.rootPath, branch)
    if (!path.isAbsolute(destination) || destination.includes('\0'))
      throw new WorkspaceError('INVALID_PATH', 'The worktree destination must be an absolute path')
    if (!base || base.startsWith('-') || base.length > 300 || /[\0\r\n]/.test(base))
      throw new WorkspaceError('GIT_ERROR', 'Select a commit or branch as the worktree base')
    const resolvedBase = await this.requireGit(identity.rootPath, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${base}^{commit}`,
    ])
    const worktrees = await this.listWorktrees(root)
    const parent = path.dirname(destination)
    await fs.mkdir(parent, { recursive: true })
    const target = path.join(await fs.realpath(parent), path.basename(destination))
    for (const worktree of worktrees) {
      const relative = path.relative(worktree.repositoryRoot || worktree.rootPath, target)
      if (
        !relative ||
        (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
      )
        throw new WorkspaceError(
          'INVALID_PATH',
          'Create isolated workspaces outside existing working directories',
        )
    }
    try {
      await fs.lstat(target)
      throw new WorkspaceError('FILE_CONFLICT', 'The worktree destination already exists')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await this.requireGit(identity.repositoryRoot, [
      'worktree',
      'add',
      '-b',
      branch,
      '--',
      target,
      resolvedBase.stdout.trim(),
    ])
    const projectRelative = path.relative(identity.repositoryRoot, identity.rootPath)
    return this.inspect(path.join(target, projectRelative))
  }

  async listWorktrees(root: string): Promise<WorkspaceIdentity[]> {
    const identity = await this.inspect(root)
    if (!identity.repositoryRoot) return []
    const result = await this.requireGit(identity.repositoryRoot, [
      'worktree',
      'list',
      '--porcelain',
      '-z',
    ])
    const paths = result.stdout
      .split('\0')
      .filter((field) => field.startsWith('worktree '))
      .map((field) => field.slice(9))
    const worktrees: WorkspaceIdentity[] = []
    for (const directory of paths) {
      try {
        worktrees.push(await this.inspect(directory))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return worktrees
  }

  async removeWorktree(root: string, target: string): Promise<void> {
    const original = await this.inspect(root)
    const candidate = await this.inspect(target)
    const registered = await this.listWorktrees(root)
    if (
      !original.repositoryId ||
      original.repositoryId !== candidate.repositoryId ||
      !candidate.repositoryRoot ||
      !registered.some((entry) => entry.repositoryRoot === candidate.repositoryRoot) ||
      registered[0]?.repositoryRoot === candidate.repositoryRoot ||
      original.repositoryRoot === candidate.repositoryRoot
    )
      throw new WorkspaceError(
        'GIT_ERROR',
        'Only another registered linked worktree can be removed',
      )
    const dirty = await this.requireGit(candidate.repositoryRoot, [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--ignored',
    ])
    if (dirty.stdout)
      throw new WorkspaceError(
        'FILE_CONFLICT',
        'This workspace contains local, untracked or ignored files. Preserve them before removing it.',
      )
    await this.requireGit(original.repositoryRoot!, [
      'worktree',
      'remove',
      '--',
      candidate.repositoryRoot,
    ])
  }

  private async worktreePlan(
    root: string,
    source: string,
  ): Promise<{
    comparison: WorktreeComparison
    changes: { path: string; before: FileSnapshot | null; after: FileSnapshot | null }[]
  }> {
    const destination = await this.inspect(root)
    const origin = await this.inspect(source)
    if (
      !destination.repositoryId ||
      destination.repositoryId !== origin.repositoryId ||
      !destination.repositoryRoot ||
      !origin.repositoryRoot ||
      destination.repositoryRoot === origin.repositoryRoot ||
      !destination.hasHead ||
      !origin.hasHead
    )
      throw new WorkspaceError('GIT_ERROR', 'Select a different worktree from the same repository')
    const [targetHead, sourceHead] = await Promise.all([
      this.requireGit(destination.rootPath, ['rev-parse', 'HEAD']),
      this.requireGit(origin.rootPath, ['rev-parse', 'HEAD']),
    ])
    const base = (
      await this.requireGit(destination.rootPath, [
        'merge-base',
        targetHead.stdout.trim(),
        sourceHead.stdout.trim(),
      ])
    ).stdout.trim()
    const comparison: WorktreeComparison = { base, files: [], conflicts: [] }
    const changes: { path: string; before: FileSnapshot | null; after: FileSnapshot | null }[] = []
    const sourcePrefix = path.relative(origin.repositoryRoot, origin.rootPath)
    if (sourcePrefix !== path.relative(destination.repositoryRoot, destination.rootPath))
      throw new WorkspaceError(
        'GIT_ERROR',
        'Compare matching project directories in the two worktrees',
      )
    const changed = await this.requireGit(origin.rootPath, [
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      base,
      '--',
      '.',
    ])
    const untracked = await this.requireGit(origin.rootPath, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      '.',
    ])
    const names = new Set([
      ...changed.stdout
        .split('\0')
        .filter(Boolean)
        .map((name) => path.relative(sourcePrefix, name).split(path.sep).join('/')),
      ...untracked.stdout.split('\0').filter(Boolean),
    ])
    for (const name of [...names].sort()) {
      try {
        const relative = normalizeRelative(name)
        assertEditable(relative)
        const repoPath = path.posix.join(sourcePrefix.split(path.sep).join('/'), relative)
        const tree = await this.requireGit(origin.repositoryRoot, [
          'ls-tree',
          '-z',
          base,
          '--',
          repoPath,
        ])
        const entry = /^(\d+) blob ([a-f0-9]+)\t/.exec(tree.stdout)
        let baseline: FileSnapshot | null = null
        if (entry) {
          if (entry[1] === '120000')
            throw new WorkspaceError('INVALID_PATH', 'Symlink changes require manual review')
          const blob = await this.requireGit(origin.repositoryRoot, ['show', entry[2]])
          if (blob.stdoutBuffer.length > MAX_FILE_BYTES)
            throw new WorkspaceError('FILE_TOO_LARGE', 'The file exceeds the review limit')
          baseline = { content: blob.stdoutBuffer, mode: entry[1] === '100755' ? 0o755 : 0o644 }
        } else if (tree.stdout)
          throw new WorkspaceError('INVALID_PATH', 'Submodule changes require manual review')
        for (const directory of [destination.rootPath, origin.rootPath])
          await rejectSymlinkPath(directory, relative)
        const before = await this.snapshot(destination.rootPath, relative)
        const after = await this.snapshot(origin.rootPath, relative)
        if (sameSnapshot(baseline, after)) continue
        comparison.files.push({
          path: relative,
          status: !baseline ? 'added' : !after ? 'deleted' : 'modified',
          baseFingerprint: snapshotFingerprint(baseline),
          targetFingerprint: snapshotFingerprint(before),
          sourceFingerprint: snapshotFingerprint(after),
        })
        if (sameSnapshot(before, after)) continue
        if (!sameSnapshot(before, baseline))
          comparison.conflicts.push({
            path: relative,
            reason: 'Both workspaces changed this path since their common baseline',
          })
        else changes.push({ path: relative, before, after })
      } catch (error) {
        comparison.conflicts.push({
          path: name,
          reason: error instanceof Error ? error.message : 'Unable to review this file',
        })
      }
    }
    return { comparison, changes }
  }

  async compareWorktree(root: string, source: string): Promise<WorktreeComparison> {
    return (await this.worktreePlan(root, source)).comparison
  }

  async applyWorktree(root: string, source: string): Promise<WorktreeApplyResult> {
    const destination = await fs.realpath(root)
    return this.serialize(`worktree:${destination}`, async () => {
      const { comparison, changes } = await this.worktreePlan(destination, source)
      if (comparison.conflicts.length) return { applied: [], conflicts: comparison.conflicts }
      // Preflight the entire batch before writing. Every operation repeats this check immediately before mutation.
      for (const change of changes)
        if (
          !sameSnapshot(await this.snapshot(destination, change.path), change.before) ||
          !sameSnapshot(await this.snapshot(source, change.path), change.after)
        )
          return {
            applied: [],
            conflicts: [
              { path: change.path, reason: 'A file changed after comparison. Compare again.' },
            ],
          }
      const applied: typeof changes = []
      try {
        for (const change of changes) {
          if (!sameSnapshot(await this.snapshot(source, change.path), change.after))
            throw new WorkspaceError(
              'FILE_CONFLICT',
              `The source file changed before applying: ${change.path}`,
            )
          await rejectSymlinkPath(destination, change.path)
          const location = await safePath(destination, change.path, true)
          if (change.after) {
            await fs.mkdir(path.dirname(location.absolute), { recursive: true })
            await this.atomicWrite(destination, change.path, change.after, change.before)
          } else {
            if (!sameSnapshot(await this.snapshot(destination, change.path), change.before))
              throw new WorkspaceError(
                'FILE_CONFLICT',
                `The file changed before deletion: ${change.path}`,
              )
            await fs.unlink(location.absolute)
          }
          applied.push(change)
        }
        return { applied: applied.map((change) => change.path), conflicts: [] }
      } catch (error) {
        const rollbackConflicts: { path: string; reason: string }[] = []
        for (const change of [...applied].reverse()) {
          try {
            if (!sameSnapshot(await this.snapshot(destination, change.path), change.after))
              throw new Error('A later edit prevents automatic rollback; your file was preserved')
            if (change.before)
              await this.atomicWrite(destination, change.path, change.before, change.after)
            else await fs.unlink((await safePath(destination, change.path)).absolute)
          } catch (rollbackError) {
            rollbackConflicts.push({
              path: change.path,
              reason:
                rollbackError instanceof Error
                  ? rollbackError.message
                  : 'Rollback requires manual review',
            })
          }
        }
        if (rollbackConflicts.length)
          return {
            applied: applied
              .filter((change) =>
                rollbackConflicts.some((conflict) => conflict.path === change.path),
              )
              .map((change) => change.path),
            conflicts: rollbackConflicts,
            rolledBack: false,
          }
        throw new WorkspaceError(
          'FILE_CONFLICT',
          `No changes were applied; the operation was rolled back. ${error instanceof Error ? error.message : 'Please compare and retry.'}`,
        )
      }
    })
  }

  private async statusFiles(root: string, repo: string): Promise<PorcelainFile[]> {
    const result = await this.requireGit(root, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--',
      '.',
    ])
    return parsePorcelain(result.stdout)
      .map((file) => ({
        ...file,
        path: path.relative(root, path.resolve(repo, file.path)).split(path.sep).join('/'),
        originalPath: file.originalPath
          ? path.relative(root, path.resolve(repo, file.originalPath)).split(path.sep).join('/')
          : undefined,
      }))
      .filter((file) => !file.path.startsWith('../') && !path.isAbsolute(file.path))
  }

  async gitStatus(root: string): Promise<ExtendedGitStatus> {
    const realRoot = await fs.realpath(root)
    const repo = await this.repositoryRoot(realRoot)
    if (!repo) return { branch: '', files: [], branches: [], isRepo: false }
    const [symbolic, branchesResult, files, upstreamResult, index] = await Promise.all([
      this.git(realRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      this.requireGit(realRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
      this.statusFiles(realRoot, repo),
      this.git(realRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
      this.requireGit(repo, ['ls-files', '--stage', '-z']),
    ])
    const head =
      symbolic.code === 0
        ? symbolic.stdout.trim()
        : (await this.git(realRoot, ['rev-parse', '--short', 'HEAD'])).stdout.trim()
    const upstream = upstreamResult.code === 0 ? upstreamResult.stdout.trim() : undefined
    const remote =
      symbolic.code === 0
        ? await this.git(realRoot, ['config', '--get', `branch.${head}.remote`])
        : undefined
    const counts = upstream
      ? await this.git(realRoot, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`])
      : undefined
    const [ahead, behind] = counts?.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : []
    return {
      branch: head || 'HEAD',
      branches: branchesResult.stdout.split('\n').filter(Boolean),
      isRepo: true,
      indexFingerprint: fingerprint(index.stdoutBuffer),
      upstream,
      remote: remote?.code === 0 ? remote.stdout.trim() : undefined,
      ahead,
      behind,
      conflicts: files
        .filter(
          (file) =>
            /U/.test(file.index + file.working) || ['AA', 'DD'].includes(file.index + file.working),
        )
        .map((file) => file.path),
      files: files.map(({ path: filePath, index, working }) => ({
        path: filePath,
        index,
        working,
      })),
    }
  }

  async gitDiff(root: string, input: string, staged = false): Promise<GitDiff> {
    const location = await safePath(root, input, true)
    const repo = await this.repositoryRoot(location.root)
    if (!repo) throw new WorkspaceError('GIT_ERROR', 'This project is not a Git repository')
    const toRepo = (relative: string) =>
      path.relative(repo, path.resolve(location.root, relative)).split(path.sep).join('/')
    const fileStatus = (await this.statusFiles(location.root, repo)).find(
      (file) => file.path === location.relative,
    )
    const originalPath =
      staged &&
      fileStatus?.index === 'R' &&
      fileStatus.originalPath &&
      !fileStatus.originalPath.startsWith('../')
        ? fileStatus.originalPath
        : location.relative
    let unavailable: 'binary' | 'large' | undefined
    const readBlob = async (spec: string): Promise<Buffer> => {
      const size = await this.git(location.root, ['cat-file', '-s', spec])
      if (size.code !== 0) return Buffer.alloc(0)
      if (Number(size.stdout.trim()) > MAX_FILE_BYTES) {
        unavailable = 'large'
        return Buffer.alloc(0)
      }
      return (await this.requireGit(location.root, ['show', spec])).stdoutBuffer
    }
    const originalBuffer = await readBlob(`${staged ? 'HEAD' : ''}:${toRepo(originalPath)}`)
    let modifiedBuffer: Buffer = Buffer.alloc(0)
    if (staged) modifiedBuffer = await readBlob(`:${toRepo(location.relative)}`)
    else {
      try {
        const info = await fs.stat(location.absolute)
        if (!info.isFile()) unavailable = 'binary'
        else if (info.size > MAX_FILE_BYTES) unavailable = 'large'
        else modifiedBuffer = await fs.readFile(location.absolute)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    if (unavailable)
      return {
        path: location.relative,
        original: '',
        modified: '',
        staged,
        previewUnavailable: unavailable,
      }
    try {
      return {
        path: location.relative,
        original: decodeText(originalBuffer),
        modified: decodeText(modifiedBuffer),
        staged,
      }
    } catch (error) {
      if (
        !(error instanceof WorkspaceError) ||
        !['BINARY_FILE', 'FILE_TOO_LARGE'].includes(error.code)
      )
        throw error
      return {
        path: location.relative,
        original: '',
        modified: '',
        staged,
        previewUnavailable: error.code === 'FILE_TOO_LARGE' ? 'large' : 'binary',
      }
    }
  }

  async gitAction(
    root: string,
    action: WorkspaceGitAction,
    value: string,
    expectedIndexFingerprint?: string,
  ): Promise<void> {
    const realRoot = await fs.realpath(root)
    const repo = await this.repositoryRoot(realRoot)
    if (!repo) throw new WorkspaceError('GIT_ERROR', 'This project is not a Git repository')
    if (action === 'stage' || action === 'unstage') {
      const location = await safePath(realRoot, value, true)
      assertEditable(location.relative)
      if (action === 'stage') await this.requireGit(realRoot, ['add', '--', location.relative])
      else {
        const head = await this.git(realRoot, ['rev-parse', '--verify', 'HEAD'])
        await this.requireGit(
          realRoot,
          head.code === 0
            ? ['reset', '--quiet', 'HEAD', '--', location.relative]
            : ['rm', '--cached', '-r', '--ignore-unmatch', '--', location.relative],
        )
      }
    } else if (action === 'commit') {
      if (!value.trim() || value.includes('\0'))
        throw new WorkspaceError('GIT_ERROR', 'A commit message is required')
      await this.assertIndexScope(realRoot, repo)
      if (expectedIndexFingerprint) {
        const index = await this.requireGit(repo, ['ls-files', '--stage', '-z'])
        if (fingerprint(index.stdoutBuffer) !== expectedIndexFingerprint)
          throw new WorkspaceError(
            'FILE_CONFLICT',
            'Staged contents changed after preview. Refresh the commit preview before committing.',
          )
      }
      await this.requireGit(realRoot, ['commit', '--message', value])
    } else if (action === 'checkout') {
      const branches = (
        await this.requireGit(realRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
      ).stdout.split('\n')
      if (value.startsWith('-') || !branches.includes(value))
        throw new WorkspaceError('GIT_ERROR', 'Select an existing local branch')
      await this.requireGit(realRoot, ['checkout', value, '--'])
    } else if (action === 'createBranch') {
      await this.validateBranch(realRoot, value)
      await this.requireGit(realRoot, ['checkout', '-b', value, '--'])
    } else if (action === 'fetch' || action === 'pull' || action === 'push') {
      const status = await this.gitStatus(realRoot)
      const remotes = (await this.requireGit(realRoot, ['remote'])).stdout
        .split('\n')
        .filter(Boolean)
      const remote =
        status.remote && status.remote !== '.'
          ? status.remote
          : remotes.includes('origin')
            ? 'origin'
            : remotes[0]
      if (!remote || remote.startsWith('-'))
        throw new WorkspaceError('GIT_ERROR', 'Configure a remote repository before synchronizing')
      if (action === 'fetch') await this.requireGit(realRoot, ['fetch', '--', remote])
      else if (action === 'pull') {
        if (!status.upstream)
          throw new WorkspaceError('GIT_ERROR', 'Set an upstream branch before pulling')
        if (
          status.files.length ||
          (await this.requireGit(repo, ['status', '--porcelain=v1'])).stdout.trim()
        )
          throw new WorkspaceError('GIT_ERROR', 'Commit or stash local changes before pulling')
        await this.requireGit(realRoot, ['pull', '--ff-only'])
      } else {
        const branch = (
          await this.git(realRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
        ).stdout.trim()
        await this.validateBranch(realRoot, branch)
        if (status.upstream) {
          const upstreamBranch = (
            await this.requireGit(realRoot, ['config', '--get', `branch.${branch}.merge`])
          ).stdout.trim()
          if (!upstreamBranch.startsWith('refs/heads/'))
            throw new WorkspaceError('GIT_ERROR', 'The upstream must refer to a remote branch')
          await this.validateBranch(realRoot, upstreamBranch.slice(11))
          await this.requireGit(realRoot, ['push', '--', remote, `HEAD:${upstreamBranch}`])
        } else
          await this.requireGit(realRoot, [
            'push',
            '--set-upstream',
            '--',
            remote,
            `HEAD:refs/heads/${branch}`,
          ])
      }
    } else throw new WorkspaceError('GIT_ERROR', 'Unsupported Git action')
  }

  async gitHistory(root: string): Promise<GitCommit[]> {
    const identity = await this.inspect(root)
    if (!identity.hasHead) return []
    const result = await this.requireGit(identity.rootPath, [
      'log',
      '-100',
      '--format=%H%x00%h%x00%s%x00%an%x00%at%x00',
    ])
    const fields = result.stdout.split('\0')
    const commits: GitCommit[] = []
    for (let index = 0; index + 4 < fields.length; index += 5)
      commits.push({
        hash: fields[index].trim(),
        shortHash: fields[index + 1],
        subject: fields[index + 2],
        author: fields[index + 3],
        timestamp: Number(fields[index + 4]) * 1000,
      })
    return commits
  }
}
