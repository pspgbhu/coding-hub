import { useEffect, useState } from 'react'
import type {
  BackupInfo,
  Project,
  Session,
  StorageInfo,
  TaskDefinition,
  TaskRun,
  TurnReview,
  UpdateState,
  Workspace,
} from '../../shared/types'
import { api } from '../lib/api'

interface Feedback {
  onError: (error: unknown) => void
  notify: (message: string) => void
}
export function DataSettings({
  onError,
  notify,
  onRestored,
  onBeforeRestore,
  hasDirty,
}: Feedback & { onRestored: () => void; onBeforeRestore: () => Promise<void>; hasDirty: boolean }) {
  const [backups, setBackups] = useState<BackupInfo[]>([])
  const [storage, setStorage] = useState<StorageInfo>()
  const [update, setUpdate] = useState<UpdateState>()
  const [busy, setBusy] = useState(false)
  const refresh = async () => {
    const [items, info, state] = await Promise.all([
      api.listBackups(),
      api.storageInfo(),
      api.updateState(),
    ])
    setBackups(items)
    setStorage(info)
    setUpdate(state)
  }
  useEffect(() => {
    void refresh().catch(onError)
    return api.onUpdate(setUpdate)
  }, [])
  async function action(work: () => Promise<unknown>) {
    setBusy(true)
    try {
      await work()
      await refresh()
    } catch (error) {
      onError(error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="management-stack">
      <h3>数据与备份</h3>
      <p>数据只保存在本机。每天自动备份，保留最近 7 份；手动备份单独保留。</p>
      {storage && (
        <p>
          {storage.sessions} 个会话 · {storage.events} 条记录 · 数据{' '}
          {(storage.databaseBytes / 1048576).toFixed(1)} MB · 备份{' '}
          {(storage.backupBytes / 1048576).toFixed(1)} MB
        </p>
      )}
      <div className="management-actions">
        <button className="button secondary" onClick={() => void api.revealData().catch(onError)}>
          打开数据目录
        </button>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              await api.createBackup()
              notify('备份已创建')
            })
          }
        >
          立即备份
        </button>
        <button
          className="button secondary"
          onClick={() =>
            void api
              .exportDiagnostics()
              .then((saved) => saved && notify('已导出脱敏诊断'))
              .catch(onError)
          }
        >
          导出诊断
        </button>
      </div>
      <div className="backup-list">
        {backups.map((backup) => (
          <div className="management-row" key={backup.id}>
            <span>
              {new Date(backup.createdAt).toLocaleString()} ·{' '}
              {
                { manual: '手动', daily: '每日', migration: '升级前', 'before-restore': '恢复前' }[
                  backup.reason
                ]
              }{' '}
              · {(backup.bytes / 1024).toFixed(0)} KB
            </span>
            <button
              className="button secondary small"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    '恢复会替换当前会话、草稿与设置，并保留一份恢复前备份。请先停止任务；继续将终止全部终端。确定恢复吗？',
                  )
                )
                  void action(async () => {
                    await onBeforeRestore()
                    const terminals = await api.terminalList()
                    await Promise.all(terminals.map((terminal) => api.terminalClose(terminal.id)))
                    await api.restoreBackup(backup.id)
                    onRestored()
                    notify('备份已恢复')
                  })
              }}
            >
              恢复
            </button>
          </div>
        ))}
      </div>
      <h3>应用更新</h3>
      <p>
        {update?.message ||
          (
            {
              unconfigured: '当前版本尚未配置更新源。',
              idle: '可检查新版本。',
              checking: '正在检查…',
              available: '新版本可用',
              downloading: '正在下载…',
              downloaded: '下载完成，重启后安装',
              error: '更新失败，可重新检查',
            } as Record<string, string>
          )[update?.status ?? 'idle']}
        {update?.version ? ` · ${update.version}` : ''}
        {update?.progress !== undefined ? ` · ${update.progress.toFixed(0)}%` : ''}
      </p>
      {update?.releaseNotes && <pre className="release-notes">{update.releaseNotes}</pre>}
      <div className="management-actions">
        <button
          className="button secondary"
          disabled={busy || update?.status === 'checking'}
          onClick={() => void action(async () => setUpdate(await api.checkUpdates()))}
        >
          检查更新
        </button>
        {update?.status === 'available' && (
          <button
            className="button primary"
            onClick={() => void api.downloadUpdate().catch(onError)}
          >
            下载更新
          </button>
        )}
        {update?.status === 'downloaded' && (
          <button
            className="button primary"
            disabled={hasDirty}
            title={hasDirty ? '请先保存编辑器中的修改' : undefined}
            onClick={() => {
              if (window.confirm('确认已保存编辑内容并停止任务，重启并安装更新吗？'))
                void api.installUpdate().catch(onError)
            }}
          >
            重启安装
          </button>
        )}
      </div>
    </div>
  )
}

export function ProjectManager({
  projects,
  removedProjects,
  onChanged,
  onError,
  notify,
}: Feedback & {
  projects: Project[]
  removedProjects: Project[]
  onChanged: (project?: Project) => void
}) {
  const [name, setName] = useState('')
  const [cloneUrl, setCloneUrl] = useState('')
  const [busy, setBusy] = useState(false)
  async function action(work: () => Promise<Project | null | void>) {
    setBusy(true)
    try {
      const project = await work()
      onChanged(project || undefined)
    } catch (error) {
      onError(error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="management-stack">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void action(async () => {
            const project = await api.createProject({
              name: name.trim(),
              cloneUrl: cloneUrl.trim() || undefined,
            })
            if (project) {
              setName('')
              setCloneUrl('')
              notify('项目已创建')
            }
            return project
          })
        }}
      >
        <label className="field-label">
          新项目名称
          <input
            className="input"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="field-label">
          Git 克隆地址（留空创建目录）
          <input
            className="input"
            value={cloneUrl}
            onChange={(event) => setCloneUrl(event.target.value)}
            placeholder="https://… 或 git@…"
          />
        </label>
        <button className="button primary" disabled={busy || !name.trim()}>
          创建或克隆项目
        </button>
      </form>
      <h3>当前项目</h3>
      {projects.map((project) => (
        <div className="management-row" key={project.id}>
          <div>
            <strong>{project.name}</strong>
            <small>{project.path}</small>
            <small>{project.trusted ? '已信任' : '受限模式'}</small>
          </div>
          <div className="management-actions">
            <button
              className="button secondary small"
              disabled={busy}
              onClick={() => void action(() => api.relocateProject(project.id))}
            >
              重新定位
            </button>
            <button
              className="button secondary small"
              disabled={busy}
              onClick={() => void action(() => api.trustProject(project.id, !project.trusted))}
            >
              {project.trusted ? '撤销信任' : '信任'}
            </button>
            <button
              className="button secondary small"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`从列表移除「${project.name}」？本地文件与会话历史仍会保留。`))
                  void action(() => api.removeProject(project.id))
              }}
            >
              移除
            </button>
          </div>
        </div>
      ))}
      <h3>已移除项目</h3>
      {!removedProjects.length && <p>没有已移除项目。</p>}
      {removedProjects.map((project) => (
        <div className="management-row" key={project.id}>
          <span>{project.name}</span>
          <button
            className="button secondary small"
            disabled={busy}
            onClick={() => void action(() => api.restoreProject(project.id))}
          >
            恢复项目
          </button>
        </div>
      ))}
    </div>
  )
}

export function TaskInbox({
  sessions,
  onSelect,
  onError,
}: {
  sessions: Session[]
  onSelect: (session: Session) => void
  onError: (error: unknown) => void
}) {
  const [tasks, setTasks] = useState<TaskRun[]>([])
  useEffect(() => {
    void api.listTasks().then(setTasks).catch(onError)
    return api.onTask((task) =>
      setTasks((previous) => [task, ...previous.filter((item) => item.id !== task.id)]),
    )
  }, [])
  const relevant = sessions.filter(
    (session) =>
      !session.deletedAt &&
      !session.archived &&
      ([
        'starting',
        'running',
        'waiting',
        'stopping',
        'stop_failed',
        'error',
        'interrupted',
      ].includes(session.status) ||
        Boolean(session.activeTurnId && session.updatedAt > (session.readAt ?? 0))),
  )
  return (
    <div className="management-stack">
      <h3>Agent 任务</h3>
      {!relevant.length && <p>没有待处理的 Agent 任务。</p>}
      {relevant.map((session) => (
        <button className="inbox-row" key={session.id} onClick={() => onSelect(session)}>
          <strong>{session.title}</strong>
          <span>
            {session.status === 'waiting'
              ? '等待授权或回答'
              : session.status === 'error'
                ? '执行失败'
                : session.status === 'interrupted'
                  ? '已中断'
                  : session.status === 'stop_failed'
                    ? '停止失败，需要处理'
                    : session.status === 'idle'
                      ? '已完成，尚未查看'
                      : '正在执行'}
          </span>
        </button>
      ))}
      <h3>检查任务</h3>
      {!tasks.length && <p>尚未运行检查。</p>}
      {tasks.map((task) => (
        <details className="task-result" key={task.id}>
          <summary>
            {task.name} · {task.status}{' '}
            {task.exitCode !== undefined ? `· exit ${task.exitCode}` : ''}
          </summary>
          {task.status === 'running' && (
            <button
              className="button secondary small"
              onClick={() => void api.cancelTask(task.id).catch(onError)}
            >
              停止检查
            </button>
          )}
          <pre>{task.output || '暂无输出'}</pre>
          {task.sessionId && (
            <button
              className="button secondary small"
              onClick={() => {
                const session = sessions.find((item) => item.id === task.sessionId)
                if (session) onSelect(session)
              }}
            >
              跳转会话
            </button>
          )}
        </details>
      ))}
    </div>
  )
}

export function TurnInspector({
  session,
  turnId,
  workspace,
  onError,
  notify,
  onContext,
}: Feedback & {
  session: Session
  turnId: string
  workspace: Workspace
  onContext: (name: string, content: string) => void
}) {
  const [review, setReview] = useState<TurnReview | null>()
  const [definitions, setDefinitions] = useState<TaskDefinition[]>([])
  const [tasks, setTasks] = useState<TaskRun[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [customName, setCustomName] = useState('自定义检查')
  const [customCommand, setCustomCommand] = useState('')
  const [customArgs, setCustomArgs] = useState('[]')
  const [commandError, setCommandError] = useState('')
  const [customOpen, setCustomOpen] = useState(false)
  const checksRunning = tasks.some((task) => task.status === 'running')
  function editDefinition(definition: TaskDefinition) {
    setCustomOpen(true)
    setCustomName(definition.name)
    setCustomCommand(definition.command)
    setCustomArgs(JSON.stringify(definition.args, null, 2))
    setCommandError('')
  }
  async function runDefinition(definition: TaskDefinition) {
    setBusy(true)
    try {
      const task = await api.runTask(workspace.id, definition, session.id)
      setTasks((previous) => [task, ...previous.filter((item) => item.id !== task.id)])
    } catch (error) {
      onError(error)
    } finally {
      setBusy(false)
    }
  }
  async function runCustom() {
    try {
      const args: unknown = JSON.parse(customArgs)
      if (
        !Array.isArray(args) ||
        args.length > 100 ||
        !args.every((value) => typeof value === 'string' && value.length <= 4096)
      )
        throw new Error('参数必须是最多 100 项的 JSON 字符串数组，单项不超过 4,096 字符。')
      if (!customCommand.trim() || !customName.trim())
        throw new Error('请填写检查名称和可执行文件。')
      setCommandError('')
      await runDefinition({
        id: crypto.randomUUID(),
        name: customName.trim(),
        command: customCommand.trim(),
        args,
      })
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : '参数格式无效。')
    }
  }
  const refresh = async () => {
    const [value, checks, runs] = await Promise.all([
      api.getReview(session.id, turnId),
      api.taskDefinitions(workspace.id),
      api.listTasks(workspace.id),
    ])
    setReview(value)
    setDefinitions(checks)
    setTasks(runs.filter((run) => run.turnId === turnId || run.sessionId === session.id))
  }
  useEffect(() => {
    void refresh().catch(onError)
    return api.onTask((task) => {
      if (task.workspaceId === workspace.id)
        setTasks((previous) => [task, ...previous.filter((item) => item.id !== task.id)])
    })
  }, [session.id, turnId, workspace.id])
  return (
    <div className="management-stack">
      <h3>本轮变更</h3>
      <button className="button secondary small" onClick={() => void refresh().catch(onError)}>
        刷新本轮快照
      </button>
      {review === undefined ? (
        <p>正在读取变更快照…</p>
      ) : !review ? (
        <p>此轮快照尚不可用。刚完成的任务可稍后刷新；历史会话不会追溯生成快照。</p>
      ) : (
        <>
          {review.warnings.map((warning) => (
            <p className="inline-warning" key={warning}>
              {warning}
            </p>
          ))}
          {!review.files.length && <p>没有检测到文件变更。</p>}
          {review.files.map((file) => (
            <details className="review-file" key={file.path}>
              <summary>
                <input
                  type="checkbox"
                  aria-label={`选择 ${file.path}`}
                  disabled={!file.reviewable}
                  checked={selected.includes(file.path)}
                  onChange={(event) =>
                    setSelected((previous) =>
                      event.target.checked
                        ? [...previous, file.path]
                        : previous.filter((path) => path !== file.path),
                    )
                  }
                />
                {file.path}
                {!file.reviewable ? ' · 不支持回滚' : ''}
              </summary>
              <div className="review-comparison">
                <div>
                  <strong>修改前</strong>
                  <pre>{file.before ?? '（不存在）'}</pre>
                </div>
                <div>
                  <strong>修改后</strong>
                  <pre>{file.after ?? '（已删除）'}</pre>
                </div>
              </div>
              <button
                className="button secondary small"
                onClick={() =>
                  onContext(
                    file.path,
                    `修改前：\n${file.before ?? '(不存在)'}\n修改后：\n${file.after ?? '(已删除)'}`,
                  )
                }
              >
                引用变更
              </button>
            </details>
          ))}
          <button
            className="button secondary"
            disabled={busy || !selected.length}
            onClick={() => {
              if (
                !window.confirm('仅回滚选中的本轮修改；如文件已再次变化，操作会拒绝。确定继续吗？')
              )
                return
              setBusy(true)
              void api
                .revertReview(session.id, turnId, selected)
                .then(async () => {
                  setSelected([])
                  await refresh()
                  notify('已回滚选中修改')
                })
                .catch(onError)
                .finally(() => setBusy(false))
            }}
          >
            回滚选中修改
          </button>
        </>
      )}
      <h3>运行项目检查</h3>
      <p>检查在当前工作区执行；运行记录包含命令、参数、输出和退出码。请确认你信任项目。</p>
      <div className="management-actions">
        {definitions.map((definition) => (
          <div key={definition.id}>
            <button
              className="button secondary"
              disabled={busy || checksRunning}
              title={`${definition.command} ${JSON.stringify(definition.args)}`}
              onClick={() => void runDefinition(definition)}
            >
              {definition.name}
            </button>
            <button
              className="button secondary small"
              aria-label={`编辑检查 ${definition.name}`}
              onClick={() => editDefinition(definition)}
            >
              编辑命令
            </button>
          </div>
        ))}
      </div>
      {!definitions.length && <p>未发现 test、lint、typecheck 或 build 检查脚本。</p>}
      <details
        className="custom-check"
        open={customOpen}
        onToggle={(event) => setCustomOpen(event.currentTarget.open)}
      >
        <summary>新增或编辑自定义检查</summary>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void runCustom()
          }}
        >
          <label className="field-label">
            检查名称
            <input
              className="input"
              required
              maxLength={200}
              value={customName}
              onChange={(event) => setCustomName(event.target.value)}
            />
          </label>
          <label className="field-label">
            可执行文件
            <input
              className="input mono"
              required
              maxLength={4096}
              value={customCommand}
              placeholder="pnpm 或完整可执行文件路径"
              onChange={(event) => setCustomCommand(event.target.value)}
            />
          </label>
          <label className="field-label">
            参数（JSON 字符串数组）
            <textarea
              className="input mono"
              aria-label="检查参数 JSON 数组"
              rows={4}
              value={customArgs}
              onChange={(event) => setCustomArgs(event.target.value)}
            />
          </label>
          <p>
            例如 <code>["run", "test", "--", "--runInBand"]</code>
            。每项作为独立参数传入；历史记录可重新编辑运行。
          </p>
          {commandError && (
            <p className="inline-warning" role="alert">
              {commandError}
            </p>
          )}
          <button
            className="button primary"
            disabled={busy || checksRunning || !customCommand.trim() || !customName.trim()}
          >
            运行自定义检查
          </button>
        </form>
      </details>
      {tasks.map((task) => (
        <details className="task-result" key={task.id}>
          <summary>
            {task.name} · {task.status} {task.exitCode !== undefined ? `· ${task.exitCode}` : ''}
          </summary>
          {task.status === 'running' && (
            <button
              className="button secondary small"
              onClick={() => void api.cancelTask(task.id).catch(onError)}
            >
              停止检查
            </button>
          )}
          <pre>{task.output || '暂无输出'}</pre>
          <p>
            <code>{task.command}</code> <code>{JSON.stringify(task.args)}</code>
          </p>
          <button
            className="button secondary small"
            onClick={() =>
              editDefinition({
                id: task.id,
                name: task.name,
                command: task.command,
                args: task.args,
              })
            }
          >
            编辑并重新运行
          </button>
          <button
            className="button secondary small"
            onClick={() => onContext(task.name, task.output)}
          >
            引用检查结果
          </button>
        </details>
      ))}
    </div>
  )
}

export function WorkspaceActions({
  workspace,
  onChanged,
  onError,
  notify,
}: Feedback & { workspace: Workspace; onChanged: () => void }) {
  const [preview, setPreview] = useState<string>('')
  const [busy, setBusy] = useState(false)
  return (
    <div className="management-stack">
      <p>
        {workspace.name} · {workspace.kind === 'worktree' ? '独立工作区' : '共享工作区'}
        <br />
        {workspace.cwd}
      </p>
      {workspace.kind === 'worktree' && (
        <>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() =>
              void api
                .compareWorkspace(workspace.id)
                .then((comparison) =>
                  setPreview(
                    `${comparison.files.map((file) => `${file.status} ${file.path}`).join('\n') || '没有变更'}${comparison.conflicts.length ? '\n冲突：\n' + comparison.conflicts.map((item) => `${item.path}: ${item.reason}`).join('\n') : ''}`,
                  ),
                )
                .catch(onError)
            }
          >
            比较与共享工作区的差异
          </button>
          {preview && <pre>{preview}</pre>}
          <button
            className="button primary"
            disabled={busy || !preview}
            onClick={() => {
              if (
                !window.confirm(
                  '将独立工作区修改应用到共享工作区？如存在冲突，操作将保留现场并报告冲突。',
                )
              )
                return
              setBusy(true)
              void api
                .applyWorkspace(workspace.id)
                .then((result) => {
                  if (result.conflicts.length)
                    setPreview(
                      result.conflicts.map((item) => `${item.path}: ${item.reason}`).join('\n'),
                    )
                  else notify(`已应用 ${result.applied.length} 个文件`)
                  onChanged()
                })
                .catch(onError)
                .finally(() => setBusy(false))
            }}
          >
            应用回共享工作区
          </button>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => {
              if (
                !window.confirm(
                  '清理此应用创建的独立工作区？运行中的任务、未提交修改与可用性会先检查，会话历史仍会保留。',
                )
              )
                return
              setBusy(true)
              void api
                .removeWorkspace(workspace.id)
                .then(onChanged)
                .catch(onError)
                .finally(() => setBusy(false))
            }}
          >
            清理独立工作区
          </button>
        </>
      )}
    </div>
  )
}
