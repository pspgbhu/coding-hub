import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { test, expect, openTrustedProject, createSession, sendMessage } from './fixtures'
import type { ProviderId } from '../../src/shared/types'

for (const provider of ['codex', 'claude', 'opencode'] as ProviderId[]) {
  test(`${provider}: visible trust, native transport, permission and stop lifecycle`, async ({
    desktop,
  }) => {
    const { page } = desktop
    await openTrustedProject(desktop)
    const session = await createSession(page, provider)
    await sendMessage(page, `hello ${provider}`)
    const prefix = provider.toUpperCase()
    await expect(
      page.getByText(`${prefix}_TRANSPORT_OK 中文流式输出`, { exact: true }),
    ).toBeVisible()
    await expect
      .poll(
        async () =>
          (await page.evaluate((id) => window.hub.getSession(id), session.id)).session.status,
      )
      .toBe('idle')
    const first = await page.evaluate((id) => window.hub.getSession(id), session.id)
    expect(first.session.nativeId).toBeTruthy()
    expect(first.events.filter((event) => event.kind === 'text')).toHaveLength(1)
    await sendMessage(page, 'approval')
    await expect(page.getByText('需要你的授权', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '允许一次', exact: true }).click()
    await expect(page.getByText(`${prefix}_APPROVED`, { exact: true })).toBeVisible()
    await expect
      .poll(async () =>
        (await page.evaluate((id) => window.hub.getSession(id), session.id)).events.some(
          (event) => event.kind === 'requestResolved' && event.resolution === 'approved',
        ),
      )
      .toBe(true)
    if (provider === 'codex') {
      await sendMessage(page, 'question')
      await expect(page.getByText('选择输出格式', { exact: true })).toBeVisible()
      await page.getByRole('radio', { name: 'JSON', exact: true }).check()
      await page.getByRole('button', { name: '提交回答', exact: true }).click()
      await expect(page.getByText('CODEX_ANSWERED_JSON', { exact: true })).toBeVisible()
      await expect
        .poll(async () =>
          (await page.evaluate((id) => window.hub.getSession(id), session.id)).events.some(
            (event) => event.kind === 'requestResolved' && event.answers?.format?.includes('JSON'),
          ),
        )
        .toBe(true)
    }
    await sendMessage(page, 'long-running')
    await expect(page.getByRole('button', { name: '停止执行', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '停止执行', exact: true }).click()
    await expect
      .poll(
        async () =>
          (await page.evaluate((id) => window.hub.getSession(id), session.id)).session.status,
      )
      .toBe('interrupted')
    expect(
      (await page.evaluate((id) => window.hub.getSession(id), session.id)).session.nativeId,
    ).toBe(first.session.nativeId)
  })
}

test('drafts, unsaved editor content and multiple real terminals survive switches and renderer reload', async ({
  desktop,
}) => {
  test.setTimeout(90000)
  const { page } = desktop
  await openTrustedProject(desktop)
  const first = await createSession(page, 'codex')
  await sendMessage(page, 'first session')
  await expect(page.getByText('CODEX_TRANSPORT_OK 中文流式输出', { exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('FIRST_UNSENT_DRAFT')
  const second = await createSession(page, 'codex')
  await sendMessage(page, 'second session')
  await expect(page.getByText('CODEX_TRANSPORT_OK 中文流式输出', { exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('SECOND_UNSENT_DRAFT')
  await page.getByRole('button', { name: 'first session', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue(
    'FIRST_UNSENT_DRAFT',
  )
  await page.getByRole('button', { name: '切换代码工作区', exact: true }).click()
  await page.getByRole('treeitem', { name: 'hello.ts', exact: true }).click()
  const editor = page.locator('.monaco-editor').first()
  await expect(editor).toBeVisible()
  await editor.click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await page.keyboard.insertText('export const hello = "UNSAVED_EDITOR"\n')
  const workspaceId = first.workspaceId || first.projectId
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.hub.getEditorState(id), workspaceId))?.files[0]?.edited,
    )
    .toContain('UNSAVED_EDITOR')
  expect(await readFile(join(desktop.projectPath, 'hello.ts'), 'utf8')).toContain('world')
  await page.getByRole('button', { name: '切换终端', exact: true }).click()
  await expect(page.locator('.xterm-screen:visible')).toBeVisible()
  await page.locator('.xterm-screen:visible').click()
  await page.keyboard.type("node -e \"console.log('FIRST_'+'TERMINAL')\"")
  await page.keyboard.press('Enter')
  await expect(page.locator('.xterm-rows:visible')).toContainText('FIRST_TERMINAL')
  await page.getByRole('button', { name: '新建终端', exact: true }).click()
  await expect(page.getByRole('tablist', { name: '终端标签' }).getByRole('tab')).toHaveCount(2)
  await page.locator('.xterm-screen:visible').click()
  await page.keyboard.type("node -e \"console.log('SECOND_'+'TERMINAL')\"")
  await page.keyboard.press('Enter')
  await expect(page.locator('.xterm-rows:visible')).toContainText('SECOND_TERMINAL')
  const ids = (await page.evaluate((id) => window.hub.terminalList(id), workspaceId))
    .filter((entry) => entry.exitCode === undefined)
    .map((entry) => entry.id)
    .sort()
  expect(ids).toHaveLength(2)
  await page.getByRole('button', { name: '隐藏终端面板', exact: true }).click()
  await page.getByRole('button', { name: 'second session', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue(
    'SECOND_UNSENT_DRAFT',
  )
  await page.getByRole('button', { name: 'first session', exact: true }).click()
  await page.reload()
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue(
    'FIRST_UNSENT_DRAFT',
  )
  if (!(await page.locator('.workspace:visible').count()))
    await page.getByRole('button', { name: '切换代码工作区', exact: true }).click()
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('UNSAVED_EDITOR')
  if (!(await page.getByRole('region', { name: '项目终端' }).isVisible()))
    await page.getByRole('button', { name: '切换终端', exact: true }).click()
  await expect(page.getByRole('tablist', { name: '终端标签' }).getByRole('tab')).toHaveCount(2)
  expect(
    (await page.evaluate((id) => window.hub.terminalList(id), workspaceId))
      .filter((entry) => entry.exitCode === undefined)
      .map((entry) => entry.id)
      .sort(),
  ).toEqual(ids)
  await page.getByRole('tablist', { name: '终端标签' }).getByRole('tab').nth(1).click()
  await expect(page.locator('.xterm-rows:visible')).toContainText('SECOND_TERMINAL')
  await page.getByRole('button', { name: '搜索终端输出', exact: true }).click()
  await page.getByRole('textbox', { name: '搜索终端内容', exact: true }).fill('SECOND_TERMINAL')
  await expect
    .poll(() => page.locator('.xterm-screen:visible .xterm-selection div').count())
    .toBeGreaterThan(0)
  await page.getByRole('button', { name: '引用终端输出', exact: true }).click()
  await expect(page.locator('.context-chip')).toContainText('终端')
  await page.getByRole('button', { name: '终止当前终端', exact: true }).click()
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.hub.terminalList(id), workspaceId)).filter(
          (entry) => entry.exitCode === undefined,
        ).length,
    )
    .toBe(1)
  await page.getByRole('button', { name: '重启当前终端', exact: true }).click()
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.hub.terminalList(id), workspaceId)).filter(
          (entry) => entry.exitCode === undefined,
        ).length,
    )
    .toBe(2)
  expect((await page.evaluate((id) => window.hub.getDraft(id), second.id)).text).toBe(
    'SECOND_UNSENT_DRAFT',
  )
  await page.screenshot({ path: 'test-results/desktop-recovery.png' })
})

test('independent worktree changes stay isolated and commit requires visible staged review', async ({
  desktop,
}) => {
  const { page } = desktop
  await openTrustedProject(desktop)
  const session = await createSession(page, 'codex', 'isolated')
  await sendMessage(page, 'write-file')
  await expect(page.getByText('CODEX_TRANSPORT_OK 中文流式输出', { exact: true })).toBeVisible()
  const workspace = (
    await page.evaluate((id) => window.hub.listWorkspaces(id), session.projectId)
  ).find((entry) => entry.id === session.workspaceId)!
  expect(workspace.kind).toBe('worktree')
  expect(await readFile(join(desktop.projectPath, 'hello.ts'), 'utf8')).toContain('world')
  expect(await readFile(join(workspace.cwd, 'hello.ts'), 'utf8')).toContain('ISOLATED_CHANGE')
  await page.getByRole('button', { name: '切换代码工作区', exact: true }).click()
  await page.locator('.workspace:visible').getByRole('button', { name: /^变更/ }).click()
  await page.getByRole('button', { name: '暂存 hello.ts', exact: true }).click()
  await page
    .getByRole('textbox', { name: '提交说明', exact: true })
    .fill('test: reviewed isolated change')
  await page.getByRole('button', { name: '审阅并提交', exact: true }).click()
  const review = page.getByRole('dialog', { name: '审阅暂存修改后提交', exact: true })
  await expect(review).toBeVisible()
  await expect(review.getByRole('button', { name: 'hello.ts', exact: true })).toBeVisible()
  await expect(review.locator('.monaco-diff-editor')).toContainText('ISOLATED_CHANGE')
  await review.getByRole('button', { name: '确认提交暂存修改', exact: true }).click()
  await expect(review).toHaveCount(0)
  expect(
    execFileSync('git', ['log', '-1', '--format=%s'], {
      cwd: workspace.cwd,
      encoding: 'utf8',
    }).trim(),
  ).toBe('test: reviewed isolated change')
  expect(
    execFileSync('git', ['log', '-1', '--format=%s'], {
      cwd: desktop.projectPath,
      encoding: 'utf8',
    }).trim(),
  ).toBe('test: initial fixture')
})

test('security boundaries reject escaping paths and non-web external URLs', async ({ desktop }) => {
  await openTrustedProject(desktop)
  const failures = await desktop.page.evaluate(async () => {
    const project = (await window.hub.bootstrap()).projects[0],
      result: string[] = []
    try {
      await window.hub.readFile(project.id, '../../etc/passwd')
    } catch {
      result.push('path')
    }
    try {
      await window.hub.openExternal('javascript:alert(1)')
    } catch {
      result.push('url')
    }
    return result
  })
  expect(failures).toEqual(['path', 'url'])
})

test('visible backup restore replaces drafts and unsaved editor state without cleanup overwriting them', async ({
  desktop,
}) => {
  test.setTimeout(90000)
  const { page } = desktop
  await openTrustedProject(desktop)
  const session = await createSession(page, 'codex')
  await sendMessage(page, 'backup session')
  await expect(page.getByText('CODEX_TRANSPORT_OK 中文流式输出', { exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('DRAFT_BEFORE_BACKUP')
  await page.getByRole('button', { name: '切换代码工作区', exact: true }).click()
  await page.getByRole('treeitem', { name: 'hello.ts', exact: true }).click()
  const edit = async (marker: string) => {
    await page
      .locator('.monaco-editor')
      .first()
      .getByRole('textbox', { name: 'Editor content', exact: true })
      .focus()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.keyboard.insertText(`export const hello = "${marker}"\n`)
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(
              (id) => window.hub.getEditorState(id),
              session.workspaceId || session.projectId,
            )
          )?.files[0]?.edited,
      )
      .toContain(marker)
  }
  await edit('EDITOR_BEFORE_BACKUP')
  await expect
    .poll(async () => (await page.evaluate((id) => window.hub.getDraft(id), session.id)).text)
    .toBe('DRAFT_BEFORE_BACKUP')
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await page.getByRole('button', { name: /^设置/ }).first().click()
  await settings.getByRole('button', { name: '数据与更新', exact: true }).click()
  await settings.getByRole('button', { name: '立即备份', exact: true }).click()
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.hub.listBackups())).filter(
          (backup) => backup.reason === 'manual',
        ).length,
    )
    .toBe(1)
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('DRAFT_AFTER_BACKUP')
  await edit('EDITOR_AFTER_BACKUP')
  await expect
    .poll(async () => (await page.evaluate((id) => window.hub.getDraft(id), session.id)).text)
    .toBe('DRAFT_AFTER_BACKUP')
  await page.getByRole('button', { name: /^设置/ }).first().click()
  await settings.getByRole('button', { name: '数据与更新', exact: true }).click()
  page.once('dialog', (dialog) => dialog.accept())
  await settings
    .locator('.management-row')
    .filter({ hasText: '手动' })
    .getByRole('button', { name: '恢复', exact: true })
    .click()
  await expect
    .poll(async () => (await page.evaluate((id) => window.hub.getDraft(id), session.id)).text)
    .toBe('DRAFT_BEFORE_BACKUP')
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(
            (id) => window.hub.getEditorState(id),
            session.workspaceId || session.projectId,
          )
        )?.files[0]?.edited,
    )
    .toContain('EDITOR_BEFORE_BACKUP')
  await expect(settings).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue(
    'DRAFT_BEFORE_BACKUP',
  )
  await page.reload()
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue(
    'DRAFT_BEFORE_BACKUP',
  )
  if (!(await page.locator('.workspace:visible').count()))
    await page.getByRole('button', { name: '切换代码工作区', exact: true }).click()
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText(
    'EDITOR_BEFORE_BACKUP',
  )
})
