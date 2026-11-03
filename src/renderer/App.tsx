import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { createPortal } from 'react-dom'
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
  Pin,
  Trash2,
  Download,
  Inbox,
  GitBranch,
} from 'lucide-react'
import type {
  AgentEvent,
  Project,
  ProviderId,
  ProviderInfo,
  Session,
  Settings,
  Workspace as WorkspaceInfo,
  ContextItem,
  AppHealth,
  SessionSearchResult,
} from '../shared/types'
import { ACTIVE_STATUSES, PROVIDERS } from '../shared/types'
import { api, appendEvent, errorText, shortPath } from './lib/api'
import { flushBeforeClose } from './lib/close-flush'
import Chat from './components/Chat'
import TerminalPanel from './components/TerminalPanel'
import LayoutHandles from './components/LayoutHandles'
import WindowedSessionList from './components/WindowedSessionList'
import {
  DataSettings,
  ProjectManager,
  TaskInbox,
  TurnInspector,
  WorkspaceActions,
} from './components/ProductPanels'
const Workspace = lazy(() => import('./components/Workspace'))
const providerIds: ProviderId[] = ['claude', 'codex', 'opencode']
function ReadinessGrid({ info }: { info?: ProviderInfo }) {
  return (
    <dl className="readiness-grid" aria-label="Agent 连接检查">
      {(
        [
          { key: 'installation', label: 'CLI 安装' },
          { key: 'version', label: '协议版本' },
          { key: 'authentication', label: '账号登录' },
          { key: 'models', label: '模型列表' },
        ] as const
      ).map(({ key, label }) => {
        const value = info?.readiness?.[key] ?? 'unknown'
        return (
          <div key={key} data-readiness={value}>
            <dt>{label}</dt>
            <dd>
              {value === 'ready'
                ? key === 'authentication'
                  ? '已验证'
                  : '已确认'
                : value === 'error'
                  ? '需要处理'
                  : key === 'authentication'
                    ? '尚未验证'
                    : '未知'}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}
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
                        ? `${info.version || 'CLI 可用'}${info.readiness?.authentication !== 'ready' ? ' · 登录尚未验证' : ''}`
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
function App() {
  const [booting, setBooting] = useState(true)
  const [bootError, setBootError] = useState('')
  const [closing, setClosing] = useState(false)
  const closingRef = useRef(false)
  const [projects, setProjects] = useState<Project[]>([])
  const [removedProjects, setRemovedProjects] = useState<Project[]>([])
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const [loadedWorkspaces, setLoadedWorkspaces] = useState<string[]>([])
  const [health, setHealth] = useState<AppHealth>({ storage: 'ready', runtime: 'starting' })
  const [sessions, setSessions] = useState<Session[]>([])
  const [settings, setSettings] = useState<Settings>({ theme: 'system', cliPaths: {} })
  const settingsRef = useRef(settings)
  const settingsQueue = useRef<Promise<unknown>>(Promise.resolve())
  settingsRef.current = settings
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
  const [dirtyFiles, setDirtyFiles] = useState(false)
  const dirtyWorkspaces = useRef(new Set<string>())
  const dirtyCallbacks = useRef(new Map<string, (dirty: boolean) => void>())
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
  const [isolated, setIsolated] = useState(true)
  const [newWorkspaceId, setNewWorkspaceId] = useState('')
  const [workspaceChecking, setWorkspaceChecking] = useState(false)
  const [canIsolate, setCanIsolate] = useState(false)
  const [workspaceHint, setWorkspaceHint] = useState('')
  const workspaceCheck = useRef(0)
  const [addingProject, setAddingProject] = useState(false)
  const [search, setSearch] = useState('')
  const [searchIds, setSearchIds] = useState<Set<string>>(new Set())
  const [searchResults, setSearchResults] = useState<SessionSearchResult[]>([])
  const [focusEventId, setFocusEventId] = useState<string>()
  const [historyTarget, setHistoryTarget] = useState<{ id: string; eventId?: string }>()
  const [before, setBefore] = useState<number>()
  const [after, setAfter] = useState<number>()
  const [hasMore, setHasMore] = useState(false)
  const [hasNewer, setHasNewer] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const historyRequest = useRef(0)
  const historyAtLatest = useRef(true)
  const paging = useRef(false)
  const [searchPending, setSearchPending] = useState(false)
  const [archived, setArchived] = useState(false)
  const [trash, setTrash] = useState(false)
  const [projectManager, setProjectManager] = useState(false)
  const [inboxOpen, setInboxOpen] = useState(false)
  const [workspaceManager, setWorkspaceManager] = useState(false)
  const [inspection, setInspection] = useState<string>()
  const [commandOpen, setCommandOpen] = useState(false)
  const [commandQuery, setCommandQuery] = useState('')
  const [menuId, setMenuId] = useState<string>()
  const [menuPosition, setMenuPosition] = useState({ left: 16, top: 100 })
  const menuAnchor = useRef<HTMLButtonElement | null>(null)
  const [rename, setRename] = useState<{ id: string; title: string }>()
  const [toast, setToast] = useState<{ message: string; error: boolean }>()
  const [context, setContext] = useState<ContextItem>()
  const [systemDark, setSystemDark] = useState(
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  )
  const [cliDrafts, setCliDrafts] = useState<Settings['cliPaths']>({})
  const [savingSettings, setSavingSettings] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const providerProbe = useRef(0)
  const pendingContext = useRef<ContextItem | undefined>(undefined)
  const activeRef = useRef(sessionId)
  const eventIds = useRef(new Set<string>())
  const incoming = useRef<{ id: string; buffer: AgentEvent[] } | null>(null)
  const project = projects.find((item) => item.id === projectId)
  const session = sessions.find((item) => item.id === sessionId)
  const activeWorkspace = workspaces.find((item) => item.id === (session?.workspaceId ?? projectId))
  const workspaceProject = (item: WorkspaceInfo): Project => ({
    ...(projects.find((value) => value.id === item.projectId) ?? {
      createdAt: item.createdAt,
      trusted: false,
    }),
    id: item.id,
    name: item.name,
    path: item.cwd,
  })
  function dirtyHandler(id: string) {
    if (!dirtyCallbacks.current.has(id))
      dirtyCallbacks.current.set(id, (dirty) => {
        if (dirty) dirtyWorkspaces.current.add(id)
        else dirtyWorkspaces.current.delete(id)
        setDirtyFiles(dirtyWorkspaces.current.size > 0)
      })
    return dirtyCallbacks.current.get(id)!
  }
  const theme = settings.theme === 'system' ? (systemDark ? 'dark' : 'light') : settings.theme
  activeRef.current = sessionId
  const reportError = useCallback(
    (error: unknown) => setToast({ message: errorText(error), error: true }),
    [],
  )
  const notify = (message: string) => setToast({ message, error: false })
  useEffect(() => {
    if (!api) return
    const stopEditing = (event: Event) => {
      if (!closingRef.current) return
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    document.addEventListener('keydown', stopEditing, true)
    document.addEventListener('beforeinput', stopEditing, true)
    const unsubscribe = api.onPrepareClose(async () => {
      closingRef.current = true
      setClosing(true)
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      await flushBeforeClose()
      await settingsQueue.current.catch(() => undefined)
      await api.saveSettings(settingsRef.current)
    })
    const cancel = api.onCloseCancelled(() => {
      closingRef.current = false
      setClosing(false)
    })
    return () => {
      unsubscribe()
      cancel()
      document.removeEventListener('keydown', stopEditing, true)
      document.removeEventListener('beforeinput', stopEditing, true)
    }
  }, [])
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(undefined), toast.error ? 8000 : 3500)
    return () => clearTimeout(timer)
  }, [toast])
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  useEffect(() => {
    if (workspace && activeWorkspace)
      setLoadedWorkspaces((previous) =>
        previous.includes(activeWorkspace.id) ? previous : [...previous, activeWorkspace.id],
      )
  }, [workspace, activeWorkspace?.id])
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const change = () => setSystemDark(media.matches)
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  const saveSettings = async (patch: Partial<Settings>) => {
    const next = { ...settingsRef.current, ...patch }
    settingsRef.current = next
    setSettings(next)
    const task = settingsQueue.current.catch(() => undefined).then(() => api.saveSettings(next))
    settingsQueue.current = task
    const updated = await task
    if (settingsRef.current === next) {
      settingsRef.current = updated
      setSettings(updated)
    }
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
      setRemovedProjects(data.removedProjects ?? [])
      setWorkspaces(data.workspaces)
      setHealth(data.health)
      setSessions(data.sessions)
      setSettings(data.settings)
      setCliDrafts(data.settings.cliPaths)
      setPlatform(data.platform)
      setVersion(data.version)
      const storedSession = data.sessions.find(
        (item) => item.id === data.settings.lastSessionId && !item.archived && !item.deletedAt,
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
        if (event.kind === 'done' && document.hasFocus() && historyAtLatest.current)
          void api.updateSession(event.sessionId, { readAt: Date.now() }).catch(reportError)
        if (incoming.current?.id === event.sessionId) incoming.current.buffer.push(event)
        else if (historyAtLatest.current) {
          eventIds.current.add(event.id)
          setEvents((previous) => appendEvent(previous, event))
        }
      }
    })
    let refreshing = false
    let refreshAgain = false
    let alive = true
    const unSessions = api.onSessionsChanged(() => {
      refreshAgain = true
      if (refreshing) return
      refreshing = true
      void (async () => {
        try {
          do {
            refreshAgain = false
            try {
              const data = await api.bootstrap()
              if (!alive) return
              setSessions(data.sessions)
              setProjects(data.projects)
              setRemovedProjects(data.removedProjects ?? [])
              setWorkspaces(data.workspaces)
              setHealth(data.health)
            } catch (error) {
              if (alive) reportError(error)
            }
          } while (alive && refreshAgain)
        } finally {
          refreshing = false
        }
      })()
    })
    return () => {
      alive = false
      unEvent()
      unSessions()
    }
  }, [reportError])
  useEffect(() => {
    if (api) return api.onHealth(setHealth)
  }, [])
  useEffect(() => {
    const request = ++historyRequest.current
    paging.current = false
    setLoadingMore(false)
    setContext(pendingContext.current)
    pendingContext.current = undefined
    eventIds.current.clear()
    setEvents([])
    setHasMore(false)
    setHasNewer(false)
    setBefore(undefined)
    setAfter(undefined)
    historyAtLatest.current = false
    incoming.current = null
    if (!sessionId || !api) {
      setLoadingSession(false)
      return
    }
    let stale = false
    const pending = { id: sessionId, buffer: [] as AgentEvent[] }
    const anchor = historyTarget?.id === sessionId ? historyTarget.eventId : undefined
    incoming.current = pending
    setLoadingSession(true)
    void api
      .getSession(sessionId, { limit: 100, aroundEventId: anchor })
      .then((view) => {
        if (stale || request !== historyRequest.current) return
        setSessions((previous) =>
          previous.map((item) => (item.id === view.session.id ? view.session : item)),
        )
        const raw = [
          ...view.events,
          ...(view.hasNewer
            ? []
            : pending.buffer.filter(
                (event) => event.sequence !== undefined && event.sequence > view.cursor,
              )),
        ]
        historyAtLatest.current = !view.hasNewer
        eventIds.current = new Set(raw.map((event) => event.id))
        incoming.current = null
        setEvents(raw.reduce(appendEvent, [] as AgentEvent[]))
        setBefore(view.before)
        setAfter(view.after)
        setHasMore(Boolean(view.hasMore))
        setHasNewer(Boolean(view.hasNewer))
        if (anchor && view.anchorFound === false) {
          setFocusEventId(undefined)
          reportError('搜索命中已不可用，已显示此会话最新消息。请重新搜索。')
        }
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
  }, [sessionId, historyTarget, reportError])
  async function loadMore(direction: 'older' | 'newer' = 'older') {
    if (
      !sessionId ||
      loadingSession ||
      paging.current ||
      (direction === 'older' ? !hasMore : !hasNewer)
    )
      return
    const id = sessionId
    const request = historyRequest.current
    paging.current = true
    setLoadingMore(true)
    const pending = direction === 'newer' ? { id, buffer: [] as AgentEvent[] } : undefined
    if (pending) incoming.current = pending
    try {
      const view = await api.getSession(id, {
        ...(direction === 'older' ? { before } : { after }),
        limit: 100,
      })
      if (activeRef.current !== id || request !== historyRequest.current) return
      const raw = [
        ...view.events,
        ...(pending && !view.hasNewer
          ? pending.buffer.filter(
              (event) => event.sequence !== undefined && event.sequence > view.cursor,
            )
          : []),
      ]
      for (const event of raw) eventIds.current.add(event.id)
      setEvents((previous) =>
        direction === 'older'
          ? [...raw.filter((event) => !previous.some((item) => item.id === event.id)), ...previous]
          : raw.reduce(appendEvent, previous),
      )
      if (direction === 'older') {
        setBefore(view.before)
        setHasMore(Boolean(view.hasMore))
      } else {
        setAfter(view.after)
        setHasNewer(Boolean(view.hasNewer))
        historyAtLatest.current = !view.hasNewer
      }
    } catch (error) {
      if (request === historyRequest.current) reportError(error)
    } finally {
      if (incoming.current === pending) incoming.current = null
      if (request === historyRequest.current) {
        paging.current = false
        setLoadingMore(false)
      }
    }
  }
  function latestHistory() {
    if (!sessionId) return
    setFocusEventId(undefined)
    setHistoryTarget({ id: sessionId })
  }
  function toggleTerminal() {
    if (!activeWorkspace || !project?.trusted) return
    if (!terminal)
      setTerminalProjects((previous) =>
        previous.includes(activeWorkspace.id) ? previous : [...previous, activeWorkspace.id],
      )
    setTerminal((value) => !value)
  }
  async function chooseProject(id: string) {
    setProjectId(id)
    setSessionId(undefined)
    setMenuId(undefined)
    setTerminal(false)
    setFocusEventId(undefined)
    void saveSettings({ lastProjectId: id, lastSessionId: undefined }).catch(reportError)
    void loadProviders(id)
  }
  function chooseSession(item: Session, eventId?: string) {
    if (item.projectId !== projectId) {
      setTerminal(false)
      void loadProviders(item.projectId)
    }
    setProjectId(item.projectId)
    setSessionId(item.id)
    setHistoryTarget({ id: item.id, eventId })
    setMenuId(undefined)
    setFocusEventId(eventId)
    setInspection(undefined)
    void api.updateSession(item.id, { readAt: Date.now() }).catch(reportError)
    void saveSettings({ lastProjectId: item.projectId, lastSessionId: item.id }).catch(reportError)
  }
  useEffect(() => {
    if (!api) return
    return api.onFocusSession((id) => {
      void api
        .getSession(id, { limit: 100 })
        .then((view) => {
          setSessions((previous) =>
            previous.some((item) => item.id === view.session.id)
              ? previous
              : [view.session, ...previous],
          )
          chooseSession(view.session)
          setInboxOpen(false)
        })
        .catch(reportError)
    })
  }, [settings])
  async function refreshCatalog(next?: Project) {
    const data = await api.bootstrap()
    setProjects(data.projects)
    setRemovedProjects(data.removedProjects ?? [])
    setSessions(data.sessions)
    setWorkspaces(data.workspaces)
    setHealth(data.health)
    if (next && !next.removedAt) await chooseProject(next.id)
    else if (projectId && !data.projects.some((item) => item.id === projectId)) {
      setProjectId(data.projects[0]?.id)
      setSessionId(undefined)
    }
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
    setIsolated(false)
    setCanIsolate(false)
    setWorkspaceHint(project.trusted ? '正在检查项目仓库…' : '请先信任项目。')
    setNewWorkspaceId('')
    const token = ++workspaceCheck.current
    if (!project.trusted) {
      setWorkspaceChecking(false)
      return
    }
    setWorkspaceChecking(true)
    void api.inspectWorkspace(project.id).then(
      (identity) => {
        if (token !== workspaceCheck.current) return
        setCanIsolate(identity.hasHead)
        setIsolated(identity.hasHead)
        setWorkspaceHint(
          identity.hasHead
            ? '独立工作区保留各会话修改；已有会话始终继续使用原目录。'
            : '项目尚无 Git 提交，已选择共享工作区；创建首个提交后可使用独立工作区。',
        )
        setWorkspaceChecking(false)
      },
      () => {
        if (token !== workspaceCheck.current) return
        setWorkspaceHint('未检测到可用的 Git 提交，已选择共享工作区。')
        setWorkspaceChecking(false)
      },
    )
  }
  async function createSession() {
    if (!project || workspaceChecking || (isolated && !canIsolate)) return
    setNewPending(true)
    try {
      const created = await api.createSession({
        projectId: project.id,
        provider: selectedProvider,
        model: model.trim() || undefined,
        isolated: !newWorkspaceId && isolated,
        workspaceId: newWorkspaceId || undefined,
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
  async function updateSession(id: string, patch: Parameters<typeof api.updateSession>[1]) {
    try {
      const result = await api.updateSession(id, patch)
      setSessions((previous) => previous.map((item) => (item.id === id ? result : item)))
      if ((patch.archived || patch.deletedAt) && sessionId === id) {
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
      } else if (letter === 'p' && event.shiftKey) {
        event.preventDefault()
        setCommandOpen(true)
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
    if (trash) {
      setSearchPending(false)
      setSearchIds(
        new Set(
          sessions
            .filter(
              (item) =>
                item.deletedAt &&
                item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
            )
            .map((item) => item.id),
        ),
      )
      return
    }
    let stale = false
    setSearchPending(true)
    const timer = setTimeout(() => {
      void api
        .searchSessions(query)
        .then((results) => {
          if (!stale) {
            setSearchIds(new Set(results.map((item) => item.id)))
            setSearchResults(results)
          }
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
  }, [search, trash, reportError])
  const filteredSessions = sessions
    .filter(
      (item) =>
        Boolean(item.deletedAt) === trash &&
        (trash || item.archived === archived) &&
        (search.trim() ? searchIds.has(item.id) : item.projectId === projectId),
    )
    .sort(
      (a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt,
    )
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
      inert={closing}
      style={
        {
          '--sidebar-width': `${settings.sidebarWidth ?? 238}px`,
          '--workspace-width': settings.workspaceWidth ? `${settings.workspaceWidth}px` : '48vw',
          '--terminal-height': `${settings.terminalHeight ?? 230}px`,
        } as React.CSSProperties
      }
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
          <button
            className="icon-button"
            title="任务收件箱"
            aria-label="任务收件箱"
            onClick={() => setInboxOpen(true)}
          >
            <Inbox size={16} />
          </button>
          <button
            className="icon-button"
            title="命令面板 · ⌘/Ctrl + Shift + P"
            aria-label="命令面板"
            onClick={() => setCommandOpen(true)}
          >
            <Command size={16} />
          </button>
          {project && (
            <>
              <button
                className={`icon-button ${terminal ? 'active' : ''}`}
                title="终端 · ⌘/Ctrl + J"
                aria-label="切换终端"
                onClick={toggleTerminal}
                disabled={!project.trusted}
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
                  aria-label="搜索会话"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={trash ? '筛选回收站标题' : '搜索标题与对话内容'}
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
                  title="管理项目"
                  aria-label="管理项目"
                  onClick={() => setProjectManager(true)}
                >
                  <MoreHorizontal size={14} />
                </button>
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
                <span>{trash ? '回收站' : archived ? '已归档' : search ? '搜索结果' : '会话'}</span>
                <button
                  className={`icon-button ${trash ? 'active' : ''}`}
                  title={trash ? '返回会话' : '会话回收站'}
                  onClick={() => {
                    setTrash((value) => !value)
                    setSearch('')
                  }}
                >
                  <Trash2 size={13} />
                </button>
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
                  <WindowedSessionList
                    key={`${projectId}:${archived}:${trash}:${search}`}
                    items={filteredSessions}
                    activeId={sessionId}
                    rowHeight={search ? 54 : 38}
                  >
                    {(item) => (
                      <div
                        key={item.id}
                        className={`session-row ${sessionId === item.id ? 'active' : ''}`}
                        style={{ height: search ? 50 : 34 }}
                      >
                        <button
                          className="session-select"
                          title={item.title}
                          onClick={() =>
                            chooseSession(
                              item,
                              searchResults.find((result) => result.id === item.id)?.matchEventId,
                            )
                          }
                        >
                          <span
                            className={`session-state ${item.status === 'running' || item.status === 'waiting' ? 'running' : ''}`}
                            style={{ background: PROVIDERS[item.provider].color }}
                          />
                          <span>
                            {item.pinned ? '⌁ ' : ''}
                            {item.title}
                            {search &&
                              searchResults.find((result) => result.id === item.id)?.snippet && (
                                <small className="session-snippet">
                                  {searchResults.find((result) => result.id === item.id)?.snippet}
                                </small>
                              )}
                          </span>
                        </button>
                        <button
                          className="session-menu-trigger icon-button"
                          title="会话操作"
                          onClick={(event) => {
                            const rect = event.currentTarget.getBoundingClientRect()
                            menuAnchor.current = event.currentTarget
                            setMenuPosition({
                              left: Math.max(
                                8,
                                Math.min(window.innerWidth - 200, rect.right - 180),
                              ),
                              top: Math.max(8, Math.min(window.innerHeight - 240, rect.bottom + 4)),
                            })
                            setMenuId(menuId === item.id ? undefined : item.id)
                          }}
                        >
                          <MoreHorizontal size={15} />
                        </button>
                        {menuId === item.id &&
                          createPortal(
                            <>
                              <div
                                className="popover-backdrop"
                                onClick={() => setMenuId(undefined)}
                              />
                              <div
                                className="session-menu"
                                role="menu"
                                aria-label="会话操作"
                                style={{
                                  position: 'fixed',
                                  left: menuPosition.left,
                                  top: menuPosition.top,
                                  right: 'auto',
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === 'Escape') {
                                    event.preventDefault()
                                    setMenuId(undefined)
                                    menuAnchor.current?.focus()
                                  } else if (
                                    ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
                                  ) {
                                    event.preventDefault()
                                    const buttons = [
                                      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                                        'button:not(:disabled)',
                                      ),
                                    ]
                                    const index = buttons.indexOf(
                                      document.activeElement as HTMLButtonElement,
                                    )
                                    const next =
                                      event.key === 'Home'
                                        ? 0
                                        : event.key === 'End'
                                          ? buttons.length - 1
                                          : (index +
                                              (event.key === 'ArrowDown' ? 1 : -1) +
                                              buttons.length) %
                                            buttons.length
                                    buttons[next]?.focus()
                                  }
                                }}
                              >
                                <button
                                  role="menuitem"
                                  autoFocus
                                  onClick={() => {
                                    setRename({ id: item.id, title: item.title })
                                    setMenuId(undefined)
                                  }}
                                >
                                  <Pencil size={13} />
                                  重命名
                                </button>
                                <button
                                  role="menuitem"
                                  onClick={() =>
                                    void updateSession(item.id, { pinned: !item.pinned })
                                  }
                                >
                                  <Pin size={13} />
                                  {item.pinned ? '取消置顶' : '置顶会话'}
                                </button>
                                <button
                                  role="menuitem"
                                  onClick={() =>
                                    void api
                                      .exportSession(item.id, 'markdown')
                                      .then((saved) => saved && notify('会话已导出'))
                                      .catch(reportError)
                                  }
                                >
                                  <Download size={13} />
                                  导出 Markdown
                                </button>
                                <button
                                  role="menuitem"
                                  onClick={() =>
                                    void api
                                      .exportSession(item.id, 'json')
                                      .then((saved) => saved && notify('会话已导出'))
                                      .catch(reportError)
                                  }
                                >
                                  <Download size={13} />
                                  导出 JSON
                                </button>
                                <button
                                  role="menuitem"
                                  disabled={ACTIVE_STATUSES.includes(item.status)}
                                  onClick={() =>
                                    void updateSession(item.id, { archived: !item.archived })
                                  }
                                >
                                  <Archive size={13} />
                                  {item.archived ? '取消归档' : '归档会话'}
                                </button>
                                <button
                                  role="menuitem"
                                  disabled={ACTIVE_STATUSES.includes(item.status)}
                                  onClick={() =>
                                    void updateSession(item.id, {
                                      deletedAt: item.deletedAt ? null : Date.now(),
                                    })
                                  }
                                >
                                  <Trash2 size={13} />
                                  {item.deletedAt ? '恢复会话' : '移至回收站'}
                                </button>
                              </div>
                            </>,
                            document.body,
                          )}
                      </div>
                    )}
                  </WindowedSessionList>
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
          {(health.storage === 'error' || health.runtime === 'error' || health.code) && (
            <div className="health-banner" role="alert">
              <AlertCircle size={16} />
              <span>{health.message || '工作台服务出现问题。草稿已保留，请重试或导出诊断。'}</span>
              {health.storage === 'error' || health.runtime === 'error' ? (
                <button
                  className="button secondary small"
                  onClick={() => void api.retryStorage().then(setHealth).catch(reportError)}
                >
                  重试连接
                </button>
              ) : (
                <button
                  className="button secondary small"
                  onClick={() => {
                    setSettingsTab('data')
                    setSettingsOpen(true)
                  }}
                >
                  数据与备份
                </button>
              )}
              <button
                className="button secondary small"
                onClick={() => void api.exportDiagnostics().catch(reportError)}
              >
                导出诊断
              </button>
            </div>
          )}
          {project && !project.trusted && (
            <div className="trust-banner" role="status">
              <AlertCircle size={16} />
              <span>
                此项目处于受限模式。信任后才能运行 Agent、项目脚本和终端。请先确认目录来源。
              </span>
              <button
                className="button primary small"
                onClick={() =>
                  void api
                    .trustProject(project.id, true)
                    .then((trusted) => {
                      setProjects((previous) =>
                        previous.map((item) => (item.id === trusted.id ? trusted : item)),
                      )
                      void loadProviders(project.id)
                    })
                    .catch(reportError)
                }
              >
                信任此项目
              </button>
            </div>
          )}
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
                            starting: '正在启动',
                            running: '执行中',
                            waiting: '等待回复',
                            error: '遇到问题',
                            interrupted: '已中断',
                            stopping: '正在停止',
                            stop_failed: '停止失败',
                          }[session.status]
                        }
                      </span>
                      <button className="icon-button" title="新建会话" onClick={openNew}>
                        <Plus size={17} />
                      </button>
                      {activeWorkspace && (
                        <button
                          className="button secondary small"
                          onClick={() => setWorkspaceManager(true)}
                        >
                          <GitBranch size={13} />
                          {activeWorkspace.kind === 'worktree' ? '独立工作区' : '共享工作区'}
                        </button>
                      )}
                    </div>
                  </div>
                  <Chat
                    session={session}
                    events={events}
                    loading={loadingSession}
                    provider={providers.find((item) => item.id === session.provider)}
                    onSend={(text) => {
                      if (hasNewer || focusEventId) latestHistory()
                      return api.sendMessage(session.id, text)
                    }}
                    onStop={() => void api.interrupt(session.id).catch(reportError)}
                    onError={reportError}
                    context={context}
                    clearContext={() => setContext(undefined)}
                    settings={settings}
                    disabled={
                      !project.trusted || health.storage === 'error' || Boolean(session.deletedAt)
                    }
                    hasMore={hasMore}
                    hasNewer={hasNewer}
                    loadingMore={loadingMore}
                    onLoadMore={() => void loadMore()}
                    onLoadNewer={() => void loadMore('newer')}
                    onLatest={latestHistory}
                    onInspectTurn={setInspection}
                    focusEventId={focusEventId}
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
            {workspaces
              .filter((item) => loadedWorkspaces.includes(item.id))
              .map((item) => (
                <Suspense
                  key={item.id}
                  fallback={
                    <aside className="workspace workspace-loading">
                      <LoaderCircle className="spin" size={20} />
                      <span>加载代码工作区…</span>
                    </aside>
                  }
                >
                  <Workspace
                    key={item.id}
                    visible={workspace && activeWorkspace?.id === item.id}
                    onDirtyChange={dirtyHandler(item.id)}
                    project={workspaceProject(item)}
                    theme={theme}
                    settings={settings}
                    running={sessions.some(
                      (candidate) =>
                        (candidate.workspaceId ?? candidate.projectId) === item.id &&
                        ACTIVE_STATUSES.includes(candidate.status),
                    )}
                    onClose={() => setWorkspace(false)}
                    onError={reportError}
                    onContext={(path, content, startLine, endLine) => {
                      if (content.length > 60000) {
                        reportError(
                          '引用内容超过 60,000 字符。请在编辑器中选择较小的代码片段后再引用。',
                        )
                        return
                      }
                      const reference: ContextItem = {
                        id: crypto.randomUUID(),
                        kind: startLine ? 'selection' : 'file',
                        name: path,
                        path,
                        content,
                        startLine,
                        endLine,
                      }
                      if (!session) {
                        pendingContext.current = reference
                        openNew()
                      } else {
                        setContext(reference)
                        notify('已引用到对话')
                      }
                    }}
                  />
                </Suspense>
              ))}
          </div>
          {workspaces
            .filter((item) => terminalProjects.includes(item.id))
            .map((item) => (
              <TerminalPanel
                key={item.id}
                project={workspaceProject(item)}
                visible={terminal && item.id === activeWorkspace?.id}
                theme={theme}
                settings={settings}
                onError={reportError}
                onContext={(content) =>
                  setContext({
                    id: crypto.randomUUID(),
                    kind: 'terminal',
                    name: '终端输出',
                    content,
                  })
                }
                onClose={() => {
                  if (item.id === activeWorkspace?.id) setTerminal(false)
                }}
              />
            ))}
        </main>
      </div>
      <Modal
        open={newOpen}
        onOpenChange={(value) => {
          if (!value) workspaceCheck.current++
          setNewOpen(value)
        }}
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
                    {info?.available ? 'CLI 可用' : '未检测到'}
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
          <label className="field-label" htmlFor="session-workspace">
            工作区
          </label>
          <select
            id="session-workspace"
            className="input"
            disabled={workspaceChecking}
            value={newWorkspaceId || (isolated ? 'isolated' : 'shared')}
            onChange={(event) => {
              const value = event.target.value
              setIsolated(value === 'isolated')
              setNewWorkspaceId(value === 'isolated' || value === 'shared' ? '' : value)
            }}
          >
            <option value="isolated" disabled={!canIsolate}>
              新建独立工作区（推荐）
            </option>
            <option value="shared">项目共享工作区</option>
            {workspaces
              .filter((item) => item.projectId === projectId && item.kind === 'worktree')
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.branch || item.cwd}
                </option>
              ))}
          </select>
          <p className="field-hint" role="status">
            {workspaceHint}
          </p>
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
            disabled={
              newPending ||
              workspaceChecking ||
              !currentProvider?.available ||
              !project?.trusted ||
              health.storage === 'error'
            }
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
            <button
              className={settingsTab === 'data' ? 'active' : ''}
              onClick={() => setSettingsTab('data')}
            >
              <Download size={15} />
              数据与更新
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
                      <ReadinessGrid info={info} />
                      <p className="field-hint">
                        登录未知时不会视为已登录；首次实际请求由本机 CLI
                        验证。模型列表不代表账号已获全部模型权限。
                      </p>
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
            ) : settingsTab === 'data' ? (
              <DataSettings
                onError={reportError}
                notify={notify}
                onBeforeRestore={async () => {
                  setLoadedWorkspaces([])
                  setTerminalProjects([])
                  setSessionId(undefined)
                  setWorkspace(false)
                  setTerminal(false)
                  setContext(undefined)
                  // Run component cleanup and its save IPC before replacing the database.
                  await new Promise<void>((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                  )
                  await settingsQueue.current.catch(() => undefined)
                  await api.getSettings()
                }}
                onRestored={() => {
                  setLoadedWorkspaces([])
                  setTerminalProjects([])
                  dirtyWorkspaces.current.clear()
                  setDirtyFiles(false)
                  void load()
                }}
                hasDirty={dirtyFiles}
              />
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
                <div className="management-stack">
                  <label className="field-label">
                    编辑器字号
                    <input
                      type="number"
                      className="input"
                      min={10}
                      max={24}
                      value={settings.fontSize ?? 12}
                      onChange={(event) =>
                        void saveSettings({ fontSize: Number(event.target.value) }).catch(
                          reportError,
                        )
                      }
                    />
                  </label>
                  <label className="field-label">
                    缩进宽度
                    <select
                      className="input"
                      value={settings.tabSize ?? 2}
                      onChange={(event) =>
                        void saveSettings({ tabSize: Number(event.target.value) }).catch(
                          reportError,
                        )
                      }
                    >
                      <option value={2}>2</option>
                      <option value={4}>4</option>
                      <option value={8}>8</option>
                    </select>
                  </label>
                  <label className="field-label">
                    发送消息
                    <select
                      className="input"
                      value={settings.sendKey ?? 'enter'}
                      onChange={(event) =>
                        void saveSettings({
                          sendKey: event.target.value as Settings['sendKey'],
                        }).catch(reportError)
                      }
                    >
                      <option value="enter">Enter 发送 / Shift Enter 换行</option>
                      <option value="mod-enter">⌘/Ctrl Enter 发送</option>
                    </select>
                  </label>
                  <label className="question-option">
                    <input
                      type="checkbox"
                      checked={settings.notifications !== false}
                      onChange={(event) =>
                        void saveSettings({ notifications: event.target.checked }).catch(
                          reportError,
                        )
                      }
                    />
                    任务完成、失败与等待回复时通知
                  </label>
                  <label className="field-label">
                    侧栏宽度
                    <input
                      className="input"
                      type="range"
                      min={210}
                      max={400}
                      value={settings.sidebarWidth ?? 238}
                      onChange={(event) =>
                        void saveSettings({ sidebarWidth: Number(event.target.value) }).catch(
                          reportError,
                        )
                      }
                    />
                  </label>
                  <label className="field-label">
                    工作区宽度
                    <input
                      className="input"
                      type="range"
                      min={430}
                      max={1000}
                      value={settings.workspaceWidth ?? 690}
                      onChange={(event) =>
                        void saveSettings({ workspaceWidth: Number(event.target.value) }).catch(
                          reportError,
                        )
                      }
                    />
                  </label>
                  <label className="field-label">
                    终端高度
                    <input
                      className="input"
                      type="range"
                      min={140}
                      max={600}
                      value={settings.terminalHeight ?? 230}
                      onChange={(event) =>
                        void saveSettings({ terminalHeight: Number(event.target.value) }).catch(
                          reportError,
                        )
                      }
                    />
                  </label>
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
                    ['命令面板', 'Shift + P'],
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
        open={projectManager}
        onOpenChange={setProjectManager}
        title="项目管理"
        description="创建、克隆、恢复或重新定位本机项目。"
        className="management-dialog"
      >
        <ProjectManager
          projects={projects}
          removedProjects={removedProjects}
          onChanged={(next) => void refreshCatalog(next).catch(reportError)}
          onError={reportError}
          notify={notify}
        />
      </Modal>
      <Modal
        open={inboxOpen}
        onOpenChange={setInboxOpen}
        title="任务收件箱"
        description="查看运行、等待回复和失败的任务。"
        className="management-dialog"
      >
        <TaskInbox
          sessions={sessions}
          onSelect={(item) => {
            chooseSession(item)
            setInboxOpen(false)
          }}
          onError={reportError}
        />
      </Modal>
      <Modal
        open={workspaceManager}
        onOpenChange={setWorkspaceManager}
        title="工作区管理"
        description="审阅独立工作区，将修改应用回共享目录。"
        className="management-dialog"
      >
        {activeWorkspace && (
          <WorkspaceActions
            workspace={activeWorkspace}
            onChanged={() => void refreshCatalog().catch(reportError)}
            onError={reportError}
            notify={notify}
          />
        )}
      </Modal>
      <Modal
        open={Boolean(inspection)}
        onOpenChange={(open) => {
          if (!open) setInspection(undefined)
        }}
        title="本轮变更与检查"
        description="审阅、选择性回滚并运行项目检查。"
        className="management-dialog"
      >
        {inspection && session && activeWorkspace && (
          <TurnInspector
            key={`${session.id}:${inspection}`}
            session={session}
            workspace={activeWorkspace}
            turnId={inspection}
            onError={reportError}
            notify={notify}
            onContext={(name, content) => {
              setContext({ id: crypto.randomUUID(), kind: 'diff', name, content })
              setInspection(undefined)
            }}
          />
        )}
      </Modal>
      <Modal
        open={commandOpen}
        onOpenChange={setCommandOpen}
        title="命令面板"
        description="搜索命令并快速跳转。"
      >
        <input
          autoFocus
          className="input"
          placeholder="搜索命令…"
          value={commandQuery}
          onChange={(event) => setCommandQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === 'ArrowDown') {
              event.preventDefault()
              const first =
                event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(
                  '[data-command]',
                )
              if (event.key === 'Enter') first?.click()
              else first?.focus()
            }
          }}
        />
        <div className="command-list">
          {[
            { name: '新建会话', run: openNew },
            { name: '打开项目', run: () => void addProject() },
            { name: '管理项目 / 克隆仓库', run: () => setProjectManager(true) },
            { name: '任务收件箱', run: () => setInboxOpen(true) },
            { name: '设置', run: () => setSettingsOpen(true) },
            {
              name: '数据备份与应用更新',
              run: () => {
                setSettingsTab('data')
                setSettingsOpen(true)
              },
            },
            { name: '切换终端', run: toggleTerminal },
            { name: '切换代码工作区', run: () => setWorkspace((value) => !value) },
            {
              name: '搜索会话',
              run: () => {
                setSidebar(true)
                setTimeout(() => searchRef.current?.focus(), 0)
              },
            },
            ...sessions
              .filter((item) => !item.deletedAt)
              .map((item) => ({ name: `会话：${item.title}`, run: () => chooseSession(item) })),
          ]
            .filter((item) =>
              item.name.toLocaleLowerCase().includes(commandQuery.toLocaleLowerCase()),
            )
            .slice(0, 30)
            .map((item, index) => (
              <button
                key={`${index}:${item.name}`}
                data-command
                className="inbox-row"
                onClick={() => {
                  setCommandOpen(false)
                  setCommandQuery('')
                  item.run()
                }}
              >
                {item.name}
              </button>
            ))}
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
      <LayoutHandles
        settings={settings}
        onChange={(patch) => void saveSettings(patch).catch(reportError)}
      />
      {closing &&
        createPortal(
          <div
            role="alert"
            aria-live="assertive"
            aria-busy="true"
            className="closing-overlay"
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 10000,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 12,
              background: 'var(--main)',
              color: 'var(--text)',
            }}
          >
            <LoaderCircle className="spin" size={20} />
            正在保存草稿与编辑器状态，请稍候…
          </div>,
          document.body,
        )}
    </div>
  )
}

class AppBoundary extends Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (this.state.failed)
      return (
        <div className="startup">
          <Brand />
          <h2>界面需要恢复</h2>
          <p>后台任务可能仍在运行。重新载入将恢复会话、草稿和终端连接。</p>
          <button className="button primary" onClick={() => location.reload()}>
            重新载入界面
          </button>
          <button
            className="button secondary"
            onClick={() => void api?.exportDiagnostics().catch(() => {})}
          >
            导出诊断
          </button>
        </div>
      )
    return this.props.children
  }
}

export default function SafeApp() {
  return (
    <AppBoundary>
      <App />
    </AppBoundary>
  )
}
