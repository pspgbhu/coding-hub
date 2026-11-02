import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { IPty } from 'node-pty'
import type { EmitTerminal } from '../shared/runtime'
import {
  getProcessEnvironment,
  ownProcessTree,
  prepareEnvironment,
  type OwnedProcessTree,
} from './process'

const HIGH_WATER = 256 * 1024
const LOW_WATER = 64 * 1024
interface Terminal {
  pty: IPty
  pending: number
  paused: boolean
  tree: OwnedProcessTree
  exited: boolean
}

export class TerminalService {
  private terminals = new Map<string, Terminal>()
  private closing = false
  constructor(private readonly emit: EmitTerminal) {}

  async create(root: string, cols: number, rows: number): Promise<string> {
    if (this.closing) throw new Error('The terminal service is closing')
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
    }
    entry.tree = ownProcessTree(terminal.pid, () => !entry.exited)
    this.terminals.set(id, entry)
    terminal.onData((data) => {
      if (!this.terminals.has(id)) return
      entry.pending += Buffer.byteLength(data, 'utf8')
      if (!entry.paused && entry.pending >= HIGH_WATER) {
        terminal.pause()
        entry.paused = true
      }
      this.emit({ id, data })
    })
    terminal.onExit(({ exitCode }) => {
      entry.exited = true
      entry.tree.release()
      if (!this.terminals.delete(id)) return
      this.emit({ id, exitCode })
    })
    return id
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

  async close(id: string): Promise<void> {
    const entry = this.terminals.get(id)
    if (!entry) return
    this.terminals.delete(id)
    try {
      await entry.tree.terminate()
    } finally {
      if (!entry.exited) entry.pty.kill()
      this.emit({ id, exitCode: 0 })
    }
  }

  async closeAll(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.terminals.keys()].map((id) => this.close(id)))
  }
}
