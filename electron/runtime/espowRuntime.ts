import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface, type Interface as ReadLineInterface } from 'node:readline'
import type { RuntimeStatus } from '../../src/runtime'
import type { AgentRuntime, RuntimeContextSource, RuntimeEvent, RuntimeRunRequest } from './agentRuntime'
import { RuntimeError } from './agentRuntime'
import { addDiagnosticBreadcrumb, reportDiagnostic, reportDiagnosticError } from '../diagnostics/diagnosticBridge'

const EXPECTED_PROTOCOL_VERSION = '1'


export interface RuntimeUiLearningStatus { active: boolean; url?: string | null; engine?: string }
export interface RuntimeUiLearningCapture { active: boolean; capture: unknown | null }

interface RpcResponse {
  id?: string
  result?: unknown
  error?: { code?: string; message?: string }
}

interface RuntimeWireEvent {
  eventId?: string
  runId?: string
  threadId?: string
  turnId?: string
  createdAt?: string
  type?: string
  delta?: string
  content?: string
  toolName?: string
  required?: boolean
  reason?: RuntimeEvent['followupReason']
  callId?: string
  step?: number
  callReason?: RuntimeEvent['callReason']
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  executionContent?: string
  messageCount?: number
  toolCount?: number
  systemPromptChars?: number
  contextPackageChars?: number
  toolSchemaChars?: number
  assistantHistoryChars?: number
  toolResultChars?: number
  estimatedInputTokens?: number
  historyTokens?: number
  inputBreakdown?: Array<{ source: RuntimeContextSource; tokens: number; percentage: number }>
  error?: string
  code?: string
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

class EventQueue {
  private readonly values: RuntimeEvent[] = []
  private readonly waiters: Array<(value: RuntimeEvent | null) => void> = []
  private ended = false

  push(value: RuntimeEvent): void {
    if (this.ended) return
    const waiter = this.waiters.shift()
    if (waiter) waiter(value)
    else this.values.push(value)
  }

  close(): void {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter(null)
  }

  async next(): Promise<RuntimeEvent | null> {
    const value = this.values.shift()
    if (value) return value
    if (this.ended) return null
    return new Promise((resolve) => this.waiters.push(resolve))
  }
}

function runtimeBinary(projectRoot: string): string {
  if (process.env.ESPOW_RUNTIME_BIN) return process.env.ESPOW_RUNTIME_BIN
  const suffix = process.platform === 'win32' ? '.exe' : ''
  return join(projectRoot, 'espow-runtime', 'target', 'debug', `espow-runtime${suffix}`)
}

function readableError(error: unknown): RuntimeError {
  const technical = error instanceof Error ? error.message : String(error)
  if (/ENOENT|not found/i.test(technical)) return new RuntimeError('ESPow Runtime 尚未构建，请先执行 npm run runtime:build。', 'not-installed', technical)
  return new RuntimeError('ESPow Runtime 启动或通信失败。', 'start-failed', technical)
}

function eventFromWire(value: RuntimeWireEvent): RuntimeEvent | null {
  if (!value.runId || !value.threadId || !value.turnId || !value.type) return null
  const wireTime = typeof value.createdAt === 'string' ? Number(value.createdAt) : Number.NaN
  const base = {
    eventId: value.eventId,
    runId: value.runId,
    threadId: value.threadId,
    turnId: value.turnId,
    createdAt: Number.isFinite(wireTime) ? new Date(wireTime).toISOString() : new Date().toISOString()
  }
  switch (value.type) {
    case 'run_started': return { ...base, type: 'run_started' }
    case 'model_started': return { ...base, type: 'model_started', step: value.step, modelCallId: value.callId, callReason: value.callReason }
    case 'message_delta': return typeof value.delta === 'string' ? { ...base, type: 'message_delta', delta: value.delta } : null
    case 'message_completed': return { ...base, type: 'message_completed', content: value.content ?? '' }
    case 'tool_started': return { ...base, type: 'tool_started', toolName: value.toolName, callId: value.callId, step: value.step }
    case 'tool_completed': return { ...base, type: 'tool_completed', toolName: value.toolName, callId: value.callId, step: value.step }
    case 'followup_decision': return { ...base, type: 'followup_decision', toolName: value.toolName, step: value.step, followupRequired: value.required, followupReason: value.reason }
    case 'model_usage': {
      const inputTokens = value.inputTokens ?? 0
      const outputTokens = value.outputTokens ?? 0
      const totalTokens = value.totalTokens ?? inputTokens + outputTokens
      return {
        ...base, type: 'model_usage', step: value.step, modelCallId: value.callId, callReason: value.callReason, durationMs: value.durationMs,
        usage: { inputTokens, outputTokens, totalTokens }, executionContent: value.executionContent,
        metrics: {
          messageCount: value.messageCount ?? 0,
          toolCount: value.toolCount ?? 0,
          systemPromptChars: value.systemPromptChars ?? 0,
          contextPackageChars: value.contextPackageChars ?? 0,
          toolSchemaChars: value.toolSchemaChars ?? 0,
          assistantHistoryChars: value.assistantHistoryChars ?? 0,
          toolResultChars: value.toolResultChars ?? 0,
          estimatedInputTokens: value.estimatedInputTokens ?? 0,
          historyTokens: value.historyTokens ?? 0,
          inputBreakdown: value.inputBreakdown ?? []
        }
      }
    }
    case 'run_completed': return { ...base, type: 'run_completed' }
    case 'run_cancelled': return { ...base, type: 'run_cancelled' }
    case 'run_failed': return { ...base, type: 'run_failed', error: value.error ?? 'ESPow Runtime 执行失败。', errorCode: value.code }
    default: return null
  }
}

export class EspowRuntime implements AgentRuntime {
  readonly type = 'espow-runtime' as const
  private child: ChildProcessWithoutNullStreams | null = null
  private lines: ReadLineInterface | null = null
  private status: RuntimeStatus['status'] = 'stopped'
  private lastError: string | null = null
  private activeRunId: string | null = null
  private version = '0.1.0'
  private shuttingDown = false
  private readonly pending = new Map<string, PendingRequest>()
  private readonly runQueues = new Map<string, EventQueue>()

  constructor(private readonly projectRoot: string) {}

  async start(): Promise<void> {
    if (this.child && this.status === 'running') return
    this.status = 'starting'
    this.shuttingDown = false
    this.lastError = null
    const binary = runtimeBinary(this.projectRoot)
    if (!existsSync(binary)) {
      this.status = 'error'
      this.lastError = 'ESPow Runtime 尚未构建。'
      throw new RuntimeError('ESPow Runtime 尚未构建，请先执行 npm run runtime:build。', 'not-installed', binary)
    }
    try {
      addDiagnosticBreadcrumb({ layer: 'runtime', action: 'runtime_start', status: 'start' })
      const child = spawn(binary, [], {
        cwd: this.projectRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, RUST_LOG: process.env.RUST_LOG ?? 'espow_runtime=info' }
      })
      this.child = child
      this.lines = createInterface({ input: child.stdout })
      this.lines.on('line', (line) => this.handleLine(line))
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string | Buffer) => {
        const text = String(chunk).trim()
        if (text) console.error('[espow-runtime]', text)
        if (/\b(ERROR|panic|fatal)\b/i.test(text)) reportDiagnostic({ level: /panic|fatal/i.test(text) ? 'fatal' : 'error', layer: 'runtime', module: 'RustRuntime', operation: 'stderr', errorCode: /panic/i.test(text) ? 'RUNTIME_PANIC' : 'RUNTIME_UNHANDLED_ERROR', errorMessage: text, runId: this.activeRunId ?? undefined })
      })
      child.once('error', (error) => this.handleExit(error))
      child.once('exit', (code, signal) => this.handleExit(new Error(`ESPow Runtime exited (${code ?? 'null'}, ${signal ?? 'no-signal'})`)))
      const initialized = await this.request<{ runtime?: string; runtimeVersion?: string; protocolVersion?: string }>('runtime.initialize', {})
      if (initialized.protocolVersion !== EXPECTED_PROTOCOL_VERSION) {
        throw new RuntimeError(`ESPow Runtime 协议版本不兼容：expected=${EXPECTED_PROTOCOL_VERSION}, actual=${initialized.protocolVersion ?? 'missing'}`, 'protocol-error')
      }
      if (initialized.runtimeVersion) this.version = initialized.runtimeVersion
      await this.request('runtime.ping', {})
      this.status = 'running'
      addDiagnosticBreadcrumb({ layer: 'runtime', action: 'runtime_start', status: 'success' })
    } catch (error) {
      const runtimeError = error instanceof RuntimeError ? error : readableError(error)
      this.lastError = runtimeError.message
      this.status = 'error'
      await this.forceClose()
      reportDiagnosticError(error, { layer: 'runtime', module: 'EspowRuntime', operation: 'start', errorCode: 'RUNTIME_START_FAILED' })
      throw runtimeError
    }
  }

  async *run(request: RuntimeRunRequest): AsyncIterable<RuntimeEvent> {
    await this.start()
    if (this.activeRunId) throw new RuntimeError('当前已有 Runtime Run 正在执行。', 'run-conflict')
    const queue = new EventQueue()
    this.runQueues.set(request.runId, queue)
    this.activeRunId = request.runId
    try {
      try {
        await this.request('run.start', request, 30_000)
      } catch (error) {
        await this.request('run.cancel', { runId: request.runId }, 2_000).catch(() => undefined)
        throw error
      }
      while (true) {
        const event = await queue.next()
        if (!event) break
        yield event
        if (event.type === 'run_completed' || event.type === 'run_failed' || event.type === 'run_cancelled') break
      }
    } finally {
      queue.close()
      this.runQueues.delete(request.runId)
      if (this.activeRunId === request.runId) this.activeRunId = null
    }
  }

  async startUiLearning(url: string, profileDir: string): Promise<RuntimeUiLearningStatus> {
    await this.start()
    return this.request<RuntimeUiLearningStatus>('ui_learning.start', { url, profileDir }, 30_000)
  }

  async focusUiLearning(): Promise<RuntimeUiLearningStatus> {
    await this.start()
    return this.request<RuntimeUiLearningStatus>('ui_learning.focus', {}, 10_000)
  }

  async captureUiLearning(script: string): Promise<RuntimeUiLearningCapture> {
    await this.start()
    return this.request<RuntimeUiLearningCapture>('ui_learning.capture', { script }, 15_000)
  }

  async screenshotUiLearning(path: string, sanitizeCss: string): Promise<{ ok: boolean; path?: string }> {
    await this.start()
    return this.request<{ ok: boolean; path?: string }>('ui_learning.screenshot', { path, sanitizeCss }, 20_000)
  }

  async uiLearningStatus(): Promise<RuntimeUiLearningStatus> {
    await this.start()
    return this.request<RuntimeUiLearningStatus>('ui_learning.status', {}, 10_000)
  }

  async stopUiLearning(): Promise<void> {
    if (!this.child || this.status !== 'running') return
    await this.request('ui_learning.stop', {}, 10_000)
  }

  async cancel(runId: string): Promise<boolean> {
    if (!this.child || this.status !== 'running') return false
    const result = await this.request<{ cancelled?: boolean }>('run.cancel', { runId }, 10_000)
    return result.cancelled === true
  }

  async shutdown(): Promise<void> {
    const child = this.child
    this.shuttingDown = true
    if (!child) {
      this.status = 'stopped'
      this.shuttingDown = false
      return
    }
    try {
      if (this.status === 'running') await this.request('runtime.shutdown', {}, 2_000).catch(() => undefined)
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.killed) return resolve()
        const timeout = setTimeout(() => { child.kill('SIGTERM'); resolve() }, 2_000)
        child.once('exit', () => { clearTimeout(timeout); resolve() })
      })
    } finally {
      await this.forceClose()
      this.status = 'stopped'
      this.activeRunId = null
      this.shuttingDown = false
    }
  }

  getStatus(): RuntimeStatus {
    return {
      runtimeType: this.type,
      label: 'ESPow Runtime',
      status: this.status,
      version: this.version,
      activeRunId: this.activeRunId,
      error: this.lastError
    }
  }

  private request<T = Record<string, unknown>>(method: string, params: unknown, timeoutMs = 10_000): Promise<T> {
    const child = this.child
    if (!child || child.stdin.destroyed) return Promise.reject(new RuntimeError('ESPow Runtime 连接已关闭。', 'connection-closed'))
    const id = randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new RuntimeError(`ESPow Runtime 请求超时：${method}`, 'connection-closed'))
      }, timeoutMs)
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timeout })
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return
        clearTimeout(timeout)
        this.pending.delete(id)
        reject(readableError(error))
      })
    })
  }

  private handleLine(line: string): void {
    let value: RpcResponse & { event?: RuntimeWireEvent }
    try {
      value = JSON.parse(line) as RpcResponse & { event?: RuntimeWireEvent }
    } catch {
      console.error('[espow-runtime] Invalid protocol JSON', line.slice(0, 500))
      reportDiagnostic({ level: 'error', layer: 'runtime', module: 'EspowRuntime', operation: 'parseProtocol', errorCode: 'RUNTIME_PROTOCOL_ERROR', errorMessage: 'Invalid protocol JSON' })
      return
    }
    if (value.event) {
      const event = eventFromWire(value.event)
      if (!event) return
      const queue = this.runQueues.get(event.runId)
      queue?.push(event)
      if (event.type === 'run_completed' || event.type === 'run_failed' || event.type === 'run_cancelled') queue?.close()
      return
    }
    if (!value.id) return
    const pending = this.pending.get(value.id)
    if (!pending) return
    clearTimeout(pending.timeout)
    this.pending.delete(value.id)
    if (value.error) pending.reject(new RuntimeError(value.error.message ?? 'ESPow Runtime 请求失败。', value.error.code === 'run-conflict' ? 'run-conflict' : 'protocol-error'))
    else pending.resolve(value.result)
  }

  private handleExit(error: Error): void {
    if (!this.child) return
    const wasStopping = this.shuttingDown || this.status === 'stopped'
    if (!wasStopping) {
      this.lastError = error.message
      this.status = 'error'
      console.error('[runtime] ESPow Runtime exited unexpectedly', error.message)
      reportDiagnosticError(error, { layer: 'runtime', module: 'EspowRuntime', operation: 'processExit', errorCode: 'RUNTIME_PROCESS_EXITED', runId: this.activeRunId ?? undefined })
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new RuntimeError('ESPow Runtime 连接已中断。', 'connection-closed', error.message))
    }
    this.pending.clear()
    for (const queue of this.runQueues.values()) queue.close()
    this.runQueues.clear()
    this.lines?.close()
    this.lines = null
    this.child = null
    this.activeRunId = null
  }

  private async forceClose(): Promise<void> {
    this.lines?.close()
    this.lines = null
    const child = this.child
    this.child = null
    if (child && child.exitCode === null && !child.killed) child.kill('SIGTERM')
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new RuntimeError('ESPow Runtime 已关闭。', 'connection-closed'))
    }
    this.pending.clear()
    for (const queue of this.runQueues.values()) queue.close()
    this.runQueues.clear()
  }
}
