import { _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Explicit opt-in only. This uses the user's installed CLIs and may consume plan usage.
if (process.env.CODING_HUB_LIVE_SMOKE !== '1')
  throw new Error('Set CODING_HUB_LIVE_SMOKE=1 to run real-account smoke checks.')
const root = await mkdtemp(join(tmpdir(), 'coding-hub-live-'))
const projectPath = join(root, 'project')
await mkdir(projectPath)
const env = Object.fromEntries(
  Object.entries({ ...process.env, CODING_HUB_USER_DATA: join(root, 'data') }).filter(
    ([, value]) => value !== undefined,
  ),
)
delete env.ELECTRON_RUN_AS_NODE
const executablePath = process.env.CODING_HUB_PACKAGED_APP
const app = await electron.launch({
  executablePath,
  args: executablePath ? [] : [resolve('.')],
  env,
})
const page = await app.firstWindow()
const results = []
try {
  await page.waitForFunction(() => !!window.hub)
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
  }, projectPath)
  const project = await page.evaluate(() => window.hub.addProject())
  for (const provider of (process.env.CODING_HUB_LIVE_PROVIDERS || 'claude,codex').split(',')) {
    const model = provider === 'codex' ? process.env.CODING_HUB_CODEX_MODEL : undefined
    const session = await page.evaluate(
      ({ projectId, provider, model }) => window.hub.createSession({ projectId, provider, model }),
      { projectId: project.id, provider, model },
    )
    await page.evaluate(
      (id) =>
        window.hub.sendMessage(
          id,
          'Reply with exactly this sentence: 连接成功：Coding Hub 已接入。 Do not read files, use tools, run commands or modify anything.',
        ),
      session.id,
    )
    const end = Date.now() + 180000
    let view
    while (Date.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 750))
      view = await page.evaluate((id) => window.hub.getSession(id), session.id)
      if (!['running', 'waiting'].includes(view.session.status)) break
    }
    const text =
      view?.events
        .filter((event) => event.kind === 'text')
        .map((event) => event.text)
        .join('\n') || ''
    const errors =
      view?.events
        .filter((event) => event.kind === 'error')
        .map((event) => event.text)
        .join('\n') || ''
    const success = view?.session.status === 'idle' && !!text
    results.push({
      provider,
      success,
      status: view?.session.status,
      nativeSession: !!view?.session.nativeId,
      text,
      errors,
    })
    if (['running', 'waiting'].includes(view?.session.status))
      await page.evaluate((id) => window.hub.interrupt(id), session.id)
  }
  console.log(JSON.stringify(results, null, 2))
  if (results.some((result) => !result.success)) process.exitCode = 1
} finally {
  await app.close()
  await rm(root, { recursive: true, force: true })
}
