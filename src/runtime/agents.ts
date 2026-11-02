import type { AgentContext, AgentManagerContract, EmitEvent } from '../shared/runtime'
import { PROVIDERS, type ProviderId, type ProviderInfo, type Settings } from '../shared/types'
import { resolveCommand, runCommand } from './process'
import { Turn, errorMessage, type Reply } from './adapters/common'
import { ClaudeAdapter } from './adapters/claude'
import { CodexAdapter } from './adapters/codex'
import { OpenCodeAdapter } from './adapters/opencode'

interface Adapter {
  send(context: AgentContext, text: string, turnId: string): Promise<void>
  interrupt(sessionId: string): Promise<void>
  respond(sessionId: string, requestId: string, reply: Reply): Promise<void>
  models(path: string, cwd?: string): Promise<import('../shared/types').Model[]>
  close(): Promise<void>
}
export const MINIMUM_VERSIONS: Record<ProviderId, string> = {
  claude: '2.1.236',
  codex: '0.151.0',
  opencode: '1.19.5',
}

export function versionSupported(version: string, minimum: string): boolean {
  const actual = version
    .match(/\d+\.\d+\.\d+/)?.[0]
    .split('.')
    .map(Number)
  if (!actual) return false
  const wanted = minimum.split('.').map(Number)
  for (let index = 0; index < 3; index++) {
    if (actual[index] > wanted[index]) return true
    if (actual[index] < wanted[index]) return false
  }
  return true
}

export class AgentManager implements AgentManagerContract {
  private readonly adapters: Record<ProviderId, Adapter>
  private readonly owners = new Map<string, { provider: ProviderId; turnId: string }>()
  private readonly starting = new Map<string, { turn: Turn; cancelled: boolean }>()
  private closed = false
  constructor(private readonly emit: EmitEvent) {
    const forward: EmitEvent = (event) => {
      if (event.kind === 'done' && this.owners.get(event.sessionId)?.turnId === event.turnId)
        this.owners.delete(event.sessionId)
      emit(event)
    }
    this.adapters = {
      claude: new ClaudeAdapter(forward),
      codex: new CodexAdapter(forward),
      opencode: new OpenCodeAdapter(forward),
    }
  }
  async send(context: AgentContext, text: string, turnId: string): Promise<void> {
    if (this.closed) throw new Error('Agent runtime is closing.')
    if (!text.trim()) throw new Error('Enter a message first.')
    if (this.owners.has(context.session.id))
      throw new Error('This session is already running. Stop the current turn first.')
    const provider = context.session.provider
    this.owners.set(context.session.id, { provider, turnId })
    const startup = { turn: new Turn(context, turnId, this.emit), cancelled: false }
    this.starting.set(context.session.id, startup)
    startup.turn.status('running')
    // Never keep the runtime's IPC request waiting on model generation or startup.
    void (async () => {
      try {
        const path = await resolveCommand(PROVIDERS[provider].command, context.cliPath)
        if (startup.cancelled || this.closed) return
        if (!path)
          throw new Error(
            `${PROVIDERS[provider].name} CLI was not found. Install it or select its executable in Settings.`,
          )
        const version = await runCommand(path, ['--version'], context.cwd)
        const label = version.stdout.trim() || version.stderr.trim()
        if (version.code !== 0)
          throw new Error(
            `${PROVIDERS[provider].name} --version failed: ${label || `exit ${version.code}`}`,
          )
        if (!versionSupported(label, MINIMUM_VERSIONS[provider]))
          throw new Error(
            `${PROVIDERS[provider].name} requires version ${MINIMUM_VERSIONS[provider]} or later. Found: ${label || 'unknown'}. Update the CLI and try again.`,
          )
        if (startup.cancelled || this.closed) return
        this.starting.delete(context.session.id)
        await this.adapters[provider].send({ ...context, cliPath: path }, text, turnId)
      } catch (error) {
        if (!startup.cancelled) startup.turn.finish('error', error)
        if (this.owners.get(context.session.id)?.turnId === turnId)
          this.owners.delete(context.session.id)
      } finally {
        if (this.starting.get(context.session.id) === startup)
          this.starting.delete(context.session.id)
      }
    })()
  }
  async interrupt(sessionId: string): Promise<void> {
    const startup = this.starting.get(sessionId)
    if (startup) {
      startup.cancelled = true
      startup.turn.cancelPending()
      startup.turn.finish('interrupted')
      this.starting.delete(sessionId)
      this.owners.delete(sessionId)
      return
    }
    const owner = this.owners.get(sessionId)
    if (owner) await this.adapters[owner.provider].interrupt(sessionId)
  }
  async respond(sessionId: string, requestId: string, reply: Reply): Promise<void> {
    const owner = this.owners.get(sessionId)
    if (!owner) throw new Error('This session is no longer waiting for input.')
    await this.adapters[owner.provider].respond(sessionId, requestId, reply)
  }
  async probe(settings: Settings, cwd?: string): Promise<ProviderInfo[]> {
    return Promise.all(
      (Object.keys(PROVIDERS) as ProviderId[]).map(async (id): Promise<ProviderInfo> => {
        const info: ProviderInfo = { id, name: PROVIDERS[id].name, available: false, models: [] }
        try {
          if (this.closed) throw new Error('Agent runtime is closing.')
          const path = await resolveCommand(PROVIDERS[id].command, settings.cliPaths[id])
          if (this.closed) throw new Error('Agent runtime is closing.')
          if (!path) return { ...info, error: 'CLI not found. Choose its executable in Settings.' }
          info.path = path
          const result = await runCommand(path, ['--version'], cwd)
          info.version = (result.stdout || result.stderr).trim().split('\n')[0]
          if (result.code !== 0) throw new Error(`Version probe failed: ${info.version}`)
          if (!versionSupported(info.version, MINIMUM_VERSIONS[id]))
            throw new Error(`Requires ${MINIMUM_VERSIONS[id]} or later. Update your CLI.`)
          if (this.closed) throw new Error('Agent runtime is closing.')
          info.available = true
          try {
            info.models = await this.adapters[id].models(path, cwd)
          } catch (error) {
            info.error = `Model discovery: ${errorMessage(error)}`
          }
        } catch (error) {
          info.error = errorMessage(error)
        }
        return info
      }),
    )
  }
  async close(): Promise<void> {
    this.closed = true
    for (const sessionId of this.starting.keys()) await this.interrupt(sessionId)
    await Promise.allSettled(Object.values(this.adapters).map((adapter) => adapter.close()))
    this.owners.clear()
  }
}
