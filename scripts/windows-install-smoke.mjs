import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { arch, cpus, release } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { _electron as electron } from '@playwright/test'
import { normalizeRegistryRows } from './windows-install-registry.cjs'

if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('This installation smoke requires native Windows x64.')
assert(
  process.env.GITHUB_ACTIONS === 'true' &&
    process.env.CI === 'true' &&
    process.env.RUNNER_ENVIRONMENT === 'github-hosted',
  'NSIS smoke is restricted to disposable GitHub-hosted CI',
)
assert.equal(
  process.env.CODING_HUB_INSTALL_SMOKE,
  '1',
  'Explicit installation smoke authorization is required',
)
assert(
  process.env.RUNNER_TEMP && isAbsolute(process.env.RUNNER_TEMP),
  'An absolute RUNNER_TEMP is required',
)
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
  if (!['--old-installer', '--new-installer', '--output'].includes(options[i]))
    throw new Error(`Unknown option ${options[i]}`)
const oldInstaller = option('--old-installer', 'release/Coding Hub Setup 0.1.0.exe')
const newInstaller = option('--new-installer', 'release/Coding Hub Setup 0.1.1.exe')
const output = option('--output', 'coverage/installation/windows-x64.json')
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
    'Runs genuine old/new NSIS installers and their installed uninstaller on disposable GitHub-hosted native Windows only; never accepts an existing Coding Hub registration, application, shortcut, updater cache or default data directory.',
    'Uses /S /currentuser and a final unquoted /D= private path. Uninstall runs a byte-identical copy of the installed uninstaller with /S /currentuser and final _?= so completion can be awaited. Sources: https://nsis.sourceforge.io/Docs/Chapter3.html and pinned electron-builder 26 templates/nsis/assistedInstaller.nsh and uninstaller.nsh.',
    'No real Agent CLI or account is used. All CLI paths are private nonexistent executables, common inherited credential variable names are filtered, and CODING_HUB_USER_DATA is a separate private directory verified in each running version.',
    'Tests installed application replacement, schema migration and retained data. Does not establish production signing, SmartScreen reputation, an update-feed download or interactive installer accessibility.',
    'The installer creates normal per-user registration and shortcuts on the clean CI account; the genuine uninstaller removes them. Fixture userData is checked after uninstall and deleted only by final fixture cleanup.',
    'User-data retention is verified for the isolated CODING_HUB_USER_DATA directory. No existing default profile is opened or deleted, and this does not test a real user choosing to delete default-profile data.',
  ],
}
const runnerTemp = await realpath(process.env.RUNNER_TEMP)
assert(!/[\s"\r\n]/.test(runnerTemp), 'RUNNER_TEMP must not need NSIS argument quoting')
const projectRoot = await realpath(resolve('.'))
const tempScope = relative(projectRoot, runnerTemp)
assert(
  tempScope.startsWith('..' + sep) || isAbsolute(tempScope),
  'The installer fixture must be outside the current project',
)
const taskRoot = await realpath(await mkdtemp(join(runnerTemp, 'coding-hub-windows-install-')))
const applications = join(taskRoot, 'Applications')
const installedApp = join(applications, 'CodingHub')
// NSIS requires /D= and _?= to remain unquoted even when paths contain spaces.
// Reject such a runner path rather than rely on Node's automatic argument quoting.
assert(
  !/[\s"\r\n]/.test(installedApp),
  'The private NSIS fixture path must not need command-line quoting',
)
const executable = join(installedApp, 'Coding Hub.exe')
const userData = join(taskRoot, 'isolated-user-data')
const database = join(userData, 'coding-hub.db')
const projectPath = join(taskRoot, '中文 legacy project')
let installationAttempted = false
let preflightPassed = false
const shortcuts = []
let updaterCache
let current
let failure
await mkdir(applications)
await mkdir(userData, { mode: 0o700 })
await mkdir(projectPath)
await mkdir(dirname(output), { recursive: true })
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
      join(taskRoot, `never-run-${provider}.exe`),
    ]),
  ),
}
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) =>
      value !== undefined && !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API[_-]?KEY)/i.test(key),
  ),
)
delete env.ELECTRON_RUN_AS_NODE
env.CODING_HUB_USER_DATA = userData

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
// electron-builder 26 derives NSIS's stable GUID from appId using this namespace.
const namespace = Buffer.from('50e065bc313411e69bab38c9862bdaf3', 'hex')
const guidBytes = createHash('sha1')
  .update(namespace)
  .update('dev.codinghub.desktop')
  .digest()
  .subarray(0, 16)
guidBytes[6] = (guidBytes[6] & 15) | 80
guidBytes[8] = (guidBytes[8] & 63) | 128
const hex = guidBytes.toString('hex')
const guid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
const powershell = join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)
async function ps(script) {
  const result = await run(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from('$ErrorActionPreference="Stop";' + script, 'utf16le').toString('base64'),
    ],
    { env, timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
  )
  return JSON.parse(result.stdout.trim())
}
async function registry() {
  return normalizeRegistryRows(
    await ps(
      `$result=@(); foreach($hive in @('CurrentUser','LocalMachine')) { foreach($view in @('Registry64','Registry32')) { $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$hive,[Microsoft.Win32.RegistryView]::$view); try { foreach($path in @('Software\\${guid}','Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}')) { $key=$base.OpenSubKey($path); try { $location=$null; $version=$null; if($null -ne $key) { $location=$key.GetValue('InstallLocation'); $version=$key.GetValue('DisplayVersion') }; $result += [pscustomobject]@{hive=$hive;view=$view;key=$path;exists=($null -ne $key);location=$location;version=$version} } finally { if($key){$key.Close()} } } } finally { $base.Close() } } }; ConvertTo-Json -InputObject @($result) -Compress`,
    ),
    guid,
  )
}
async function appProcesses() {
  return ps(
    `ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process -Filter "Name='Coding Hub.exe'" | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;path=$_.ExecutablePath} }) -Compress`,
  )
}
async function until(check, message, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(message)
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
}
const samePath = (left, right) => resolve(left).toLowerCase() === resolve(right).toLowerCase()
async function assertRegistration(version) {
  const entries = await registry()
  const present = entries.filter((entry) => entry.exists)
  assert(present.length > 0, 'The real installer must create its stable registration')
  for (const entry of present) {
    assert.equal(entry.hive, 'CurrentUser', 'NSIS must not install for all users')
    if (entry.location)
      assert(
        samePath(entry.location, installedApp),
        'Refusing an installation registration outside the private fixture',
      )
    if (entry.version) assert.equal(entry.version, version)
  }
  assert(
    present.some((entry) => entry.location && samePath(entry.location, installedApp)),
    'Private InstallLocation must be registered',
  )
  assert(
    present.some((entry) => entry.version === version),
    'Installed DisplayVersion must be registered',
  )
  return entries
}
async function preflight() {
  assert(
    (await registry()).every((entry) => !entry.exists),
    'Refusing to upgrade or uninstall an existing Coding Hub installation',
  )
  assert.equal(
    (await appProcesses()).length,
    0,
    'Refusing to run NSIS while any pre-existing Coding Hub process exists',
  )
  const folders = await ps(
    `ConvertTo-Json -InputObject @([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('CommonDesktopDirectory'),[Environment]::GetFolderPath('Programs'),[Environment]::GetFolderPath('CommonPrograms')) -Compress`,
  )
  for (const folder of folders.filter(Boolean)) shortcuts.push(join(folder, 'Coding Hub.lnk'))
  for (const shortcut of shortcuts)
    assert(!existsSync(shortcut), 'Refusing to replace an existing Coding Hub shortcut')
  assert(process.env.APPDATA && process.env.LOCALAPPDATA)
  for (const path of [
    join(process.env.APPDATA, 'coding-hub'),
    join(process.env.APPDATA, 'Coding Hub'),
    join(process.env.LOCALAPPDATA, 'Programs', 'Coding Hub'),
  ])
    assert(!existsSync(path), 'Refusing to touch existing default Coding Hub data or app folders')
  updaterCache = join(process.env.LOCALAPPDATA, 'coding-hub-updater')
  assert(!existsSync(updaterCache), 'Refusing to replace an existing Coding Hub installer cache')
  preflightPassed = true
  report.preflight = {
    cleanHostedRunner: true,
    registryGuid: guid,
    defaultUserDataAbsent: true,
    noExistingAppOrShortcuts: true,
  }
}
async function install(installer, version) {
  if (installationAttempted) await assertRegistration('0.1.0')
  else assert((await registry()).every((entry) => !entry.exists))
  assert.equal(
    (await appProcesses()).length,
    0,
    'Applications must close before installer replacement',
  )
  assert(installedApp.startsWith(taskRoot + sep))
  installationAttempted = true
  await run(installer, ['/S', '/currentuser', `/D=${installedApp}`], {
    env,
    timeout: 180000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  })
  assert(existsSync(executable), 'The real NSIS installer did not create the private executable')
  await assertRegistration(version)
}
async function uninstall() {
  assert(preflightPassed && installationAttempted)
  const entries = await registry()
  for (const entry of entries.filter((entry) => entry.location))
    assert(samePath(entry.location, installedApp), 'Refusing to uninstall a foreign location')
  assert.equal((await appProcesses()).length, 0, 'Applications must close before uninstall')
  const source = join(installedApp, 'Uninstall Coding Hub.exe')
  assert(existsSync(source), 'The real installed NSIS uninstaller is required')
  const copied = join(taskRoot, 'native-uninstall.exe')
  await copyFile(source, copied)
  assert.equal(await hash(source), await hash(copied))
  report.uninstaller = {
    source,
    sha256: await hash(copied),
    waitMode: 'copied real uninstaller with final _?=',
  }
  await run(copied, ['/S', '/currentuser', `_?=${installedApp}`], {
    env,
    timeout: 180000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  })
  await until(
    async () => !existsSync(executable) && (await registry()).every((entry) => !entry.exists),
    'NSIS uninstall did not remove the private application and registration',
  )
  assert(!existsSync(installedApp), 'The actual uninstaller must remove the application directory')
  for (const shortcut of shortcuts)
    assert(!existsSync(shortcut), 'NSIS uninstall left a created shortcut')
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
  assert.equal(info.arch, process.arch)
  assert.equal(await realpath(info.userData), userData)
  const appPathRelative = relative(installedApp, info.appPath)
  assert(
    appPathRelative &&
      appPathRelative !== '..' &&
      !appPathRelative.startsWith('..' + sep) &&
      !isAbsolute(appPathRelative),
    'The genuinely installed private application must be running',
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
  if (preflightPassed)
    await until(
      async () => (await appProcesses()).length === 0,
      'Installed app processes did not exit',
    )
}
async function waitForPaint(page) {
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise((painted) => requestAnimationFrame(() => requestAnimationFrame(painted)))
  })
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
    ['old', oldInstaller],
    ['new', newInstaller],
  ]) {
    assert(existsSync(path), `Missing complete installer ${path}`)
    report.artifacts[key] = { path, file: basename(path), sha256: await hash(path) }
  }
  await preflight()
  report.seedRuntime = await seed()
  await install(oldInstaller, '0.1.0')
  console.log('Opening genuinely NSIS-installed 0.1.0 with isolated v1 data.')
  const old = await launch('0.1.0')
  await waitForPaint(old.page)
  await old.page.screenshot({ path: join(dirname(output), 'windows-old-0.1.0.png') })
  await close()
  preserved(await stored(), 1)
  report.phases.push({
    phase: 'old-installed-app',
    ...old.info,
    executableArchitecture: old.info.arch,
    schemaVersion: 1,
    chineseHistoryVisible: true,
    themeVisible: 'dark',
  })
  console.log('Upgrading with the actual 0.1.1 NSIS installer at the same private path.')
  await install(newInstaller, '0.1.1')
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
  await waitForPaint(reopened.page)
  await reopened.page.screenshot({
    path: join(dirname(output), 'windows-upgraded-reopened-0.1.1.png'),
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
  await uninstall()
  assert(!existsSync(installedApp))
  assert(existsSync(database))
  const retained = await stored()
  preserved(retained, 2)
  assert.equal(retained.drafts[0].text, draftText)
  assert.equal(retained.editors[0].files[0].edited, edited)
  report.assertions = {
    oldVersionActuallyLaunched: true,
    newVersionActuallyLaunched: true,
    sameRegisteredPrivateInstallPathUpgraded: true,
    schema1To2: true,
    projectIdPreserved: true,
    canonicalCwdPreserved: true,
    sessionIdAndNativeIdPreserved: true,
    chineseEventIdsAndTextPreserved: true,
    darkThemePreserved: true,
    newDraftContextAndEditorRecoveredAfterQuit: true,
    unsavedProjectFileUntouched: true,
    realNsisUninstallRemovedAppAndRegistration: true,
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
  if (preflightPassed && installationAttempted) {
    try {
      // A failed installer may have registered itself before it copied the main
      // executable, and a failed uninstaller may have already removed that EXE.
      // In either case use its real uninstaller or retain the fixture as failed;
      // removing the tree would hide a leftover native registration/shortcut.
      const registered = (await registry()).some((entry) => entry.exists)
      if (registered || existsSync(installedApp) || shortcuts.some(existsSync)) await uninstall()
    } catch (error) {
      cleanupErrors.push(`Native fixture uninstall failed: ${String(error)}`)
    }
  }
  if (preflightPassed && updaterCache && existsSync(updaterCache)) {
    try {
      const files = await readdir(updaterCache)
      assert(
        files.every((name) => name === 'installer.exe'),
        'Unexpected files in the fixture-created installer cache; refusing deletion',
      )
      if (files.includes('installer.exe'))
        assert(
          [report.artifacts.old?.sha256, report.artifacts.new?.sha256].includes(
            await hash(join(updaterCache, 'installer.exe')),
          ),
          'Refusing to delete an unrecognized cached installer',
        )
      await rm(updaterCache, { recursive: true })
    } catch (error) {
      cleanupErrors.push(`Fixture installer cache cleanup failed: ${String(error)}`)
    }
  }
  if (!cleanupErrors.length) {
    try {
      await rm(taskRoot, { recursive: true, force: true })
    } catch (error) {
      cleanupErrors.push(`Temporary fixture cleanup failed: ${String(error)}`)
    }
  }
  report.cleanup = { temporaryFixtureRemoved: !existsSync(taskRoot), errors: cleanupErrors }
  if (cleanupErrors.length) {
    report.status = 'failed'
    failure ??= new Error('Temporary installation cleanup was incomplete')
  }
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  console.log(`Installation report: ${output}`)
}
if (failure) {
  console.error(failure)
  process.exitCode = 1
}
