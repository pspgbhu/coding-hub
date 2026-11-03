import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '../shared/types'
import { redactDiagnostics } from '../shared/diagnostics'

/** The signed release profile supplies app-update.yml. Internal builds never fetch updates. */
export class UpdateService {
  private state: UpdateState
  constructor(
    private readonly emit: (state: UpdateState) => void,
    private readonly canRestart: () => Promise<void>,
  ) {
    let release = false
    try {
      release =
        JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')).releaseChannel ===
        'stable'
    } catch {
      /* Internal/source builds have no signed update profile. */
    }
    const configured =
      app.isPackaged && release && existsSync(join(process.resourcesPath, 'app-update.yml'))
    this.state = {
      status: configured ? 'idle' : 'unconfigured',
      currentVersion: app.getVersion(),
      message: configured ? undefined : '内部测试构建尚未配置签名更新源。',
    }
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.allowDowngrade = false
    autoUpdater.on('checking-for-update', () =>
      this.change({ status: 'checking', message: undefined }),
    )
    autoUpdater.on('update-available', (info) =>
      this.change({
        status: 'available',
        version: info.version,
        releaseNotes:
          typeof info.releaseNotes === 'string'
            ? info.releaseNotes
            : info.releaseNotes?.map((n) => n.note ?? '').join('\n'),
      }),
    )
    autoUpdater.on('update-not-available', () =>
      this.change({ status: 'idle', message: '当前已是最新版本。' }),
    )
    autoUpdater.on('download-progress', (progress) =>
      this.change({ status: 'downloading', progress: progress.percent }),
    )
    autoUpdater.on('update-downloaded', () => this.change({ status: 'downloaded', progress: 100 }))
    autoUpdater.on('error', (error) =>
      this.change({ status: 'error', message: redactDiagnostics(error.message) }),
    )
  }
  private change(patch: Partial<UpdateState>): void {
    Object.assign(this.state, patch)
    this.emit(this.get())
  }
  get(): UpdateState {
    return { ...this.state }
  }
  async check(): Promise<UpdateState> {
    if (this.state.status === 'unconfigured') return this.get()
    if (['checking', 'downloading', 'downloaded'].includes(this.state.status)) return this.get()
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      this.change({ status: 'error', message: redactDiagnostics(String(error)) })
    }
    return this.get()
  }
  async download(): Promise<void> {
    if (this.state.status !== 'available') throw new Error('请先检查并选择可用的新版本。')
    try {
      await autoUpdater.downloadUpdate()
    } catch (error) {
      this.change({ status: 'error', message: redactDiagnostics(String(error)) })
      throw new Error(this.state.message)
    }
  }
  async install(): Promise<void> {
    if (this.state.status !== 'downloaded') throw new Error('更新尚未下载完成。')
    await this.canRestart()
    autoUpdater.quitAndInstall(false, true)
  }
}
