import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crossSpawn from 'cross-spawn'
import { randomUUID } from 'node:crypto'

let environment: NodeJS.ProcessEnv = { ...process.env }
let prepared: Promise<NodeJS.ProcessEnv> | undefined
let shuttingDown = false
const ownedChildren = new Map<ChildProcessWithoutNullStreams, OwnedProcessTree>()
const ownedTrees = new Set<OwnedProcessTree>()
export interface ProcessOwnership {
  id: string
  pid: number
  started: string
  isolatedGroup: boolean
  members?: { pid: number; started: string }[]
}
export interface ProcessOwnershipEvent {
  action: 'register' | 'release'
  process: ProcessOwnership
}
let ownershipObserver: ((event: ProcessOwnershipEvent) => void) | undefined
export function setProcessOwnershipObserver(
  observer: (event: ProcessOwnershipEvent) => void,
): void {
  ownershipObserver = observer
}

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
  if (process.platform === 'win32') {
    const command = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    )
    const script =
      'Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;started=$_.CreationDate.ToUniversalTime().Ticks.ToString()} } | ConvertTo-Json -Compress'
    return new Promise((resolve, reject) =>
      execFile(
        command,
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { timeout: 5000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (error, stdout) => {
          if (error) {
            reject(error)
            return
          }
          try {
            const parsed = JSON.parse(stdout)
            resolve(
              (Array.isArray(parsed) ? parsed : [parsed]).map(
                (entry: { pid: number; parent: number; started: string }) => ({
                  ...entry,
                  group: entry.pid,
                  state: '',
                }),
              ),
            )
          } catch (parseError) {
            reject(parseError)
          }
        },
      ),
    )
  }
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

/** Only call for processes created by this application; renderer-supplied PIDs are forbidden. */
export function ownProcessTree(
  pid: number,
  isRunning: () => boolean,
  isolatedGroup = false,
  expectedStarted?: string,
  expectedMembers: { pid: number; started: string }[] = [],
): OwnedProcessTree {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid)
    throw new Error('Invalid owned process')
  let released = false
  let pending: Promise<void> | undefined
  let identity: ProcessOwnership | undefined
  let rootStarted = expectedStarted
  const known = new Map(
    expectedMembers
      .filter((member) => member.pid !== pid || member.started === expectedStarted)
      .map((member) => [member.pid, member.started]),
  )
  const local = expectedStarted === undefined
  const bornAfter = Date.now() - 1000
  const remember = (targets: ProcessIdentity[], root?: ProcessIdentity): void => {
    if (root) rootStarted = root.started
    for (const target of targets) known.set(target.pid, target.started)
    if (released || !targets.length) return
    identity = {
      id: identity?.id ?? randomUUID(),
      pid,
      started: rootStarted ?? '',
      isolatedGroup,
      members: [...known].map(([pid, started]) => ({ pid, started })),
    }
    ownershipObserver?.({ action: 'register', process: identity })
  }
  const initial = local
    ? processSnapshot()
        .then((snapshot) => {
          const root = snapshot.find((entry) => entry.pid === pid)
          const targets = descendantProcesses(snapshot, pid, isolatedGroup)
          remember(targets, root)
        })
        .catch(() => {})
    : Promise.resolve()
  const tree: OwnedProcessTree = {
    release() {
      if (released) return
      released = true
      ownedTrees.delete(tree)
      if (identity) ownershipObserver?.({ action: 'release', process: identity })
    },
    terminate(force = false) {
      if (pending) return pending
      if (released) return Promise.resolve()
      pending = (async () => {
        await initial
        const snapshot = await processSnapshot()
        const root = snapshot.find((entry) => entry.pid === pid)
        const rootMatches = root && (rootStarted ? root.started === rootStarted : isRunning())
        const knownTargets = snapshot.filter((entry) => known.get(entry.pid) === entry.started)
        let targets: ProcessIdentity[]
        if (rootMatches) targets = descendantProcesses(snapshot, pid, isolatedGroup)
        else if (local && !root && isolatedGroup && process.platform !== 'win32') {
          // A live POSIX process group reserves its ID even after its leader exits.
          targets = descendantProcesses(snapshot, pid, true)
        } else if (local && !root && process.platform === 'win32') {
          const candidates = descendantProcesses(snapshot, pid, false)
          // Windows retains the creating parent PID. Exclude processes older than this launch.
          const floor = BigInt(Math.trunc(bornAfter)) * 10000n + 621355968000000000n
          targets = candidates.filter((entry) => BigInt(entry.started) >= floor)
        } else targets = knownTargets
        if (!local && !rootMatches && !knownTargets.length) {
          if (root) return // A recycled leader PID must never be targeted.
          if (isolatedGroup && snapshot.some((entry) => entry.group === pid))
            throw new Error(
              'Cannot verify the remaining process group identity. Ownership was retained.',
            )
          return
        }
        targets = [
          ...new Map([...targets, ...knownTargets].map((entry) => [entry.pid, entry])).values(),
        ].filter((entry) => entry.pid !== process.pid && !entry.state.startsWith('Z'))
        remember(targets, rootMatches ? root : undefined)
        if (!targets.length) return
        if (process.platform === 'win32') {
          const command = path.join(
            process.env.SystemRoot || 'C:\\Windows',
            'System32',
            'taskkill.exe',
          )
          for (const target of targets.filter((entry) => !rootMatches || entry.pid === pid)) {
            const current = (await processSnapshot()).find(
              (entry) => entry.pid === target.pid && entry.started === target.started,
            )
            if (!current) continue
            await new Promise<void>((resolve, reject) => {
              const killer = spawn(command, ['/PID', String(target.pid), '/T', '/F'], {
                windowsHide: true,
                stdio: 'ignore',
                shell: false,
              })
              const timer = setTimeout(() => {
                killer.kill()
                reject(new Error('Process tree termination timed out'))
              }, 4000)
              killer.once('error', (error) => {
                clearTimeout(timer)
                reject(error)
              })
              killer.once('close', (code) => {
                clearTimeout(timer)
                if (code === 0) resolve()
                else
                  void processSnapshot().then(
                    (current) =>
                      current.some(
                        (entry) => entry.pid === target.pid && entry.started === target.started,
                      )
                        ? reject(new Error('Unable to terminate owned process tree'))
                        : resolve(),
                    reject,
                  )
              })
            })
          }
        } else {
          for (const target of targets.filter((entry) => entry.pid !== pid))
            signalOwnedProcess(target, force ? 'SIGKILL' : 'SIGTERM')
          const leader = targets.find((entry) => entry.pid === pid)
          if (leader) signalOwnedProcess(leader, force ? 'SIGKILL' : 'SIGTERM')
          if (!force) await new Promise((resolve) => setTimeout(resolve, 600))
          const remaining = new Map((await processSnapshot()).map((entry) => [entry.pid, entry]))
          for (const before of targets) {
            const after = remaining.get(before.pid)
            if (after && after.started === before.started) signalOwnedProcess(after, 'SIGKILL')
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 80))
        const after = await processSnapshot()
        if (
          targets.some((target) =>
            after.some(
              (entry) =>
                entry.pid === target.pid &&
                entry.started === target.started &&
                !entry.state.startsWith('Z'),
            ),
          )
        )
          throw new Error('Owned processes did not stop. Ownership was retained.')
      })().then(
        () => tree.release(),
        (error) => {
          pending = undefined
          throw error
        },
      )
      return pending
    },
  }
  ownedTrees.add(tree)
  return tree
}

/** Main-process recovery uses only runtime-issued ownership records, never renderer PIDs. */
export async function terminateOwnedProcesses(records: ProcessOwnership[]): Promise<void> {
  if (!records.length) return
  const snapshot = await processSnapshot()
  const failures: unknown[] = []
  await Promise.all(
    records.map(async (record) => {
      const root = snapshot.find(
        (entry) => entry.pid === record.pid && entry.started === record.started,
      )
      const members = (record.members ?? []).filter(
        (member) => member.pid !== record.pid || member.started === record.started,
      )
      const knownMember = snapshot.some((entry) =>
        members.some((member) => member.pid === entry.pid && member.started === entry.started),
      )
      if (
        !root &&
        !knownMember &&
        process.platform === 'win32' &&
        !snapshot.some((entry) => entry.pid === record.pid) &&
        snapshot.some((entry) => entry.parent === record.pid)
      ) {
        failures.push(
          new Error(
            'Cannot verify Windows descendants after the owning parent exited. Ownership was retained.',
          ),
        )
        return
      }
      if (
        !root &&
        !knownMember &&
        !snapshot.some((entry) => record.isolatedGroup && entry.group === record.pid)
      )
        return
      try {
        const tree = ownProcessTree(
          record.pid,
          () => Boolean(root),
          record.isolatedGroup,
          record.started,
          members,
        )
        await tree.terminate()
      } catch (error) {
        failures.push(error)
      }
    }),
  )
  if (failures.length)
    throw new Error(`Unable to terminate ${failures.length} owned process tree(s).`)
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

/** Confirm cleanup after a natural parent exit, including children holding inherited pipes. */
export async function finalizeOwnedChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  await terminateProcessTree(child)
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
    child.once('exit', () => {
      // Descendants may inherit stdout: waiting for close can deadlock forever.
      void tree.terminate().then(
        () => ownedChildren.delete(child),
        () => {},
      )
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
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CommandResult> {
  await prepareEnvironment()
  if (options.signal?.aborted) throw new Error('Command cancelled')
  return new Promise((resolve, reject) => {
    const child = launch(command, args, cwd)
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let total = 0
    let failure: Error | undefined
    let cleanup: Promise<void> | undefined
    const stop = (error: Error, force = false): void => {
      failure = error
      if (!cleanup) {
        cleanup = terminateProcessTree(child, force)
        void cleanup.catch(reject)
      }
    }
    const abort = (): void => stop(new Error('Command cancelled'))
    options.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => {
      stop(new Error(`Command timed out: ${path.basename(command)}`))
    }, options.timeoutMs ?? 30_000)
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      total += chunk.length
      if (total > 8 * 1024 * 1024) {
        stop(new Error('Command output exceeds the 8 MB limit'), true)
      } else chunks.push(chunk)
    }
    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))
    child.once('error', (error) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      reject(error)
    })
    child.once('close', async (code) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      try {
        await (cleanup ?? finalizeOwnedChild(child))
      } catch (error) {
        reject(error)
        return
      }
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
    if (options.signal?.aborted) abort()
  })
}
