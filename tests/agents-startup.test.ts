import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../src/shared/types'
import type { AgentContext } from '../src/shared/runtime'

const fixture = vi.hoisted(() => ({ failStop: false }))
vi.mock('../src/runtime/process', () => ({
  resolveCommand: async () => '/fixture/cli',
  runCommand: async (
    _path: string,
    _args: string[],
    _cwd: string,
    options: { signal?: AbortSignal } = {},
  ) =>
    new Promise((_resolve, reject) => {
      options.signal?.addEventListener(
        'abort',
        () =>
          reject(
            new Error(
              fixture.failStop ? 'Unable to terminate owned process tree' : 'Command cancelled',
            ),
          ),
        { once: true },
      )
    }),
}))
import { AgentManager } from '../src/runtime/agents'

const context: AgentContext = {
  cwd: '/fixture',
  session: {
    id: 'startup',
    projectId: 'project',
    provider: 'codex',
    title: 'Test',
    status: 'idle',
    archived: false,
    createdAt: 0,
    updatedAt: 0,
  },
}
describe('agent startup cancellation', () => {
  it('waits for startup cancellation and preserves ownership when termination fails', async () => {
    const events: AgentEvent[] = []
    const manager = new AgentManager((event) => events.push(event))
    fixture.failStop = true
    await manager.send(context, 'Work', 'turn')
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(manager.interrupt('startup')).rejects.toThrow('Unable to terminate')
    expect(events.at(-1)).toMatchObject({ kind: 'status', status: 'stop_failed' })
    expect(events.some((event) => event.kind === 'done')).toBe(false)
    await expect(manager.send(context, 'Other work', 'other')).rejects.toThrow('already running')
    await manager.close().catch(() => {})
    fixture.failStop = false
  })
  it('emits starting, stopping and one interrupted completion after successful cancellation', async () => {
    const events: AgentEvent[] = []
    const manager = new AgentManager((event) => events.push(event))
    await manager.send(context, 'Work', 'turn')
    await new Promise((resolve) => setTimeout(resolve, 0))
    await manager.interrupt('startup')
    expect(events.filter((event) => event.kind === 'status').map((event) => event.status)).toEqual([
      'starting',
      'stopping',
      'interrupted',
    ])
    expect(events.filter((event) => event.kind === 'done')).toHaveLength(1)
    await manager.close()
  })
})
