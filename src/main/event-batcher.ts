import type { AgentEvent } from '../shared/types'

/** Preserve protocol ordering while batching only append-only chunks for the same item. */
export class EventBatcher {
  private pending = new Map<string, { event: AgentEvent; chunks: string[] }>()
  private timer?: NodeJS.Timeout
  private bytes = 0
  constructor(
    private readonly emit: (event: AgentEvent) => void,
    private readonly delay = 50,
  ) {}
  push(event: AgentEvent): void {
    const text = event.kind === 'text' && event.delta ? event.text : undefined
    const output = event.kind === 'tool' && event.outputDelta ? event.output : undefined
    if (!event.itemId || (text === undefined && output === undefined)) {
      this.flush()
      this.emit(event)
      return
    }
    const key = `${event.sessionId}:${event.turnId}:${event.kind}:${event.itemId}`
    const previous = this.pending.get(key)
    if (previous) {
      previous.event = event
      previous.chunks.push(text ?? output ?? '')
    } else this.pending.set(key, { event, chunks: [text ?? output ?? ''] })
    this.bytes += Buffer.byteLength(text ?? output ?? '')
    if (this.bytes >= 128 * 1024) {
      this.flush()
      return
    }
    this.timer ??= setTimeout(() => this.flush(), this.delay)
  }
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const records = [...this.pending.values()]
    this.pending.clear()
    this.bytes = 0
    for (const { event, chunks } of records)
      this.emit({
        ...event,
        ...(event.kind === 'text' ? { text: chunks.join('') } : { output: chunks.join('') }),
      })
  }
}
