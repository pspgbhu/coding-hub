const assert = require('node:assert/strict')

/** Validate only the fixed read-only NSIS registry query, before any path is used. */
function normalizeRegistryRows(raw, guid) {
  assert(Array.isArray(raw) && raw.length === 8, 'Expected all eight NSIS registry observations')
  const expected = new Set()
  for (const hive of ['CurrentUser', 'LocalMachine'])
    for (const view of ['Registry64', 'Registry32'])
      for (const key of [
        `Software\\${guid}`,
        `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`,
      ])
        expected.add(JSON.stringify([hive, view, key]))
  const seen = new Set()
  return raw.map((entry) => {
    assert(
      entry && typeof entry === 'object' && !Array.isArray(entry),
      'Invalid registry observation',
    )
    const identity = JSON.stringify([entry.hive, entry.view, entry.key])
    assert(
      expected.has(identity) && !seen.has(identity),
      'Unexpected or duplicate registry observation',
    )
    seen.add(identity)
    assert.equal(typeof entry.exists, 'boolean', 'Registry existence must be explicit')
    const normalized = { hive: entry.hive, view: entry.view, key: entry.key, exists: entry.exists }
    for (const field of ['location', 'version']) {
      const value = entry[field]
      if (!entry.exists) {
        // An absent key has no usable metadata. PowerShell's empty subexpression
        // may serialize as an empty object; it must never reach path.resolve.
        assert(
          value == null ||
            value === '' ||
            (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0),
          'Absent registry keys must not contain metadata',
        )
        normalized[field] = null
      } else {
        assert(
          value == null || (typeof value === 'string' && value.trim().length > 0),
          `Present registry ${field} must be a nonempty string or null`,
        )
        normalized[field] = value ?? null
      }
    }
    return normalized
  })
}

module.exports = { normalizeRegistryRows }
