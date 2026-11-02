import { describe, expect, it } from 'vitest'
import { redactDiagnostics } from '../src/shared/diagnostics'
describe('provider diagnostics', () => {
  it('redacts JSON and header credentials while preserving actionable failure context', () => {
    const message =
      'HTTP 401 Authorization: Bearer abcdefghijklmnopqrstuvwxyz {"access_token":"secret-token","apiKey":"private-key","password":"private-password"}'
    const safe = redactDiagnostics(message)
    expect(safe).toContain('HTTP 401')
    expect(safe).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(safe).not.toContain('secret-token')
    expect(safe).not.toContain('private-key')
    expect(safe).not.toContain('private-password')
  })
  it('preserves model and CLI diagnostics and redacts standalone keys', () => {
    expect(redactDiagnostics('model gpt-5.6-sol is unavailable')).toBe(
      'model gpt-5.6-sol is unavailable',
    )
    expect(redactDiagnostics('invalid sk-proj-abcdefghijklmnopqrstuvwxyz')).toBe(
      'invalid [redacted]',
    )
  })
})
