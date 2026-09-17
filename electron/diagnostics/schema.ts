import type { DiagnosticEvent, DiagnosticLayer, DiagnosticLevel } from '../../src/diagnostic'

const levels = new Set<DiagnosticLevel>(['debug', 'info', 'warn', 'error', 'fatal'])
const layers = new Set<DiagnosticLayer>(['renderer', 'electron-main', 'runtime', 'persistence', 'model', 'tool', 'script'])

export function validateDiagnosticEvent(value: DiagnosticEvent): boolean {
  if (!value || typeof value !== 'object') return false
  if (!levels.has(value.level) || !layers.has(value.layer)) return false
  if (typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))) return false
  if (value.metadata && Object.values(value.metadata).some((item) => item !== null && !['string', 'number', 'boolean'].includes(typeof item))) return false
  return true
}
