import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Page } from '@playwright/test'
import type { ProviderId } from '../../src/shared/types'
import {
  test,
  expect,
  createSession,
  openTrustedProject,
  sendMessage,
  type Desktop,
} from './fixtures'

interface NativeRequest {
  provider: ProviderId
  cwd: string
  nativeId: string
  model: string | { providerID: string; modelID: string } | null
  effort?: string | null
  variant?: string | null
  input?: { type: string; text?: string; url?: string }[]
}

async function requests(desktop: Desktop, provider: ProviderId): Promise<NativeRequest[]> {
  try {
    return (await readFile(join(desktop.location, `${provider}.cjs.requests`), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as NativeRequest)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function choose(page: Page, label: string, option: string) {
  await page.getByRole('button', { name: label, exact: true }).click()
  await page
    .getByRole('dialog', { name: `${label}选项`, exact: true })
    .getByRole('option', { name: option, exact: true })
    .click()
}

async function sessions(page: Page) {
  return (await page.evaluate(() => window.hub.bootstrap())).sessions
}

test('the new page preserves an unsent image draft and creates exactly one session on first send', async ({
  desktop,
}) => {
  const { page, app } = desktop
  await expect(page.getByRole('heading', { name: '打开项目', exact: true })).toBeVisible()
  expect(await sessions(page)).toHaveLength(0)
  await openTrustedProject(desktop)
  const project = (await page.evaluate(() => window.hub.bootstrap())).projects[0]
  await expect(page.getByRole('heading', { name: '开始新会话', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '选择模型', exact: true })).toContainText(
    'Codex · CLI 默认',
  )
  await expect(page.getByRole('button', { name: '选择思考强度', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '添加图片', exact: true })).toBeEnabled()
  await page.screenshot({ path: test.info().outputPath('new-conversation.png') })
  await page.getByRole('button', { name: '选择模型', exact: true }).click()
  await expect(page.getByRole('option', { name: 'Fixture model', exact: true })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('model-menu.png') })
  await page.keyboard.press('Escape')
  await choose(page, '选择模型', 'Fixture model')
  await choose(page, '选择思考强度', 'high')
  await expect
    .poll(() => page.evaluate((id) => window.hub.getNewSessionDraft(id), project.id))
    .toMatchObject({ model: 'fixture-model', reasoningOption: 'high' })
  await page.getByRole('button', { name: '选择模型', exact: true }).click()
  await page
    .getByRole('dialog', { name: '选择模型选项', exact: true })
    .getByRole('option', { name: 'CLI 默认', exact: true })
    .first()
    .click()
  await expect(page.getByRole('button', { name: '选择模型', exact: true })).toContainText(
    'Codex · CLI 默认',
  )
  await expect(page.getByRole('button', { name: '选择思考强度', exact: true })).toBeDisabled()
  await expect
    .poll(async () => {
      const draft = await page.evaluate((id) => window.hub.getNewSessionDraft(id), project.id)
      return draft.model === undefined && draft.reasoningOption === undefined
    })
    .toBe(true)
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
  expect(await sessions(page)).toHaveLength(0)

  const imagePath = join(desktop.location, 'first-message.png')
  await writeFile(
    imagePath,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
      'base64',
    ),
  )
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [path],
    })) as typeof dialog.showOpenDialog
  }, imagePath)
  await page.getByRole('button', { name: '添加图片', exact: true }).click()
  await expect(page.getByTitle('预览引用 first-message.png', { exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('FIRST_UI_MESSAGE')
  await expect
    .poll(() => page.evaluate((id) => window.hub.getNewSessionDraft(id), project.id))
    .toMatchObject({ text: 'FIRST_UI_MESSAGE', context: [{ name: 'first-message.png' }] })
  await page.reload()
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue(
    'FIRST_UI_MESSAGE',
  )
  await expect(page.getByTitle('预览引用 first-message.png', { exact: true })).toBeVisible()
  expect(await sessions(page)).toHaveLength(0)
  const send = page.getByRole('button', { name: '发送消息', exact: true })
  await expect(send).toBeEnabled()
  await send.evaluate((button: HTMLButtonElement) => {
    button.click()
    button.click()
  })
  await expect(page.getByText('CODEX_TRANSPORT_OK 中文流式输出', { exact: true })).toBeVisible()
  const stored = await sessions(page)
  expect(stored).toHaveLength(1)
  expect(stored[0]).toMatchObject({
    provider: 'codex',
    projectId: project.id,
    title: 'FIRST_UI_MESSAGE',
  })
  const view = await page.evaluate((id) => window.hub.getSession(id), stored[0].id)
  expect(view.events.filter((event) => event.kind === 'user')).toHaveLength(1)
  expect(view.events.find((event) => event.kind === 'user')?.context).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'first-message.png' })]),
  )
  const native = await requests(desktop, 'codex')
  expect(native).toHaveLength(1)
  expect(native[0]).toMatchObject({ model: null, effort: null, cwd: project.path })
  expect(native[0].input).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: 'image' })]),
  )
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue('')
  await expect(page.getByTitle('预览引用 first-message.png', { exact: true })).toHaveCount(0)
  expect(await sessions(page)).toHaveLength(1)
})

test('new-session drafts and explicit model preferences remain separate for each project across restart', async ({
  desktop,
}) => {
  let { page } = desktop
  await openTrustedProject(desktop)
  const first = (await page.evaluate(() => window.hub.bootstrap())).projects[0]
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('PROJECT_ONE_UNSENT')
  const secondPath = join(desktop.location, 'Second project')
  await mkdir(secondPath)
  const canonicalSecondPath = await realpath(secondPath)
  await desktop.app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [path],
    })) as typeof dialog.showOpenDialog
  }, secondPath)
  await choose(page, '选择项目', '打开项目')
  await page.getByRole('button', { name: '信任此项目', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue('')
  const second = (await page.evaluate(() => window.hub.bootstrap())).projects.find(
    (project) => project.path === canonicalSecondPath,
  )!
  await choose(page, '选择模型', 'Fixture Claude model')
  await choose(page, '选择思考强度', 'high')
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('PROJECT_TWO_UNSENT')
  await choose(page, '选择项目', first.name)
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue(
    'PROJECT_ONE_UNSENT',
  )
  await expect(page.getByRole('button', { name: '选择模型', exact: true })).toContainText(
    'Codex · CLI 默认',
  )
  await choose(page, '选择项目', basename(secondPath))
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue(
    'PROJECT_TWO_UNSENT',
  )
  await expect(page.getByRole('button', { name: '选择模型', exact: true })).toContainText(
    'Fixture Claude model',
  )
  await expect(page.getByRole('button', { name: '选择思考强度', exact: true })).toContainText(
    'high',
  )
  await expect
    .poll(() => page.evaluate((id) => window.hub.getNewSessionDraft(id), second.id))
    .toMatchObject({
      provider: 'claude',
      model: 'fixture-model',
      reasoningOption: 'high',
      text: 'PROJECT_TWO_UNSENT',
    })
  expect(await sessions(page)).toHaveLength(0)
  page = (await desktop.restart()).page
  await expect(page.getByRole('heading', { name: '开始新会话', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue(
    'PROJECT_TWO_UNSENT',
  )
  await expect(page.getByRole('button', { name: '选择思考强度', exact: true })).toContainText(
    'high',
  )
  const defaults = (await page.evaluate(() => window.hub.getSettings())).newSessionDefaults
  expect(defaults?.[second.id]).toEqual({
    provider: 'claude',
    model: 'fixture-model',
    reasoningOption: 'high',
  })
  expect(defaults?.[first.id]).toBeUndefined()
  expect(await sessions(page)).toHaveLength(0)
  await sendMessage(page, 'PROJECT_TWO_FIRST_SEND')
  await expect(page.getByText('CLAUDE_TRANSPORT_OK 中文流式输出', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue('')
  await expect(page.getByRole('button', { name: '选择模型', exact: true })).toContainText(
    'Fixture Claude model',
  )
  await expect(page.getByRole('button', { name: '选择思考强度', exact: true })).toContainText(
    'high',
  )
})

test('Codex model and effort choices reach an isolated workspace and can change on an idle native session', async ({
  desktop,
}) => {
  const { page } = desktop
  await openTrustedProject(desktop)
  await choose(page, '选择模型', 'Fixture model')
  await expect(page.getByRole('button', { name: '选择思考强度', exact: true })).toContainText(
    'medium',
  )
  await choose(page, '选择思考强度', 'high')
  await choose(page, '选择工作区', '新建独立工作区')
  expect(await sessions(page)).toHaveLength(0)
  await sendMessage(page, 'CODEX_UI_SELECTION')
  await expect(page.getByText('CODEX_TRANSPORT_OK 中文流式输出', { exact: true })).toBeVisible()
  const initial = (await sessions(page))[0]
  expect(initial).toMatchObject({ model: 'fixture-model', reasoningOption: 'high' })
  const workspace = (await page.evaluate(() => window.hub.bootstrap())).workspaces.find(
    (item) => item.id === initial.workspaceId,
  )!
  expect(workspace.kind).toBe('worktree')
  expect((await requests(desktop, 'codex'))[0]).toMatchObject({
    model: 'fixture-model',
    effort: 'high',
    cwd: workspace.cwd,
    nativeId: initial.nativeId,
  })
  await choose(page, '选择模型', 'Fixture precise')
  await expect.poll(async () => (await sessions(page))[0].model).toBe('fixture-precise')
  await page.getByRole('button', { name: '选择模型', exact: true }).click()
  await expect(
    page
      .getByRole('dialog', { name: '选择模型选项', exact: true })
      .getByRole('option', { name: 'Fixture Claude model', exact: true }),
  ).toHaveCount(0)
  await page
    .getByRole('dialog', { name: '选择模型选项', exact: true })
    .getByRole('option', { name: 'Fixture model', exact: true })
    .click()
  await choose(page, '选择思考强度', '模型默认')
  await expect.poll(async () => (await sessions(page))[0].reasoningOption).toBe('medium')
  await sendMessage(page, 'CODEX_RESET_MODEL_DEFAULT')
  await expect.poll(async () => (await requests(desktop, 'codex')).length).toBe(2)
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeVisible()
  expect((await requests(desktop, 'codex'))[1]).toMatchObject({
    model: 'fixture-model',
    effort: 'medium',
    nativeId: initial.nativeId,
  })
  expect(await sessions(page)).toHaveLength(1)
  await sendMessage(page, 'long-running')
  await expect(page.getByRole('button', { name: '停止执行', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '选择模型', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '选择思考强度', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '停止执行', exact: true }).click()
  await expect(page.getByRole('button', { name: '选择模型', exact: true })).toBeEnabled()
})

test('selector keyboard navigation, unknown models and zoomed popovers preserve an unsent draft', async ({
  desktop,
}) => {
  const { page } = desktop
  await openTrustedProject(desktop)
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('KEYBOARD_UNSENT')
  const project = (await page.evaluate(() => window.hub.bootstrap())).projects[0]
  await expect
    .poll(() => page.evaluate((id) => window.hub.getNewSessionDraft(id), project.id))
    .toMatchObject({ text: 'KEYBOARD_UNSENT' })
  const model = page.getByRole('button', { name: '选择模型', exact: true })
  await expect(model).toBeEnabled()
  await model.press('ArrowDown')
  const search = page.getByLabel('搜索模型或输入模型 ID', { exact: true })
  await expect(search).toBeFocused()
  await search.fill('Fixture legacy')
  await expect(page.getByRole('option', { name: 'Fixture legacy', exact: true })).toHaveClass(
    /is-active/,
  )
  await page.keyboard.press('Enter')
  await expect(model).toContainText('Fixture legacy')
  const reasoning = page.getByRole('button', { name: '选择思考强度', exact: true })
  await expect(reasoning).toBeDisabled()
  await expect(reasoning).toHaveAccessibleDescription('此模型未提供可用的思考强度选项')
  await model.click()
  await search.fill('private/custom-model')
  await page
    .getByRole('option', { name: '使用自定义模型 private/custom-model（Codex）', exact: true })
    .click()
  await expect(model).toContainText('private/custom-model')
  await expect(reasoning).toBeDisabled()
  await model.click()
  await page.keyboard.press('Escape')
  await expect(model).toBeFocused()
  await expect(page.getByRole('dialog', { name: '选择模型选项', exact: true })).toHaveCount(0)
  await model.click()
  await page.getByRole('textbox', { name: '搜索会话', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '选择模型选项', exact: true })).toHaveCount(0)
  await desktop.app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setSize(920, 700)
    window.webContents.setZoomFactor(1.5)
  })
  await model.click()
  const menu = page.getByRole('dialog', { name: '选择模型选项', exact: true })
  await expect(menu).toBeInViewport()
  expect(
    await menu.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      return (
        bounds.left >= 0 &&
        bounds.top >= 0 &&
        bounds.right <= innerWidth &&
        bounds.bottom <= innerHeight
      )
    }),
  ).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue(
    'KEYBOARD_UNSENT',
  )
  expect(await sessions(page)).toHaveLength(0)
})

test('editor file and text references enter the new draft without leaking into a historical session', async ({
  desktop,
}) => {
  const { page } = desktop
  await openTrustedProject(desktop)
  const history = await createSession(page, 'codex')
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('HISTORY_UNSENT')
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('NEW_CONTEXT_UNSENT')
  await page.getByRole('button', { name: '切换代码工作区', exact: true }).click()
  await page.getByRole('treeitem', { name: 'hello.ts', exact: true }).click()
  const reference = page.getByRole('button', { name: '引用到对话', exact: true })
  await reference.click()
  await expect(page.getByTitle('预览引用 hello.ts', { exact: true })).toBeVisible()
  await expect
    .poll(() => page.evaluate((id) => window.hub.getNewSessionDraft(id), history.projectId))
    .toMatchObject({
      text: 'NEW_CONTEXT_UNSENT',
      context: [{ kind: 'file', name: 'hello.ts', content: 'export const hello = "world"\n' }],
    })
  await page.getByRole('button', { name: '移除引用 hello.ts', exact: true }).click()
  const editor = page.locator('.workspace:visible .monaco-editor').first()
  await editor.click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await page.keyboard.press('ArrowLeft')
  for (let index = 0; index < 6; index++) await page.keyboard.press('Shift+ArrowRight')
  await reference.click()
  await expect
    .poll(() => page.evaluate((id) => window.hub.getNewSessionDraft(id), history.projectId))
    .toMatchObject({
      context: [{ kind: 'selection', content: 'export', startLine: 1, endLine: 1 }],
    })
  await page.locator(`[data-session-id="${history.id}"] .session-select`).click()
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue(
    'HISTORY_UNSENT',
  )
  await expect(page.getByTitle('预览引用 hello.ts', { exact: true })).toHaveCount(0)
  expect(await page.evaluate((id) => window.hub.getDraft(id), history.id)).toMatchObject({
    text: 'HISTORY_UNSENT',
    context: [],
  })
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue(
    'NEW_CONTEXT_UNSENT',
  )
  await expect(page.getByTitle('预览引用 hello.ts', { exact: true })).toBeVisible()
  expect(await sessions(page)).toHaveLength(1)
})

test('an empty session suggestion cannot overwrite another session saved draft', async ({
  desktop,
}) => {
  const { page } = desktop
  await openTrustedProject(desktop)
  const first = await createSession(page, 'codex')
  const second = await createSession(page, 'codex')
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('SECOND_SAVED_DRAFT')
  await expect
    .poll(() => page.evaluate((id) => window.hub.getDraft(id), second.id))
    .toMatchObject({ text: 'SECOND_SAVED_DRAFT' })
  await page.locator(`[data-session-id="${first.id}"] .session-select`).click()
  await page.getByRole('button', { name: '说明项目结构和主要入口', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue(
    '说明项目结构和主要入口',
  )
  await page.locator(`[data-session-id="${second.id}"] .session-select`).click()
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue(
    'SECOND_SAVED_DRAFT',
  )
  await page.reload()
  await expect(page.getByRole('textbox', { name: '消息输入框', exact: true })).toHaveValue(
    'SECOND_SAVED_DRAFT',
  )
  expect(await page.evaluate((id) => window.hub.getDraft(id), first.id)).toMatchObject({
    text: '说明项目结构和主要入口',
  })
})

for (const selection of [
  {
    provider: 'claude',
    modelName: 'Fixture Claude model',
    effort: 'high',
    response: 'CLAUDE_TRANSPORT_OK 中文流式输出',
  },
  {
    provider: 'opencode',
    modelName: 'Fixture / Fixture model',
    effort: 'custom-fast',
    response: 'OPENCODE_TRANSPORT_OK 中文流式输出',
  },
] as const) {
  test(`${selection.provider} model and native reasoning selections reach its installed CLI transport`, async ({
    desktop,
  }) => {
    const { page } = desktop
    await openTrustedProject(desktop)
    await choose(page, '选择模型', selection.modelName)
    await choose(page, '选择思考强度', selection.effort)
    expect(await sessions(page)).toHaveLength(0)
    await sendMessage(page, `${selection.provider.toUpperCase()}_UI_SELECTION`)
    await expect(page.getByText(selection.response, { exact: true })).toBeVisible()
    const stored = await sessions(page)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      provider: selection.provider,
      reasoningOption: selection.effort,
    })
    const native = (await requests(desktop, selection.provider))[0]
    expect(native.cwd).toBe(await realpath(desktop.projectPath))
    if (selection.provider === 'claude')
      expect(native).toMatchObject({ model: 'fixture-model', effort: 'high' })
    else
      expect(native).toMatchObject({
        model: { providerID: 'fixture', modelID: 'model' },
        variant: 'custom-fast',
      })
  })
}
