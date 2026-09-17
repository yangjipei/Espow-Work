import type {
  AnalysisDecisionState,
  AnalysisHistoricalRequirement,
  AnalysisPatchOperation,
  AnalysisQuestionDraft,
  AnalysisQuestionState,
  AnalysisReadinessState,
  AnalysisScenarioState,
  AnalysisSlot,
  AnalysisSlotStatus,
  AnalysisState,
  AnalysisTurnSubmission
} from '../../src/analysisState'
import type { AnalysisStatement, RequirementAnalysisResult } from '../../src/skills'

function now(): string { return new Date().toISOString() }

function slot(value = '', status: AnalysisSlotStatus = 'unknown', source: AnalysisSlot<string>['source'] = 'runtime'): AnalysisSlot<string> {
  return { value, status, source, updatedAt: now(), openIssueId: null }
}

export const analysisCoreModules = [
  'requirement_summary', 'current_state', 'problem', 'goal', 'actors', 'scope', 'out_of_scope',
  'core_scenarios', 'main_flow', 'key_rules', 'exceptions', 'decisions', 'open_issues'
] as const

export const analysisRequirementModules = {
  workflow: ['workflow', 'rounds', 'scheduling', 'trigger_conditions', 'exit_conditions', 'state_machine', 'parallelism', 'manual_automation_boundary'],
  integration: ['integration', 'request', 'response', 'identifier', 'callback', 'status_mapping', 'compensation', 'idempotency', 'data_persistence', 'error_handling'],
  page_interaction: ['page', 'interaction', 'display_rules', 'configuration', 'data_mapping', 'validation', 'permission', 'empty_state', 'error_state'],
  decision_rule: ['decision_input', 'decision_output', 'rule_conditions', 'rule_priority', 'strategy', 'fallback', 'feature_dependency', 'execution_timing'],
  data_mapping: ['data_source', 'field_mapping', 'data_type', 'format', 'separator', 'transformation', 'sync_direction', 'conflict_rule'],
  account_permission: ['account_lifecycle', 'role', 'permission', 'organization', 'binding', 'sync', 'disable_rule', 'audit']
} as const

export function createEmptyAnalysisState(workspaceId: string, requirementId: string, threadId: string): AnalysisState {
  return {
    schemaVersion: 2,
    workspaceId,
    requirementId,
    threadId,
    version: 1,
    source: 'new',
    mainlineSchema: { version: 1, status: 'missing', requirementTypes: [], modules: [...analysisCoreModules] },
    working: { currentTopic: null, currentQuestion: null },
    moduleData: {},
    problem: {
      trigger: slot(), currentProblem: slot(), rootCause: slot(), businessImpact: slot(), currentWorkaround: slot()
    },
    scenarios: [],
    goals: { businessGoals: [], userGoals: [], systemGoals: [], successCriteria: [] },
    flow: { entry: slot(), mainFlow: [], branches: [], exitConditions: [], failureFlows: [] },
    rules: [],
    scope: { inScope: [], outOfScope: [], future: [], constraints: [] },
    impact: { systems: [], upstream: [], downstream: [], data: [], externalServices: [], historicalRequirements: [] },
    decisions: [],
    openQuestions: [],
    collectionMeta: {},
    readiness: {
      status: 'NOT_READY', problemClear: false, goalClear: false, scenarioClear: false, mainFlowClear: false, rulesClear: false, scopeClear: false,
      exceptionsClear: false, dependenciesClear: false, blockingQuestions: 0, readyForConfirmation: false
    },
    changedPaths: [],
    updatedAt: now()
  }
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const normalized = values.filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim()).filter(Boolean)
  return [...new Set(normalized)]
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function collectionStatus(state: AnalysisState, path: string): AnalysisSlotStatus {
  return state.collectionMeta?.[path]?.status ?? 'unknown'
}

function setCollectionMeta(state: AnalysisState, path: string, operation: AnalysisPatchOperation): void {
  state.collectionMeta ??= {}
  state.collectionMeta[path] = {
    status: operation.op === 'remove' ? 'unknown' : (operation.status ?? (operation.source === 'user' || operation.source === 'source' ? 'confirmed' : 'inferred')),
    source: operation.source ?? 'agent',
    updatedAt: now()
  }
}

function isConfirmedCollection(state: AnalysisState, path: string): boolean {
  return ['confirmed', 'not_applicable'].includes(collectionStatus(state, path))
}

function cloneState(state: AnalysisState): AnalysisState {
  return JSON.parse(JSON.stringify(state)) as AnalysisState
}

export function normalizeAnalysisState(state: AnalysisState): AnalysisState {
  const normalized = cloneState(state)
  const compatible = normalized as AnalysisState & {
    schemaVersion?: number
    mainlineSchema?: AnalysisState['mainlineSchema']
    working?: AnalysisState['working']
    moduleData?: AnalysisState['moduleData']
  }
  compatible.schemaVersion = 2
  compatible.mainlineSchema ??= { version: 1, status: 'proposed', requirementTypes: [], modules: [...analysisCoreModules] }
  compatible.mainlineSchema.modules = [...new Set([...analysisCoreModules, ...compatible.mainlineSchema.modules])]
  compatible.working ??= { currentTopic: null, currentQuestion: null }
  compatible.moduleData ??= {}
  normalized.openQuestions = normalized.openQuestions.map((question) => ({
    ...question,
    type: question.type ?? (question.status === 'open'
      ? (question.priority === 'blocking' ? 'BLOCKING' : 'NON_BLOCKING')
      : question.status === 'deferred' ? 'DEFERRED' : 'CLOSED'),
    targetStage: question.targetStage ?? 'requirement-analysis'
  }))
  normalized.readiness = calculateAnalysisReadinessValue(normalized)
  return normalized
}

export function applyAnalysisSchemaDelta(state: AnalysisState, submission: AnalysisTurnSubmission): AnalysisState {
  const next = normalizeAnalysisState(state)
  const delta = submission.schemaDelta
  if (delta) {
    const wasConfirmed = next.mainlineSchema.status === 'confirmed'
    if (delta.requirementTypes) next.mainlineSchema.requirementTypes = [...new Set(delta.requirementTypes)]
    if (delta.modules) next.mainlineSchema.modules = [...new Set([...analysisCoreModules, ...delta.modules])]
    if (delta.addModules?.length) {
      const before = next.mainlineSchema.modules.length
      next.mainlineSchema.modules = [...new Set([...next.mainlineSchema.modules, ...delta.addModules])]
      if (wasConfirmed && next.mainlineSchema.modules.length > before) next.mainlineSchema.version += 1
    }
    if (delta.status) next.mainlineSchema.status = delta.status
    next.changedPaths = [...new Set([...next.changedPaths, '/mainlineSchema'])]
  }
  next.updatedAt = now()
  return next
}

export function applyAnalysisWorkingDelta(state: AnalysisState, submission: AnalysisTurnSubmission): AnalysisState {
  const next = normalizeAnalysisState(state)
  const working = submission.workingDelta
  if (working) {
    if (working.clearCurrentQuestion) next.working.currentQuestion = null
    if ('currentTopic' in working) next.working.currentTopic = working.currentTopic ?? null
    if ('currentQuestion' in working) next.working.currentQuestion = working.currentQuestion ?? null
  }
  if (next.working.currentQuestion && submission.resolvedQuestionIds.includes(next.working.currentQuestion.id)) {
    next.working.currentQuestion = null
    next.working.currentTopic = null
  }
  next.updatedAt = now()
  return next
}

export function applyAnalysisSchemaAndWorking(state: AnalysisState, submission: AnalysisTurnSubmission): AnalysisState {
  return applyAnalysisWorkingDelta(applyAnalysisSchemaDelta(state, submission), submission)
}

export function deriveAnalysisStateForThread(state: AnalysisState, workspaceId: string, requirementId: string, threadId: string): AnalysisState {
  const derived = cloneState(state)
  derived.workspaceId = workspaceId
  derived.requirementId = requirementId
  derived.threadId = threadId
  derived.source = 'derived'
  derived.changedPaths = []
  derived.updatedAt = now()
  return derived
}

function questionMatchesTopic(question: AnalysisQuestionState, pattern: RegExp): boolean {
  return question.status === 'open' && pattern.test(`${question.topic} ${question.question}`)
}

function hasConflict(state: AnalysisState): boolean {
  const problemSlots = Object.values(state.problem)
  return problemSlots.some((item) => item.status === 'conflicted')
    || state.scenarios.some((item) => item.status === 'conflicted')
    || state.rules.some((item) => item.status === 'conflicted')
    || state.decisions.some((item) => item.status === 'conflicted')
    || state.scope.inScope.some((value) => state.scope.outOfScope.includes(value))
}

function calculateAnalysisReadinessValue(state: AnalysisState): AnalysisReadinessState {
  const currentProblem = state.problem.currentProblem
  const problemClear = Boolean(currentProblem.value.trim()) && ['confirmed', 'not_applicable'].includes(currentProblem.status)
  const goalPaths = ['/goals/businessGoals', '/goals/userGoals', '/goals/systemGoals', '/goals/successCriteria']
  const goalClear = goalPaths.some((path) => isConfirmedCollection(state, path))
    && [...state.goals.businessGoals, ...state.goals.userGoals, ...state.goals.systemGoals, ...state.goals.successCriteria].some(Boolean)
  const scenarioClear = state.scenarios.some((item) => item.status === 'confirmed'
    && Boolean(item.actor.trim()) && Boolean(item.trigger.trim()) && Boolean(item.painPoint.trim()) && Boolean(item.expectedOutcome.trim()))
  const mainFlowClear = state.flow.mainFlow.filter(Boolean).length >= 2 && isConfirmedCollection(state, '/flow/mainFlow')
  const openBlocking = state.openQuestions.filter((item) => item.status === 'open' && item.priority === 'blocking')
  const openModuleFields = Object.values(state.moduleData).filter((item) => item.status === 'open').length
  const rulesClear = state.rules.some((item) => item.status === 'confirmed')
    || !openBlocking.some((item) => /规则|rule|条件|优先级|判断/i.test(`${item.topic} ${item.question}`))
  const scopePaths = ['/scope/inScope', '/scope/outOfScope', '/scope/constraints']
  const scopeClear = scopePaths.some((path) => isConfirmedCollection(state, path))
    && state.scope.inScope.length + state.scope.outOfScope.length + state.scope.constraints.length > 0
  const exceptionPaths = ['/flow/branches', '/flow/exitConditions', '/flow/failureFlows']
  const exceptionsClear = exceptionPaths.some((path) => isConfirmedCollection(state, path))
    || !openBlocking.some((item) => /异常|退出|失败|恢复|补偿|exception|exit|failure|recovery/i.test(`${item.topic} ${item.question}`))
  const dependencyPaths = ['/impact/systems', '/impact/upstream', '/impact/downstream', '/impact/externalServices', '/impact/historicalRequirements']
  const dependenciesClear = dependencyPaths.some((path) => isConfirmedCollection(state, path))
    || !openBlocking.some((item) => /上下游|依赖|历史|系统|服务商|dependency|upstream|downstream/i.test(`${item.topic} ${item.question}`))
  const blockingQuestions = openBlocking.length + openModuleFields
  const readyForConfirmation = state.mainlineSchema.status === 'confirmed' && problemClear && goalClear && scenarioClear && mainFlowClear && rulesClear && scopeClear
    && blockingQuestions === 0 && !hasConflict(state)
  const status = readyForConfirmation
    ? state.readiness?.status === 'COMPLETED' && state.changedPaths.length === 0 ? 'COMPLETED' : 'READY_TO_CONFIRM'
    : 'NOT_READY'
  return {
    status,
    problemClear, goalClear, scenarioClear, mainFlowClear, rulesClear, scopeClear, exceptionsClear, dependenciesClear,
    blockingQuestions,
    readyForConfirmation
  }
}

export function calculateAnalysisReadiness(state: AnalysisState): AnalysisReadinessState {
  return calculateAnalysisReadinessValue(normalizeAnalysisStateWithoutReadiness(state))
}

function normalizeAnalysisStateWithoutReadiness(state: AnalysisState): AnalysisState {
  const normalized = cloneState(state)
  const compatible = normalized as AnalysisState & {
    schemaVersion?: number
    mainlineSchema?: AnalysisState['mainlineSchema']
    working?: AnalysisState['working']
    moduleData?: AnalysisState['moduleData']
  }
  compatible.schemaVersion = 2
  compatible.mainlineSchema ??= { version: 1, status: 'proposed', requirementTypes: [], modules: [...analysisCoreModules] }
  compatible.mainlineSchema.modules = [...new Set([...analysisCoreModules, ...compatible.mainlineSchema.modules])]
  compatible.working ??= { currentTopic: null, currentQuestion: null }
  compatible.moduleData ??= {}
  return normalized
}

function normalizeScenario(value: unknown, fallbackId: string): AnalysisScenarioState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const actor = cleanText(row.actor)
  const trigger = cleanText(row.trigger)
  const painPoint = cleanText(row.painPoint ?? row.blocker)
  const expectedOutcome = cleanText(row.expectedOutcome)
  if (!actor && !trigger && !painPoint && !expectedOutcome) return null
  const status = cleanText(row.status) as AnalysisSlotStatus
  return {
    scenarioId: cleanText(row.scenarioId ?? row.id) || fallbackId,
    actor,
    trigger,
    preconditions: uniqueStrings(row.preconditions),
    intent: cleanText(row.intent),
    currentActions: uniqueStrings(row.currentActions ?? row.currentFlow),
    painPoint,
    expectedOutcome,
    status: ['unknown', 'inferred', 'open', 'discussing', 'confirmed', 'conflicted', 'not_applicable'].includes(status) ? status : 'inferred'
  }
}

function normalizeDecision(value: unknown, fallbackId: string): AnalysisDecisionState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const decision = cleanText(row.decision)
  if (!decision) return null
  const status = cleanText(row.status) as AnalysisSlotStatus
  return {
    id: cleanText(row.id) || fallbackId,
    topic: cleanText(row.topic),
    decision,
    reason: cleanText(row.reason),
    status: ['unknown', 'inferred', 'open', 'discussing', 'confirmed', 'conflicted', 'not_applicable'].includes(status) ? status : 'inferred'
  }
}

function setStringSlot(target: AnalysisSlot<string>, operation: AnalysisPatchOperation): void {
  if (operation.op === 'remove') {
    target.value = ''
    target.status = 'unknown'
    target.source = 'runtime'
    target.updatedAt = now()
    return
  }
  const value = cleanText(operation.value)
  const status = operation.status ?? (operation.source === 'user' ? 'confirmed' : 'inferred')
  target.value = value
  target.status = status
  target.source = operation.source ?? 'agent'
  target.updatedAt = now()
}

function nextQuestionId(state: AnalysisState): string {
  const max = state.openQuestions.reduce((value, item) => Math.max(value, Number(item.id.match(/^Q(\d+)$/i)?.[1] ?? 0)), 0)
  return `Q${max + 1}`
}

function nextScenarioId(state: AnalysisState): string {
  const max = state.scenarios.reduce((value, item) => Math.max(value, Number(item.scenarioId.match(/^S(\d+)$/i)?.[1] ?? 0)), 0)
  return `S${max + 1}`
}

function nextRuleId(state: AnalysisState): string {
  const max = state.rules.reduce((value, item) => Math.max(value, Number(item.ruleId.match(/^R(\d+)$/i)?.[1] ?? 0)), 0)
  return `R${max + 1}`
}

function nextDecisionId(state: AnalysisState): string {
  const max = state.decisions.reduce((value, item) => Math.max(value, Number(item.id.match(/^D(\d+)$/i)?.[1] ?? 0)), 0)
  return `D${max + 1}`
}

function replaceOrAppendById<T>(values: T[], idOf: (value: T) => string, id: string, value: T): void {
  const index = values.findIndex((item) => idOf(item) === id)
  if (index >= 0) values[index] = value
  else values.push(value)
}

function applyOperation(state: AnalysisState, operation: AnalysisPatchOperation): void {
  const originalPath = operation.path.trim()
  const path = originalPath.endsWith('/-') ? originalPath.slice(0, -2) : originalPath
  const moduleMatch = path.match(/^\/modules\/([a-z0-9_-]+)$/i)
  if (moduleMatch) {
    const field = moduleMatch[1]
    if (!state.mainlineSchema.modules.includes(field)) return
    if (operation.op === 'remove') delete state.moduleData[field]
    else state.moduleData[field] = {
      value: operation.value ?? null,
      status: operation.status === 'confirmed' ? 'confirmed' : operation.status === 'open' || operation.status === 'unknown' || operation.status === 'discussing' ? 'open' : 'inferred',
      source: operation.source ?? 'agent', updatedAt: now()
    }
    return
  }
  const problemMatch = path.match(/^\/problem\/(trigger|currentProblem|rootCause|businessImpact|currentWorkaround)$/)
  if (problemMatch) {
    setStringSlot(state.problem[problemMatch[1] as keyof AnalysisState['problem']], operation)
    return
  }
  if (path === '/flow/entry') {
    setStringSlot(state.flow.entry, operation)
    return
  }

  const arrayTargets: Record<string, string[]> = {
    '/goals/businessGoals': state.goals.businessGoals,
    '/goals/userGoals': state.goals.userGoals,
    '/goals/systemGoals': state.goals.systemGoals,
    '/goals/successCriteria': state.goals.successCriteria,
    '/flow/mainFlow': state.flow.mainFlow,
    '/flow/branches': state.flow.branches,
    '/flow/exitConditions': state.flow.exitConditions,
    '/flow/failureFlows': state.flow.failureFlows,
    '/scope/inScope': state.scope.inScope,
    '/scope/outOfScope': state.scope.outOfScope,
    '/scope/future': state.scope.future,
    '/scope/constraints': state.scope.constraints,
    '/impact/systems': state.impact.systems,
    '/impact/upstream': state.impact.upstream,
    '/impact/downstream': state.impact.downstream,
    '/impact/data': state.impact.data,
    '/impact/externalServices': state.impact.externalServices
  }
  const target = arrayTargets[path]
  if (target) {
    if (operation.op === 'remove') target.splice(0)
    else if (Array.isArray(operation.value)) target.splice(0, target.length, ...uniqueStrings(operation.value))
    else {
      const text = cleanText(operation.value)
      if (text && !target.includes(text)) target.push(text)
    }
    setCollectionMeta(state, path, operation)
    return
  }

  const scenarioMatch = path.match(/^\/scenarios(?:\/([^/]+))?$/)
  if (scenarioMatch) {
    const id = scenarioMatch[1] || nextScenarioId(state)
    if (operation.op === 'remove') {
      const index = state.scenarios.findIndex((item) => item.scenarioId === id)
      if (index >= 0) state.scenarios.splice(index, 1)
      return
    }
    const scenario = normalizeScenario(operation.value, id)
    if (scenario) {
      const status = operation.status ?? (operation.source === 'user' ? 'confirmed' : scenario.status)
      replaceOrAppendById(state.scenarios, (item) => item.scenarioId, id, { ...scenario, scenarioId: id, status })
    }
    return
  }

  const ruleMatch = path.match(/^\/rules(?:\/([^/]+))?$/)
  if (ruleMatch) {
    const id = ruleMatch[1] || nextRuleId(state)
    if (operation.op === 'remove') {
      const index = state.rules.findIndex((item) => item.ruleId === id)
      if (index >= 0) state.rules.splice(index, 1)
      return
    }
    if (!operation.value || typeof operation.value !== 'object' || Array.isArray(operation.value)) return
    const row = operation.value as Record<string, unknown>
    const status = cleanText(row.status) as AnalysisSlotStatus
    const value = {
      ruleId: id,
      subject: cleanText(row.subject),
      condition: cleanText(row.condition),
      action: cleanText(row.action),
      priority: typeof row.priority === 'number' && Number.isFinite(row.priority) ? row.priority : null,
      exception: cleanText(row.exception) || null,
      status: operation.status ?? (['unknown', 'inferred', 'open', 'discussing', 'confirmed', 'conflicted', 'not_applicable'].includes(status) ? status : (operation.source === 'user' ? 'confirmed' : 'inferred') as AnalysisSlotStatus)
    }
    replaceOrAppendById(state.rules, (item) => item.ruleId, id, value)
    return
  }

  const decisionMatch = path.match(/^\/decisions(?:\/([^/]+))?$/)
  if (decisionMatch) {
    const id = decisionMatch[1] || nextDecisionId(state)
    if (operation.op === 'remove') {
      const index = state.decisions.findIndex((item) => item.id === id)
      if (index >= 0) state.decisions.splice(index, 1)
      return
    }
    const decision = normalizeDecision(operation.value, id)
    if (decision) {
      const status = operation.status ?? (operation.source === 'user' ? 'confirmed' : decision.status)
      replaceOrAppendById(state.decisions, (item) => item.id, id, { ...decision, id, status })
    }
    return
  }

  if (path === '/impact/historicalRequirements') {
    if (operation.op === 'remove') state.impact.historicalRequirements = []
    else if (Array.isArray(operation.value)) {
      state.impact.historicalRequirements = operation.value.flatMap((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return []
        const row = item as Record<string, unknown>
        const name = cleanText(row.name)
        if (!name) return []
        const relation = cleanText(row.relation)
        const status = cleanText(row.status) as AnalysisSlotStatus
        return [{
          name,
          relation: ['extends', 'changes', 'replaces', 'depends_on', 'unknown'].includes(relation) ? relation as AnalysisHistoricalRequirement['relation'] : 'unknown',
          impact: cleanText(row.impact),
          status: ['unknown', 'inferred', 'open', 'discussing', 'confirmed', 'conflicted', 'not_applicable'].includes(status) ? status : 'inferred'
        }]
      })
    }
    setCollectionMeta(state, path, operation)
  }
}

function addQuestion(state: AnalysisState, draft: AnalysisQuestionDraft): void {
  const question = draft.question.trim()
  if (!question) return
  if (state.openQuestions.some((item) => item.status === 'open' && item.question === question)) return
  state.openQuestions.push({
    id: nextQuestionId(state), topic: draft.topic.trim(), question,
    priority: draft.priority, reason: draft.reason.trim(), impact: uniqueStrings(draft.impact), blocking: draft.priority === 'blocking', status: 'open',
    type: draft.priority === 'blocking' ? 'BLOCKING' : 'NON_BLOCKING', targetStage: draft.targetStage ?? 'requirement-analysis'
  })
}

export interface AnalysisQuestionGateResult {
  state: AnalysisState
  candidateCount: number
  droppedCount: number
  deferredCount: number
  blockingCount: number
}

function normalizedQuestion(value: string): string {
  return value.toLowerCase().replace(/[\s，。？！；：,.?!;:'"“”‘’、]/g, '')
}

function isLifecycleConfirmationQuestion(value: string): boolean {
  return /(以上|当前).*(是否|可否).*(基线|确认|认可)|是否.*(?:完成|结束).*需求分析|是否.*进入.*(?:下一阶段|业务流程)/i.test(value)
}

function isDeferredDetail(draft: AnalysisQuestionDraft): boolean {
  const text = `${draft.topic} ${draft.question} ${draft.reason}`
  return draft.targetStage !== undefined && draft.targetStage !== 'requirement-analysis'
    || /(toast|提示语|文案|字段名|字段名称|颜色|字号|间距|圆角|图标|视觉|布局|交互细节)/i.test(text)
}

function isValidBlockingQuestion(draft: AnalysisQuestionDraft): boolean {
  const text = `${draft.topic} ${draft.question} ${draft.reason} ${(draft.impact ?? []).join(' ')}`
  return draft.priority === 'blocking'
    && /(两个|多种|多套|不同方案|无法确定|主流程|核心规则|范围|边界|系统职责|责任归属|scope|responsibility|core rule|main flow)/i.test(text)
}

function isAnsweredByMainline(state: AnalysisState, question: string): boolean {
  const normalized = normalizedQuestion(question)
  const answers = [
    ...Object.values(state.problem).filter((item) => item.status === 'confirmed').map((item) => item.value),
    ...state.goals.businessGoals, ...state.goals.userGoals, ...state.goals.systemGoals,
    ...state.flow.mainFlow, ...state.scope.inScope, ...state.scope.outOfScope, ...state.scope.constraints,
    ...state.rules.filter((item) => item.status === 'confirmed').flatMap((item) => [item.subject, item.condition, item.action]),
    ...state.decisions.filter((item) => item.status === 'confirmed').map((item) => item.decision)
  ].map(normalizedQuestion).filter((value) => value.length >= 8)
  return answers.some((answer) => normalized.includes(answer))
}

export function gateAnalysisQuestions(state: AnalysisState, drafts: AnalysisQuestionDraft[]): AnalysisQuestionGateResult {
  const next = normalizeAnalysisState(state)
  const provisionalReady = next.readiness.readyForConfirmation
  let droppedCount = 0
  let deferredCount = 0
  let blockingCount = 0
  for (const draft of drafts.slice(0, 8)) {
    const question = draft.question.trim()
    if (!question) { droppedCount += 1; continue }
    const signature = normalizedQuestion(question)
    const duplicate = next.openQuestions.find((item) => normalizedQuestion(item.question) === signature)
    if (duplicate || isLifecycleConfirmationQuestion(question) || isAnsweredByMainline(next, question)) {
      droppedCount += 1
      continue
    }
    const blocking = isValidBlockingQuestion(draft)
    if (!blocking && (provisionalReady || draft.priority === 'non_blocking' || isDeferredDetail(draft))) {
      next.openQuestions.push({
        id: nextQuestionId(next), topic: draft.topic.trim(), question, priority: 'non_blocking', reason: draft.reason.trim(),
        impact: uniqueStrings(draft.impact), blocking: false, status: 'deferred', type: 'DEFERRED',
        targetStage: draft.targetStage ?? (isDeferredDetail(draft) ? 'interaction-design' : 'business-flow')
      })
      deferredCount += 1
      continue
    }
    if (!blocking) { droppedCount += 1; continue }
    addQuestion(next, { ...draft, priority: 'blocking', targetStage: 'requirement-analysis' })
    blockingCount += 1
  }
  next.readiness = calculateAnalysisReadinessValue(next)
  next.updatedAt = now()
  return { state: next, candidateCount: drafts.length, droppedCount, deferredCount, blockingCount }
}

function addDeterministicConflicts(state: AnalysisState): void {
  const overlaps = state.scope.inScope.filter((value) => state.scope.outOfScope.includes(value))
  for (const value of overlaps) {
    addQuestion(state, {
      topic: 'scope', priority: 'blocking', reason: '同一范围项同时出现在 inScope 与 outOfScope。',
      question: `“${value}”当前同时被标记为本期范围和非本期范围，请确认最终边界。`
    })
  }
}

export function applyAnalysisStatePatches(state: AnalysisState, patches: AnalysisPatchOperation[]): AnalysisState {
  const next = cloneState(state)
  const changedPaths: string[] = []
  for (const operation of patches.slice(0, 40)) {
    if (!operation || typeof operation.path !== 'string' || !/^\/(problem|scenarios|goals|flow|rules|scope|impact|decisions|modules)(\/|$)/.test(operation.path)) continue
    applyOperation(next, operation)
    changedPaths.push(operation.path)
  }
  next.changedPaths = [...new Set(changedPaths)]
  next.updatedAt = now()
  return next
}

export function resolveAnalysisQuestions(
  state: AnalysisState,
  resolvedQuestionIds: string[],
  newQuestions: AnalysisQuestionDraft[]
): AnalysisState {
  const next = cloneState(state)
  for (const id of resolvedQuestionIds) {
    const question = next.openQuestions.find((item) => item.id === id)
    if (question) { question.status = 'closed'; question.type = 'CLOSED'; question.blocking = false }
  }
  const gated = gateAnalysisQuestions(next, newQuestions)
  next.updatedAt = now()
  return gated.state
}

export function detectAnalysisConflicts(state: AnalysisState): AnalysisState {
  const next = cloneState(state)
  addDeterministicConflicts(next)
  next.updatedAt = now()
  return next
}

export function finalizeAnalysisTurn(state: AnalysisState): AnalysisState {
  const next = cloneState(state)
  next.version += 1
  next.readiness = calculateAnalysisReadiness(next)
  next.updatedAt = now()
  return next
}

export function applyAnalysisTurn(state: AnalysisState, submission: AnalysisTurnSubmission): AnalysisState {
  const normalized = normalizeAnalysisState(state)
  const prepared = applyAnalysisSchemaAndWorking(normalized, submission)
  const patched = applyAnalysisStatePatches(prepared, submission.patches)
  const resolved = resolveAnalysisQuestions(patched, submission.resolvedQuestionIds, submission.newQuestions)
  const conflictsChecked = detectAnalysisConflicts(resolved)
  return finalizeAnalysisTurn(conflictsChecked)
}

export function migrateLegacyAnalysisState(
  workspaceId: string,
  requirementId: string,
  threadId: string,
  legacy: RequirementAnalysisResult | null
): AnalysisState {
  const state = createEmptyAnalysisState(workspaceId, requirementId, threadId)
  if (!legacy) return state
  const timestamp = now()
  state.source = 'migrated'
  state.mainlineSchema.status = 'proposed'
  const migratedCollectionStatus: AnalysisSlotStatus = legacy.analysisStatus === 'Confirmed' || legacy.readiness.semanticReady ? 'confirmed' : 'inferred'
  const markMigratedCollection = (path: string) => {
    state.collectionMeta[path] = { status: migratedCollectionStatus, source: 'migration', updatedAt: timestamp }
  }
  state.problem.currentProblem = { value: legacy.problemDefinition, status: 'confirmed', source: 'migration', updatedAt: timestamp, openIssueId: null }
  state.goals.businessGoals = legacy.goal ? [legacy.goal] : []
  if (state.goals.businessGoals.length) markMigratedCollection('/goals/businessGoals')
  state.scenarios = legacy.scenarios.map((item, index) => ({
    scenarioId: item.id || `S${index + 1}`, actor: item.actor, trigger: item.trigger, preconditions: [], intent: '',
    currentActions: item.currentFlow, painPoint: item.blocker, expectedOutcome: item.expectedOutcome,
    status: /confirm|明确|已确认/i.test(item.status) ? 'confirmed' : 'inferred'
  }))
  state.flow.mainFlow = legacy.currentFlow
  if (state.flow.mainFlow.length) markMigratedCollection('/flow/mainFlow')
  state.problem.rootCause = {
    value: legacy.rootCauses.map((item) => item.description).join('；'),
    status: legacy.rootCauses.some((item) => item.evidenceType === 'FACT') ? 'confirmed' : legacy.rootCauses.length ? 'inferred' : 'unknown',
    source: 'migration', updatedAt: timestamp, openIssueId: null
  }
  state.scope.constraints = legacy.boundaries
  state.scope.outOfScope = legacy.outOfScope
  if (state.scope.constraints.length) markMigratedCollection('/scope/constraints')
  if (state.scope.outOfScope.length) markMigratedCollection('/scope/outOfScope')
  state.decisions = legacy.decisions.map((decision, index) => ({ id: `D${index + 1}`, topic: 'legacy', decision, reason: '', status: 'confirmed' }))
  state.openQuestions = legacy.openQuestions.map((question, index) => ({ id: `Q${index + 1}`, topic: 'legacy', question, priority: 'blocking', reason: '从历史 Requirement Analysis 迁移', status: 'open' }))
  state.readiness = calculateAnalysisReadiness(state)
  return state
}

function compactList(values: string[], limit = 8): string {
  return values.slice(0, limit).map((value) => `- ${value}`).join('\n') || '- —'
}

export function buildAnalysisProjection(state: AnalysisState): string {
  state = normalizeAnalysisState(state)
  const confirmed: string[] = []
  const inferred: string[] = []
  const pushSlot = (label: string, value: AnalysisSlot<string>) => {
    if (!value.value.trim() || value.status === 'unknown' || value.status === 'not_applicable') return
    const target = value.status === 'confirmed' ? confirmed : inferred
    target.push(`${label}：${value.value}`)
  }
  pushSlot('当前问题', state.problem.currentProblem)
  pushSlot('触发原因', state.problem.trigger)
  pushSlot('根因', state.problem.rootCause)
  pushSlot('业务影响', state.problem.businessImpact)
  pushSlot('当前绕行方式', state.problem.currentWorkaround)
  const pushCollection = (path: string, label: string, values: string[], separator: string) => {
    if (!values.length) return
    const target = collectionStatus(state, path) === 'confirmed' ? confirmed : inferred
    target.push(`${label}：${values.join(separator)}`)
  }
  pushCollection('/goals/businessGoals', '业务目标', state.goals.businessGoals, '；')
  pushCollection('/flow/mainFlow', '当前主流程', state.flow.mainFlow, ' → ')
  pushCollection('/scope/inScope', '本期范围', state.scope.inScope, '、')
  pushCollection('/scope/outOfScope', '非本期', state.scope.outOfScope, '、')
  const scenarios = state.scenarios.slice(0, 5).map((item) => `${item.scenarioId} ${item.actor}｜${item.trigger}｜痛点：${item.painPoint}｜期望：${item.expectedOutcome}`)
  const rules = state.rules.filter((item) => item.status !== 'unknown').slice(0, 8)
    .map((item) => `${item.ruleId} ${item.subject}：${item.condition || '默认'} → ${item.action}`)
  const decisions = state.decisions.filter((item) => item.status === 'confirmed').slice(0, 8)
    .map((item) => `${item.id} ${item.decision}`)
  const blocking = state.openQuestions.filter((item) => item.status === 'open' && item.priority === 'blocking').slice(0, 5)
    .map((item) => `${item.id} ${item.question}`)
  const nonBlocking = state.openQuestions.filter((item) => item.status === 'open' && item.priority === 'non_blocking').slice(0, 3)
    .map((item) => `${item.id} ${item.question}`)
  const readiness = state.readiness
  const moduleFacts = Object.entries(state.moduleData).slice(0, 12).map(([key, item]) => `${key} [${item.status}]：${typeof item.value === 'string' ? item.value : JSON.stringify(item.value)}`)
  return [
    `[Analysis Mainline v${state.version}]`,
    `[Schema v${state.mainlineSchema.version} · ${state.mainlineSchema.status}]`,
    `Types: ${state.mainlineSchema.requirementTypes.join(', ') || '—'}`,
    `Modules: ${state.mainlineSchema.modules.join(', ')}`,
    '[Confirmed]', compactList(confirmed),
    inferred.length ? `[Inferred / Discussing]\n${compactList(inferred)}` : '',
    scenarios.length ? `[Scenarios]\n${compactList(scenarios)}` : '',
    rules.length ? `[Rules]\n${compactList(rules)}` : '',
    decisions.length ? `[Decisions]\n${compactList(decisions)}` : '',
    moduleFacts.length ? `[Requirement-specific Modules]\n${compactList(moduleFacts, 12)}` : '',
    `[Blocking Questions]\n${compactList(blocking)}`,
    nonBlocking.length ? `[Non-blocking Questions]\n${compactList(nonBlocking)}` : '',
    state.changedPaths.length ? `[Changed Since Last Turn]\n${compactList(state.changedPaths)}` : '',
    `[Readiness]\nStatus=${readiness.status} Problem=${readiness.problemClear} Goal=${readiness.goalClear} Scenario=${readiness.scenarioClear} MainFlow=${readiness.mainFlowClear} Rules=${readiness.rulesClear} Scope=${readiness.scopeClear} Exceptions=${readiness.exceptionsClear} Dependencies=${readiness.dependenciesClear} Blocking=${readiness.blockingQuestions} Ready=${readiness.readyForConfirmation}`
  ].filter(Boolean).join('\n\n')
}

export function buildAnalysisWorkingProjection(state: AnalysisState): string {
  state = normalizeAnalysisState(state)
  const question = state.working.currentQuestion
  return [
    `Current Topic: ${state.working.currentTopic ?? '—'}`,
    `Current Question: ${question ? `${question.id} ${question.question}` : '—'}`,
    question?.options.length ? `Options:\n${question.options.map((item) => `- ${item.id}: ${item.label}`).join('\n')}` : ''
  ].filter(Boolean).join('\n')
}

function analysisStatements(state: AnalysisState): { blockers: AnalysisStatement[]; roots: AnalysisStatement[] } {
  const blockers = state.scenarios.filter((item) => item.painPoint.trim()).map((item) => ({
    description: item.painPoint,
    evidenceType: item.status === 'confirmed' ? 'FACT' as const : 'ASSUMPTION' as const,
    source: item.status === 'confirmed' ? 'Analysis State' : null
  }))
  const roots = state.problem.rootCause.value.trim() ? [{
    description: state.problem.rootCause.value,
    evidenceType: state.problem.rootCause.status === 'confirmed' ? 'FACT' as const : 'ASSUMPTION' as const,
    source: state.problem.rootCause.status === 'confirmed' ? 'Analysis State' : null
  }] : []
  return { blockers, roots }
}

function renderStateMarkdown(state: AnalysisState): string {
  const readiness = state.readiness.readyForConfirmation ? 'confirmed' : 'draft'
  const actors = [...new Set(state.scenarios.map((item) => item.actor).filter(Boolean))]
  const scenarios = state.scenarios.length ? state.scenarios.map((item) => [
    `### ${item.scenarioId}${item.intent ? ` ${item.intent}` : ''}`, `- Actor：${item.actor || '—'}`, `- Trigger：${item.trigger || '—'}`,
    `- Preconditions：${item.preconditions.join('、') || '—'}`, `- Current Flow：${item.currentActions.join(' → ') || '—'}`,
    `- Pain Point：${item.painPoint || '—'}`, `- Expected Outcome：${item.expectedOutcome || '—'}`, `- Status：${item.status}`
  ].join('\n')).join('\n\n') : '—'
  const rules = state.rules.length ? state.rules.map((item) => `- ${item.ruleId}｜${item.subject}｜${item.condition || '默认'} → ${item.action}${item.exception ? `｜例外：${item.exception}` : ''}`).join('\n') : '—'
  const questions = state.openQuestions.filter((item) => item.status === 'open').map((item) => `- ${item.id} [${item.priority}] ${item.question}`).join('\n') || '—'
  return `# Requirement Analysis\n\n- Analysis Status：${readiness}\n- Analysis State Version：${state.version}\n\n## 1. Problem\n\n${state.problem.currentProblem.value || '—'}\n\n## 2. Goals\n\n${compactList([...state.goals.businessGoals, ...state.goals.userGoals, ...state.goals.systemGoals])}\n\n## 3. Actors\n\n${compactList(actors)}\n\n## 4. Scenarios\n\n${scenarios}\n\n## 5. Current Main Flow\n\n${state.flow.mainFlow.join(' → ') || '—'}\n\n## 6. Rules\n\n${rules}\n\n## 7. Scope\n\n### In Scope\n${compactList(state.scope.inScope)}\n\n### Out of Scope\n${compactList(state.scope.outOfScope)}\n\n### Future\n${compactList(state.scope.future)}\n\n### Constraints\n${compactList(state.scope.constraints)}\n\n## 8. Impact\n\n- Systems：${state.impact.systems.join('、') || '—'}\n- Upstream：${state.impact.upstream.join('、') || '—'}\n- Downstream：${state.impact.downstream.join('、') || '—'}\n- External Services：${state.impact.externalServices.join('、') || '—'}\n\n## 9. Decisions\n\n${compactList(state.decisions.filter((item) => item.status === 'confirmed').map((item) => `${item.id} ${item.decision}`))}\n\n## 10. Open Questions\n\n${questions}\n\n## 11. Readiness\n\n- Status：${state.readiness.status}\n- Problem Clear：${state.readiness.problemClear}\n- Goal Clear：${state.readiness.goalClear}\n- Scenario Clear：${state.readiness.scenarioClear}\n- Main Flow Clear：${state.readiness.mainFlowClear}\n- Rules Clear：${state.readiness.rulesClear}\n- Scope Clear：${state.readiness.scopeClear}\n- Blocking Questions：${state.readiness.blockingQuestions}\n`
}

export function analysisResultFromState(state: AnalysisState, artifactBaseHash: string | null): RequirementAnalysisResult {
  const { blockers, roots } = analysisStatements(state)
  const facts: string[] = []
  const assumptions: string[] = []
  for (const [label, value] of Object.entries(state.problem) as Array<[string, AnalysisSlot<string>]>) {
    if (!value.value.trim()) continue
    ;(value.status === 'confirmed' ? facts : assumptions).push(`${label}: ${value.value}`)
  }
  const status = state.readiness.readyForConfirmation ? 'ReadyForConfirmation' : 'Analyzing'
  return {
    analysisStatus: status,
    problemDefinition: state.problem.currentProblem.value,
    goal: [...state.goals.businessGoals, ...state.goals.userGoals, ...state.goals.systemGoals].join('；'),
    actors: [...new Set(state.scenarios.map((item) => item.actor).filter(Boolean))].map((name) => ({ name, role: name })),
    scenarios: state.scenarios.map((item) => ({
      id: item.scenarioId, name: item.intent || item.expectedOutcome || item.scenarioId, actor: item.actor,
      trigger: item.trigger, currentFlow: item.currentActions, blocker: item.painPoint,
      expectedOutcome: item.expectedOutcome, status: item.status
    })),
    currentFlow: state.flow.mainFlow,
    blockers,
    rootCauses: roots,
    boundaries: state.scope.constraints,
    facts,
    assumptions,
    decisions: state.decisions.filter((item) => item.status === 'confirmed').map((item) => item.decision),
    openQuestions: state.openQuestions.filter((item) => item.status === 'open').map((item) => item.question),
    outOfScope: state.scope.outOfScope,
    readiness: {
      deterministicPassed: state.readiness.problemClear && state.readiness.goalClear && state.readiness.scenarioClear && state.readiness.mainFlowClear && state.readiness.rulesClear && state.readiness.scopeClear,
      semanticReady: state.readiness.readyForConfirmation,
      missing: [
        !state.readiness.problemClear ? 'problem_definition' : '', !state.readiness.goalClear ? 'goal' : '', !state.readiness.scenarioClear ? 'scenarios' : '',
        !state.readiness.mainFlowClear ? 'current_flow' : '', !state.readiness.rulesClear ? 'rules' : '',
        !state.readiness.scopeClear ? 'scope' : '', state.readiness.blockingQuestions ? 'blocking_questions' : ''
      ].filter(Boolean)
    },
    artifactPath: 'analysis/requirement-analysis.md',
    artifactCandidate: renderStateMarkdown(state),
    artifactBaseHash,
    confirmedAt: null
  }
}
