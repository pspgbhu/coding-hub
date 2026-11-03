import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import type { ProcessOwnership } from '../../src/runtime/process'
import { test, expect, openTrustedProject, createSession, sendMessage } from './fixtures'

interface RuntimeIdentity {
  pid: number
  creationTime: number
}
async function runtimeIdentity(app: ElectronApplication): Promise<RuntimeIdentity> {
  const observed = await app.evaluate(({ app }) => ({
    mainPid: process.pid,
    metrics: app.getAppMetrics().map(({ pid, type, name, serviceName, creationTime }) => ({
      pid,
      type,
      name,
      serviceName,
      creationTime,
    })),
  }))
  await test.info().attach('application-process-metadata', {
    body: JSON.stringify(observed, null, 2),
    contentType: 'application/json',
  })
  const candidates = observed.metrics
    .filter(
      (entry) =>
        entry.type === 'Utility' &&
        (entry.name === 'Coding Hub Runtime' || entry.serviceName === 'Coding Hub Runtime'),
    )
    .map(({ pid, creationTime }) => ({ pid, creationTime }))
  expect(
    candidates,
    `Only this application's uniquely named Runtime may be targeted; process metadata: ${JSON.stringify(observed)}`,
  ).toHaveLength(1)
  expect(candidates[0].pid).toBeGreaterThan(1)
  return candidates[0]
}
async function readIfPresent(path: string): Promise<string> {
  return readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
}
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

test('a forced renderer crash automatically reloads persisted drafts and keeps the same live PTY', async ({
  desktop,
}) => {
  test.setTimeout(90000)
  const { app, page } = desktop
  await openTrustedProject(desktop)
  const session = await createSession(page, 'codex')
  await sendMessage(page, 'renderer crash preparation')
  await expect(page.getByText('CODEX_TRANSPORT_OK 中文流式输出', { exact: true })).toBeVisible()
  const workspaceId = session.workspaceId || session.projectId
  const draft = 'CRASH_CONFIRMED_PERSISTED_DRAFT'
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill(draft)
  await page.getByRole('button', { name: '切换代码工作区', exact: true }).click()
  await page.getByRole('treeitem', { name: 'hello.ts', exact: true }).click()
  const editor = page.locator('.workspace:visible .monaco-editor').first()
  await expect(editor).toBeVisible()
  await editor.click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await page.keyboard.insertText('export const hello = "CRASH_UNSAVED_EDITOR"\n')
  await expect
    .poll(async () => (await page.evaluate((id) => window.hub.getDraft(id), session.id)).text)
    .toBe(draft)
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.hub.getEditorState(id), workspaceId))?.files.find(
          (file) => file.path === 'hello.ts',
        )?.edited,
    )
    .toContain('CRASH_UNSAVED_EDITOR')
  expect(await readFile(join(desktop.projectPath, 'hello.ts'), 'utf8')).toContain('world')

  await page.getByRole('button', { name: '切换终端', exact: true }).click()
  await expect(page.locator('.xterm-screen:visible')).toBeVisible()
  await page.locator('.xterm-screen:visible').click()
  await page.keyboard.type("node -e \"console.log('RENDERER_'+'BEFORE_CRASH')\"")
  await page.keyboard.press('Enter')
  await expect(page.locator('.xterm-rows:visible')).toContainText('RENDERER_BEFORE_CRASH')
  const terminals = (await page.evaluate((id) => window.hub.terminalList(id), workspaceId))
    .filter((entry) => entry.exitCode === undefined)
    .map((entry) => entry.id)
  expect(terminals).toHaveLength(1)
  const runtime = await runtimeIdentity(app)

  const windowIdentity = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    const state = {
      windowId: window.id,
      contentsId: window.webContents.id,
      rendererPid: window.webContents.getOSProcessId(),
      gone: [] as string[],
      loaded: false,
      errors: [] as string[],
    }
    ;(globalThis as unknown as { __hubRendererCrash: typeof state }).__hubRendererCrash = state
    window.webContents.once('render-process-gone', (_event, details) => {
      state.gone.push(details.reason)
    })
    window.webContents.once('did-finish-load', () => {
      state.loaded = true
    })
    window.webContents.on('console-message', (details) => {
      if (details.level === 'error') state.errors.push(details.message)
    })
    window.webContents.on('preload-error', (_event, _path, error) => {
      state.errors.push(error.message)
    })
    return {
      windowId: state.windowId,
      contentsId: state.contentsId,
      rendererPid: state.rendererPid,
    }
  })
  // This is a real process fault. Production render-process-gone must reload the
  // window; the test deliberately never calls page.reload or webContents.reload.
  await app.evaluate(({ BrowserWindow }, id) => {
    const window = BrowserWindow.fromId(id)
    if (!window) throw new Error('The original application window is missing')
    window.webContents.forcefullyCrashRenderer()
  }, windowIdentity.windowId)
  await expect
    .poll(
      () =>
        app.evaluate(
          () =>
            (globalThis as unknown as { __hubRendererCrash: { loaded: boolean; gone: string[] } })
              .__hubRendererCrash,
        ),
      { timeout: 20000 },
    )
    .toMatchObject({ loaded: true, gone: [expect.stringMatching(/^(?:crashed|killed)$/)] })

  // Playwright marks its original Page execution scope permanently crashed.
  // Inspect the recovered real DOM via the surviving main process, rather than
  // restarting the application or hiding subsequent renderer errors.
  const recoveredDOM = () =>
    app.evaluate(({ BrowserWindow }, id) => {
      const window = BrowserWindow.fromId(id)
      if (!window) throw new Error('The original application window is missing')
      return window.webContents.executeJavaScript(`(() => {
        const workspace = document.querySelector('.workspace');
        if (!workspace?.getClientRects().length) document.querySelector('button[aria-label="切换代码工作区"]')?.click();
        const terminal = document.querySelector('.terminal-panel');
        if (!terminal?.getClientRects().length) document.querySelector('button[aria-label="切换终端"]')?.click();
        return {
          draft: document.querySelector('textarea[aria-label="消息输入框"]')?.value,
          editor: document.querySelector('.workspace .monaco-editor .view-lines')?.textContent,
          terminal: document.querySelector('.terminal-panel .xterm-rows')?.textContent,
          terminalConnecting: Array.from(document.querySelectorAll('.terminal-panel [role="status"]'))
            .some((entry) => entry.textContent?.includes('正在重新连接'))
        };
      })()`)
    }, windowIdentity.windowId)
  await expect.poll(recoveredDOM, { timeout: 20000 }).toMatchObject({
    draft,
    editor: expect.stringContaining('CRASH_UNSAVED_EDITOR'),
    terminal: expect.stringContaining('RENDERER_BEFORE_CRASH'),
    terminalConnecting: false,
  })
  const recoveredIdentity = await app.evaluate(({ BrowserWindow }, id) => {
    const window = BrowserWindow.fromId(id)!
    return { contentsId: window.webContents.id, rendererPid: window.webContents.getOSProcessId() }
  }, windowIdentity.windowId)
  expect(recoveredIdentity.contentsId).toBe(windowIdentity.contentsId)
  expect(recoveredIdentity.rendererPid).not.toBe(windowIdentity.rendererPid)
  expect(await runtimeIdentity(app)).toEqual(runtime)
  const recoveredTerminals = await app.evaluate(
    ({ BrowserWindow }, input) =>
      BrowserWindow.fromId(input.windowId)!.webContents.executeJavaScript(
        `window.hub.terminalList(${JSON.stringify(input.workspaceId)})`,
      ),
    { windowId: windowIdentity.windowId, workspaceId },
  )
  expect(
    recoveredTerminals
      .filter((entry: { exitCode?: number }) => entry.exitCode === undefined)
      .map((entry: { id: string }) => entry.id),
  ).toEqual(terminals)

  await app.evaluate(async ({ BrowserWindow }, id) => {
    const window = BrowserWindow.fromId(id)!
    window.show()
    window.focus()
    window.webContents.focus()
    const focused = await window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('.terminal-panel .xterm-helper-textarea');
      input?.focus(); return document.activeElement === input;
    })()`)
    if (!focused) throw new Error('The restored terminal input did not receive focus')
    for (const keyCode of "node -e \"console.log('RENDERER_'+'AFTER_CRASH')\"")
      window.webContents.sendInputEvent({ type: 'char', keyCode })
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  }, windowIdentity.windowId)
  await expect.poll(recoveredDOM, { timeout: 15000 }).toMatchObject({
    terminal: expect.stringContaining('RENDERER_AFTER_CRASH'),
  })
  expect(await runtimeIdentity(app)).toEqual(runtime)
  expect(
    await app.evaluate(
      () =>
        (globalThis as unknown as { __hubRendererCrash: { errors: string[] } }).__hubRendererCrash
          .errors,
    ),
  ).toEqual([])
  // The fixture also retains its strict pageerror assertion. Only the explicit
  // render-process-gone fault above is expected; JavaScript errors are not ignored.
})

test('a killed owned Runtime cleans its CLI and PTY, then reconnects without replaying the interrupted turn', async ({
  desktop,
}) => {
  test.setTimeout(120000)
  const { app, page, location } = desktop
  await openTrustedProject(desktop)
  const session = await createSession(page, 'codex')
  const workspaceId = session.workspaceId || session.projectId
  const verificationWorkspace = await page.evaluate(
    (projectId) => window.hub.createWorkspace(projectId),
    session.projectId,
  )
  expect(verificationWorkspace.kind).toBe('worktree')
  expect(verificationWorkspace.id).not.toBe(workspaceId)
  const verification = await page.evaluate(
    ({ workspaceId, command }) =>
      window.hub.runTask(workspaceId, {
        id: 'runtime-crash-check',
        name: 'runtime crash verification',
        command,
        args: ['-e', "console.log('RUNTIME_CHECK_PID:'+process.pid);setInterval(()=>{},1000)"],
      }),
    { workspaceId: verificationWorkspace.id, command: process.execPath },
  )
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.hub.listTasks(id), verificationWorkspace.id)).find(
          (task) => task.id === verification.id,
        )?.output,
      { timeout: 15000 },
    )
    .toContain('RUNTIME_CHECK_PID:')
  const verificationBefore = (
    await page.evaluate((id) => window.hub.listTasks(id), verificationWorkspace.id)
  ).find((task) => task.id === verification.id)!
  expect(verificationBefore.status).toBe('running')
  const verificationProcess = Number(/RUNTIME_CHECK_PID:(\d+)/.exec(verificationBefore.output)?.[1])
  expect(verificationProcess).toBeGreaterThan(1)
  await page.getByRole('button', { name: '切换终端', exact: true }).click()
  await expect(page.locator('.xterm-screen:visible')).toBeVisible()
  await page.locator('.xterm-screen:visible').click()
  await page.keyboard.type(
    "node -e \"console.log('RUNTIME_PTY_'+'PID:'+process.pid);setInterval(()=>{},1000)\"",
  )
  await page.keyboard.press('Enter')
  await expect(page.locator('.xterm-rows:visible')).toContainText('RUNTIME_PTY_PID:')
  const terminalProcess = Number(
    /RUNTIME_PTY_PID:(\d+)/.exec(await page.locator('.xterm-rows:visible').innerText())?.[1],
  )
  expect(terminalProcess).toBeGreaterThan(1)
  const oldTerminals = (await page.evaluate((id) => window.hub.terminalList(id), workspaceId))
    .filter((entry) => entry.exitCode === undefined)
    .map((entry) => entry.id)
  expect(oldTerminals).toHaveLength(1)

  const oldInput = 'write-file long-running-review RUNTIME_FAULT_ONLY_ONCE'
  await sendMessage(page, oldInput)
  const turnLog = join(location, 'codex.cjs.turns')
  const recordedTurns = async () =>
    (await readIfPresent(turnLog)).trim().split('\n').filter(Boolean)
  await expect.poll(recordedTurns).toHaveLength(1)
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.hub.getSession(id), session.id)).session.status,
    )
    .toBe('running')
  const before = await page.evaluate((id) => window.hub.getSession(id), session.id)
  expect(before.session.nativeId).toBeTruthy()
  expect(before.session.activeTurnId).toBeTruthy()
  const ownershipPath = join(location, 'data', 'owned-processes.json')
  const readOwners = async (): Promise<ProcessOwnership[]> =>
    JSON.parse((await readIfPresent(ownershipPath)) || '[]')
  await expect
    .poll(async () => (await readOwners()).length, { timeout: 15000 })
    .toBeGreaterThanOrEqual(3)
  const owners = await readOwners()
  expect(owners.some((owner) => owner.pid === verificationProcess)).toBe(true)
  for (const owner of owners) {
    expect(owner.pid).toBeGreaterThan(1)
    expect(owner.started).toBeTruthy()
  }
  const runtime = await runtimeIdentity(app)
  // Match both PID and birth time again immediately before the only destructive
  // signal, and only against Electron's metrics for this application's Runtime.
  await app.evaluate(({ app }, expected) => {
    const matches = app
      .getAppMetrics()
      .filter(
        (entry) =>
          entry.type === 'Utility' &&
          (entry.name === 'Coding Hub Runtime' || entry.serviceName === 'Coding Hub Runtime'),
      )
    if (
      matches.length !== 1 ||
      matches[0].pid !== expected.pid ||
      matches[0].creationTime !== expected.creationTime
    )
      throw new Error('Refusing to kill an unverified or replaced Runtime')
    process.kill(expected.pid, 'SIGKILL')
  }, runtime)

  await expect(page.getByRole('button', { name: '重试连接', exact: true })).toBeVisible({
    timeout: 20000,
  })
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.hub.getSession(id), session.id)).session.status,
      { timeout: 20000 },
    )
    .toMatch(/^(?:interrupted|stop_failed)$/)
  const stopped = await page.evaluate((id) => window.hub.getSession(id), session.id)
  expect(
    stopped.events.filter((event) => event.kind === 'user' && event.text === oldInput),
  ).toHaveLength(1)
  expect(await recordedTurns()).toHaveLength(1)
  if (stopped.session.status === 'stop_failed') {
    const blocked = await page.evaluate(async (id) => {
      try {
        await window.hub.sendMessage(id, 'MUST_NOT_RUN_WHILE_STOP_FAILED')
        return false
      } catch {
        return true
      }
    }, session.id)
    expect(blocked, 'Unconfirmed cleanup must keep the shared workspace locked').toBe(true)
  }
  await page.getByRole('button', { name: '重试连接', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => window.hub.health()), { timeout: 30000 })
    .toMatchObject({ runtime: 'ready', storage: 'ready' })
  if (
    (await page.evaluate((id) => window.hub.getSession(id), session.id)).session.status ===
    'stop_failed'
  ) {
    await page.getByRole('button', { name: '停止执行', exact: true }).click()
  }
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.hub.getSession(id), session.id)).session.status,
      { timeout: 20000 },
    )
    .toBe('interrupted')
  await expect
    .poll(
      () =>
        owners.every((owner) => !isAlive(owner.pid)) &&
        !isAlive(terminalProcess) &&
        !isAlive(verificationProcess),
      {
        timeout: 20000,
      },
    )
    .toBe(true)
  expect(await readOwners()).toEqual([])
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.hub.listTasks(id), verificationWorkspace.id)).find(
          (task) => task.id === verification.id,
        )?.status,
      { timeout: 15000 },
    )
    .toBe('cancelled')
  const cancelled = (
    await page.evaluate((id) => window.hub.listTasks(id), verificationWorkspace.id)
  ).find((task) => task.id === verification.id)!
  expect(cancelled.finishedAt).toBeGreaterThanOrEqual(verificationBefore.startedAt)
  const replacement = await runtimeIdentity(app)
  expect(replacement).not.toEqual(runtime)
  const currentTerminals = await page.evaluate((id) => window.hub.terminalList(id), workspaceId)
  expect(
    currentTerminals.filter(
      (entry) => oldTerminals.includes(entry.id) && entry.exitCode === undefined,
    ),
  ).toHaveLength(0)
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(({ sessionId, turnId }) => window.hub.getReview(sessionId, turnId), {
            sessionId: session.id,
            turnId: before.session.activeTurnId!,
          })
        )?.finishedAt,
      { timeout: 20000 },
    )
    .toBeTruthy()
  expect(await recordedTurns()).toHaveLength(1)

  const rerun = await page.evaluate(
    ({ workspaceId, command }) =>
      window.hub.runTask(workspaceId, {
        id: 'runtime-recovered-check',
        name: 'verification after runtime recovery',
        command,
        args: ['-e', "console.log('VERIFICATION_AFTER_RUNTIME_CRASH')"],
      }),
    { workspaceId: verificationWorkspace.id, command: process.execPath },
  )
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.hub.listTasks(id), verificationWorkspace.id)).find(
          (task) => task.id === rerun.id,
        ),
      { timeout: 20000 },
    )
    .toMatchObject({
      status: 'passed',
      exitCode: 0,
      output: expect.stringContaining('VERIFICATION_AFTER_RUNTIME_CRASH'),
    })

  await sendMessage(page, 'fresh task after verified runtime recovery')
  await expect(page.getByText('CODEX_TRANSPORT_OK 中文流式输出', { exact: true })).toBeVisible({
    timeout: 20000,
  })
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.hub.getSession(id), session.id)).session.status,
    )
    .toBe('idle')
  const recovered = await page.evaluate((id) => window.hub.getSession(id), session.id)
  expect(recovered.session.nativeId).toBe(before.session.nativeId)
  expect(
    recovered.events.filter((event) => event.kind === 'user' && event.text === oldInput),
  ).toHaveLength(1)
  expect(
    recovered.events.filter(
      (event) => event.kind === 'user' && event.text === 'MUST_NOT_RUN_WHILE_STOP_FAILED',
    ),
  ).toHaveLength(0)
  expect(await recordedTurns()).toHaveLength(1)
})
