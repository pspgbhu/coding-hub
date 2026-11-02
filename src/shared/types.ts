export type ProviderId = 'claude' | 'codex' | 'opencode'
export type SessionStatus = 'idle' | 'running' | 'waiting' | 'error' | 'interrupted'
export interface Project {
  id: string
  name: string
  path: string
  createdAt: number
}
export interface Session {
  id: string
  projectId: string
  provider: ProviderId
  title: string
  model?: string
  nativeId?: string
  activeTurnId?: string
  status: SessionStatus
  archived: boolean
  createdAt: number
  updatedAt: number
}
export interface Model {
  id: string
  name: string
}
export interface ProviderInfo {
  id: ProviderId
  name: string
  available: boolean
  path?: string
  version?: string
  error?: string
  models: Model[]
}
export interface Settings {
  theme: 'system' | 'dark' | 'light'
  cliPaths: Partial<Record<ProviderId, string>>
  lastProjectId?: string
  lastSessionId?: string
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
  state?: 'running' | 'completed' | 'error'
  requestId?: string
  questions?: PromptQuestion[]
  decisions?: string[]
  nativeId?: string
  status?: SessionStatus
  tokens?: number
  cost?: number
}
export interface SessionView {
  session: Session
  events: AgentEvent[]
  cursor: number
}
export interface Bootstrap {
  projects: Project[]
  sessions: Session[]
  settings: Settings
  version: string
  platform: string
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
}
export interface GitDiff {
  path: string
  original: string
  modified: string
  staged: boolean
}
export interface TerminalOutput {
  id: string
  data?: string
  exitCode?: number
}
export interface AppAPI {
  bootstrap(): Promise<Bootstrap>
  addProject(): Promise<Project | null>
  removeProject(id: string): Promise<void>
  createSession(input: {
    projectId: string
    provider: ProviderId
    model?: string
  }): Promise<Session>
  getSession(id: string): Promise<SessionView>
  searchSessions(query: string): Promise<Session[]>
  updateSession(
    id: string,
    patch: { title?: string; archived?: boolean; model?: string },
  ): Promise<Session>
  sendMessage(id: string, text: string): Promise<void>
  interrupt(id: string): Promise<void>
  respond(
    id: string,
    requestId: string,
    response: { decision?: string; answers?: Record<string, string[]> },
  ): Promise<void>
  providers(projectId?: string): Promise<ProviderInfo[]>
  getSettings(): Promise<Settings>
  saveSettings(settings: Settings): Promise<Settings>
  listFiles(projectId: string, path?: string): Promise<FileEntry[]>
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
    action: 'stage' | 'unstage' | 'commit' | 'checkout',
    value: string,
  ): Promise<void>
  terminalCreate(projectId: string, cols: number, rows: number): Promise<string>
  terminalWrite(id: string, data: string): Promise<void>
  terminalResize(id: string, cols: number, rows: number): Promise<void>
  terminalClose(id: string): Promise<void>
  terminalAck(id: string, bytes: number): Promise<void>
  openExternal(url: string): Promise<void>
  revealProject(projectId: string): Promise<void>
  windowAction(action: 'minimize' | 'maximize' | 'close'): Promise<void>
  onEvent(callback: (event: AgentEvent) => void): () => void
  onTerminal(callback: (output: TerminalOutput) => void): () => void
  onSessionsChanged(callback: () => void): () => void
}
export const PROVIDERS: Record<ProviderId, { name: string; color: string; command: string }> = {
  claude: { name: 'Claude Code', color: '#d79573', command: 'claude' },
  codex: { name: 'Codex', color: '#8cbfa5', command: 'codex' },
  opencode: { name: 'OpenCode', color: '#a8b5e5', command: 'opencode' },
}
