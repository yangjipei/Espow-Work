import type { RuntimeControlEvent } from '../../src/model'
import type { LifecycleStageId } from '../../src/lifecycleStageState'
import { parseDeterministicQuery, type DeterministicQuery } from './deterministicMessageRouter'
import { parseExplicitSlotUpdate, type ExplicitSlotUpdate } from './explicitSlotRouter'

export type TurnIntent =
  | 'ASK_QUESTION'
  | 'REQUEST_CONCLUSION'
  | 'PROVIDE_INFORMATION'
  | 'MODIFY_REQUIREMENT'
  | 'ANSWER_CLARIFICATION'
  | 'CONFIRM_STAGE'
  | 'REJECT_STAGE'
  | 'CONTINUE_STAGE'
  | 'REQUEST_ARTIFACT'
  | 'GENERAL_DISCUSSION'
  | 'UNKNOWN'

export interface RecognizedIntent {
  intent: TurnIntent
  target: string | null
  targetStage: LifecycleStageId | null
  pendingQuestionId: string | null
  confidence: number
  needsReasoning: boolean
  source: 'FAST_PATH' | 'UI_EVENT' | 'LLM'
}

export type TurnRoute =
  | { path: 'script'; intent: 'explicit-slot-update'; reason: string; update: ExplicitSlotUpdate }
  | { path: 'script'; intent: 'requirement-query'; reason: string; query: DeterministicQuery }
  | { path: 'script'; intent: 'runtime-control'; reason: string; recognized: RecognizedIntent }
  | { path: 'recognition'; intent: 'UNKNOWN'; reason: string }
  | { path: 'agent'; intent: 'UNKNOWN'; reason: string }

const controlCommands = new Map<string, TurnIntent>([
  ['继续', 'CONTINUE_STAGE'],
  ['下一步', 'CONTINUE_STAGE'],
  ['确认', 'CONFIRM_STAGE'],
  ['同意', 'CONFIRM_STAGE'],
  ['取消', 'REJECT_STAGE'],
  ['拒绝', 'REJECT_STAGE']
])

const stageControlCommands: Partial<Record<LifecycleStageId, Record<string, TurnIntent>>> = {
  'requirement-analysis': { 确认分析: 'CONFIRM_STAGE', 分析确认: 'CONFIRM_STAGE', 取消分析: 'REJECT_STAGE' },
  'business-flow': { 确认流程: 'CONFIRM_STAGE', 流程确认: 'CONFIRM_STAGE', 取消流程: 'REJECT_STAGE', 拒绝流程: 'REJECT_STAGE' },
  'solution-design': { 确认方案: 'CONFIRM_STAGE', 方案确认: 'CONFIRM_STAGE', 取消方案: 'REJECT_STAGE', 拒绝方案: 'REJECT_STAGE' },
  'interaction-design': { 确认交互: 'CONFIRM_STAGE', 交互确认: 'CONFIRM_STAGE', 取消交互: 'REJECT_STAGE', 拒绝交互: 'REJECT_STAGE' },
  prototype: { 确认原型: 'CONFIRM_STAGE', 原型确认: 'CONFIRM_STAGE', '这个版本 ok': 'CONFIRM_STAGE', 定稿: 'CONFIRM_STAGE', 取消原型: 'REJECT_STAGE', 拒绝原型: 'REJECT_STAGE' },
  'product-spec': { '确认prd': 'CONFIRM_STAGE', 'prd确认': 'CONFIRM_STAGE', 确认产品规格: 'CONFIRM_STAGE', 定稿: 'CONFIRM_STAGE', 取消产品规格: 'REJECT_STAGE' },
  'requirement-review': { 确认评审: 'CONFIRM_STAGE', 评审确认: 'CONFIRM_STAGE', 取消评审: 'REJECT_STAGE', 拒绝评审: 'REJECT_STAGE' }
}

function normalizedControlCommand(task: string): string {
  return task.trim().replace(/[。！!\s]+$/g, '')
}

export function recognizeControlCommand(task: string, currentStage: LifecycleStageId | null): RecognizedIntent | null {
  const command = normalizedControlCommand(task)
  const intent = controlCommands.get(command) ?? (currentStage ? stageControlCommands[currentStage]?.[command.toLowerCase()] : undefined)
  if (!intent || !currentStage) return null
  return {
    intent, target: null, targetStage: currentStage, pendingQuestionId: null,
    confidence: 1, needsReasoning: false, source: 'FAST_PATH'
  }
}


function looksLikeAmbiguousControl(task: string): boolean {
  const command = normalizedControlCommand(task)
  if (!command || command.length > 10) return false
  return /(确认|同意|拒绝|取消|继续|下一步|可以了|没问题|就这样|定稿|通过)/i.test(command)
}

export function intentFromControlEvent(event: RuntimeControlEvent): RecognizedIntent {
  return {
    intent: event.type, target: null, targetStage: event.stageId, pendingQuestionId: null,
    confidence: 1, needsReasoning: false, source: 'UI_EVENT'
  }
}

export function routeTurn(task: string, currentStage: LifecycleStageId | null = null, event?: RuntimeControlEvent): TurnRoute {
  if (event) return { path: 'script', intent: 'runtime-control', reason: '结构化 UI Event 直接进入 Runtime Router。', recognized: intentFromControlEvent(event) }
  const update = parseExplicitSlotUpdate(task)
  if (update) return { path: 'script', intent: 'explicit-slot-update', reason: update.reason, update }
  const query = parseDeterministicQuery(task)
  if (query) return { path: 'script', intent: 'requirement-query', reason: query === 'conclusion' ? '当前结论可从 Mainline、Readiness 与 Blocking Issues 确定性回答。' : '当前问题可从 Requirement Snapshot 确定性回答。', query }
  const control = recognizeControlCommand(task, currentStage)
  if (control) return { path: 'script', intent: 'runtime-control', reason: '短、独立且无歧义的 Runtime Control Command。', recognized: control }
  if (looksLikeAmbiguousControl(task)) {
    return { path: 'recognition', intent: 'UNKNOWN', reason: '短控制语义存在歧义，仅此类输入进入 Intent Recognition。' }
  }
  return { path: 'agent', intent: 'UNKNOWN', reason: '普通自由文本直接进入当前 Stage / Skill，由主 Agent 完成一次语义理解。' }
}
