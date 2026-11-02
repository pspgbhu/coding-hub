import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { AgentContext, EmitEvent } from '../../shared/runtime'
import type { Model } from '../../shared/types'
import { launch, resolveCommand, terminateProcessTree } from '../process'
import { JsonLines, Turn, approved, outputText, type Reply } from './common'

type Message = Record<string, any>
type Pending = {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** The public app-server transport uses NDJSON JSON-RPC, not Content-Length frames. */
export class CodexRpc {
  private nextId = 0
  private closed = false
  private readonly pending = new Map<string, Pending>()
  private stderr = ''
  private readonly decoder = new StringDecoder('utf8')
  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    private readonly receive: (message: Message) => void,
    private readonly onExit: (error?: Error) => void,
  ) {
    const lines = new JsonLines(
      (message) => {
        if (!message.method && message.id != null) {
          const pending = this.pending.get(String(message.id))
          if (!pending) return
          this.pending.delete(String(message.id))
          clearTimeout(pending.timer)
          if (message.error)
            pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)))
          else pending.resolve(message.result)
        } else this.receive(message)
      },
      (error) => this.fail(error),
    )
    child.stdout.on('data', (chunk: Buffer) => lines.push(chunk))
    child.stdout.on('end', () => lines.end())
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + this.decoder.write(chunk)).slice(-5000)
    })
    child.stdin.on('error', (error) => {
      if (!this.closed) this.fail(error)
    })
    child.once('error', (error) => this.fail(error))
    child.once('close', (code, signal) => {
      if (this.closed) return
      this.fail(
        new Error(
          `Codex app-server exited (${signal ?? code ?? 'unknown'}).${this.stderr ? `\n${this.stderr}` : ''}`,
        ),
      )
    })
  }
  request(method: string, params: unknown, timeout = 30_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Codex connection is closed.'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id))
        reject(new Error(`Codex timed out during ${method}.`))
      }, timeout)
      this.pending.set(String(id), { resolve, reject, timer })
      this.write({ id, method, params })
    })
  }
  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params == null ? {} : { params }) })
  }
  response(id: string | number, result: unknown): void {
    this.write({ id, result })
  }
  rejectRequest(id: string | number, message: string): void {
    this.write({ id, error: { code: -32601, message } })
  }
  private write(value: unknown): void {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify(value)}\n`)
  }
  private fail(error: Error): void {
    if (this.closed) return
    this.close()
    this.onExit(error)
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Codex connection closed.'))
    }
    this.pending.clear()
    this.child.stdin.end()
    const timer = setTimeout(() => {
      void terminateProcessTree(this.child).catch(() => {})
    }, 2000)
    timer.unref()
    this.child.once('close', () => clearTimeout(timer))
  }
}

interface Active {
  turn: Turn
  rpc?: CodexRpc
  threadId?: string
  nativeTurnId?: string
  streamed: Set<string>
  toolOutput: Map<string, string>
  stopped: boolean
}

export class CodexAdapter {
  private readonly active = new Map<string, Active>()
  private closed = false
  constructor(private readonly emit: EmitEvent) {}
  async send(context: AgentContext, text: string, turnId: string): Promise<void> {
    if (this.closed) throw new Error('Agent runtime is closing.')
    if (this.active.has(context.session.id)) throw new Error('This session is already running.')
    const state: Active = {
      turn: new Turn(context, turnId, this.emit),
      streamed: new Set(),
      toolOutput: new Map(),
      stopped: false,
    }
    this.active.set(context.session.id, state)
    state.turn.status('running')
    void this.start(state, text).catch((error) => this.end(state, error))
  }
  private async connect(
    path: string,
    cwd: string | undefined,
    receive: (message: Message) => void,
    exit: (error?: Error) => void,
  ): Promise<CodexRpc> {
    if (this.closed) throw new Error('Agent runtime is closing.')
    const rpc = new CodexRpc(launch(path, ['app-server'], cwd), receive, exit)
    try {
      await rpc.request('initialize', {
        clientInfo: { name: 'coding_hub', title: 'Coding Hub', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      })
      rpc.notify('initialized')
      return rpc
    } catch (error) {
      rpc.close()
      throw error
    }
  }
  private async start(state: Active, text: string): Promise<void> {
    const { turn } = state
    const path = await resolveCommand('codex', turn.context.cliPath)
    if (!path)
      throw new Error(
        'Codex CLI was not found. Install it and run codex login, or select its executable in Settings.',
      )
    if (state.stopped || this.closed) return
    state.rpc = await this.connect(
      path,
      turn.context.cwd,
      (message) => {
        if (message.id != null && message.method)
          void this.serverRequest(state, message).catch((error) => this.end(state, error))
        else this.notification(state, message)
      },
      (error) => this.end(state, error),
    )
    if (state.stopped) {
      state.rpc.close()
      return
    }
    const params = {
      cwd: turn.context.cwd,
      model: turn.context.session.model || undefined,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    }
    const result = turn.context.session.nativeId
      ? await state.rpc.request('thread/resume', {
          ...params,
          threadId: turn.context.session.nativeId,
        })
      : await state.rpc.request('thread/start', params)
    state.threadId = result.thread.id
    turn.event({ kind: 'session', nativeId: state.threadId })
    if (state.stopped) {
      state.rpc.close()
      return
    }
    const started = await state.rpc.request('turn/start', {
      threadId: state.threadId,
      input: [{ type: 'text', text, text_elements: [] }],
      model: turn.context.session.model || undefined,
    })
    state.nativeTurnId = started.turn.id
    if (state.stopped)
      await state.rpc
        .request('turn/interrupt', { threadId: state.threadId, turnId: state.nativeTurnId })
        .catch(() => {})
  }
  private notification(state: Active, message: Message): void {
    if (state.turn.ended) return
    const p = message.params ?? {}
    if (p.threadId && state.threadId && p.threadId !== state.threadId) return
    if (message.method === 'turn/started') state.nativeTurnId = p.turn?.id
    if (message.method === 'item/agentMessage/delta') {
      state.streamed.add(p.itemId)
      state.turn.event({ kind: 'text', itemId: p.itemId, text: p.delta, delta: true })
    }
    if (
      message.method === 'item/commandExecution/outputDelta' ||
      message.method === 'item/fileChange/outputDelta'
    ) {
      const output = (state.toolOutput.get(p.itemId) ?? '') + (p.delta ?? '')
      state.toolOutput.set(p.itemId, output.slice(-64_000))
      state.turn.event({
        kind: 'tool',
        itemId: p.itemId,
        output: output.slice(-64_000),
        state: 'running',
      })
    }
    if (message.method === 'item/started' || message.method === 'item/completed') {
      const item = p.item
      if (!item) return
      const completed = message.method === 'item/completed'
      if (item.type === 'agentMessage') {
        if (completed && !state.streamed.has(item.id))
          state.turn.event({ kind: 'text', itemId: item.id, text: item.text, delta: false })
      } else if (!['userMessage', 'reasoning'].includes(item.type)) {
        state.turn.event({
          kind: 'tool',
          itemId: item.id,
          name: item.tool ?? item.type,
          input: item.command ?? item.arguments ?? item.changes ?? item,
          output:
            item.aggregatedOutput ?? outputText(item.result ?? item.contentItems ?? item.text),
          state:
            item.status === 'failed' || item.success === false
              ? 'error'
              : completed
                ? 'completed'
                : 'running',
        })
      }
    }
    if (message.method === 'thread/tokenUsage/updated')
      state.turn.event({
        kind: 'usage',
        tokens: p.tokenUsage?.last?.totalTokens ?? p.tokenUsage?.total?.totalTokens,
      })
    if (message.method === 'error' && !p.willRetry)
      this.end(state, new Error(p.error?.message ?? 'Codex reported an error.'))
    if (message.method === 'serverRequest/resolved') {
      const id = String(p.requestId)
      if (state.turn.pending.has(id)) state.turn.respond(id, { decision: 'deny' })
    }
    if (message.method === 'turn/completed') {
      if (p.turn?.status === 'interrupted') state.turn.interrupted = true
      this.end(
        state,
        p.turn?.status === 'failed'
          ? new Error(p.turn.error?.message ?? 'Codex turn failed.')
          : undefined,
      )
    }
  }
  private async serverRequest(state: Active, message: Message): Promise<void> {
    const p = message.params ?? {}
    const requestId = String(message.id)
    if (state.stopped || state.turn.ended) {
      state.rpc?.rejectRequest(message.id, 'Session was stopped.')
      return
    }
    if (message.method === 'item/tool/requestUserInput') {
      const reply = await state.turn.ask(requestId, {
        kind: 'question',
        name: 'User input',
        questions: (p.questions ?? []).map((question: Message) => ({
          id: question.id,
          title: question.question,
          options: question.options ?? undefined,
          multiple: false,
        })),
      })
      state.rpc?.response(message.id, {
        answers: Object.fromEntries(
          (p.questions ?? []).map((question: Message) => [
            question.id,
            { answers: reply.answers?.[question.id] ?? [] },
          ]),
        ),
      })
    } else if (
      ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(
        message.method,
      )
    ) {
      const decisions = Array.isArray(p.availableDecisions)
        ? p.availableDecisions.filter((d: unknown) => typeof d === 'string')
        : ['accept', 'decline']
      const reply = await state.turn.ask(requestId, {
        kind: 'approval',
        itemId: p.itemId,
        name: message.method.includes('commandExecution') ? 'Run command' : 'Change files',
        text: p.reason,
        input: p.command ?? p,
        decisions,
      })
      const decision = ['acceptForSession', 'always', 'allow-session'].includes(
        reply.decision ?? '',
      )
        ? 'acceptForSession'
        : approved(reply.decision)
          ? 'accept'
          : 'decline'
      state.rpc?.response(message.id, { decision })
    } else if (message.method === 'item/permissions/requestApproval') {
      // This host has no permission-profile editor; safely decline additional grants.
      state.rpc?.response(message.id, { permissions: {}, scope: 'turn' })
    } else state.rpc?.rejectRequest(message.id, `Coding Hub does not support ${message.method}.`)
  }
  private end(state: Active, error?: unknown): void {
    if (state.turn.ended) return
    state.turn.finish(state.turn.interrupted ? 'interrupted' : error ? 'error' : 'idle', error)
    state.rpc?.close()
    if (this.active.get(state.turn.context.session.id) === state)
      this.active.delete(state.turn.context.session.id)
  }
  async interrupt(sessionId: string): Promise<void> {
    const state = this.active.get(sessionId)
    if (!state) return
    state.stopped = true
    state.turn.cancelPending()
    if (state.threadId && state.nativeTurnId)
      await state.rpc
        ?.request('turn/interrupt', { threadId: state.threadId, turnId: state.nativeTurnId }, 5000)
        .catch(() => {})
    this.end(state)
  }
  async respond(sessionId: string, requestId: string, reply: Reply): Promise<void> {
    const state = this.active.get(sessionId)
    if (!state) throw new Error('This session is no longer running.')
    state.turn.respond(requestId, reply)
  }
  async models(path: string, cwd?: string): Promise<Model[]> {
    const rpc = await this.connect(
      path,
      cwd,
      (message) => {
        if (message.id != null) rpc.rejectRequest(message.id, 'Discovery does not execute tools.')
      },
      () => {},
    )
    try {
      const result = await rpc.request('model/list', { includeHidden: false })
      return result.data.map((model: Message) => ({
        id: model.id,
        name: model.displayName ?? model.model ?? model.id,
      }))
    } finally {
      rpc.close()
    }
  }
  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.active.keys()].map((id) => this.interrupt(id)))
  }
}
