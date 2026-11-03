import { contextBridge, ipcRenderer } from 'electron'
import type { AppAPI } from '../shared/types'
const methods = [
  'bootstrap',
  'addProject',
  'removeProject',
  'createSession',
  'getSession',
  'searchSessions',
  'updateSession',
  'sendMessage',
  'interrupt',
  'respond',
  'providers',
  'getSettings',
  'saveSettings',
  'listFiles',
  'readFile',
  'saveFile',
  'gitStatus',
  'gitDiff',
  'gitAction',
  'terminalCreate',
  'terminalWrite',
  'terminalResize',
  'terminalClose',
  'terminalAck',
  'openExternal',
  'revealProject',
  'windowAction',
  'trustProject',
  'restoreProject',
  'relocateProject',
  'createProject',
  'listWorkspaces',
  'inspectWorkspace',
  'createWorkspace',
  'removeWorkspace',
  'compareWorkspace',
  'applyWorkspace',
  'getDraft',
  'saveDraft',
  'getEditorState',
  'saveEditorState',
  'addImages',
  'exportSession',
  'searchFiles',
  'createFile',
  'renameFile',
  'deleteFile',
  'openInEditor',
  'gitHistory',
  'getReview',
  'revertReview',
  'taskDefinitions',
  'runTask',
  'cancelTask',
  'listTasks',
  'getEventOutput',
  'terminalList',
  'terminalAttach',
  'listBackups',
  'createBackup',
  'storageInfo',
  'revealData',
  'exportDiagnostics',
  'health',
  'retryStorage',
  'updateState',
  'checkUpdates',
  'downloadUpdate',
  'installUpdate',
] as const
const api: Record<string, unknown> = {}
api.onPrepareClose = (callback: () => Promise<void>) => {
  let alive = true
  const handler = async (_event: unknown, payload: { nonce?: unknown }) => {
    if (!payload || typeof payload.nonce !== 'string' || payload.nonce.length > 200) return
    const nonce = payload.nonce
    try {
      await callback()
      if (alive) ipcRenderer.send('hub:close-ready', { nonce })
    } catch {
      if (alive)
        ipcRenderer.send('hub:close-ready', {
          nonce,
          error: '未能保存所有草稿和编辑器状态，请检查存储状态后重试退出。',
        })
    }
  }
  ipcRenderer.on('hub:prepare-close', handler)
  return () => {
    alive = false
    ipcRenderer.removeListener('hub:prepare-close', handler)
  }
}
let dataGeneration: string | undefined
for (const method of methods)
  api[method] = async (...args: unknown[]) => {
    if (method === 'saveDraft' || method === 'saveEditorState') args.push(dataGeneration)
    const result = await ipcRenderer.invoke(`hub:${method}`, ...args)
    if (method === 'bootstrap' && dataGeneration === undefined)
      dataGeneration = result.dataGeneration
    return result
  }
// Only this fixed operation may replace the data generation and invalidate every page cache.
api.restoreBackup = async (value: unknown) => {
  let result: unknown
  try {
    result = await ipcRenderer.invoke('hub:restoreBackup', value)
  } catch (error) {
    if (error instanceof Error && error.message.includes('[DATA_RESTORE_APPLIED]'))
      window.location.reload()
    throw error
  }
  window.location.reload()
  return result
}
for (const [method, channel] of [
  ['onEvent', 'hub:event'],
  ['onTerminal', 'hub:terminal'],
  ['onSessionsChanged', 'hub:sessions'],
  ['onHealth', 'hub:health'],
  ['onTask', 'hub:task'],
  ['onUpdate', 'hub:update'],
  ['onFocusSession', 'hub:focus-session'],
  ['onCloseCancelled', 'hub:close-cancelled'],
] as const) {
  api[method] = (callback: (data: unknown) => void) => {
    const handler = (_event: unknown, data: unknown): void => callback(data)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
}
contextBridge.exposeInMainWorld('hub', api as unknown as AppAPI)
