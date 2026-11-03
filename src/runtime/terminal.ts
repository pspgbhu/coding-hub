import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { IPty } from 'node-pty'
import type { EmitTerminal } from '../shared/runtime'
import type { TerminalDescriptor } from '../shared/types'
import { ensureWindowsProcessApi } from './windows-process'
import {
  getProcessEnvironment,
  ownProcessTree,
  prepareEnvironment,
  type OwnedProcessTree,
} from './process'

const HIGH_WATER = 256 * 1024
const LOW_WATER = 64 * 1024
const REPLAY_CHARACTERS = 256 * 1024
interface Terminal {
  pty: IPty
  pending: number
  paused: boolean
  tree: OwnedProcessTree
  exited: boolean
  exitCode?: number
  cleanup?: Promise<void>
  descriptor: TerminalDescriptor
  sequence: number
}

export class TerminalService {
  private terminals = new Map<string, Terminal>()
  private completed = new Map<string, TerminalDescriptor>()
  private closing = false
  constructor(private readonly emit: EmitTerminal) {}

  async create(root: string, cols: number, rows: number, workspaceId?: string): Promise<string> {
    if (this.closing) throw new Error('The terminal service is closing')
    if (process.platform === 'win32') ensureWindowsProcessApi()
    await prepareEnvironment()
    const cwd = await realpath(root)
    const dimensions = this.dimensions(cols, rows)
    // Load the native module only in the Node utility process, never in a renderer.
    const nodePty = await import('node-pty')
    if (this.closing) throw new Error('The terminal service is closing')
    const shell =
      process.platform === 'win32'
        ? process.env.ComSpec || 'cmd.exe'
        : process.env.SHELL || '/bin/zsh'
    const terminal = nodePty.spawn(shell, process.platform === 'win32' ? [] : ['-l'], {
      name: 'xterm-256color',
      // node-pty 1.1's system-ConPTY kill races its console-list helper. The bundled backend owns cleanup directly.
      ...(process.platform === 'win32' ? { useConptyDll: true } : {}),
      ...dimensions,
      cwd,
      env: { ...getProcessEnvironment(), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    })
    const id = randomUUID()
    const entry: Terminal = {
      pty: terminal,
      pending: 0,
      paused: false,
      exited: false,
      tree: undefined!,
      sequence: 0,
      descriptor: {
        id,
        workspaceId,
        cwd,
        title: shell.split(/[\\/]/).at(-1) || 'Terminal',
        cols,
        rows,
        createdAt: Date.now(),
        buffer: '',
      },
    }
    // forkpty creates a dedicated POSIX session/process group; its surviving group keeps that identity reserved.
    entry.tree = ownProcessTree(terminal.pid, () => !entry.exited, process.platform !== 'win32')
    this.terminals.set(id, entry)
    terminal.onData((data) => {
      if (!this.terminals.has(id)) return
      entry.pending += Buffer.byteLength(data, 'utf8')
      entry.descriptor.sequence = ++entry.sequence
      entry.descriptor.buffer = ((entry.descriptor.buffer || '') + data).slice(-REPLAY_CHARACTERS)
      if (!entry.paused && entry.pending >= HIGH_WATER) {
        terminal.pause()
        entry.paused = true
      }
      this.emit({ id, data, sequence: entry.sequence })
    })
    terminal.onExit(({ exitCode }) => {
      entry.exited = true
      entry.exitCode = exitCode
      // Shell exit may arrive before late-descendant verification. Keep the workspace occupied until confirmed.
      void this.confirmExit(entry).catch(() => {
        /* The retained terminal reports a retryable cleanup diagnostic. */
      })
    })
    return id
  }

  list(workspaceId?: string): TerminalDescriptor[] {
    return [...this.terminals.values()]
      .map((entry) => entry.descriptor)
      .concat([...this.completed.values()])
      .filter((entry) => workspaceId === undefined || entry.workspaceId === workspaceId)
      .map((entry) => ({ ...entry, buffer: undefined }))
  }

  attach(id: string): TerminalDescriptor {
    const entry = this.terminals.get(id)
    if (!entry) {
      const completed = this.completed.get(id)
      if (!completed) throw new Error('Terminal does not exist or is already closed')
      return { ...completed }
    }
    entry.pending = 0
    if (entry.paused) {
      entry.pty.resume()
      entry.paused = false
    }
    return { ...entry.descriptor }
  }

  private remember(descriptor: TerminalDescriptor): void {
    this.completed.set(descriptor.id, descriptor)
    while (this.completed.size > 20) this.completed.delete(this.completed.keys().next().value!)
  }

  private get(id: string): Terminal {
    const terminal = this.terminals.get(id)
    if (!terminal) throw new Error('Terminal does not exist or is already closed')
    return terminal
  }

  private dimensions(cols: number, rows: number): { cols: number; rows: number } {
    if (
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < 1 ||
      rows < 1 ||
      cols > 1000 ||
      rows > 1000
    ) {
      throw new Error('Terminal dimensions must be integers between 1 and 1000')
    }
    return { cols, rows }
  }

  write(id: string, data: string): void {
    if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > 1024 * 1024)
      throw new Error('Terminal input exceeds the 1 MB limit')
    this.get(id).pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const dimensions = this.dimensions(cols, rows)
    this.get(id).pty.resize(dimensions.cols, dimensions.rows)
    Object.assign(this.get(id).descriptor, dimensions)
  }

  ack(id: string, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new Error('Invalid terminal acknowledgement')
    const entry = this.terminals.get(id)
    if (!entry) return // A final rendering ACK may arrive just after exit.
    entry.pending = Math.max(0, entry.pending - bytes)
    if (entry.paused && entry.pending <= LOW_WATER) {
      entry.pty.resume()
      entry.paused = false
    }
  }

  private confirmExit(entry: Terminal): Promise<void> {
    if (entry.cleanup) return entry.cleanup
    const id = entry.descriptor.id
    const pending = (async () => {
      try {
        await entry.tree.terminate()
        if (!entry.exited) entry.pty.kill()
        if (this.terminals.get(id) !== entry) return
        this.terminals.delete(id)
        const exitCode = entry.exitCode ?? 130
        this.remember({ ...entry.descriptor, sequence: ++entry.sequence, exitCode })
        this.emit({ id, exitCode, sequence: entry.sequence })
      } catch (error) {
        if (this.terminals.get(id) === entry) {
          const data = '\r\n[终端子进程清理尚未确认，工作区保持占用。请重试“终止当前终端”。]\r\n'
          entry.descriptor.sequence = ++entry.sequence
          entry.descriptor.buffer = ((entry.descriptor.buffer || '') + data).slice(
            -REPLAY_CHARACTERS,
          )
          this.emit({ id, data, sequence: entry.sequence })
        }
        throw error
      }
    })()
    const cleanup = pending.finally(() => {
      if (entry.cleanup === cleanup) entry.cleanup = undefined
    })
    entry.cleanup = cleanup
    return cleanup
  }

  async close(id: string): Promise<void> {
    const entry = this.terminals.get(id)
    if (!entry) return
    await this.confirmExit(entry)
  }

  async closeAll(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.terminals.keys()].map((id) => this.close(id)))
  }
}
