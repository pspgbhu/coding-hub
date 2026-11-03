import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { RedactingDiagnosticStream } from '../../shared/diagnostics'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AgentContext, EmitEvent } from '../../shared/runtime'
import type { Model } from '../../shared/types'
import { finalizeOwnedChild, launch, resolveCommand, terminateProcessTree } from '../process'
import { Turn, approved, errorMessage, inputImages, type Reply } from './common'

type Json = Record<string, any>
interface Server {
  child: ChildProcessWithoutNullStreams
  url: string
  auth: string
  cwd: string
  stream?: AbortController
  connecting?: Promise<void>
  connected: boolean
  closed: boolean
  stderr: string
  stopping?: Promise<void>
}
interface Active {
  turn: Turn
  server?: Server
  nativeId?: string
  submitted: boolean
  finishing: boolean
  sawActivity: boolean
  roles: Map<string, string>
  baseline: Set<string>
  requests: Set<string>
}
class PortCollisionError extends Error {}

/** SSE framing supports CRLF, multiline data and UTF-8 split across network chunks. */
export class SseDecoder {
  private readonly decoder = new TextDecoder()
  private buffer = ''
  constructor(private readonly receive: (event: Json) => void) {}
  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')
    // CRLF can itself straddle chunks; normalize after appending too.
    this.buffer = this.buffer.replace(/\r\n/g, '\n')
    if (this.buffer.length > 16 * 1024 * 1024)
      throw new Error('OpenCode SSE message exceeded 16 MB.')
    let end: number
    while ((end = this.buffer.indexOf('\n\n')) >= 0) {
      const frame = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 2)
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (data) this.receive(JSON.parse(data))
    }
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

export class OpenCodeAdapter {
  private readonly servers = new Map<string, Promise<Server>>()
  private readonly discoveryServers = new Set<Promise<Server>>()
  private readonly active = new Map<string, Active>()
  private closed = false
  constructor(private readonly emit: EmitEvent) {}
  async send(context: AgentContext, text: string, turnId: string): Promise<void> {
    if (this.closed) throw new Error('Agent runtime is closing.')
    if (this.active.has(context.session.id)) throw new Error('This session is already running.')
    const state: Active = {
      turn: new Turn(context, turnId, this.emit),
      submitted: false,
      finishing: false,
      sawActivity: false,
      roles: new Map(),
      baseline: new Set(),
      requests: new Set(),
    }
    this.active.set(context.session.id, state)
    state.turn.status('running')
    void this.start(state, text).catch(async (error) => {
      if (state.submitted && state.nativeId && !state.turn.ended) {
        state.turn.event({ kind: 'error', text: errorMessage(error) })
        await this.interrupt(context.session.id).catch(() => {})
      } else this.end(state, error)
    })
  }
  private async request(
    server: Server,
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<any> {
    const url = new URL(path, server.url)
    url.searchParams.set('directory', server.cwd)
    const response = await fetch(url, {
      method,
      redirect: 'error',
      headers: { authorization: server.auth, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) {
      const text = (await response.text()).slice(0, 2000)
      throw new Error(`OpenCode ${method} ${path}: ${response.status}${text ? ` — ${text}` : ''}`)
    }
    if (response.status === 204) return undefined
    const text = await response.text()
    return text ? JSON.parse(text) : undefined
  }
  private async server(cwd: string, customPath?: string): Promise<Server> {
    if (this.closed) throw new Error('Agent runtime is closing.')
    const path = await resolveCommand('opencode', customPath)
    if (this.closed) throw new Error('Agent runtime is closing.')
    if (!path)
      throw new Error(
        'OpenCode CLI was not found. Install and configure it, or select its executable in Settings.',
      )
    const key = `${path}\0${cwd}`
    let pending = this.servers.get(key)
    if (!pending) {
      pending = this.createServer(path, cwd)
      this.servers.set(key, pending)
      pending.catch(() => {
        if (this.servers.get(key) === pending) this.servers.delete(key)
      })
    }
    const server = await pending
    if (server.closed) {
      this.servers.delete(key)
      return this.server(cwd, customPath)
    }
    if (!server.connected) {
      server.connecting ??= this.watch(server).finally(() => {
        server.connecting = undefined
      })
      await server.connecting
    }
    return server
  }
  private async createServer(path: string, cwd: string): Promise<Server> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.createServerAttempt(path, cwd)
      } catch (error) {
        if (
          this.closed ||
          attempt >= 2 ||
          !(
            error instanceof PortCollisionError ||
            /EADDRINUSE|address already in use|port.*(?:in use|already)|failed to start server on port/i.test(
              errorMessage(error),
            )
          )
        )
          throw error
      }
    }
  }
  private async createServerAttempt(path: string, cwd: string): Promise<Server> {
    const port = await freePort()
    if (this.closed) throw new Error('Agent runtime is closing.')
    const password = randomBytes(32).toString('hex')
    const child = launch(
      path,
      ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--mdns=false'],
      cwd,
      { OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: password },
    )
    const server: Server = {
      child,
      url: `http://127.0.0.1:${port}`,
      auth: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
      cwd,
      connected: false,
      closed: false,
      stderr: '',
    }
    const diagnostics = new RedactingDiagnosticStream((text) => {
      server.stderr = (server.stderr + text).slice(-4000)
    })
    child.stdout.on('data', () => {})
    child.stdin.on('error', () => {})
    child.stderr.on('data', (chunk: Buffer) => diagnostics.push(chunk))
    child.stderr.once('end', () => diagnostics.end())
    let spawnError: Error | undefined
    child.once('error', (error) => {
      spawnError = error
      this.serverFailed(server, error)
    })
    child.once('close', async (code, signal) => {
      if (server.closed) return
      try {
        await finalizeOwnedChild(child)
      } catch (error) {
        server.closed = true
        server.stream?.abort()
        for (const state of this.active.values())
          if (state.server === server) state.turn.failStop(error)
        return
      }
      if (!server.closed)
        this.serverFailed(
          server,
          new Error(
            `OpenCode server exited (${signal ?? code}).${server.stderr ? `\n${server.stderr}` : ''}`,
          ),
        )
    })
    try {
      const deadline = Date.now() + 20_000
      while (true) {
        if (this.closed || spawnError || server.closed)
          throw (
            spawnError ??
            new Error(
              `OpenCode server could not start.${server.stderr ? `\n${server.stderr}` : ''}`,
            )
          )
        try {
          const response = await fetch(`${server.url}/global/health`, {
            redirect: 'error',
            headers: { authorization: server.auth },
            signal: AbortSignal.timeout(700),
          })
          if (response.ok) {
            let health: unknown
            try {
              health = await response.json()
            } catch {
              throw new PortCollisionError(
                'OpenCode health endpoint returned invalid JSON; the port may belong to another process.',
              )
            }
            if (
              !health ||
              typeof health !== 'object' ||
              !('healthy' in health) ||
              health.healthy !== true ||
              !('version' in health) ||
              typeof health.version !== 'string'
            )
              throw new PortCollisionError(
                'OpenCode health response did not match the expected healthy/version schema.',
              )
            const unauthorized = await fetch(`${server.url}/global/health`, {
              redirect: 'error',
              signal: AbortSignal.timeout(700),
            })
            void unauthorized.body?.cancel()
            if (unauthorized.status !== 401)
              throw new PortCollisionError(
                'OpenCode server did not enforce password authentication (expected HTTP 401 without credentials).',
              )
            break
          }
          if (response.status === 401)
            throw new PortCollisionError(
              'OpenCode rejected this server’s unique password; the port may belong to another process.',
            )
          void response.body?.cancel()
        } catch (error) {
          if (error instanceof PortCollisionError)
            throw error /* Otherwise the server is still starting. */
        }
        if (Date.now() > deadline)
          throw new Error(
            `OpenCode server did not become ready within 20 seconds.${server.stderr ? `\n${server.stderr}` : ''}`,
          )
        await new Promise((resolve) => setTimeout(resolve, 120))
      }
      await this.watch(server)
      return server
    } catch (error) {
      await this.stopServer(server)
      throw error
    }
  }
  private async watch(server: Server): Promise<void> {
    if (server.connected) return
    const controller = new AbortController()
    server.stream = controller
    const url = new URL('/event', server.url)
    url.searchParams.set('directory', server.cwd)
    const timer = setTimeout(() => controller.abort(), 20_000)
    let response: Response
    try {
      response = await fetch(url, {
        redirect: 'error',
        headers: { authorization: server.auth, accept: 'text/event-stream' },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (
      !response.ok ||
      !response.body ||
      !response.headers.get('content-type')?.includes('text/event-stream')
    )
      throw new Error(`OpenCode event stream could not connect (${response.status}).`)
    server.connected = true
    const reader = response.body.getReader()
    const decoder = new SseDecoder((event) => this.event(server, event))
    void (async () => {
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          decoder.push(chunk.value)
        }
        if (!controller.signal.aborted)
          throw new Error(
            'OpenCode event stream disconnected. Send another message to resume the session.',
          )
      } catch (error) {
        if (!controller.signal.aborted)
          for (const state of this.active.values())
            if (state.server === server) {
              state.turn.event({ kind: 'error', text: errorMessage(error) })
              await this.interrupt(state.turn.context.session.id).catch(() => {})
            }
      } finally {
        if (server.stream === controller) server.connected = false
        reader.releaseLock()
      }
    })()
  }
  private async start(state: Active, text: string): Promise<void> {
    const server = await this.server(state.turn.context.cwd, state.turn.context.cliPath)
    state.server = server
    if (state.turn.interrupted || state.turn.ended) return
    const existing = state.turn.context.session.nativeId
    const session = existing
      ? await this.request(server, `/session/${encodeURIComponent(existing)}`)
      : await this.request(server, '/session', 'POST', { title: state.turn.context.session.title })
    state.nativeId = session.id
    state.turn.event({ kind: 'session', nativeId: session.id })
    // Existing native messages are context, not new output for this app turn.
    if (existing) {
      const messages = await this.request(
        server,
        `/session/${encodeURIComponent(session.id)}/message`,
      )
      for (const message of messages ?? []) state.baseline.add(message.info.id)
    }
    if (state.turn.interrupted || state.turn.ended) return
    const model = state.turn.context.session.model
    let selectedModel: { providerID: string; modelID: string } | undefined
    if (model) {
      const index = model.indexOf('/')
      if (index < 1)
        throw new Error(
          'Select an OpenCode model as provider/model, for example anthropic/claude-sonnet-4-6.',
        )
      selectedModel = { providerID: model.slice(0, index), modelID: model.slice(index + 1) }
    }
    state.submitted = true
    await this.request(server, `/session/${encodeURIComponent(session.id)}/prompt_async`, 'POST', {
      parts: [
        { type: 'text', text },
        ...inputImages(state.turn.context).map((image) => ({
          type: 'file',
          mime: image.mimeType,
          filename: image.name,
          url: image.dataUrl,
        })),
      ],
      ...(selectedModel ? { model: selectedModel } : {}),
    })
  }
  private event(server: Server, event: Json): void {
    const p = event.properties ?? {}
    const nativeId = p.sessionID ?? p.part?.sessionID ?? p.info?.sessionID
    const state = [...this.active.values()].find(
      (entry) => entry.server === server && entry.nativeId === nativeId,
    )
    if (!state || state.turn.ended || !state.submitted) return
    if (event.type === 'message.updated') {
      state.roles.set(p.info.id, p.info.role)
      if (p.info.role === 'assistant' && !state.baseline.has(p.info.id)) state.sawActivity = true
      if (p.info.role === 'assistant' && !state.baseline.has(p.info.id) && p.info.time?.completed) {
        state.turn.event({
          kind: 'usage',
          tokens:
            p.info.tokens?.total ?? (p.info.tokens?.input ?? 0) + (p.info.tokens?.output ?? 0),
          cost: p.info.cost,
        })
        if (p.info.error)
          this.end(
            state,
            new Error(
              p.info.error.data?.message ?? p.info.error.name ?? 'OpenCode model request failed.',
            ),
          )
      }
    }
    if (
      event.type === 'message.part.delta' &&
      p.field === 'text' &&
      state.roles.get(p.messageID) === 'assistant' &&
      !state.baseline.has(p.messageID)
    )
      state.turn.event({ kind: 'text', itemId: p.partID, text: p.delta, delta: true })
    if (event.type === 'message.part.updated') this.part(state, p.part)
    if (event.type === 'session.error')
      this.end(
        state,
        new Error(p.error?.data?.message ?? p.error?.name ?? 'OpenCode session failed.'),
      )
    if (event.type === 'session.status' && p.status?.type === 'busy') {
      state.sawActivity = true
      if (!state.turn.pending.size) state.turn.status('running')
    }
    if (
      state.sawActivity &&
      ((event.type === 'session.status' && p.status?.type === 'idle') ||
        event.type === 'session.idle')
    )
      void this.complete(state)
    if (event.type === 'permission.asked' || event.type === 'question.asked')
      void this.ask(state, event.type, p).catch((error) => this.end(state, error))
    if (
      ['permission.replied', 'question.replied', 'question.rejected'].includes(event.type) &&
      state.turn.pending.has(p.requestID)
    )
      state.turn.resolveExternal(p.requestID)
  }
  private part(state: Active, part: Json): void {
    if (
      !part ||
      state.baseline.has(part.messageID) ||
      state.roles.get(part.messageID) !== 'assistant'
    )
      return
    if (part.type === 'text')
      state.turn.event({ kind: 'text', itemId: part.id, text: part.text, delta: false })
    if (part.type === 'tool')
      state.turn.event({
        kind: 'tool',
        itemId: part.id,
        name: part.tool,
        input: part.state?.input,
        output: part.state?.output ?? part.state?.error,
        state:
          part.state?.status === 'error'
            ? 'error'
            : part.state?.status === 'completed'
              ? 'completed'
              : 'running',
      })
  }
  private async complete(state: Active): Promise<void> {
    if (state.finishing || state.turn.ended) return
    state.finishing = true
    try {
      // Snapshot reconciles any final text arriving at the same time as idle.
      const messages = await this.request(
        state.server!,
        `/session/${encodeURIComponent(state.nativeId!)}/message`,
      )
      for (const message of messages ?? [])
        if (message.info?.role === 'assistant' && !state.baseline.has(message.info.id)) {
          state.roles.set(message.info.id, 'assistant')
          for (const part of message.parts ?? []) this.part(state, part)
          if (message.info.error)
            throw new Error(
              message.info.error.data?.message ??
                message.info.error.name ??
                'OpenCode request failed.',
            )
        }
      this.end(state)
    } catch (error) {
      this.end(state, error)
    }
  }
  private async ask(state: Active, type: string, request: Json): Promise<void> {
    if (state.requests.has(request.id)) return
    state.requests.add(request.id)
    const question = type === 'question.asked'
    await state.turn.ask(
      request.id,
      question
        ? {
            kind: 'question',
            name: 'User input',
            questions: request.questions.map((q: Json, index: number) => ({
              id: String(index),
              title: q.question,
              options: q.options,
              multiple: q.multiple,
            })),
          }
        : {
            kind: 'approval',
            name: request.permission,
            input: { patterns: request.patterns, metadata: request.metadata },
            decisions: ['once', 'always', 'reject'],
          },
      async (reply) => {
        if (!state.server || state.turn.ended || state.turn.interrupted)
          throw new Error('This request is no longer active.')
        const id = encodeURIComponent(request.id)
        if (question) {
          if (reply.answers)
            await this.request(state.server, `/question/${id}/reply`, 'POST', {
              answers: request.questions.map(
                (_: unknown, index: number) => reply.answers?.[String(index)] ?? [],
              ),
            })
          else await this.request(state.server, `/question/${id}/reject`, 'POST')
        } else
          await this.request(state.server, `/permission/${id}/reply`, 'POST', {
            reply:
              reply.decision === 'always' ? 'always' : approved(reply.decision) ? 'once' : 'reject',
          })
      },
    )
  }
  private end(state: Active, error?: unknown): void {
    if (state.turn.ended) return
    if (state.turn.interrupted && error && ['stopping', 'failed'].includes(state.turn.stopState)) {
      state.turn.failStop(error)
      return
    }
    state.turn.finish(state.turn.interrupted ? 'interrupted' : error ? 'error' : 'idle', error)
    if (this.active.get(state.turn.context.session.id) === state)
      this.active.delete(state.turn.context.session.id)
  }
  private serverFailed(server: Server, error: Error): void {
    if (server.closed) return
    server.closed = true
    server.stream?.abort()
    for (const state of this.active.values()) if (state.server === server) this.end(state, error)
  }
  private stopServer(server: Server): Promise<void> {
    if (server.stopping) return server.stopping
    server.closed = true
    server.stream?.abort()
    server.child.stdin.end()
    server.stopping = terminateProcessTree(server.child).catch(() => {})
    return server.stopping
  }
  async interrupt(sessionId: string): Promise<void> {
    const state = this.active.get(sessionId)
    if (!state) return
    state.turn.beginStop()
    try {
      if (state.server && state.nativeId)
        await this.request(
          state.server,
          `/session/${encodeURIComponent(state.nativeId)}/abort`,
          'POST',
        )
      this.end(state)
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
  async models(path: string, cwd = process.cwd()): Promise<Model[]> {
    if (this.closed) throw new Error('Agent runtime is closing.')
    const executable = await resolveCommand('opencode', path)
    if (this.closed) throw new Error('Agent runtime is closing.')
    if (!executable) throw new Error('OpenCode CLI was not found.')
    const key = `${executable}\0${cwd}`
    const cached = this.servers.get(key)
    let server = cached ? await cached : undefined
    if (server?.closed) {
      if (this.servers.get(key) === cached) this.servers.delete(key)
      server = undefined
    }
    // Discovery owns an independent short-lived process unless a send has
    // already reserved its persistent project server. It must never release
    // a server that a concurrently starting native session is using.
    const temporary = !server
    let discovery: Promise<Server> | undefined
    if (!server) {
      if (this.closed) throw new Error('Agent runtime is closing.')
      discovery = this.createServer(executable, cwd)
      this.discoveryServers.add(discovery)
    }
    try {
      server ??= await discovery!
      if (this.closed) throw new Error('Agent runtime is closing.')
      const data = await this.request(server, '/provider')
      return (data.all ?? [])
        .filter((provider: Json) => data.connected?.includes(provider.id))
        .flatMap((provider: Json) =>
          Object.entries(provider.models ?? {}).map(([id, model]) => ({
            id: `${provider.id}/${id}`,
            name: `${provider.name ?? provider.id} / ${(model as Json).name ?? id}`,
          })),
        )
    } finally {
      if (temporary && server) await this.stopServer(server)
      if (discovery) this.discoveryServers.delete(discovery)
    }
  }
  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.active.keys()].map((id) => this.interrupt(id)))
    const servers = await Promise.allSettled([
      ...this.servers.values(),
      ...this.discoveryServers.values(),
    ])
    await Promise.all(
      servers.flatMap((result) =>
        result.status === 'fulfilled' ? [this.stopServer(result.value)] : [],
      ),
    )
    this.servers.clear()
    this.discoveryServers.clear()
  }
}
