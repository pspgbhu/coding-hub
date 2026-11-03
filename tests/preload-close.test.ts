import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppAPI } from '../src/shared/types'

const fixture = vi.hoisted(() => ({
  listeners: new Map<string, Set<(...args: any[]) => unknown>>(),
  api: undefined as unknown as AppAPI,
  send: vi.fn(),
}))
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, value: AppAPI) => {
      fixture.api = value
    },
  },
  ipcRenderer: {
    invoke: vi.fn(),
    send: fixture.send,
    on: (name: string, callback: (...args: any[]) => unknown) => {
      if (!fixture.listeners.has(name)) fixture.listeners.set(name, new Set())
      fixture.listeners.get(name)!.add(callback)
    },
    removeListener: (name: string, callback: (...args: any[]) => unknown) => {
      fixture.listeners.get(name)?.delete(callback)
    },
  },
}))
import '../src/preload/index'

const cleanup: (() => void)[] = []
afterEach(() => {
  cleanup.splice(0).forEach((unregister) => unregister())
  fixture.send.mockClear()
})
async function prepare(payload: unknown) {
  await Promise.all(
    [...(fixture.listeners.get('hub:prepare-close') ?? [])].map((callback) =>
      callback({}, payload),
    ),
  )
}
describe('typed preload close acknowledgement', () => {
  it('hides the nonce from the page and acknowledges only after its async saves finish', async () => {
    let finish!: () => void
    const flush = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    cleanup.push(fixture.api.onPrepareClose(flush))
    const pending = prepare({ nonce: 'native-close-nonce' })
    expect(flush).toHaveBeenCalledExactlyOnceWith()
    expect(fixture.send).not.toHaveBeenCalled()
    finish()
    await pending
    expect(fixture.send).toHaveBeenCalledExactlyOnceWith('hub:close-ready', {
      nonce: 'native-close-nonce',
    })
  })
  it('rejects failed saves without exposing raw error contents and supports cancellation events', async () => {
    cleanup.push(
      fixture.api.onPrepareClose(async () => {
        throw new Error('password=should-not-leak')
      }),
    )
    await prepare({ nonce: 'failed-close' })
    expect(fixture.send).toHaveBeenCalledWith('hub:close-ready', {
      nonce: 'failed-close',
      error: expect.any(String),
    })
    expect(JSON.stringify(fixture.send.mock.calls)).not.toContain('should-not-leak')
    const cancelled = vi.fn()
    cleanup.push(fixture.api.onCloseCancelled(cancelled))
    for (const callback of fixture.listeners.get('hub:close-cancelled') ?? [])
      callback({}, undefined)
    expect(cancelled).toHaveBeenCalledOnce()
  })
  it('ignores malformed requests and does not acknowledge a listener that has unmounted', async () => {
    let finish!: () => void
    const flush = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const unregister = fixture.api.onPrepareClose(flush)
    await prepare({ nonce: 42 })
    expect(flush).not.toHaveBeenCalled()
    const pending = prepare({ nonce: 'unmounted-close' })
    unregister()
    finish()
    await pending
    expect(fixture.send).not.toHaveBeenCalled()
  })
})
