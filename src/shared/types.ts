export type ProviderId = 'claude' | 'codex' | 'opencode'
export type SessionStatus =
  'idle' | 'starting' | 'running' | 'waiting' | 'stopping' | 'stop_failed' | 'error' | 'interrupted'
export const ACTIVE_STATUSES: SessionStatus[] = [
  'starting',
  'running',
  'waiting',
  'stopping',
  'stop_failed',
]
export interface Project {
  id: string
  name: string
  path: string
  createdAt: number
  trusted?: boolean
  removedAt?: number
}
export interface Workspace {
  id: string
  projectId: string
  kind: 'shared' | 'worktree'
  cwd: string
  name: string
  branch?: string
  canonicalId?: string
  repositoryId?: string
  ownedByHub?: boolean
  createdAt: number
  deletedAt?: number
}
export interface Session {
  id: string
  projectId: string
  workspaceId?: string
  provider: ProviderId
  title: string
  model?: string
  reasoningOption?: string
  nativeId?: string
  activeTurnId?: string
  status: SessionStatus
  archived: boolean
  pinned?: boolean
  deletedAt?: number
  readAt?: number
  createdAt: number
  updatedAt: number
}
export interface Model {
  id: string
  name: string
  description?: string
  isDefault?: boolean
  reasoning?: {
    kind: 'effort' | 'variant'
    options: { value: string; label: string; description?: string }[]
    default?: string
  }
}
export interface ProviderInfo {
  id: ProviderId
  name: string
  available: boolean
  path?: string
  version?: string
  error?: string
  models: Model[]
  readiness?: {
    installation: 'ready' | 'unknown' | 'error'
    version: 'ready' | 'unknown' | 'error'
    authentication: 'ready' | 'unknown' | 'error'
    models: 'ready' | 'unknown' | 'error'
    message?: string
  }
  capabilities?: {
    permissions: boolean
    questions: boolean
    permissionProfiles: boolean
    images: boolean
    nativeResume: boolean
  }
}
export interface Settings {
  theme: 'system' | 'dark' | 'light'
  cliPaths: Partial<Record<ProviderId, string>>
  lastProjectId?: string
  lastSessionId?: string
  fontSize?: number
  tabSize?: number
  sendKey?: 'enter' | 'mod-enter'
  notifications?: boolean
  sidebarWidth?: number
  workspaceWidth?: number
  terminalHeight?: number
  newSessionDefaults?: Record<
    string,
    { provider: ProviderId; model?: string; reasoningOption?: string }
  >
}
export interface ContextItem {
  id: string
  kind: 'file' | 'selection' | 'terminal' | 'diff' | 'image'
  name: string
  content?: string
  path?: string
  startLine?: number
  endLine?: number
  mimeType?: string
  dataUrl?: string
}
export interface TurnInput {
  text: string
  context: ContextItem[]
}
export interface ComposerDraft extends TurnInput {
  updatedAt: number
}
export interface NewSessionDraft extends ComposerDraft {
  id: string
  provider: ProviderId
  model?: string
  reasoningOption?: string
  workspace: { kind: 'shared' } | { kind: 'isolated' } | { kind: 'existing'; id: string }
}
export interface EditorState {
  files: (FileContent & { edited: string; external?: FileContent; viewState?: unknown })[]
  active: string
  mode: 'files' | 'git'
  updatedAt: number
}
export interface BackupInfo {
  id: string
  createdAt: number
  bytes: number
  schemaVersion: number
  reason: 'manual' | 'daily' | 'migration' | 'before-restore'
}
export interface StorageInfo {
  databaseBytes: number
  backupBytes: number
  backups: number
  projects: number
  sessions: number
  events: number
  schemaVersion: number
}
export interface SessionSearchResult extends Session {
  snippet?: string
  matchEventId?: string
}
export interface AppHealth {
  storage: 'ready' | 'error'
  runtime: 'ready' | 'starting' | 'error'
  message?: string
  code?: string
}
export interface FileSearchResult {
  path: string
  line?: number
  text?: string
}
export type GitAction =
  'stage' | 'unstage' | 'commit' | 'checkout' | 'createBranch' | 'fetch' | 'pull' | 'push'
export interface GitCommit {
  hash: string
  shortHash: string
  subject: string
  author: string
  timestamp: number
}
export interface WorkspaceIdentity {
  rootPath: string
  canonicalId: string
  repositoryId?: string
  gitDir?: string
  repositoryRoot?: string
  branch?: string
  hasHead: boolean
}
export interface WorkspaceComparison {
  base: string
  files: {
    path: string
    status: string
    baseFingerprint: string | null
    targetFingerprint: string | null
    sourceFingerprint: string | null
  }[]
  conflicts: { path: string; reason: string }[]
}
export interface ReviewFile {
  path: string
  before: string | null
  after: string | null
  beforeFingerprint: string
  afterFingerprint: string
  reviewable: boolean
}
export interface TurnReview {
  turnId: string
  sessionId: string
  workspaceId: string
  startedAt: number
  finishedAt?: number
  files: ReviewFile[]
  warnings: string[]
}
export interface TaskDefinition {
  id: string
  name: string
  command: string
  args: string[]
}
export interface TaskRun {
  id: string
  workspaceId: string
  sessionId?: string
  turnId?: string
  name: string
  command: string
  args: string[]
  status: 'running' | 'passed' | 'failed' | 'cancelled'
  startedAt: number
  finishedAt?: number
  exitCode?: number
  output: string
}
export interface UpdateState {
  status:
    'unconfigured' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'
  currentVersion: string
  version?: string
  progress?: number
  releaseNotes?: string
  message?: string
}
export interface PromptQuestion {
  id: string
  title: string
  options?: { label: string; description?: string }[]
  multiple?: boolean
}
export type AgentEventKind =
  | 'user'
  | 'text'
  | 'tool'
  | 'approval'
  | 'question'
  | 'usage'
  | 'error'
  | 'done'
  | 'status'
  | 'session'
  | 'requestResolved'
export interface AgentEvent {
  id: string
  sessionId: string
  turnId: string
  kind: AgentEventKind
  timestamp: number
  sequence?: number
  itemId?: string
  text?: string
  delta?: boolean
  name?: string
  input?: unknown
  output?: string
  outputDelta?: boolean
  outputRef?: string
  outputBytes?: number
  outputTruncated?: boolean
  persistedId?: string
  state?: 'running' | 'completed' | 'error'
  requestId?: string
  questions?: PromptQuestion[]
  decisions?: string[]
  nativeId?: string
  status?: SessionStatus
  tokens?: number
  cost?: number
  context?: ContextItem[]
  decision?: string
  scope?: 'once' | 'session' | 'turn'
  resolution?: 'approved' | 'denied' | 'cancelled' | 'expired' | 'external' | 'failed'
  answers?: Record<string, string[]>
}
export interface SessionPage {
  before?: number
  after?: number
  aroundEventId?: string
  limit?: number
}
export interface SessionView {
  session: Session
  events: AgentEvent[]
  cursor: number
  before?: number
  hasMore?: boolean
  after?: number
  hasNewer?: boolean
  anchorFound?: boolean
}
export interface Bootstrap {
  projects: Project[]
  sessions: Session[]
  settings: Settings
  version: string
  platform: string
  workspaces: Workspace[]
  health: AppHealth
  removedProjects?: Project[]
  dataGeneration: string
}
export interface FileEntry {
  name: string
  path: string
  directory: boolean
}
export interface FileContent {
  path: string
  content: string
  fingerprint: string
  language: string
}
export interface GitFile {
  path: string
  index: string
  working: string
}
export interface GitStatus {
  branch: string
  files: GitFile[]
  branches: string[]
  isRepo: boolean
  remote?: string
  upstream?: string
  ahead?: number
  behind?: number
  conflicts?: string[]
  indexFingerprint?: string
}
export interface GitDiff {
  path: string
  original: string
  modified: string
  staged: boolean
  previewUnavailable?: 'binary' | 'large'
}
export interface TerminalOutput {
  id: string
  sequence?: number
  data?: string
  exitCode?: number
}
export interface TerminalDescriptor {
  id: string
  workspaceId?: string
  cwd: string
  title: string
  cols: number
  rows: number
  createdAt: number
  exitCode?: number
  buffer?: string
  sequence?: number
}
export interface AppAPI {
  onPrepareClose(callback: () => Promise<void>): () => void
  onCloseCancelled(callback: () => void): () => void
  bootstrap(): Promise<Bootstrap>
  addProject(): Promise<Project | null>
  removeProject(id: string): Promise<void>
  trustProject(id: string, trusted: boolean): Promise<Project>
  restoreProject(id: string): Promise<Project>
  relocateProject(id: string): Promise<Project | null>
  createProject(input: { name: string; cloneUrl?: string }): Promise<Project | null>
  listWorkspaces(projectId: string): Promise<Workspace[]>
  inspectWorkspace(id: string): Promise<WorkspaceIdentity>
  createWorkspace(projectId: string, base?: string): Promise<Workspace>
  removeWorkspace(id: string): Promise<void>
  compareWorkspace(id: string): Promise<WorkspaceComparison>
  applyWorkspace(
    id: string,
  ): Promise<{ conflicts: { path: string; reason: string }[]; applied: string[] }>
  createSession(input: {
    projectId: string
    provider: ProviderId
    model?: string
    reasoningOption?: string
    workspaceId?: string
    isolated?: boolean
    base?: string
  }): Promise<Session>
  getNewSessionDraft(projectId: string): Promise<NewSessionDraft>
  saveNewSessionDraft(projectId: string, draft: NewSessionDraft): Promise<void>
  createSessionFromDraft(projectId: string, draftId: string): Promise<Session>
  getSession(id: string, page?: SessionPage): Promise<SessionView>
  searchSessions(query: string): Promise<SessionSearchResult[]>
  updateSession(
    id: string,
    patch: {
      title?: string
      archived?: boolean
      model?: string
      reasoningOption?: string | null
      pinned?: boolean
      deletedAt?: number | null
      readAt?: number
    },
  ): Promise<Session>
  sendMessage(
    id: string,
    input: string | TurnInput,
    options?: { firstMessage?: boolean; draftUpdatedAt?: number },
  ): Promise<void>
  getDraft(sessionId: string): Promise<ComposerDraft>
  saveDraft(sessionId: string, draft: ComposerDraft): Promise<void>
  getEditorState(workspaceId: string): Promise<EditorState | null>
  saveEditorState(workspaceId: string, state: EditorState): Promise<void>
  addImages(): Promise<ContextItem[]>
  exportSession(id: string, format: 'markdown' | 'json'): Promise<boolean>
  interrupt(id: string): Promise<void>
  respond(
    id: string,
    requestId: string,
    response: {
      decision?: string
      answers?: Record<string, string[]>
      permissions?: Record<string, unknown>
      scope?: 'turn' | 'session'
    },
  ): Promise<void>
  providers(projectId?: string): Promise<ProviderInfo[]>
  getSettings(): Promise<Settings>
  saveSettings(settings: Settings): Promise<Settings>
  listFiles(projectId: string, path?: string): Promise<FileEntry[]>
  searchFiles(workspaceId: string, query: string, content?: boolean): Promise<FileSearchResult[]>
  createFile(workspaceId: string, path: string, content?: string): Promise<FileContent>
  renameFile(workspaceId: string, path: string, to: string): Promise<FileContent>
  deleteFile(workspaceId: string, path: string, fingerprint: string): Promise<void>
  openInEditor(workspaceId: string, path?: string): Promise<void>
  readFile(projectId: string, path: string): Promise<FileContent>
  saveFile(
    projectId: string,
    path: string,
    content: string,
    fingerprint: string,
    overwrite?: boolean,
  ): Promise<FileContent>
  gitStatus(projectId: string): Promise<GitStatus>
  gitDiff(projectId: string, path: string, staged?: boolean): Promise<GitDiff>
  gitAction(
    projectId: string,
    action: GitAction,
    value: string,
    expectedIndexFingerprint?: string,
  ): Promise<void>
  gitHistory(workspaceId: string): Promise<GitCommit[]>
  getReview(sessionId: string, turnId: string): Promise<TurnReview | null>
  getEventOutput(
    sessionId: string,
    eventId: string,
    page?: { offset?: number; limit?: number },
  ): Promise<{ text: string; total: number; hasMore: boolean; nextOffset: number }>
  revertReview(sessionId: string, turnId: string, paths: string[]): Promise<void>
  taskDefinitions(workspaceId: string): Promise<TaskDefinition[]>
  runTask(workspaceId: string, definition: TaskDefinition, sessionId?: string): Promise<TaskRun>
  cancelTask(id: string): Promise<void>
  listTasks(workspaceId?: string): Promise<TaskRun[]>
  terminalCreate(projectId: string, cols: number, rows: number): Promise<string>
  terminalWrite(id: string, data: string): Promise<void>
  terminalResize(id: string, cols: number, rows: number): Promise<void>
  terminalClose(id: string): Promise<void>
  terminalAck(id: string, bytes: number): Promise<void>
  terminalList(workspaceId?: string): Promise<TerminalDescriptor[]>
  terminalAttach(id: string): Promise<TerminalDescriptor>
  listBackups(): Promise<BackupInfo[]>
  createBackup(): Promise<BackupInfo>
  restoreBackup(id: string): Promise<void>
  storageInfo(): Promise<StorageInfo>
  revealData(): Promise<void>
  exportDiagnostics(): Promise<boolean>
  health(): Promise<AppHealth>
  retryStorage(): Promise<AppHealth>
  updateState(): Promise<UpdateState>
  checkUpdates(): Promise<UpdateState>
  downloadUpdate(): Promise<void>
  installUpdate(): Promise<void>
  openExternal(url: string): Promise<void>
  revealProject(projectId: string): Promise<void>
  windowAction(action: 'minimize' | 'maximize' | 'close'): Promise<void>
  onEvent(callback: (event: AgentEvent) => void): () => void
  onTerminal(callback: (output: TerminalOutput) => void): () => void
  onSessionsChanged(callback: () => void): () => void
  onHealth(callback: (health: AppHealth) => void): () => void
  onTask(callback: (task: TaskRun) => void): () => void
  onUpdate(callback: (state: UpdateState) => void): () => void
  onFocusSession(callback: (sessionId: string) => void): () => void
}
export const PROVIDERS: Record<ProviderId, { name: string; color: string; command: string }> = {
  claude: { name: 'Claude Code', color: 'var(--secondary)', command: 'claude' },
  codex: { name: 'Codex', color: 'var(--secondary)', command: 'codex' },
  opencode: { name: 'OpenCode', color: 'var(--secondary)', command: 'opencode' },
}
