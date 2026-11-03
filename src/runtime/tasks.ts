import { randomUUID } from 'node:crypto'
import { readFile, mkdir, open, rename, unlink, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { TaskDefinition, TaskRun } from '../shared/types'
import {
  prepareEnvironment,
  resolveCommand,
  launch,
  terminateProcessTree,
  finalizeOwnedChild,
} from './process'
import { redactDiagnostics, RedactingDiagnosticStream } from '../shared/diagnostics'

const MAX_OUTPUT = 256 * 1024
function diagnosticArguments(args: string[]): string[] {
  let redactNext = false
  return args.map((argument) => {
    if (redactNext) {
      redactNext = false
      return '[redacted]'
    }
    redactNext =
      /^--?(?:api[-_]?key|token|access[-_]?token|refresh[-_]?token|auth[-_]?token|password|secret|client[-_]?secret)$/i.test(
        argument,
      )
    return redactDiagnostics(argument).replace(
      /^(--?(?:api[-_]?key|token|password|secret))=.*/i,
      '$1=[redacted]',
    )
  })
}
export class TaskService {
  private readonly runs = new Map<string, TaskRun>()
  private readonly children = new Map<string, ChildProcessWithoutNullStreams>()
  private readonly reservations = new Set<string>()
  private readonly starts = new Set<Promise<unknown>>()
  private readonly finishers = new Map<string, () => Promise<void>>()
  private readonly cancelled = new Set<string>()
  private readonly writes = new Map<string, Promise<void>>()
  private closing = false
  constructor(private readonly emit: (run: TaskRun) => void) {}
  async definitions(root: string): Promise<TaskDefinition[]> {
    try {
      const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
      const files = await readdir(root)
      const manager =
        String(manifest.packageManager || '').split('@')[0] ||
        (files.includes('pnpm-lock.yaml')
          ? 'pnpm'
          : files.includes('yarn.lock')
            ? 'yarn'
            : files.includes('package-lock.json')
              ? 'npm'
              : files.includes('bun.lock') || files.includes('bun.lockb')
                ? 'bun'
                : 'pnpm')
      if (
        !['pnpm', 'npm', 'yarn', 'bun'].includes(manager) ||
        !manifest.scripts ||
        typeof manifest.scripts !== 'object' ||
        Array.isArray(manifest.scripts)
      )
        return []
      return Object.entries(manifest.scripts)
        .filter(([, value]) => typeof value === 'string')
        .map(([name]) => ({ id: name, name, command: manager, args: ['run', name] }))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error(`无法读取项目检查脚本：${redactDiagnostics(String(error))}`)
    }
  }
  private async persist(folder: string, run: TaskRun): Promise<void> {
    const value = JSON.stringify(run)
    const file = join(folder, `${run.id}.json`)
    const pending = (this.writes.get(run.id) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const temporary = `${file}.${randomUUID()}.tmp`
        try {
          const handle = await open(temporary, 'wx', 0o600)
          try {
            await handle.writeFile(value)
            await handle.sync()
          } finally {
            await handle.close()
          }
          await rename(temporary, file)
        } finally {
          await unlink(temporary).catch(() => {})
        }
      })
    this.writes.set(run.id, pending)
    try {
      await pending
    } finally {
      if (this.writes.get(run.id) === pending) this.writes.delete(run.id)
    }
  }
  async run(
    root: string,
    dataDir: string,
    workspaceId: string,
    definition: TaskDefinition,
    sessionId?: string,
    turnId?: string,
  ): Promise<TaskRun> {
    if (this.closing) throw new Error('应用正在退出，不能启动检查任务。')
    if (
      this.reservations.has(workspaceId) ||
      [...this.runs.values()].some(
        (run) => run.workspaceId === workspaceId && run.status === 'running',
      )
    )
      throw new Error('此工作区已有检查任务正在运行。')
    this.reservations.add(workspaceId)
    const starting = this.start(root, dataDir, workspaceId, definition, sessionId, turnId)
    this.starts.add(starting)
    try {
      return await starting
    } finally {
      this.starts.delete(starting)
      this.reservations.delete(workspaceId)
    }
  }
  private async start(
    root: string,
    dataDir: string,
    workspaceId: string,
    definition: TaskDefinition,
    sessionId?: string,
    turnId?: string,
  ): Promise<TaskRun> {
    await prepareEnvironment()
    const command = await resolveCommand(definition.command)
    if (!command) throw new Error(`未找到命令：${definition.command}`)
    if (this.closing) throw new Error('应用正在退出，检查任务尚未启动。')
    const run: TaskRun = {
      id: randomUUID(),
      workspaceId,
      sessionId,
      turnId,
      name: redactDiagnostics(definition.name),
      command: redactDiagnostics(definition.command),
      args: diagnosticArguments(definition.args),
      status: 'running',
      startedAt: Date.now(),
      output: '',
    }
    const folder = join(dataDir, 'tasks')
    await mkdir(folder, { recursive: true, mode: 0o700 })
    await this.persist(folder, run)
    this.runs.set(run.id, run)
    let child: ChildProcessWithoutNullStreams
    try {
      if (this.closing) throw new Error('应用正在退出，检查任务尚未启动。')
      child = launch(command, definition.args, root)
    } catch (error) {
      run.status = this.closing ? 'cancelled' : 'failed'
      run.finishedAt = Date.now()
      run.output = redactDiagnostics(String(error))
      await this.persist(folder, run)
      this.emit({ ...run })
      throw error
    }
    this.children.set(run.id, child)
    let pending: NodeJS.Timeout | undefined
    let saveTimer: NodeJS.Timeout | undefined
    let finalizing: Promise<void> | undefined
    let exitCode: number | null = null
    let closed = false
    let resolveClosed: (() => void) | undefined
    const closePromise = new Promise<void>((resolve) => {
      resolveClosed = resolve
    })
    const reportSaveFailure = (error: unknown) => {
      run.output = (
        run.output +
        `\n[TASK_RESULT_SAVE_FAILED] 保存检查结果失败：${redactDiagnostics(String(error))}`
      ).slice(-MAX_OUTPUT)
      this.emit({ ...run })
    }
    const changed = () => {
      if (!pending)
        pending = setTimeout(() => {
          pending = undefined
          this.emit({ ...run })
        }, 80)
      if (!saveTimer)
        saveTimer = setTimeout(() => {
          saveTimer = undefined
          void this.persist(folder, run).catch(reportSaveFailure)
        }, 500)
    }
    const append = (text: string) => {
      run.output = (run.output + redactDiagnostics(text)).slice(-MAX_OUTPUT)
      changed()
    }
    const decoders = [new RedactingDiagnosticStream(append), new RedactingDiagnosticStream(append)]
    const finalize = (): Promise<void> => {
      if (run.finishedAt) return Promise.resolve()
      if (finalizing) return finalizing
      finalizing = (async () => {
        await finalizeOwnedChild(child)
        if (!closed) {
          let timer: NodeJS.Timeout | undefined
          try {
            await Promise.race([
              closePromise,
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, 1000)
              }),
            ])
          } finally {
            if (timer) clearTimeout(timer)
          }
        }
        decoders.forEach((decoder) => decoder.end())
        if (pending) clearTimeout(pending)
        if (saveTimer) clearTimeout(saveTimer)
        pending = undefined
        saveTimer = undefined
        run.status = this.cancelled.has(run.id) ? 'cancelled' : exitCode === 0 ? 'passed' : 'failed'
        run.exitCode = exitCode ?? -1
        run.finishedAt = Date.now()
        this.children.delete(run.id)
        this.finishers.delete(run.id)
        this.cancelled.delete(run.id)
        await this.persist(folder, run).catch(reportSaveFailure)
        this.emit({ ...run })
        const completed = [...this.runs.values()]
          .filter((value) => value.finishedAt)
          .sort((a, b) => b.startedAt - a.startedAt)
        for (const entry of completed.slice(200)) this.runs.delete(entry.id)
      })().catch((error) => {
        finalizing = undefined
        append(
          `\n[PROCESS_CLEANUP_FAILED] 检查进程尚未确认结束，工作区保持锁定：${redactDiagnostics(String(error))}\n`,
        )
        this.emit({ ...run })
        throw error
      })
      return finalizing
    }
    this.finishers.set(run.id, finalize)
    child.stdout.on('data', (chunk) => decoders[0].push(chunk))
    child.stderr.on('data', (chunk) => decoders[1].push(chunk))
    child.on('error', (error) => {
      append(error.message + '\n')
      void finalize().catch(() => {})
    })
    child.once('exit', (code) => {
      exitCode = code
      void finalize().catch(() => {})
    })
    child.once('close', (code) => {
      closed = true
      resolveClosed?.()
      exitCode ??= code
      void finalize().catch(() => {})
    })
    child.stdin.end()
    this.emit({ ...run })
    return { ...run }
  }
  async cancel(id: string): Promise<void> {
    const child = this.children.get(id)
    if (!child) return
    this.cancelled.add(id)
    try {
      await terminateProcessTree(child)
      await this.finishers.get(id)?.()
    } catch (error) {
      this.cancelled.delete(id)
      throw error
    }
  }
  async list(dataDir: string, workspaceId?: string): Promise<TaskRun[]> {
    const records = new Map(this.runs)
    const folder = join(dataDir, 'tasks')
    for (const name of (await readdir(folder).catch(() => [])).filter((value) =>
      /^[\da-f-]+\.json$/.test(value),
    )) {
      try {
        const run = JSON.parse(await readFile(join(folder, name), 'utf8')) as TaskRun
        if (!run.id || !run.workspaceId || typeof run.output !== 'string') continue
        if (!records.has(run.id)) {
          if (run.status === 'running') {
            run.status = 'cancelled'
            run.finishedAt = Date.now()
            run.output += '\n上次应用退出时检查中断，未自动重新执行。'
          }
          records.set(run.id, run)
        }
      } catch {
        /* A damaged task result must not hide intact runs. */
      }
    }
    return [...records.values()]
      .filter((run) => !workspaceId || run.workspaceId === workspaceId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 100)
  }
  async close(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.starts])
    const results = await Promise.allSettled([...this.children.keys()].map((id) => this.cancel(id)))
    await Promise.allSettled([...this.writes.values()])
    if (results.some((result) => result.status === 'rejected'))
      throw new Error('部分检查进程尚未确认结束。')
  }
}
