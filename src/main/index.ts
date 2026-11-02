import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
import { join, basename } from 'node:path'
import { realpath } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Store } from './store'
import { RuntimeClient } from './runtime-client'
import type { AgentEvent, Settings, TerminalOutput } from '../shared/types'

if (process.env.CODING_HUB_USER_DATA) app.setPath('userData', process.env.CODING_HUB_USER_DATA)
const locked = app.requestSingleInstanceLock()
if (!locked) app.quit()
let window: BrowserWindow | undefined
let tray: Tray | undefined
let store: Store
let quitting = false
let finalQuit = false
const runtime = new RuntimeClient()
const terminals = new Map<string, string>()
const projectMutations = new Set<string>()
const idSchema = z.string().uuid()
const textSchema = z.string().min(1).max(100000)
const providerSchema = z.enum(['claude', 'codex', 'opencode'])
const settingsSchema = z.object({
  theme: z.enum(['system', 'dark', 'light']),
  cliPaths: z.object({
    claude: z.string().max(4096).optional(),
    codex: z.string().max(4096).optional(),
    opencode: z.string().max(4096).optional(),
  }),
  lastProjectId: z.string().optional(),
  lastSessionId: z.string().optional(),
})
const broadcast = (channel: string, value?: unknown): void => {
  if (window && !window.isDestroyed()) window.webContents.send(channel, value)
}
const changed = (): void => broadcast('hub:sessions')
function eventReceived(event: AgentEvent): void {
  try {
    store.append(event)
    broadcast('hub:event', event)
    if (['done', 'error', 'status', 'session', 'user'].includes(event.kind)) changed()
  } catch (error) {
    console.error(
      'Unable to persist runtime event:',
      error instanceof Error ? error.message : 'Unknown error',
    )
  }
}
runtime.on('event', eventReceived)
runtime.on('terminal', (output: TerminalOutput) => {
  broadcast('hub:terminal', output)
  if (output.exitCode !== undefined) terminals.delete(output.id)
})
runtime.on('exit', () => {
  if (!store || quitting) return
  for (const session of store.sessions()) {
    if (session.status === 'running' || session.status === 'waiting') {
      store.resolveRequests(session.id)
      const turnId =
        session.activeTurnId ?? store.view(session.id).events.at(-1)?.turnId ?? randomUUID()
      eventReceived({
        id: randomUUID(),
        sessionId: session.id,
        turnId,
        timestamp: Date.now(),
        kind: 'error',
        text: '后台服务意外退出。本轮已中断，可以重新发送消息以恢复原会话。',
      })
      eventReceived({
        id: randomUUID(),
        sessionId: session.id,
        turnId,
        timestamp: Date.now(),
        kind: 'done',
        status: 'interrupted',
      })
    }
  }
  terminals.clear()
  changed()
})
function projectRoot(id: unknown): string {
  return store.project(idSchema.parse(id)).path
}
function assertTerminal(id: unknown): string {
  const parsed = z.string().min(1).max(200).parse(id)
  if (!terminals.has(parsed)) throw new Error('终端已关闭，请重新打开。')
  return parsed
}
function assertNoRunning(projectId: string): void {
  if (
    store
      .sessions()
      .some((s) => s.projectId === projectId && ['running', 'waiting'].includes(s.status))
  )
    throw new Error('请先停止此项目中正在运行的任务。')
}
function assertProjectAvailable(projectId: string): void {
  if (projectMutations.has(projectId)) throw new Error('项目正在执行 Git 或移除操作，请稍后重试。')
}
async function mutateProject<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
  assertProjectAvailable(projectId)
  projectMutations.add(projectId)
  try {
    return await operation()
  } finally {
    projectMutations.delete(projectId)
  }
}
function registerIPC(): void {
  const handlers: Record<string, (...args: any[]) => any> = {
    bootstrap: () => ({
      projects: store.projects(),
      sessions: store.sessions(),
      settings: store.settings(),
      version: app.getVersion(),
      platform: process.platform,
    }),
    addProject: async () => {
      const result = await dialog.showOpenDialog(window!, {
        title: '打开项目',
        properties: ['openDirectory', 'createDirectory'],
      })
      if (result.canceled || !result.filePaths[0]) return null
      const path = await realpath(result.filePaths[0])
      const project = store.addProject(path, basename(path))
      store.saveSettings({ ...store.settings(), lastProjectId: project.id })
      changed()
      return project
    },
    removeProject: async (id: string) => {
      idSchema.parse(id)
      assertNoRunning(id)
      await mutateProject(id, async () => {
        for (const [terminalId, owner] of terminals)
          if (owner === id) {
            await runtime.call('terminal.close', terminalId)
            terminals.delete(terminalId)
          }
        store.removeProject(id)
        changed()
      })
    },
    createSession: (input: unknown) => {
      const parsed = z
        .object({
          projectId: idSchema,
          provider: providerSchema,
          model: z.string().max(300).optional(),
        })
        .parse(input)
      assertProjectAvailable(parsed.projectId)
      const session = store.createSession(parsed.projectId, parsed.provider, parsed.model)
      store.saveSettings({
        ...store.settings(),
        lastProjectId: parsed.projectId,
        lastSessionId: session.id,
      })
      changed()
      return session
    },
    getSession: (id: unknown) => store.view(idSchema.parse(id)),
    searchSessions: (query: unknown) => store.searchSessions(z.string().max(300).parse(query)),
    updateSession: (id: unknown, patch: unknown) => {
      const parsed = z
        .object({
          title: z.string().trim().min(1).max(200).optional(),
          archived: z.boolean().optional(),
          model: z.string().max(300).optional(),
        })
        .parse(patch)
      const sessionId = idSchema.parse(id)
      const session = store.session(sessionId)
      if (
        ['running', 'waiting'].includes(session.status) &&
        (parsed.archived || parsed.model !== undefined)
      )
        throw new Error('请先停止任务再归档或修改模型。')
      const updated = store.patchSession(sessionId, parsed)
      changed()
      return updated
    },
    sendMessage: async (id: unknown, text: unknown) => {
      const session = store.session(idSchema.parse(id))
      assertProjectAvailable(session.projectId)
      const content = textSchema.parse(text).trim()
      if (!content) throw new Error('请输入消息。')
      if (['running', 'waiting'].includes(session.status))
        throw new Error('当前会话正在执行任务，请等待完成或先停止。')
      const project = store.project(session.projectId)
      const turnId = randomUUID()
      store.patchSession(session.id, { status: 'running' })
      eventReceived({
        id: randomUUID(),
        sessionId: session.id,
        turnId,
        kind: 'user',
        text: content,
        timestamp: Date.now(),
      })
      changed()
      try {
        await runtime.call(
          'agent.send',
          { session, cwd: project.path, cliPath: store.settings().cliPaths[session.provider] },
          content,
          turnId,
        )
      } catch (error) {
        eventReceived({
          id: randomUUID(),
          sessionId: session.id,
          turnId,
          kind: 'error',
          text: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        })
        throw error
      }
    },
    interrupt: async (id: unknown) => {
      const sessionId = idSchema.parse(id)
      const turnId = store.session(sessionId).activeTurnId
      await runtime.call('agent.interrupt', sessionId)
      if (store.session(sessionId).activeTurnId === turnId) {
        store.resolveRequests(sessionId, undefined, turnId)
        if (['running', 'waiting'].includes(store.session(sessionId).status))
          store.patchSession(sessionId, { status: 'interrupted' })
      }
      changed()
    },
    respond: async (id: unknown, requestId: unknown, response: unknown) => {
      const sessionId = idSchema.parse(id)
      const req = z.string().min(1).max(1000).parse(requestId)
      const answer = z
        .object({
          decision: z.string().max(100).optional(),
          answers: z.record(z.string(), z.array(z.string().max(10000))).optional(),
        })
        .parse(response)
      if (
        !store
          .view(sessionId)
          .events.some(
            (e) =>
              e.requestId === req &&
              ['approval', 'question'].includes(e.kind) &&
              e.state !== 'completed',
          )
      )
        throw new Error('此请求已过期。')
      await runtime.call('agent.respond', sessionId, req, answer)
      store.resolveRequests(sessionId, req)
      if (
        store.session(sessionId).status === 'waiting' &&
        !store
          .view(sessionId)
          .events.some(
            (event) => ['approval', 'question'].includes(event.kind) && event.state !== 'completed',
          )
      )
        store.patchSession(sessionId, { status: 'running' })
      changed()
    },
    providers: (projectId?: string) =>
      runtime.call('agent.probe', store.settings(), projectId ? projectRoot(projectId) : undefined),
    getSettings: () => store.settings(),
    saveSettings: (input: unknown) => store.saveSettings(settingsSchema.parse(input) as Settings),
    listFiles: (projectId: unknown, path = '') =>
      runtime.call('workspace.listFiles', projectRoot(projectId), z.string().max(4096).parse(path)),
    readFile: (projectId: unknown, path: unknown) =>
      runtime.call(
        'workspace.readFile',
        projectRoot(projectId),
        z.string().min(1).max(4096).parse(path),
      ),
    saveFile: (
      projectId: unknown,
      path: unknown,
      content: unknown,
      fingerprint: unknown,
      overwrite = false,
    ) =>
      runtime.call(
        'workspace.saveFile',
        projectRoot(projectId),
        z.string().min(1).max(4096).parse(path),
        z
          .string()
          .max(4 * 1024 * 1024)
          .parse(content),
        z.string().max(100).parse(fingerprint),
        z.boolean().parse(overwrite),
      ),
    gitStatus: (projectId: unknown) => runtime.call('workspace.gitStatus', projectRoot(projectId)),
    gitDiff: (projectId: unknown, path: unknown, staged = false) =>
      runtime.call(
        'workspace.gitDiff',
        projectRoot(projectId),
        z.string().min(1).max(4096).parse(path),
        z.boolean().parse(staged),
      ),
    gitAction: (projectId: unknown, action: unknown, value: unknown) => {
      const id = idSchema.parse(projectId)
      const operation = z.enum(['stage', 'unstage', 'commit', 'checkout']).parse(action)
      if (operation === 'commit' || operation === 'checkout') assertNoRunning(id)
      const argument = z.string().min(1).max(10000).parse(value)
      return mutateProject(id, () =>
        runtime.call('workspace.gitAction', projectRoot(id), operation, argument),
      )
    },
    terminalCreate: async (projectId: unknown, cols: unknown, rows: unknown) => {
      const id = idSchema.parse(projectId)
      const terminalId: string = await runtime.call(
        'terminal.create',
        projectRoot(id),
        z.number().int().min(10).max(500).parse(cols),
        z.number().int().min(2).max(300).parse(rows),
      )
      terminals.set(terminalId, id)
      return terminalId
    },
    terminalWrite: (id: unknown, data: unknown) =>
      runtime.call('terminal.write', assertTerminal(id), z.string().max(1000000).parse(data)),
    terminalResize: (id: unknown, cols: unknown, rows: unknown) =>
      runtime.call(
        'terminal.resize',
        assertTerminal(id),
        z.number().int().min(1).max(500).parse(cols),
        z.number().int().min(1).max(300).parse(rows),
      ),
    terminalAck: (id: unknown, bytes: unknown) =>
      terminals.has(String(id))
        ? runtime.call(
            'terminal.ack',
            assertTerminal(id),
            z.number().int().min(0).max(1000000).parse(bytes),
          )
        : undefined,
    terminalClose: async (id: unknown) => {
      const terminalId = assertTerminal(id)
      await runtime.call('terminal.close', terminalId)
      terminals.delete(terminalId)
    },
    openExternal: async (url: unknown) => {
      const parsed = new URL(z.string().max(10000).parse(url))
      if (!['http:', 'https:'].includes(parsed.protocol))
        throw new Error('仅支持打开 HTTP/HTTPS 链接。')
      await shell.openExternal(parsed.toString())
    },
    revealProject: async (id: unknown) => {
      const error = await shell.openPath(projectRoot(id))
      if (error) throw new Error(error)
    },
    windowAction: (action: unknown) => {
      if (!window) return
      const parsed = z.enum(['minimize', 'maximize', 'close']).parse(action)
      if (parsed === 'minimize') window.minimize()
      else if (parsed === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize()
      else window.close()
    },
  }
  for (const [name, handler] of Object.entries(handlers))
    ipcMain.handle(`hub:${name}`, (event, ...args) => {
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error('拒绝来自未知页面的调用。')
      return handler(...args)
    })
}
function createWindow(): void {
  if (window && !window.isDestroyed()) {
    window.show()
    window.focus()
    return
  }
  window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 650,
    show: false,
    title: 'Coding Hub',
    backgroundColor: '#151719',
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 18 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  window.once('ready-to-show', () => window?.show())
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      window?.hide()
    }
  })
  window.on('closed', () => {
    window = undefined
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window?.webContents.getURL()) event.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
}
function setupTray(): void {
  const icon = nativeImage.createFromPath(join(app.getAppPath(), 'build/tray.png'))
  tray = new Tray(
    icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 18, height: 18 }),
  )
  tray.setToolTip('Coding Hub · 编程工作台')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 Coding Hub', click: createWindow },
      { type: 'separator' },
      { label: '退出 Coding Hub', click: () => app.quit() },
    ]),
  )
  tray.on('click', createWindow)
}
if (locked)
  void app.whenReady().then(() => {
    app.setAppUserModelId('dev.codinghub.desktop')
    store = new Store(join(app.getPath('userData'), 'coding-hub.db'))
    registerIPC()
    createWindow()
    setupTray()
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === 'darwin'
          ? [
              {
                label: 'Coding Hub',
                submenu: [
                  { role: 'about' as const },
                  { type: 'separator' as const },
                  { role: 'hide' as const },
                  { role: 'hideOthers' as const },
                  { role: 'unhide' as const },
                  { type: 'separator' as const },
                  { role: 'quit' as const },
                ],
              },
            ]
          : []),
        {
          label: '编辑',
          submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'selectAll' },
          ],
        },
        {
          label: '显示',
          submenu: [
            { role: 'reload' },
            { role: 'toggleDevTools' },
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            { role: 'zoomOut' },
            { role: 'togglefullscreen' },
          ],
        },
        {
          label: '窗口',
          submenu: [{ role: 'minimize' }, { label: '显示主窗口', click: createWindow }],
        },
      ]),
    )
    void runtime.start().catch((error) => console.error('Runtime startup:', error.message))
  })
app.on('second-instance', createWindow)
app.on('activate', createWindow)
app.on('window-all-closed', () => {})
app.on('before-quit', (event) => {
  if (finalQuit) return
  event.preventDefault()
  if (quitting) return
  quitting = true
  void runtime.close().finally(() => {
    store?.close()
    tray?.destroy()
    finalQuit = true
    app.quit()
  })
})
