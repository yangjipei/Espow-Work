import type { DiagnosticEvent } from '../../src/diagnostic'

const forbiddenKeys = /(^|_)(api_?key|authorization|secret|token|prompt|content|body|payload|message|email|phone|identity|bank|attachment|prd|mainline|artifact)(_|$)/i
const secretPatterns: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:sk|sess)-[A-Za-z0-9_-]{12,}\b/g,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\b1[3-9]\d{9}\b/g,
  /\b\d{15,19}\b/g,
  /\/Users\/[^/\s]+/g,
  /[A-Z]:\\Users\\[^\\\s]+/gi
]

export function sanitizeText(value: string): string {
  let result = value.slice(0, 8_000)
  for (const pattern of secretPatterns) result = result.replace(pattern, '[REDACTED]')
  return result
}

export function sanitizeMetadata(metadata: DiagnosticEvent['metadata']): DiagnosticEvent['metadata'] {
  if (!metadata) return undefined
  const safe: NonNullable<DiagnosticEvent['metadata']> = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (forbiddenKeys.test(key)) continue
    safe[key] = typeof value === 'string' ? sanitizeText(value) : value
  }
  return Object.keys(safe).length ? safe : undefined
}

export function sanitizeDiagnosticEvent(event: DiagnosticEvent): DiagnosticEvent {
  return {
    ...event,
    errorMessage: event.errorMessage ? sanitizeText(event.errorMessage) : undefined,
    stack: event.stack ? sanitizeText(event.stack) : undefined,
    metadata: sanitizeMetadata(event.metadata)
  }
}
