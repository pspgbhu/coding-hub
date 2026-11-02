import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

let app: ElectronApplication
let page: Page
let location: string
let projectPath: string
let fakeCli: string
const pageErrors: string[] = []
const fakeSource = `#!/usr/bin/env node
const readline = require('node:readline');
if (process.argv.includes('--version')) { console.log('codex-cli 0.151.0'); process.exit(0); }
const send = m => process.stdout.write(JSON.stringify(m)+'\\n');
let threadId = 'fixture-thread', turnId = 'fixture-turn', timer;
const complete = text => { send({method:'item/agentMessage/delta',params:{threadId,turnId,itemId:'answer',delta:text}}); send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}}); };
readline.createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line); const p=m.params||{};
 if(m.method==='initialize') send({id:m.id,result:{userAgent:'fixture'}});
 if(m.method==='model/list') send({id:m.id,result:{data:[{id:'fixture-model',displayName:'Fixture model'}]}});
 if(m.method==='thread/start'||m.method==='thread/resume') send({id:m.id,result:{thread:{id:p.threadId||threadId}}});
 if(m.method==='turn/start') {
  send({id:m.id,result:{turn:{id:turnId}}});
  const text=p.input?.[0]?.text||'';
  if(text.includes('approval')) send({id:800,method:'item/commandExecution/requestApproval',params:{threadId,turnId,itemId:'tool',command:'printf approved',reason:'Fixture permission request',availableDecisions:['accept','decline']}});
  else if(text.includes('long-running')) timer=setInterval(()=>{},1000);
  else if(text.includes('background')) setTimeout(()=>complete('BACKGROUND_COMPLETED'),400);
  else setTimeout(()=>complete('Hello from the real IPC and CLI transport. 中文流式输出。'),50);
 }
 if(m.id===800&&m.result) complete(m.result.decision==='accept'?'APPROVED':'DECLINED');
 if(m.method==='turn/interrupt') {clearInterval(timer);send({id:m.id,result:{}});send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'interrupted'}}});}
});
process.stdin.on('end',()=>process.exit(0));
`
async function launch() {
  const env = Object.fromEntries(
    Object.entries({ ...process.env, CODING_HUB_USER_DATA: join(location, 'data') }).filter(
      ([, value]) => value !== undefined,
    ),
  ) as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  const executablePath = process.env.CODING_HUB_PACKAGED_APP
  app = await electron.launch({ executablePath, args: executablePath ? [] : [resolve('.')], env })
  page = await app.firstWindow()
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByText('想法，从这里变成代码。')).toBeVisible()
}
test.beforeAll(async () => {
  location = await mkdtemp(join(tmpdir(), 'coding-hub-e2e-'))
  projectPath = join(location, '中文 project')
  execFileSync('git', ['init', '-b', 'main', projectPath])
  execFileSync('git', ['config', 'user.name', 'Desktop test'], { cwd: projectPath })
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: projectPath })
  await writeFile(join(projectPath, 'hello.ts'), 'export const hello = "world"\n')
  const script = join(location, 'fake-codex.cjs')
  await writeFile(script, fakeSource)
  if (process.platform === 'win32') {
    fakeCli = join(location, 'fake-codex.cmd')
    await writeFile(fakeCli, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`)
  } else {
    fakeCli = script
    await chmod(script, 0o755)
  }
  await launch()
})
test.afterAll(async () => {
  await app?.close()
  await rm(location, { recursive: true, force: true })
  expect(pageErrors).toEqual([])
})

test('desktop workspace connects UI → IPC → utility process → files, Git and CLI', async () => {
  await page.screenshot({ path: 'test-results/welcome.png' })
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [selected],
    })) as typeof dialog.showOpenDialog
  }, projectPath)
  await page.getByRole('button', { name: '打开项目', exact: true }).first().click()
  await expect(page.getByText('中文 project', { exact: true }).first()).toBeVisible()
  const project = await page.evaluate(async () => (await window.hub.bootstrap()).projects[0])
  await page.evaluate(
    async ({ fakeCli }) => {
      const settings = await window.hub.getSettings()
      await window.hub.saveSettings({
        ...settings,
        cliPaths: { ...settings.cliPaths, codex: fakeCli },
      })
    },
    { fakeCli },
  )
  const providers = await page.evaluate(() => window.hub.providers())
  expect(providers.find((p) => p.id === 'codex')?.available).toBe(true)
  const content = await page.evaluate((id) => window.hub.readFile(id, 'hello.ts'), project.id)
  expect(content.content).toContain('world')
  await page.evaluate(
    async ({ id, fingerprint }) => {
      await window.hub.saveFile(id, 'hello.ts', 'export const hello = "updated"\n', fingerprint)
      await window.hub.gitAction(id, 'stage', 'hello.ts')
    },
    { id: project.id, fingerprint: content.fingerprint },
  )
  const status = await page.evaluate((id) => window.hub.gitStatus(id), project.id)
  expect(status.files[0].index).toBe('A')
  const session = await page.evaluate(
    (id) => window.hub.createSession({ projectId: id, provider: 'codex' }),
    project.id,
  )
  // Reload exercises bootstrap restoration rather than injecting renderer state.
  await page.reload()
  await expect(page.getByPlaceholder('描述任务，交给你的 coding agent…')).toBeVisible()
  await page.getByPlaceholder('描述任务，交给你的 coding agent…').fill('Say hello')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(
    page.getByText('Hello from the real IPC and CLI transport. 中文流式输出。', { exact: true }),
  ).toBeVisible()
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.hub.getSession(id), session.id)).session.status,
    )
    .toBe('idle')
  const view = await page.evaluate((id) => window.hub.getSession(id), session.id)
  expect(view.session.nativeId).toBe('fixture-thread')
  expect(view.events.filter((e) => e.kind === 'text')).toHaveLength(1)
  await page.getByPlaceholder('描述任务，交给你的 coding agent…').fill('approval')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByText('需要你的授权', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '允许一次', exact: true }).click()
  await expect(page.getByText('APPROVED', { exact: true })).toBeVisible()
  await page.screenshot({ path: 'test-results/conversation.png' })
  await page.getByRole('button', { name: '切换代码工作区' }).click()
  await expect(page.getByText('hello.ts', { exact: true }).first()).toBeVisible()
  await page.getByText('hello.ts', { exact: true }).first().click()
  await expect(page.locator('.monaco-editor').first()).toBeVisible()
  await page.getByRole('button', { name: '切换终端' }).click()
  await expect(page.locator('.xterm-screen')).toBeVisible()
  await page.locator('.xterm-screen').click()
  await page.keyboard.type("node -e \"console.log('HUB_'+'TERMINAL_OK')\"")
  await page.keyboard.press('Enter')
  await expect(page.locator('.xterm-rows')).toContainText('HUB_TERMINAL_OK')
  await page.screenshot({ path: 'test-results/workspace.png' })
  await page.getByRole('button', { name: '切换终端' }).click()
  await page.getByRole('button', { name: '切换终端' }).click()
  await expect(page.locator('.xterm-rows')).toContainText('HUB_TERMINAL_OK')
  // Persistence survives renderer restarts and terminal work does not alter agent history.
  await page.reload()
  await expect(page.getByText('APPROVED', { exact: true })).toBeVisible()
  expect(
    (await page.evaluate((id) => window.hub.getSession(id), session.id)).session.nativeId,
  ).toBe('fixture-thread')
  await page.evaluate(async () => {
    const settings = await window.hub.getSettings()
    await window.hub.saveSettings({ ...settings, theme: 'dark' })
  })
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByRole('button', { name: '切换代码工作区' }).click()
  await page.getByText('hello.ts', { exact: true }).first().click()
  await page.screenshot({ path: 'test-results/workspace-dark.png' })
})

test('interrupt, archive and security boundaries remain consistent', async () => {
  const { sessions } = await page.evaluate(() => window.hub.bootstrap())
  const id = sessions[0].id
  await page.evaluate((id) => window.hub.sendMessage(id, 'long-running'), id)
  await expect(page.getByRole('button', { name: '停止执行' })).toBeVisible()
  const blocked = await page.evaluate(async (id) => {
    try {
      await window.hub.gitAction(id, 'checkout', 'main')
      return false
    } catch {
      return true
    }
  }, sessions[0].projectId)
  expect(blocked).toBe(true)
  await page.getByRole('button', { name: '停止执行' }).click()
  await expect
    .poll(async () => (await page.evaluate((id) => window.hub.getSession(id), id)).session.status)
    .toBe('interrupted')
  const errors = await page.evaluate(async () => {
    const project = (await window.hub.bootstrap()).projects[0]
    const result: string[] = []
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
  expect(errors).toEqual(['path', 'url'])
  await page.evaluate(
    (id) => window.hub.updateSession(id, { title: 'Persistent renamed session' }),
    id,
  )
  await expect(page.getByText('Persistent renamed session').first()).toBeVisible()
  await page.getByTitle('会话操作', { exact: true }).first().click()
  await page.getByRole('button', { name: '归档会话', exact: true }).click()
  await page.getByTitle('查看已归档会话', { exact: true }).click()
  await expect(page.getByText('Persistent renamed session').first()).toBeVisible()
  await page.getByPlaceholder('搜索标题与对话内容').fill('中文流式输出')
  await expect(page.locator('.session-select')).toHaveCount(1)
})

test('parallel sessions and closing the window keep background work alive', async () => {
  const project = await page.evaluate(async () => (await window.hub.bootstrap()).projects[0])
  const ids = await page.evaluate(async (projectId) => {
    const sessions = await Promise.all([
      window.hub.createSession({ projectId, provider: 'codex' }),
      window.hub.createSession({ projectId, provider: 'codex' }),
    ])
    await Promise.all(
      sessions.map((session, index) =>
        window.hub.sendMessage(session.id, `background task ${index}`),
      ),
    )
    await window.hub.windowAction('close')
    return sessions.map((session) => session.id)
  }, project.id)
  expect(
    await app.browserWindow(page).then((window) => window.evaluate((window) => window.isVisible())),
  ).toBe(false)
  for (const id of ids)
    await expect
      .poll(async () => (await page.evaluate((id) => window.hub.getSession(id), id)).session.status)
      .toBe('idle')
  for (const id of ids)
    expect(
      (await page.evaluate((id) => window.hub.getSession(id), id)).events
        .filter((event) => event.kind === 'text')
        .map((event) => event.text),
    ).toEqual(['BACKGROUND_COMPLETED'])
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].show()
  })
  await page.reload()
  await expect(page.getByText('BACKGROUND_COMPLETED', { exact: true })).toBeVisible()
})
