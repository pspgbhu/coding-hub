import { readdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
const files = (await readdir('release'))
  .filter((name) => /\.(dmg|zip|exe|yml|blockmap)$/.test(name))
  .sort()
const lines = []
for (const name of files)
  lines.push(
    `${createHash('sha256')
      .update(await readFile(join('release', name)))
      .digest('hex')}  ${name}`,
  )
if (!lines.length) throw new Error('No installers or update metadata found.')
await writeFile('release/SHA256SUMS.txt', lines.join('\n') + '\n')
