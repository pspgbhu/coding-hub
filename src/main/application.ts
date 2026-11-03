import { app, dialog, shell, Notification, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, extname, relative, isAbsolute } from 'node:path'
import { mkdir, realpath, readFile, writeFile, stat, rm, rename } from 'node:fs/promises'
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  statSync,
} from 'node:fs'
import { z } from 'zod'
import { Store } from './store'
import { RuntimeClient } from './runtime-client'
import {
  ACTIVE_STATUSES,
  type AgentEvent,
  type AppHealth,
  type ContextItem,
  type Settings,
  type Workspace,
  type WorkspaceIdentity,
  type TaskRun,
  type TerminalOutput,
  type TerminalDescriptor,
  type TurnInput,
  type TurnReview,
} from '../shared/types'
import { redactDiagnostics, redactNativeEventInput } from '../shared/diagnostics'
import {
  terminateOwnedProcesses,
  resolveCommand,
  type ProcessOwnership,
  type ProcessOwnershipEvent,
} from '../runtime/process'
import { UpdateService } from './updates'
import { tmpdir } from 'node:os'
import crossSpawn from 'cross-spawn'
import { EventBatcher } from './event-batcher'
import { OutputStore } from './output-store'
import { exportSessionFile } from './session-export'

const id = z.string().uuid()
const pathText = z.string().min(1).max(4096)
const contextSchema = z.object({
  id: z.string().max(200),
  kind: z.enum(['file', 'selection', 'terminal', 'diff', 'image']),
  name: z.string().max(500),
  content: z.string().max(60000).optional(),
  path: z.string().max(4096).optional(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  mimeType: z.string().optional(),
  dataUrl: z
    .string()
    .max(12 * 1024 * 1024)
    .optional(),
})
const inputSchema = z.object({
  text: z.string().max(100000),
  context: z.array(contextSchema).max(20),
})
const settingsSchema = z.object({
  theme: z.enum(['system', 'dark', 'light']),
  cliPaths: z.object({
    claude: z.string().max(4096).optional(),
    codex: z.string().max(4096).optional(),
    opencode: z.string().max(4096).optional(),
  }),
  lastProjectId: z.string().optional(),
  lastSessionId: z.string().optional(),
  fontSize: z.number().int().min(10).max(24).optional(),
  tabSize: z.number().int().min(1).max(8).optional(),
  sendKey: z.enum(['enter', 'mod-enter']).optional(),
  notifications: z.boolean().optional(),
  sidebarWidth: z.number().min(180).max(420).optional(),
  workspaceWidth: z.number().min(350).max(1400).optional(),
  terminalHeight: z.number().min(140).max(700).optional(),
})
const active = (status: string) =>
  ACTIVE_STATUSES.includes(status as (typeof ACTIVE_STATUSES)[number])
async function writeExportFile(path: string, content: string): Promise<void> {
  const temporary = path + '.coding-hub-' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

export class ApplicationServices {
  readonly healthState: AppHealth = { storage: 'ready', runtime: 'starting' }
  private readonly mutations = new Map<string, WorkspaceIdentity>()
  private readonly reservations = new Map<string, WorkspaceIdentity>()
  private readonly identities = new Map<string, WorkspaceIdentity>()
  private readonly finalizing = new Map<string, WorkspaceIdentity>()
  private readonly reviewCompletions = new Set<Promise<void>>()
  private readonly terminals = new Map<string, string>()
  private readonly owned = new Map<string, ProcessOwnership>()
  private ownershipReadError?: Error
  private readonly tasks = new Map<string, TaskRun>()
  private readonly recoveringTasks = new Set<string>()
  private pendingEvents: AgentEvent[] = []
  private dataGeneration = randomUUID()
  private restoring = false
  private projectOperations = 0
  private closing = false
  private readonly outputStore: OutputStore
  private readonly eventBatcher = new EventBatcher((event) => this.receive(event))
  private cleanup?: Promise<void>
  private readonly dataDir = app.getPath('userData')
  private readonly updates: UpdateService
  constructor(
    readonly runtime: RuntimeClient,
    readonly store: Store,
    private readonly window: () => BrowserWindow | undefined,
  ) {
    this.outputStore = new OutputStore(this.dataDir)
    this.updates = new UpdateService(
      (state) => this.broadcast('hub:update', state),
      async () => {
        for (const workspace of this.store.workspaces()) {
          await this.assertIdle(workspace)
          if (this.store.getEditorState(workspace.id).files.some((f) => f.edited !== f.content))
            throw new Error('请先保存或关闭未保存文件，再安装更新。')
        }
        if (this.terminals.size) throw new Error('终端仍在运行，请先终止终端后安装更新。')
        this.writable()
      },
    )
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
    for (const task of this.taskRecords()) {
      if (task.status !== 'running') continue
      this.tasks.set(task.id, task)
      this.recoveringTasks.add(task.id)
    }
    this.readOwnership(true)
    if (!this.ownershipReadError && (this.owned.size || this.recoveringTasks.size))
      this.cleanup = this.cleanOwnedProcesses().then(() => this.reconcileRecoveredTasks())
    runtime.on('ownership', (event: ProcessOwnershipEvent) => {
      if (event.action === 'register') this.owned.set(event.process.id, event.process)
      else this.owned.delete(event.process.id)
      if (this.ownershipReadError) return
      if (!this.persistOwnership() && event.action === 'register') {
        this.failStorage(new Error('受管进程恢复记录无法保存。'))
        this.cleanup = this.cleanOwnedProcesses()
        void this.cleanup.catch((error) => this.log('ownership-cleanup', String(error)))
      }
    })
    runtime.on('diagnostic', (line: string) => this.log('runtime', line))
    runtime.on('event', (event: AgentEvent) => this.eventBatcher.push(event))
    runtime.on('terminal', (output: TerminalOutput) => {
      this.broadcast('hub:terminal', output)
      if (output.exitCode !== undefined) this.terminals.delete(output.id)
    })
    runtime.on('task', (task: TaskRun) => {
      this.tasks.set(task.id, task)
      try {
        this.saveArtifact('task:' + task.id, task)
      } catch (error) {
        this.failStorage(error)
      }
      this.broadcast('hub:task', task)
      if (task.status !== 'running') this.notify('检查已结束', task.name)
    })
    runtime.on('exit', () => {
      if (!this.closing) this.cleanup = this.runtimeExited()
    })
    if (store.backupError) this.reportBackupFailure(store.backupError)
  }
  reportBackupFailure(error: unknown): void {
    this.log('backup', String(error))
    this.setHealth({
      code: 'BACKUP_FAILED',
      message: '自动备份未完成，当前数据库仍可使用。请检查磁盘空间，并在数据设置中重新备份。',
    })
  }
  private assertGeneration(generation: unknown): void {
    if (this.restoring) throw new Error('正在恢复数据，暂不接受旧页面保存。')
    if (generation !== undefined && generation !== this.dataGeneration)
      throw new Error('[STALE_DATA_GENERATION] 数据已恢复，旧窗口的延迟保存已忽略。')
  }
  private assertOwnershipReadable(): void {
    if (this.ownershipReadError) throw this.ownershipReadError
  }
  private readOwnership(allowFirstLaunch = false): void {
    const file = join(this.dataDir, 'owned-processes.json')
    try {
      let raw: unknown
      try {
        raw = JSON.parse(readFileSync(file, 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (!allowFirstLaunch || this.owned.size || this.recoveringTasks.size)
          throw new Error('Process ownership file is missing while execution may still exist.')
        raw = []
      }
      // Birth identities are native ps lstart text (including localized day/month names),
      // or the UTC DateTime ticks produced by Windows CIM. Never accept an arbitrary PID alone.
      const birth = z
        .string()
        .max(256)
        .refine((value) => {
          if (/^\d{17,19}$/.test(value)) {
            const ticks = BigInt(value)
            return ticks >= 621355968000000000n && ticks <= 3155378975999999999n
          }
          const date = /^(\S+)\s+(\S+)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(value)
          return (
            !!date &&
            Number(date[3]) >= 1 &&
            Number(date[3]) <= 31 &&
            Number(date[4]) <= 23 &&
            Number(date[5]) <= 59 &&
            Number(date[6]) <= 59 &&
            Number(date[7]) >= 1970 &&
            !/[\u0000-\u001f\u007f]/.test(value)
          )
        })
      const pid = z.number().int().min(2).max(0xffffffff)
      const member = z.object({ pid, started: birth })
      const record = z
        .object({
          id: z
            .string()
            .min(1)
            .max(1024)
            .refine((value) => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value)),
          pid,
          started: z.union([birth, z.literal('')]),
          isolatedGroup: z.boolean(),
          members: z.array(member).max(50000).optional(),
        })
        .refine(
          (entry) =>
            entry.started !== '' || entry.members?.some((member) => member.pid !== entry.pid),
          {
            message: 'A missing leader birth requires a separately verified member identity.',
          },
        )
      const records = z.array(record).max(10000).parse(raw)
      const ids = new Set<string>()
      for (const entry of records) {
        if (ids.has(entry.id)) throw new Error('Duplicate process ownership record.')
        ids.add(entry.id)
        const existing = this.owned.get(entry.id)
        if (
          existing &&
          (existing.pid !== entry.pid ||
            existing.started !== entry.started ||
            existing.isolatedGroup !== entry.isolatedGroup)
        )
          throw new Error('Conflicting process ownership identities.')
      }
      // Validate the complete file before admitting any record to process cleanup.
      for (const entry of records) {
        const existing = this.owned.get(entry.id)
        this.owned.set(
          entry.id,
          existing
            ? {
                ...entry,
                members: [
                  ...new Map(
                    [...(entry.members ?? []), ...(existing.members ?? [])].map((member) => [
                      `${member.pid}:${member.started}`,
                      member,
                    ]),
                  ).values(),
                ],
              }
            : entry,
        )
      }
      this.ownershipReadError = undefined
    } catch {
      this.ownershipReadError = new Error(
        `[OWNERSHIP_RECORD_INVALID] 进程记录损坏/丢失，无法确认旧执行已停止，已暂停新执行。原文件保留在 ${file}。请保留原件，从可信备份修复该记录并恢复读取权限，再点击“重试恢复”；请勿直接删除或重置为空账本。`,
      )
      this.setHealth({
        runtime: 'error',
        code: 'OWNERSHIP_RECORD_INVALID',
        message: this.ownershipReadError.message,
      })
    }
  }
  private persistOwnership(): boolean {
    if (this.ownershipReadError) return false
    try {
      const file = join(this.dataDir, 'owned-processes.json')
      writeFileSync(file + '.tmp', JSON.stringify([...this.owned.values()]), { mode: 0o600 })
      renameSync(file + '.tmp', file)
      return true
    } catch (error) {
      this.log('ownership', String(error))
      return false
    }
  }
  private saveArtifact(key: string, value: unknown): void {
    this.store.db
      .prepare(
        'INSERT INTO settings(key,data) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data',
      )
      .run(key, JSON.stringify(value))
  }
  private artifact<T>(key: string): T | null {
    const row = this.store.db.prepare('SELECT data FROM settings WHERE key=?').get(key) as
      { data: string } | undefined
    return row ? (JSON.parse(row.data) as T) : null
  }
  private taskRecords(): TaskRun[] {
    const rows = this.store.db
      .prepare("SELECT data FROM settings WHERE key LIKE 'task:%'")
      .all() as { data: string }[]
    return rows.map((row) => JSON.parse(row.data) as TaskRun)
  }
  private storedTasks(workspaceId?: string): TaskRun[] {
    const latest = new Map(this.taskRecords().map((run) => [run.id, run]))
    // Task events can reach memory while disk writes fail. Keep their latest state visible and retryable.
    for (const run of this.tasks.values()) latest.set(run.id, run)
    return [...latest.values()]
      .filter((run) => !workspaceId || run.workspaceId === workspaceId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 100)
  }
  /** Call only after the process ownership cleanup has confirmed that the old runtime cannot execute. */
  private reconcileRecoveredTasks(
    reason = '后台服务已退出，受管进程已确认停止；检查已中断，未自动重发。',
  ): void {
    this.assertOwnershipReadable()
    // Stage every confirmed terminal state before disk writes, so retries keep the original recovery reason.
    for (const taskId of this.recoveringTasks) {
      const previous = this.tasks.get(taskId)
      if (previous?.status === 'running')
        this.tasks.set(taskId, {
          ...previous,
          status: 'cancelled',
          finishedAt: Date.now(),
          output: (previous.output + '\n' + reason + '\n').slice(-256 * 1024),
        })
    }
    for (const taskId of this.recoveringTasks) {
      const task = this.tasks.get(taskId)
      if (!task) {
        this.recoveringTasks.delete(taskId)
        continue
      }
      try {
        this.saveArtifact('task:' + task.id, task)
      } catch (error) {
        this.failStorage(error)
        throw error
      } finally {
        this.broadcast('hub:task', task)
      }
      this.recoveringTasks.delete(taskId)
    }
  }
  private async cleanOwnedProcesses(): Promise<void> {
    this.assertOwnershipReadable()
    if (!this.owned.size) return
    try {
      while (this.owned.size) {
        const processes = [...this.owned.values()]
        await terminateOwnedProcesses(processes)
        for (const process of processes) this.owned.delete(process.id)
        this.persistOwnership()
      }
    } catch (error) {
      this.setHealth({
        runtime: 'error',
        code: 'PROCESS_CLEANUP_FAILED',
        message: '受管进程尚未确认结束，已暂停新任务。请重试恢复。',
      })
      throw error
    }
  }
  private async runtimeExited(): Promise<void> {
    for (const task of this.tasks.values())
      if (task.status === 'running') this.recoveringTasks.add(task.id)
    this.setHealth({
      runtime: 'error',
      code: 'RUNTIME_EXIT',
      message: '后台服务已退出，正在清理受管进程。',
    })
    let stopped = true
    try {
      await this.cleanOwnedProcesses()
    } catch {
      stopped = false
    }
    if (stopped) {
      try {
        this.reconcileRecoveredTasks()
      } catch {
        /* The latest task state remains in memory for storage retry. */
      }
    }
    for (const session of this.store.sessions({ includeDeleted: true, includeRemoved: true })) {
      if (!active(session.status)) continue
      const turnId = session.activeTurnId ?? randomUUID()
      this.receive({
        id: randomUUID(),
        sessionId: session.id,
        turnId,
        timestamp: Date.now(),
        kind: 'error',
        text: stopped
          ? '后台服务意外退出。本轮已中断，未自动重新执行。'
          : '受管进程停止失败。工作区保持锁定，请重试停止。',
      })
      this.receive({
        id: randomUUID(),
        sessionId: session.id,
        turnId,
        timestamp: Date.now(),
        kind: stopped ? 'done' : 'status',
        status: stopped ? 'interrupted' : 'stop_failed',
      })
    }
    this.terminals.clear()
    this.broadcast('hub:sessions')
  }
  private log(category: string, value: string): void {
    try {
      const file = join(this.dataDir, 'diagnostics.log')
      if (existsSync(file) && statSync(file).size > 1024 * 1024)
        renameSync(file, join(this.dataDir, 'diagnostics.previous.log'))
      appendFileSync(
        file,
        `${new Date().toISOString()} [${category}] ${redactDiagnostics(value).slice(0, 10000)}\n`,
        { mode: 0o600 },
      )
    } catch {
      /* The visible health state remains available if the disk is full. */
    }
  }
  private broadcast(channel: string, value?: unknown): void {
    try {
      const window = this.window()
      if (window && !window.isDestroyed()) window.webContents.send(channel, value)
    } catch (error) {
      this.log('renderer-delivery', String(error))
    }
  }
  private setHealth(patch: Partial<AppHealth>): void {
    Object.assign(this.healthState, patch)
    if (this.ownershipReadError)
      Object.assign(this.healthState, {
        runtime: 'error',
        code: 'OWNERSHIP_RECORD_INVALID',
        message: this.ownershipReadError.message,
      })
    this.broadcast('hub:health', { ...this.healthState })
  }
  private failStorage(error: unknown): void {
    this.log('storage', String(error))
    if (this.healthState.storage === 'error') return
    this.setHealth({
      storage: 'error',
      code: 'STORAGE_WRITE_FAILED',
      message:
        '本地数据保存失败，已暂停新任务。请检查磁盘空间或备份后重试；当前草稿仍保留在窗口中。',
    })
    for (const session of this.store.sessions())
      if (active(session.status))
        void this.runtime
          .call('agent.interrupt', session.id)
          .catch((e) => this.log('stop', String(e)))
    for (const task of this.tasks.values())
      if (task.status === 'running')
        void this.runtime
          .call('task.cancel', task.id)
          .catch((e) => this.log('task-stop', String(e)))
  }
  private receive(event: AgentEvent, replaying = false): boolean {
    if (this.healthState.storage === 'error' && !replaying) {
      if (this.pendingEvents.length < 1000) this.pendingEvents.push(event)
      return false
    }
    try {
      if ((event.kind === 'tool' || event.kind === 'approval') && event.input !== undefined)
        event = {
          ...event,
          input: redactNativeEventInput(event.input, {
            command: /^(?:commandExecution|Run command|bash|shell|execute)$/i.test(
              event.name ?? '',
            ),
          }),
        }
      if (event.kind === 'done') {
        const outputs = this.outputStore.finishTurn(
          event.sessionId,
          event.turnId,
          event.status ?? 'idle',
        )
        for (let index = 0; index < outputs.length; index++)
          if (!this.receive(outputs[index], replaying)) {
            this.pendingEvents.push(
              ...outputs
                .slice(index + 1)
                .concat(event)
                .slice(0, 1000 - this.pendingEvents.length),
            )
            return false
          }
      }
      event = this.outputStore.ingest(event)
      this.store.append(event)
      if (event.kind === 'tool' && event.itemId) {
        const row = this.store.db
          .prepare('SELECT id FROM events WHERE stream_key=? ORDER BY ordinal DESC LIMIT 1')
          .get(`${event.sessionId}:${event.turnId}:tool:${event.itemId}`) as
          { id: string } | undefined
        event.persistedId = row?.id
      }
      this.broadcast('hub:event', event)
      if (['done', 'error', 'status', 'session', 'user', 'requestResolved'].includes(event.kind))
        this.broadcast('hub:sessions')
      if (event.kind === 'done') {
        const session = this.store.session(event.sessionId)
        const workspace = this.store.workspace(session.workspaceId ?? session.projectId)
        const identity = this.identities.get(workspace.id)
        const scope = identity?.gitDir ?? identity?.rootPath ?? workspace.cwd
        this.finalizing.set(
          scope,
          identity ?? { rootPath: workspace.cwd, canonicalId: workspace.cwd, hasHead: false },
        )
        const completion = this.runtime
          .call<TurnReview | null>(
            'review.finish',
            workspace.cwd,
            this.dataDir,
            session.id,
            event.turnId,
          )
          .then((review) => {
            if (review) this.saveArtifact(`review:${session.id}:${event.turnId}`, review)
          })
          .catch((e) => {
            this.log('review', String(e))
            try {
              this.saveArtifact(`review:${session.id}:${event.turnId}`, {
                sessionId: session.id,
                workspaceId: workspace.id,
                turnId: event.turnId,
                startedAt: event.timestamp,
                finishedAt: Date.now(),
                files: [],
                warnings: ['本轮快照整理失败，请查看当前 Git 变更，不提供自动回滚。'],
              })
            } catch (error) {
              this.failStorage(error)
            }
            this.setHealth({
              code: 'REVIEW_FAILED',
              message: '本轮变更快照整理失败，请在代码工作区检查 Git 变更。',
            })
          })
          .finally(() => {
            this.finalizing.delete(scope)
            this.reviewCompletions.delete(completion)
            this.broadcast('hub:sessions')
          })
        this.reviewCompletions.add(completion)
        this.notify(event.status === 'error' ? '任务失败' : '任务已结束', session.title, session.id)
      } else if (event.kind === 'approval' || event.kind === 'question')
        this.notify('任务等待你的回复', this.store.session(event.sessionId).title, event.sessionId)
      return true
    } catch (error) {
      if (this.pendingEvents.length < 1000) this.pendingEvents.push(event)
      this.failStorage(error)
      return false
    }
  }
  private notify(title: string, _body: string, sessionId?: string): void {
    try {
      const window = this.window()
      if (
        this.store.settings().notifications === false ||
        window?.isFocused() ||
        !Notification.isSupported()
      )
        return
      const notification = new Notification({ title, body: '打开 Coding Hub 查看详情。' })
      notification.on('click', () => {
        window?.show()
        window?.focus()
        if (sessionId) this.broadcast('hub:focus-session', sessionId)
      })
      notification.show()
    } catch (error) {
      this.log('notification', String(error))
    }
  }
  private writable(allowClosing = false): void {
    this.assertOwnershipReadable()
    if (this.closing && !allowClosing) throw new Error('应用正在退出，请等待保存完成。')
    if (this.restoring) throw new Error('[DATA_RESTORE_BUSY] 正在恢复数据，请稍后重试。')
    if (this.healthState.storage !== 'ready')
      throw new Error('[STORAGE_WRITE_FAILED] 请先恢复本地存储后再执行任务。')
  }
  private async exportDestination(path: string): Promise<string> {
    if (this.closing) throw new Error('应用正在退出，请等待保存完成。')
    const root = await realpath(this.dataDir)
    const parent = await realpath(dirname(path))
    const destination = join(parent, basename(path))
    const target = await realpath(destination).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return destination
      throw error
    })
    const inside = (file: string) => {
      const scope = relative(root, file)
      return (
        scope === '' ||
        (!isAbsolute(scope) &&
          scope !== '..' &&
          !scope.startsWith('../') &&
          !scope.startsWith('..\\'))
      )
    }
    if (inside(destination) || inside(target))
      throw new Error('请选择应用数据目录以外的位置，避免覆盖数据库、备份或受管文件。')
    return destination
  }
  private workspace(value: unknown): Workspace {
    const workspace = this.store.workspace(id.parse(value))
    this.store.project(workspace.projectId)
    return workspace
  }
  private trusted(workspace: Workspace): void {
    this.assertOwnershipReadable()
    if (this.closing) throw new Error('应用正在退出，请等待保存完成。')
    if (this.restoring) throw new Error('正在恢复数据，请稍后重试。')
    if (workspace.deletedAt) throw new Error('工作区已清理，历史可查看导出，请新建会话。')
    const project = this.store.project(workspace.projectId)
    if (project.removedAt) throw new Error('请先恢复此项目。')
    if (!project.trusted)
      throw new Error(
        '[PROJECT_UNTRUSTED] 请先确认信任此项目，再编辑文件或运行 Agent、终端、检查及 Git 命令。',
      )
  }
  private async identity(workspace: Workspace): Promise<WorkspaceIdentity> {
    this.assertOwnershipReadable()
    if (this.cleanup) await this.cleanup
    const result = await this.runtime.call<WorkspaceIdentity>('workspace.inspect', workspace.cwd)
    this.identities.set(workspace.id, result)
    return result
  }
  private async scope(workspace: Workspace): Promise<string> {
    const identity = await this.identity(workspace)
    return identity.gitDir ?? identity.rootPath
  }
  private overlaps(left: WorkspaceIdentity, right: WorkspaceIdentity): boolean {
    if (left.gitDir && right.gitDir) return left.gitDir === right.gitDir
    const nested = (left: string, right: string) => {
      const path = relative(left, right)
      return (
        path === '' ||
        (!isAbsolute(path) && path !== '..' && !path.startsWith('..\\') && !path.startsWith('../'))
      )
    }
    return nested(left.rootPath, right.rootPath) || nested(right.rootPath, left.rootPath)
  }
  private async assertIdle(workspace: Workspace): Promise<void> {
    const identity = await this.identity(workspace)
    if ([...this.finalizing.values()].some((other) => this.overlaps(identity, other)))
      throw new Error('正在整理本轮变更，请稍后重试。')
    for (const session of this.store.sessions({ includeDeleted: true, includeRemoved: true })) {
      if (!active(session.status)) continue
      const other = this.store.workspace(session.workspaceId ?? session.projectId)
      const otherIdentity = await this.identity(other)
      const left = identity.gitDir ?? identity.rootPath
      const right = otherIdentity.gitDir ?? otherIdentity.rootPath
      if (left === right || this.overlaps(identity, otherIdentity))
        throw new Error('[WORKSPACE_BUSY] 此工作区已有任务运行或等待回复，请先停止它。')
    }
    for (const task of this.tasks.values())
      if (task.status === 'running') {
        const other = this.store.workspace(task.workspaceId)
        if (this.overlaps(identity, await this.identity(other)))
          throw new Error('[WORKSPACE_BUSY] 此工作区已有检查任务正在运行。')
      }
  }
  private async mutate<T>(workspace: Workspace, operation: () => Promise<T>): Promise<T> {
    const scope = await this.scope(workspace)
    this.writable()
    const identity = this.identities.get(workspace.id)!
    if (
      [...this.mutations.values(), ...this.reservations.values()].some((other) =>
        this.overlaps(identity, other),
      )
    )
      throw new Error('[WORKSPACE_BUSY] 工作区正在执行其他操作，请稍后重试。')
    this.mutations.set(scope, identity)
    try {
      return await operation()
    } finally {
      this.mutations.delete(scope)
    }
  }
  private async mutateMany<T>(workspaces: Workspace[], operation: () => Promise<T>): Promise<T> {
    const unique = new Map<string, Workspace>()
    for (const workspace of workspaces) unique.set(await this.scope(workspace), workspace)
    const values = [...unique.values()]
    const acquire = (index: number): Promise<T> =>
      index === values.length ? operation() : this.mutate(values[index], () => acquire(index + 1))
    return acquire(0)
  }
  async ready(): Promise<void> {
    this.assertOwnershipReadable()
    if (this.cleanup) await this.cleanup
    this.cleanup = undefined
    await this.runtime.start()
    this.setHealth({
      runtime: 'ready',
      ...(this.healthState.code === 'BACKUP_FAILED' ? {} : { message: undefined, code: undefined }),
    })
  }
  private async isolated(projectId: string, base?: string): Promise<Workspace> {
    const project = this.store.project(projectId)
    const shared = this.workspace(projectId)
    this.trusted(shared)
    const identity = await this.identity(shared)
    if (!identity.hasHead) throw new Error('此项目尚无 Git 提交，请使用当前目录或先创建首个提交。')
    const workspaceId = randomUUID()
    const destination = join(this.dataDir, 'worktrees', project.id, workspaceId)
    const branch = `coding-hub/${workspaceId.slice(0, 8)}`
    const created = await this.mutate(shared, () =>
      this.runtime.call<WorkspaceIdentity>(
        'workspace.createWorktree',
        shared.cwd,
        destination,
        branch,
        base,
      ),
    )
    const workspace: Workspace = {
      id: workspaceId,
      projectId,
      kind: 'worktree',
      cwd: created.rootPath,
      name: branch,
      branch,
      canonicalId: created.canonicalId,
      repositoryId: created.repositoryId,
      ownedByHub: true,
      createdAt: Date.now(),
    }
    this.store.addWorkspace(workspace)
    this.broadcast('hub:sessions')
    return workspace
  }
  readonly handlers: Record<string, (...args: any[]) => unknown> = {
    bootstrap: () => ({
      projects: this.store.projects(),
      removedProjects: this.store.projects({ includeRemoved: true }).filter((p) => p.removedAt),
      sessions: this.store.sessions({ includeDeleted: true }),
      workspaces: this.store.workspaces(),
      settings: this.store.settings(),
      health: { ...this.healthState },
      dataGeneration: this.dataGeneration,
      version: app.getVersion(),
      platform: process.platform,
    }),
    addProject: async () => {
      const result = await dialog.showOpenDialog(this.window()!, {
        title: '打开项目',
        properties: ['openDirectory', 'createDirectory'],
      })
      if (result.canceled || !result.filePaths[0]) return null
      const cwd = await realpath(result.filePaths[0])
      this.writable()
      const project = this.store.addProject(cwd, basename(cwd))
      this.store.saveSettings({ ...this.store.settings(), lastProjectId: project.id })
      this.broadcast('hub:sessions')
      return project
    },
    trustProject: async (value: unknown, trusted: unknown) => {
      this.writable()
      const projectId = id.parse(value)
      const trust = z.boolean().parse(trusted)
      return this.mutateMany(this.store.workspaces(projectId), async () => {
        if (!trust) {
          for (const workspace of this.store.workspaces(projectId)) await this.assertIdle(workspace)
          if (
            [...this.terminals.values()].some(
              (owner) => this.workspace(owner).projectId === projectId,
            )
          )
            throw new Error('请先终止项目中的终端，再撤销信任。')
        }
        const project = this.store.patchProject(projectId, { trusted: trust })
        this.broadcast('hub:sessions')
        return project
      })
    },
    restoreProject: (value: unknown) => {
      this.writable()
      const project = this.store.patchProject(id.parse(value), { removedAt: undefined })
      this.broadcast('hub:sessions')
      return project
    },
    relocateProject: async (value: unknown) => {
      this.writable()
      const project = this.store.project(id.parse(value))
      const result = await dialog.showOpenDialog(this.window()!, {
        title: '重新定位项目',
        properties: ['openDirectory'],
      })
      if (result.canceled) return null
      const cwd = await realpath(result.filePaths[0])
      return this.mutateMany(this.store.workspaces(project.id), async () => {
        for (const workspace of this.store.workspaces(project.id)) {
          await this.assertIdle(workspace)
          if (
            this.store
              .getEditorState(workspace.id)
              .files.some((file) => file.edited !== file.content)
          )
            throw new Error('请先保存未保存的文件，再重新定位项目。')
        }
        if (
          [...this.terminals.values()].some(
            (owner) => this.workspace(owner).projectId === project.id,
          )
        )
          throw new Error('请先终止项目中的终端，再重新定位。')
        if (
          this.store
            .sessions({ includeDeleted: true, includeRemoved: true })
            .some((s) => s.projectId === project.id && s.nativeId)
        )
          throw new Error(
            '此项目已有原生会话绑定原目录。请重新打开新目录创建项目，原会话和历史保留。',
          )
        const updated = this.store.patchProject(project.id, {
          path: cwd,
          name: basename(cwd),
          trusted: false,
        })
        this.broadcast('hub:sessions')
        return updated
      })
    },
    createProject: async (input: unknown) => {
      const parsed = z
        .object({
          name: z
            .string()
            .trim()
            .min(1)
            .max(100)
            .regex(/^[^\\/<>:"|?*]+$/)
            .refine(
              (name) => name !== '.' && name !== '..' && !name.endsWith('.'),
              '请使用有效的项目目录名称',
            ),
          cloneUrl: z.string().max(4096).optional(),
        })
        .parse(input)
      const result = await dialog.showOpenDialog(this.window()!, {
        title: '选择项目的父目录',
        properties: ['openDirectory'],
      })
      if (result.canceled) return null
      this.writable()
      this.projectOperations++
      try {
        const destination = join(result.filePaths[0], parsed.name)
        if (parsed.cloneUrl) {
          if (!/^(https:\/\/[^\s@?#]+|git@[^\s]+:[^\s]+)$/.test(parsed.cloneUrl))
            throw new Error('请使用不含凭据、查询参数的 HTTPS 或 SSH 仓库地址。')
          await this.runtime.call('project.clone', parsed.cloneUrl, destination)
        } else await mkdir(destination, { recursive: false })
        const cwd = await realpath(destination)
        this.writable()
        const project = this.store.addProject(cwd, parsed.name)
        this.broadcast('hub:sessions')
        return project
      } finally {
        this.projectOperations--
      }
    },
    removeProject: async (value: unknown) => {
      const projectId = id.parse(value)
      return this.mutateMany(this.store.workspaces(projectId), async () => {
        for (const workspace of this.store.workspaces(projectId)) await this.assertIdle(workspace)
        if (
          [...this.terminals.values()].some(
            (owner) => this.workspace(owner).projectId === projectId,
          )
        )
          throw new Error('请先终止项目中的终端，再移除项目。')
        this.store.removeProject(projectId)
        this.broadcast('hub:sessions')
      })
    },
    listWorkspaces: (value: unknown) => this.store.workspaces(id.parse(value)),
    inspectWorkspace: (value: unknown) => this.identity(this.workspace(value)),
    createWorkspace: (value: unknown, base?: unknown) =>
      this.isolated(id.parse(value), base === undefined ? undefined : pathText.parse(base)),
    removeWorkspace: async (value: unknown) => {
      const workspace = this.workspace(value)
      this.trusted(workspace)
      await this.assertIdle(workspace)
      if (workspace.kind !== 'worktree' || !workspace.ownedByHub)
        throw new Error('只能清理由 Coding Hub 创建的独立工作区。')
      if ([...this.terminals.values()].includes(workspace.id))
        throw new Error('请先终止此工作区的终端。')
      if (this.store.getEditorState(workspace.id).files.some((f) => f.edited !== f.content))
        throw new Error('此工作区存在未保存的文件，请先处理。')
      if (
        this.store
          .sessions({ includeDeleted: true })
          .some((s) => (s.workspaceId ?? s.projectId) === workspace.id && !s.deletedAt)
      )
        throw new Error('请先将此工作区的会话移入回收站，再清理目录。')
      await this.mutate(workspace, async () => {
        await this.assertIdle(workspace)
        if ([...this.terminals.values()].includes(workspace.id))
          throw new Error('请先终止工作区的终端。')
        await this.runtime.call(
          'workspace.removeWorktree',
          this.store.project(workspace.projectId).path,
          workspace.cwd,
        )
        this.store.removeWorkspace(workspace.id)
      })
      this.broadcast('hub:sessions')
    },
    compareWorkspace: (value: unknown) => {
      const workspace = this.workspace(value)
      return this.runtime.call(
        'workspace.compareWorktree',
        this.store.project(workspace.projectId).path,
        workspace.cwd,
      )
    },
    applyWorkspace: async (value: unknown) => {
      const source = this.workspace(value)
      const target = this.workspace(source.projectId)
      this.trusted(source)
      await this.assertIdle(source)
      await this.assertIdle(target)
      if (source.kind !== 'worktree') throw new Error('请选择独立工作区作为来源。')
      if (this.store.getEditorState(target.id).files.some((f) => f.edited !== f.content))
        throw new Error('请先保存接收工作区的编辑内容。')
      return this.mutateMany([target, source], async () => {
        await this.assertIdle(target)
        await this.assertIdle(source)
        return this.runtime.call('workspace.applyWorktree', target.cwd, source.cwd)
      })
    },
    createSession: async (input: unknown) => {
      const parsed = z
        .object({
          projectId: id,
          provider: z.enum(['claude', 'codex', 'opencode']),
          model: z.string().max(300).optional(),
          workspaceId: id.optional(),
          isolated: z.boolean().optional(),
          base: z.string().max(300).optional(),
        })
        .parse(input)
      this.writable()
      const workspace = parsed.isolated
        ? await this.isolated(parsed.projectId, parsed.base)
        : this.workspace(parsed.workspaceId ?? parsed.projectId)
      if (workspace.projectId !== parsed.projectId) throw new Error('工作区不属于此项目。')
      const session = this.store.createSession(
        parsed.projectId,
        parsed.provider,
        parsed.model,
        workspace.id,
      )
      this.store.saveSettings({
        ...this.store.settings(),
        lastProjectId: parsed.projectId,
        lastSessionId: session.id,
      })
      this.broadcast('hub:sessions')
      return session
    },
    getSession: (value: unknown, page?: unknown) =>
      this.store.view(
        id.parse(value),
        page === undefined
          ? { limit: 100 }
          : z
              .object({
                before: z.number().int().optional(),
                after: z.number().int().optional(),
                aroundEventId: id.optional(),
                limit: z.number().int().min(1).max(500).default(100),
              })
              .refine(
                (value) =>
                  [value.before, value.after, value.aroundEventId].filter(
                    (boundary) => boundary !== undefined,
                  ).length <= 1,
                '历史分页只能指定一个定位边界。',
              )
              .parse(page ?? {}),
      ),
    searchSessions: (query: unknown) =>
      this.store.searchSessions(z.string().max(300).parse(query), { limit: 100 }),
    updateSession: (value: unknown, patch: unknown) => {
      this.writable()
      const parsed = z
        .object({
          title: z.string().trim().min(1).max(200).optional(),
          archived: z.boolean().optional(),
          model: z.string().max(300).optional(),
          pinned: z.boolean().optional(),
          deletedAt: z.number().nullable().optional(),
          readAt: z.number().optional(),
        })
        .parse(patch)
      const session = this.store.session(id.parse(value))
      if (
        active(session.status) &&
        (parsed.archived || parsed.deletedAt || parsed.model !== undefined)
      )
        throw new Error('请先停止此会话的任务。')
      const { deletedAt, ...rest } = parsed
      const updated = this.store.patchSession(session.id, {
        ...rest,
        ...(Object.hasOwn(parsed, 'deletedAt')
          ? { deletedAt: deletedAt === null ? undefined : deletedAt }
          : {}),
      })
      this.broadcast('hub:sessions')
      return updated
    },
    getDraft: (value: unknown) => this.store.getDraft(id.parse(value)),
    saveDraft: (value: unknown, draft: unknown, generation?: unknown) => {
      this.assertGeneration(generation)
      const parsed = inputSchema.extend({ updatedAt: z.number() }).parse(draft)
      try {
        this.store.saveDraft(id.parse(value), parsed)
      } catch (error) {
        this.failStorage(error)
        throw error
      }
    },
    getEditorState: (value: unknown) => this.store.getEditorState(this.workspace(value).id),
    saveEditorState: (value: unknown, state: unknown, generation?: unknown) => {
      this.assertGeneration(generation)
      const parsed = z
        .object({
          files: z
            .array(
              z.object({
                path: pathText,
                content: z.string().max(2 * 1024 * 1024),
                fingerprint: z.string(),
                language: z.string(),
                edited: z.string().max(2 * 1024 * 1024),
                external: z
                  .object({
                    path: pathText,
                    content: z.string(),
                    fingerprint: z.string(),
                    language: z.string(),
                  })
                  .optional(),
                viewState: z.unknown().optional(),
              }),
            )
            .max(100),
          active: z.string(),
          mode: z.enum(['files', 'git']),
          updatedAt: z.number(),
        })
        .parse(state)
      try {
        this.store.saveEditorState(this.workspace(value).id, parsed)
      } catch (error) {
        this.failStorage(error)
        throw error
      }
    },
    addImages: async () => {
      const result = await dialog.showOpenDialog(this.window()!, {
        title: '添加图片',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      })
      const items: ContextItem[] = []
      for (const path of result.filePaths.slice(0, 10)) {
        if ((await stat(path)).size > 8 * 1024 * 1024) throw new Error('单张图片不能超过 8 MB。')
        const mimeType =
          extname(path).toLowerCase() === '.png'
            ? 'image/png'
            : extname(path).toLowerCase() === '.webp'
              ? 'image/webp'
              : 'image/jpeg'
        items.push({
          id: randomUUID(),
          kind: 'image',
          name: basename(path),
          mimeType,
          dataUrl: `data:${mimeType};base64,${(await readFile(path)).toString('base64')}`,
        })
      }
      return items
    },
    sendMessage: async (value: unknown, input: unknown) => {
      this.writable()
      if (this.cleanup) await this.cleanup
      const session = this.store.session(id.parse(value))
      if (session.deletedAt || session.archived) throw new Error('请先恢复会话后再发送。')
      const workspace = this.workspace(session.workspaceId ?? session.projectId)
      this.trusted(workspace)
      const parsed: TurnInput =
        typeof input === 'string'
          ? { text: z.string().min(1).max(100000).parse(input), context: [] }
          : inputSchema.parse(input)
      if (!parsed.text.trim()) throw new Error('请输入消息。')
      const text =
        parsed.text.trim() +
        parsed.context
          .filter((c) => c.kind !== 'image')
          .map(
            (c) =>
              `\n\n<context name=${JSON.stringify(c.name)} path=${JSON.stringify(c.path ?? '')} lines=${JSON.stringify([c.startLine, c.endLine])}>\n${c.content ?? ''}\n</context>`,
          )
          .join('')
      if (text.length > 100000) throw new Error('消息和引用合计超过 100,000 字符，请缩小引用。')
      const scope = await this.scope(workspace)
      this.writable()
      const identity = this.identities.get(workspace.id)!
      if (
        [...this.reservations.values(), ...this.mutations.values()].some((other) =>
          this.overlaps(identity, other),
        )
      )
        throw new Error('此工作区正在启动任务或执行 Git 操作。')
      this.reservations.set(scope, identity)
      const turnId = randomUUID()
      try {
        await this.assertIdle(workspace)
        await this.runtime.call(
          'review.capture',
          workspace.cwd,
          this.dataDir,
          session.id,
          workspace.id,
          turnId,
        )
        const event: AgentEvent = {
          id: randomUUID(),
          sessionId: session.id,
          turnId,
          kind: 'user',
          text: parsed.text.trim(),
          context: parsed.context,
          timestamp: Date.now(),
        }
        try {
          this.store.db.transaction(() => {
            this.store.append(event)
            this.store.patchSession(session.id, { status: 'starting' })
          })()
        } catch (error) {
          this.failStorage(error)
          throw error
        }
        this.broadcast('hub:event', event)
        this.broadcast('hub:sessions')
        await this.runtime.call(
          'agent.send',
          {
            session,
            cwd: workspace.cwd,
            cliPath: this.store.settings().cliPaths[session.provider],
            input: parsed,
          },
          text,
          turnId,
        )
      } catch (error) {
        const current = this.store.session(session.id)
        if (current.activeTurnId === turnId && active(current.status)) {
          this.receive({
            id: randomUUID(),
            sessionId: session.id,
            turnId,
            kind: 'error',
            text: redactDiagnostics(String(error)),
            timestamp: Date.now(),
          })
          this.store.patchSession(session.id, { status: 'stop_failed' })
          this.broadcast('hub:sessions')
          try {
            if (this.cleanup) await this.cleanup
            await this.runtime.call('agent.interrupt', session.id)
            const stopped = this.store.session(session.id)
            if (stopped.activeTurnId === turnId && active(stopped.status))
              this.receive({
                id: randomUUID(),
                sessionId: session.id,
                turnId,
                kind: 'done',
                status: 'error',
                timestamp: Date.now(),
              })
          } catch (stopError) {
            this.log('dispatch-stop', String(stopError))
          }
        }
        throw error
      } finally {
        this.reservations.delete(scope)
      }
    },
    interrupt: async (value: unknown) => {
      this.assertOwnershipReadable()
      if (this.cleanup) await this.cleanup
      const session = this.store.session(id.parse(value))
      if (!active(session.status)) return
      const turnId = session.activeTurnId
      this.store.patchSession(session.id, { status: 'stopping' })
      this.broadcast('hub:sessions')
      try {
        await this.runtime.call('agent.interrupt', session.id)
        const stopped = this.store.session(session.id)
        if (
          this.healthState.storage === 'ready' &&
          stopped.activeTurnId === turnId &&
          active(stopped.status)
        )
          this.receive({
            id: randomUUID(),
            sessionId: session.id,
            turnId: turnId ?? randomUUID(),
            kind: 'done',
            status: 'interrupted',
            timestamp: Date.now(),
          })
      } catch (error) {
        const current = this.store.session(session.id)
        if (
          current.activeTurnId === turnId &&
          ['stopping', 'stop_failed'].includes(current.status)
        ) {
          this.store.patchSession(session.id, { status: 'stop_failed' })
          this.broadcast('hub:sessions')
          throw error
        }
      }
    },
    respond: async (value: unknown, requestId: unknown, response: unknown) => {
      if (this.closing) throw new Error('应用正在退出，不能继续授权或回答。')
      const session = this.store.session(id.parse(value))
      const request = z.string().min(1).max(1000).parse(requestId)
      const answer = z
        .object({
          decision: z.string().max(100).optional(),
          answers: z.record(z.string(), z.array(z.string().max(10000))).optional(),
          permissions: z.record(z.string(), z.unknown()).optional(),
          scope: z.enum(['turn', 'session']).optional(),
        })
        .parse(response)
      const pending = this.store.db
        .prepare(
          "SELECT 1 FROM events WHERE session_id=? AND json_extract(data,'$.turnId')=? AND json_extract(data,'$.requestId')=? AND json_extract(data,'$.kind') IN ('approval','question') AND COALESCE(json_extract(data,'$.state'),'')<>'completed' LIMIT 1",
        )
        .get(session.id, session.activeTurnId ?? '', request)
      if (!pending) throw new Error('此请求已经结束或过期。')
      await this.runtime.call('agent.respond', session.id, request, answer)
    },
    providers: (value?: unknown) => {
      this.assertOwnershipReadable()
      if (this.closing) throw new Error('应用正在退出，请稍后再检测。')
      const workspace = value ? this.workspace(value) : undefined
      return this.runtime.call(
        'agent.probe',
        this.store.settings(),
        workspace && this.store.project(workspace.projectId).trusted ? workspace.cwd : tmpdir(),
      )
    },
    getSettings: () => this.store.settings(),
    saveSettings: (value: unknown) => {
      this.writable(true)
      return this.store.saveSettings(settingsSchema.parse(value) as Settings)
    },
    listFiles: (value: unknown, path = '') =>
      this.runtime.call(
        'workspace.listFiles',
        this.workspace(value).cwd,
        z.string().max(4096).parse(path),
      ),
    readFile: (value: unknown, path: unknown) =>
      this.runtime.call('workspace.readFile', this.workspace(value).cwd, pathText.parse(path)),
    saveFile: (
      value: unknown,
      path: unknown,
      content: unknown,
      fingerprint: unknown,
      overwrite = false,
    ) => {
      const workspace = this.workspace(value)
      this.trusted(workspace)
      return this.runtime.call(
        'workspace.saveFile',
        workspace.cwd,
        pathText.parse(path),
        z
          .string()
          .max(2 * 1024 * 1024)
          .parse(content),
        z.string().max(100).parse(fingerprint),
        z.boolean().parse(overwrite),
      )
    },
    searchFiles: (value: unknown, query: unknown, content = false) => {
      const workspace = this.workspace(value)
      this.trusted(workspace)
      return this.runtime.call(
        'workspace.searchFiles',
        workspace.cwd,
        z.string().max(300).parse(query),
        z.boolean().parse(content),
      )
    },
    createFile: (value: unknown, path: unknown, content = '') => {
      const workspace = this.workspace(value)
      this.trusted(workspace)
      return this.runtime.call(
        'workspace.createFile',
        workspace.cwd,
        pathText.parse(path),
        z
          .string()
          .max(2 * 1024 * 1024)
          .parse(content),
      )
    },
    renameFile: (value: unknown, path: unknown, to: unknown) => {
      const workspace = this.workspace(value)
      this.trusted(workspace)
      return this.runtime.call(
        'workspace.renameFile',
        workspace.cwd,
        pathText.parse(path),
        pathText.parse(to),
      )
    },
    deleteFile: (value: unknown, path: unknown, fingerprint: unknown) => {
      const workspace = this.workspace(value)
      this.trusted(workspace)
      return this.runtime.call(
        'workspace.deleteFile',
        workspace.cwd,
        pathText.parse(path),
        z.string().max(100).parse(fingerprint),
      )
    },
    openInEditor: async (value: unknown, path?: unknown) => {
      const workspace = this.workspace(value)
      this.trusted(workspace)
      const location = await this.runtime.call<string>(
        'workspace.resolveFile',
        workspace.cwd,
        path === undefined ? undefined : pathText.parse(path),
      )
      let command = await resolveCommand('code')
      let args = ['--reuse-window', location]
      if (!command) {
        command = await resolveCommand('zed')
        args = [location]
      }
      if (!command) {
        if (!path || /\.(png|jpe?g|gif|webp|ico|pdf|zip|exe|dmg)$/i.test(location)) {
          shell.showItemInFolder(location)
          return
        }
        command =
          process.platform === 'darwin'
            ? '/usr/bin/open'
            : join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'notepad.exe')
        args = process.platform === 'darwin' ? ['-a', 'TextEdit', location] : [location]
      }
      await new Promise<void>((resolve, reject) => {
        const child = crossSpawn(command!, args, {
          stdio: 'ignore',
          detached: true,
          shell: false,
          windowsHide: false,
        })
        child.once('error', reject)
        child.once('spawn', () => {
          child.unref()
          resolve()
        })
      })
    },
    gitStatus: (value: unknown) => {
      const workspace = this.workspace(value)
      this.trusted(workspace)
      return this.runtime.call('workspace.gitStatus', workspace.cwd)
    },
    gitDiff: (value: unknown, path: unknown, staged = false) => {
      const workspace = this.workspace(value)
      this.trusted(workspace)
      return this.runtime.call(
        'workspace.gitDiff',
        workspace.cwd,
        pathText.parse(path),
        z.boolean().parse(staged),
      )
    },
    gitHistory: (value: unknown) => {
      const workspace = this.workspace(value)
      this.trusted(workspace)
      return this.runtime.call('workspace.gitHistory', workspace.cwd)
    },
    gitAction: async (
      value: unknown,
      action: unknown,
      argument: unknown,
      expectedIndexFingerprint?: unknown,
    ) => {
      this.writable()
      const workspace = this.workspace(value)
      this.trusted(workspace)
      const operation = z
        .enum(['stage', 'unstage', 'commit', 'checkout', 'createBranch', 'fetch', 'pull', 'push'])
        .parse(action)
      if (!['stage', 'unstage', 'fetch'].includes(operation)) await this.assertIdle(workspace)
      await this.mutate(workspace, async () => {
        if (!['stage', 'unstage', 'fetch'].includes(operation)) await this.assertIdle(workspace)
        return this.runtime.call(
          'workspace.gitAction',
          workspace.cwd,
          operation,
          z.string().max(10000).parse(argument),
          expectedIndexFingerprint === undefined
            ? undefined
            : z.string().max(100).parse(expectedIndexFingerprint),
        )
      })
      this.identities.delete(workspace.id)
      this.broadcast('hub:sessions')
    },
    getReview: (sessionId: unknown, turnId: unknown) => {
      const session = this.store.session(id.parse(sessionId))
      return this.artifact<TurnReview>(`review:${session.id}:${id.parse(turnId)}`)
    },
    getEventOutput: async (sessionId: unknown, eventId: unknown, page?: unknown) => {
      const session = this.store.session(id.parse(sessionId))
      const row = this.store.db
        .prepare('SELECT data FROM events WHERE id=? AND session_id=?')
        .get(id.parse(eventId), session.id) as { data: string } | undefined
      if (!row) throw new Error('工具记录不存在。')
      const event = JSON.parse(row.data) as AgentEvent
      if (!event.outputRef) throw new Error('此记录没有独立输出。')
      const parsed = z
        .object({
          offset: z
            .number()
            .int()
            .min(0)
            .max(64 * 1024 * 1024)
            .optional(),
          limit: z
            .number()
            .int()
            .min(1024)
            .max(64 * 1024)
            .optional(),
        })
        .parse(page ?? {})
      return this.outputStore.read(event.outputRef, parsed.offset, parsed.limit)
    },
    revertReview: async (sessionId: unknown, turnId: unknown, paths: unknown) => {
      const session = this.store.session(id.parse(sessionId))
      const workspace = this.workspace(session.workspaceId ?? session.projectId)
      this.trusted(workspace)
      await this.assertIdle(workspace)
      const turn = id.parse(turnId)
      const review = this.artifact<TurnReview>(`review:${session.id}:${turn}`)
      if (!review) throw new Error('未找到此回合的完整审阅快照。')
      await this.mutate(workspace, async () => {
        await this.assertIdle(workspace)
        await this.runtime.call(
          'review.revert',
          workspace.cwd,
          this.dataDir,
          session.id,
          turn,
          z.array(pathText).min(1).max(500).parse(paths),
          review,
        )
        const updated = await this.runtime.call<TurnReview | null>(
          'review.get',
          this.dataDir,
          session.id,
          turn,
        )
        if (updated) this.saveArtifact(`review:${session.id}:${turn}`, updated)
      })
    },
    taskDefinitions: (value: unknown) => {
      const workspace = this.workspace(value)
      return this.runtime.call('task.definitions', workspace.cwd)
    },
    runTask: async (value: unknown, definition: unknown, sessionId?: unknown) => {
      this.writable()
      const workspace = this.workspace(value)
      this.trusted(workspace)
      const parsed = z
        .object({
          id: z.string().max(100),
          name: z.string().min(1).max(200),
          command: z.string().min(1).max(4096),
          args: z.array(z.string().max(4096)).max(100),
        })
        .parse(definition)
      return this.mutate(workspace, async () => {
        await this.assertIdle(workspace)
        const session = sessionId ? this.store.session(id.parse(sessionId)) : undefined
        if (session && (session.workspaceId ?? session.projectId) !== workspace.id)
          throw new Error('检查任务与会话工作区不一致。')
        const run = await this.runtime.call<TaskRun>(
          'task.run',
          workspace.cwd,
          this.dataDir,
          workspace.id,
          parsed,
          session?.id,
          session?.activeTurnId,
        )
        this.tasks.set(run.id, run)
        return run
      })
    },
    cancelTask: (value: unknown) => this.runtime.call('task.cancel', id.parse(value)),
    listTasks: (value?: unknown) =>
      this.storedTasks(value === undefined ? undefined : this.workspace(value).id),
    terminalCreate: async (value: unknown, cols: unknown, rows: unknown) => {
      const workspace = this.workspace(value)
      this.trusted(workspace)
      return this.mutate(workspace, async () => {
        const terminalId = await this.runtime.call<string>(
          'terminal.create',
          workspace.cwd,
          z.number().int().min(10).max(500).parse(cols),
          z.number().int().min(2).max(300).parse(rows),
          workspace.id,
        )
        this.terminals.set(terminalId, workspace.id)
        return terminalId
      })
    },
    terminalList: async (value?: unknown) => {
      const list = await this.runtime.call<TerminalDescriptor[]>(
        'terminal.list',
        value === undefined ? undefined : this.workspace(value).id,
      )
      for (const terminal of list)
        if (terminal.workspaceId) {
          if (terminal.exitCode === undefined) this.terminals.set(terminal.id, terminal.workspaceId)
          else this.terminals.delete(terminal.id)
        }
      return list
    },
    terminalAttach: (value: unknown) => this.runtime.call('terminal.attach', id.parse(value)),
    terminalWrite: (value: unknown, data: unknown) => {
      if (this.closing) throw new Error('应用正在退出，请等待保存完成。')
      return this.runtime.call(
        'terminal.write',
        id.parse(value),
        z.string().max(1000000).parse(data),
      )
    },
    terminalResize: (value: unknown, cols: unknown, rows: unknown) =>
      this.runtime.call(
        'terminal.resize',
        id.parse(value),
        z.number().int().min(1).max(500).parse(cols),
        z.number().int().min(1).max(300).parse(rows),
      ),
    terminalClose: async (value: unknown) => {
      const terminalId = id.parse(value)
      await this.runtime.call('terminal.close', terminalId)
      this.terminals.delete(terminalId)
    },
    terminalAck: (value: unknown, bytes: unknown) =>
      this.runtime.call(
        'terminal.ack',
        id.parse(value),
        z.number().int().min(0).max(1000000).parse(bytes),
      ),
    exportSession: async (value: unknown, format: unknown) => {
      const session = this.store.session(id.parse(value))
      const kind = z.enum(['markdown', 'json']).parse(format)
      const result = await dialog.showSaveDialog(this.window()!, {
        title: '导出会话',
        defaultPath: `${session.title.replace(/[\\/:*?"<>|]/g, '_')}.${kind === 'json' ? 'json' : 'md'}`,
      })
      if (result.canceled || !result.filePath) return false
      const destination = await this.exportDestination(result.filePath)
      const workspace = this.workspace(session.workspaceId ?? session.projectId)
      return this.mutate(workspace, async () => {
        await this.assertIdle(workspace)
        await exportSessionFile(
          this.store,
          this.outputStore,
          this.store.session(session.id),
          destination,
          kind,
        )
        return true
      })
    },
    listBackups: () => this.store.listBackups(),
    createBackup: () => this.store.createBackup(),
    restoreBackup: async (value: unknown) => {
      if (this.closing) throw new Error('应用正在退出，请等待保存完成。')
      if (
        this.restoring ||
        this.projectOperations ||
        this.reservations.size ||
        this.mutations.size ||
        this.finalizing.size
      )
        throw new Error('任务或工作区操作尚未完成，请稍后再恢复。')
      this.writable()
      this.restoring = true
      let replaced = false
      try {
        if (this.cleanup) await this.cleanup
        this.cleanup = undefined
        this.assertOwnershipReadable()
        if (this.healthState.storage !== 'ready') throw new Error('请先恢复本地存储后再恢复备份。')
        this.eventBatcher.flush()
        for (const workspace of this.store.workspaces()) await this.assertIdle(workspace)
        if ([...this.tasks.values()].some((task) => task.status === 'running'))
          throw new Error('[WORKSPACE_BUSY] 请先停止全部检查任务，再恢复备份。')
        if (this.terminals.size) throw new Error('恢复数据前请先终止全部终端。')
        // Idle CLI servers may retain ownership. No current Agent/task/PTY can own a running state from this backup.
        this.store.restoreBackup(z.string().max(200).parse(value))
        this.dataGeneration = randomUUID()
        replaced = true
        this.tasks.clear()
        this.recoveringTasks.clear()
        for (const task of this.taskRecords()) {
          if (task.status !== 'running') continue
          this.tasks.set(task.id, task)
          this.recoveringTasks.add(task.id)
        }
        this.reconcileRecoveredTasks('备份中的运行状态已中断，未自动重发。')
        if (this.store.restoreWarning)
          this.setHealth({
            code: 'RESTORE_PRESERVED_DAMAGED_OUTPUTS',
            message: this.store.restoreWarning,
          })
        this.broadcast('hub:sessions')
      } catch (error) {
        if (replaced) {
          this.failStorage(error)
          this.broadcast('hub:sessions')
          throw new Error(
            '[DATA_RESTORE_APPLIED] 备份已恢复，但部分本地状态尚未保存。窗口将重新加载，请在恢复界面重试本地存储。',
          )
        }
        throw error
      } finally {
        this.restoring = false
      }
    },
    storageInfo: () => this.store.storageInfo(),
    revealData: () => shell.openPath(this.dataDir),
    exportDiagnostics: async () => {
      const result = await dialog.showSaveDialog(this.window()!, {
        title: '导出诊断',
        defaultPath: 'coding-hub-diagnostics.json',
      })
      if (result.canceled || !result.filePath) return false
      const destination = await this.exportDestination(result.filePath)
      const logs = await Promise.all(
        ['diagnostics.log', 'diagnostics.previous.log'].map((name) =>
          readFile(join(this.dataDir, name), 'utf8').catch(() => ''),
        ),
      )
      await writeExportFile(
        destination,
        JSON.stringify(
          {
            version: app.getVersion(),
            platform: process.platform,
            arch: process.arch,
            health: this.healthState,
            storage: this.store.storageInfo(),
            logs: logs.map(redactDiagnostics),
          },
          null,
          2,
        ),
      )
      return true
    },
    health: () => ({ ...this.healthState }),
    updateState: () => this.updates.get(),
    checkUpdates: () => this.updates.check(),
    downloadUpdate: () => this.updates.download(),
    installUpdate: () => this.updates.install(),
    retryStorage: async () => {
      if (this.closing) throw new Error('应用正在退出，请等待保存完成。')
      if (this.ownershipReadError) {
        this.readOwnership()
        this.assertOwnershipReadable()
      }
      if (
        this.healthState.storage === 'ready' &&
        this.healthState.runtime === 'ready' &&
        !this.cleanup &&
        !this.recoveringTasks.size
      )
        return { ...this.healthState }
      // A real recovery will stop owned task processes too; reconcile every running task it can stop.
      for (const task of this.tasks.values())
        if (task.status === 'running') this.recoveringTasks.add(task.id)
      await this.cleanOwnedProcesses()
      this.cleanup = undefined
      try {
        if (!this.persistOwnership())
          throw new Error('无法保存受管进程恢复记录，请检查磁盘空间和目录权限。')
        this.store.db
          .prepare('INSERT OR REPLACE INTO settings(key,data) VALUES (?,?)')
          .run('health-check', JSON.stringify({ checkedAt: Date.now() }))
        this.reconcileRecoveredTasks()
        for (const task of this.tasks.values()) this.saveArtifact('task:' + task.id, task)
        const events = this.pendingEvents
        this.pendingEvents = []
        for (let index = 0; index < events.length; index++) {
          if (!this.receive(events[index], true)) {
            this.pendingEvents.push(
              ...events.slice(index + 1).slice(0, 1000 - this.pendingEvents.length),
            )
            throw new Error('积压事件尚未完成保存，请再次重试。')
          }
        }
        this.setHealth({ storage: 'ready', code: undefined, message: undefined })
        await this.ready()
        this.broadcast('hub:sessions')
      } catch (error) {
        this.failStorage(error)
        throw error
      }
      return { ...this.healthState }
    },
    openExternal: async (value: unknown) => {
      const url = new URL(z.string().max(10000).parse(value))
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
        throw new Error('仅支持不含凭据的 HTTP/HTTPS 链接。')
      await shell.openExternal(url.toString())
    },
    revealProject: (value: unknown) => shell.openPath(this.workspace(value).cwd),
    windowAction: (value: unknown) => {
      const action = z.enum(['minimize', 'maximize', 'close']).parse(value)
      const window = this.window()
      if (!window) return
      if (action === 'minimize') window.minimize()
      else if (action === 'close') window.close()
      else if (window.isMaximized()) window.unmaximize()
      else window.maximize()
    },
  }
  beginClose(): void {
    if (this.mutations.size || this.projectOperations || this.reservations.size)
      throw new Error('工作区操作尚未完成，请等待操作结束后再次退出。')
    this.closing = true
  }
  cancelClose(): void {
    this.closing = false
  }
  async close(): Promise<void> {
    this.assertOwnershipReadable()
    this.closing = true
    try {
      this.eventBatcher.flush()
      const stops = await Promise.allSettled([
        ...this.store
          .sessions({ includeDeleted: true, includeRemoved: true })
          .filter((session) => active(session.status))
          .map((session) => Promise.resolve().then(() => this.handlers.interrupt(session.id))),
        ...[...this.tasks.values()]
          .filter((task) => task.status === 'running')
          .map((task) => this.runtime.call('task.cancel', task.id)),
      ])
      const failed = stops.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      )
      if (failed.length)
        throw new AggregateError(
          failed.map((result) => result.reason),
          '后台任务尚未确认停止，已取消退出。',
        )
      this.eventBatcher.flush()
      await Promise.allSettled([...this.reviewCompletions])
      await this.runtime.close()
      this.eventBatcher.flush()
      await Promise.allSettled([...this.reviewCompletions])
      await this.cleanOwnedProcesses()
    } catch (error) {
      this.closing = false
      this.runtime.resumeAfterFailedClose()
      throw error
    }
  }
}
