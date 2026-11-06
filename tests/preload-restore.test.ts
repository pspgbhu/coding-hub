import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppAPI } from '../src/shared/types'

const fixture = vi.hoisted(() => ({
  api: undefined as unknown as AppAPI,
  invoke: vi.fn(),
  reload: vi.fn(),
}))
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, value: AppAPI) => {
      fixture.api = value
    },
  },
  ipcRenderer: { invoke: fixture.invoke, on: vi.fn(), removeListener: vi.fn() },
}))
import '../src/preload/index'

beforeEach(() => {
  fixture.invoke.mockReset()
  fixture.reload.mockReset()
  vi.stubGlobal('window', { location: { reload: fixture.reload } })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fixed backup restore preload refresh', () => {
  it('guards new-session persistence, handoff and both send signatures with the bootstrap generation', async () => {
    fixture.invoke.mockResolvedValueOnce({ dataGeneration: 'fixture-generation' })
    await fixture.api.bootstrap()
    fixture.invoke.mockResolvedValue(undefined)
    await fixture.api.getNewSessionDraft('project')
    expect(fixture.invoke).toHaveBeenLastCalledWith('hub:getNewSessionDraft', 'project')
    const draft = {
      id: 'draft',
      text: 'task',
      context: [],
      updatedAt: 1,
      provider: 'codex' as const,
      workspace: { kind: 'shared' as const },
    }
    await fixture.api.saveNewSessionDraft('project', draft)
    expect(fixture.invoke).toHaveBeenLastCalledWith(
      'hub:saveNewSessionDraft',
      'project',
      draft,
      'fixture-generation',
    )
    await fixture.api.createSessionFromDraft('project', 'draft')
    expect(fixture.invoke).toHaveBeenLastCalledWith(
      'hub:createSessionFromDraft',
      'project',
      'draft',
      'fixture-generation',
    )
    await fixture.api.sendMessage('session', 'ordinary task')
    expect(fixture.invoke).toHaveBeenLastCalledWith(
      'hub:sendMessage',
      'session',
      'ordinary task',
      undefined,
      'fixture-generation',
    )
    const options = { firstMessage: true, draftUpdatedAt: 1 }
    await fixture.api.sendMessage('session', { text: 'task', context: [] }, options)
    expect(fixture.invoke).toHaveBeenLastCalledWith(
      'hub:sendMessage',
      'session',
      { text: 'task', context: [] },
      options,
      'fixture-generation',
    )
  })

  it('reloads once after a successful restore to renew the generation and all renderer caches', async () => {
    fixture.invoke.mockResolvedValue(undefined)
    await expect(fixture.api.restoreBackup('selected-backup')).resolves.toBeUndefined()
    expect(fixture.invoke).toHaveBeenCalledExactlyOnceWith('hub:restoreBackup', 'selected-backup')
    expect(fixture.reload).toHaveBeenCalledOnce()
  })

  it('preserves the current page and rejects ordinary preflight or unapplied failures', async () => {
    const failure = new Error('[WORKSPACE_BUSY] An existing task must finish before restoring.')
    fixture.invoke.mockRejectedValue(failure)
    await expect(fixture.api.restoreBackup('selected-backup')).rejects.toBe(failure)
    expect(fixture.reload).not.toHaveBeenCalled()
  })

  it('reloads an already-applied restore failure while continuing to reject the original IPC failure', async () => {
    const failure = new Error(
      "Error invoking remote method 'hub:restoreBackup': Error: [DATA_RESTORE_APPLIED] Restored data needs a storage retry.",
    )
    fixture.invoke.mockRejectedValue(failure)
    await expect(fixture.api.restoreBackup('selected-backup')).rejects.toBe(failure)
    expect(fixture.reload).toHaveBeenCalledOnce()
  })

  it('does not turn an unrelated typed method failure into a page refresh', async () => {
    fixture.invoke.mockRejectedValue(new Error('[DATA_RESTORE_APPLIED] unrelated failure'))
    await expect(fixture.api.openExternal('https://example.test')).rejects.toThrow(
      'unrelated failure',
    )
    expect(fixture.reload).not.toHaveBeenCalled()
  })
})
