import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

// This historical build is evidence only. Never alter the current checkout or
// rebuild an old app in the current release directory.
const BASELINE = '9610d035cab6f85232972c8f9960d7282526af68'
const project = await realpath(resolve('.'))
assert(
  process.env.GITHUB_ACTIONS === 'true' && process.env.CI === 'true',
  'Baseline installation builds are CI-only',
)
assert(
  process.env.CODING_HUB_INSTALL_SMOKE === '1',
  'Explicit installation smoke authorization is required',
)
assert(['darwin', 'win32'].includes(process.platform), 'Native macOS or Windows is required')
assert(process.env.RUNNER_TEMP && isAbsolute(process.env.RUNNER_TEMP), 'RUNNER_TEMP is required')
const runnerTemp = await realpath(process.env.RUNNER_TEMP)
const inside = (parent, child) => {
  const part = relative(parent, child)
  return part && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part)
}
async function cleanup(location) {
  const root = await realpath(location)
  assert(
    inside(runnerTemp, root) && !inside(project, root),
    'Refusing cleanup outside the private runner fixture',
  )
  assert(basename(root).startsWith('coding-hub-install-baseline-'))
  const marker = JSON.parse(await readFile(join(root, 'fixture.json'), 'utf8'))
  assert.equal(marker.baselineSha, BASELINE)
  assert.equal(marker.kind, 'coding-hub-install-baseline')
  if (existsSync(join(root, 'source', '.git'))) {
    await new Promise((resolveRemoval, reject) => {
      const child = spawn('git', ['worktree', 'remove', '--force', join(root, 'source')], {
        cwd: project,
        stdio: 'inherit',
        windowsHide: true,
      })
      child.once('error', reject)
      child.once('close', (code) =>
        code === 0 ? resolveRemoval() : reject(new Error('Historical worktree cleanup failed')),
      )
    })
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
  const reportPath = resolve(
    `coverage/installation/baseline-${process.platform}-${process.arch}.json`,
  )
  if (existsSync(reportPath)) {
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    report.cleanup.fixtureRemoved = true
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  }
}
if (process.argv[2] === '--cleanup') {
  assert.equal(process.argv.length, 3)
  if (process.env.CODING_HUB_BASELINE_ROOT) await cleanup(process.env.CODING_HUB_BASELINE_ROOT)
  process.exit(0)
}
if (process.argv[2] === '--verify-report') {
  assert.equal(process.argv.length, 4)
  const reportPath = await realpath(resolve(process.argv[3]))
  assert(inside(resolve('coverage/installation'), reportPath))
  const smoke = JSON.parse(await readFile(reportPath, 'utf8'))
  const baseline = JSON.parse(
    await readFile(
      resolve(`coverage/installation/baseline-${process.platform}-${process.arch}.json`),
      'utf8',
    ),
  )
  assert.equal(smoke.status, 'passed')
  assert.equal(baseline.status, 'passed')
  assert.equal(baseline.baselineSha, BASELINE)
  assert.equal(baseline.cleanup.sourceWorktreeRemoved, true)
  for (const key of ['old', 'new'])
    assert.equal(smoke.artifacts[key].sha256, baseline.artifacts[key].sha256)
  assert.equal(smoke.machine.arch, process.arch)
  assert(smoke.phases.length >= 3)
  for (const phase of smoke.phases) assert.equal(phase.arch, process.arch)
  smoke.buildEvidence = {
    baselineSha: BASELINE,
    nativeArchitecture: process.arch,
    sourceWorktreeRemoved: true,
    installerHashesMatchBuild: true,
  }
  await writeFile(reportPath, JSON.stringify(smoke, null, 2) + '\n')
  process.exit(0)
}
assert.equal(process.argv.length, 2, 'Usage: node scripts/build-install-baseline.mjs [--cleanup]')
assert(
  ['x64', 'arm64'].includes(process.arch) &&
    (process.platform !== 'win32' || process.arch === 'x64'),
)
assert(!inside(project, runnerTemp), 'RUNNER_TEMP must be outside the current project')
const root = await mkdtemp(join(runnerTemp, 'coding-hub-install-baseline-'))
const checkout = join(root, 'source')
await writeFile(
  join(root, 'fixture.json'),
  JSON.stringify({
    kind: 'coding-hub-install-baseline',
    baselineSha: BASELINE,
    fixtureId: randomUUID(),
  }),
)
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `root=${root}\n`)
const reportPath = resolve(
  `coverage/installation/baseline-${process.platform}-${process.arch}.json`,
)
const report = {
  recordedAt: new Date().toISOString(),
  status: 'running',
  baselineSha: BASELINE,
  currentSha: process.env.GITHUB_SHA,
  platform: process.platform,
  arch: process.arch,
  sourcePath: checkout,
  phases: [],
  cleanup: {},
}
let registered = false,
  failure
const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
for (const key of Object.keys(env))
  if (/CSC|APPLE_|TOKEN|SECRET|PASSWORD|CREDENTIAL|API[_-]?KEY/i.test(key)) delete env[key]
env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
function run(command, args, cwd = project) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: 'inherit',
      shell: process.platform === 'win32' && command === 'pnpm.cmd',
      windowsHide: true,
    })
    const timer = setTimeout(
      () => {
        child.kill()
        reject(new Error(`Historical build timed out: ${command}`))
      },
      20 * 60 * 1000,
    )
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      code === 0 ? resolveRun() : reject(new Error(`${command} exited ${code}`))
    })
  })
}
async function hash(path) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}
try {
  // actions/checkout uses fetch-depth: 0, so the pinned historical object exists
  // without downloading or checking out an untrusted branch in this helper.
  await run('git', ['worktree', 'add', '--detach', checkout, BASELINE])
  registered = true
  const oldPackage = JSON.parse(await readFile(join(checkout, 'package.json'), 'utf8'))
  assert.equal(oldPackage.version, '0.1.0')
  const currentPackage = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'))
  assert.equal(currentPackage.version, '0.1.1')
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  await run(pnpm, ['install', '--frozen-lockfile'], checkout)
  await run(pnpm, ['build'], checkout)
  await run(
    pnpm,
    [
      'exec',
      'electron-builder',
      process.platform === 'darwin' ? '--mac' : '--win',
      `--${process.arch}`,
      '--publish',
      'never',
    ],
    checkout,
  )
  const extension = process.platform === 'darwin' ? '.dmg' : '.exe'
  const findInstaller = async (directory, version) => {
    const candidates = (await readdir(directory)).filter(
      (name) =>
        name.endsWith(extension) &&
        name.includes(version) &&
        (extension !== '.exe' || name.includes('Setup')),
    )
    assert.equal(
      candidates.length,
      1,
      `Expected exactly one native ${version} installer in ${directory}`,
    )
    return join(directory, candidates[0])
  }
  const oldArtifact = await findInstaller(join(checkout, 'release'), '0.1.0')
  const oldInstaller = join(root, basename(oldArtifact))
  await copyFile(oldArtifact, oldInstaller)
  const newInstaller = await findInstaller(join(project, 'release'), currentPackage.version)
  report.artifacts = {
    old: { path: oldInstaller, sha256: await hash(oldInstaller) },
    new: { path: newInstaller, sha256: await hash(newInstaller) },
  }
  report.phases.push({
    phase: 'native-historical-build',
    version: oldPackage.version,
    architecture: process.arch,
    codeModified: false,
  })
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `old_installer=${oldInstaller}\nnew_installer=${newInstaller}\nbaseline_sha=${BASELINE}\n`,
    )
  report.status = 'passed'
} catch (error) {
  failure = error
  report.status = 'failed'
  report.error = error instanceof Error ? error.message : String(error)
} finally {
  if (registered) {
    try {
      await run('git', ['worktree', 'remove', '--force', checkout])
      report.cleanup.sourceWorktreeRemoved = !existsSync(checkout)
    } catch (error) {
      report.cleanup.error = String(error)
      report.status = 'failed'
      failure ??= error
    }
  }
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  console.log(`Historical installer build report: ${reportPath}`)
}
if (failure) {
  console.error(failure)
  process.exitCode = 1
}
