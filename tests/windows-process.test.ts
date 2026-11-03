import { describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import {
  acquireWindowsProcess,
  createWindowsProcessSupervisor,
  ensureWindowsProcessApi,
  openVerifiedWindowsProcess,
  type WindowsProcessApi,
  type WindowsProcessLease,
} from '../src/runtime/windows-process'

const exactBirth = 133000000000000007n
const epoch = 504911232000000000n
function fixture() {
  const query = { kind: 'query' }
  const target = { kind: 'terminate' }
  const api = {
    openProcess: vi.fn((access: number) => (access & 1 ? target : query)),
    getProcessTimes: vi.fn((_handle: unknown, creation: Buffer) => {
      creation.writeBigUInt64LE(exactBirth)
      return 1
    }),
    waitForSingleObject: vi.fn(() => 258),
    terminateProcess: vi.fn(() => 1),
    closeHandle: vi.fn(() => 1),
    getLastError: vi.fn(() => 5),
  } satisfies WindowsProcessApi
  return { api, query, target, supervisor: createWindowsProcessSupervisor(api, 100) }
}

describe('pinned Windows native process identity', () => {
  it('captures synchronously with query/synchronize rights and keeps the process pinned after exit', () => {
    const { api, supervisor, query } = fixture()
    const lease = supervisor.acquire(42)!
    expect(api.openProcess).toHaveBeenCalledWith(0x101000, 0, 42)
    expect(lease.pid).toBe(42)
    expect(lease.started).toBe((((exactBirth + epoch) / 10n) * 10n).toString())
    expect(lease.isAlive()).toBe(true)
    api.waitForSingleObject.mockReturnValue(0)
    expect(lease.isAlive()).toBe(false)
    lease.terminate()
    expect(api.terminateProcess).not.toHaveBeenCalled()
    expect(api.closeHandle).not.toHaveBeenCalled()
    lease.close()
    lease.close()
    expect(api.closeHandle).toHaveBeenCalledExactlyOnceWith(query)
    expect(() => lease.isAlive()).toThrow('lease is closed')
    expect(() => lease.terminate()).toThrow('lease is closed')
  })

  it('terminates through a separately opened handle while retaining the original query pin', () => {
    const { api, supervisor, query, target } = fixture()
    const lease = supervisor.acquire(42)!
    lease.terminate()
    expect(api.openProcess).toHaveBeenLastCalledWith(0x101001, 0, 42)
    expect(api.terminateProcess).toHaveBeenCalledExactlyOnceWith(target, 130)
    expect(api.closeHandle).toHaveBeenCalledExactlyOnceWith(target)
    expect(api.closeHandle).not.toHaveBeenCalledWith(query)
    // A successful request is asynchronous; the lease must still report the native wait state.
    expect(lease.isAlive()).toBe(true)
    api.waitForSingleObject.mockReturnValue(0)
    expect(lease.isAlive()).toBe(false)
    lease.close()
    expect(api.closeHandle).toHaveBeenLastCalledWith(query)
  })

  it('rejects a different 100ns identity even when both births have the same CIM microsecond', () => {
    const { api, supervisor, query, target } = fixture()
    const lease = supervisor.acquire(42)!
    api.getProcessTimes.mockImplementation((_handle, creation) => {
      creation.writeBigUInt64LE(exactBirth + 1n)
      return 1
    })
    expect(() => lease.terminate()).toThrow('different native process birth identity')
    expect(api.terminateProcess).not.toHaveBeenCalled()
    expect(api.closeHandle).toHaveBeenCalledExactlyOnceWith(target)
    expect(api.closeHandle).not.toHaveBeenCalledWith(query)
    lease.close()
  })

  it.each([0, 1, -1, 1.5, NaN, 0x100000000, 100])('never opens a forbidden PID: %s', (pid) => {
    const { api, supervisor } = fixture()
    expect(() => supervisor.acquire(pid)).toThrow('invalid or current process identifier')
    expect(api.openProcess).not.toHaveBeenCalled()
  })

  it('distinguishes a missing process from access or query failure and closes a failed capture', () => {
    const { api, supervisor, query } = fixture()
    api.openProcess.mockReturnValueOnce(null as never)
    api.getLastError.mockReturnValueOnce(87)
    expect(supervisor.acquire(42)).toBeUndefined()
    api.openProcess.mockReturnValueOnce(null as never)
    expect(() => supervisor.acquire(42)).toThrow('OpenProcess failed (Windows error 5)')
    api.getProcessTimes.mockReturnValueOnce(0)
    expect(() => supervisor.acquire(42)).toThrow('GetProcessTimes failed')
    expect(api.closeHandle).toHaveBeenCalledExactlyOnceWith(query)
  })

  it('does not turn wait or live-process termination failures into successful cleanup', () => {
    const { api, supervisor, query, target } = fixture()
    const lease = supervisor.acquire(42)!
    api.waitForSingleObject.mockReturnValueOnce(0xffffffff)
    expect(() => lease.isAlive()).toThrow('WaitForSingleObject failed')
    api.openProcess.mockReturnValueOnce(null as never)
    expect(() => lease.terminate()).toThrow('OpenProcess for termination failed')
    api.terminateProcess.mockReturnValueOnce(0)
    expect(() => lease.terminate()).toThrow('TerminateProcess failed')
    expect(api.closeHandle).toHaveBeenCalledExactlyOnceWith(target)
    expect(api.closeHandle).not.toHaveBeenCalledWith(query)
    expect(lease.isAlive()).toBe(true)
    lease.close()
  })

  it('accepts a concurrent native exit after a failed termination request without releasing its pin', () => {
    const { api, supervisor } = fixture()
    const lease = supervisor.acquire(42)!
    api.terminateProcess.mockReturnValueOnce(0)
    api.waitForSingleObject.mockReturnValueOnce(258).mockReturnValueOnce(0)
    expect(() => lease.terminate()).not.toThrow()
    expect(api.closeHandle).toHaveBeenCalledTimes(1)
    lease.close()
  })

  it('retains a lease when closing fails, and only closes once after a successful retry', () => {
    const { api, supervisor } = fixture()
    const lease = supervisor.acquire(42)!
    api.closeHandle.mockReturnValueOnce(0)
    expect(() => lease.close()).toThrow('CloseHandle failed')
    expect(lease.isAlive()).toBe(true)
    lease.close()
    lease.close()
    expect(api.closeHandle).toHaveBeenCalledTimes(2)
  })

  it('closes a mismatched historical candidate without terminating it or promoting its identity', () => {
    const { api, supervisor, query } = fixture()
    expect(supervisor.openVerified(42, 'unrelated historical identity')).toBeUndefined()
    expect(api.closeHandle).toHaveBeenCalledExactlyOnceWith(query)
    expect(api.terminateProcess).not.toHaveBeenCalled()
    const started = (((exactBirth + epoch) / 10n) * 10n).toString()
    const verified = supervisor.openVerified(42, started)!
    expect(verified.started).toBe(started)
    verified.close()
  })

  it.skipIf(process.platform === 'win32')('does not load Koffi or kernel32 on macOS', () => {
    expect(() => ensureWindowsProcessApi()).not.toThrow()
  })

  it.skipIf(process.platform !== 'win32')(
    'pins an immediately exiting native child before its Node exit callback and releases only after confirmation',
    async () => {
      ensureWindowsProcessApi()
      const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
        stdio: 'ignore',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once('exit', resolve)
        child.once('error', reject)
      })
      let lease: WindowsProcessLease | undefined
      let same: WindowsProcessLease | undefined
      try {
        // No await/event-loop turn may separate spawn's PID and native identity capture.
        lease = acquireWindowsProcess(child.pid!)
        expect(lease).toBeDefined()
        if (!lease) throw new Error('The immediate native child was not captured.')
        expect(lease.started).toMatch(/^[1-9]\d+0$/)
        expect(await exited).toBe(0)
        expect(lease.isAlive()).toBe(false)
        // Windows retains the exited process object and PID while our query handle remains open.
        same = openVerifiedWindowsProcess(child.pid!, lease.started)
        expect(same).toBeDefined()
        expect(same?.isAlive()).toBe(false)
      } finally {
        same?.close()
        if (lease?.isAlive()) {
          lease.terminate()
          await exited
        } else if (!lease) {
          // The exact ChildProcess handle is safe even if native capture itself failed.
          child.kill()
          await exited
        }
        lease?.close()
      }
    },
  )
})
