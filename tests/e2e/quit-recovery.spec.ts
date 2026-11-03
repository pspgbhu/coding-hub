import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect, openTrustedProject, createSession } from './fixtures'

test('native application quit confirms pending draft and editor recovery writes before database close', async ({
  desktop,
}) => {
  test.setTimeout(90000)
  await openTrustedProject(desktop)
  const session = await createSession(desktop.page, 'codex')
  await desktop.page
    .getByRole('textbox', { name: '消息输入框', exact: true })
    .fill('DRAFT_BASELINE')
  await expect
    .poll(
      async () => (await desktop.page.evaluate((id) => window.hub.getDraft(id), session.id)).text,
    )
    .toBe('DRAFT_BASELINE')
  // Deliberately keep ordinary debounce saves pending. The actual typed preload
  // API and native app.before-quit path remain intact; only timer pacing changes.
  const deferAutosave = () =>
    desktop.page.evaluate(() => {
      const original = window.setTimeout.bind(window)
      window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
        original(
          handler,
          delay === 150 || delay === 250 ? 60000 : delay,
          ...args,
        )) as typeof window.setTimeout
    })
  const quit = async () => {
    const closed = desktop.app.waitForEvent('close')
    // app.quit is the same native before-quit path used by Cmd+Q and the tray.
    await desktop.app.evaluate(({ app }) => app.quit())
    await closed
    await desktop.restart()
  }
  await deferAutosave()
  await desktop.page
    .getByRole('textbox', { name: '消息输入框', exact: true })
    .fill('DRAFT_FINAL_BEFORE_QUIT')
  expect((await desktop.page.evaluate((id) => window.hub.getDraft(id), session.id)).text).toBe(
    'DRAFT_BASELINE',
  )
  await quit()
  await expect(desktop.page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue(
    'DRAFT_FINAL_BEFORE_QUIT',
  )
  await desktop.page.getByRole('button', { name: '切换代码工作区', exact: true }).click()
  await desktop.page.getByRole('treeitem', { name: 'hello.ts', exact: true }).click()
  const editor = desktop.page.locator('.monaco-editor').first()
  await expect(editor.locator('.view-lines')).toContainText('world')
  await expect
    .poll(
      async () =>
        (
          await desktop.page.evaluate(
            (id) => window.hub.getEditorState(id),
            session.workspaceId || session.projectId,
          )
        )?.files.length,
    )
    .toBe(1)
  await deferAutosave()
  await editor.click()
  await desktop.page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await desktop.page.keyboard.insertText('export const hello = "EDITOR_FINAL_BEFORE_QUIT"\n')
  expect(
    (
      await desktop.page.evaluate(
        (id) => window.hub.getEditorState(id),
        session.workspaceId || session.projectId,
      )
    )?.files[0].edited,
  ).toContain('world')
  await quit()
  await expect
    .poll(
      async () =>
        (
          await desktop.page.evaluate(
            (id) => window.hub.getEditorState(id),
            session.workspaceId || session.projectId,
          )
        )?.files[0].edited,
    )
    .toContain('EDITOR_FINAL_BEFORE_QUIT')
  if (!(await desktop.page.locator('.workspace:visible').count()))
    await desktop.page.getByRole('button', { name: '切换代码工作区', exact: true }).click()
  await expect(desktop.page.locator('.monaco-editor .view-lines').first()).toContainText(
    'EDITOR_FINAL_BEFORE_QUIT',
  )
  expect(await readFile(join(desktop.projectPath, 'hello.ts'), 'utf8')).toContain('world')
})
