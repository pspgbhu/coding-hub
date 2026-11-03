import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { EventBatcher } from '../src/main/event-batcher'
import { OutputStore } from '../src/main/output-store'
import { Store } from '../src/main/store'
import type { AgentEvent } from '../src/shared/types'
const folders: string[] = []
const directory = () => {
  const folder = mkdtempSync(join(tmpdir(), 'hub-output-'))
  folders.push(folder)
  return folder
}
const event = (extra: Partial<AgentEvent> = {}): AgentEvent => ({
  id: randomUUID(),
  sessionId: randomUUID(),
  turnId: randomUUID(),
  kind: 'tool',
  itemId: 'command',
  timestamp: Date.now(),
  ...extra,
})
afterEach(() => {
  vi.useRealTimers()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})
describe('stream batching preserves identity and control ordering', () => {
  it('batches a thousand chunks into one durable item before an approval, then respects a full snapshot', () => {
    vi.useFakeTimers()
    const store = new Store(join(directory(), 'test.db'))
    const project = store.addProject(directory(), 'fixture')
    const session = store.createSession(project.id, 'codex')
    const turnId = randomUUID()
    const delivered: AgentEvent[] = []
    const batch = new EventBatcher((e) => {
      delivered.push(e)
      store.append(e)
    })
    for (let i = 0; i < 1000; i++)
      batch.push(
        event({
          sessionId: session.id,
          turnId,
          kind: 'text',
          itemId: 'answer',
          delta: true,
          text: '中文',
        }),
      )
    expect(delivered).toHaveLength(0)
    batch.push(event({ sessionId: session.id, turnId, kind: 'approval', requestId: 'request' }))
    expect(delivered.map((e) => e.kind)).toEqual(['text', 'approval'])
    expect(store.view(session.id).events[0].text).toBe('中文'.repeat(1000))
    batch.push(
      event({
        sessionId: session.id,
        turnId,
        kind: 'text',
        itemId: 'answer',
        delta: false,
        text: '最终回答',
      }),
    )
    expect(store.view(session.id).events[0].text).toBe('最终回答')
    vi.advanceTimersByTime(60)
    expect(delivered).toHaveLength(3)
    store.close()
  })
  it('keeps text and tool-output chunks separate and flushes buffered tool output before completion', () => {
    const delivered: AgentEvent[] = []
    const batch = new EventBatcher((e) => delivered.push(e))
    const base = event()
    batch.push({ ...base, id: randomUUID(), output: 'first ', outputDelta: true })
    batch.push({ ...base, id: randomUUID(), output: 'second', outputDelta: true })
    batch.push({ ...base, id: randomUUID(), state: 'completed' })
    expect(delivered[0].output).toBe('first second')
    expect(delivered[1].state).toBe('completed')
  })
})
describe('bounded tool history with paged, redacted full output', () => {
  it('keeps a multi-megabyte result out of ordinary history and reads complete UTF-8 pages', async () => {
    const output = new OutputStore(directory())
    const original = '中文🙂'.repeat(220000)
    const preview = output.ingest(event({ output: original, state: 'completed' }))
    expect(Buffer.byteLength(preview.output!)).toBeLessThanOrEqual(64 * 1024)
    expect(preview.outputTruncated).toBe(true)
    expect(preview.outputBytes).toBe(Buffer.byteLength(original))
    let all = '',
      offset = 0
    do {
      const page = await output.read(preview.outputRef!, offset, 32000)
      all += page.text
      expect(page.nextOffset).toBeGreaterThan(offset)
      offset = page.nextOffset
      if (!page.hasMore) break
    } while (true)
    expect(all).toBe(original)
  })
  it('redacts credentials split across native output chunks and flushes a final non-newline tail', async () => {
    const output = new OutputStore(directory())
    const base = event()
    output.ingest({ ...base, output: 'Authorization: Bea', outputDelta: true })
    output.ingest({
      ...base,
      id: randomUUID(),
      output: 'rer hiddencredential123456789\n你好末尾',
      outputDelta: true,
    })
    const [finished] = output.finishTurn(base.sessionId, base.turnId, 'idle')
    const full = await output.read(finished.outputRef!)
    expect(full.text).not.toContain('hiddencredential')
    expect(full.text).toContain('[redacted]')
    expect(full.text).toContain('你好末尾')
    expect(finished.state).toBe('completed')
  })
  it('uses a final native full snapshot instead of appending its duplicate output', async () => {
    const output = new OutputStore(directory())
    const base = event()
    output.ingest({ ...base, output: 'partial\n', outputDelta: true })
    const final = output.ingest({
      ...base,
      id: randomUUID(),
      output: 'partial\ncomplete\n',
      outputDelta: false,
      state: 'completed',
    })
    expect((await output.read(final.outputRef!)).text).toBe('partial\ncomplete\n')
    await expect(output.read('../secret')).rejects.toThrow('无效')
  })
  it('keeps the previous blob and metadata when replacement writing or publishing fails', async () => {
    const folder = directory()
    let failWrite = false,
      failRename = false
    const io = {
      ...fs,
      writeSync: ((...args: Parameters<typeof fs.writeSync>) => {
        if (failWrite) {
          failWrite = false
          throw new Error('disk write failed')
        }
        return (fs.writeSync as (...a: Parameters<typeof fs.writeSync>) => number)(...args)
      }) as typeof fs.writeSync,
      renameSync: ((...args: Parameters<typeof fs.renameSync>) => {
        if (failRename) {
          failRename = false
          throw new Error('rename failed')
        }
        return fs.renameSync(...args)
      }) as typeof fs.renameSync,
    }
    const output = new OutputStore(folder, io)
    const base = event()
    const previous = output.ingest({ ...base, output: 'previous 中文🙂\n', outputDelta: true })
    for (const fail of ['write', 'rename']) {
      if (fail === 'write') failWrite = true
      else failRename = true
      expect(() =>
        output.ingest({
          ...base,
          id: randomUUID(),
          output: 'replacement 中文🙂\n',
          state: 'completed',
        }),
      ).toThrow()
      expect((await output.read(previous.outputRef!)).text).toBe('previous 中文🙂\n')
      expect(readdirSync(join(folder, 'outputs'))).toEqual([previous.outputRef + '.txt'])
    }
    const final = output.ingest({
      ...base,
      id: randomUUID(),
      output: 'replacement 中文🙂\n',
      state: 'completed',
    })
    expect((await output.read(final.outputRef!)).text).toBe('replacement 中文🙂\n')
    expect(final.outputBytes).toBe(Buffer.byteLength('replacement 中文🙂\n'))
  })
  it('rolls back partial append failures and retries the exact credential framing state', async () => {
    let failWrite = false
    const io = {
      ...fs,
      writeSync: ((
        fd: number,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => {
        if (failWrite) {
          failWrite = false
          fs.writeSync(fd, buffer, offset, Math.min(4, length), position)
          throw new Error('partial disk write failed')
        }
        return fs.writeSync(fd, buffer, offset, length, position)
      }) as typeof fs.writeSync,
    }
    const output = new OutputStore(directory(), io)
    const base = event()
    const previous = output.ingest({
      ...base,
      output: 'previous\nAuthorization: Bea',
      outputDelta: true,
    })
    const chunk = {
      ...base,
      id: randomUUID(),
      output: 'rer retry-secret-credential12345\n中文🙂末尾',
      outputDelta: true,
    }
    failWrite = true
    expect(() => output.ingest(chunk)).toThrow('partial disk')
    expect((await output.read(previous.outputRef!)).text).toBe('previous\n')
    output.ingest(chunk)
    failWrite = true
    expect(() => output.finishTurn(base.sessionId, base.turnId, 'idle')).toThrow('partial disk')
    const [finished] = output.finishTurn(base.sessionId, base.turnId, 'idle')
    const full = await output.read(finished.outputRef!)
    expect(full.text).toBe('previous\nAuthorization: Bearer [redacted]\n中文🙂末尾')
    expect(finished.outputBytes).toBe(Buffer.byteLength(full.text))
    expect(output.finishTurn(base.sessionId, base.turnId, 'idle')).toEqual([])
  })
  it('makes progress with one-byte page requests without corrupting multi-byte characters', async () => {
    const output = new OutputStore(directory())
    const original = '🙂你好abcé末尾'
    const final = output.ingest(event({ output: original, state: 'completed' }))
    let offset = 0,
      all = ''
    do {
      const page = await output.read(final.outputRef!, offset, 1)
      expect(page.nextOffset).toBeGreaterThan(offset)
      all += page.text
      offset = page.nextOffset
      if (!page.hasMore) break
    } while (true)
    expect(all).toBe(original)
    await expect(output.read(final.outputRef!, 1, 1)).rejects.toThrow('UTF-8')
  })

  it('reserves a visible cap notice when later native chunks exceed the real 32 MB budget', async () => {
    const folder = directory()
    const output = new OutputStore(folder)
    const base = event()
    const cap = 32 * 1024 * 1024,
      notice = '\n[输出超过 32 MB 存储上限，后续内容未保存]\n'
    const payloadBudget = cap - Buffer.byteLength(notice)
    const first = '🙂'.repeat(Math.floor((payloadBudget - 1) / 4)) + '\n'
    output.ingest({ ...base, output: first, outputDelta: true })
    const capped = output.ingest({
      ...base,
      id: randomUUID(),
      output: '新增尾部🙂\n',
      outputDelta: true,
    })
    const final = output.ingest({ ...base, id: randomUUID(), state: 'completed' })
    const stored = fs.readFileSync(join(folder, 'outputs', final.outputRef + '.txt'))
    expect(stored.length).toBeLessThanOrEqual(cap)
    expect(stored.toString('utf8')).not.toContain('�')
    expect(stored.toString('utf8').endsWith(notice)).toBe(true)
    expect(capped.outputTruncated).toBe(true)
    expect(final.outputBytes).toBe(stored.length)
    expect(final.output).toContain('输出超过 32 MB 存储上限')
    const lastPage = await output.read(
      final.outputRef!,
      Math.max(0, stored.length - Buffer.byteLength(notice)),
      1024,
    )
    expect(lastPage.text).toBe(notice)
    expect(lastPage.hasMore).toBe(false)
  })
})
