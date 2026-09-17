export const diagnosticIpc = {
  getSummary: 'diagnostic:get-summary',
  setRemoteReporting: 'diagnostic:set-remote-reporting',
  captureRendererError: 'diagnostic:capture-renderer-error',
  addBreadcrumb: 'diagnostic:add-breadcrumb',
  openLogs: 'diagnostic:open-logs',
  exportBundle: 'diagnostic:export-bundle'
} as const

export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'
export type DiagnosticLayer = 'renderer' | 'electron-main' | 'runtime' | 'persistence' | 'model' | 'tool' | 'script'

export interface DiagnosticEvent {
  timestamp: string
  level: DiagnosticLevel
  layer: DiagnosticLayer
  module?: string
  operation?: string
  errorCode?: string
  errorMessage?: string
  stack?: string
  appVersion?: string
  runtimeVersion?: string
  os?: string
  arch?: string
  sessionId?: string
  workspaceIdHash?: string
  runId?: string
  stage?: string
  slot?: string
  provider?: string
  model?: string
  toolName?: string
  scriptName?: string
  inputTokens?: number
  outputTokens?: number
  durationMs?: number
  metadata?: Record<string, string | number | boolean | null>
}

export interface DiagnosticBreadcrumb {
  timestamp: string
  layer: DiagnosticLayer
  action: string
  status: 'start' | 'success' | 'failure' | 'info'
  runId?: string
  workspaceIdHash?: string
  durationMs?: number
}

export interface RendererDiagnosticInput {
  level: 'error' | 'fatal'
  operation: 'window.error' | 'unhandledrejection' | 'react.error-boundary'
  errorMessage: string
  stack?: string
}

export interface DiagnosticSummary {
  appVersion: string
  runtimeVersion: string
  os: string
  arch: string
  databaseStatus: 'connected' | 'unavailable'
  runtimeStatus: string
  remoteReporting: boolean
  remoteReporterConfigured: boolean
  localLogging: boolean
  logDirectory: string
  lastError: Pick<DiagnosticEvent, 'timestamp' | 'layer' | 'module' | 'operation' | 'errorCode' | 'errorMessage'> | null
}

export interface DiagnosticApi {
  getSummary: () => Promise<DiagnosticSummary>
  setRemoteReporting: (enabled: boolean) => Promise<DiagnosticSummary>
  captureRendererError: (event: RendererDiagnosticInput) => Promise<void>
  addBreadcrumb: (action: string, status?: DiagnosticBreadcrumb['status']) => Promise<void>
  openLogs: () => Promise<string | null>
  exportBundle: () => Promise<{ canceled: boolean; path?: string; error?: string }>
}
