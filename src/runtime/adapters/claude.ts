import {
  query,
  type Query,
  type SDKUserMessage,
  type SpawnOptions,
  type SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk'
import { StringDecoder } from 'node:string_decoder'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { RedactingDiagnosticStream } from '../../shared/diagnostics'
import type { AgentContext, EmitEvent } from '../../shared/runtime'
import type { Model } from '../../shared/types'
import {
  finalizeOwnedChild,
  getProcessEnvironment,
  launch,
  resolveCommand,
  terminateProcessTree,
} from '../process'
import { AsyncQueue, Turn, approved, inputImages, outputText, type Reply } from './common'

interface Active {
  turn: Turn
  queue: AsyncQueue<SDKUserMessage>
  query?: Query
  controller: AbortController
  children: Set<ChildProcessWithoutNullStreams>
}

function spawnClaude(
  options: SpawnOptions,
  stderr: (text: string) => void,
  spawned?: (child: ChildProcessWithoutNullStreams) => void,
  cleanupFailed?: (error: unknown) => void,
): SpawnedProcess {
  const child = launch(options.command, options.args, options.cwd, options.env)
  spawned?.(child)
  const decoder = new StringDecoder('utf8')
  child.stderr.on('data', (chunk: Buffer) => stderr(decoder.write(chunk)))
  child.stderr.once('end', () => {
    const rest = decoder.end()
    if (rest) stderr(rest)
  })
  const abort = (): void => {
    void terminateProcessTree(child).catch(() => {})
  }
  options.signal.addEventListener('abort', abort, { once: true })
  child.once('close', () => options.signal.removeEventListener('abort', abort))
  if (options.signal.aborted) abort()
  const wrappers = new Map<(...args: any[]) => void, (...args: any[]) => void>()
  const afterCleanup = (listener: (...args: any[]) => void) => {
    const wrapped = (...args: any[]) => {
      void finalizeOwnedChild(child).then(
        () => listener(...args),
        (error) => {
          cleanupFailed?.(error)
          listener(...args)
        },
      )
    }
    wrappers.set(listener, wrapped)
    return wrapped
  }
  // Route the SDK's own forced kill through the same tree-aware owner too.
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    get killed() {
      return child.killed
    },
    get exitCode() {
      return child.exitCode
    },
    kill: (signal) => {
      void terminateProcessTree(child, signal === 'SIGKILL').catch(() => {})
      return true
    },
    on: (event, listener) => {
      child.on(
        event === 'exit' ? 'close' : event,
        event === 'exit' ? afterCleanup(listener) : listener,
      )
    },
    once: (event, listener) => {
      child.once(
        event === 'exit' ? 'close' : event,
        event === 'exit' ? afterCleanup(listener) : listener,
      )
    },
    off: (event, listener) => {
      child.off(event === 'exit' ? 'close' : event, wrappers.get(listener) ?? listener)
      wrappers.delete(listener)
    },
  }
}

/** Converts native Code messages without conflating message IDs across turns. */
export class ClaudeMessages {
  private readonly currentMessages = new Map<string, string>()
  private readonly blocks = new Map<
    string,
    { index: number; type: string; streamed: boolean; reconciled: boolean }[]
  >()
  private readonly fallbackOffsets = new Map<string, number>()
  private nativeId?: string
  private hasText = false
  private readonly toolNames = new Map<string, string>()
  private readonly toolCalls = new Set<string>()
  constructor(private readonly turn: Turn) {}
  receive(message: Record<string, any>): void {
    if (message.session_id && message.session_id !== this.nativeId) {
      this.nativeId = message.session_id
      this.turn.event({ kind: 'session', nativeId: message.session_id })
    }
    if (message.type === 'stream_event') {
      const event = message.event
      const scope = message.parent_tool_use_id ?? 'main'
      if (event?.type === 'message_start') {
        const id = event.message?.id ?? message.uuid
        this.currentMessages.set(scope, id)
        this.blocks.set(id, [])
      }
      const messageId = this.currentMessages.get(scope) ?? `stream:${scope}`
      const blocks = this.blocks.get(messageId) ?? []
      this.blocks.set(messageId, blocks)
      if (event?.type === 'content_block_start')
        blocks.push({
          index: event.index,
          type: event.content_block?.type ?? 'text',
          streamed: false,
          reconciled: false,
        })
      const itemId = `${messageId}:${event?.index ?? 0}`
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        let block = blocks.find((entry) => entry.index === event.index)
        if (!block) {
          block = { index: event.index, type: 'text', streamed: false, reconciled: false }
          blocks.push(block)
        }
        block.streamed = true
        this.hasText = true
        this.turn.event({ kind: 'text', itemId, text: event.delta.text, delta: true })
      }
    }
    if (message.type === 'assistant') {
      const messageId = message.message?.id ?? message.uuid
      const ledger = this.blocks.get(messageId)
      for (const [index, block] of (message.message?.content ?? []).entries()) {
        // Code may emit one assistant fragment per completed block. Its local
        // index is then zero even when the original API block followed thinking.
        const original = ledger?.find((entry) => entry.type === block.type && !entry.reconciled)
        if (original) original.reconciled = true
        const offset = this.fallbackOffsets.get(messageId) ?? 0
        const itemId = `${messageId}:${original?.index ?? offset + index}`
        const alreadyReconciled = !original && ledger?.some((entry) => entry.type === block.type)
        if (block.type === 'text' && !original?.streamed && !alreadyReconciled) {
          this.hasText = true
          this.turn.event({ kind: 'text', itemId, text: block.text, delta: false })
        }
        if (block.type === 'tool_use' && !this.toolCalls.has(block.id)) {
          this.toolCalls.add(block.id)
          this.toolNames.set(block.id, block.name)
          this.turn.event({
            kind: 'tool',
            itemId: block.id,
            name: block.name,
            input: block.input,
            state: 'running',
          })
        }
      }
      if (!ledger)
        this.fallbackOffsets.set(
          messageId,
          (this.fallbackOffsets.get(messageId) ?? 0) + (message.message?.content?.length ?? 0),
        )
    }
    if (message.type === 'user' && Array.isArray(message.message?.content)) {
      for (const block of message.message.content)
        if (block.type === 'tool_result') {
          this.turn.event({
            kind: 'tool',
            itemId: block.tool_use_id,
            name: this.toolNames.get(block.tool_use_id) ?? 'Tool',
            output: outputText(block.content),
            state: block.is_error ? 'error' : 'completed',
          })
        }
    }
    if (message.type === 'result') {
      if (!this.hasText && message.result)
        this.turn.event({
          kind: 'text',
          itemId: `result:${message.uuid}`,
          text: message.result,
          delta: false,
        })
      this.turn.event({
        kind: 'usage',
        tokens: (message.usage?.input_tokens ?? 0) + (message.usage?.output_tokens ?? 0),
        cost: message.total_cost_usd,
      })
      if (message.is_error || message.subtype !== 'success')
        throw new Error(
          message.errors?.join('\n') || message.result || `Claude Code ended: ${message.subtype}`,
        )
    }
  }
}

export class ClaudeAdapter {
  private readonly active = new Map<string, Active>()
  private closed = false
  constructor(private readonly emit: EmitEvent) {}
  async send(context: AgentContext, text: string, turnId: string): Promise<void> {
    if (this.closed) throw new Error('Agent runtime is closing.')
    if (this.active.has(context.session.id)) throw new Error('This session is already running.')
    const state: Active = {
      turn: new Turn(context, turnId, this.emit),
      queue: new AsyncQueue(),
      controller: new AbortController(),
      children: new Set(),
    }
    this.active.set(context.session.id, state)
    state.turn.status('running')
    void this.run(state, text)
  }
  private async run(state: Active, text: string): Promise<void> {
    const { turn, queue } = state
    let stderr = ''
    const diagnostics = new RedactingDiagnosticStream((text) => {
      stderr = (stderr + text).slice(-4000)
    })
    try {
      const path = await resolveCommand('claude', turn.context.cliPath)
      if (!path)
        throw new Error(
          'Claude Code CLI was not found. Install it and run claude auth login, or select its executable in Settings.',
        )
      if (state.controller.signal.aborted || this.closed) return
      state.query = query({
        prompt: queue,
        options: {
          pathToClaudeCodeExecutable: path,
          cwd: turn.context.cwd,
          resume: turn.context.session.nativeId,
          model: turn.context.session.model || undefined,
          settingSources: ['user', 'project', 'local'],
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          includePartialMessages: true,
          permissionMode: 'default',
          env: getProcessEnvironment({ CLAUDE_AGENT_SDK_CLIENT_APP: 'coding-hub/0.1.0' }),
          abortController: state.controller,
          spawnClaudeCodeProcess: (options) =>
            spawnClaude(
              options,
              (value) => {
                diagnostics.push(value)
              },
              (child) => {
                state.children.add(child)
              },
              (error) => state.turn.failStop(error),
            ),
          stderr: (value) => {
            diagnostics.push(value)
          },
          canUseTool: async (name, input, options) => {
            const requestId = options.requestId
            const questions =
              name === 'AskUserQuestion' && Array.isArray(input.questions)
                ? (input.questions as Record<string, any>[])
                : undefined
            const reply = await turn.ask(
              requestId,
              questions
                ? {
                    kind: 'question',
                    name,
                    input,
                    questions: questions.map((question, index) => ({
                      id: String(index),
                      title: question.question,
                      options: question.options,
                      multiple: question.multiSelect,
                    })),
                  }
                : {
                    kind: 'approval',
                    name,
                    input,
                    text: options.decisionReason,
                    decisions: ['allow', 'deny'],
                  },
            )
            if (turn.interrupted || options.signal.aborted)
              return {
                behavior: 'deny',
                message: 'The user stopped this request.',
                interrupt: true,
              }
            if (questions && reply.answers) {
              const answers = Object.fromEntries(
                questions.map((question, index) => [
                  question.question,
                  (reply.answers?.[String(index)] ?? []).join(', '),
                ]),
              )
              return { behavior: 'allow', updatedInput: { ...input, answers } }
            }
            return approved(reply.decision)
              ? { behavior: 'allow', updatedInput: input }
              : { behavior: 'deny', message: 'The user declined this request.' }
          },
        },
      })
      queue.push({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text },
            ...inputImages(turn.context).map((image) => ({
              type: 'image' as const,
              source: { type: 'base64' as const, media_type: image.mimeType, data: image.data },
            })),
          ],
        },
        parent_tool_use_id: null,
        session_id: turn.context.session.nativeId ?? '',
      })
      const messages = new ClaudeMessages(turn)
      let completed = false
      for await (const message of state.query) {
        messages.receive(message as unknown as Record<string, any>)
        if (message.type === 'result') {
          completed = true
          break
        }
      }
      if (turn.stopState !== 'failed' && (completed || turn.stopState !== 'stopping')) turn.finish()
    } catch (error) {
      diagnostics.end()
      const message = error instanceof Error ? error.message : String(error)
      if (!['stopping', 'failed'].includes(turn.stopState)) {
        try {
          await Promise.all([...state.children].map((child) => terminateProcessTree(child)))
        } catch (cleanupError) {
          turn.failStop(cleanupError)
          return
        }
        turn.finish(
          turn.interrupted ? 'interrupted' : 'error',
          new Error(`${message}${stderr && !message.includes(stderr) ? `\n${stderr}` : ''}`),
        )
      }
    } finally {
      diagnostics.end()
      queue.end()
      state.query?.close()
      if (turn.ended && this.active.get(turn.context.session.id) === state)
        this.active.delete(turn.context.session.id)
    }
  }
  async interrupt(sessionId: string): Promise<void> {
    const state = this.active.get(sessionId)
    if (!state) return
    state.turn.beginStop()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        state.query?.interrupt(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2000)
        }),
      ])
    } catch {
      /* Process may already have exited. */
    } finally {
      clearTimeout(timer)
    }
    try {
      state.queue.end()
      state.controller.abort()
      state.query?.close()
      await Promise.all([...state.children].map((child) => terminateProcessTree(child)))
      state.turn.finish('interrupted')
      this.active.delete(sessionId)
    } catch (error) {
      if (state.turn.ended) return
      state.turn.failStop(error)
      throw error
    }
  }
  async respond(sessionId: string, requestId: string, reply: Reply): Promise<void> {
    const state = this.active.get(sessionId)
    if (!state) throw new Error('This session is no longer running.')
    await state.turn.respond(requestId, reply)
  }
  async models(path: string, cwd?: string): Promise<Model[]> {
    if (this.closed) throw new Error('Agent runtime is closing.')
    const queue = new AsyncQueue<SDKUserMessage>()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12_000)
    let instance: Query | undefined
    try {
      instance = query({
        prompt: queue,
        options: {
          pathToClaudeCodeExecutable: path,
          cwd,
          settingSources: ['user', 'project', 'local'],
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          abortController: controller,
          env: getProcessEnvironment({ CLAUDE_AGENT_SDK_CLIENT_APP: 'coding-hub/0.1.0' }),
          spawnClaudeCodeProcess: (options) => spawnClaude(options, () => {}),
        },
      })
      const models = await instance.supportedModels()
      return models.map((model) => ({ id: model.value, name: model.displayName }))
    } finally {
      clearTimeout(timer)
      queue.end()
      instance?.close()
    }
  }
  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.active.keys()].map((id) => this.interrupt(id)))
  }
}
