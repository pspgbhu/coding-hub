import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { arch, cpus, release, tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { _electron as electron } from '@playwright/test'

if (process.platform !== 'darwin')
  throw new Error('This installation smoke runs only on native macOS.')
const run = promisify(execFile)
const requireModule = createRequire(resolve('package.json'))
const electronNode = requireModule('electron')
const options = process.argv.slice(2)
const option = (name, fallback) => {
  const index = options.indexOf(name)
  if (index < 0) return resolve(fallback)
  if (!options[index + 1] || options[index + 1].startsWith('--'))
    throw new Error(`Missing value for ${name}`)
  return resolve(options[index + 1])
}
for (let i = 0; i < options.length; i += 2)
  if (!['--old-dmg', '--new-dmg', '--output'].includes(options[i]))
    throw new Error(`Unknown option ${options[i]}`)
const oldDmg = option('--old-dmg', 'release/Coding Hub-0.1.0.dmg')
const newDmg = option('--new-dmg', 'release/Coding Hub-0.1.1.dmg')
const output = option('--output', 'coverage/installation/macos-x64.json')
const report = {
  recordedAt: new Date().toISOString(),
  status: 'running',
  machine: {
    platform: process.platform,
    arch: arch(),
    osRelease: release(),
    cpu: cpus()[0]?.model,
  },
  artifacts: {},
  assertions: {},
  phases: [],
  boundaries: [
    'Both supplied local DMGs are mounted read-only and copied with ditto into a private temporary Applications directory; the user Applications directory and default user data are never used.',
    'Tests a native macOS copy/replace application lifecycle on this host. It does not test Gatekeeper, quarantine, notarization, a production signing identity, an update-feed download, Windows NSIS, arm64 hardware or a Finder UI drag gesture.',
    'No real Agent account or installed Agent CLI is used: every CLI path points at an isolated nonexistent executable, and common inherited credential environment variables are filtered.',
    'Uninstall means deleting the temporary .app bundle and checking that its separate userData still exists. Fixture userData is removed only by final test cleanup after that assertion.',
  ],
}
const taskRoot = await realpath(await mkdtemp(join(tmpdir(), 'coding-hub-macos-install-')))
const applications = join(taskRoot, 'Applications')
const installedApp = join(applications, 'Coding Hub.app')
const executable = join(installedApp, 'Contents', 'MacOS', 'Coding Hub')
const userData = join(taskRoot, 'isolated-user-data')
const database = join(userData, 'coding-hub.db')
const projectPath = join(taskRoot, '中文 legacy project')
const mounted = []
let current
let failure
await mkdir(applications)
await mkdir(userData, { mode: 0o700 })
await mkdir(projectPath)
await mkdir(join(taskRoot, 'empty-zsh'))
await writeFile(join(projectPath, 'hello.ts'), 'export const hello = "original on disk"\n')
const fixture = {
  project: {
    id: randomUUID(),
    path: projectPath,
    name: '安装升级 验证项目',
    createdAt: Date.now(),
  },
  session: {
    id: randomUUID(),
    provider: 'codex',
    title: '旧版中文会话',
    nativeId: `native-install-${randomUUID()}`,
    status: 'idle',
    archived: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  events: [],
  settings: {},
}
fixture.session.projectId = fixture.project.id
fixture.session.activeTurnId = randomUUID()
fixture.events = [
  { kind: 'user', text: '旧版中文任务：请保留这段历史。' },
  { kind: 'text', text: '旧版中文历史：升级后仍保留。' },
  { kind: 'done', status: 'idle' },
].map((value, index) => ({
  id: randomUUID(),
  sessionId: fixture.session.id,
  turnId: fixture.session.activeTurnId,
  timestamp: Date.now() + index,
  ...value,
}))
fixture.settings = {
  theme: 'dark',
  lastProjectId: fixture.project.id,
  lastSessionId: fixture.session.id,
  cliPaths: Object.fromEntries(
    ['codex', 'claude', 'opencode'].map((provider) => [
      provider,
      join(taskRoot, `never-run-${provider}`),
    ]),
  ),
}
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) =>
      value !== undefined &&
      !/(?:api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|server[_-]?password|^GH_TOKEN$|^GITHUB_TOKEN$)/i.test(
        key,
      ),
  ),
)
delete env.ELECTRON_RUN_AS_NODE
env.CODING_HUB_USER_DATA = userData
env.ZDOTDIR = join(taskRoot, 'empty-zsh')

async function hash(path) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}
async function nodeSql(script, ...args) {
  const result = await run(electronNode, ['-e', script, ...args], {
    cwd: resolve('.'),
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    maxBuffer: 4 * 1024 * 1024,
  })
  return JSON.parse(result.stdout.trim())
}
const sqliteModule = requireModule.resolve('better-sqlite3')
async function seed() {
  return nodeSql(
    `
    const D=require(process.argv[1]),db=new D(process.argv[2]),f=JSON.parse(process.argv[3]);
    db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,path TEXT UNIQUE NOT NULL,data TEXT NOT NULL);CREATE TABLE sessions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),data TEXT NOT NULL);CREATE TABLE events(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),stream_key TEXT,ordinal INTEGER NOT NULL,data TEXT NOT NULL);CREATE TABLE settings(key TEXT PRIMARY KEY,data TEXT NOT NULL);PRAGMA user_version=1;');
    db.prepare('INSERT INTO projects VALUES(?,?,?)').run(f.project.id,f.project.path,JSON.stringify(f.project));
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(f.session.id,f.project.id,JSON.stringify(f.session));
    f.events.forEach((event,index)=>db.prepare('INSERT INTO events VALUES(?,?,NULL,?,?)').run(event.id,f.session.id,index+1,JSON.stringify(event)));
    db.prepare("INSERT INTO settings VALUES('app',?)").run(JSON.stringify(f.settings));
    console.log(JSON.stringify({schemaVersion:db.pragma('user_version',{simple:true}),electron:process.versions.electron,node:process.versions.node}));db.close();
  `,
    sqliteModule,
    database,
    JSON.stringify(fixture),
  )
}
async function stored() {
  return nodeSql(
    `
    const D=require(process.argv[1]),db=new D(process.argv[2],{readonly:true});
    const rows=table=>db.prepare('SELECT data FROM '+table).all().map(row=>JSON.parse(row.data));
    const exists=table=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
    console.log(JSON.stringify({schemaVersion:db.pragma('user_version',{simple:true}),integrity:db.pragma('integrity_check',{simple:true}),projects:rows('projects'),sessions:rows('sessions'),events:rows('events'),settings:JSON.parse(db.prepare("SELECT data FROM settings WHERE key='app'").get().data),drafts:exists('composer_drafts')?rows('composer_drafts'):[],editors:exists('editor_states')?rows('editor_states'):[]}));db.close();
  `,
    sqliteModule,
    database,
  )
}
async function mount(dmg, label) {
  const mountpoint = join(taskRoot, `mount-${label}`)
  await mkdir(mountpoint)
  await run(
    '/usr/bin/hdiutil',
    ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mountpoint, dmg],
    { maxBuffer: 4 * 1024 * 1024 },
  )
  mounted.push(mountpoint)
  const app = join(mountpoint, 'Coding Hub.app')
  assert(existsSync(app), `${label} DMG must contain Coding Hub.app`)
  return app
}
async function copyApplication(source) {
  assert(installedApp.startsWith(taskRoot + sep))
  await rm(installedApp, { recursive: true, force: true })
  await run('/usr/bin/ditto', [source, installedApp])
}
async function launch(expectedVersion) {
  current = await electron.launch({ executablePath: executable, args: [], env, timeout: 60000 })
  const running = current
  running.once('close', () => {
    if (current === running) current = undefined
  })
  const page = await running.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.hub?.bootstrap))
  const info = await running.evaluate(({ app }) => ({
    version: app.getVersion(),
    arch: process.arch,
    electron: process.versions.electron,
    userData: app.getPath('userData'),
    appPath: app.getAppPath(),
  }))
  assert.equal(info.version, expectedVersion)
  assert.equal(await realpath(info.userData), userData)
  assert(
    info.appPath.startsWith(installedApp + sep),
    'The copied temporary application must be running',
  )
  const snapshot = await page.evaluate((id) => window.hub.getSession(id), fixture.session.id)
  assert.equal(snapshot.session.nativeId, fixture.session.nativeId)
  assert(snapshot.events.some((event) => event.text === fixture.events[1].text))
  await page.getByText(fixture.events[1].text, { exact: true }).waitFor({ state: 'visible' })
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  return { page, info }
}
async function close() {
  await current?.close()
  current = undefined
}
function preserved(value, expectedSchema) {
  assert.equal(value.schemaVersion, expectedSchema)
  assert.equal(value.integrity, 'ok')
  assert.equal(
    value.projects.find((project) => project.id === fixture.project.id)?.path,
    projectPath,
  )
  assert.equal(
    value.sessions.find((session) => session.id === fixture.session.id)?.nativeId,
    fixture.session.nativeId,
  )
  assert.equal(value.settings.theme, 'dark')
  for (const event of fixture.events)
    assert(
      value.events.some(
        (stored) =>
          stored.id === event.id && stored.text === event.text && stored.kind === event.kind,
      ),
    )
}

try {
  for (const [key, path] of [
    ['old', oldDmg],
    ['new', newDmg],
  ]) {
    assert(existsSync(path), `Missing complete installer ${path}`)
    report.artifacts[key] = { path, file: basename(path), sha256: await hash(path) }
  }
  console.log('Mounting local old/new DMGs read-only into private temporary locations.')
  const oldBundle = await mount(oldDmg, 'old')
  const newBundle = await mount(newDmg, 'new')
  report.seedRuntime = await seed()
  await copyApplication(oldBundle)
  const installedArchitecture = (await run('/usr/bin/file', ['-b', executable])).stdout.trim()
  console.log('Opening copied 0.1.0 with isolated v1 data and Chinese history.')
  const old = await launch('0.1.0')
  await old.page.screenshot({ path: resolve('coverage/installation/old-0.1.0.png') })
  await close()
  preserved(await stored(), 1)
  report.phases.push({
    phase: 'old-installed-app',
    ...old.info,
    executableArchitecture: installedArchitecture,
    schemaVersion: 1,
    chineseHistoryVisible: true,
    themeVisible: 'dark',
  })
  console.log('Replacing only the temporary .app with copied 0.1.1; userData stays in place.')
  await copyApplication(newBundle)
  const upgraded = await launch('0.1.1')
  const catalog = await upgraded.page.evaluate(() => window.hub.bootstrap())
  assert.equal(
    catalog.workspaces.find((workspace) => workspace.id === fixture.project.id)?.cwd,
    projectPath,
  )
  preserved(await stored(), 2)
  const draftText = '新版未发送草稿：退出和升级后继续。'
  const edited = 'export const hello = "UPGRADED_UNSAVED_BUFFER"\n'
  await upgraded.page.evaluate(
    async ({ sessionId, workspaceId, draftText, edited }) => {
      const file = await window.hub.readFile(workspaceId, 'hello.ts')
      await window.hub.saveDraft(sessionId, {
        text: draftText,
        context: [
          {
            id: 'upgrade-reference',
            kind: 'file',
            name: 'hello.ts',
            path: 'hello.ts',
            content: file.content,
          },
        ],
        updatedAt: Date.now(),
      })
      await window.hub.saveEditorState(workspaceId, {
        files: [{ ...file, edited }],
        active: 'hello.ts',
        mode: 'files',
        updatedAt: Date.now(),
      })
    },
    { sessionId: fixture.session.id, workspaceId: fixture.project.id, draftText, edited },
  )
  report.phases.push({
    phase: 'new-app-upgraded-in-place',
    ...upgraded.info,
    schemaVersion: 2,
    legacyWorkspaceCwd: projectPath,
  })
  await close()
  console.log('Reopening installed 0.1.1 to confirm draft and editor recovery.')
  const reopened = await launch('0.1.1')
  await reopened.page.waitForFunction(
    (text) => document.querySelector('textarea[aria-label="消息输入框"]')?.value === text,
    draftText,
  )
  const recovered = await reopened.page.evaluate(
    async ({ sessionId, workspaceId }) => ({
      draft: await window.hub.getDraft(sessionId),
      editor: await window.hub.getEditorState(workspaceId),
    }),
    { sessionId: fixture.session.id, workspaceId: fixture.project.id },
  )
  assert.equal(recovered.draft.text, draftText)
  assert.equal(recovered.draft.context[0].content, 'export const hello = "original on disk"\n')
  assert.equal(recovered.editor.files[0].edited, edited)
  await reopened.page.getByRole('button', { name: '切换代码工作区', exact: true }).click()
  await reopened.page.waitForFunction(() =>
    [...document.querySelectorAll('.monaco-editor .view-lines')].some((element) =>
      element.textContent.includes('UPGRADED_UNSAVED_BUFFER'),
    ),
  )
  await reopened.page.screenshot({
    path: resolve('coverage/installation/upgraded-reopened-0.1.1.png'),
  })
  assert.equal(
    await readFile(join(projectPath, 'hello.ts'), 'utf8'),
    'export const hello = "original on disk"\n',
  )
  await close()
  report.phases.push({
    phase: 'new-app-reopened',
    ...reopened.info,
    draftRecovered: true,
    contextRecovered: true,
    editorBufferRecovered: true,
    originalProjectFileUnchanged: true,
  })
  await rm(installedApp, { recursive: true })
  assert(!existsSync(installedApp))
  assert(existsSync(database))
  const retained = await stored()
  preserved(retained, 2)
  assert.equal(retained.drafts[0].text, draftText)
  assert.equal(retained.editors[0].files[0].edited, edited)
  report.assertions = {
    oldVersionActuallyLaunched: true,
    newVersionActuallyLaunched: true,
    sameTemporaryAppPathReplaced: true,
    schema1To2: true,
    projectIdPreserved: true,
    canonicalCwdPreserved: true,
    sessionIdAndNativeIdPreserved: true,
    chineseEventIdsAndTextPreserved: true,
    darkThemePreserved: true,
    newDraftContextAndEditorRecoveredAfterQuit: true,
    unsavedProjectFileUntouched: true,
    uninstallRemovedAppOnly: true,
    userDataRetainedAfterAppRemoval: true,
  }
  report.status = 'passed'
} catch (error) {
  failure = error
  report.status = 'failed'
  report.error = error instanceof Error ? error.message : String(error)
} finally {
  const cleanupErrors = []
  try {
    await close()
  } catch (error) {
    cleanupErrors.push(String(error))
  }
  for (const mountpoint of mounted.reverse()) {
    try {
      await run('/usr/bin/hdiutil', ['detach', mountpoint])
    } catch {
      try {
        await run('/usr/bin/hdiutil', ['detach', '-force', mountpoint])
      } catch (error) {
        cleanupErrors.push(`Unable to detach private mount ${mountpoint}: ${String(error)}`)
      }
    }
  }
  if (!cleanupErrors.length) await rm(taskRoot, { recursive: true, force: true })
  report.cleanup = { temporaryFixtureRemoved: !existsSync(taskRoot), errors: cleanupErrors }
  if (cleanupErrors.length) {
    report.status = 'failed'
    failure ??= new Error('Temporary installation cleanup was incomplete')
  }
  await mkdir(resolve(output, '..'), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  console.log(`Installation report: ${output}`)
}
if (failure) {
  console.error(failure)
  process.exitCode = 1
}
