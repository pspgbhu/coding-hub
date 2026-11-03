import { describe, expect, it } from 'vitest'
import {
  redactDiagnostics,
  RedactingDiagnosticStream,
  redactNativeEventInput,
} from '../src/shared/diagnostics'
describe('provider diagnostics', () => {
  it('redacts credentials and preserves UTF-8 across arbitrary byte boundaries', () => {
    const output: string[] = []
    const stream = new RedactingDiagnosticStream((line) => output.push(line))
    const input = Buffer.from(
      '你好 ANTHROPIC_AUTH_TOKEN=private-token GH_TOKEN=github-secret https://user:pass@example.test\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz\nfinished',
    )
    for (const byte of input) stream.push(Buffer.from([byte]))
    stream.end()
    const safe = output.join('')
    expect(safe).toContain('你好')
    expect(safe).toContain('finished')
    for (const secret of [
      'private-token',
      'github-secret',
      'user:pass',
      'abcdefghijklmnopqrstuvwxyz',
    ])
      expect(safe).not.toContain(secret)
  })
  it('omits oversized diagnostic lines rather than leaking split credentials', () => {
    const output: string[] = []
    const stream = new RedactingDiagnosticStream((line) => output.push(line), 32)
    stream.push('x'.repeat(40))
    stream.push('password=secret\nnext line\n')
    stream.end()
    expect(output.join('')).not.toContain('secret')
    expect(output.join('')).toContain('next line')
  })
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

describe('native input persistence copies', () => {
  it('redacts structured credentials without changing the object used for native execution', () => {
    const original = {
      env: { OPENAI_API_KEY: 'private-api', GH_TOKEN: 'private-gh', NORMAL: 'visible' },
      headers: { Authorization: 'Bearer original-native', Cookie: 'session=private-cookie' },
      credentials: { client_secret: 'private-client', refreshToken: 'private-refresh' },
      url: 'https://username:private-password@example.test/path?q=ordinary',
      command: 'cli --api-key "private-flag" --model visible',
      argv: ['--password', 'private-argument', '--token=private-token', 'visible'],
      body: { password: 'source-example', code: 'const password="source-example"' },
      text: 'password=example',
      patch: '+ API_KEY=example',
      answers: { authToken: 'user answer' },
    }
    const safe = redactNativeEventInput(original) as typeof original
    expect(safe).not.toBe(original)
    for (const secret of [
      'private-api',
      'private-gh',
      'private-cookie',
      'original-native',
      'private-client',
      'private-refresh',
      'private-password',
      'private-flag',
      'private-argument',
      'private-token',
    ])
      expect(JSON.stringify(safe)).not.toContain(secret)
    expect(safe.env.NORMAL).toBe('visible')
    expect(safe.body).toEqual(original.body)
    expect(safe.text).toBe(original.text)
    expect(safe.patch).toBe(original.patch)
    expect(safe.answers).toEqual(original.answers)
    expect(original.headers.Authorization).toBe('Bearer original-native')
    expect(original.argv[1]).toBe('private-argument')
  })
  it('handles cycles, depth limits and repeated references without invoking toJSON', () => {
    const circular: Record<string, unknown> = { password: 'secret' }
    circular.self = circular
    const safe = redactNativeEventInput({ first: circular, second: circular }) as Record<
      string,
      unknown
    >
    expect(JSON.stringify(safe)).not.toContain('secret')
    expect(safe.first).toEqual(safe.second)
    let deep: Record<string, unknown> = {}
    const input = deep
    for (let i = 0; i < 100; i++) {
      deep.child = {}
      deep = deep.child as Record<string, unknown>
    }
    expect(JSON.stringify(redactNativeEventInput(input))).toContain('input size limit')
  })
  it('sanitizes top-level commands only when their native event is explicitly a command', () => {
    const command = 'cli --token secret-token --model visible'
    expect(redactNativeEventInput(command)).toBe(command)
    expect(redactNativeEventInput(command, { command: true })).toBe(
      'cli --token [redacted] --model visible',
    )
    expect(
      redactNativeEventInput({
        token: 'secret-token',
        secret: 'secret-value',
        url: 'https://host.test/path?api_key=private-api&name=visible&access_token=private-token#fragment',
      }),
    ).toEqual({
      token: '[redacted]',
      secret: '[redacted]',
      url: 'https://host.test/path?api_key=[redacted]&name=visible&access_token=[redacted]#fragment',
    })
  })

  it('redacts credential URLs and known provider tokens in commands without scanning source bodies', () => {
    const command =
      "curl 'https://user:private-userinfo@host.test/path?api_key=private-query&visible=value' -d sk-proj-abcdefghijklmnopqrstuvwxyz github_pat_abcdefghijklmnopqrstuvwxyz; echo password=example"
    const safe = redactNativeEventInput(command, { command: true }) as string
    expect(safe).toContain('visible=value')
    expect(safe).toContain('echo password=example')
    for (const secret of [
      'private-userinfo',
      'private-query',
      'sk-proj-abcdefghijklmnopqrstuvwxyz',
      'github_pat_abcdefghijklmnopqrstuvwxyz',
    ])
      expect(safe).not.toContain(secret)
    expect(redactNativeEventInput({ body: command, code: command, patch: command })).toEqual({
      body: command,
      code: command,
      patch: command,
    })
  })
})
