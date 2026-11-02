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
] as const
const api: Record<string, unknown> = {}
for (const method of methods)
  api[method] = (...args: unknown[]) => ipcRenderer.invoke(`hub:${method}`, ...args)
for (const [method, channel] of [
  ['onEvent', 'hub:event'],
  ['onTerminal', 'hub:terminal'],
  ['onSessionsChanged', 'hub:sessions'],
] as const) {
  api[method] = (callback: (data: unknown) => void) => {
    const handler = (_event: unknown, data: unknown): void => callback(data)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
}
contextBridge.exposeInMainWorld('hub', api as unknown as AppAPI)
