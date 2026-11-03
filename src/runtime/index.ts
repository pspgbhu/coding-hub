import { randomUUID } from 'node:crypto'
import { AgentManager } from './agents'
import { WorkspaceService } from './workspace'
import { TerminalService } from './terminal'
import {
  closeAllProcesses,
  setProcessOwnershipObserver,
  resolveCommand,
  runCommand,
} from './process'
import { TaskService } from './tasks'
import { ReviewService } from './review'
import { redactDiagnostics } from '../shared/diagnostics'
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
setProcessOwnershipObserver((event) => send({ type: 'ownership', event }))
const emit = (event: AgentEvent): void => send({ type: 'event', event })
const agents = new AgentManager(emit)
const workspace = new WorkspaceService()
const terminals = new TerminalService((output) => send({ type: 'terminal', output }))
const tasks = new TaskService((task) => send({ type: 'task', task }))
const reviews = new ReviewService()
let closing = false
port.on('message', ({ data: request }) => {
  void (async () => {
    const { id, method, args } = request
    try {
      if (closing && method !== 'shutdown') throw new Error('应用正在退出。')
      let result: unknown
      if (method === 'project.clone') {
        const git = await resolveCommand('git')
        if (!git) throw new Error('未找到 Git，请先安装。')
        const clone = await runCommand(
          git,
          ['clone', '--', String(args[0]), String(args[1])],
          undefined,
          { timeoutMs: 120000 },
        )
        if (clone.code !== 0) throw new Error('克隆失败：' + clone.stderr)
      } else if (method === 'agent.send') {
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
      } else if (method.startsWith('task.')) {
        const fn = tasks[method.slice(5) as keyof TaskService]
        if (typeof fn !== 'function') throw new Error('未知检查任务操作。')
        result = await (fn as (...a: unknown[]) => unknown).apply(tasks, args)
      } else if (method.startsWith('review.')) {
        const fn = reviews[method.slice(7) as keyof ReviewService]
        if (typeof fn !== 'function') throw new Error('未知审阅操作。')
        result = await (fn as (...a: unknown[]) => unknown).apply(reviews, args)
      } else if (method === 'shutdown') {
        closing = true
        const graceful = Promise.allSettled([agents.close(), terminals.closeAll(), tasks.close()])
        await Promise.race([graceful, new Promise((resolve) => setTimeout(resolve, 1500))])
        await closeAllProcesses()
        await Promise.race([graceful, new Promise((resolve) => setTimeout(resolve, 500))])
      } else throw new Error('未知后台操作。')
      send({ type: 'response', id, result })
    } catch (error) {
      send({
        type: 'response',
        id,
        error: redactDiagnostics(error instanceof Error ? error.message : String(error)),
      })
    }
  })()
})
send({ type: 'ready' })
