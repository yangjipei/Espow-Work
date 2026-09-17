import type { LifecycleStageId } from '../../src/lifecycleStageState'
import { createModelProvider, type StoredModelConfig } from '../modelProvider'
import type { RecognizedIntent, TurnIntent } from './turnRouter'

const intents = new Set<TurnIntent>([
  'ASK_QUESTION', 'REQUEST_CONCLUSION', 'PROVIDE_INFORMATION', 'MODIFY_REQUIREMENT',
  'ANSWER_CLARIFICATION', 'CONFIRM_STAGE', 'REJECT_STAGE', 'CONTINUE_STAGE',
  'REQUEST_ARTIFACT', 'GENERAL_DISCUSSION', 'UNKNOWN'
])

const stages = new Set<LifecycleStageId>([
  'requirement-analysis', 'business-flow', 'solution-design', 'interaction-design',
  'prototype', 'product-spec', 'requirement-review'
])

export interface IntentRecognitionContext {
  message: string
  currentStage: LifecycleStageId | null
  pendingQuestion: { id: string; question: string } | null
}

export interface IntentRecognitionResult {
  recognized: RecognizedIntent
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null
  durationMs: number
}

function jsonObject(content: string): Record<string, unknown> {
  const normalized = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const parsed = JSON.parse(normalized) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Intent Recognition 输出不是 JSON Object。')
  return parsed as Record<string, unknown>
}

export function validateRecognizedIntent(value: Record<string, unknown>): RecognizedIntent {
  const intent = typeof value.intent === 'string' && intents.has(value.intent as TurnIntent) ? value.intent as TurnIntent : 'UNKNOWN'
  const confidence = typeof value.confidence === 'number' && Number.isFinite(value.confidence)
    ? Math.min(1, Math.max(0, value.confidence)) : 0
  const targetStage = typeof value.targetStage === 'string' && stages.has(value.targetStage as LifecycleStageId)
    ? value.targetStage as LifecycleStageId : null
  const safeIntent = confidence >= 0.7 ? intent : 'UNKNOWN'
  return {
    intent: safeIntent,
    target: typeof value.target === 'string' && value.target.trim() ? value.target.trim() : null,
    targetStage,
    pendingQuestionId: typeof value.pendingQuestionId === 'string' && value.pendingQuestionId.trim() ? value.pendingQuestionId.trim() : null,
    confidence,
    needsReasoning: value.needsReasoning === true,
    source: 'LLM'
  }
}

export class IntentRecognitionService {
  async recognize(context: IntentRecognitionContext, config: StoredModelConfig): Promise<IntentRecognitionResult> {
    const provider = createModelProvider(config.provider)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    const startedAt = Date.now()
    const controlContext = JSON.stringify({
      currentStage: context.currentStage,
      pendingQuestion: context.pendingQuestion
    })
    try {
      const completion = await provider.completeChat({
        maxOutputTokens: 240,
        messages: [
          {
            role: 'system',
            content: `你是 ESPow 的 Intent Recognition 模块，只理解用户本轮意图，不执行任务。\n可选 intent：ASK_QUESTION、REQUEST_CONCLUSION、PROVIDE_INFORMATION、MODIFY_REQUIREMENT、ANSWER_CLARIFICATION、CONFIRM_STAGE、REJECT_STAGE、CONTINUE_STAGE、REQUEST_ARTIFACT、GENERAL_DISCUSSION、UNKNOWN。\n只输出单个 JSON Object，字段为 intent、target、targetStage、pendingQuestionId、confidence、needsReasoning。targetStage 仅允许 requirement-analysis、business-flow、solution-design、interaction-design、prototype、product-spec、requirement-review 或 null。\n不要因出现 PRD、原型、按钮等词就按关键词分类；必须理解否定、转折和复合表达。复合表达中需求修改或澄清回答优先于阶段确认。无法可靠判断时输出 UNKNOWN，禁止猜测确认、拒绝或推进。`
          },
          { role: 'user', content: `Control Context: ${controlContext}\nLatest User Message: ${context.message}` }
        ]
      }, config, controller.signal)
      return { recognized: validateRecognizedIntent(jsonObject(completion.content)), usage: completion.usage, durationMs: Date.now() - startedAt }
    } catch {
      return {
        recognized: { intent: 'UNKNOWN', target: null, targetStage: context.currentStage, pendingQuestionId: null, confidence: 0, needsReasoning: false, source: 'LLM' },
        usage: null,
        durationMs: Date.now() - startedAt
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}
