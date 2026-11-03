import type { AgentEvent, Settings, Session, TerminalOutput, TurnInput, TaskRun } from './types'
export interface AgentContext {
  session: Session
  cwd: string
  cliPath?: string
  input?: TurnInput
}
export interface AgentManagerContract {
  send(context: AgentContext, text: string, turnId: string): Promise<void>
  interrupt(sessionId: string): Promise<void>
  respond(
    sessionId: string,
    requestId: string,
    response: {
      decision?: string
      answers?: Record<string, string[]>
      permissions?: Record<string, unknown>
      scope?: 'turn' | 'session'
    },
  ): Promise<void>
  probe(settings: Settings, cwd?: string): Promise<import('./types').ProviderInfo[]>
  close(): Promise<void>
}
export type RuntimeMessage =
  | { type: 'event'; event: AgentEvent }
  | { type: 'terminal'; output: TerminalOutput }
  | { type: 'response'; id: string; result?: unknown; error?: string }
  | { type: 'ready' }
  | { type: 'task'; task: TaskRun }
  | { type: 'ownership'; event: import('../runtime/process').ProcessOwnershipEvent }
export interface RuntimeRequest {
  id: string
  method: string
  args: unknown[]
}
export type EmitEvent = (event: AgentEvent) => void
export type EmitTerminal = (output: TerminalOutput) => void
