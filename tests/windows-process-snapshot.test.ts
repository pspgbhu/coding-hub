import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessOwnershipEvent } from '../src/runtime/process'

const childProcess = vi.hoisted(() => ({ spawn: vi.fn() }))
const native = vi.hoisted(() => ({ acquire: vi.fn(), verified: vi.fn(), ensure: vi.fn() }))
vi.mock('../src/runtime/windows-process', () => ({
  acquireWindowsProcess: native.acquire,
  openVerifiedWindowsProcess: native.verified,
  ensureWindowsProcessApi: native.ensure,
}))
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: childProcess.spawn,
}))

interface Identity {
  pid: number
  parent: number
  started: string
}
class Inspector extends EventEmitter {
  stdin = Object.assign(new PassThrough(), { unref: vi.fn() })
  stdout = Object.assign(new PassThrough(), { unref: vi.fn() })
  stderr = Object.assign(new PassThrough(), { unref: vi.fn() })
  unref = vi.fn()
  closed = false
  kill = vi.fn(() => {
    if (this.closed) return false
    this.closed = true
    this.stdin.destroy()
    this.stdout.end()
    this.stderr.end()
    this.emit('close', 0)
    return true
  })
  respond(value: Identity[] | string): void {
    if (Array.isArray(value)) processes = value
    this.stdout.write((typeof value === 'string' ? value : JSON.stringify(value)) + '\n')
  }
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const rootPid = process.pid + 100000
const childPid = rootPid + 1
const otherPid = rootPid + 2
let started: string
const identity = (pid: number, parent: number): Identity => ({ pid, parent, started })
let runtime: typeof import('../src/runtime/process')
let inspectors: Inspector[]
let requests: Inspector[]
let processes: Identity[]
let respond: (inspector: Inspector) => void
let killed: number[]
let events: ProcessOwnershipEvent[]

beforeEach(async () => {
  vi.clearAllMocks()
  vi.resetModules()
  started = (BigInt(Date.now()) * 10000n + 621355968000000000n).toString()
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' })
  inspectors = []
  requests = []
  processes = []
  killed = []
  events = []
  respond = (inspector) => queueMicrotask(() => inspector.respond(processes))
  childProcess.spawn.mockImplementation((command: string, args: string[]) => {
    if (command.endsWith('powershell.exe')) {
      expect(args).toEqual([
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        expect.stringContaining("if ($request -ne 'snapshot') { exit 1 }"),
      ])
      const inspector = new Inspector()
      inspectors.push(inspector)
      let input = ''
      inspector.stdin.on('data', (chunk) => {
        input += String(chunk)
        while (input.includes('\n')) {
          const index = input.indexOf('\n')
          expect(input.slice(0, index)).toBe('snapshot')
          input = input.slice(index + 1)
          requests.push(inspector)
          respond(inspector)
        }
      })
      return inspector
    }
    throw new Error(`Unexpected process spawn: ${command}`)
  })
  native.acquire.mockImplementation((pid: number) => {
    const entry = processes.find((entry) => entry.pid === pid)
    if (!entry) return undefined
    let closed = false
    return {
      pid,
      started: entry.started,
      isAlive() {
        if (closed) throw new Error('Lease closed')
        return processes.some((current) => current.pid === pid && current.started === entry.started)
      },
      terminate() {
        if (closed) throw new Error('Lease closed')
        killed.push(pid)
        processes = processes.filter(
          (current) => current.pid !== pid || current.started !== entry.started,
        )
      },
      close() {
        closed = true
      },
    }
  })
  native.verified.mockImplementation((pid: number, started: string) => {
    const lease = native.acquire(pid)
    if (lease && lease.started !== started) {
      lease.close()
      return undefined
    }
    return lease
  })
  runtime = await import('../src/runtime/process')
  runtime.setProcessOwnershipObserver((event) => events.push(event))
})

afterEach(async () => {
  vi.useRealTimers()
  respond = (inspector) => queueMicrotask(() => inspector.respond([]))
  await runtime.closeAllProcesses()
  Object.defineProperty(process, 'platform', originalPlatform)
})

describe('fixed Windows process inspector', () => {
  it('does not adopt four older foreign workers through a recycled numeric parent PID', async () => {
    const older = (BigInt(started) - 20000000n).toString()
    const foreignWorkers = [1, 2, 3, 4].map((offset) => ({
      pid: childPid + offset,
      parent: rootPid,
      started: older,
    }))
    processes = [identity(rootPid, process.pid), ...foreignWorkers]
    runtime.ownProcessTree(rootPid, () => true)
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0].process.members).toEqual([{ pid: rootPid, started }])
  })

  it('does not adopt or kill a recycled root first observed after the launched child exits', async () => {
    processes = [identity(rootPid, process.pid)]
    const tree = runtime.ownProcessTree(rootPid, () => false)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    await new Promise((resolve) => setImmediate(resolve))
    await expect(tree.terminate()).rejects.toThrow('Ownership was retained')
    expect(killed).toEqual([])
    expect(events.some((event) => event.action === 'release')).toBe(false)
    expect(events.at(-1)?.process.members ?? []).toEqual([])
  })

  it('does not promote an unverified orphan merely because its birth is within one second', async () => {
    processes = []
    const tree = runtime.ownProcessTree(rootPid, () => false)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    await new Promise((resolve) => setImmediate(resolve))
    processes = [
      { pid: childPid, parent: rootPid, started: (BigInt(started) - 5000000n).toString() },
    ]
    await expect(tree.terminate()).rejects.toThrow('Ownership was retained')
    expect(killed).toEqual([])
    expect(events.at(-1)?.process.members ?? []).toEqual([])
  })

  it('rejects an older late descendant edge while preserving the unrelated process', async () => {
    const parent = { ...identity(childPid, rootPid), started: (BigInt(started) + 100n).toString() }
    const foreign = { pid: otherPid, parent: childPid, started: (BigInt(started) + 50n).toString() }
    processes = [identity(rootPid, process.pid), parent]
    const tree = runtime.ownProcessTree(rootPid, () => true)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    await new Promise((resolve) => setImmediate(resolve))
    processes = [...processes, foreign]
    await tree.terminate()
    expect(killed).toEqual([childPid, rootPid])
    expect(processes).toEqual([foreign])
    expect(
      events.filter((event) => event.action === 'register').at(-1)?.process.members,
    ).not.toContainEqual({ pid: otherPid, started: foreign.started })
  })

  it('never replaces a synchronously pinned root birth with a later numeric PID snapshot', async () => {
    processes = [identity(rootPid, process.pid)]
    const tree = runtime.ownProcessTree(rootPid, () => true)
    const newer = {
      ...identity(rootPid, process.pid),
      started: (BigInt(started) + 100n).toString(),
    }
    processes = [newer]
    await tree.terminate()
    expect(killed).toEqual([])
    expect(processes).toEqual([newer])
    expect(events[0].process.started).toBe(started)
    expect(events[0].process.members).toEqual([{ pid: rootPid, started }])
  })

  it('keeps ownership after a native CloseHandle failure and releases only after a successful retry', async () => {
    processes = [identity(rootPid, process.pid), identity(childPid, rootPid)]
    const tree = runtime.ownProcessTree(rootPid, () => true)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    await new Promise((resolve) => setImmediate(resolve))
    const rootLease = native.acquire.mock.results.find(
      (result) => result.value?.pid === rootPid,
    )!.value
    const close = vi.spyOn(rootLease, 'close').mockImplementationOnce(() => {
      throw new Error('injected CloseHandle failure')
    })
    await expect(tree.terminate()).rejects.toThrow('injected CloseHandle failure')
    expect(processes).toEqual([])
    expect(events.some((event) => event.action === 'release')).toBe(false)
    tree.release()
    expect(events.some((event) => event.action === 'release')).toBe(false)
    await tree.terminate()
    expect(close).toHaveBeenCalledTimes(2)
    expect(events.filter((event) => event.action === 'release')).toHaveLength(1)
  })

  it('requires a final fresh scan when the root exits after an earlier scan missed its last child', async () => {
    const root = identity(rootPid, process.pid)
    const late = identity(childPid, rootPid)
    processes = [root]
    const tree = runtime.ownProcessTree(rootPid, () => true)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    await new Promise((resolve) => setImmediate(resolve))
    let scans = 0
    respond = (inspector) =>
      queueMicrotask(() => {
        scans++
        inspector.respond(scans === 1 ? [root] : [late])
        // CIM captured root before it spawned its final child and exited. The
        // native handle is already signalled by the time that stale scan arrives.
        processes = [late]
      })
    await expect(tree.terminate()).rejects.toThrow('Ownership was retained')
    expect(scans).toBe(2)
    expect(killed).toEqual([])
    expect(events.some((event) => event.action === 'release')).toBe(false)
    expect(events.at(-1)?.process.members).toContainEqual({ pid: childPid, started })
    respond = (inspector) => queueMicrotask(() => inspector.respond(processes))
    await tree.terminate()
    expect(killed).toEqual([childPid])
    expect(processes).toEqual([])
    expect(events.at(-1)?.action).toBe('release')
  })

  it('never promotes a quarantined native identity or clears it merely because CIM misses one frame', async () => {
    const root = identity(rootPid, process.pid)
    const stale = identity(childPid, rootPid)
    const foreignBirth = (BigInt(started) + 100n).toString()
    let foreignAlive = true
    const acquire = native.acquire.getMockImplementation()!
    native.acquire.mockImplementation((pid: number) => {
      if (pid !== childPid) return acquire(pid)
      let closed = false
      return {
        pid,
        started: foreignBirth,
        isAlive() {
          if (closed) throw new Error('Lease closed')
          return foreignAlive
        },
        terminate() {
          throw new Error('An uncertain identity must never be terminated')
        },
        close() {
          closed = true
        },
      }
    })
    processes = [root, stale]
    const tree = runtime.ownProcessTree(rootPid, () => true)
    await vi.waitFor(() =>
      expect(events.at(-1)?.process.uncertainMembers).toEqual([
        { pid: childPid, started: foreignBirth },
      ]),
    )
    processes = [root, { ...stale, started: foreignBirth }]
    await expect(tree.terminate()).rejects.toThrow('Cannot verify process descendants')
    processes = [root] // A single CIM frame misses the still-live quarantined object.
    await expect(tree.terminate()).rejects.toThrow('Cannot verify process descendants')
    const retained = JSON.parse(JSON.stringify(events.at(-1)!.process))
    expect(retained.members).toEqual([{ pid: rootPid, started }])
    expect(retained.uncertainMembers).toEqual([{ pid: childPid, started: foreignBirth }])
    await expect(runtime.terminateOwnedProcesses([retained])).rejects.toThrow('Unable to terminate')
    expect(killed).toEqual([])
    tree.release()
    expect(events.some((event) => event.action === 'release')).toBe(false)
    foreignAlive = false
    processes = []
    await tree.terminate()
    expect(events.at(-1)?.action).toBe('release')
  })

  it('batches concurrent starts and obtains a new scan for post-exit confirmation', async () => {
    processes = [identity(rootPid, process.pid), identity(childPid, process.pid)]
    const first = runtime.ownProcessTree(rootPid, () => true)
    const second = runtime.ownProcessTree(childPid, () => true)
    await vi.waitFor(() =>
      expect(events.filter((event) => event.action === 'register')).toHaveLength(2),
    )
    expect(requests).toHaveLength(1)
    processes = []
    await Promise.all([first.terminate(), second.terminate()])
    expect(requests).toHaveLength(3)
    expect(inspectors).toHaveLength(1)
    expect(inspectors[0].unref).toHaveBeenCalledOnce()
    for (const stream of [inspectors[0].stdin, inspectors[0].stdout, inspectors[0].stderr])
      expect(stream.unref).toHaveBeenCalledOnce()
    expect(events.filter((event) => event.action === 'release')).toHaveLength(2)
    expect(killed).toEqual([])
  })

  it('never gives a late launch an already running older scan', async () => {
    respond = () => {}
    processes = [identity(rootPid, process.pid)]
    const first = runtime.ownProcessTree(rootPid, () => true)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    processes = [...processes, identity(childPid, process.pid)]
    const second = runtime.ownProcessTree(childPid, () => true)
    respond = (inspector) => queueMicrotask(() => inspector.respond(processes))
    inspectors[0].respond(processes)
    processes = [...processes, identity(childPid, process.pid)]
    await vi.waitFor(() =>
      expect(
        events.filter((event) => event.action === 'register').map((event) => event.process.pid),
      ).toEqual([rootPid, childPid]),
    )
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    processes = []
    await Promise.all([first.terminate(), second.terminate()])
    expect(requests).toHaveLength(4)
    expect(inspectors).toHaveLength(1)
  })

  it('cleans a child proven by a pinned exited parent and confirms native handle termination', async () => {
    processes = [identity(rootPid, process.pid), identity(otherPid, process.pid)]
    const tree = runtime.ownProcessTree(rootPid, () => true)
    await vi.waitFor(() => expect(events).toHaveLength(1))
    processes = [identity(childPid, rootPid), identity(otherPid, process.pid)]
    await tree.terminate()
    expect(killed).toEqual([childPid])
    expect(processes).toEqual([identity(otherPid, process.pid)])
    // Initial ownership, post-exit discovery, birth check, post-kill confirmation.
    expect(requests).toHaveLength(4)
    expect(events.at(-1)?.action).toBe('release')
  })

  it.each(['birth-check', 'post-check'])(
    'retains a verified late child during %s until a complete retry confirms cleanup',
    async (phase) => {
      const root = identity(rootPid, process.pid)
      const late = identity(childPid, rootPid)
      processes = [root]
      const tree = runtime.ownProcessTree(rootPid, () => true)
      await vi.waitFor(() => expect(events).toHaveLength(1))
      const scans = phase === 'birth-check' ? [[root], [late]] : [[root], [], [late]]
      respond = (inspector) => queueMicrotask(() => inspector.respond(scans.shift() ?? [late]))
      await expect(tree.terminate()).rejects.toThrow('Ownership was retained')
      expect(requests).toHaveLength(phase === 'birth-check' ? 3 : 4)
      expect(events.some((event) => event.action === 'release')).toBe(false)
      const retained = JSON.parse(
        JSON.stringify(events.filter((event) => event.action === 'register').at(-1)!.process),
      )
      // The original parent handle still reserves its PID, so this birth-ordered
      // direct child is now proved. It must still survive a rejected cleanup and
      // an external release until an explicit retry terminates its exact handle.
      expect(retained.members).toContainEqual({ pid: childPid, started })
      expect(retained.uncertainMembers).toBeUndefined()
      tree.release()
      expect(events.some((event) => event.action === 'release')).toBe(false)
      processes = [late]
      respond = (inspector) => queueMicrotask(() => inspector.respond(processes))
      await tree.terminate()
      expect(killed).toContain(childPid)
      expect(events.at(-1)?.action).toBe('release')
      expect(processes).toEqual([])
    },
  )

  it('can safely retry a late child whose still-live known parent has the same birth identity', async () => {
    const root = identity(rootPid, process.pid)
    const parent = identity(childPid, rootPid)
    const grandchild = identity(childPid + 100, childPid)
    processes = [root, parent]
    const tree = runtime.ownProcessTree(rootPid, () => true)
    await vi.waitFor(() => expect(events).toHaveLength(1))
    const scans = [
      [root, parent],
      [parent, grandchild],
    ]
    respond = (inspector) => queueMicrotask(() => inspector.respond(scans.shift() ?? processes))
    await expect(tree.terminate()).rejects.toThrow('Ownership was retained')
    expect(killed).toEqual([])
    const retained = events.filter((event) => event.action === 'register').at(-1)!.process
    expect(retained.members).toContainEqual({ pid: grandchild.pid, started })
    expect(retained.uncertainMembers).toBeUndefined()
    tree.release()
    expect(events.some((event) => event.action === 'release')).toBe(false)
    expect(requests).toHaveLength(3)
    processes = [parent, grandchild]
    respond = (inspector) => queueMicrotask(() => inspector.respond(processes))
    await tree.terminate()
    expect(killed).toEqual([grandchild.pid, childPid])
    expect(processes).toEqual([])
    expect(events.at(-1)?.action).toBe('release')
  })

  it('persists uncertainty for an unproved descendant chain without promoting or killing either member', async () => {
    const member = identity(childPid, rootPid)
    const grandchild = identity(childPid + 100, childPid)
    processes = [member]
    const tree = runtime.ownProcessTree(rootPid, () => false)
    await vi.waitFor(() => expect(events).toHaveLength(1))
    const first = JSON.parse(JSON.stringify(events[0].process))
    expect(first.members).toEqual([])
    expect(first.uncertainMembers).toEqual([{ pid: childPid, started }])
    processes = [grandchild]
    // Recovery retains suspicion through the absent, unverified parent as well.
    await expect(runtime.terminateOwnedProcesses([first])).rejects.toThrow('Unable to terminate')
    await expect(tree.terminate()).rejects.toThrow('Ownership was retained')
    const retained = JSON.parse(
      JSON.stringify(events.filter((event) => event.action === 'register').at(-1)!.process),
    )
    expect(retained.started).toBe('')
    expect(retained.members).toEqual([])
    expect(retained.uncertainMembers).toEqual([{ pid: grandchild.pid, started }])
    await expect(runtime.terminateOwnedProcesses([retained])).rejects.toThrow('Unable to terminate')
    tree.release()
    expect(killed).toEqual([])
    expect(events.some((event) => event.action === 'release')).toBe(false)
    processes = []
    await tree.terminate()
    expect(events.at(-1)?.action).toBe('release')
  })

  it('rejects a broken inspector without treating its failure as successful cleanup, then retries', async () => {
    processes = [identity(rootPid, process.pid)]
    const tree = runtime.ownProcessTree(rootPid, () => true)
    await vi.waitFor(() => expect(events).toHaveLength(1))
    respond = (inspector) => queueMicrotask(() => inspector.respond('{broken-json'))
    await expect(tree.terminate()).rejects.toThrow('Unable to decode process snapshot')
    expect(events.some((event) => event.action === 'release')).toBe(false)
    expect(inspectors[0].kill).toHaveBeenCalledOnce()
    respond = (inspector) => queueMicrotask(() => inspector.respond([]))
    await tree.terminate()
    expect(inspectors).toHaveLength(2)
    expect(events.at(-1)?.action).toBe('release')
    await runtime.closeAllProcesses()
    expect(inspectors[1].kill).toHaveBeenCalledOnce()
  })

  it('times out an unresponsive inspector and retains ownership until a confirmed retry', async () => {
    processes = [identity(rootPid, process.pid)]
    const tree = runtime.ownProcessTree(rootPid, () => true)
    await vi.waitFor(() => expect(events).toHaveLength(1))
    vi.useFakeTimers()
    respond = () => {}
    const attempt = tree.terminate()
    const rejected = expect(attempt).rejects.toThrow('Process snapshot timed out')
    await vi.advanceTimersByTimeAsync(5001)
    await rejected
    expect(inspectors[0].kill).toHaveBeenCalledOnce()
    expect(events.some((event) => event.action === 'release')).toBe(false)
    vi.useRealTimers()
    respond = (inspector) => queueMicrotask(() => inspector.respond([]))
    await tree.terminate()
    expect(inspectors).toHaveLength(2)
    expect(events.at(-1)?.action).toBe('release')
  })

  it('does not respawn an inspector for a queued ownership scan after final shutdown', async () => {
    respond = () => {}
    const first = runtime.ownProcessTree(rootPid, () => true)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    first.release()
    const second = runtime.ownProcessTree(childPid, () => true)
    second.release()
    const closing = runtime.closeAllProcesses()
    expect(events.some((event) => event.action === 'release')).toBe(false)
    respond = (inspector) => queueMicrotask(() => inspector.respond([]))
    inspectors[0].respond([identity(rootPid, process.pid), identity(childPid, process.pid)])
    await closing
    await new Promise((resolve) => setImmediate(resolve))
    expect(inspectors).toHaveLength(1)
    expect(requests.length).toBeGreaterThanOrEqual(2)
    expect(inspectors[0].kill).toHaveBeenCalledOnce()
  })

  it('blocks external release while a termination scan is pending and releases only after fresh confirmation', async () => {
    processes = [identity(rootPid, process.pid)]
    const tree = runtime.ownProcessTree(rootPid, () => true)
    await vi.waitFor(() => expect(events).toHaveLength(1))
    respond = () => {}
    const stopping = tree.terminate()
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    tree.release()
    expect(events.some((event) => event.action === 'release')).toBe(false)
    processes = []
    respond = (inspector) => queueMicrotask(() => inspector.respond([]))
    inspectors[0].respond([])
    await stopping
    expect(events.filter((event) => event.action === 'release')).toHaveLength(1)
    expect(killed).toEqual([])
  })

  it.each(['stdout', 'stderr'] as const)(
    'rejects %s pipe errors and preserves ownership',
    async (stream) => {
      processes = [identity(rootPid, process.pid)]
      const tree = runtime.ownProcessTree(rootPid, () => true)
      await vi.waitFor(() => expect(events).toHaveLength(1))
      respond = () => {}
      const attempt = tree.terminate()
      const rejected = expect(attempt).rejects.toThrow(
        stream === 'stdout'
          ? 'Process snapshot output closed'
          : 'Process snapshot diagnostics closed',
      )
      await vi.waitFor(() => expect(requests).toHaveLength(2))
      inspectors[0][stream].emit('error', new Error('injected pipe failure'))
      await rejected
      expect(events.some((event) => event.action === 'release')).toBe(false)
      respond = (inspector) => queueMicrotask(() => inspector.respond([]))
      await tree.terminate()
      expect(events.at(-1)?.action).toBe('release')
    },
  )

  it('rejects inspector stdout EOF before its timeout instead of reporting an empty snapshot', async () => {
    processes = [identity(rootPid, process.pid)]
    const tree = runtime.ownProcessTree(rootPid, () => true)
    await vi.waitFor(() => expect(events).toHaveLength(1))
    respond = () => {}
    const attempt = tree.terminate()
    const rejected = expect(attempt).rejects.toThrow('Process snapshot output closed')
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    inspectors[0].stdout.end()
    await rejected
    expect(events.some((event) => event.action === 'release')).toBe(false)
    respond = (inspector) => queueMicrotask(() => inspector.respond([]))
    await tree.terminate()
    expect(events.at(-1)?.action).toBe('release')
  })

  it.each([
    { pid: -1 },
    { pid: 0 },
    { pid: 0x100000000 },
    { pid: 1.5 },
    { parent: -1 },
    { parent: 0x100000000 },
    { started: '-1' },
    { started: '0' },
    { started: '00123' },
    { started: 'not-utc-ticks' },
    { started: '3155378976000000000' },
  ])(
    'rejects invalid process identity fields %j instead of confirming cleanup',
    async (invalid) => {
      processes = [identity(rootPid, process.pid)]
      const tree = runtime.ownProcessTree(rootPid, () => true)
      await vi.waitFor(() => expect(events).toHaveLength(1))
      respond = (inspector) =>
        queueMicrotask(() => inspector.respond([{ ...identity(rootPid, process.pid), ...invalid }]))
      await expect(tree.terminate()).rejects.toThrow('Unable to decode process snapshot')
      expect(events.some((event) => event.action === 'release')).toBe(false)
      respond = (inspector) => queueMicrotask(() => inspector.respond([]))
      await tree.terminate()
      expect(events.at(-1)?.action).toBe('release')
    },
  )
})
