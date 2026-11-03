import { afterEach, describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { cpus, release, tmpdir, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Store } from '../src/main/store'
import { EventBatcher } from '../src/main/event-batcher'
import { OutputStore } from '../src/main/output-store'
import { WorkspaceService } from '../src/runtime/workspace'
import type { AgentEvent } from '../src/shared/types'

const full = process.env.CODING_HUB_BENCHMARK === '1'
const locations: string[] = []
const stores: Store[] = []
const artifact = resolve(`coverage/benchmarks/performance-${full ? 'full' : 'smoke'}.json`)
const report: Record<string, unknown> = {
  recordedAt: new Date().toISOString(),
  mode: full ? 'full' : 'smoke',
  machine: {
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    memoryBytes: totalmem(),
    node: process.versions.node,
    electron: process.versions.electron,
  },
  boundaries: [
    'Service/database timings; Electron renderer paint and complete app startup are separate gates.',
    'Local wall-clock timings depend on host load; fixed CI hardware validation remains required.',
    'Fixture construction, file creation and Git index construction are excluded from operation timings.',
  ],
}
function timed<T>(work: () => T): { value: T; ms: number } {
  const start = performance.now()
  const value = work()
  return { value, ms: performance.now() - start }
}
function statistics(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    samples: samples.length,
    minMs: sorted[0],
    medianMs: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maxMs: sorted.at(-1)!,
  }
}
async function saveReport() {
  await mkdir(resolve('coverage/benchmarks'), { recursive: true })
  await writeFile(artifact, JSON.stringify(report, null, 2) + '\n')
}
async function database() {
  const directory = await mkdtemp(join(tmpdir(), 'hub-performance-'))
  locations.push(directory)
  const store = new Store(join(directory, 'hub.db'))
  stores.push(store)
  const project = store.addProject(join(directory, 'project'), '性能项目')
  return { store, project, directory }
}
function event(sessionId: string, index: number, text: string): AgentEvent {
  return {
    id: randomUUID(),
    sessionId,
    turnId: `turn-${Math.floor(index / 10)}`,
    itemId: `message-${index}`,
    kind: 'text',
    text,
    timestamp: Date.now(),
  }
}
afterEach(async () => {
  for (const store of stores.splice(0)) if (store.db.open) store.close()
  for (const directory of locations.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe(full ? 'full opt-in product benchmarks' : 'small performance regression fixtures', () => {
  it(
    'measures paged history, indexed Chinese search, session listings and store reopening',
    async () => {
      const { store, project, directory } = await database()
      const sessionCount = full ? 1000 : 40
      const eventCount = full ? 10000 : 400
      let historyId = ''
      const setup = timed(() =>
        store.db.transaction(() => {
          for (let i = 0; i < sessionCount; i++) {
            const session = store.createSession(project.id, 'codex')
            store.patchSession(session.id, {
              title: `Performance session ${String(i).padStart(4, '0')}`,
            })
            if (i === 0) historyId = session.id
            else
              store.append(
                event(session.id, 0, `Secondary session ${i}: 中文查找, safe 100%_literal`),
              )
          }
          for (let i = 0; i < eventCount; i++)
            store.append(
              event(
                historyId,
                i,
                `Message ${i}: 中文查找与索引检索 needle-${String(i).padStart(5, '0')} safe 100%_literal. ${'Representative conversation text. '.repeat(4)}`,
              ),
            )
        })(),
      )
      const historySamples: number[] = []
      let before: number | undefined
      for (let i = 0; i < 20; i++) {
        const page = timed(() => store.view(historyId, { limit: 100, before }))
        expect(page.value.events.length).toBeLessThanOrEqual(100)
        expect(page.value.events.length).toBeGreaterThan(0)
        historySamples.push(page.ms)
        before = page.value.hasMore ? page.value.before : undefined
      }
      const queries = [
        '中文查找',
        '100%_literal',
        '中文',
        'Performance',
        'needle',
        'not-present',
        '性能项目',
        '',
        'session 0001',
        '检索',
      ]
      const searchSamples: number[] = []
      for (let i = 0; i < 20; i++) {
        const result = timed(() =>
          store.searchSessions(queries[i % queries.length], { limit: 100 }),
        )
        expect(result.value.length).toBeLessThanOrEqual(100)
        if (queries[i % queries.length] === 'not-present') expect(result.value).toEqual([])
        searchSamples.push(result.ms)
      }
      const listing = timed(() => store.sessions({ includeDeleted: true }))
      expect(listing.value).toHaveLength(sessionCount)
      const bootstrap = timed(() => ({
        projects: store.projects(),
        sessions: store.sessions({ includeDeleted: true }),
        workspaces: store.workspaces(),
        settings: store.settings(),
      }))
      expect(bootstrap.value.sessions).toHaveLength(sessionCount)
      store.close()
      stores.splice(stores.indexOf(store), 1)
      const reopened = timed(() => new Store(join(directory, 'hub.db')))
      stores.push(reopened.value)
      const history = statistics(historySamples)
      const search = statistics(searchSamples)
      report.database = {
        sessionCount,
        conversationEvents: eventCount,
        totalEvents: eventCount + sessionCount - 1,
        setupMs: setup.ms,
        historyPage: history,
        search,
        sessionsReadMs: listing.ms,
        bootstrapDataReadMs: bootstrap.ms,
        storeReopenMs: reopened.ms,
        databaseBytes: reopened.value.storageInfo().databaseBytes,
      }
      await saveReport()
      expect(history.maxMs).toBeLessThanOrEqual(1000)
      expect(search.p95Ms).toBeLessThanOrEqual(500)
      expect(reopened.ms).toBeLessThanOrEqual(5000)
    },
    full ? 180000 : 15000,
  )

  it(
    'measures quick-open against real files and a real Git index including its final path',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'hub-file-benchmark-'))
      locations.push(directory)
      const fileCount = full ? 50000 : 200
      const setupStart = performance.now()
      execFileSync('git', ['init', '-b', 'main', '--template=', directory], { stdio: 'pipe' })
      const names: string[] = []
      const groupCount = Math.ceil(fileCount / 500)
      for (let group = 0; group < groupCount; group++) {
        const folder = `src/group${String(group).padStart(3, '0')}`
        await mkdir(join(directory, folder), { recursive: true })
        const batch: string[] = []
        for (let i = group * 500; i < Math.min(fileCount, (group + 1) * 500); i++) {
          const name = `${folder}/file-${String(i).padStart(5, '0')}.ts`
          names.push(name)
          batch.push(name)
        }
        // Bounded filesystem concurrency; every indexed entry has a real regular file.
        for (let start = 0; start < batch.length; start += 50)
          await Promise.all(
            batch.slice(start, start + 50).map((name) => writeFile(join(directory, name), '')),
          )
      }
      const hash = execFileSync('git', ['hash-object', '-w', '--stdin'], {
        cwd: directory,
        input: '',
        encoding: 'utf8',
      }).trim()
      execFileSync('git', ['-c', 'core.fsmonitor=false', 'update-index', '--index-info'], {
        cwd: directory,
        input: names.map((name) => `100644 ${hash}\t${name}\n`).join(''),
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 16 * 1024 * 1024,
      })
      const setupMs = performance.now() - setupStart
      const workspace = new WorkspaceService()
      const targets = [names[0], names[Math.floor(fileCount / 2)], names.at(-1)!]
      const searches: { target: string; ms: number; found: boolean }[] = []
      const repetitions = full ? 20 : 3
      for (let i = 0; i < repetitions; i++) {
        const target = targets[i % targets.length]
        const start = performance.now()
        const results = await workspace.searchFiles(directory, target.split('/').at(-1)!)
        searches.push({
          target,
          ms: performance.now() - start,
          found: results.some((result) => result.path === target),
        })
      }
      report.quickOpen = {
        fileCount,
        realFiles: true,
        gitIndexed: true,
        contents:
          'Empty real files; this benchmark measures filename quick-open, not content scanning.',
        setupMs,
        coldInitializationMs: searches[0]?.ms,
        measurements: searches,
        timings: statistics(searches.map((search) => search.ms)),
        warmTimings: statistics(searches.slice(1).map((search) => search.ms)),
      }
      await saveReport()
      for (const search of searches)
        expect(search.found, `Quick-open must include ${search.target}`).toBe(true)
      if (full)
        expect(statistics(searches.map((search) => search.ms)).p95Ms).toBeLessThanOrEqual(500)
    },
    full ? 240000 : 15000,
  )

  it(
    'records cumulative streaming writes and long-tool payload sizes without inventing a bound',
    async () => {
      const { store, project } = await database()
      const session = store.createSession(project.id, 'codex')
      const deltaCount = full ? 1000 : 40
      const chunk = 'streaming output '.repeat(16)
      const streaming = timed(() => {
        for (let i = 0; i < deltaCount; i++)
          store.append({ ...event(session.id, 0, chunk), itemId: 'stream', delta: true })
      })
      const longOutput = 'tool output\n'.repeat(full ? 180000 : 10000)
      store.append({
        ...event(session.id, 1, ''),
        kind: 'tool',
        output: longOutput,
        state: 'completed',
      })
      const view = timed(() => store.view(session.id, { limit: 100 }))
      report.streaming = {
        rawDeltas: deltaCount,
        deltaBytes: Buffer.byteLength(chunk),
        cumulativeTextBytes: Buffer.byteLength(chunk) * deltaCount,
        storeAppendMs: streaming.ms,
        toolOutputInputBytes: Buffer.byteLength(longOutput),
        toolOutputStoredBytes: Buffer.byteLength(
          view.value.events.find((item) => item.kind === 'tool')?.output ?? '',
        ),
        pageWireBytes: Buffer.byteLength(JSON.stringify(view.value)),
        pageReadMs: view.ms,
        note: 'Measures Store.append directly, before any main-process event batching. No streaming or output-size threshold is asserted here.',
      }
      await saveReport()
      expect(view.value.events.find((item) => item.kind === 'text')?.text).toBe(
        chunk.repeat(deltaCount),
      )
      console.log(`Performance report: ${artifact}`)
    },
    full ? 180000 : 15000,
  )

  it(
    'measures the production batching and external-output path with bounded history and complete paged reads',
    async () => {
      const { store, project, directory } = await database()
      const session = store.createSession(project.id, 'codex')
      const outputStore = new OutputStore(directory)
      let sqliteWrites = 0
      const batcher = new EventBatcher((incoming) => {
        store.append(outputStore.ingest(incoming))
        sqliteWrites++
      })
      const deltaCount = full ? 1000 : 40
      const textChunk = 'streaming output '.repeat(16)
      const textStart = performance.now()
      for (let i = 0; i < deltaCount; i++)
        batcher.push({ ...event(session.id, 0, textChunk), itemId: 'stream', delta: true })
      batcher.flush()
      const textPipelineMs = performance.now() - textStart
      const textSqliteWrites = sqliteWrites
      // Newline framing exercises the actual redactor while preserving multilingual data.
      const outputChunk = `工具输出 ${'x'.repeat(2200)}\n`
      const toolStart = performance.now()
      for (let i = 0; i < deltaCount; i++)
        batcher.push({
          ...event(session.id, 1, ''),
          itemId: 'large-command',
          kind: 'tool',
          output: outputChunk,
          outputDelta: true,
          state: 'running',
        })
      batcher.push({
        ...event(session.id, 1, ''),
        itemId: 'large-command',
        kind: 'tool',
        output: undefined,
        state: 'completed',
      })
      batcher.flush()
      const toolPipelineMs = performance.now() - toolStart
      const history = timed(() => store.view(session.id, { limit: 100 }))
      const output = history.value.events.find((value) => value.kind === 'tool')!
      const expected = outputChunk.repeat(deltaCount)
      expect(output.outputRef).toBeTruthy()
      expect(Buffer.byteLength(output.output ?? '')).toBeLessThanOrEqual(64 * 1024)
      expect(output.outputBytes).toBe(Buffer.byteLength(expected))
      expect(output.outputTruncated).toBe(true)
      expect(sqliteWrites).toBeLessThan(deltaCount / 4)
      expect(history.value.events.find((value) => value.kind === 'text')?.text).toBe(
        textChunk.repeat(deltaCount),
      )
      const readStart = performance.now(),
        pages: number[] = [],
        hash = createHash('sha256')
      let offset = 0
      do {
        const start = performance.now()
        const page = await outputStore.read(output.outputRef!, offset, 32768)
        pages.push(performance.now() - start)
        expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(32768)
        expect(page.nextOffset).toBeGreaterThan(offset)
        hash.update(page.text)
        offset = page.nextOffset
        if (!page.hasMore) break
      } while (true)
      expect(offset).toBe(Buffer.byteLength(expected))
      expect(hash.digest('hex')).toBe(createHash('sha256').update(expected).digest('hex'))
      report.productionStreaming = {
        rawTextDeltas: deltaCount,
        rawToolDeltas: deltaCount,
        textInputBytes: Buffer.byteLength(textChunk) * deltaCount,
        toolInputBytes: Buffer.byteLength(expected),
        textPipelineMs,
        toolPipelineMs,
        textSqliteWrites,
        toolSqliteWrites: sqliteWrites - textSqliteWrites,
        totalSqliteWrites: sqliteWrites,
        toolHistoryPreviewBytes: Buffer.byteLength(output.output ?? ''),
        pageWireBytes: Buffer.byteLength(JSON.stringify(history.value)),
        historyReadMs: history.ms,
        fullOutputReadMs: performance.now() - readStart,
        fullOutputPages: pages.length,
        outputPageReads: statistics(pages),
        fullOutputHashVerified: true,
        note: 'Actual EventBatcher → OutputStore → Store path; burst input flushes at 128 KiB or a protocol boundary. Timings exclude fixture setup and do not emulate real network pacing.',
      }
      await saveReport()
    },
    full ? 180000 : 15000,
  )
})
