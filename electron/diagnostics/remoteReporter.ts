import type { DiagnosticBreadcrumb, DiagnosticEvent } from '../../src/diagnostic'

export interface RemoteReporter {
  readonly configured: boolean
  capture(event: DiagnosticEvent, breadcrumbs: DiagnosticBreadcrumb[]): Promise<void>
}

export class SentryReporter implements RemoteReporter {
  readonly configured: boolean
  private readonly endpoint: string | null
  private readonly publicKey: string | null

  constructor(dsn = process.env.ESPOW_SENTRY_DSN ?? '') {
    try {
      const url = new URL(dsn)
      const projectId = url.pathname.split('/').filter(Boolean).at(-1)
      if (!url.username || !projectId) throw new Error('Invalid Sentry DSN')
      this.publicKey = url.username
      this.endpoint = `${url.protocol}//${url.host}/api/${projectId}/envelope/`
      this.configured = true
    } catch {
      this.publicKey = null
      this.endpoint = null
      this.configured = false
    }
  }

  async capture(event: DiagnosticEvent, breadcrumbs: DiagnosticBreadcrumb[]): Promise<void> {
    if (!this.endpoint || !this.publicKey) return
    const eventId = crypto.randomUUID().replaceAll('-', '')
    const envelope = [
      JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() }),
      JSON.stringify({ type: 'event' }),
      JSON.stringify({
        event_id: eventId,
        timestamp: Date.parse(event.timestamp) / 1000,
        level: event.level,
        platform: 'node',
        logger: `espow.${event.layer}`,
        message: event.errorMessage ?? `${event.module ?? event.layer}:${event.operation ?? 'event'}`,
        tags: {
          layer: event.layer, module: event.module, operation: event.operation, error_code: event.errorCode,
          app_version: event.appVersion, runtime_version: event.runtimeVersion, stage: event.stage, slot: event.slot,
          provider: event.provider, model: event.model, tool_name: event.toolName, script_name: event.scriptName
        },
        extra: { ...event, stack: undefined, errorMessage: undefined },
        exception: event.stack ? { values: [{ type: event.errorCode ?? 'Error', value: event.errorMessage, stacktrace: { frames: [] } }] } : undefined,
        breadcrumbs: { values: breadcrumbs.map((item) => ({ timestamp: Date.parse(item.timestamp) / 1000, category: item.layer, message: item.action, level: item.status === 'failure' ? 'error' : 'info', data: item })) }
      })
    ].join('\n')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5_000)
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST', body: envelope, signal: controller.signal,
        headers: { 'Content-Type': 'application/x-sentry-envelope', 'X-Sentry-Auth': `Sentry sentry_version=7,sentry_key=${this.publicKey},sentry_client=espow-work/0.1` }
      })
      if (!response.ok) throw new Error(`Sentry HTTP ${response.status}`)
    } finally {
      clearTimeout(timeout)
    }
  }
}
