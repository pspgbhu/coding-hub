import { spawnSync } from 'node:child_process'

const target = process.argv[2]
if (!['mac', 'win'].includes(target)) throw new Error('Usage: node scripts/release.mjs mac|win')
const url = process.env.CODING_HUB_UPDATE_URL
let endpoint
try {
  endpoint = new URL(url ?? '')
} catch {
  throw new Error('Signed releases require an HTTPS CODING_HUB_UPDATE_URL.')
}
if (
  endpoint.protocol !== 'https:' ||
  endpoint.username ||
  endpoint.password ||
  endpoint.search ||
  endpoint.hash
)
  throw new Error(
    'The update feed must use HTTPS without embedded credentials, query parameters or fragments.',
  )
if (!process.env.CSC_LINK && !process.env.CSC_NAME)
  throw new Error(
    'Signed releases require CSC_LINK or CSC_NAME. Use package:mac/package:win for internal builds.',
  )
if (target === 'mac' && !process.env.APPLE_API_KEY && !process.env.APPLE_ID)
  throw new Error('macOS releases require notarization credentials.')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
for (const args of [
  ['build'],
  [
    'exec',
    'electron-builder',
    `--${target}`,
    '--config',
    'electron-builder.release.yml',
    '--publish',
    'never',
  ],
]) {
  const result = spawnSync(pnpm, args, { stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
