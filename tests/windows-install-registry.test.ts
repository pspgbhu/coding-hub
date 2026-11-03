import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

interface RegistryRow {
  hive: string
  view: string
  key: string
  exists: boolean
  location: string | null
  version: string | null
}
const require = createRequire(import.meta.url)
const { normalizeRegistryRows } = require('../scripts/windows-install-registry.cjs') as {
  normalizeRegistryRows: (raw: unknown, guid: string) => RegistryRow[]
}
const guid = 'ff45b1b5-78b6-5451-aa7c-1bdfec2cea9d'
function observations() {
  return ['CurrentUser', 'LocalMachine'].flatMap((hive) =>
    ['Registry64', 'Registry32'].flatMap((view) =>
      [`Software\\${guid}`, `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`].map(
        (key) => ({
          hive,
          view,
          key,
          exists: false,
          location: null as unknown,
          version: null as unknown,
        }),
      ),
    ),
  )
}

describe('native installer registry observation boundary', () => {
  it('normalizes absent PowerShell empty metadata before it can reach a path check', () => {
    const raw = observations()
    raw[0].location = {}
    raw[0].version = {}
    raw[1] = { ...raw[1], exists: true, location: 'D:\\private\\CodingHub', version: '0.1.1' }
    const actual = normalizeRegistryRows(raw, guid)
    expect(actual[0]).toEqual({ ...raw[0], location: null, version: null })
    expect(actual[1]).toEqual(raw[1])
    expect(actual).toHaveLength(8)
    expect(raw[0].location).toEqual({})
  })

  it('keeps optional metadata of an existing registration null when the values are missing', () => {
    const raw = observations()
    raw[0] = { ...raw[0], exists: true, location: undefined, version: undefined }
    expect(normalizeRegistryRows(raw, guid)[0]).toEqual({
      ...raw[0],
      location: null,
      version: null,
    })
  })

  it.each(['location', 'version'] as const)(
    'rejects a present key with non-string %s instead of coercing or hiding it',
    (field) => {
      for (const invalid of [{}, { value: 'D:\\foreign' }, [], 123, false, '']) {
        const raw = observations()
        raw[0] = { ...raw[0], exists: true, location: 'D:\\private\\CodingHub', version: '0.1.1' }
        raw[0][field] = invalid
        expect(() => normalizeRegistryRows(raw, guid)).toThrow(`Present registry ${field}`)
      }
    },
  )

  it('preserves a present foreign location for the existing strict private-path guard', () => {
    const raw = observations()
    raw[0] = {
      ...raw[0],
      exists: true,
      location: 'C:\\Users\\real-user\\Coding Hub',
      version: '0.1.0',
    }
    expect(normalizeRegistryRows(raw, guid)[0].location).toBe(raw[0].location)
  })

  it('rejects incomplete, duplicate and unexpected registry observations', () => {
    const raw = observations()
    expect(() => normalizeRegistryRows(raw.slice(1), guid)).toThrow('all eight')
    expect(() => normalizeRegistryRows([raw[0], raw[0], ...raw.slice(2)], guid)).toThrow(
      'duplicate',
    )
    expect(() =>
      normalizeRegistryRows([{ ...raw[0], hive: 'foreign' }, ...raw.slice(1)], guid),
    ).toThrow('Unexpected')
    expect(() =>
      normalizeRegistryRows([{ ...raw[0], exists: 'false' }, ...raw.slice(1)], guid),
    ).toThrow('existence must be explicit')
    expect(() =>
      normalizeRegistryRows([{ ...raw[0], location: { value: 'foreign' } }, ...raw.slice(1)], guid),
    ).toThrow('Absent registry keys')
  })
})
