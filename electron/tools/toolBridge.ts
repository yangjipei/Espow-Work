import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { espowToolContracts, type ToolCallRecord, type WriteApprovalRequest } from '../../src/tools'
import { EspowToolError, EspowToolService, type ToolExecutionContext, type ToolName } from './toolService'
import { RuntimeExecutor } from '../runtime/runtimeExecutor'

const maxRequestBytes = 6 * 1024 * 1024
const toolNames = new Set(espowToolContracts.map((tool) => tool.name))

export interface ToolBridgeEvent {
  call: ToolCallRecord
  output?: Record<string, unknown>
  approval?: WriteApprovalRequest
}

export interface ActiveToolRun extends ToolExecutionContext {
  onEvent: (event: ToolBridgeEvent) => void
}

interface ToolRequest {
  callId?: unknown
  name?: unknown
  args?: unknown
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxRequestBytes) throw new EspowToolError('INVALID_INPUT', 'Tool 请求超过大小限制。')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new EspowToolError('INVALID_INPUT', 'Tool 请求不是合法 JSON。')
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json) })
  response.end(json)
}

export class EspowToolBridge {
  private readonly token = randomBytes(32).toString('hex')
  private readonly server = createServer((request, response) => void this.handle(request, response))
  private active: ActiveToolRun | null = null
  private url: string | null = null
  private readonly executor: RuntimeExecutor

  constructor(tools: EspowToolService) {
    this.executor = new RuntimeExecutor(tools)
  }

  async start(): Promise<{ url: string; token: string }> {
    if (this.url) return { url: this.url, token: this.token }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      this.server.once('error', onError)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', onError)
        resolve()
      })
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('ESPow Tool Bridge 无法获取监听地址。')
    this.url = `http://127.0.0.1:${address.port}/tool`
    return { url: this.url, token: this.token }
  }

  activate(run: ActiveToolRun): () => void {
    if (this.active) throw new Error('ESPow Tool Bridge 已绑定其他 Run。')
    this.active = run
    return () => {
      if (this.active === run) this.active = null
    }
  }

  async close(): Promise<void> {
    this.active = null
    if (!this.server.listening) return
    await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()))
    this.url = null
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST' || request.url !== '/tool') return send(response, 404, { ok: false })
    if (request.headers.authorization !== `Bearer ${this.token}`) return send(response, 403, { ok: false, error: { code: 'PERMISSION_DENIED', message: 'Tool Bridge 身份校验失败。' } })
    const active = this.active
    if (!active) return send(response, 409, { ok: false, error: { code: 'NO_ACTIVE_RUN', message: '当前没有绑定的 Agent Run。' } })
    let call: ToolCallRecord | null = null
    try {
      const body = await readBody(request) as ToolRequest
      if (typeof body.name !== 'string' || !toolNames.has(body.name)) throw new EspowToolError('INVALID_INPUT', '未知 ESPow Tool。')
      call = {
        id: typeof body.callId === 'string' && body.callId ? body.callId : randomUUID(),
        name: body.name,
        status: 'Running',
        startedAt: new Date().toISOString(),
        completedAt: null,
        error: null
      }
      active.onEvent({ call })
      const output = await this.executor.execute(body.name as ToolName, body.args, active)
      const completed: ToolCallRecord = { ...call, status: output.status === 'approval-required' ? 'WaitingConfirmation' : 'Completed', completedAt: new Date().toISOString() }
      const approval = output.approval && typeof output.approval === 'object' ? output.approval as unknown as WriteApprovalRequest : undefined
      active.onEvent({ call: completed, output, approval })
      send(response, 200, { ok: true, output })
    } catch (error) {
      const code = error instanceof EspowToolError ? error.code : 'TOOL_FAILED'
      const message = error instanceof Error ? error.message : 'ESPow Tool 执行失败。'
      if (call) active.onEvent({ call: { ...call, status: 'Failed', completedAt: new Date().toISOString(), error: message } })
      send(response, 400, { ok: false, error: { code, message } })
    }
  }
}
