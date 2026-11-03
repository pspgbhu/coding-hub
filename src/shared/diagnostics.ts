import { StringDecoder } from 'node:string_decoder'

/** Applies only to diagnostics, never to user messages, source files or terminal contents. */
export function redactDiagnostics(value: string): string {
  return value
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, '[redacted]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})/g, '[redacted]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.\-]{12,}/gi, '$1 [redacted]')
    .replace(/\b(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(
      /((?:api[_-]?key|(?:access|refresh|auth|id|session)[_-]?token|(?:gh|github)[_-]token|client[_-]?secret|password)["']?\s*[:=]\s*["']?)([^\s"',;}]+)/gi,
      '$1[redacted]',
    )
}

/** Frame diagnostics before redacting: credentials and UTF-8 may cross pipe chunks. */
export class RedactingDiagnosticStream {
  private readonly decoder = new StringDecoder('utf8')
  private buffer = ''
  private dropping = false
  constructor(
    private readonly emit: (safe: string) => void,
    private readonly maxLine = 64 * 1024,
  ) {}
  push(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    let end: number
    while ((end = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, end + 1)
      this.buffer = this.buffer.slice(end + 1)
      if (!this.dropping) this.emitLine(line)
      this.dropping = false
    }
    if (this.buffer.length > this.maxLine) {
      if (!this.dropping) this.emit('[Diagnostic line omitted: exceeded size limit]\n')
      this.buffer = ''
      this.dropping = true
    }
  }
  end(): void {
    this.push(this.decoder.end())
    if (this.buffer && !this.dropping) this.emitLine(this.buffer)
    this.buffer = ''
  }
  private emitLine(line: string): void {
    this.emit(
      line.length > this.maxLine
        ? '[Diagnostic line omitted: exceeded size limit]\n'
        : redactDiagnostics(line),
    )
  }
}

const CREDENTIAL_KEY =
  /^(?:authorization|proxyauthorization|authentication|cookie|setcookie|token|secret|password|passwd|apikey|accesstoken|refreshtoken|authtoken|authenticationtoken|idtoken|sessiontoken|clientsecret|privatekey|ghtoken|githubtoken|anthropicauthtoken|openaiapikey)$/
const CREDENTIAL_ENV =
  /(?:^|_)(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|PASSWORD|PRIVATE_KEY)$|^(?:GH_TOKEN|GITHUB_TOKEN)$/i
const CREDENTIAL_FLAG =
  /^--?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|token|password|passwd|client[-_]?secret|private[-_]?key)$/i
const BODY_KEY = /^(?:text|body|code|patch|content|answer|answers|message|messages|prompt)$/i
const normalizeCredentialKey = (key: string): string => key.replace(/[-_\s]/g, '').toLowerCase()

function redactCredentialUrl(url: string): string {
  return url
    .replace(/^(https?:\/\/)[^\s/@]+:[^\s/@]+@/i, '$1[redacted]@')
    .replace(
      /([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|id[-_]?token|session[-_]?token|token|password|client[-_]?secret)=)[^&#]*/gi,
      '$1[redacted]',
    )
}

function redactCommandCredentials(command: string): string {
  // Only explicit credential flags/assignments. Do not search arbitrary command bodies for prose such as password=example.
  return command
    .replace(
      /(^|\s)(--?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|token|password|passwd|client[-_]?secret|private[-_]?key))(=|\s+)("[^"]*"|'[^']*'|[^\s]+)/gi,
      '$1$2$3[redacted]',
    )
    .replace(
      /(^|\s)((?:[A-Z][A-Z0-9_]*_)?(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|PASSWORD|PRIVATE_KEY)|GH_TOKEN|GITHUB_TOKEN)=("[^"]*"|'[^']*'|[^\s]+)/g,
      '$1$2=[redacted]',
    )
    .replace(
      /((?:-H|--header)(?:=|\s+)["']?(?:Authorization|Proxy-Authorization|Cookie):\s*)(?:Bearer\s+|Basic\s+)?[^"'\r\n]+/gi,
      '$1[redacted]',
    )
    .replace(/https?:\/\/[^\s"'<>]+/gi, redactCredentialUrl)
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, '[redacted]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})/g, '[redacted]')
}

/**
 * Sanitize only the display/persistence copy of native tool/approval input.
 * Never pass this copy back to an SDK: native execution and permission replies retain their original values.
 * Source, patches, user prose and answers deliberately keep their exact contents.
 */
export function redactNativeEventInput(
  input: unknown,
  options: { command?: boolean } = {},
): unknown {
  if (options.command && typeof input === 'string') return redactCommandCredentials(input)
  const seen = new WeakSet<object>()
  let remaining = 20_000
  const copy = (value: unknown, depth: number, sanitize: boolean, parent = ''): unknown => {
    if (--remaining < 0 || depth > 64) return '[omitted: input size limit]'
    if (value === null || typeof value !== 'object') return value
    if (seen.has(value)) return '[omitted: circular reference]'
    seen.add(value)
    try {
      if (Array.isArray(value)) {
        let hideNext = false
        const entries = value.slice(0, Math.max(0, remaining))
        const copied = entries.map((entry) => {
          if (sanitize && /^(?:args|argv|arguments)$/i.test(parent) && typeof entry === 'string') {
            if (hideNext) {
              hideNext = false
              return '[redacted]'
            }
            if (CREDENTIAL_FLAG.test(entry)) {
              hideNext = true
              return entry
            }
            const assignment = entry.match(/^(--?[^=]+)=(.*)$/s)
            if (assignment && CREDENTIAL_FLAG.test(assignment[1]))
              return assignment[1] + '=[redacted]'
            if (/^(?:Authorization|Proxy-Authorization|Cookie):/i.test(entry))
              return entry.replace(/^([^:]+:).*$/s, '$1 [redacted]')
          }
          return copy(entry, depth + 1, sanitize, parent)
        })
        if (entries.length < value.length) copied.push('[omitted: input size limit]')
        return copied
      }
      const result: Record<string, unknown> = Object.create(null)
      for (const [key, entry] of Object.entries(value)) {
        if (remaining <= 0) {
          result['[omitted]'] = 'input size limit'
          break
        }
        const keySafe = sanitize && !BODY_KEY.test(key)
        if (
          keySafe &&
          (CREDENTIAL_KEY.test(normalizeCredentialKey(key)) || CREDENTIAL_ENV.test(key))
        ) {
          result[key] = '[redacted]'
        } else if (
          keySafe &&
          typeof entry === 'string' &&
          /^(?:url|uri|endpoint|baseurl)$/i.test(key)
        ) {
          result[key] = redactCredentialUrl(entry)
        } else if (
          keySafe &&
          typeof entry === 'string' &&
          /^(?:command|cmd|shellcommand)$/i.test(key)
        ) {
          result[key] = redactCommandCredentials(entry)
        } else {
          result[key] = copy(entry, depth + 1, keySafe, key)
        }
      }
      return result
    } finally {
      seen.delete(value)
    }
  }
  return copy(input, 0, true, options.command ? 'argv' : '')
}
