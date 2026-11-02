import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crossSpawn from 'cross-spawn'

let environment: NodeJS.ProcessEnv = { ...process.env }
let prepared: Promise<NodeJS.ProcessEnv> | undefined
let shuttingDown = false
const ownedChildren = new Map<ChildProcessWithoutNullStreams, OwnedProcessTree>()
const ownedTrees = new Set<OwnedProcessTree>()

interface ProcessIdentity {
  pid: number
  parent: number
  group: number
  state: string
  started: string
}
export interface OwnedProcessTree {
  terminate(force?: boolean): Promise<void>
  release(): void
}

async function processSnapshot(): Promise<ProcessIdentity[]> {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/ps',
      ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='],
      { timeout: 2000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(
          stdout.split('\n').flatMap((line) => {
            const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line)
            return match
              ? [
                  {
                    pid: Number(match[1]),
                    parent: Number(match[2]),
                    group: Number(match[3]),
                    state: match[4],
                    started: match[5],
                  },
                ]
              : []
          }),
        )
      },
    )
  })
}

function descendantProcesses(
  snapshot: ProcessIdentity[],
  root: number,
  isolatedGroup: boolean,
): ProcessIdentity[] {
  const selected = new Set([root])
  if (isolatedGroup) for (const entry of snapshot) if (entry.group === root) selected.add(entry.pid)
  let previous = 0
  while (previous !== selected.size) {
    previous = selected.size
    for (const entry of snapshot) if (selected.has(entry.parent)) selected.add(entry.pid)
  }
  return snapshot.filter((entry) => selected.has(entry.pid))
}

function signalOwnedProcess(entry: ProcessIdentity, signal: NodeJS.Signals): void {
  if (entry.pid === process.pid || entry.state.startsWith('Z')) return
  try {
    process.kill(entry.pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

/** Only call for a process just created by this application; never accept renderer-supplied PIDs. */
export function ownProcessTree(
  pid: number,
  isRunning: () => boolean,
  isolatedGroup = false,
): OwnedProcessTree {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid)
    throw new Error('Invalid owned process')
  let released = false
  let pending: Promise<void> | undefined
  const tree: OwnedProcessTree = {
    release() {
      released = true
      ownedTrees.delete(tree)
    },
    terminate(force = false) {
      if (pending) return pending
      if (released || !isRunning()) {
        tree.release()
        return Promise.resolve()
      }
      pending = (async () => {
        if (process.platform === 'win32') {
          // taskkill follows this application's live root, never an image-name pattern.
          const command = path.join(
            process.env.SystemRoot || 'C:\\Windows',
            'System32',
            'taskkill.exe',
          )
          await new Promise<void>((resolve, reject) => {
            const taskkill = spawn(command, ['/PID', String(pid), '/T', '/F'], {
              windowsHide: true,
              stdio: 'ignore',
              shell: false,
            })
            const timer = setTimeout(() => {
              taskkill.kill()
              reject(new Error('Process tree termination timed out'))
            }, 4000)
            taskkill.once('error', (error) => {
              clearTimeout(timer)
              reject(error)
            })
            taskkill.once('close', (code) => {
              clearTimeout(timer)
              if (code === 0 || !isRunning()) resolve()
              else reject(new Error(`Unable to terminate owned process tree (${code})`))
            })
          })
          return
        }
        const snapshot = await processSnapshot()
        // The ownership callback prevents acting on a PID that has already been reaped/reused.
        if (!isRunning()) return
        const root = snapshot.find((entry) => entry.pid === pid)
        if (!root) return
        const targets = descendantProcesses(snapshot, pid, isolatedGroup)
        // Capture descendants before terminating the parent, since orphaned children are reparented.
        for (const entry of targets.filter((entry) => entry.pid !== pid))
          signalOwnedProcess(entry, force ? 'SIGKILL' : 'SIGTERM')
        signalOwnedProcess(root, force ? 'SIGKILL' : 'SIGTERM')
        if (force) return
        await new Promise((resolve) => setTimeout(resolve, 600))
        const remaining = new Map((await processSnapshot()).map((entry) => [entry.pid, entry]))
        for (const before of targets) {
          const after = remaining.get(before.pid)
          // Never signal a recycled PID: the start identity must still match the captured descendant.
          if (after && after.started === before.started) signalOwnedProcess(after, 'SIGKILL')
        }
      })().finally(() => tree.release())
      return pending
    },
  }
  ownedTrees.add(tree)
  return tree
}

export async function terminateProcessTree(
  child: ChildProcessWithoutNullStreams,
  force = false,
): Promise<void> {
  const tree = ownedChildren.get(child)
  if (!tree) {
    if (child.exitCode !== null || child.signalCode !== null) return
    throw new Error('Refusing to terminate a process that was not launched by Coding Hub')
  }
  await tree.terminate(force)
}

export async function closeAllProcesses(): Promise<void> {
  shuttingDown = true
  await Promise.allSettled([...ownedTrees].map((tree) => tree.terminate()))
}

/** Finder does not inherit the PATH established by the user's login shell. */
export function prepareEnvironment(): Promise<NodeJS.ProcessEnv> {
  if (prepared) return prepared
  prepared = (async () => {
    if (process.platform === 'darwin') {
      const shell = process.env.SHELL || '/bin/zsh'
      const shellPath = await new Promise<string>((resolve) => {
        const child = launch(shell, ['-ilc', 'printf "\\0CODING_HUB_PATH\\0%s\\0" "$PATH"'])
        let stdout = ''
        const timer = setTimeout(() => {
          void terminateProcessTree(child, true)
            .catch(() => {})
            .finally(() => resolve(''))
        }, 5000)
        child.stdout.on('data', (chunk) => {
          stdout += String(chunk)
          if (stdout.length > 1024 * 1024)
            void terminateProcessTree(child, true)
              .catch(() => {})
              .finally(() => resolve(''))
        })
        child.stderr.resume()
        child.once('error', () => {
          clearTimeout(timer)
          resolve('')
        })
        child.once('close', () => {
          clearTimeout(timer)
          resolve(/\0CODING_HUB_PATH\0([^\0]+)\0/.exec(stdout)?.[1] || '')
        })
        child.stdin.end()
      })
      environment.PATH = [
        ...new Set(
          [
            ...shellPath.split(path.delimiter),
            ...(process.env.PATH || '').split(path.delimiter),
            '/opt/homebrew/bin',
            '/usr/local/bin',
            path.join(os.homedir(), '.local/bin'),
          ].filter(Boolean),
        ),
      ].join(path.delimiter)
    }
    environment = normalizeEnvironment(environment)
    return { ...environment }
  })()
  return prepared
}

function normalizeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') return { ...env }
  const result = { ...env }
  const pathKey = Object.keys(result).find((key) => key.toLowerCase() === 'path')
  const searchPath = pathKey ? result[pathKey] : undefined
  for (const key of Object.keys(result)) if (key.toLowerCase() === 'path') delete result[key]
  if (searchPath !== undefined) result.PATH = searchPath
  return result
}

export function getProcessEnvironment(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return normalizeEnvironment({ ...environment, ...extra })
}

export async function resolveCommand(command: string, customPath?: string): Promise<string | null> {
  const env = await prepareEnvironment()
  const wanted = (customPath || command).trim()
  if (!wanted || /[\0\r\n]/.test(wanted)) return null
  const hasPath = path.isAbsolute(wanted) || wanted.includes('/') || wanted.includes('\\')
  const directories = hasPath ? [''] : (env.PATH || '').split(path.delimiter).filter(Boolean)
  const extensions =
    process.platform === 'win32' && !path.extname(wanted)
      ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
      : ['']
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.resolve(directory, wanted + extension)
      try {
        if (!(await stat(candidate)).isFile()) continue
        await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
        return candidate
      } catch {
        /* Continue searching other PATH entries. */
      }
    }
  }
  return null
}

export function launch(
  command: string,
  args: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  if (shuttingDown) throw new Error('The process runtime is shutting down')
  if ([command, ...args].some((value) => value.includes('\0')))
    throw new Error('Command contains an invalid NUL character')
  const childEnv = getProcessEnvironment(env)
  const child = crossSpawn(command, args, {
    cwd,
    env: childEnv,
    stdio: 'pipe',
    windowsHide: true,
    shell: false,
    detached: process.platform !== 'win32',
  }) as ChildProcessWithoutNullStreams
  if (child.pid) {
    const tree = ownProcessTree(
      child.pid,
      () => child.exitCode === null && child.signalCode === null,
      process.platform !== 'win32',
    )
    ownedChildren.set(child, tree)
    child.once('close', () => {
      tree.release()
      ownedChildren.delete(child)
    })
  }
  return child
}

export interface CommandResult {
  stdout: string
  stderr: string
  code: number
  stdoutBuffer: Buffer
}

export async function runCommand(
  command: string,
  args: string[],
  cwd?: string,
  options: { timeoutMs?: number } = {},
): Promise<CommandResult> {
  await prepareEnvironment()
  return new Promise((resolve, reject) => {
    const child = launch(command, args, cwd)
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let total = 0
    let failure: Error | undefined
    let cleanup: Promise<void> | undefined
    const timer = setTimeout(() => {
      failure = new Error(`Command timed out: ${path.basename(command)}`)
      cleanup = terminateProcessTree(child).catch(() => {})
    }, options.timeoutMs ?? 30_000)
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      total += chunk.length
      if (total > 8 * 1024 * 1024) {
        failure = new Error('Command output exceeds the 8 MB limit')
        cleanup ||= terminateProcessTree(child, true).catch(() => {})
      } else chunks.push(chunk)
    }
    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', async (code) => {
      clearTimeout(timer)
      await cleanup
      if (failure) {
        reject(failure)
        return
      }
      const stdoutBuffer = Buffer.concat(stdout)
      resolve({
        stdout: stdoutBuffer.toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code: code ?? -1,
        stdoutBuffer,
      })
    })
    child.stdin.end()
  })
}
