import { randomUUID } from 'node:crypto'
import { AgentManager } from './agents'
import { WorkspaceService } from './workspace'
import { TerminalService } from './terminal'
import { closeAllProcesses } from './process'
import type { AgentContext, RuntimeMessage, RuntimeRequest } from '../shared/runtime'
import type { AgentEvent, Settings } from '../shared/types'

const port = (
  process as NodeJS.Process & {
    parentPort: {
      on: (name: string, callback: (event: { data: RuntimeRequest }) => void) => void
      postMessage: (value: RuntimeMessage) => void
    }
  }
).parentPort
const send = (message: RuntimeMessage): void => port.postMessage(message)
const emit = (event: AgentEvent): void => send({ type: 'event', event })
const agents = new AgentManager(emit)
const workspace = new WorkspaceService()
const terminals = new TerminalService((output) => send({ type: 'terminal', output }))
let closing = false
port.on('message', ({ data: request }) => {
  void (async () => {
    const { id, method, args } = request
    try {
      if (closing && method !== 'shutdown') throw new Error('应用正在退出。')
      let result: unknown
      if (method === 'agent.send') {
        const [context, text, turnId] = args as [AgentContext, string, string]
        void agents.send(context, text, turnId).catch((error) => {
          emit({
            id: randomUUID(),
            sessionId: context.session.id,
            turnId,
            kind: 'error',
            timestamp: Date.now(),
            text: error instanceof Error ? error.message : String(error),
          })
          emit({
            id: randomUUID(),
            sessionId: context.session.id,
            turnId,
            kind: 'done',
            status: 'error',
            timestamp: Date.now(),
          })
        })
      } else if (method === 'agent.probe')
        result = await agents.probe(args[0] as Settings, args[1] as string | undefined)
      else if (method === 'agent.interrupt') result = await agents.interrupt(args[0] as string)
      else if (method === 'agent.respond')
        result = await agents.respond(...(args as Parameters<AgentManager['respond']>))
      else if (method.startsWith('workspace.')) {
        const name = method.slice(10) as keyof WorkspaceService
        const fn = workspace[name]
        if (typeof fn !== 'function') throw new Error('未知文件操作。')
        result = await (fn as (...a: unknown[]) => unknown).apply(workspace, args)
      } else if (method.startsWith('terminal.')) {
        const name = method.slice(9) as keyof TerminalService
        const fn = terminals[name]
        if (typeof fn !== 'function') throw new Error('未知终端操作。')
        result = await (fn as (...a: unknown[]) => unknown).apply(terminals, args)
      } else if (method === 'shutdown') {
        closing = true
        const graceful = Promise.allSettled([agents.close(), terminals.closeAll()])
        await Promise.race([graceful, new Promise((resolve) => setTimeout(resolve, 1500))])
        await closeAllProcesses()
        await Promise.race([graceful, new Promise((resolve) => setTimeout(resolve, 500))])
      } else throw new Error('未知后台操作。')
      send({ type: 'response', id, result })
    } catch (error) {
      send({ type: 'response', id, error: error instanceof Error ? error.message : String(error) })
    }
  })()
})
send({ type: 'ready' })
