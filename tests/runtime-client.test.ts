import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('electron', () => ({ utilityProcess: { fork: fixture.fork } }))

import { RuntimeClient } from '../src/main/runtime-client'

class FakeUtilityProcess extends EventEmitter {
  stderr = new EventEmitter()
  stdout = new EventEmitter()
  postMessage = vi.fn((message: { id: string; method: string; args: unknown[] }) => {
    if (message.method === 'shutdown')
      queueMicrotask(() => this.emit('message', { type: 'response', id: message.id, result: null }))
  })
  kill = vi.fn(() => {
    queueMicrotask(() => this.emit('exit', 0))
    return true
  })
}

beforeEach(() => {
  fixture.fork.mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('runtime client startup and shutdown races', () => {
  it('retries a new utility process after fork throws synchronously', async () => {
    const child = new FakeUtilityProcess()
    fixture.fork
      .mockImplementationOnce(() => {
        throw new Error('utility fork failed')
      })
      .mockReturnValueOnce(child)
    const client = new RuntimeClient()

    await expect(client.start()).rejects.toThrow('utility fork failed')
    const retry = client.start()
    expect(fixture.fork).toHaveBeenCalledTimes(2)
    child.emit('message', { type: 'ready' })
    await expect(retry).resolves.toBeUndefined()

    await client.close()
    expect(child.postMessage.mock.calls.map(([message]) => message.method)).toEqual(['shutdown'])
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('blocks a request waiting for ready when close begins, while still delivering shutdown', async () => {
    const child = new FakeUtilityProcess()
    fixture.fork.mockReturnValue(child)
    const client = new RuntimeClient()
    const request = client.call('agent.start', { sessionId: 'session' })
    const rejected = expect(request).rejects.toThrow('应用正在退出')
    expect(fixture.fork).toHaveBeenCalledOnce()
    expect(child.postMessage).not.toHaveBeenCalled()

    const closing = client.close()
    expect(child.postMessage).not.toHaveBeenCalled()
    child.emit('message', { type: 'ready' })
    await rejected
    await closing

    expect(child.postMessage.mock.calls.map(([message]) => message.method)).toEqual(['shutdown'])
    expect(child.kill).toHaveBeenCalledOnce()
    await expect(client.call('agent.start')).rejects.toThrow('应用正在退出')
    expect(fixture.fork).toHaveBeenCalledOnce()
  })
})
