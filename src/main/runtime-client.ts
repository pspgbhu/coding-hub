import { utilityProcess, type UtilityProcess } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { RuntimeMessage } from '../shared/runtime'
import { RedactingDiagnosticStream } from '../shared/diagnostics'

export class RuntimeClient extends EventEmitter {
  private child?: UtilityProcess
  private pending = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  private ready?: Promise<void>
  private closing = false
  start(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = new Promise((resolve, reject) => {
      const child = utilityProcess.fork(join(__dirname, 'runtime.js'), [], {
        serviceName: 'Coding Hub Runtime',
        stdio: 'pipe',
      })
      this.child = child
      const timeout = setTimeout(() => {
        if (this.child === child) {
          this.child = undefined
          this.ready = undefined
          child.kill()
          this.emit('exit', -1)
        }
        reject(new Error('后台服务启动超时，请重试。'))
      }, 20000)
      child.on('message', (message: RuntimeMessage) => {
        if (this.child !== child) return
        if (message.type === 'ready') {
          clearTimeout(timeout)
          resolve()
        } else if (message.type === 'event') this.emit('event', message.event)
        else if (message.type === 'terminal') this.emit('terminal', message.output)
        else if (message.type === 'task') this.emit('task', message.task)
        else if (message.type === 'ownership') this.emit('ownership', message.event)
        else if (message.type === 'response') {
          const pending = this.pending.get(message.id)
          if (!pending) return
          this.pending.delete(message.id)
          clearTimeout(pending.timer)
          if (message.error) pending.reject(new Error(message.error))
          else pending.resolve(message.result)
        }
      })
      const diagnostics = new RedactingDiagnosticStream((line) => this.emit('diagnostic', line))
      child.stderr?.on('data', (data) => diagnostics.push(data))
      child.stdout?.on('data', () => {})
      child.on('exit', (code) => {
        diagnostics.end()
        if (this.child !== child) return
        clearTimeout(timeout)
        this.child = undefined
        this.ready = undefined
        const error = new Error(`后台服务已退出 (${code})，请重试操作。`)
        reject(error)
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer)
          pending.reject(error)
        }
        this.pending.clear()
        this.emit('exit', code)
      })
    })
    const starting = this.ready
    void starting.catch(() => {
      if (this.ready === starting && !this.child) this.ready = undefined
    })
    return starting
  }
  async call<T = any>(method: string, ...args: unknown[]): Promise<T> {
    if (this.closing && method !== 'shutdown') throw new Error('应用正在退出。')
    await this.start()
    if (this.closing && method !== 'shutdown') throw new Error('应用正在退出。')
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const timer = setTimeout(
        () => {
          this.pending.delete(id)
          reject(new Error('操作超时，请检查 CLI 或重试。'))
        },
        method === 'agent.probe' ? 60000 : method === 'project.clone' ? 130000 : 45000,
      )
      this.pending.set(id, { resolve, reject, timer })
      this.child!.postMessage({ id, method, args })
    })
  }
  async close(): Promise<void> {
    this.closing = true
    const child = this.child
    if (!child) return
    let deadline: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        this.call('shutdown'),
        new Promise((resolve) => {
          deadline = setTimeout(resolve, 6000)
        }),
      ]).catch(() => {})
    } finally {
      if (deadline) clearTimeout(deadline)
    }
    if (this.child !== child) return
    const exited = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.removeListener('exit', done)
        reject(new Error('后台服务尚未确认退出，请重试停止。'))
      }, 6000)
      const done = () => {
        clearTimeout(timeout)
        resolve()
      }
      child.once('exit', done)
    })
    child.kill()
    await exited
  }
  resumeAfterFailedClose(): void {
    this.closing = false
  }
}
