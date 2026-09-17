import type { ModelProviderId } from '../src/model'
import type { MessageRole } from '../src/persistence'

export interface StoredModelConfig {
  provider: ModelProviderId
  apiKey: string
  model: string
  baseUrl: string
}

export interface ModelRequest {
  messages: Array<{ role: MessageRole; content: string }>
  maxOutputTokens?: number
}

export type ModelEvent = { type: 'delta'; delta: string } | { type: 'completed' }

export interface ModelCompletion {
  content: string
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null
}

export interface ModelProvider {
  testConnection(config: StoredModelConfig, maxOutputTokens?: number): Promise<void>
  completeChat(request: ModelRequest, config: StoredModelConfig, signal: AbortSignal): Promise<ModelCompletion>
  streamChat(request: ModelRequest, config: StoredModelConfig, signal: AbortSignal): AsyncIterable<ModelEvent>
}

export class ProviderRequestError extends Error {
  constructor(message: string, readonly code: 'authentication' | 'model' | 'network' | 'timeout' | 'provider' | 'stream') {
    super(message)
    this.name = 'ProviderRequestError'
  }
}

interface ChatChunk {
  choices?: Array<{
    delta?: { content?: string | null }
    finish_reason?: string | null
  }>
  error?: { message?: string }
}

function completionUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '')
  try {
    new URL(normalized)
  } catch {
    throw new ProviderRequestError('Base URL 格式无效，请填写完整的 http(s) 地址。', 'network')
  }
  return `${normalized}/chat/completions`
}

async function responseError(response: Response): Promise<ProviderRequestError> {
  let detail = ''
  try {
    const body = await response.json() as { error?: { message?: string }; message?: string }
    detail = body.error?.message ?? body.message ?? ''
  } catch {
    detail = ''
  }
  const suffix = detail ? `：${detail}` : ''
  if (response.status === 401 || response.status === 403) return new ProviderRequestError(`API Key 无效或没有访问权限${suffix}`, 'authentication')
  if (response.status === 404) return new ProviderRequestError(`Model 或 Base URL 不存在${suffix}`, 'model')
  if (response.status === 429) return new ProviderRequestError(`Provider 请求受限或额度不足${suffix}`, 'provider')
  return new ProviderRequestError(`Provider 请求失败（HTTP ${response.status}）${suffix}`, 'provider')
}

export async function* parseSseStream(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() ?? ''
      for (const block of blocks) {
        const data = block.split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (data) yield data
      }
      if (done) break
    }
    const data = buffer.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (data) yield data
  } finally {
    reader.releaseLock()
  }
}

abstract class ChatCompletionsProvider implements ModelProvider {
  abstract readonly id: ModelProviderId

  async testConnection(config: StoredModelConfig, maxOutputTokens = 400): Promise<void> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    try {
      for await (const _event of this.streamChat({ messages: [{ role: 'user', content: '仅回复 OK' }], maxOutputTokens }, config, controller.signal)) {
        // 完整消费流，确保 Model 确实可调用且响应可以解析。
      }
    } catch (error) {
      if (controller.signal.aborted) throw new ProviderRequestError('连接测试超时，请检查网络、Base URL 或稍后重试。', 'timeout')
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  async completeChat(request: ModelRequest, config: StoredModelConfig, signal: AbortSignal): Promise<ModelCompletion> {
    const response = await fetch(completionUrl(config.baseUrl), {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.model, messages: request.messages, stream: false, max_tokens: request.maxOutputTokens ?? 240 }),
      signal
    }).catch((error: unknown) => {
      if (signal.aborted) throw error
      throw new ProviderRequestError(`无法连接模型服务：${error instanceof Error ? error.message : '网络异常'}`, 'network')
    })
    if (!response.ok) throw await responseError(response)
    const body = await response.json() as {
      choices?: Array<{ message?: { content?: string | null } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
    }
    const content = body.choices?.[0]?.message?.content?.trim()
    if (!content) throw new ProviderRequestError('Provider 未返回可解析的 Completion。', 'stream')
    const usage = body.usage && Number.isSafeInteger(body.usage.prompt_tokens) && Number.isSafeInteger(body.usage.completion_tokens)
      ? {
          inputTokens: body.usage.prompt_tokens!, outputTokens: body.usage.completion_tokens!,
          totalTokens: Number.isSafeInteger(body.usage.total_tokens) ? body.usage.total_tokens! : body.usage.prompt_tokens! + body.usage.completion_tokens!
        }
      : null
    return { content, usage }
  }

  async *streamChat(request: ModelRequest, config: StoredModelConfig, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const controller = new AbortController()
    let timedOut = false
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(() => { timedOut = true; controller.abort() }, 120_000)
    try {
      let response: Response
      try {
        response = await fetch(completionUrl(config.baseUrl), {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: config.model, messages: request.messages, stream: true, max_tokens: request.maxOutputTokens ?? 1_200 }),
          signal: controller.signal
        })
      } catch (error) {
        if (timedOut) throw new ProviderRequestError('请求超时，请检查网络、Base URL 或稍后重试。', 'timeout')
        if (signal.aborted) throw error
        throw new ProviderRequestError(`无法连接模型服务：${error instanceof Error ? error.message : '网络异常'}`, 'network')
      }
      if (!response.ok) throw await responseError(response)
      if (!response.body) throw new ProviderRequestError('Provider 未返回可读取的 Streaming Response。', 'stream')

      let completed = false
      for await (const data of parseSseStream(response.body)) {
        if (data === '[DONE]') {
          completed = true
          break
        }
        let chunk: ChatChunk
        try {
          chunk = JSON.parse(data) as ChatChunk
        } catch {
          throw new ProviderRequestError('Provider 返回了无法解析的 Streaming 数据。', 'stream')
        }
        if (chunk.error?.message) throw new ProviderRequestError(`Provider 返回错误：${chunk.error.message}`, 'provider')
        const choice = chunk.choices?.[0]
        if (choice?.delta?.content) yield { type: 'delta', delta: choice.delta.content }
        if (choice?.finish_reason) completed = true
      }
      if (!completed) throw new ProviderRequestError('Streaming Response 意外中断，请重试。', 'stream')
      yield { type: 'completed' }
    } catch (error) {
      if (timedOut) throw new ProviderRequestError('请求超时，请检查网络、Base URL 或稍后重试。', 'timeout')
      if (signal.aborted || error instanceof ProviderRequestError) throw error
      throw new ProviderRequestError(`Streaming Response 中断：${error instanceof Error ? error.message : '网络异常'}`, 'stream')
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
    }
  }
}

export class OpenAIProvider extends ChatCompletionsProvider {
  readonly id = 'openai' as const
}

export class DeepSeekProvider extends ChatCompletionsProvider {
  readonly id = 'deepseek' as const
}

export function createModelProvider(provider: ModelProviderId): ModelProvider {
  return provider === 'openai' ? new OpenAIProvider() : new DeepSeekProvider()
}
