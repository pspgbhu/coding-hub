import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { rename } from 'node:fs/promises'
import { Store } from './store'
import { RuntimeClient } from './runtime-client'
import { ApplicationServices } from './application'
import { listDatabaseBackups, verifiedBackupPath, replaceDatabase } from './storage'
import { redactDiagnostics } from '../shared/diagnostics'

if (process.env.CODING_HUB_USER_DATA) app.setPath('userData', process.env.CODING_HUB_USER_DATA)
const locked = app.requestSingleInstanceLock()
if (!locked) app.quit()
let window: BrowserWindow | undefined
let tray: Tray | undefined
let store: Store
let services: ApplicationServices | undefined
let quitting = false
let finalQuit = false
const runtime = new RuntimeClient()
let closeRequest: { nonce: string; resolve: () => void; reject: (error: Error) => void } | undefined
async function prepareRendererClose(): Promise<void> {
  if (!window || window.isDestroyed()) return
  let timeout: NodeJS.Timeout | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      const nonce = randomUUID()
      closeRequest = { nonce, resolve, reject }
      timeout = setTimeout(
        () => reject(new Error('窗口未确认草稿与编辑内容已保存，已取消退出。')),
        15000,
      )
      window!.webContents.send('hub:prepare-close', { nonce })
    })
  } finally {
    if (timeout) clearTimeout(timeout)
    closeRequest = undefined
  }
}

async function openStore(): Promise<Store | undefined> {
  const location = join(app.getPath('userData'), 'coding-hub.db')
  while (true) {
    try {
      return new Store(location, (error) => services?.reportBackupFailure(error))
    } catch (error) {
      const backups = listDatabaseBackups(location)
      const result = await dialog.showMessageBox({
        type: 'error',
        title: '本地数据需要恢复',
        message: '无法打开 Coding Hub 数据',
        detail: redactDiagnostics(String(error)),
        buttons: [...(backups.length ? ['从最近的有效备份恢复'] : []), '打开数据目录', '退出'],
        defaultId: backups.length ? 0 : 1,
        cancelId: backups.length ? 2 : 1,
      })
      if (backups.length && result.response === 0) {
        for (const backup of backups) {
          const moved: { original: string; preserved: string }[] = []
          let replacement: ReturnType<typeof replaceDatabase> | undefined
          try {
            const source = verifiedBackupPath(location, backup.id)
            const suffix = `.damaged-${Date.now()}-${randomUUID()}`
            for (const original of [
              location,
              location + '-wal',
              location + '-shm',
              join(app.getPath('userData'), 'outputs'),
            ]) {
              const preserved = original + suffix
              try {
                await rename(original, preserved)
                moved.push({ original, preserved })
              } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
              }
            }
            replacement = replaceDatabase(location, source)
            const restored = new Store(location, (failure) =>
              services?.reportBackupFailure(failure),
            )
            replacement.commit()
            return restored
          } catch {
            try {
              replacement?.rollback()
              for (const entry of moved.reverse()) await rename(entry.preserved, entry.original)
            } catch (rollbackError) {
              await dialog.showMessageBox({
                type: 'error',
                message: '恢复尚未完成，原资料已保存在 damaged / rollback 文件中。',
                detail: redactDiagnostics(String(rollbackError)),
              })
              return undefined
            }
          }
        }
        await dialog.showMessageBox({
          type: 'error',
          message: '没有可恢复的有效备份。原数据已保留，请打开数据目录检查。',
        })
      } else if (result.response === (backups.length ? 1 : 0)) {
        await shell.openPath(app.getPath('userData'))
        continue
      }
      return undefined
    }
  }
}
function registerIPC(): void {
  ipcMain.on('hub:close-ready', (event, result: unknown) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      !closeRequest
    )
      return
    if (
      !result ||
      typeof result !== 'object' ||
      !('nonce' in result) ||
      result.nonce !== closeRequest.nonce
    )
      return
    if ('error' in result && typeof result.error === 'string')
      closeRequest.reject(new Error(redactDiagnostics(result.error).slice(0, 2000)))
    else closeRequest.resolve()
  })
  for (const [name, handler] of Object.entries(services!.handlers))
    ipcMain.handle(`hub:${name}`, async (event, ...args) => {
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
    backgroundColor: '#171717',
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
  window.webContents.on('render-process-gone', () => {
    if (!quitting) window?.reload()
  })
  window.on('unresponsive', () => {
    void dialog
      .showMessageBox(window!, {
        type: 'warning',
        message: '窗口暂时没有响应',
        detail: '已保存的草稿和后台任务保留。可以继续等待，或重新加载窗口。',
        buttons: ['继续等待', '重新加载'],
        defaultId: 0,
      })
      .then((result) => {
        if (result.response === 1) window?.reload()
      })
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
  const trayIcon = icon.isEmpty()
    ? nativeImage.createEmpty()
    : icon.resize({ width: 18, height: 18 })
  if (process.platform === 'darwin') trayIcon.setTemplateImage(true)
  tray = new Tray(trayIcon)
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
  void app.whenReady().then(async () => {
    app.setAppUserModelId('dev.codinghub.desktop')
    const opened = await openStore()
    if (!opened) {
      finalQuit = true
      app.quit()
      return
    }
    store = opened
    services = new ApplicationServices(runtime, store, () => window)
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
    void services
      .ready()
      .catch((error) => console.error('Runtime startup:', redactDiagnostics(String(error))))
  })
app.on('second-instance', createWindow)
app.on('activate', createWindow)
app.on('window-all-closed', () => {})
app.on('before-quit', (event) => {
  if (finalQuit) return
  event.preventDefault()
  if (quitting) return
  quitting = true
  void Promise.resolve()
    .then(async () => {
      services?.beginClose()
      await prepareRendererClose()
      await (services?.close() ?? runtime.close())
    })
    .then(() => {
      store?.close()
      tray?.destroy()
      finalQuit = true
      app.quit()
    })
    .catch((error) => {
      quitting = false
      services?.cancelClose()
      if (window && !window.isDestroyed()) window.webContents.send('hub:close-cancelled')
      createWindow()
      console.error('Shutdown:', redactDiagnostics(String(error)))
      void dialog.showMessageBox(window!, {
        type: 'error',
        title: '暂时无法退出',
        message: '尚未确认内容保存或后台停止，已取消退出。',
        detail:
          redactDiagnostics(String(error)).slice(0, 2000) +
          '\n请检查保存状态和后台任务后，再次退出。',
      })
    })
})
