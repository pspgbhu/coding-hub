import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import {
  Archive,
  ArrowRight,
  Check,
  Code2,
  Command,
  ExternalLink,
  Folder,
  FolderOpen,
  LoaderCircle,
  MessageSquare,
  Monitor,
  Moon,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Plus,
  Search,
  Settings as SettingsIcon,
  Sun,
  TerminalSquare,
  X,
  Minus,
  Square,
  Pencil,
  AlertCircle,
  RefreshCw,
} from 'lucide-react'
import type {
  AgentEvent,
  Project,
  ProviderId,
  ProviderInfo,
  Session,
  Settings,
} from '../shared/types'
import { PROVIDERS } from '../shared/types'
import { api, appendEvent, errorText, shortPath } from './lib/api'
import Chat from './components/Chat'
import TerminalPanel from './components/TerminalPanel'
const Workspace = lazy(() => import('./components/Workspace'))
const providerIds: ProviderId[] = ['claude', 'codex', 'opencode']
function Brand({ small = false }: { small?: boolean }) {
  return (
    <div className={`brand ${small ? 'small' : ''}`}>
      <div className="brand-mark">
        <Code2 size={small ? 15 : 18} strokeWidth={2.3} />
      </div>
      <span>Coding Hub</span>
    </div>
  )
}
function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  className = '',
}: {
  open: boolean
  onOpenChange: (value: boolean) => void
  title: string
  description?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className={`dialog-content ${className}`}>
          <div className="dialog-header">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description>{description || 'Coding Hub 工作区设置'}</Dialog.Description>
            </div>
            <Dialog.Close className="icon-button" aria-label="关闭">
              <X size={18} />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
function EmptyState({
  project,
  providers,
  checking,
  addProject,
  createSession,
  openSettings,
}: {
  project?: Project
  providers: ProviderInfo[]
  checking: boolean
  addProject: () => void
  createSession: () => void
  openSettings: () => void
}) {
  return (
    <div className="home">
      <div className="home-content">
        <h1>{project ? '项目会话' : '打开项目'}</h1>
        <p className="home-description">
          {project ? '在当前项目中创建会话。' : '选择本地目录，然后创建会话。'}
        </p>
        <button
          className="button primary home-action"
          onClick={project ? createSession : addProject}
        >
          {project ? <Plus size={17} /> : <FolderOpen size={17} />}
          {project ? '新建会话' : '打开项目'}
          <ArrowRight size={16} />
        </button>
        {project && (
          <div className="home-project">
            <Folder size={13} />
            <strong>{project.name}</strong>
            <span>{shortPath(project.path)}</span>
          </div>
        )}
        <div className="home-agents">
          {providerIds.map((id) => {
            const info = providers.find((p) => p.id === id)
            return (
              <button className="agent-readiness" key={id} onClick={openSettings}>
                <span className="provider-monogram" style={{ color: PROVIDERS[id].color }}>
                  {id === 'claude' ? '✳' : id === 'codex' ? '◇' : '⌘'}
                </span>
                <div>
                  <strong>{PROVIDERS[id].name}</strong>
                  <small>
                    {checking
                      ? '正在检测'
                      : info?.available
                        ? info.version || '已就绪'
                        : '需要配置'}
                  </small>
                </div>
                {checking ? (
                  <LoaderCircle size={11} className="spin" />
                ) : (
                  <span className={`status-dot ${info?.available ? '' : 'off'}`} />
                )}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
export default function App() {
  const [booting, setBooting] = useState(true)
  const [bootError, setBootError] = useState('')
  const [projects, setProjects] = useState<Project[]>([])
  const [sessions, setSessions] = useState<Session[]>([])
  const [settings, setSettings] = useState<Settings>({ theme: 'system', cliPaths: {} })
  const [platform, setPlatform] = useState('darwin')
  const [version, setVersion] = useState('0.1.0')
  const [projectId, setProjectId] = useState<string>()
  const [sessionId, setSessionId] = useState<string>()
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [loadingSession, setLoadingSession] = useState(false)
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [checking, setChecking] = useState(false)
  const [sidebar, setSidebar] = useState(true)
  const [workspace, setWorkspace] = useState(false)
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false)
  const [dirtyFiles, setDirtyFiles] = useState(false)
  const [terminal, setTerminal] = useState(false)
  const [terminalProjects, setTerminalProjects] = useState<string[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState('agents')
  const [newOpen, setNewOpen] = useState(false)
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>('codex')
  const [model, setModel] = useState('')
  const modelEdited = useRef(false)
  const modelInitialized = useRef(false)
  const [newPending, setNewPending] = useState(false)
  const [addingProject, setAddingProject] = useState(false)
  const [search, setSearch] = useState('')
  const [searchIds, setSearchIds] = useState<Set<string>>(new Set())
  const [searchPending, setSearchPending] = useState(false)
  const [archived, setArchived] = useState(false)
  const [menuId, setMenuId] = useState<string>()
  const [rename, setRename] = useState<{ id: string; title: string }>()
  const [toast, setToast] = useState<{ message: string; error: boolean }>()
  const [context, setContext] = useState<{ path: string; content: string }>()
  const [systemDark, setSystemDark] = useState(
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  )
  const [cliDrafts, setCliDrafts] = useState<Settings['cliPaths']>({})
  const [savingSettings, setSavingSettings] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const providerProbe = useRef(0)
  const pendingContext = useRef<{ path: string; content: string } | undefined>(undefined)
  const activeRef = useRef(sessionId)
  const eventIds = useRef(new Set<string>())
  const incoming = useRef<{ id: string; buffer: AgentEvent[] } | null>(null)
  const project = projects.find((item) => item.id === projectId)
  const session = sessions.find((item) => item.id === sessionId)
  const theme = settings.theme === 'system' ? (systemDark ? 'dark' : 'light') : settings.theme
  activeRef.current = sessionId
  const reportError = useCallback(
    (error: unknown) => setToast({ message: errorText(error), error: true }),
    [],
  )
  const notify = (message: string) => setToast({ message, error: false })
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(undefined), toast.error ? 8000 : 3500)
    return () => clearTimeout(timer)
  }, [toast])
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  useEffect(() => {
    if (workspace) setWorkspaceLoaded(true)
  }, [workspace])
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const change = () => setSystemDark(media.matches)
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  const saveSettings = async (patch: Partial<Settings>) => {
    const updated = await api.saveSettings({ ...settings, ...patch })
    setSettings(updated)
    return updated
  }
  const loadProviders = useCallback(
    async (id?: string) => {
      if (!api) return
      const probe = ++providerProbe.current
      setChecking(true)
      try {
        const detected = await api.providers(id)
        if (probe === providerProbe.current) setProviders(detected)
      } catch (error) {
        if (probe === providerProbe.current) reportError(error)
      } finally {
        if (probe === providerProbe.current) setChecking(false)
      }
    },
    [reportError],
  )
  const load = useCallback(async () => {
    if (!api) {
      setBooting(false)
      setBootError('请在桌面应用中打开 Coding Hub')
      return
    }
    setBooting(true)
    setBootError('')
    try {
      const data = await api.bootstrap()
      setProjects(data.projects)
      setSessions(data.sessions)
      setSettings(data.settings)
      setCliDrafts(data.settings.cliPaths)
      setPlatform(data.platform)
      setVersion(data.version)
      const storedSession = data.sessions.find(
        (item) => item.id === data.settings.lastSessionId && !item.archived,
      )
      const firstProject =
        data.projects.find(
          (item) => item.id === (storedSession?.projectId || data.settings.lastProjectId),
        ) || data.projects[0]
      setProjectId(firstProject?.id)
      setSessionId(storedSession?.id)
      void loadProviders(firstProject?.id)
    } catch (error) {
      setBootError(errorText(error))
    } finally {
      setBooting(false)
    }
  }, [loadProviders])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    if (!api) return
    const unEvent = api.onEvent((event) => {
      setSessions((previous) =>
        previous.map((item) => {
          if (item.id !== event.sessionId) return item
          if (event.kind === 'user')
            return { ...item, activeTurnId: event.turnId, status: 'running' }
          if (item.activeTurnId && item.activeTurnId !== event.turnId) return item
          const status =
            event.status ??
            (event.kind === 'done' ? 'idle' : event.kind === 'error' ? 'error' : undefined)
          return status ? { ...item, status } : item
        }),
      )
      if (event.sessionId === activeRef.current && !eventIds.current.has(event.id)) {
        if (incoming.current?.id === event.sessionId) incoming.current.buffer.push(event)
        else {
          eventIds.current.add(event.id)
          setEvents((previous) => appendEvent(previous, event))
        }
      }
    })
    let refreshing = false
    const unSessions = api.onSessionsChanged(() => {
      if (refreshing) return
      refreshing = true
      void api
        .bootstrap()
        .then((data) => {
          setSessions(data.sessions)
          setProjects(data.projects)
        })
        .catch(reportError)
        .finally(() => {
          refreshing = false
        })
    })
    return () => {
      unEvent()
      unSessions()
    }
  }, [reportError])
  useEffect(() => {
    setContext(pendingContext.current)
    pendingContext.current = undefined
    eventIds.current.clear()
    setEvents([])
    incoming.current = null
    if (!sessionId || !api) {
      setLoadingSession(false)
      return
    }
    let stale = false
    const pending = { id: sessionId, buffer: [] as AgentEvent[] }
    incoming.current = pending
    setLoadingSession(true)
    void api
      .getSession(sessionId)
      .then((view) => {
        if (stale) return
        setSessions((previous) =>
          previous.map((item) => (item.id === view.session.id ? view.session : item)),
        )
        const raw = [
          ...view.events,
          ...pending.buffer.filter(
            (event) => event.sequence !== undefined && event.sequence > view.cursor,
          ),
        ]
        eventIds.current = new Set(raw.map((event) => event.id))
        incoming.current = null
        setEvents(raw.reduce(appendEvent, [] as AgentEvent[]))
      })
      .catch((error) => {
        if (stale) return
        incoming.current = null
        eventIds.current = new Set(pending.buffer.map((event) => event.id))
        setEvents(pending.buffer.reduce(appendEvent, [] as AgentEvent[]))
        reportError(error)
      })
      .finally(() => {
        if (!stale) setLoadingSession(false)
      })
    return () => {
      stale = true
      if (incoming.current === pending) incoming.current = null
    }
  }, [sessionId, reportError])
  function toggleTerminal() {
    if (!projectId) return
    if (!terminal)
      setTerminalProjects((previous) =>
        previous.includes(projectId) ? previous : [...previous, projectId],
      )
    setTerminal((value) => !value)
  }
  async function chooseProject(id: string) {
    if (
      id !== projectId &&
      dirtyFiles &&
      !window.confirm('当前工作区有未保存的文件。切换项目将放弃这些修改，确定继续吗？')
    )
      return
    setProjectId(id)
    setSessionId(undefined)
    setMenuId(undefined)
    setTerminal(false)
    void saveSettings({ lastProjectId: id, lastSessionId: undefined }).catch(reportError)
    void loadProviders(id)
  }
  function chooseSession(item: Session) {
    if (
      item.projectId !== projectId &&
      dirtyFiles &&
      !window.confirm('当前工作区有未保存的文件。切换项目将放弃这些修改，确定继续吗？')
    )
      return
    if (item.projectId !== projectId) {
      setTerminal(false)
      void loadProviders(item.projectId)
    }
    setProjectId(item.projectId)
    setSessionId(item.id)
    setMenuId(undefined)
    void saveSettings({ lastProjectId: item.projectId, lastSessionId: item.id }).catch(reportError)
  }
  async function addProject() {
    if (addingProject) return
    setAddingProject(true)
    try {
      const result = await api.addProject()
      if (result) {
        setProjects((previous) =>
          previous.some((item) => item.id === result.id) ? previous : [...previous, result],
        )
        await chooseProject(result.id)
      }
    } catch (error) {
      reportError(error)
    } finally {
      setAddingProject(false)
    }
  }
  function openNew() {
    if (!project) {
      void addProject()
      return
    }
    const available =
      providers.find((info) => info.available && info.id === selectedProvider) ||
      providers.find((info) => info.available)
    const id = available?.id || selectedProvider
    const firstModel = providers.find((info) => info.id === id)?.models[0]?.id
    modelEdited.current = false
    modelInitialized.current = !!firstModel
    setModel(firstModel || '')
    setSelectedProvider(id)
    setNewOpen(true)
  }
  async function createSession() {
    if (!project) return
    setNewPending(true)
    try {
      const created = await api.createSession({
        projectId: project.id,
        provider: selectedProvider,
        model: model.trim() || undefined,
      })
      setSessions((previous) => [created, ...previous.filter((item) => item.id !== created.id)])
      chooseSession(created)
      setNewOpen(false)
      setArchived(false)
      setSearch('')
    } catch (error) {
      reportError(error)
    } finally {
      setNewPending(false)
    }
  }
  async function updateSession(id: string, patch: { title?: string; archived?: boolean }) {
    try {
      const result = await api.updateSession(id, patch)
      setSessions((previous) => previous.map((item) => (item.id === id ? result : item)))
      if (patch.archived && sessionId === id) {
        setSessionId(undefined)
        void saveSettings({ lastSessionId: undefined }).catch(reportError)
      }
      setMenuId(undefined)
      setRename(undefined)
    } catch (error) {
      reportError(error)
    }
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      const letter = event.key.toLowerCase()
      if (letter === 'n') {
        event.preventDefault()
        openNew()
      } else if (letter === 'k') {
        event.preventDefault()
        setSidebar(true)
        setTimeout(() => searchRef.current?.focus(), 0)
      } else if (letter === ',') {
        event.preventDefault()
        setSettingsOpen(true)
      } else if (letter === 'b') {
        event.preventDefault()
        setSidebar((value) => !value)
      } else if (letter === 'j') {
        event.preventDefault()
        if (project) toggleTerminal()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })
  useEffect(() => {
    const query = search.trim()
    if (!query) {
      setSearchPending(false)
      setSearchIds(new Set())
      return
    }
    let stale = false
    setSearchPending(true)
    const timer = setTimeout(() => {
      void api
        .searchSessions(query)
        .then((results) => {
          if (!stale) setSearchIds(new Set(results.map((item) => item.id)))
        })
        .catch((error) => {
          if (!stale) {
            setSearchIds(new Set())
            reportError(error)
          }
        })
        .finally(() => {
          if (!stale) setSearchPending(false)
        })
    }, 200)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [search, reportError])
  const filteredSessions = sessions
    .filter(
      (item) =>
        item.archived === archived &&
        (search.trim() ? searchIds.has(item.id) : item.projectId === projectId),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
  useEffect(() => {
    if (!newOpen || modelEdited.current || modelInitialized.current) return
    const firstModel = providers.find((info) => info.id === selectedProvider)?.models[0]?.id
    if (firstModel) {
      setModel(firstModel)
      modelInitialized.current = true
    }
  }, [newOpen, selectedProvider, providers])
  const currentProvider = providers.find((item) => item.id === selectedProvider)
  if (booting || bootError)
    return (
      <div className="startup">
        <Brand />
        <div>
          {booting ? (
            <>
              <LoaderCircle size={24} className="spin" />
              <p>正在启动…</p>
            </>
          ) : (
            <>
              <AlertCircle size={28} />
              <h2>{!api ? '桌面模式' : '工作台启动失败'}</h2>
              <p>{bootError}</p>
              {api && (
                <button className="button primary" onClick={() => void load()}>
                  重新连接
                </button>
              )}
            </>
          )}
        </div>
      </div>
    )
  return (
    <div
      className={`app ${platform === 'darwin' ? 'mac' : 'windows'} ${!sidebar ? 'sidebar-collapsed' : ''}`}
    >
      <header className="titlebar">
        <div className="titlebar-leading">
          {platform === 'darwin' && <div className="traffic-spacer" />}
          <button
            className="icon-button"
            title="切换侧栏 · ⌘/Ctrl + B"
            aria-label="切换侧栏"
            onClick={() => setSidebar((value) => !value)}
          >
            <PanelLeft size={16} />
          </button>
          {!sidebar && <Brand small />}
        </div>
        <div className="titlebar-center">
          <span>Coding Hub</span>
          <span className="titlebar-separator">/</span>
          <span>{project?.name || '工作台'}</span>
        </div>
        <div className="titlebar-actions">
          {project && (
            <>
              <button
                className={`icon-button ${terminal ? 'active' : ''}`}
                title="终端 · ⌘/Ctrl + J"
                aria-label="切换终端"
                onClick={toggleTerminal}
              >
                <TerminalSquare size={16} />
              </button>
              <button
                className={`icon-button ${workspace ? 'active' : ''}`}
                title="代码工作区"
                aria-label="切换代码工作区"
                onClick={() => setWorkspace((value) => !value)}
              >
                <PanelRight size={16} />
              </button>
            </>
          )}
          {platform !== 'darwin' && (
            <div className="window-controls">
              <button onClick={() => void api.windowAction('minimize')} aria-label="最小化">
                <Minus size={13} />
              </button>
              <button onClick={() => void api.windowAction('maximize')} aria-label="最大化">
                <Square size={11} />
              </button>
              <button
                className="window-close"
                onClick={() => void api.windowAction('close')}
                aria-label="关闭"
              >
                <X size={14} />
              </button>
            </div>
          )}
        </div>
      </header>
      <div className="app-body">
        {sidebar && (
          <aside className="sidebar">
            <div className="sidebar-top">
              <Brand />
              <button className="new-session-button" onClick={openNew}>
                <Plus size={16} />
                <span>新建会话</span>
                <kbd>{platform === 'darwin' ? '⌘' : 'Ctrl'} N</kbd>
              </button>
              <div className="sidebar-search">
                <Search size={14} />
                <input
                  ref={searchRef}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="搜索标题与对话内容"
                />
                {search ? (
                  <button className="icon-button" onClick={() => setSearch('')} title="清空搜索">
                    <X size={12} />
                  </button>
                ) : (
                  <kbd>{platform === 'darwin' ? '⌘' : 'Ctrl'} K</kbd>
                )}
              </div>
            </div>
            <div className="sidebar-scroll">
              <div className="sidebar-section-header">
                <span>项目</span>
                <button
                  className="icon-button"
                  title="打开项目"
                  onClick={() => void addProject()}
                  disabled={addingProject}
                >
                  {addingProject ? <LoaderCircle size={13} className="spin" /> : <Plus size={14} />}
                </button>
              </div>
              <div className="project-list">
                {projects.length === 0 ? (
                  <button className="project-placeholder" onClick={() => void addProject()}>
                    <FolderOpen size={15} />
                    <span>打开你的第一个项目</span>
                  </button>
                ) : (
                  projects.map((item) => (
                    <button
                      className={`project-row ${projectId === item.id ? 'active' : ''}`}
                      key={item.id}
                      title={item.path}
                      onClick={() => void chooseProject(item.id)}
                    >
                      {projectId === item.id ? <FolderOpen size={16} /> : <Folder size={16} />}
                      <span>{item.name}</span>
                      {projectId === item.id && <span className="project-active-dot" />}
                    </button>
                  ))
                )}
              </div>
              <div className="sidebar-section-header sessions-heading">
                <span>{archived ? '已归档' : search ? '搜索结果' : '会话'}</span>
                <button
                  className={`icon-button ${archived ? 'active' : ''}`}
                  title={archived ? '返回活跃会话' : '查看已归档会话'}
                  onClick={() => setArchived((value) => !value)}
                >
                  <Archive size={13} />
                </button>
              </div>
              <div className="session-list">
                {searchPending ? (
                  <div className="sidebar-empty search-pending">
                    <LoaderCircle size={12} className="spin" />
                    正在搜索…
                  </div>
                ) : filteredSessions.length === 0 ? (
                  <div className="sidebar-empty">
                    {search
                      ? '没有找到相关会话'
                      : archived
                        ? '暂无已归档会话'
                        : project
                          ? '暂无会话'
                          : '先打开项目'}
                  </div>
                ) : (
                  filteredSessions.map((item) => (
                    <div
                      key={item.id}
                      className={`session-row ${sessionId === item.id ? 'active' : ''}`}
                    >
                      <button
                        className="session-select"
                        title={item.title}
                        onClick={() => chooseSession(item)}
                      >
                        <span
                          className={`session-state ${item.status === 'running' || item.status === 'waiting' ? 'running' : ''}`}
                          style={{ background: PROVIDERS[item.provider].color }}
                        />
                        <span>{item.title}</span>
                      </button>
                      <button
                        className="session-menu-trigger icon-button"
                        title="会话操作"
                        onClick={() => setMenuId(menuId === item.id ? undefined : item.id)}
                      >
                        <MoreHorizontal size={15} />
                      </button>
                      {menuId === item.id && (
                        <>
                          <div className="popover-backdrop" onClick={() => setMenuId(undefined)} />
                          <div className="session-menu">
                            <button
                              onClick={() => {
                                setRename({ id: item.id, title: item.title })
                                setMenuId(undefined)
                              }}
                            >
                              <Pencil size={13} />
                              重命名
                            </button>
                            <button
                              disabled={item.status === 'running' || item.status === 'waiting'}
                              onClick={() =>
                                void updateSession(item.id, { archived: !item.archived })
                              }
                            >
                              <Archive size={13} />
                              {item.archived ? '取消归档' : '归档会话'}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="sidebar-bottom">
              <button className="settings-entry" onClick={() => setSettingsOpen(true)}>
                <SettingsIcon size={16} />
                <span>设置</span>
                <span className="local-badge">
                  <span className="status-dot" />
                  本地
                </span>
              </button>
              <div className="sidebar-footnote">
                <span>所有数据保存在此设备</span>
                <span>v{version}</span>
              </div>
            </div>
          </aside>
        )}
        <main className="main">
          <div className="main-upper">
            <div className="main-content">
              {session && project ? (
                <>
                  <div className="conversation-toolbar">
                    <div className="conversation-heading">
                      <span
                        className="provider-logo"
                        style={{ color: PROVIDERS[session.provider].color }}
                      >
                        {session.provider === 'claude'
                          ? '✳'
                          : session.provider === 'codex'
                            ? '◇'
                            : '⌘'}
                      </span>
                      <div>
                        <strong>{session.title}</strong>
                        <span>
                          {PROVIDERS[session.provider].name}
                          <i>·</i>
                          {session.model || '默认模型'}
                        </span>
                      </div>
                    </div>
                    <div className="conversation-actions">
                      <span className={`session-status ${session.status}`}>
                        <span className="status-dot" />
                        {
                          {
                            idle: '就绪',
                            running: '执行中',
                            waiting: '等待回复',
                            error: '遇到问题',
                            interrupted: '已中断',
                          }[session.status]
                        }
                      </span>
                      <button className="icon-button" title="新建会话" onClick={openNew}>
                        <Plus size={17} />
                      </button>
                    </div>
                  </div>
                  <Chat
                    session={session}
                    events={events}
                    loading={loadingSession}
                    provider={providers.find((item) => item.id === session.provider)}
                    onSend={(text) => api.sendMessage(session.id, text)}
                    onStop={() => void api.interrupt(session.id).catch(reportError)}
                    onError={reportError}
                    context={context}
                    clearContext={() => setContext(undefined)}
                  />
                </>
              ) : (
                <EmptyState
                  project={project}
                  providers={providers}
                  checking={checking}
                  addProject={() => void addProject()}
                  createSession={openNew}
                  openSettings={() => setSettingsOpen(true)}
                />
              )}
            </div>
            {(workspace || workspaceLoaded) && project && (
              <Suspense
                fallback={
                  <aside className="workspace workspace-loading">
                    <LoaderCircle className="spin" size={20} />
                    <span>加载代码工作区…</span>
                  </aside>
                }
              >
                <Workspace
                  key={project.id}
                  visible={workspace}
                  onDirtyChange={setDirtyFiles}
                  project={project}
                  theme={theme}
                  running={sessions.some(
                    (item) =>
                      item.projectId === project.id &&
                      (item.status === 'running' || item.status === 'waiting'),
                  )}
                  onClose={() => setWorkspace(false)}
                  onError={reportError}
                  onContext={(path, content) => {
                    if (content.length > 60000) {
                      reportError(
                        '引用内容超过 60,000 字符。请在编辑器中选择较小的代码片段后再引用。',
                      )
                      return
                    }
                    if (!session) {
                      pendingContext.current = { path, content }
                      openNew()
                    } else {
                      setContext({ path, content })
                      notify('已引用到对话')
                    }
                  }}
                />
              </Suspense>
            )}
          </div>
          {projects
            .filter((item) => terminalProjects.includes(item.id))
            .map((item) => (
              <TerminalPanel
                key={item.id}
                project={item}
                visible={terminal && item.id === projectId}
                theme={theme}
                onClose={() => {
                  setTerminalProjects((previous) => previous.filter((id) => id !== item.id))
                  if (item.id === projectId) setTerminal(false)
                }}
              />
            ))}
        </main>
      </div>
      <Modal
        open={newOpen}
        onOpenChange={setNewOpen}
        title="新建会话"
        description={`为 ${project?.name || '当前项目'} 创建会话。`}
      >
        <div className="new-session-body">
          <label className="field-label">选择 coding agent</label>
          <div className="provider-picker">
            {providerIds.map((id) => {
              const info = providers.find((item) => item.id === id)
              return (
                <button
                  key={id}
                  className={selectedProvider === id ? 'selected' : ''}
                  onClick={() => {
                    const firstModel = info?.models[0]?.id
                    modelEdited.current = false
                    modelInitialized.current = !!firstModel
                    setSelectedProvider(id)
                    setModel(firstModel || '')
                  }}
                >
                  <span className="provider-monogram" style={{ color: PROVIDERS[id].color }}>
                    {id === 'claude' ? '✳' : id === 'codex' ? '◇' : '⌘'}
                  </span>
                  <strong>{PROVIDERS[id].name}</strong>
                  <span className={`provider-ready ${info?.available ? '' : 'unavailable'}`}>
                    <span className={`status-dot ${info?.available ? '' : 'off'}`} />
                    {info?.available ? '已就绪' : '未检测到'}
                  </span>
                  {selectedProvider === id && <Check size={14} className="provider-check" />}
                </button>
              )
            })}
          </div>
          <label className="field-label" htmlFor="session-model">
            模型 <span>可选</span>
          </label>
          {currentProvider?.models.length ? (
            <select
              id="session-model"
              className="input"
              value={model}
              onChange={(event) => {
                modelEdited.current = true
                setModel(event.target.value)
              }}
            >
              <option value="">使用 CLI 配置</option>
              {model && !currentProvider.models.some((item) => item.id === model) && (
                <option value={model}>{model}</option>
              )}
              {currentProvider.models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.id}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="session-model"
              className="input"
              value={model}
              onChange={(event) => {
                modelEdited.current = true
                setModel(event.target.value)
              }}
              placeholder="使用 CLI 配置"
            />
          )}
          <p className="field-hint">使用本机 CLI 的登录与项目配置。</p>
          {currentProvider && !currentProvider.available && (
            <div className="inline-warning">
              <AlertCircle size={15} />
              <span>{currentProvider.error || '请先安装或配置此 Agent CLI。'}</span>
              <button
                onClick={() => {
                  setNewOpen(false)
                  setSettingsOpen(true)
                }}
              >
                前往设置
              </button>
            </div>
          )}
          <button
            className="button primary full-width"
            disabled={newPending || !currentProvider?.available}
            onClick={() => void createSession()}
          >
            {newPending ? <LoaderCircle size={16} className="spin" /> : <MessageSquare size={16} />}
            开始会话
            <ArrowRight size={15} />
          </button>
        </div>
      </Modal>
      <Modal
        open={settingsOpen}
        onOpenChange={(value) => {
          setSettingsOpen(value)
          if (value) setCliDrafts(settings.cliPaths)
        }}
        title="设置"
        description="配置 Agent、外观与快捷键。"
        className="settings-dialog"
      >
        <div className="settings-layout">
          <nav className="settings-nav">
            <button
              className={settingsTab === 'agents' ? 'active' : ''}
              onClick={() => setSettingsTab('agents')}
            >
              <Code2 size={15} />
              Agent 连接
            </button>
            <button
              className={settingsTab === 'general' ? 'active' : ''}
              onClick={() => setSettingsTab('general')}
            >
              <Monitor size={15} />
              外观与通用
            </button>
            <button
              className={settingsTab === 'shortcuts' ? 'active' : ''}
              onClick={() => setSettingsTab('shortcuts')}
            >
              <Command size={15} />
              快捷键
            </button>
          </nav>
          <div className="settings-page">
            {settingsTab === 'agents' ? (
              <>
                <div className="settings-section-heading">
                  <div>
                    <h3>连接本机 CLI</h3>
                    <p>复用官方 CLI 的登录与项目配置。</p>
                  </div>
                  <button
                    className="button secondary small"
                    onClick={() => void loadProviders(projectId)}
                    disabled={checking}
                  >
                    <RefreshCw size={13} className={checking ? 'spin' : ''} />
                    重新检测
                  </button>
                </div>
                {providerIds.map((id) => {
                  const info = providers.find((item) => item.id === id)
                  return (
                    <div className="cli-setting" key={id}>
                      <div className="cli-heading">
                        <span className="provider-monogram" style={{ color: PROVIDERS[id].color }}>
                          {id === 'claude' ? '✳' : id === 'codex' ? '◇' : '⌘'}
                        </span>
                        <strong>{PROVIDERS[id].name}</strong>
                        <span className={`cli-state ${info?.available ? 'ready' : ''}`}>
                          <span className={`status-dot ${info?.available ? '' : 'off'}`} />
                          {checking
                            ? '检测中'
                            : info?.available
                              ? info.version || '已就绪'
                              : '未就绪'}
                        </span>
                      </div>
                      <label className="field-label" htmlFor={`cli-${id}`}>
                        CLI 路径 <span>留空自动检测</span>
                      </label>
                      <input
                        id={`cli-${id}`}
                        className="input mono"
                        placeholder={info?.path || PROVIDERS[id].command}
                        value={cliDrafts[id] || ''}
                        onChange={(event) =>
                          setCliDrafts((previous) => ({ ...previous, [id]: event.target.value }))
                        }
                      />
                      {info?.path && (
                        <div className="detected-path" title={info.path}>
                          {info.path}
                        </div>
                      )}
                      {info?.error && <div className="cli-error">{info.error}</div>}
                      <div className="cli-help">
                        <span>在终端完成安装和登录</span>
                        <button
                          onClick={() =>
                            void api
                              .openExternal(
                                {
                                  claude: 'https://code.claude.com/docs/en/setup',
                                  codex: 'https://developers.openai.com/codex/cli',
                                  opencode: 'https://opencode.ai/docs/',
                                }[id],
                              )
                              .catch(reportError)
                          }
                        >
                          官方文档
                          <ExternalLink size={11} />
                        </button>
                      </div>
                    </div>
                  )
                })}
                <div className="settings-save">
                  <span>路径更改在下次启动 Agent 时生效</span>
                  <button
                    className="button primary"
                    disabled={savingSettings}
                    onClick={async () => {
                      setSavingSettings(true)
                      try {
                        await saveSettings({
                          cliPaths: Object.fromEntries(
                            Object.entries(cliDrafts)
                              .filter(([, value]) => value?.trim())
                              .map(([key, value]) => [key, value!.trim()]),
                          ),
                        })
                        await loadProviders(projectId)
                        notify('连接设置已保存')
                      } catch (e) {
                        reportError(e)
                      } finally {
                        setSavingSettings(false)
                      }
                    }}
                  >
                    {savingSettings && <LoaderCircle size={14} className="spin" />}保存并检测
                  </button>
                </div>
              </>
            ) : settingsTab === 'general' ? (
              <>
                <h3>外观</h3>
                <p className="settings-description">设置界面主题。</p>
                <div className="theme-picker">
                  {(
                    [
                      { value: 'system', label: '跟随系统', Icon: Monitor },
                      { value: 'light', label: '浅色', Icon: Sun },
                      { value: 'dark', label: '深色', Icon: Moon },
                    ] as const
                  ).map(({ value, label, Icon }) => (
                    <button
                      key={value}
                      className={settings.theme === value ? 'selected' : ''}
                      onClick={() => void saveSettings({ theme: value }).catch(reportError)}
                    >
                      <Icon size={23} strokeWidth={1.4} />
                      <span>{label}</span>
                      {settings.theme === value && <Check size={12} />}
                    </button>
                  ))}
                </div>
                <div className="about-box">
                  <Brand small />
                  <div>
                    <span>版本</span>
                    <span>{version}</span>
                  </div>
                  <div>
                    <span>运行平台</span>
                    <span>
                      {platform === 'darwin'
                        ? 'macOS'
                        : platform === 'win32'
                          ? 'Windows'
                          : platform}
                    </span>
                  </div>
                  <div>
                    <span>数据与隐私</span>
                    <span>会话保存在本机</span>
                  </div>
                </div>
              </>
            ) : (
              <>
                <h3>快捷键</h3>
                <p className="settings-description">macOS 使用 ⌘，Windows 使用 Ctrl。</p>
                <div className="shortcut-list">
                  {[
                    ['新建会话', 'N'],
                    ['搜索会话', 'K'],
                    ['打开设置', ','],
                    ['切换侧栏', 'B'],
                    ['切换终端', 'J'],
                    ['保存当前文件', 'S'],
                  ].map(([label, key]) => (
                    <div key={key}>
                      <span>{label}</span>
                      <kbd>
                        {platform === 'darwin' ? '⌘' : 'Ctrl'} {key}
                      </kbd>
                    </div>
                  ))}
                  <div>
                    <span>发送消息</span>
                    <kbd>Enter</kbd>
                  </div>
                  <div>
                    <span>输入换行</span>
                    <kbd>Shift Enter</kbd>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </Modal>
      <Modal
        open={!!rename}
        onOpenChange={(value) => {
          if (!value) setRename(undefined)
        }}
        title="重命名会话"
        description="输入新的会话名称。"
      >
        <form
          className="rename-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (rename?.title.trim()) void updateSession(rename.id, { title: rename.title.trim() })
          }}
        >
          <input
            autoFocus
            className="input"
            value={rename?.title || ''}
            onChange={(event) =>
              setRename((previous) =>
                previous ? { ...previous, title: event.target.value } : previous,
              )
            }
          />
          <button className="button primary" disabled={!rename?.title.trim()}>
            保存名称
          </button>
        </form>
      </Modal>
      {toast && (
        <div className={`toast ${toast.error ? 'error' : ''}`} role="status">
          {toast.error ? <AlertCircle size={17} /> : <Check size={17} />}
          <span>{toast.message}</span>
          <button className="icon-button" onClick={() => setToast(undefined)} title="关闭提示">
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
