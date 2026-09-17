import type { DiagnosticLayer } from '../../src/diagnostic'

const rules: Array<[RegExp, string]> = [
  [/database (?:is )?not open|sqlite is closed|database is already closed/i, 'DB_NOT_OPEN'],
  [/sqlite|database|query failed/i, 'DB_QUERY_FAILED'],
  [/returned no content|empty response|no content/i, 'MODEL_EMPTY_RESPONSE'],
  [/model.*timeout|request.*timeout|timed out/i, 'MODEL_TIMEOUT'],
  [/model.*parse|response.*parse|invalid.*json/i, 'MODEL_PARSE_FAILED'],
  [/model|provider|api request/i, 'MODEL_REQUEST_FAILED'],
  [/tool/i, 'TOOL_EXECUTION_FAILED'],
  [/script/i, 'SCRIPT_EXECUTION_FAILED'],
  [/workspace/i, 'WORKSPACE_LOAD_FAILED'],
  [/session|thread/i, 'SESSION_LOAD_FAILED'],
  [/ipc/i, 'IPC_CALL_FAILED'],
  [/panic/i, 'RUNTIME_PANIC']
]

export function normalizeError(error: unknown, layer: DiagnosticLayer, explicitCode?: string): { errorCode: string; errorMessage: string; stack?: string } {
  const value = error instanceof Error ? error : new Error(String(error))
  const text = `${value.name}: ${value.message}`
  const fallback = layer === 'runtime' ? 'RUNTIME_UNHANDLED_ERROR' : `${layer.replace('-', '_').toUpperCase()}_UNHANDLED_ERROR`
  return {
    errorCode: explicitCode || rules.find(([pattern]) => pattern.test(text))?.[1] || fallback,
    errorMessage: value.message || String(error),
    stack: value.stack
  }
}
