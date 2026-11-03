import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

assert.equal(process.platform, 'win32', 'Native Windows is required')
assert(process.env.GITHUB_ACTIONS === 'true' && process.env.CI === 'true', 'CI only')
const source = await readFile(new URL('../src/runtime/process.ts', import.meta.url), 'utf8')
const matches = [...source.matchAll(/const script = `([\s\S]*?)`/g)].filter((match) =>
  match[1].includes("$request -ne 'snapshot'"),
)
assert.equal(matches.length, 1, 'Expected exactly one fixed process snapshot protocol')
const script = matches[0][1]
assert(!script.includes('${'), 'The diagnostic must not evaluate TypeScript interpolation')
const command = join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)
const result = await new Promise((resolve) => {
  const child = spawn(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'pipe',
    windowsHide: true,
    shell: false,
  })
  const chunks = []
  let stdoutBytes = 0,
    stderrBytes = 0,
    failure,
    settled = false,
    fallback
  const finish = (exitCode) => {
    if (settled) return
    settled = true
    clearTimeout(timeout)
    clearTimeout(fallback)
    resolve({
      stdout: Buffer.concat(chunks).toString('utf8'),
      stdoutBytes,
      stderrBytes,
      exitCode,
      failure,
    })
  }
  const stop = (reason) => {
    failure ??= reason
    child.stdin.destroy()
    child.kill()
    fallback ??= setTimeout(() => finish(null), 2000)
  }
  const timeout = setTimeout(() => stop('timeout'), 10000)
  child.stdout.on('data', (chunk) => {
    stdoutBytes += chunk.length
    if (stdoutBytes > 8 * 1024 * 1024) stop('stdout-limit')
    else chunks.push(chunk)
  })
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length
    if (stderrBytes > 1024 * 1024) stop('stderr-limit')
  })
  child.stdin.on('error', () => stop('stdin-error'))
  child.stdout.on('error', () => stop('stdout-error'))
  child.stderr.on('error', () => stop('stderr-error'))
  child.once('error', () => {
    failure ??= 'spawn-error'
    finish(null)
  })
  child.once('close', finish)
  // Execute the exact production marker and let the fixed loop exit on EOF.
  child.stdin.end('snapshot\n')
})
const report = {
  diagnostic: 'fixed-process-snapshot-identity-shape-only',
  exitCode: result.exitCode,
  failure: result.failure,
  stdoutBytes: result.stdoutBytes,
  stderrBytes: result.stderrBytes,
  jsonParseable: false,
  isArray: false,
  rowCount: 0,
  invalidRows: 0,
  invalidCounts: {},
  samples: [],
}
try {
  const payload = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim())
  report.jsonParseable = true
  report.isArray = Array.isArray(payload)
  if (Array.isArray(payload)) {
    report.rowCount = payload.length
    for (const row of payload) {
      const reasons = []
      if (!row || typeof row !== 'object' || Array.isArray(row)) reasons.push('row-type')
      else {
        if (!Number.isSafeInteger(row.pid)) reasons.push('pid-type')
        else if (row.pid < 1 || row.pid > 0xffffffff) reasons.push('pid-range')
        if (!Number.isSafeInteger(row.parent)) reasons.push('parent-type')
        else if (row.parent < 0 || row.parent > 0xffffffff) reasons.push('parent-range')
        if (typeof row.started !== 'string') reasons.push('started-type')
        else if (!/^[1-9]\d{0,18}$/.test(row.started)) reasons.push('started-format')
        else if (BigInt(row.started) > 3155378975999999999n) reasons.push('started-range')
      }
      if (!reasons.length) continue
      report.invalidRows++
      for (const reason of reasons)
        report.invalidCounts[reason] = (report.invalidCounts[reason] ?? 0) + 1
      if (report.samples.length < 3)
        report.samples.push({
          reasons,
          pidType: typeof row?.pid,
          ...(typeof row?.pid === 'number' && Number.isFinite(row.pid) ? { pid: row.pid } : {}),
          parentType: typeof row?.parent,
          ...(typeof row?.parent === 'number' && Number.isFinite(row.parent)
            ? { parent: row.parent }
            : {}),
          startedType: typeof row?.started,
          ...(typeof row?.started === 'string' && /^\d{1,32}$/.test(row.started)
            ? { startedTicks: row.started }
            : {}),
        })
    }
  }
} catch {
  // Do not print raw stdout/stderr: only structural information is permitted.
  const trimmed = result.stdout.trimStart()
  report.firstNonWhitespaceCodePoint = trimmed.codePointAt(0) ?? null
  report.nonemptyLines = result.stdout.split(/\r?\n/).filter((line) => line.trim()).length
}
console.log(JSON.stringify(report))
if (result.failure || result.exitCode !== 0) process.exitCode = 1
