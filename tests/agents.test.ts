import { describe, expect, it } from 'vitest'
import { AsyncQueue, JsonLines, Turn } from '../src/runtime/adapters/common'
import { ClaudeMessages } from '../src/runtime/adapters/claude'
import { SseDecoder } from '../src/runtime/adapters/opencode'
import { versionSupported } from '../src/runtime/agents'
import type { AgentEvent } from '../src/shared/types'
import type { AgentContext } from '../src/shared/runtime'

const context: AgentContext = {
  cwd: '/tmp',
  session: {
    id: 'app-session',
    projectId: 'project',
    provider: 'claude',
    title: 'Test',
    status: 'idle',
    archived: false,
    createdAt: 0,
    updatedAt: 0,
  },
}

describe('agent event contracts', () => {
  it('frames UTF-8 NDJSON when a Chinese character spans byte chunks', () => {
    const messages: unknown[] = [],
      errors: Error[] = []
    const lines = new JsonLines(
      (message) => messages.push(message),
      (error) => errors.push(error),
    )
    const bytes = Buffer.from('{"text":"你好"}\r\n{"last":true}')
    for (const byte of bytes) lines.push(Buffer.from([byte]))
    lines.end()
    expect(messages).toEqual([{ text: '你好' }, { last: true }])
    expect(errors).toEqual([])
  })
  it('reports corrupt JSON instead of silently dropping agent messages', () => {
    const errors: Error[] = []
    const lines = new JsonLines(
      () => {},
      (error) => errors.push(error),
    )
    lines.push('{"text":}\n')
    expect(errors[0].message).toContain('Invalid agent JSON')
  })
  it('decodes multiline SSE with split CRLF and multibyte text', () => {
    const events: unknown[] = []
    const decoder = new SseDecoder((event) => events.push(event))
    const bytes = Buffer.from(
      ': heartbeat\r\ndata: {"type":"text",\r\ndata: "text":"你好"}\r\n\r\n',
    )
    for (const byte of bytes) decoder.push(Buffer.from([byte]))
    expect(events).toEqual([{ type: 'text', text: '你好' }])
  })
  it('resolves pending approval on cancellation and finishes once', async () => {
    const events: AgentEvent[] = []
    const turn = new Turn(context, 'turn-1', (event) => events.push(event))
    const reply = turn.ask('request-1', { kind: 'approval', name: 'Bash' })
    expect(events.at(-1)?.kind).toBe('approval')
    turn.cancelPending()
    turn.finish()
    turn.finish('error', new Error('late error'))
    expect(await reply).toEqual({ decision: 'deny' })
    expect(events.filter((event) => event.kind === 'done')).toHaveLength(1)
    expect(events.at(-1)?.status).toBe('interrupted')
    expect(
      events.every(
        (event) =>
          event.id &&
          event.timestamp &&
          event.sessionId === 'app-session' &&
          event.turnId === 'turn-1',
      ),
    ).toBe(true)
  })
  it('keeps failed native replies pending and records only acknowledged decisions', async () => {
    const events: AgentEvent[] = []
    const turn = new Turn(context, 'turn', (event) => events.push(event))
    let attempts = 0
    const answer = turn.ask('permission', { kind: 'approval' }, async () => {
      if (++attempts === 1) throw new Error('Native reply failed')
    })
    await expect(turn.respond('permission', { decision: 'allow' })).rejects.toThrow(
      'Native reply failed',
    )
    expect(turn.pending.has('permission')).toBe(true)
    expect(events.at(-1)).toMatchObject({ kind: 'requestResolved', resolution: 'failed' })
    await turn.respond('permission', { decision: 'always' })
    expect(await answer).toEqual({ decision: 'always' })
    expect(turn.pending.size).toBe(0)
    expect(events.findLast((event) => event.kind === 'requestResolved')).toMatchObject({
      resolution: 'approved',
      decision: 'always',
      scope: 'session',
    })
  })
  it('retains the running turn after an unconfirmed stop and resolves external requests', async () => {
    const events: AgentEvent[] = []
    const turn = new Turn(context, 'turn', (event) => events.push(event))
    const pending = turn.ask('external', { kind: 'approval' })
    turn.resolveExternal('external')
    expect(await pending).toMatchObject({ external: true })
    turn.beginStop()
    turn.failStop(new Error('Server still busy'))
    turn.status('running')
    expect(turn.ended).toBe(false)
    expect(events.at(-1)).toMatchObject({ kind: 'status', status: 'stop_failed' })
    expect(events.some((event) => event.kind === 'done')).toBe(false)
  })
  it('records a declined permission even when the UI includes an empty answers object', async () => {
    const events: AgentEvent[] = []
    const turn = new Turn(context, 'turn', (event) => events.push(event))
    const pending = turn.ask('declined', { kind: 'approval' })
    await turn.respond('declined', { decision: 'decline', answers: {} })
    await pending
    expect(events.find((event) => event.kind === 'requestResolved')).toMatchObject({
      resolution: 'denied',
      decision: 'decline',
    })
  })
  it('keeps Claude token deltas distinct and does not replay final text', () => {
    const events: AgentEvent[] = []
    const messages = new ClaudeMessages(new Turn(context, 'turn-2', (event) => events.push(event)))
    messages.receive({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'native-message' } },
    })
    messages.receive({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } },
    })
    messages.receive({
      type: 'assistant',
      message: {
        id: 'native-message',
        content: [
          { type: 'text', text: '你好' },
          { type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: 'a.ts' } },
        ],
      },
    })
    messages.receive({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'contents' }] },
    })
    expect(events.filter((event) => event.kind === 'text')).toHaveLength(1)
    expect(events.find((event) => event.kind === 'text')).toMatchObject({
      text: '你好',
      delta: true,
      itemId: 'native-message:0',
    })
    expect(events.filter((event) => event.kind === 'tool').at(-1)).toMatchObject({
      itemId: 'call-1',
      output: 'contents',
      state: 'completed',
    })
  })
  it('reconciles Claude single-block snapshots after a thinking block without suppressing valid repeated responses', () => {
    const events: AgentEvent[] = []
    const messages = new ClaudeMessages(
      new Turn(context, 'thinking-turn', (event) => events.push(event)),
    )
    messages.receive({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'main-response' } },
    })
    messages.receive({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
    })
    messages.receive({
      type: 'assistant',
      message: { id: 'main-response', content: [{ type: 'thinking', thinking: 'private' }] },
    })
    messages.receive({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
    })
    // Another scope can start while the main message is still streaming.
    messages.receive({
      type: 'stream_event',
      parent_tool_use_id: 'subagent',
      event: { type: 'message_start', message: { id: 'child-response' } },
    })
    messages.receive({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '你好' } },
    })
    messages.receive({
      type: 'assistant',
      message: { id: 'main-response', content: [{ type: 'text', text: '你好' }] },
    })
    messages.receive({
      type: 'assistant',
      message: { id: 'next-response', content: [{ type: 'text', text: '你好' }] },
    })
    const text = events.filter((event) => event.kind === 'text')
    expect(text).toHaveLength(2)
    expect(text[0]).toMatchObject({ itemId: 'main-response:1', text: '你好', delta: true })
    expect(text[1]).toMatchObject({ itemId: 'next-response:0', text: '你好', delta: false })
  })
  it('ends an input queue that is waiting for another user turn', async () => {
    const queue = new AsyncQueue<string>()
    const iterator = queue[Symbol.asyncIterator]()
    queue.push('first')
    expect(await iterator.next()).toEqual({ done: false, value: 'first' })
    const waiting = iterator.next()
    queue.end()
    expect(await waiting).toEqual({ done: true, value: undefined })
  })
  it('enforces tested CLI minimum versions', () => {
    expect(versionSupported('Claude Code 2.1.236', '2.1.236')).toBe(true)
    expect(versionSupported('codex-cli 0.151.0', '0.151.0')).toBe(true)
    expect(versionSupported('2.1.235', '2.1.236')).toBe(false)
    expect(versionSupported('unknown', '1.19.5')).toBe(false)
  })
})
