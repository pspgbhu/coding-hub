import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import type { FileContent, FileEntry, GitDiff, GitFile, GitStatus } from '../shared/types'
import { resolveCommand, runCommand, type CommandResult } from './process'

export const MAX_FILE_BYTES = 2 * 1024 * 1024
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
        assertInside(realRoot, await fs.realpath(parent))
        break
      } catch (parentError) {
        if ((parentError as NodeJS.ErrnoException).code !== 'ENOENT') throw parentError
        const next = path.dirname(parent)
        if (next === parent) throw parentError
        parent = next
      }
    }
    return { root: realRoot, absolute: candidate, relative }
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

  async listFiles(root: string, relativePath = ''): Promise<FileEntry[]> {
    const location = await safePath(root, relativePath, false, true)
    const entries = await fs.readdir(location.absolute, { withFileTypes: true })
    const files = await Promise.all(
      entries.map(async (entry): Promise<FileEntry | null> => {
        if (entry.name === '.DS_Store' || entry.name === 'Thumbs.db') return null
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

  async saveFile(
    root: string,
    input: string,
    content: string,
    expectedFingerprint: string,
    overwrite = false,
  ): Promise<FileContent> {
    const location = await safePath(root, input)
    const key = location.absolute
    const previous = this.saves.get(key) || Promise.resolve()
    const pending = previous
      .catch(() => {})
      .then(async () => {
        const buffer = Buffer.from(content, 'utf8')
        decodeText(buffer)
        const file = await fs.open(
          location.absolute,
          constants.O_RDWR | (constants.O_NOFOLLOW || 0),
        )
        try {
          const info = await file.stat()
          if (!info.isFile())
            throw new WorkspaceError('INVALID_PATH', 'Only regular files can be saved')
          if (info.size > MAX_FILE_BYTES)
            throw new WorkspaceError('FILE_TOO_LARGE', 'Files larger than 2 MB cannot be edited')
          const current = await file.readFile()
          decodeText(current)
          if (!overwrite && fingerprint(current) !== expectedFingerprint) {
            throw new WorkspaceError(
              'FILE_CONFLICT',
              'FILE_CONFLICT: This file changed on disk. Compare or reload it before saving, or explicitly overwrite it.',
            )
          }
          // Write the existing inode, preserving executable bits and symlink target semantics.
          let written = 0
          while (written < buffer.length) {
            const result = await file.write(buffer, written, buffer.length - written, written)
            if (!result.bytesWritten) throw new Error('Unable to finish writing the file')
            written += result.bytesWritten
          }
          await file.truncate(buffer.length)
          await file.sync()
          return describe(location.relative, buffer)
        } finally {
          await file.close()
        }
      })
    this.saves.set(key, pending)
    try {
      return await pending
    } finally {
      if (this.saves.get(key) === pending) this.saves.delete(key)
    }
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
    return runCommand(await this.gitPath, ['--literal-pathspecs', ...args], root)
  }

  private async requireGit(root: string, args: string[]): Promise<CommandResult> {
    const result = await this.git(root, args)
    if (result.code !== 0)
      throw new WorkspaceError(
        'GIT_ERROR',
        result.stderr.trim() || result.stdout.trim() || 'Git command failed',
      )
    return result
  }

  private async repositoryRoot(root: string): Promise<string | null> {
    const result = await this.git(root, ['rev-parse', '--show-toplevel'])
    return result.code === 0 ? fs.realpath(result.stdout.trim()) : null
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

  async gitStatus(root: string): Promise<GitStatus> {
    const realRoot = await fs.realpath(root)
    const repo = await this.repositoryRoot(realRoot)
    if (!repo) return { branch: '', files: [], branches: [], isRepo: false }
    const [symbolic, branchesResult, files] = await Promise.all([
      this.git(realRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      this.requireGit(realRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
      this.statusFiles(realRoot, repo),
    ])
    const head =
      symbolic.code === 0
        ? symbolic.stdout.trim()
        : (await this.git(realRoot, ['rev-parse', '--short', 'HEAD'])).stdout.trim()
    return {
      branch: head || 'HEAD',
      branches: branchesResult.stdout.split('\n').filter(Boolean),
      isRepo: true,
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
    const originalResult = await this.git(location.root, [
      'show',
      `${staged ? 'HEAD' : ''}:${toRepo(originalPath)}`,
    ])
    const original = originalResult.code === 0 ? decodeText(originalResult.stdoutBuffer) : ''
    let modified = ''
    if (staged) {
      const result = await this.git(location.root, ['show', `:${toRepo(location.relative)}`])
      if (result.code === 0) modified = decodeText(result.stdoutBuffer)
    } else {
      try {
        modified = (await this.readFile(location.root, location.relative)).content
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return { path: location.relative, original, modified, staged }
  }

  async gitAction(
    root: string,
    action: 'stage' | 'unstage' | 'commit' | 'checkout',
    value: string,
  ): Promise<void> {
    const realRoot = await fs.realpath(root)
    if (!(await this.repositoryRoot(realRoot)))
      throw new WorkspaceError('GIT_ERROR', 'This project is not a Git repository')
    if (action === 'stage' || action === 'unstage') {
      const location = await safePath(realRoot, value, true)
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
      await this.requireGit(realRoot, ['commit', '--message', value])
    } else if (action === 'checkout') {
      const branches = (
        await this.requireGit(realRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
      ).stdout.split('\n')
      if (value.startsWith('-') || !branches.includes(value))
        throw new WorkspaceError('GIT_ERROR', 'Select an existing local branch')
      await this.requireGit(realRoot, ['checkout', value, '--'])
    } else throw new WorkspaceError('GIT_ERROR', 'Unsupported Git action')
  }
}
