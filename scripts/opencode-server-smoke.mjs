import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crossSpawn from 'cross-spawn'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// Downloads a pinned official CLI into an isolated cache. No accounts or model calls.
const version = '1.19.5'
const root = await mkdtemp(join(tmpdir(), 'coding-hub-opencode-smoke-'))
const project = join(root, 'project')
const password = randomBytes(32).toString('hex')
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
const children = new Set()
const controller = new AbortController()
const onSignal = () => controller.abort(new Error('Smoke check interrupted.'))
process.once('SIGINT', onSignal)
process.once('SIGTERM', onSignal)

function safe(message) {
  return String(message).replaceAll(password, '[redacted]').replaceAll(authorization, '[redacted]')
}

function launch(command, args, env) {
  const child = crossSpawn(command, args, {
    cwd: project,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  children.add(child)
  child.logs = ''
  child.failure = undefined
  child.closed = new Promise((resolve) => {
    child.once('error', (error) => {
      child.failure = error
      resolve({ error })
    })
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      child.logs = (child.logs + chunk.toString()).slice(-32_768)
    })
  return child
}

async function stop(child) {
  if (!child.pid) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    await new Promise((resolve) => {
      killer.once('error', resolve)
      killer.once('close', resolve)
    })
  } else {
    const signal = (name) => {
      try {
        process.kill(-child.pid, name)
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    signal('SIGTERM')
    await Promise.race([child.closed, delay(3000)])
    signal('SIGKILL')
  }
  await child.closed
  children.delete(child)
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return port
}

try {
  for (const directory of [
    'project',
    'home',
    'config',
    'data',
    'cache',
    'state',
    'runtime',
    'pnpm',
  ])
    await mkdir(join(root, directory), { mode: 0o700 })

  // Allowlist process plumbing; deliberately exclude inherited provider tokens and credentials.
  const env = Object.fromEntries(
    [
      'PATH',
      'Path',
      'SystemRoot',
      'WINDIR',
      'COMSPEC',
      'PATHEXT',
      'LANG',
      'LC_ALL',
      'TMPDIR',
      'TEMP',
      'TMP',
    ]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  )
  Object.assign(env, {
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_RUNTIME_DIR: join(root, 'runtime'),
    PNPM_HOME: join(root, 'pnpm'),
    npm_config_userconfig: join(root, 'home', '.npmrc'),
    OPENCODE_CONFIG_DIR: join(root, 'config'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false }),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_PURE: '1',
    OPENCODE_CLIENT: 'coding-hub-smoke',
    OPENCODE_SERVER_USERNAME: 'opencode',
    OPENCODE_SERVER_PASSWORD: password,
  })

  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const command = [
    `--config.cache-dir=${join(root, 'pnpm-cache')}`,
    `--store-dir=${join(root, 'pnpm-store')}`,
    'dlx',
    `opencode-ai@${version}`,
  ]
  console.log(`Checking official opencode-ai@${version} in an isolated temporary environment…`)
  const probe = launch(pnpm, [...command, '--version'], env)
  const result = await Promise.race([
    probe.closed,
    delay(180_000, undefined, { signal: controller.signal }).then(() => {
      throw new Error('Timed out downloading or checking OpenCode.')
    }),
  ])
  assert.equal(result.code, 0, safe(`OpenCode version command failed: ${probe.logs}`))
  assert.match(probe.logs, new RegExp(`(?:^|\\n)${version.replaceAll('.', '\\.')}\\s*(?:$|\\n)`))
  children.delete(probe)

  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const child = launch(
    pnpm,
    [...command, 'serve', '--hostname', '127.0.0.1', '--port', String(port), '--mdns=false'],
    env,
  )
  const request = (path, options = {}) => {
    const url = new URL(path, base)
    url.searchParams.set('directory', project)
    return fetch(url, {
      ...options,
      redirect: 'error',
      headers: { authorization, 'content-type': 'application/json', ...options.headers },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
    })
  }

  let health
  const deadline = Date.now() + 45_000
  while (!health) {
    controller.signal.throwIfAborted()
    if (child.failure || child.exitCode !== null || child.signalCode !== null)
      throw new Error(safe(`OpenCode server exited before ready: ${child.logs}`))
    try {
      const response = await request('/global/health')
      if (response.ok) health = await response.json()
      else await response.body?.cancel()
    } catch (error) {
      if (Date.now() >= deadline) throw error
    }
    if (!health) {
      if (Date.now() >= deadline)
        throw new Error(safe(`OpenCode did not become ready: ${child.logs}`))
      await delay(150, undefined, { signal: controller.signal })
    }
  }
  assert.deepEqual(health, { healthy: true, version })
  assert.match(
    child.logs,
    new RegExp(`opencode server listening on http://127\\.0\\.0\\.1:${port}`),
  )

  const unauthenticated = await fetch(`${base}/global/health`, {
    redirect: 'error',
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
  })
  assert.equal(unauthenticated.status, 401)
  await unauthenticated.body?.cancel()

  const providerResponse = await request('/provider')
  assert.equal(providerResponse.status, 200)
  const providers = await providerResponse.json()
  assert.ok(Array.isArray(providers.all), 'Expected provider.all array')
  assert.ok(Array.isArray(providers.connected), 'Expected provider.connected array')
  // Built-in free providers can be connected without an account.
  const providerIds = new Set(providers.all.map((provider) => provider.id))
  assert.ok(providers.connected.every((id) => typeof id === 'string' && providerIds.has(id)))
  assert.ok(providers.default && typeof providers.default === 'object')

  const sessionResponse = await request('/session', {
    method: 'POST',
    body: JSON.stringify({ title: 'Coding Hub isolated protocol smoke' }),
  })
  assert.equal(sessionResponse.status, 200)
  const session = await sessionResponse.json()
  assert.match(session.id, /^ses_/)

  const messagesResponse = await request(`/session/${session.id}/message`)
  assert.equal(messagesResponse.status, 200)
  assert.deepEqual(await messagesResponse.json(), [])

  const eventsResponse = await request('/event', { headers: { accept: 'text/event-stream' } })
  assert.equal(eventsResponse.status, 200)
  assert.match(eventsResponse.headers.get('content-type'), /^text\/event-stream/)
  const reader = eventsResponse.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let firstEvent
  try {
    while (!firstEvent) {
      const { value, done } = await reader.read()
      assert.equal(done, false, 'SSE stream ended before its first frame')
      buffer = (buffer + decoder.decode(value, { stream: true })).replaceAll('\r\n', '\n')
      assert.ok(buffer.length < 64 * 1024, 'SSE first-frame buffer exceeded 64 KB')
      const end = buffer.indexOf('\n\n')
      if (end < 0) continue
      const data = buffer
        .slice(0, end)
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      buffer = buffer.slice(end + 2)
      if (data) firstEvent = JSON.parse(data)
    }
  } finally {
    await reader.cancel()
  }
  assert.equal(firstEvent.type, 'server.connected')

  console.log(
    JSON.stringify(
      {
        version: health.version,
        authentication: '401 without credentials; 200 with isolated random password',
        providers: { total: providers.all.length, connected: providers.connected },
        session: 'created; message history is empty',
        firstEvent: firstEvent.type,
        modelRequests: 0,
      },
      null,
      2,
    ),
  )
} catch (error) {
  console.error(safe(error.stack || error))
  process.exitCode = 1
} finally {
  controller.abort()
  await Promise.allSettled([...children].map(stop))
  await rm(root, { recursive: true, force: true })
  process.removeListener('SIGINT', onSignal)
  process.removeListener('SIGTERM', onSignal)
}
