import { afterEach, describe, expect, it, vi } from 'vitest'
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
    waitForSingleObject: vi.fn((_handle: unknown, _milliseconds: number) => 258),
    terminateProcess: vi.fn(() => 1),
    closeHandle: vi.fn(() => 1),
    getLastError: vi.fn(() => 5),
  } satisfies WindowsProcessApi
  return { api, query, target, supervisor: createWindowsProcessSupervisor(api, 100) }
}
afterEach(() => vi.useRealTimers())

describe('pinned Windows native process identity', () => {
  it('captures synchronously with query/synchronize rights and keeps the process pinned after exit', async () => {
    const { api, supervisor, query } = fixture()
    const lease = supervisor.acquire(42)!
    expect(api.openProcess).toHaveBeenCalledWith(0x101000, 0, 42)
    expect(lease.pid).toBe(42)
    expect(lease.started).toBe((((exactBirth + epoch) / 10n) * 10n).toString())
    expect(lease.isAlive()).toBe(true)
    api.waitForSingleObject.mockReturnValue(0)
    expect(lease.isAlive()).toBe(false)
    await lease.terminate()
    expect(api.terminateProcess).not.toHaveBeenCalled()
    expect(api.closeHandle).not.toHaveBeenCalled()
    lease.close()
    lease.close()
    expect(api.closeHandle).toHaveBeenCalledExactlyOnceWith(query)
    expect(() => lease.isAlive()).toThrow('lease is closed')
    await expect(lease.terminate()).rejects.toThrow('lease is closed')
  })

  it('terminates through a separately opened handle while retaining the original query pin', async () => {
    vi.useFakeTimers()
    const { api, supervisor, query, target } = fixture()
    const lease = supervisor.acquire(42)!
    const completed = lease.terminate()
    expect(api.openProcess).toHaveBeenLastCalledWith(0x101001, 0, 42)
    expect(api.terminateProcess).toHaveBeenCalledExactlyOnceWith(target, 130)
    expect(api.closeHandle).toHaveBeenCalledExactlyOnceWith(target)
    expect(api.closeHandle).not.toHaveBeenCalledWith(query)
    // A successful request is asynchronous; completion still waits for this process's signal.
    expect(lease.isAlive()).toBe(true)
    expect(() => lease.close()).toThrow('exit confirmation is pending')
    api.waitForSingleObject.mockReturnValue(0)
    await vi.advanceTimersByTimeAsync(25)
    await completed
    expect(lease.isAlive()).toBe(false)
    lease.close()
    expect(api.closeHandle).toHaveBeenLastCalledWith(query)
  })

  it('rejects a different 100ns identity even when both births have the same CIM microsecond', async () => {
    const { api, supervisor, query, target } = fixture()
    const lease = supervisor.acquire(42)!
    api.getProcessTimes.mockImplementation((_handle, creation) => {
      creation.writeBigUInt64LE(exactBirth + 1n)
      return 1
    })
    await expect(lease.terminate()).rejects.toThrow('different native process birth identity')
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

  it('does not turn wait or non-racing termination errors into successful cleanup', async () => {
    const { api, supervisor, query, target } = fixture()
    const lease = supervisor.acquire(42)!
    api.waitForSingleObject.mockReturnValueOnce(0xffffffff)
    expect(() => lease.isAlive()).toThrow('WaitForSingleObject failed')
    api.getLastError.mockReturnValue(6)
    api.openProcess.mockReturnValueOnce(null as never)
    await expect(lease.terminate()).rejects.toThrow('OpenProcess for termination failed')
    api.terminateProcess.mockReturnValueOnce(0)
    await expect(lease.terminate()).rejects.toThrow('TerminateProcess failed')
    expect(api.closeHandle).toHaveBeenCalledExactlyOnceWith(target)
    expect(api.closeHandle).not.toHaveBeenCalledWith(query)
    expect(lease.isAlive()).toBe(true)
    lease.close()
  })

  it('accepts a concurrent native exit after a failed termination request without releasing its pin', async () => {
    const { api, supervisor } = fixture()
    const lease = supervisor.acquire(42)!
    api.terminateProcess.mockReturnValueOnce(0)
    api.waitForSingleObject.mockReturnValueOnce(258).mockReturnValueOnce(0)
    await expect(lease.terminate()).resolves.toBeUndefined()
    expect(api.closeHandle).toHaveBeenCalledTimes(1)
    lease.close()
  })

  it('waits asynchronously for a delayed process signal after error 5 and shares pending confirmation', async () => {
    vi.useFakeTimers()
    const { api, supervisor, query, target } = fixture()
    const lease = supervisor.acquire(42)!
    api.terminateProcess.mockReturnValueOnce(0)
    let confirmed = false
    const completed = lease.terminate(Date.now() + 100)
    expect(lease.terminate(Date.now() + 10000)).toBe(completed)
    void completed.then(() => {
      confirmed = true
    })
    let eventLoopRan = false
    setTimeout(() => {
      eventLoopRan = true
    }, 10)
    await vi.advanceTimersByTimeAsync(50)
    expect(eventLoopRan).toBe(true)
    expect(confirmed).toBe(false)
    expect(api.terminateProcess).toHaveBeenCalledOnce()
    expect(api.closeHandle).toHaveBeenCalledExactlyOnceWith(target)
    expect(api.closeHandle).not.toHaveBeenCalledWith(query)
    expect(api.waitForSingleObject.mock.calls.every((call) => call[1] === 0)).toBe(true)
    api.waitForSingleObject.mockReturnValue(0)
    await vi.advanceTimersByTimeAsync(25)
    await completed
    expect(confirmed).toBe(true)
    lease.close()
  })

  it.each(['open', 'terminate'] as const)(
    'rejects persistent error 5 at the original deadline and retains the pin (%s)',
    async (failure) => {
      vi.useFakeTimers()
      const { api, supervisor, query } = fixture()
      const lease = supervisor.acquire(42)!
      if (failure === 'open') api.openProcess.mockReturnValueOnce(null as never)
      else api.terminateProcess.mockReturnValueOnce(0)
      const deadline = Date.now() + 100
      const completed = lease.terminate(deadline)
      const rejected = expect(completed).rejects.toThrow('Windows error 5')
      await vi.advanceTimersByTimeAsync(99)
      expect(lease.isAlive()).toBe(true)
      expect(api.closeHandle).not.toHaveBeenCalledWith(query)
      expect(() => lease.close()).toThrow('exit confirmation is pending')
      await vi.advanceTimersByTimeAsync(1)
      await rejected
      expect(lease.isAlive()).toBe(true)
      expect(api.closeHandle).not.toHaveBeenCalledWith(query)
      // A later confirmed retry can finish; the failed wait never released the original pin.
      api.waitForSingleObject.mockReturnValue(0)
      await lease.terminate()
      lease.close()
      expect(api.closeHandle).toHaveBeenLastCalledWith(query)
    },
  )

  it('rejects wait failure during asynchronous confirmation without closing the query pin', async () => {
    vi.useFakeTimers()
    const { api, supervisor, query } = fixture()
    const lease = supervisor.acquire(42)!
    const completed = lease.terminate(Date.now() + 100)
    const rejected = expect(completed).rejects.toThrow('WaitForSingleObject failed')
    api.waitForSingleObject.mockReturnValue(0xffffffff)
    await vi.advanceTimersByTimeAsync(25)
    await rejected
    expect(api.closeHandle).not.toHaveBeenCalledWith(query)
    api.waitForSingleObject.mockReturnValue(0)
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
          await lease.terminate()
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
