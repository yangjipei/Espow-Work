import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DiagnosticBreadcrumb, DiagnosticEvent, DiagnosticLayer, DiagnosticSummary, RendererDiagnosticInput } from '../../src/diagnostic'
import { normalizeError } from './errorNormalizer'
import type { RemoteReporter } from './remoteReporter'
import { sanitizeDiagnosticEvent, sanitizeText } from './sanitizer'
import { createZip } from './zip'
import { validateDiagnosticEvent } from './schema'

const MAX_LOG_BYTES = 10 * 1024 * 1024
const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
const MAX_BREADCRUMBS = 100

export interface DiagnosticCaptureInput extends Omit<DiagnosticEvent, 'timestamp' | 'appVersion' | 'runtimeVersion' | 'os' | 'arch' | 'workspaceIdHash'> {
  timestamp?: string
  workspaceId?: string
  workspaceIdHash?: string
}

interface DiagnosticSettings { remoteReporting: boolean }

export class DiagnosticService {
  private readonly breadcrumbs: DiagnosticBreadcrumb[] = []
  private readonly errors: DiagnosticEvent[] = []
  private settings: DiagnosticSettings = { remoteReporting: false }
  private writeQueue = Promise.resolve()
  private localLoggingAvailable = true

  constructor(
    readonly logDirectory: string,
    private readonly appVersion: string,
    private readonly runtimeVersion: () => string,
    private readonly databaseStatus: () => DiagnosticSummary['databaseStatus'],
    private readonly runtimeStatus: () => string,
    private readonly reporter: RemoteReporter
  ) {}

  async initialize(): Promise<void> {
    try {
      await mkdir(this.logDirectory, { recursive: true })
      try {
        this.settings = JSON.parse(await readFile(join(this.logDirectory, 'settings.json'), 'utf8')) as DiagnosticSettings
      } catch { /* Defaults keep remote reporting explicitly disabled. */ }
      await this.cleanupLogs()
    } catch {
      this.localLoggingAvailable = false
    }
    this.addBreadcrumb({ layer: 'electron-main', action: 'app_start', status: 'success' })
  }

  capture(input: DiagnosticCaptureInput): void {
    const event = sanitizeDiagnosticEvent({
      ...input,
      timestamp: input.timestamp ?? new Date().toISOString(),
      appVersion: this.appVersion,
      runtimeVersion: this.runtimeVersion(),
      os: process.platform,
      arch: process.arch,
      workspaceIdHash: input.workspaceIdHash ?? (input.workspaceId ? this.hashWorkspaceId(input.workspaceId) : undefined)
    })
    delete (event as DiagnosticEvent & { workspaceId?: string }).workspaceId
    if (!validateDiagnosticEvent(event)) return
    if (event.level === 'error' || event.level === 'fatal') {
      this.errors.push(event)
      if (this.errors.length > 100) this.errors.shift()
    }
    this.enqueueWrite(this.logName(event), `${JSON.stringify(event)}\n`)
    if (this.settings.remoteReporting && this.reporter.configured && (event.level === 'error' || event.level === 'fatal')) {
      void this.reporter.capture(event, this.breadcrumbs).catch(() => undefined)
    }
  }

  captureError(error: unknown, input: Omit<DiagnosticCaptureInput, 'level' | 'errorCode' | 'errorMessage' | 'stack'> & { layer: DiagnosticLayer; errorCode?: string }): void {
    this.capture({ ...input, level: 'error', ...normalizeError(error, input.layer, input.errorCode) })
  }

  captureRenderer(input: RendererDiagnosticInput): void {
    this.capture({ ...input, layer: 'renderer', module: 'RendererGlobalErrorHandler' })
  }

  addBreadcrumb(input: Omit<DiagnosticBreadcrumb, 'timestamp' | 'workspaceIdHash'> & { timestamp?: string; workspaceId?: string; workspaceIdHash?: string }): void {
    const breadcrumb: DiagnosticBreadcrumb = {
      ...input,
      timestamp: input.timestamp ?? new Date().toISOString(),
      workspaceIdHash: input.workspaceIdHash ?? (input.workspaceId ? this.hashWorkspaceId(input.workspaceId) : undefined)
    }
    this.breadcrumbs.push(breadcrumb)
    if (this.breadcrumbs.length > MAX_BREADCRUMBS) this.breadcrumbs.shift()
  }

  getSummary(): DiagnosticSummary {
    const last = this.errors.at(-1)
    return {
      appVersion: this.appVersion,
      runtimeVersion: this.runtimeVersion(),
      os: process.platform,
      arch: process.arch,
      databaseStatus: this.databaseStatus(),
      runtimeStatus: this.runtimeStatus(),
      remoteReporting: this.settings.remoteReporting,
      remoteReporterConfigured: this.reporter.configured,
      localLogging: this.localLoggingAvailable,
      logDirectory: this.logDirectory,
      lastError: last ? {
        timestamp: last.timestamp, layer: last.layer, module: last.module, operation: last.operation,
        errorCode: last.errorCode, errorMessage: last.errorMessage
      } : null
    }
  }

  async setRemoteReporting(enabled: boolean): Promise<DiagnosticSummary> {
    this.settings.remoteReporting = enabled
    await writeFile(join(this.logDirectory, 'settings.json'), JSON.stringify(this.settings), { mode: 0o600 })
    this.addBreadcrumb({ layer: 'electron-main', action: 'remote_reporting_changed', status: 'info' })
    return this.getSummary()
  }

  async exportBundle(destination: string): Promise<void> {
    await this.writeQueue
    const entries: Array<{ name: string; data: Buffer }> = [
      { name: 'diagnostic/environment.json', data: Buffer.from(JSON.stringify(this.getSummary(), null, 2)) },
      { name: 'diagnostic/recent-errors.json', data: Buffer.from(JSON.stringify(this.errors.map(sanitizeDiagnosticEvent), null, 2)) },
      { name: 'diagnostic/breadcrumbs.json', data: Buffer.from(JSON.stringify(this.breadcrumbs, null, 2)) }
    ]
    for (const name of ['app.log', 'runtime.log', 'model.log', 'error.log']) {
      try {
        const raw = await readFile(join(this.logDirectory, name), 'utf8')
        const safe = raw.split('\n').filter(Boolean).map((line) => {
          try { return JSON.stringify(sanitizeDiagnosticEvent(JSON.parse(line) as DiagnosticEvent)) } catch { return sanitizeText(line) }
        }).join('\n')
        entries.push({ name: `diagnostic/${name}`, data: Buffer.from(safe) })
      } catch { /* Missing log categories are valid. */ }
    }
    await writeFile(destination, createZip(entries), { mode: 0o600 })
  }

  hashWorkspaceId(workspaceId: string): string {
    return createHash('sha256').update(`espow-work:${workspaceId}`).digest('hex').slice(0, 24)
  }

  private logName(event: DiagnosticEvent): string {
    if (event.level === 'error' || event.level === 'fatal') return 'error.log'
    if (event.layer === 'runtime' || event.layer === 'tool' || event.layer === 'script') return 'runtime.log'
    if (event.layer === 'model') return 'model.log'
    return 'app.log'
  }

  private enqueueWrite(name: string, content: string): void {
    if (!this.localLoggingAvailable) return
    this.writeQueue = this.writeQueue.then(async () => {
      const path = join(this.logDirectory, name)
      try {
        const info = await stat(path)
        if (info.size >= MAX_LOG_BYTES) await rename(path, `${path}.${Date.now()}`)
      } catch { /* New log file. */ }
      await appendFile(path, content, { mode: 0o600 })
    }).catch(() => undefined)
  }

  private async cleanupLogs(): Promise<void> {
    const now = Date.now()
    for (const name of await readdir(this.logDirectory)) {
      if (!/\.log\.\d+$/.test(name)) continue
      const path = join(this.logDirectory, name)
      try { if (now - (await stat(path)).mtimeMs > RETENTION_MS) await unlink(path) } catch { /* Best effort. */ }
    }
  }
}
