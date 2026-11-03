import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushBeforeClose, registerCloseFlush } from '../src/renderer/lib/close-flush'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((unregister) => unregister()))
describe('renderer recovery-buffer shutdown barrier', () => {
  it('flushes the current draft and every mounted hidden workspace using their latest values', async () => {
    let latest = 'previous text'
    const saves: string[] = []
    cleanup.push(
      registerCloseFlush(async () => {
        saves.push(latest)
      }),
    )
    cleanup.push(
      registerCloseFlush(async () => {
        saves.push('hidden workspace buffer')
      }),
    )
    latest = 'last keystroke before quit'
    await flushBeforeClose()
    expect(saves).toEqual(['last keystroke before quit', 'hidden workspace buffer'])
  })
  it('does not acknowledge a failed flush before the other writes have settled', async () => {
    let finish!: () => void
    let finished = false
    cleanup.push(
      registerCloseFlush(async () => {
        throw new Error('SQLITE_FULL')
      }),
    )
    cleanup.push(
      registerCloseFlush(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          }),
      ),
    )
    const result = flushBeforeClose()
      .then(
        () => 'saved',
        (error) => error.message,
      )
      .finally(() => {
        finished = true
      })
    await Promise.resolve()
    await Promise.resolve()
    expect(finished).toBe(false)
    finish()
    expect(await result).toBe('SQLITE_FULL')
  })
  it('unregisters unmounted buffers and allows a later retry after storage recovers', async () => {
    const unmounted = vi.fn(async () => {})
    const unregister = registerCloseFlush(unmounted)
    unregister()
    let broken = true
    cleanup.push(
      registerCloseFlush(async () => {
        if (broken) throw new Error('disk full')
      }),
    )
    await expect(flushBeforeClose()).rejects.toThrow('disk full')
    broken = false
    await expect(flushBeforeClose()).resolves.toBeUndefined()
    expect(unmounted).not.toHaveBeenCalled()
  })
})
