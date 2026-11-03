import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TerminalOutput } from '../src/shared/types'

const fixture = vi.hoisted(() => ({ spawn: vi.fn(), own: vi.fn() }))
vi.mock('node-pty', () => ({ spawn: fixture.spawn }))
vi.mock('../src/runtime/process', () => ({
  prepareEnvironment: async () => {},
  getProcessEnvironment: () => ({}),
  ownProcessTree: fixture.own,
}))
import { TerminalService } from '../src/runtime/terminal'

class FakePty {
  pid = 12345
  data?: (value: string) => void
  exit?: (value: { exitCode: number }) => void
  onData(callback: (value: string) => void) {
    this.data = callback
  }
  onExit(callback: (value: { exitCode: number }) => void) {
    this.exit = callback
  }
  pause = vi.fn()
  resume = vi.fn()
  kill = vi.fn()
  write = vi.fn()
  resize = vi.fn()
}
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hub-terminal-lifecycle-'))
  fixture.spawn.mockReset()
  fixture.own.mockReset()
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('terminal shell exit waits for descendant confirmation', () => {
  it('retains ownership and workspace occupancy when shell exit races a failed late-descendant check, then supports a confirmed retry', async () => {
    const first = new FakePty(),
      second = new FakePty()
    let reject!: (error: Error) => void
    const tree = {
      release: vi.fn(),
      terminate: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((_resolve, fail) => {
              reject = fail
            }),
        )
        .mockResolvedValue(undefined),
    }
    const otherTree = { release: vi.fn(), terminate: vi.fn().mockResolvedValue(undefined) }
    fixture.spawn.mockReturnValueOnce(first).mockReturnValueOnce(second)
    fixture.own.mockReturnValueOnce(tree).mockReturnValueOnce(otherTree)
    const events: TerminalOutput[] = []
    const terminals = new TerminalService((event) => events.push(event))
    const id = await terminals.create(directory, 80, 24, 'first')
    const other = await terminals.create(directory, 80, 24, 'other')
    const close = terminals.close(id)
    const failed = expect(close).rejects.toThrow('late descendant')
    first.exit!({ exitCode: 7 })
    expect(tree.terminate).toHaveBeenCalledOnce()
    expect(tree.release).not.toHaveBeenCalled()
    expect(terminals.list('first')[0].exitCode).toBeUndefined()
    expect(events.some((event) => event.exitCode !== undefined)).toBe(false)
    reject(new Error('late descendant ownership is not confirmed'))
    await failed
    expect(terminals.attach(id).exitCode).toBeUndefined()
    expect(terminals.attach(id).buffer).toContain('工作区保持占用')
    expect(otherTree.terminate).not.toHaveBeenCalled()
    expect(second.kill).not.toHaveBeenCalled()

    await terminals.close(id)
    expect(terminals.attach(id).exitCode).toBe(7)
    expect(events.filter((event) => event.id === id && event.exitCode !== undefined)).toHaveLength(
      1,
    )
    expect(terminals.list('other')[0].id).toBe(other)
    expect(terminals.list('other')[0].exitCode).toBeUndefined()
    await terminals.closeAll()
  })

  it('confirms a natural shell exit without deadlocking, preserving final output and native exit code', async () => {
    const pty = new FakePty()
    let confirm!: () => void
    const tree = {
      release: vi.fn(),
      terminate: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            confirm = resolve
          }),
      ),
    }
    fixture.spawn.mockReturnValue(pty)
    fixture.own.mockReturnValue(tree)
    const events: TerminalOutput[] = []
    const terminals = new TerminalService((event) => events.push(event))
    const id = await terminals.create(directory, 80, 24)
    pty.data!('FINAL_OUTPUT 中文\r\n')
    pty.exit!({ exitCode: 23 })
    expect(terminals.attach(id).exitCode).toBeUndefined()
    expect(tree.release).not.toHaveBeenCalled()
    const pending = terminals.close(id)
    expect(tree.terminate).toHaveBeenCalledOnce()
    confirm()
    await pending
    expect(terminals.attach(id)).toMatchObject({
      exitCode: 23,
      buffer: expect.stringContaining('FINAL_OUTPUT 中文'),
    })
    expect(pty.kill).not.toHaveBeenCalled()
    expect(events.filter((event) => event.exitCode !== undefined)).toEqual([
      expect.objectContaining({ id, exitCode: 23 }),
    ])
    await terminals.closeAll()
  })
})
