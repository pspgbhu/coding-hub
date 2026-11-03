import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test, expect, openTrustedProject, createSession, sendMessage } from './fixtures'
import type { Settings } from '../../src/shared/types'

test('themes, keyboard layout resizing and simulated 150/200 percent zoom keep the workbench usable', async ({
  desktop,
}) => {
  test.setTimeout(90000)
  const { app, page } = desktop
  const capture = async (name: string) => {
    const png = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'),
    )
    await writeFile(resolve('coverage/visuals', name), Buffer.from(png, 'base64'))
  }
  await mkdir(resolve('coverage/visuals'), { recursive: true })
  await openTrustedProject(desktop)
  await createSession(page, 'codex')
  await sendMessage(page, 'appearance check')
  await expect(page.getByText('CODEX_TRANSPORT_OK 中文流式输出', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '切换代码工作区', exact: true }).click()
  await page.getByRole('treeitem', { name: 'hello.ts', exact: true }).click()
  const lines = page.locator('.workspace:visible .monaco-editor .view-lines').first()
  const paint = () =>
    page.evaluate(async () => {
      await document.fonts.ready
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
    })
  const checkEditor = async () => {
    await expect(lines).toContainText('export')
    await expect(lines).toContainText('world')
    await expect(lines).toBeInViewport()
    await expect(lines.locator('.view-line').first()).toHaveCSS('visibility', 'visible')
    await paint()
  }
  await checkEditor()
  await page.getByRole('button', { name: '切换终端', exact: true }).click()
  await expect(page.locator('.xterm-screen:visible')).toBeVisible()
  const expected: Partial<Settings> = {}
  for (const panel of [
    { label: '调整侧栏宽度', key: 'sidebarWidth', arrow: 'ArrowRight' },
    { label: '调整代码工作区宽度', key: 'workspaceWidth', arrow: 'ArrowLeft' },
    { label: '调整终端高度', key: 'terminalHeight', arrow: 'ArrowUp' },
  ] as const) {
    const handle = page.getByRole('separator', { name: panel.label, exact: true })
    await expect(handle).toBeVisible()
    const before = Number(await handle.getAttribute('aria-valuenow'))
    await handle.focus()
    await page.keyboard.press(panel.arrow)
    expected[panel.key] = before + 10
    await expect
      .poll(async () => (await page.evaluate(() => window.hub.getSettings()))[panel.key])
      .toBe(before + 10)
    await expect(handle).toHaveAttribute('aria-valuenow', String(before + 10))
  }
  await page.reload()
  expect(await page.evaluate(() => window.hub.getSettings())).toMatchObject(expected)
  if (!(await page.locator('.workspace:visible').count()))
    await page.getByRole('button', { name: '切换代码工作区', exact: true }).click()
  await checkEditor()
  if (await page.getByRole('region', { name: '项目终端', exact: true }).isVisible())
    await page.getByRole('button', { name: '隐藏终端面板', exact: true }).click()
  for (const theme of ['light', 'dark'] as const) {
    await page.getByRole('button', { name: /^设置/ }).first().click()
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('button', { name: '外观与通用', exact: true }).click()
    await settings
      .getByRole('button', { name: theme === 'light' ? '浅色' : '深色', exact: true })
      .click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await settings.getByRole('button', { name: '关闭', exact: true }).click()
    await checkEditor()
    await capture(`workbench-${theme}.png`)
  }
  for (const zoom of [1.5, 2]) {
    // Electron zoom exercises layout reflow; it does not reproduce hardware DPI,
    // Windows per-monitor scaling, font rasterization or a second display.
    await app.evaluate(
      ({ BrowserWindow }, factor) =>
        BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(factor),
      zoom,
    )
    await checkEditor()
    await expect(page.getByRole('button', { name: '切换代码工作区', exact: true })).toBeInViewport()
    await expect(page.getByTitle('关闭工作区', { exact: true })).toBeInViewport()
    await capture(`workbench-zoom-${Math.round(zoom * 100)}.png`)
    await page.getByTitle('关闭工作区', { exact: true }).click()
    const composer = page.getByRole('textbox', { name: '消息输入框', exact: true })
    await expect(composer).toBeInViewport()
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeInViewport()
    await composer.fill(`ZOOM_${zoom}_UNSENT`)
    await page.getByRole('button', { name: '命令面板', exact: true }).click()
    const commands = page.getByRole('dialog', { name: '命令面板', exact: true })
    await expect(commands).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '切换代码工作区', exact: true }).click()
  }
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1),
  )
})
