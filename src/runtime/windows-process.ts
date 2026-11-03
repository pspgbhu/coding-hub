import { createRequire } from 'node:module'

const PROCESS_TERMINATE = 0x0001
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const SYNCHRONIZE = 0x00100000
const WAIT_OBJECT_0 = 0
const WAIT_TIMEOUT = 258
const ERROR_INVALID_PARAMETER = 87
const ERROR_ACCESS_DENIED = 5
const EXIT_CONFIRMATION_MS = 4000
const FILETIME_EPOCH_TICKS = 504911232000000000n

export interface WindowsProcessLease {
  readonly pid: number
  /** UTC .NET ticks at CIM's microsecond precision; the exact FILETIME stays pinned internally. */
  readonly started: string
  isAlive(): boolean
  /** Resolves only after native exit confirmation within the caller's existing cleanup deadline. */
  terminate(deadline?: number): Promise<void>
  close(): void
}

export interface WindowsProcessApi {
  openProcess(access: number, inherit: number, pid: number): unknown
  getProcessTimes(
    handle: unknown,
    creation: Buffer,
    exit: Buffer,
    kernel: Buffer,
    user: Buffer,
  ): number
  waitForSingleObject(handle: unknown, milliseconds: number): number
  terminateProcess(handle: unknown, exitCode: number): number
  closeHandle(handle: unknown): number
  getLastError(): number
}

/** Small injectable boundary for tests; no handle or arbitrary native function crosses IPC. */
export function createWindowsProcessSupervisor(api: WindowsProcessApi, currentPid = process.pid) {
  const failed = (operation: string) =>
    new Error(`${operation} failed (Windows error ${api.getLastError()}).`)
  const birth = (handle: unknown): bigint => {
    const creation = Buffer.alloc(8)
    if (!api.getProcessTimes(handle, creation, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)))
      throw failed('GetProcessTimes')
    const value = creation.readBigUInt64LE()
    if (!value) throw new Error('GetProcessTimes returned an invalid process birth identity.')
    return value
  }
  const closeHandle = (handle: unknown): void => {
    if (!api.closeHandle(handle)) throw failed('CloseHandle')
  }
  const acquire = (pid: number): WindowsProcessLease | undefined => {
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid > 0xffffffff || pid === currentPid)
      throw new Error('Refusing an invalid or current process identifier.')
    const rights = PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE
    const handle = api.openProcess(rights, 0, pid)
    if (handle == null) {
      const code = api.getLastError()
      if (code === ERROR_INVALID_PARAMETER) return undefined
      throw new Error(`OpenProcess failed (Windows error ${code}).`)
    }
    let exactBirth: bigint
    try {
      exactBirth = birth(handle)
    } catch (error) {
      closeHandle(handle)
      throw error
    }
    // CIM_DATETIME has six fractional decimal digits. Preserve its existing ledger format,
    // while all termination-handle checks below compare the full native 100ns identity.
    const started = (((exactBirth + FILETIME_EPOCH_TICKS) / 10n) * 10n).toString()
    let closed = false
    let terminating: Promise<void> | undefined
    const assertOpen = (): void => {
      if (closed) throw new Error('The Windows process lease is closed.')
    }
    const isAlive = (): boolean => {
      assertOpen()
      const result = api.waitForSingleObject(handle, 0)
      if (result === WAIT_OBJECT_0) return false
      if (result === WAIT_TIMEOUT) return true
      throw failed('WaitForSingleObject')
    }
    const waitForExit = async (deadline: number, failure?: Error): Promise<void> => {
      while (isAlive()) {
        const remaining = deadline - Date.now()
        if (remaining <= 0)
          throw (
            failure ??
            new Error('Windows process exit was not confirmed before the cleanup deadline.')
          )
        // Never block the runtime/main event loop in a native wait. The original query pin
        // remains valid throughout, including when Windows is still cancelling pending I/O.
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)))
      }
    }
    return {
      pid,
      started,
      isAlive,
      terminate(deadline = Date.now() + EXIT_CONFIRMATION_MS) {
        if (terminating) return terminating
        const operation = (async () => {
          assertOpen()
          if (!Number.isFinite(deadline)) throw new Error('Invalid Windows cleanup deadline.')
          if (!isAlive()) return
          if (Date.now() >= deadline)
            throw new Error('Windows process exit was not confirmed before the cleanup deadline.')
          // Keep the query handle open: it pins this process object/PID even after exit.
          // Request termination rights only when needed, without weakening initial capture.
          const target = api.openProcess(rights | PROCESS_TERMINATE, 0, pid)
          if (target == null) {
            const code = api.getLastError()
            const error = new Error(`OpenProcess for termination failed (Windows error ${code}).`)
            if (code !== ERROR_ACCESS_DENIED) throw error
            await waitForExit(deadline, error)
            return
          }
          let exitFailure: Error | undefined
          try {
            if (birth(target) !== exactBirth)
              throw new Error(
                'The termination handle has a different native process birth identity.',
              )
            if (!api.terminateProcess(target, 130)) {
              const code = api.getLastError()
              const error = new Error(`TerminateProcess failed (Windows error ${code}).`)
              if (code !== ERROR_ACCESS_DENIED) throw error
              // Error 5 can accompany a process already exiting. It is never success by
              // itself: only this exact pinned process object's signalled state confirms exit.
              exitFailure = error
            }
          } finally {
            closeHandle(target)
          }
          await waitForExit(deadline, exitFailure)
        })()
        terminating = operation
        void operation.then(
          () => {
            terminating = undefined
          },
          () => {
            terminating = undefined
          },
        )
        return operation
      },
      close() {
        if (closed) return
        if (terminating)
          throw new Error(
            'Cannot close a Windows process lease while exit confirmation is pending.',
          )
        closeHandle(handle)
        closed = true
      },
    }
  }
  return {
    acquire,
    openVerified(pid: number, started: string): WindowsProcessLease | undefined {
      const lease = acquire(pid)
      if (lease && lease.started !== started) {
        lease.close()
        return undefined
      }
      return lease
    },
  }
}

let supervisor: ReturnType<typeof createWindowsProcessSupervisor> | undefined
const nativeRequire = createRequire(import.meta.url)

/** Load and bind before spawning anything, so a missing native module cannot leave an unowned CLI. */
export function ensureWindowsProcessApi(): void {
  if (process.platform !== 'win32' || supervisor) return
  try {
    const koffi = nativeRequire('koffi') as typeof import('koffi')
    const kernel = koffi.load('kernel32.dll')
    supervisor = createWindowsProcessSupervisor({
      openProcess: kernel.func(
        'void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)',
      ),
      getProcessTimes: kernel.func(
        'int __stdcall GetProcessTimes(void *handle, void *creation, void *exit, void *kernel, void *user)',
      ),
      waitForSingleObject: kernel.func(
        'uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t ms)',
      ),
      terminateProcess: kernel.func(
        'int __stdcall TerminateProcess(void *handle, uint32_t exitCode)',
      ),
      closeHandle: kernel.func('int __stdcall CloseHandle(void *handle)'),
      getLastError: kernel.func('uint32_t __stdcall GetLastError()'),
    })
  } catch {
    throw new Error('Windows process supervision is unavailable. New execution has been blocked.')
  }
}

function nativeSupervisor() {
  ensureWindowsProcessApi()
  if (!supervisor) throw new Error('Windows process supervision is only available on Windows.')
  return supervisor
}

/** Call immediately after spawn returns, before yielding to the event loop or its exit callback. */
export function acquireWindowsProcess(pid: number): WindowsProcessLease | undefined {
  return nativeSupervisor().acquire(pid)
}

/** CIM/legacy-ledger precision only: a match never establishes previously unknown ancestry. */
export function openVerifiedWindowsProcess(
  pid: number,
  started: string,
): WindowsProcessLease | undefined {
  return nativeSupervisor().openVerified(pid, started)
}
