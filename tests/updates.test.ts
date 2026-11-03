import { beforeEach, describe, expect, it, vi } from 'vitest'
import { autoUpdater } from 'electron-updater'
import { UpdateService } from '../src/main/updates'
import type { UpdateState } from '../src/shared/types'

const fixture = vi.hoisted(() => ({
  packaged: true,
  releaseChannel: 'stable',
  configured: true,
  invalidMetadata: false,
  listeners: new Map<string, (value?: any) => void>(),
  check: vi.fn(),
  download: vi.fn(),
  install: vi.fn(),
}))
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return fixture.packaged
    },
    getAppPath: () => '/fixture/app',
    getVersion: () => '0.1.1',
  },
}))
vi.mock('node:fs', () => ({
  existsSync: () => fixture.configured,
  readFileSync: () =>
    fixture.invalidMetadata
      ? '{invalid'
      : JSON.stringify({ releaseChannel: fixture.releaseChannel }),
}))
vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowDowngrade: true,
    on: (event: string, callback: (value?: any) => void) => {
      fixture.listeners.set(event, callback)
    },
    checkForUpdates: fixture.check,
    downloadUpdate: fixture.download,
    quitAndInstall: fixture.install,
  },
}))

function emit(event: string, value?: unknown) {
  fixture.listeners.get(event)?.(value)
}
function setup(canRestart: () => Promise<void> = async () => {}) {
  const updates: UpdateState[] = []
  return { service: new UpdateService((state) => updates.push(state), canRestart), updates }
}
beforeEach(() => {
  fixture.packaged = true
  fixture.releaseChannel = 'stable'
  fixture.configured = true
  fixture.invalidMetadata = false
  fixture.listeners.clear()
  fixture.check.mockReset().mockResolvedValue(undefined)
  fixture.download.mockReset().mockResolvedValue(undefined)
  fixture.install.mockReset()
})

describe('signed update lifecycle', () => {
  it.each(['source', 'internal', 'missing-profile', 'invalid-metadata'])(
    'never contacts an update service for %s builds',
    async (kind) => {
      fixture.packaged = kind !== 'source'
      fixture.releaseChannel = kind === 'internal' ? 'internal' : 'stable'
      fixture.configured = kind !== 'missing-profile'
      fixture.invalidMetadata = kind === 'invalid-metadata'
      const { service } = setup()
      expect(autoUpdater.autoDownload).toBe(false)
      expect(autoUpdater.autoInstallOnAppQuit).toBe(false)
      expect(autoUpdater.allowDowngrade).toBe(false)
      expect(service.get()).toMatchObject({ status: 'unconfigured', currentVersion: '0.1.1' })
      expect((await service.check()).status).toBe('unconfigured')
      await expect(service.download()).rejects.toThrow('请先检查')
      await expect(service.install()).rejects.toThrow('尚未下载完成')
      expect(fixture.check).not.toHaveBeenCalled()
      expect(fixture.download).not.toHaveBeenCalled()
      expect(fixture.install).not.toHaveBeenCalled()
    },
  )

  it('reports stable release discovery, notes, download progress and downloaded state without rechecking', async () => {
    const { service, updates } = setup()
    expect(service.get().status).toBe('idle')
    fixture.check.mockImplementation(async () => {
      emit('checking-for-update')
      expect(service.get().status).toBe('checking')
      emit('update-available', {
        version: '0.2.0',
        releaseNotes: [{ note: '修复恢复问题' }, { note: '新功能' }],
      })
    })
    expect(await service.check()).toMatchObject({
      status: 'available',
      version: '0.2.0',
      releaseNotes: '修复恢复问题\n新功能',
    })
    fixture.download.mockImplementation(async () => {
      emit('download-progress', { percent: 42.5 })
      expect(service.get()).toMatchObject({ status: 'downloading', progress: 42.5 })
      await service.check()
      expect(fixture.check).toHaveBeenCalledTimes(1)
      emit('update-downloaded')
    })
    await service.download()
    expect(service.get()).toMatchObject({ status: 'downloaded', version: '0.2.0', progress: 100 })
    expect(await service.check()).toMatchObject({ status: 'downloaded', progress: 100 })
    expect(fixture.check).toHaveBeenCalledTimes(1)
    expect(updates.map((value) => value.status)).toEqual([
      'checking',
      'available',
      'downloading',
      'downloaded',
    ])
    const snapshot = service.get()
    snapshot.status = 'error'
    expect(service.get().status).toBe('downloaded')
  })

  it('handles an up-to-date release and redacts both asynchronous and rejected update errors', async () => {
    const { service, updates } = setup()
    fixture.check.mockImplementationOnce(async () => emit('update-not-available'))
    expect(await service.check()).toMatchObject({ status: 'idle', message: '当前已是最新版本。' })
    const secret = 'abcdefghijklmnopqrstuvwxyz'
    emit('error', new Error(`HTTP 401 Bearer ${secret} password=private-password`))
    expect(service.get().message).toContain('HTTP 401')
    expect(service.get().message).not.toContain(secret)
    expect(service.get().message).not.toContain('private-password')
    fixture.check.mockRejectedValueOnce(
      new Error('HTTP 403 https://user:private-pass@example.invalid/update'),
    )
    expect(await service.check()).toMatchObject({ status: 'error' })
    expect(service.get().message).not.toContain('private-pass')
    emit('update-available', { version: '0.2.0', releaseNotes: 'Release notes' })
    fixture.download.mockRejectedValueOnce(new Error(`HTTP 502 Bearer ${secret}`))
    await expect(service.download()).rejects.toThrow('HTTP 502')
    expect(service.get().status).toBe('error')
    expect(JSON.stringify(updates)).not.toContain(secret)
    expect(JSON.stringify(updates)).not.toContain('private-pass')
    expect(JSON.stringify(updates)).not.toContain('private-password')
  })

  it.each(['仍有运行中的任务', '仍有未保存的编辑内容'])(
    'blocks installation while %s and retries after the condition is cleared',
    async (reason) => {
      const gate = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error(reason))
        .mockResolvedValue(undefined)
      const { service } = setup(gate)
      await expect(service.install()).rejects.toThrow('尚未下载完成')
      expect(gate).not.toHaveBeenCalled()
      emit('update-available', { version: '0.2.0' })
      emit('update-downloaded')
      await expect(service.install()).rejects.toThrow(reason)
      expect(service.get().status).toBe('downloaded')
      expect(fixture.install).not.toHaveBeenCalled()
      await service.install()
      expect(gate).toHaveBeenCalledTimes(2)
      expect(fixture.install).toHaveBeenCalledExactlyOnceWith(false, true)
    },
  )
})
