export type RuntimeExecutionMode = 'analysis-conversation' | 'agent' | 'delta-fast-path' | 'artifact-generation'
export type LlmMode = 'LLM_NORMALIZE' | 'LLM_REASON' | 'LLM_REVIEW'
export type BudgetContextLevel = 'L0' | 'L1' | 'L2'

export interface LlmPolicy {
  maxCalls: number
  maxInputTokens: number
  maxOutputTokens: number
  contextLevel: BudgetContextLevel
}

export const LLM_POLICIES = {
  SCRIPT: { maxCalls: 0, maxInputTokens: 0, maxOutputTokens: 0, contextLevel: 'L0' },
  LLM_NORMALIZE: { maxCalls: 1, maxInputTokens: 6_000, maxOutputTokens: 400, contextLevel: 'L0' },
  LLM_REASON: { maxCalls: 3, maxInputTokens: 16_000, maxOutputTokens: 1_200, contextLevel: 'L1' },
  LLM_REVIEW: { maxCalls: 4, maxInputTokens: 24_000, maxOutputTokens: 1_800, contextLevel: 'L2' },
  LLM_STAGE_GENERATE: { maxCalls: 4, maxInputTokens: 24_000, maxOutputTokens: 1_800, contextLevel: 'L2' },
  LLM_COMPLEX_DECIDE: { maxCalls: 4, maxInputTokens: 16_000, maxOutputTokens: 1_200, contextLevel: 'L1' }
} as const satisfies Record<string, LlmPolicy>

export type RuntimeAction =
  | 'CREATE_REQUIREMENT' | 'OPEN_REQUIREMENT' | 'RENAME_REQUIREMENT' | 'DELETE_REQUIREMENT'
  | 'INIT_WORKSPACE' | 'RESTORE_WORKSPACE' | 'INIT_LIFECYCLE' | 'SWITCH_STAGE'
  | 'READ_SLOT' | 'WRITE_EXPLICIT_SLOT' | 'UPDATE_EXPLICIT_SLOT'
  | 'CALCULATE_COMPLETENESS' | 'CLOSE_RESOLVED_ISSUES' | 'MARK_DIRTY' | 'MARK_AFFECTED'
  | 'GENERATE_WORKING_STATE' | 'READ_FILE' | 'WRITE_FILE' | 'UPDATE_STATE'
  | 'RENDER_INITIAL_UI' | 'SHOW_STATIC_GUIDANCE' | 'CONFIRM_ARTIFACT' | 'REJECT_ARTIFACT'
  | 'UNDERSTAND_AMBIGUOUS_INPUT' | 'ANALYZE_REQUIREMENT' | 'ASSESS_REQUIREMENT_CHANGE'
  | 'GENERATE_STAGE_ARTIFACT' | 'REVIEW_REQUIREMENT'
  | 'TEST_MODEL_CONNECTION'

export const NO_LLM_ACTIONS = new Set<RuntimeAction>([
  'CREATE_REQUIREMENT', 'OPEN_REQUIREMENT', 'RENAME_REQUIREMENT', 'DELETE_REQUIREMENT',
  'INIT_WORKSPACE', 'RESTORE_WORKSPACE', 'INIT_LIFECYCLE', 'SWITCH_STAGE',
  'READ_SLOT', 'WRITE_EXPLICIT_SLOT', 'UPDATE_EXPLICIT_SLOT', 'CALCULATE_COMPLETENESS',
  'CLOSE_RESOLVED_ISSUES', 'MARK_DIRTY', 'MARK_AFFECTED', 'GENERATE_WORKING_STATE',
  'READ_FILE', 'WRITE_FILE', 'UPDATE_STATE', 'RENDER_INITIAL_UI', 'SHOW_STATIC_GUIDANCE',
  'CONFIRM_ARTIFACT', 'REJECT_ARTIFACT'
])

export interface LlmGateContext {
  action: RuntimeAction
  caller: string
  task: string
  stage?: string | null
  slot?: string | null
  contextSources?: string[]
}

export interface LlmGateDecision {
  allow: boolean
  reason: string
  mode?: LlmMode
  caller: string
  action: RuntimeAction
  stage: string | null
  slot: string | null
  maxCalls: number
  maxInputTokens: number
  maxOutputTokens: number
  contextLevel: BudgetContextLevel
  contextSources: string[]
}

export function shouldUseLLM(context: LlmGateContext): LlmGateDecision {
  const base = {
    caller: context.caller, action: context.action, stage: context.stage ?? null, slot: context.slot ?? null,
    contextSources: [...(context.contextSources ?? [])]
  }
  if (NO_LLM_ACTIONS.has(context.action)) {
    return { ...base, allow: false, reason: `${context.action} 是确定性动作，必须由 Script / Runtime 执行。`, ...LLM_POLICIES.SCRIPT }
  }
  if (context.action === 'UNDERSTAND_AMBIGUOUS_INPUT') {
    return { ...base, allow: true, reason: '输入无法通过确定性规则可靠识别，需要一次语义理解。', mode: 'LLM_NORMALIZE', ...LLM_POLICIES.LLM_NORMALIZE }
  }
  if (context.action === 'TEST_MODEL_CONNECTION') {
    return { ...base, allow: true, reason: '用户显式测试模型连接，需要一次最小 Provider 请求。', mode: 'LLM_NORMALIZE', ...LLM_POLICIES.LLM_NORMALIZE }
  }
  if (context.action === 'ANALYZE_REQUIREMENT') {
    return { ...base, allow: true, reason: '用户正在补充或请求需求分析，需要语义推理并返回结构化增量。', mode: 'LLM_REASON', ...LLM_POLICIES.LLM_REASON }
  }
  if (context.action === 'REVIEW_REQUIREMENT') {
    return { ...base, allow: true, reason: '用户明确请求复杂内容评审，需要语义判断。', mode: 'LLM_REVIEW', ...LLM_POLICIES.LLM_REVIEW }
  }
  if (context.action === 'GENERATE_STAGE_ARTIFACT') {
    return { ...base, allow: true, reason: '用户明确请求阶段方案生成；顺序读取、校验与结构化提交需要受控多步调用。', mode: 'LLM_REASON', ...LLM_POLICIES.LLM_STAGE_GENERATE }
  }
  return { ...base, allow: true, reason: '变更影响无法仅靠确定性依赖规则可靠判断。', mode: 'LLM_REASON', ...LLM_POLICIES.LLM_COMPLEX_DECIDE }
}

export interface RuntimeExecutionPlan {
  mode: RuntimeExecutionMode
  maxSteps: number
  maxModelCalls: number
  allowedTools: string[]
  terminalTool: string | null
  modelPurpose: 'semantic' | 'execution'
}

export interface DeterministicScriptSpec { name: string; label: string; deterministic: true; modelAllowed: false }
const analysisTools = new Set(['artifact_find', 'artifact_read', 'analysis_turn_submit'])

export const deterministicScriptRegistry = {
  analysis_state_merge: { name: 'analysis_state_merge', label: '合并 Analysis State Patch', deterministic: true, modelAllowed: false },
  mainline_schema_update: { name: 'mainline_schema_update', label: '更新 Dynamic Mainline Schema', deterministic: true, modelAllowed: false },
  mainline_delta_merge: { name: 'mainline_delta_merge', label: '合并 Mainline Delta', deterministic: true, modelAllowed: false },
  analysis_working_update: { name: 'analysis_working_update', label: '更新并清理 Analysis Working Context', deterministic: true, modelAllowed: false },
  question_resolver: { name: 'question_resolver', label: '关闭已回答的待确认问题', deterministic: true, modelAllowed: false },
  question_gate: { name: 'question_gate', label: '过滤、延后并分级候选问题', deterministic: true, modelAllowed: false },
  analysis_conflict_detector: { name: 'analysis_conflict_detector', label: '检测结构化需求冲突', deterministic: true, modelAllowed: false },
  analysis_readiness_calculator: { name: 'analysis_readiness_calculator', label: '计算需求分析完整度', deterministic: true, modelAllowed: false },
  analysis_projection_builder: { name: 'analysis_projection_builder', label: '生成 Mainline Projection', deterministic: true, modelAllowed: false },
  conversation_window_builder: { name: 'conversation_window_builder', label: '截取最近必要对话', deterministic: true, modelAllowed: false },
  schema_validator: { name: 'schema_validator', label: '校验结构化输入', deterministic: true, modelAllowed: false },
  id_generator: { name: 'id_generator', label: '生成稳定业务 ID', deterministic: true, modelAllowed: false },
  lifecycle_stage_state_sync: { name: 'lifecycle_stage_state_sync', label: '同步当前生命周期 Stage State', deterministic: true, modelAllowed: false },
  lifecycle_stage_readiness: { name: 'lifecycle_stage_readiness', label: '计算当前阶段 Readiness', deterministic: true, modelAllowed: false },
  lifecycle_stage_projection: { name: 'lifecycle_stage_projection', label: '生成 Stage Working Projection', deterministic: true, modelAllowed: false },
  lifecycle_downstream_stale: { name: 'lifecycle_downstream_stale', label: '标记受影响下游阶段为 stale', deterministic: true, modelAllowed: false }
} as const satisfies Record<string, DeterministicScriptSpec>

export type DeterministicScriptName = keyof typeof deterministicScriptRegistry
export function deterministicScript(name: DeterministicScriptName): DeterministicScriptSpec { return deterministicScriptRegistry[name] }

export function runtimeExecutionPlan(skill: string | null, requestedTools: string[], gate: LlmGateDecision): RuntimeExecutionPlan {
  if (!gate.allow || gate.maxCalls < 1) throw new Error(`LLM Gate 拒绝执行：${gate.reason}`)
  if (skill === 'requirement-analysis') {
    const scoped = requestedTools.filter((tool) => analysisTools.has(tool))
    if (!scoped.includes('analysis_turn_submit')) scoped.push('analysis_turn_submit')
    return { mode: 'analysis-conversation', maxSteps: 3, maxModelCalls: gate.maxCalls, allowedTools: scoped, terminalTool: 'analysis_turn_submit', modelPurpose: 'semantic' }
  }
  if (skill === 'requirement-change') {
    return { mode: 'delta-fast-path', maxSteps: 6, maxModelCalls: gate.maxCalls, allowedTools: [...requestedTools], terminalTool: null, modelPurpose: 'execution' }
  }
  return { mode: 'agent', maxSteps: 10, maxModelCalls: gate.maxCalls, allowedTools: [...requestedTools], terminalTool: null, modelPurpose: 'execution' }
}
