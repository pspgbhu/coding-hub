import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { AgentContext, EmitEvent } from '../../shared/runtime'
import type { AgentEvent, SessionStatus } from '../../shared/types'
import { redactDiagnostics } from '../../shared/diagnostics'

export type Reply = { decision?: string; answers?: Record<string, string[]> }
export type Payload = Omit<AgentEvent, 'id' | 'sessionId' | 'turnId' | 'timestamp'>

export class Turn {
  ended = false
  interrupted = false
  readonly pending = new Map<string, (reply: Reply) => void>()
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
    this.event({ kind: 'status', status })
  }
  ask(requestId: string, payload: Payload): Promise<Reply> {
    if (this.interrupted || this.ended) return Promise.resolve({ decision: 'deny' })
    this.status('waiting')
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve)
      this.event({ ...payload, requestId })
    })
  }
  respond(requestId: string, reply: Reply): void {
    const resolve = this.pending.get(requestId)
    if (!resolve) throw new Error('This request is no longer waiting for a response.')
    this.pending.delete(requestId)
    resolve(reply)
    if (!this.interrupted && !this.ended && this.pending.size === 0) this.status('running')
  }
  cancelPending(): void {
    this.interrupted = true
    for (const resolve of this.pending.values()) resolve({ decision: 'deny' })
    this.pending.clear()
  }
  finish(status: SessionStatus = this.interrupted ? 'interrupted' : 'idle', error?: unknown): void {
    if (this.ended) return
    if (error && !this.interrupted) this.event({ kind: 'error', text: errorMessage(error) })
    this.status(status)
    this.event({ kind: 'done', state: error && !this.interrupted ? 'error' : 'completed', status })
    this.ended = true
    for (const resolve of this.pending.values()) resolve({ decision: 'deny' })
    this.pending.clear()
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
