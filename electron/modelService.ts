import type { ConnectionTestResult, ModelConfigDraft } from '../src/model'
import { createModelProvider, ProviderRequestError } from './modelProvider'
import { PersistenceService } from './persistenceService'
import { shouldUseLLM } from './runtime/executionPolicy'

function readableError(error: unknown): string {
  if (error instanceof ProviderRequestError) return error.message
  if (error instanceof Error && error.name === 'AbortError') return '请求已取消。'
  return error instanceof Error ? error.message : '模型调用失败，请稍后重试。'
}

export class ModelService {
  constructor(private readonly persistence: PersistenceService) {}

  async testConnection(draft: ModelConfigDraft): Promise<ConnectionTestResult> {
    try {
      const gate = shouldUseLLM({ action: 'TEST_MODEL_CONNECTION', caller: 'ModelService.testConnection', task: '测试模型连接' })
      if (!gate.allow || gate.maxCalls !== 1) throw new Error(`LLM Gate 拒绝连接测试：${gate.reason}`)
      const config = this.persistence.resolveModelConfig(draft)
      await createModelProvider(config.provider).testConnection(config, gate.maxOutputTokens)
      return { success: true, message: `连接成功：${config.provider === 'openai' ? 'OpenAI' : 'DeepSeek'} / ${config.model}` }
    } catch (error) {
      return { success: false, message: `连接失败：${readableError(error)}` }
    }
  }

}
