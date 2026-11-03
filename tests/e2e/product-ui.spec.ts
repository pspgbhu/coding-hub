import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { cpus, release, totalmem } from 'node:os'
import { performance } from 'node:perf_hooks'
import { test, expect, openTrustedProject, createSession, sendMessage } from './fixtures'

test('readiness remains explicit and native file/image references can be previewed, restored and removed', async ({
  desktop,
}) => {
  const { page, app } = desktop
  await openTrustedProject(desktop)
  await page.getByRole('button', { name: /^设置/ }).first().click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await expect(settings.locator('.readiness-grid')).toHaveCount(3)
  for (const grid of await settings.locator('.readiness-grid').all()) {
    await expect(grid.locator('dt')).toHaveText(['CLI 安装', '协议版本', '账号登录', '模型列表'])
    const auth = grid.locator('div').filter({ has: page.getByText('账号登录', { exact: true }) })
    await expect(auth).toHaveAttribute('data-readiness', 'unknown')
    await expect(auth).toContainText('尚未验证')
  }
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  const session = await createSession(page, 'codex')
  await page.getByRole('button', { name: '切换代码工作区', exact: true }).click()
  await page.getByRole('treeitem', { name: 'hello.ts', exact: true }).click()
  await page.getByRole('button', { name: '引用到对话', exact: true }).click()
  await page.getByTitle('预览引用 hello.ts', { exact: true }).click()
  await expect(page.getByRole('region', { name: 'hello.ts 引用预览', exact: true })).toContainText(
    'world',
  )
  const imagePath = join(desktop.location, 'preview.png')
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
  await page.getByTitle('添加图片', { exact: true }).click()
  await page.getByTitle('预览引用 preview.png', { exact: true }).click()
  const image = page
    .getByRole('region', { name: 'preview.png 引用预览', exact: true })
    .getByRole('img')
  await expect(image).toBeVisible()
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0))
    .toBe(true)
  await expect
    .poll(
      async () => (await page.evaluate((id) => window.hub.getDraft(id), session.id)).context.length,
    )
    .toBe(2)
  await page.reload()
  await page.getByTitle('预览引用 hello.ts', { exact: true }).click()
  await expect(page.getByRole('region', { name: 'hello.ts 引用预览', exact: true })).toContainText(
    'world',
  )
  await page.getByTitle('预览引用 preview.png', { exact: true }).click()
  await expect(
    page.getByRole('region', { name: 'preview.png 引用预览', exact: true }).getByRole('img'),
  ).toBeVisible()
  await page.getByRole('button', { name: '移除引用 preview.png', exact: true }).click()
  await expect(page.getByTitle('预览引用 preview.png', { exact: true })).toHaveCount(0)
  await sendMessage(page, 'reference preview')
  await expect(page.getByText('CODEX_TRANSPORT_OK 中文流式输出', { exact: true })).toBeVisible()
  await page.getByTitle('预览引用 hello.ts', { exact: true }).click()
  await expect(page.getByRole('region', { name: 'hello.ts 引用预览', exact: true })).toContainText(
    'world',
  )
  await expect(page.getByRole('button', { name: '移除引用 hello.ts', exact: true })).toHaveCount(0)
})

test('confirmed permission scopes and question answers survive reload, while full tool output loads one page at a time', async ({
  desktop,
}) => {
  const { page } = desktop
  await openTrustedProject(desktop)
  const session = await createSession(page, 'codex')
  await sendMessage(page, 'permission-profile')
  await page.getByRole('combobox', { name: '授权范围', exact: true }).selectOption('session')
  await page.getByRole('button', { name: '允许本会话', exact: true }).click()
  await expect(page.getByText('CODEX_PROFILE_SESSION', { exact: true })).toBeVisible()
  await expect(page.locator('.permission-scope')).toContainText('本会话')
  await sendMessage(page, 'question')
  await page.getByRole('radio', { name: 'JSON', exact: true }).check()
  await page.getByRole('button', { name: '提交回答', exact: true }).click()
  await expect(page.getByText('CODEX_ANSWERED_JSON', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.locator('.permission-scope')).toContainText('本会话')
  await expect(page.getByRole('radio', { name: 'JSON', exact: true })).toBeChecked()
  await expect(page.getByRole('radio', { name: 'JSON', exact: true })).toBeDisabled()
  await sendMessage(page, 'long-output')
  await expect(page.getByText('CODEX_LONG_OUTPUT_COMPLETE', { exact: true })).toBeVisible()
  const tool = page.locator('.tool-event').filter({
    has: page.getByRole('button', { name: 'commandExecution', exact: true }),
  })
  await tool.locator('.tool-header').click()
  await expect(tool.locator('.tool-detail pre').first()).toHaveText('printf long-output')
  await expect(tool).toContainText('普通历史仅显示输出预览')
  expect(await tool.locator('.tool-detail pre').last().textContent()).not.toContain(
    'BEGIN_LONG_OUTPUT',
  )
  await tool.getByRole('button', { name: '按页查看完整输出', exact: true }).click()
  const output = tool.locator('.tool-detail pre').last()
  await expect(output).toContainText('BEGIN_LONG_OUTPUT')
  expect((await output.textContent())!.length).toBeLessThanOrEqual(32768)
  await expect(tool.getByRole('button', { name: '上一页', exact: true })).toBeDisabled()
  await tool.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(output).not.toContainText('BEGIN_LONG_OUTPUT')
  expect((await output.textContent())!.length).toBeLessThanOrEqual(32768)
  await tool.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(output).toContainText('END_LONG_OUTPUT')
  await expect(tool.getByRole('button', { name: '下一页', exact: true })).toBeDisabled()
  await tool.getByRole('button', { name: '上一页', exact: true }).click()
  await expect(output).not.toContainText('END_LONG_OUTPUT')
  const persisted = await page.evaluate((id) => window.hub.getSession(id), session.id)
  const event = persisted.events.find((entry) => entry.kind === 'tool')!
  expect(event.outputTruncated).toBe(true)
  expect(event.outputBytes).toBeGreaterThan(90000)
  expect(event.output!.length).toBeLessThanOrEqual(65536)
})

test('custom project checks validate JSON argv, execute through the runtime, and can be edited and rerun', async ({
  desktop,
}) => {
  const { page } = desktop
  await openTrustedProject(desktop)
  const session = await createSession(page, 'codex')
  await sendMessage(page, 'check setup')
  await expect(page.getByText('CODEX_TRANSPORT_OK 中文流式输出', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '审阅变更与检查', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '本轮变更与检查', exact: true })
  await dialog.getByText('新增或编辑自定义检查', { exact: true }).click()
  await dialog.getByLabel('检查名称', { exact: true }).fill('Custom fixture check')
  await dialog.getByLabel('可执行文件', { exact: true }).fill(process.execPath)
  await dialog.getByRole('textbox', { name: '检查参数 JSON 数组', exact: true }).fill('[1]')
  await dialog.getByRole('button', { name: '运行自定义检查', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('JSON 字符串数组')
  expect(
    await page.evaluate((id) => window.hub.listTasks(id), session.workspaceId || session.projectId),
  ).toHaveLength(0)
  const args = ['-e', "process.stdout.write('CUSTOM_CHECK_OK')"]
  await dialog
    .getByRole('textbox', { name: '检查参数 JSON 数组', exact: true })
    .fill(JSON.stringify(args))
  await dialog.getByRole('button', { name: '运行自定义检查', exact: true }).click()
  const result = dialog.locator('.task-result').first()
  await expect(result.locator('summary')).toContainText('passed')
  await result.locator('summary').click()
  await expect(result.locator('pre')).toContainText('CUSTOM_CHECK_OK')
  await dialog.getByText('新增或编辑自定义检查', { exact: true }).click()
  await result.getByRole('button', { name: '编辑并重新运行', exact: true }).click()
  await expect(
    dialog.getByRole('textbox', { name: '检查参数 JSON 数组', exact: true }),
  ).toHaveValue(JSON.stringify(args, null, 2))
  await dialog
    .getByRole('textbox', { name: '检查参数 JSON 数组', exact: true })
    .fill(JSON.stringify(['-e', "process.stdout.write('EDITED_CHECK_OK')"]))
  await dialog.getByRole('button', { name: '运行自定义检查', exact: true }).click()
  await expect(dialog.locator('.task-result')).toHaveCount(2)
  const rerun = dialog.locator('.task-result').first()
  await expect(rerun.locator('summary')).toContainText('passed')
  await rerun.locator('summary').click()
  await expect(rerun.locator('pre')).toContainText('EDITED_CHECK_OK')
})

test('one thousand stored sessions mount only visible sidebar rows and old search hits load paged history', async ({
  desktop,
}) => {
  test.setTimeout(90000)
  let { page } = desktop
  await openTrustedProject(desktop)
  const session = await createSession(page, 'codex')
  // Write a real SQLite fixture in Electron's native-module runtime. No renderer API is mocked.
  const requireModule = createRequire(resolve('package.json'))
  execFileSync(
    requireModule('electron'),
    [
      '-e',
      `
    const D=require('better-sqlite3'),crypto=require('node:crypto'),db=new D(process.argv[1]);
    const original=JSON.parse(db.prepare('SELECT data FROM sessions WHERE id=?').get(process.argv[2]).data);
    db.transaction(()=>{
      const insert=db.prepare('INSERT INTO sessions VALUES(?,?,?)');
      for(let i=0;i<999;i++){
        const row={...original,id:crypto.randomUUID(),title:'Fixture session '+String(i).padStart(4,'0'),updatedAt:original.updatedAt-i-1};
        insert.run(row.id,row.projectId,JSON.stringify(row));
      }
      const event=db.prepare('INSERT INTO events VALUES(?,?,NULL,?,?)');
      for(let i=0;i<10000;i++){
        const value={id:crypto.randomUUID(),sessionId:original.id,turnId:'fixture-'+i,kind:'text',timestamp:Date.now()+i,text:i===5?'HISTORY_NEEDLE_OLD':'History message '+i};
        event.run(value.id,original.id,i+1,JSON.stringify(value));
      }
    })();db.close();
  `,
      join(desktop.location, 'data', 'coding-hub.db'),
      session.id,
    ],
    {
      cwd: resolve('.'),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    },
  )
  await page.evaluate(async () => {
    const settings = await window.hub.getSettings()
    await window.hub.saveSettings({ ...settings, lastSessionId: undefined })
  })
  const restarted = await desktop.restart()
  page = restarted.page
  const list = page.getByRole('list', { name: '会话列表', exact: true })
  await expect(list).toHaveAttribute('data-total-count', '1000')
  const painted = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
  await painted()
  const startupMs = performance.now() - restarted.launchStartedAt
  expect(await list.getByRole('listitem').count()).toBeLessThan(50)
  const historyStart = performance.now()
  await list.locator('.session-select').first().click()
  await expect(page.locator('.conversation .assistant-message')).toHaveCount(100)
  await painted()
  const firstHistoryRenderMs = performance.now() - historyStart
  const metrics = {
    recordedAt: new Date().toISOString(),
    executionMode: process.env.CODING_HUB_PACKAGED_APP ? 'packaged' : 'source',
    packagedExecutable: process.env.CODING_HUB_PACKAGED_APP,
    sessionCount: 1000,
    conversationEvents: 10000,
    firstHistoryEvents: 100,
    startupMs,
    launchTimings: {
      ...restarted.launchTimings,
      sidebarAfterDomReadyMs: startupMs - restarted.launchTimings.domReadyMs,
    },
    rendererNavigation: await page.evaluate(() => {
      const navigation = window.performance.getEntriesByType('navigation')[0] as
        PerformanceNavigationTiming | undefined
      return navigation
        ? {
            responseEnd: navigation.responseEnd,
            domInteractive: navigation.domInteractive,
            domContentLoadedEventEnd: navigation.domContentLoadedEventEnd,
            loadEventEnd: navigation.loadEventEnd,
            visibility: document.visibilityState,
            focused: document.hasFocus(),
          }
        : undefined
    }),
    windows: await desktop.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({
        visible: window.isVisible(),
        focused: window.isFocused(),
        minimized: window.isMinimized(),
        loading: window.webContents.isLoading(),
      })),
    ),
    firstHistoryRenderMs,
    mountedSidebarRows: await list.getByRole('listitem').count(),
    machine: {
      platform: process.platform,
      arch: process.arch,
      osRelease: release(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
      node: process.versions.node,
    },
    boundaries: [
      'Actual fresh Electron process on the current host with a warm OS cache; fixture SQL, file setup and previous-process shutdown are excluded.',
      'Startup ends after the 1000-session sidebar is mounted and two animation frames; history is measured separately from UI click to 100 mounted history messages plus two animation frames.',
      'These local wall-clock gates are not evidence for fixed CI hardware, native Windows, arm64 or signed installed builds.',
    ],
  }
  await mkdir(resolve('coverage/benchmarks'), { recursive: true })
  await writeFile(
    resolve('coverage/benchmarks/desktop-full.json'),
    JSON.stringify(metrics, null, 2) + '\n',
  )
  await test.info().attach('desktop-performance', {
    body: JSON.stringify(metrics, null, 2),
    contentType: 'application/json',
  })
  console.log(
    `1000-session Electron startup ${startupMs.toFixed(1)}ms; first 100 history messages ${firstHistoryRenderMs.toFixed(1)}ms`,
  )
  expect(startupMs).toBeLessThanOrEqual(5000)
  expect(firstHistoryRenderMs).toBeLessThanOrEqual(1000)
  await expect(page.getByText('HISTORY_NEEDLE_OLD', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '加载更早的消息', exact: true })).toBeVisible()
  await list.locator('.session-select').first().focus()
  await page.keyboard.press('End')
  await expect(list.locator('[data-session-index="999"] .session-select')).toBeFocused()
  expect(await list.getByRole('listitem').count()).toBeLessThan(50)
  await page.keyboard.press('Home')
  await expect(list.locator('[data-session-index="0"] .session-select')).toBeFocused()
  await page.getByRole('textbox', { name: '搜索会话', exact: true }).fill('HISTORY_NEEDLE_OLD')
  const hit = list.locator('.session-select').first()
  await expect(hit).toContainText('HISTORY_NEEDLE_OLD')
  await hit.click()
  await expect(
    page.locator('.conversation').getByText('HISTORY_NEEDLE_OLD', { exact: true }),
  ).toBeVisible()
  // A search jump must mount a bounded window, even when the match is 9,995 events old.
  await expect(page.locator('.conversation .assistant-message')).toHaveCount(100)
  await expect(page.getByRole('region', { name: '历史片段导航', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '返回最新消息', exact: true })).toBeVisible()
  const event = page
    .locator('.conversation-event')
    .filter({ has: page.getByText('HISTORY_NEEDLE_OLD', { exact: true }) })
  await expect(event).toHaveCSS('content-visibility', 'visible')
  await expect(page.locator('.conversation-event').first()).toHaveCSS('content-visibility', 'auto')
  await mkdir(resolve('coverage/visuals'), { recursive: true })
  await page.screenshot({ path: 'coverage/visuals/product-windowed-history.png' })
  await page.getByRole('button', { name: '加载更新的消息', exact: true }).click()
  await expect(page.locator('.conversation .assistant-message')).toHaveCount(200)
  await expect(
    page.locator('.conversation').getByText('History message 199', { exact: true }),
  ).toHaveCount(1)
  await page.getByRole('button', { name: '返回最新消息', exact: true }).click()
  await expect(page.locator('.conversation .assistant-message')).toHaveCount(100)
  await expect(
    page.locator('.conversation').getByText('History message 9999', { exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('region', { name: '历史片段导航', exact: true })).toHaveCount(0)
  await expect(
    page.locator('.conversation').getByText('HISTORY_NEEDLE_OLD', { exact: true }),
  ).toHaveCount(0)
  await page.getByRole('textbox', { name: '搜索会话', exact: true }).fill('History message 5000')
  await expect(list.locator('.session-select').first()).toContainText('History message 5000')
  await list.locator('.session-select').first().click()
  await expect(
    page.locator('.conversation').getByText('History message 5000', { exact: true }),
  ).toBeVisible()
  await expect(page.locator('.conversation .assistant-message')).toHaveCount(100)
  await page.getByRole('button', { name: '加载更早的消息', exact: true }).click()
  await expect(page.locator('.conversation .assistant-message')).toHaveCount(200)
  await expect(
    page.locator('.conversation').getByText('History message 4850', { exact: true }),
  ).toHaveCount(1)
})

test('an unborn repository defaults to shared workspace and command shortcuts stay separate', async ({
  desktop,
}) => {
  execFileSync('git', ['update-ref', '-d', 'refs/heads/main'], { cwd: desktop.projectPath })
  const { page } = desktop
  await openTrustedProject(desktop)
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: '新建会话', exact: true })
  await expect(dialog.locator('#session-workspace')).toBeEnabled()
  await expect(dialog.locator('#session-workspace')).toHaveValue('shared')
  await expect(dialog.locator('option[value="isolated"]')).toBeDisabled()
  await expect(dialog).toContainText('尚无 Git 提交')
  await dialog.getByRole('button', { name: '开始会话', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await page.getByRole('button', { name: '切换代码工作区', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '快速打开文件', exact: true })).toBeVisible()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P')
  const commands = page.getByRole('dialog', { name: '命令面板', exact: true })
  await expect(commands).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+P' : 'Control+P')
  await expect(commands).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: '快速打开文件', exact: true })).toBeFocused()
})
