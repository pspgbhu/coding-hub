import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect, openTrustedProject, createSession, sendMessage } from './fixtures'
import { ACTIVE_STATUSES } from '../../src/shared/types'

const active = new Set(ACTIVE_STATUSES)

test('native application quit stops the active turn and saves its final file review before closing runtime', async ({
  desktop,
}) => {
  test.setTimeout(90000)
  await openTrustedProject(desktop)
  const session = await createSession(desktop.page, 'codex', 'isolated')
  const workspace = (
    await desktop.page.evaluate((id) => window.hub.listWorkspaces(id), session.projectId)
  ).find((entry) => entry.id === session.workspaceId)!
  expect(workspace.kind).toBe('worktree')

  // This native CLI fixture writes first, then remains busy until the real interrupt RPC arrives.
  await sendMessage(desktop.page, 'write-file long-running-review')
  await expect
    .poll(() => readFile(join(workspace.cwd, 'hello.ts'), 'utf8'))
    .toContain('ISOLATED_CHANGE')
  const beforeQuit = await desktop.page.evaluate((id) => window.hub.getSession(id), session.id)
  expect(active.has(beforeQuit.session.status)).toBe(true)
  expect(beforeQuit.session.activeTurnId).toBeTruthy()
  const turnId = beforeQuit.session.activeTurnId!
  const originalUserEvents = beforeQuit.events.filter((event) => event.kind === 'user')
  expect(originalUserEvents).toHaveLength(1)
  expect(originalUserEvents[0].turnId).toBe(turnId)
  const nativeStarts = join(desktop.location, 'codex.cjs.turns')
  expect((await readFile(nativeStarts, 'utf8')).trim().split('\n')).toHaveLength(1)

  // Exercise Electron's actual before-quit path, rather than calling a renderer shutdown API.
  const closed = desktop.app.waitForEvent('close')
  await desktop.app.evaluate(({ app }) => app.quit())
  await closed
  await desktop.restart()

  await expect
    .poll(async () => {
      const view = await desktop.page.evaluate((id) => window.hub.getSession(id), session.id)
      return view.session.status
    })
    .toMatch(/^(interrupted|idle)$/)
  const afterRestart = await desktop.page.evaluate((id) => window.hub.getSession(id), session.id)
  expect(afterRestart.session.activeTurnId).toBe(turnId)
  expect(active.has(afterRestart.session.status)).toBe(false)
  expect(afterRestart.session.nativeId).toBe(beforeQuit.session.nativeId)
  expect(afterRestart.events.filter((event) => event.kind === 'user')).toEqual(originalUserEvents)
  expect(
    afterRestart.events.some((event) => event.kind === 'done' && event.turnId === turnId),
  ).toBe(true)
  expect((await desktop.page.evaluate(() => window.hub.health())).code).not.toBe('REVIEW_FAILED')

  const review = await desktop.page.evaluate(
    ({ sessionId, turnId }) => window.hub.getReview(sessionId, turnId),
    { sessionId: session.id, turnId },
  )
  expect(review).not.toBeNull()
  expect(review!.turnId).toBe(turnId)
  expect(review!.finishedAt).toBeTruthy()
  expect(review!.warnings.join('\n')).not.toContain('REVIEW_FAILED')
  expect(review!.warnings.join('\n')).not.toContain('快照整理失败')
  const changed = review!.files.find((file) => file.path === 'hello.ts')
  expect(changed).toBeDefined()
  expect(changed!.before).toContain('world')
  expect(changed!.after).toContain('ISOLATED_CHANGE')
  expect(await readFile(join(desktop.projectPath, 'hello.ts'), 'utf8')).toContain('world')

  // The fixture's durable counter lives outside the Git workspace. A duplicate native submission
  // would append another entry even if it reused a stored user event or wrote the same file again.
  expect((await readFile(nativeStarts, 'utf8')).trim().split('\n')).toHaveLength(1)
  await expect(desktop.page.getByRole('button', { name: '停止执行', exact: true })).toHaveCount(0)
})
