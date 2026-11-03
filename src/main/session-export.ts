import { randomUUID } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
import type { AgentEvent, Session } from '../shared/types'
import type { Store } from './store'
import type { OutputStore } from './output-store'

/** Export every persisted event with bounded pages, and commit only a complete export. */
export async function exportSessionFile(
  store: Store,
  outputs: OutputStore,
  session: Session,
  destination: string,
  format: 'markdown' | 'json',
): Promise<void> {
  const last = store.db
    .prepare('SELECT MAX(ordinal) AS cursor FROM events WHERE session_id=?')
    .get(session.id) as { cursor: number | null }
  const cursor = last.cursor ?? 0
  const temporary = `${destination}.coding-hub-${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(
      format === 'json'
        ? `{"session":${JSON.stringify(session)},"cursor":${cursor},"events":[`
        : `# ${session.title}\n\n`,
    )
    let after = 0,
      count = 0
    for (;;) {
      const page = store.db
        .prepare(
          'SELECT ordinal,data FROM events WHERE session_id=? AND ordinal>? AND ordinal<=? ORDER BY ordinal LIMIT 200',
        )
        .all(session.id, after, cursor) as { ordinal: number; data: string }[]
      if (!page.length) break
      for (const row of page) {
        const event = JSON.parse(row.data) as AgentEvent
        if (format === 'json') {
          if (count++) await file.writeFile(',')
          if (event.outputRef) {
            const { outputRef, output: _preview, ...metadata } = event
            await file.writeFile(JSON.stringify(metadata).slice(0, -1) + ',"output":"')
            let offset = 0
            do {
              const output = await outputs.read(outputRef, offset, 64 * 1024)
              await file.writeFile(JSON.stringify(output.text).slice(1, -1))
              offset = output.nextOffset
              if (!output.hasMore) break
            } while (true)
            await file.writeFile('"}')
          } else await file.writeFile(JSON.stringify(event))
        } else if (
          ['user', 'text', 'tool', 'error', 'approval', 'question', 'requestResolved'].includes(
            event.kind,
          )
        ) {
          await file.writeFile(
            `## ${event.kind === 'user' ? '用户' : event.kind === 'text' ? 'Agent' : (event.name ?? event.kind)}\n\n`,
          )
          if (event.outputRef) {
            let offset = 0
            do {
              const output = await outputs.read(event.outputRef, offset, 64 * 1024)
              await file.writeFile(output.text)
              offset = output.nextOffset
              if (!output.hasMore) break
            } while (true)
          } else
            await file.writeFile(
              event.text ??
                event.output ??
                (event.input ? JSON.stringify(event.input, null, 2) : (event.resolution ?? '')),
            )
          if (event.answers) await file.writeFile(`\n\n${JSON.stringify(event.answers, null, 2)}`)
          if (event.scope) await file.writeFile(`\n\n授权范围：${event.scope}`)
          for (const context of event.context ?? [])
            await file.writeFile(
              `\n\n引用：${context.name}${context.path ? ` (${context.path})` : ''}\n${context.content ?? ''}`,
            )
          await file.writeFile('\n\n')
        }
        after = row.ordinal
      }
    }
    if (format === 'json') await file.writeFile(']}\n')
    await file.sync()
    await file.close()
    await rename(temporary, destination)
  } catch (error) {
    await file.close().catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}
