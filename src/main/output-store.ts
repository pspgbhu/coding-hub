import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { AgentEvent } from '../shared/types'
import { redactDiagnostics } from '../shared/diagnostics'

const PREVIEW = 64 * 1024
const MAX_OUTPUT = 32 * 1024 * 1024
const CAP_NOTICE = '\n[输出超过 32 MB 存储上限，后续内容未保存]\n'
const OMITTED_LINE = '[Diagnostic line omitted: exceeded size limit]\n'
type OutputIO = Pick<
  typeof fs,
  | 'openSync'
  | 'closeSync'
  | 'writeSync'
  | 'fsyncSync'
  | 'fstatSync'
  | 'ftruncateSync'
  | 'renameSync'
  | 'rmSync'
>
interface Stream {
  event: AgentEvent
  ref: string
  tail: string
  bytes: number
  capped: boolean
  pending: string
  dropping: boolean
}

/** Byte boundaries returned here always point between complete UTF-8 code points. */
function utf8Prefix(value: Buffer, limit: number): Buffer {
  let end = Math.min(value.length, Math.max(0, limit))
  while (end > 0 && end < value.length && (value[end] & 0xc0) === 0x80) end--
  return value.subarray(0, end)
}
function tail(value: string): string {
  const buffer = Buffer.from(value)
  let start = Math.max(0, buffer.length - PREVIEW)
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++
  return buffer.subarray(start).toString('utf8')
}

export class OutputStore {
  private streams = new Map<string, Stream>()
  private readonly folder: string
  constructor(
    dataDir: string,
    private readonly io: OutputIO = fs,
  ) {
    this.folder = join(dataDir, 'outputs')
    fs.mkdirSync(this.folder, { recursive: true, mode: 0o700 })
  }
  private path(ref: string): string {
    if (!/^[a-f\d]{64}$/.test(ref)) throw new Error('无效的输出引用。')
    return join(this.folder, ref + '.txt')
  }
  private writeAll(fd: number, buffer: Buffer, position: number): void {
    let offset = 0
    while (offset < buffer.length) {
      const written = this.io.writeSync(
        fd,
        buffer,
        offset,
        buffer.length - offset,
        position + offset,
      )
      if (written <= 0) throw new Error('无法保存工具输出。')
      offset += written
    }
  }
  /** Publish a complete, flushed replacement before changing either the blob or its metadata. */
  private replace(ref: string, value: string): void {
    const file = this.path(ref)
    const temporary = file + '.' + randomUUID() + '.tmp'
    let fd: number | undefined
    try {
      fd = this.io.openSync(temporary, 'wx', 0o600)
      this.writeAll(fd, Buffer.from(value), 0)
      this.io.fsyncSync(fd)
      this.io.closeSync(fd)
      fd = undefined
      this.io.renameSync(temporary, file)
    } finally {
      if (fd !== undefined) this.io.closeSync(fd)
      this.io.rmSync(temporary, { force: true })
    }
  }
  /** Roll back partially written appends; retry starts from the last committed byte count. */
  private append(record: Stream, value: string): void {
    if (!value) return
    const fd = this.io.openSync(this.path(record.ref), 'r+')
    try {
      const size = this.io.fstatSync(fd).size
      if (size < record.bytes) throw new Error('工具输出文件不完整，已保留待重试的数据。')
      if (size > record.bytes) this.io.ftruncateSync(fd, record.bytes)
      try {
        this.writeAll(fd, Buffer.from(value), record.bytes)
        this.io.fsyncSync(fd)
      } catch (error) {
        try {
          this.io.ftruncateSync(fd, record.bytes)
          this.io.fsyncSync(fd)
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            '工具输出保存和回滚失败，已保留待重试的数据。',
          )
        }
        throw error
      }
    } finally {
      this.io.closeSync(fd)
    }
  }
  private bounded(record: Stream, safe: string): { value: string; capped: boolean } {
    if (record.capped) return { value: '', capped: true }
    const buffer = Buffer.from(safe)
    // Keep this reserve even before truncation: a later chunk may arrive after the payload budget is full.
    const available = Math.max(0, MAX_OUTPUT - Buffer.byteLength(CAP_NOTICE) - record.bytes)
    if (buffer.length <= available) return { value: safe, capped: false }
    const prefix = utf8Prefix(buffer, available).toString('utf8')
    return { value: prefix + CAP_NOTICE, capped: true }
  }
  /** Pure framing means a failed disk write cannot consume a credential fragment. */
  private frame(
    record: Stream,
    chunk: string,
    finish: boolean,
  ): { safe: string; pending: string; dropping: boolean } {
    if (record.capped) return { safe: '', pending: '', dropping: false }
    let pending = record.pending + chunk
    let dropping = record.dropping
    const safe: string[] = []
    let end: number
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end + 1)
      pending = pending.slice(end + 1)
      if (!dropping) safe.push(line.length > MAX_OUTPUT ? OMITTED_LINE : redactDiagnostics(line))
      dropping = false
    }
    if (pending.length > MAX_OUTPUT) {
      if (!dropping) safe.push(OMITTED_LINE)
      pending = ''
      dropping = true
    }
    if (finish) {
      if (pending && !dropping) safe.push(redactDiagnostics(pending))
      pending = ''
      dropping = false
    }
    return { safe: safe.join(''), pending, dropping }
  }
  ingest(event: AgentEvent): AgentEvent {
    if (event.kind !== 'tool' || event.outputRef) return event
    const key = `${event.sessionId}:${event.turnId}:${event.itemId ?? event.id}`
    let record = this.streams.get(key)
    if (!record && event.output === undefined) return event
    const fresh = !record
    record ??= {
      event,
      ref: createHash('sha256').update(key).digest('hex'),
      tail: '',
      bytes: 0,
      capped: false,
      pending: '',
      dropping: false,
    }
    const finish = event.state === 'completed' || event.state === 'error'
    let next: Stream
    if (!event.outputDelta && event.output !== undefined) {
      const empty = { ...record, bytes: 0, capped: false }
      const { value, capped } = this.bounded(empty, redactDiagnostics(event.output))
      this.replace(record.ref, value)
      next = {
        ...record,
        tail: tail(value),
        bytes: Buffer.byteLength(value),
        capped,
        pending: '',
        dropping: false,
      }
    } else {
      const framed = this.frame(record, event.output ?? '', finish)
      const { value, capped } = this.bounded(record, framed.safe)
      if (fresh) this.replace(record.ref, value)
      else this.append(record, value)
      next = {
        ...record,
        tail: tail(record.tail + value),
        bytes: record.bytes + Buffer.byteLength(value),
        capped,
        pending: capped ? '' : framed.pending,
        dropping: capped ? false : framed.dropping,
      }
    }
    next.event = { ...event, output: undefined }
    if (finish) this.streams.delete(key)
    else this.streams.set(key, next)
    return this.preview(next)
  }
  private preview(record: Stream): AgentEvent {
    return {
      ...record.event,
      output: record.tail,
      outputDelta: false,
      outputRef: record.ref,
      outputBytes: record.bytes,
      outputTruncated: record.bytes > Buffer.byteLength(record.tail) || record.capped,
    }
  }
  finishTurn(sessionId: string, turnId: string, status?: string): AgentEvent[] {
    const result: AgentEvent[] = []
    for (const record of this.streams.values()) {
      if (record.event.sessionId !== sessionId || record.event.turnId !== turnId) continue
      const framed = this.frame(record, '', true)
      const { value, capped } = this.bounded(record, framed.safe)
      this.append(record, value)
      const next = {
        ...record,
        tail: tail(record.tail + value),
        bytes: record.bytes + Buffer.byteLength(value),
        capped,
        pending: '',
        dropping: false,
      }
      result.push({
        ...this.preview(next),
        id: randomUUID(),
        timestamp: Date.now(),
        state: status === 'idle' ? 'completed' : 'error',
      })
    }
    // Keep all framing state retryable if any file in this turn fails to flush.
    for (const [key, record] of this.streams) {
      if (record.event.sessionId === sessionId && record.event.turnId === turnId)
        this.streams.delete(key)
    }
    return result
  }
  async read(
    ref: string,
    offset = 0,
    limit = PREVIEW,
  ): Promise<{ text: string; total: number; hasMore: boolean; nextOffset: number }> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit <= 0)
      throw new Error('无效的输出分页范围。')
    const file = this.path(ref)
    const total = fs.statSync(file).size
    const handle = await open(file, 'r')
    try {
      // Up to three extra bytes guarantee progress even when the requested page is one byte.
      const buffer = Buffer.alloc(Math.min(limit + 3, Math.max(0, total - offset)))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      if (bytesRead && (buffer[0] & 0xc0) === 0x80)
        throw new Error('输出分页必须从完整 UTF-8 字符开始。')
      let end = Math.min(limit, bytesRead)
      let page = utf8Prefix(buffer.subarray(0, bytesRead), end)
      if (!page.length && bytesRead) {
        while (end < bytesRead && (buffer[end] & 0xc0) === 0x80) end++
        page = buffer.subarray(0, end)
      }
      const decoder = new StringDecoder('utf8')
      const text = decoder.write(page)
      const nextOffset = offset + Buffer.byteLength(text)
      return { text, total, hasMore: nextOffset < total, nextOffset }
    } finally {
      await handle.close()
    }
  }
}
