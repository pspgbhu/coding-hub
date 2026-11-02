/** Strip credentials from provider error messages before logging or persisting them. */
export function redactDiagnostics(value: string): string {
  return value
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, '[redacted]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.\-]{12,}/gi, '$1 [redacted]')
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password)["']?\s*[:=]\s*["']?)([^\s"',;}]+)/gi,
      '$1[redacted]',
    )
}
