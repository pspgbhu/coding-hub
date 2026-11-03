import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { AgentContext, EmitEvent } from '../../shared/runtime'
import type { AgentEvent, SessionStatus } from '../../shared/types'
import { redactDiagnostics } from '../../shared/diagnostics'

export type Reply = {
  decision?: string
  answers?: Record<string, string[]>
  permissions?: Record<string, unknown>
  scope?: 'turn' | 'session'
  external?: boolean
}
export type Payload = Omit<AgentEvent, 'id' | 'sessionId' | 'turnId' | 'timestamp'>

export class Turn {
  ended = false
  interrupted = false
  stopState: 'none' | 'stopping' | 'failed' | 'confirmed' = 'none'
  readonly pending = new Map<
    string,
    {
      resolve: (reply: Reply) => void
      deliver?: (reply: Reply) => Promise<void>
      submitting: boolean
      scope?: AgentEvent['scope']
      kind: AgentEvent['kind']
    }
  >()
  constructor(
    readonly context: AgentContext,
    readonly turnId: string,
    private readonly emitEvent: EmitEvent,
  ) {}
  event(payload: Payload): void {
    if (this.ended) return
    this.emitEvent({
      id: randomUUID(),
      sessionId: this.context.session.id,
      turnId: this.turnId,
      timestamp: Date.now(),
      ...payload,
    })
  }
  status(status: SessionStatus): void {
    if (
      ['stopping', 'failed'].includes(this.stopState) &&
      ['starting', 'running', 'waiting'].includes(status)
    )
      return
    this.event({ kind: 'status', status })
  }
  ask(
    requestId: string,
    payload: Payload,
    deliver?: (reply: Reply) => Promise<void>,
  ): Promise<Reply> {
    if (this.interrupted || this.ended) return Promise.resolve({ decision: 'deny' })
    if (this.pending.has(requestId)) throw new Error('The provider reused an active request ID.')
    this.status('waiting')
    return new Promise((resolve) => {
      this.pending.set(requestId, {
        resolve,
        deliver,
        submitting: false,
        scope: payload.scope,
        kind: payload.kind,
      })
      this.event({ ...payload, requestId })
    })
  }
  async respond(requestId: string, reply: Reply): Promise<void> {
    const request = this.pending.get(requestId)
    if (!request || this.interrupted || this.ended)
      throw new Error('This request is no longer waiting for a response.')
    if (request.submitting) throw new Error('This response is already being submitted.')
    request.submitting = true
    try {
      await request.deliver?.(reply)
    } catch (error) {
      request.submitting = false
      this.event({
        kind: 'requestResolved',
        requestId,
        resolution: 'failed',
        state: 'error',
        text: errorMessage(error),
      })
      throw error
    }
    if (this.pending.get(requestId) !== request) return
    this.pending.delete(requestId)
    const accepted =
      request.kind === 'question'
        ? Boolean(
            reply.answers && Object.values(reply.answers).some((answers) => answers.length > 0),
          )
        : approved(reply.decision)
    this.resolved(requestId, accepted ? 'approved' : 'denied', {
      ...reply,
      scope: reply.scope ?? (request.scope === 'once' ? undefined : request.scope),
    })
    request.resolve(reply)
    if (!this.interrupted && !this.ended && this.pending.size === 0) this.status('running')
  }
  resolveExternal(requestId: string): void {
    const request = this.pending.get(requestId)
    if (!request || request.submitting) return
    this.pending.delete(requestId)
    this.resolved(requestId, 'external')
    request.resolve({ decision: 'deny', external: true })
    if (!this.pending.size) this.status('running')
  }
  private resolved(
    requestId: string,
    resolution: NonNullable<AgentEvent['resolution']>,
    reply?: Reply,
  ): void {
    this.event({
      kind: 'requestResolved',
      requestId,
      resolution,
      decision: reply?.decision,
      answers: reply?.answers,
      scope:
        reply?.scope ??
        (['always', 'acceptForSession', 'allow-session'].includes(reply?.decision ?? '')
          ? 'session'
          : 'once'),
      state: 'completed',
    })
  }
  cancelPending(): void {
    this.interrupted = true
    for (const [requestId, request] of this.pending) {
      this.resolved(requestId, 'cancelled', { decision: 'deny' })
      request.resolve({ decision: 'deny' })
    }
    this.pending.clear()
  }
  beginStop(): void {
    if (this.ended) return
    this.stopState = 'stopping'
    this.status('stopping')
    this.cancelPending()
  }
  failStop(error: unknown): void {
    if (this.ended) return
    this.stopState = 'failed'
    this.event({
      kind: 'error',
      text: `Unable to confirm that the agent stopped: ${errorMessage(error)}`,
    })
    this.status('stop_failed')
  }
  finish(status: SessionStatus = this.interrupted ? 'interrupted' : 'idle', error?: unknown): void {
    if (this.ended) return
    this.stopState = 'confirmed'
    if (error && !this.interrupted) this.event({ kind: 'error', text: errorMessage(error) })
    this.status(status)
    for (const [requestId, request] of this.pending) {
      this.resolved(requestId, 'expired')
      request.resolve({ decision: 'deny' })
    }
    this.pending.clear()
    this.event({ kind: 'done', state: error && !this.interrupted ? 'error' : 'completed', status })
    this.ended = true
  }
}

export function errorMessage(error: unknown): string {
  return redactDiagnostics(error instanceof Error ? error.message : String(error))
}
export function approved(decision?: string): boolean {
  return [
    'allow',
    'approve',
    'accept',
    'once',
    'always',
    'acceptForSession',
    'allow-session',
  ].includes(decision ?? '')
}
export function outputText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value))
    return value
      .map((v) => (typeof v === 'object' && v && 'text' in v ? String(v.text) : ''))
      .filter(Boolean)
      .join('\n')
  return value == null ? '' : JSON.stringify(value, null, 2)
}

export function inputImages(context: AgentContext): {
  name: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  data: string
  dataUrl: string
}[] {
  return (context.input?.context ?? [])
    .filter((item) => item.kind === 'image')
    .map((item) => {
      const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
        item.dataUrl ?? '',
      )
      if (!match || match[2].length > 14 * 1024 * 1024)
        throw new Error('Images must be PNG, JPEG, GIF or WebP data URLs below 10 MB.')
      return {
        name: item.name,
        mimeType: match[1] as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
        data: match[2],
        dataUrl: item.dataUrl!,
      }
    })
}

/** Decode bytes before framing lines: a UTF-8 character may span pipe chunks. */
export class JsonLines {
  private readonly decoder = new StringDecoder('utf8')
  private buffer = ''
  constructor(
    private readonly receive: (value: Record<string, any>) => void,
    private readonly fail: (error: Error) => void,
  ) {}
  push(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    if (this.buffer.length > 16 * 1024 * 1024) {
      this.buffer = ''
      this.fail(new Error('Agent output exceeded the 16 MB message limit.'))
      return
    }
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      this.line(line)
    }
  }
  end(): void {
    this.buffer += this.decoder.end()
    if (this.buffer.trim()) this.line(this.buffer.trim())
    this.buffer = ''
  }
  private line(line: string): void {
    if (!line || !line.startsWith('{')) return
    try {
      this.receive(JSON.parse(line))
    } catch (error) {
      this.fail(new Error(`Invalid agent JSON: ${errorMessage(error)}`))
    }
  }
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = []
  private waiting?: (value: IteratorResult<T>) => void
  private closed = false
  push(value: T): void {
    if (this.closed) return
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = undefined
      resolve({ value, done: false })
    } else this.values.push(value)
  }
  end(): void {
    this.closed = true
    this.values = []
    this.waiting?.({ value: undefined, done: true })
    this.waiting = undefined
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift()
        if (value !== undefined) return Promise.resolve({ value, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => {
          this.waiting = resolve
        })
      },
    }
  }
}
