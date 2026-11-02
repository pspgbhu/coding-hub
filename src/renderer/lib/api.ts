import type { AppAPI, AgentEvent } from '../../shared/types'
declare global {
  interface Window {
    hub: AppAPI
  }
}
export const api = window.hub
export function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/^Error invoking remote method '[^']+': Error: /, '')
}
export function appendEvent(events: AgentEvent[], event: AgentEvent): AgentEvent[] {
  if (events.some((item) => item.id === event.id)) return events
  if (event.kind === 'text' && event.itemId) {
    const index = events.findLastIndex(
      (item) =>
        item.kind === 'text' && item.turnId === event.turnId && item.itemId === event.itemId,
    )
    if (index !== -1)
      return events.map((item, i) =>
        i === index
          ? {
              ...item,
              text: event.delta ? (item.text || '') + (event.text || '') : event.text || '',
            }
          : item,
      )
  }
  if (event.kind === 'tool' && event.itemId) {
    const index = events.findLastIndex(
      (item) =>
        item.kind === 'tool' && item.itemId === event.itemId && item.turnId === event.turnId,
    )
    if (index !== -1)
      return events.map((item, i) =>
        i === index
          ? {
              ...item,
              ...event,
              input: event.input ?? item.input,
              output: event.output ?? item.output,
            }
          : item,
      )
  }
  return [...events, event]
}
export function shortPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~').replace(/^C:\\Users\\[^\\]+/, '~')
}
