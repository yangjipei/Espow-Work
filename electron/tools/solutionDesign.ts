import type {
  CapabilityExecution, CapabilityLayer, ProductSurface, SolutionCapability, SolutionCheckResult,
  SolutionDataObject, SolutionDecisionCandidate, SolutionDesignModel, SolutionDesignReadiness,
  SolutionDesignStatus, SolutionRecovery, SolutionRule, SolutionState
} from '../../src/skills'

const statuses = new Set<SolutionDesignStatus>(['DRAFT', 'WAITING_CLARIFICATION', 'READY_FOR_CONFIRMATION'])
const layers = new Set<CapabilityLayer>(['user-facing', 'system', 'supporting'])
const executions = new Set<CapabilityExecution>(['manual', 'automatic'])

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} 必须是对象。`)
  return value as Record<string, unknown>
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 必须是非空字符串。`)
  return value.trim()
}

function nullableText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null
  return text(value, field)
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error(`${field} 必须是字符串数组。`)
  return value.map((item) => item.trim()).filter(Boolean)
}

function objects<T>(value: unknown, field: string, parser: (item: Record<string, unknown>, index: number) => T): T[] {
  if (!Array.isArray(value)) throw new Error(`${field} 必须是数组。`)
  return value.map((item, index) => parser(record(item, `${field}[${index}]`), index))
}

function checkBoolean(value: Record<string, unknown>, key: keyof SolutionDesignModel['semanticChecks']): boolean {
  if (typeof value[key] !== 'boolean') throw new Error(`semanticChecks.${key} 必须是布尔值。`)
  return value[key] as boolean
}

export function parseSolutionDesignJson(raw: string, allowConfirmed = false): SolutionDesignModel {
  let value: Record<string, unknown>
  try { value = record(JSON.parse(raw), 'Solution Design') } catch (error) {
    throw new Error(error instanceof SyntaxError ? 'resultJson 必须是合法的 JSON 对象。' : (error as Error).message)
  }
  const status = text(value.status, 'status') as SolutionDesignStatus
  if (!statuses.has(status) && !(allowConfirmed && status === 'CONFIRMED')) throw new Error('模型只能提交 DRAFT、WAITING_CLARIFICATION 或 READY_FOR_CONFIRMATION。')
  const scope = record(value.scope, 'scope')
  const capabilities = objects(value.capabilities, 'capabilities', (item): SolutionCapability => {
    const layer = text(item.layer, 'capability.layer') as CapabilityLayer
    const execution = text(item.execution, 'capability.execution') as CapabilityExecution
    if (!layers.has(layer)) throw new Error(`不支持的 Capability Layer：${layer}`)
    if (!executions.has(execution)) throw new Error(`不支持的 Capability Execution：${execution}`)
    return {
      id: text(item.id, 'capability.id'), name: text(item.name, 'capability.name'), layer,
      purpose: text(item.purpose, 'capability.purpose'), actor: text(item.actor, 'capability.actor'),
      trigger: text(item.trigger, 'capability.trigger'), execution,
      input: strings(item.input, 'capability.input'), behavior: strings(item.behavior, 'capability.behavior'),
      output: strings(item.output, 'capability.output'), relatedFlowNodeIds: strings(item.relatedFlowNodeIds, 'capability.relatedFlowNodeIds'),
      sourceScenarioIds: strings(item.sourceScenarioIds, 'capability.sourceScenarioIds'),
      sourceDecisionIds: strings(item.sourceDecisionIds, 'capability.sourceDecisionIds'),
      rules: strings(item.rules, 'capability.rules'), exceptions: strings(item.exceptions, 'capability.exceptions'),
      surfaces: strings(item.surfaces, 'capability.surfaces')
    }
  })
  const rules = objects(value.rules, 'rules', (item): SolutionRule => ({
    id: text(item.id, 'rule.id'), description: text(item.description, 'rule.description'),
    capabilityIds: strings(item.capabilityIds, 'rule.capabilityIds'), sourceFlowNodeIds: strings(item.sourceFlowNodeIds, 'rule.sourceFlowNodeIds')
  }))
  const states = objects(value.states, 'states', (item): SolutionState => ({
    id: text(item.id, 'state.id'), name: text(item.name, 'state.name'), meaning: text(item.meaning, 'state.meaning'),
    entryConditions: strings(item.entryConditions, 'state.entryConditions'), exitConditions: strings(item.exitConditions, 'state.exitConditions')
  }))
  const dataObjects = objects(value.dataObjects, 'dataObjects', (item): SolutionDataObject => ({
    id: text(item.id, 'dataObject.id'), name: text(item.name, 'dataObject.name'), purpose: text(item.purpose, 'dataObject.purpose'),
    keyFields: strings(item.keyFields, 'dataObject.keyFields'),
    producedByCapabilityIds: strings(item.producedByCapabilityIds, 'dataObject.producedByCapabilityIds'),
    consumedByCapabilityIds: strings(item.consumedByCapabilityIds, 'dataObject.consumedByCapabilityIds')
  }))
  const recoveries = objects(value.recoveries, 'recoveries', (item): SolutionRecovery => ({
    exception: text(item.exception, 'recovery.exception'), responsibleCapabilityId: text(item.responsibleCapabilityId, 'recovery.responsibleCapabilityId'),
    behavior: text(item.behavior, 'recovery.behavior'), outcome: text(item.outcome, 'recovery.outcome')
  }))
  const productSurfaces = objects(value.productSurfaces, 'productSurfaces', (item): ProductSurface => ({
    id: text(item.id, 'surface.id'), name: text(item.name, 'surface.name'), type: text(item.type, 'surface.type'),
    purpose: text(item.purpose, 'surface.purpose'), capabilityIds: strings(item.capabilityIds, 'surface.capabilityIds')
  }))
  const decisions = objects(value.decisions, 'decisions', (item): SolutionDecisionCandidate => ({
    id: text(item.id, 'decision.id'), question: text(item.question, 'decision.question'),
    options: objects(item.options, 'decision.options', (option) => ({
      name: text(option.name, 'option.name'), description: text(option.description, 'option.description'), tradeOff: text(option.tradeOff, 'option.tradeOff')
    })),
    affectedCapabilityIds: strings(item.affectedCapabilityIds, 'decision.affectedCapabilityIds')
  }))
  const semantic = record(value.semanticChecks, 'semanticChecks')
  const sourceAnalysisStatus = text(value.sourceAnalysisStatus, 'sourceAnalysisStatus')
  const sourceFlowStatus = text(value.sourceFlowStatus, 'sourceFlowStatus')
  if (!['confirmed', 'draft'].includes(sourceAnalysisStatus) || !['confirmed', 'draft'].includes(sourceFlowStatus)) {
    throw new Error('sourceAnalysisStatus 与 sourceFlowStatus 必须是 confirmed 或 draft。')
  }
  return {
    id: text(value.id, 'id'), name: text(value.name, 'name'), overview: text(value.overview, 'overview'),
    scope: { included: strings(scope.included, 'scope.included'), excluded: strings(scope.excluded, 'scope.excluded') },
    status, capabilities, rules, states, dataObjects, recoveries, productSurfaces, decisions,
    openQuestions: strings(value.openQuestions, 'openQuestions'), flowConflicts: strings(value.flowConflicts, 'flowConflicts'),
    semanticChecks: {
      goalCovered: checkBoolean(semantic, 'goalCovered'), scenariosCovered: checkBoolean(semantic, 'scenariosCovered'),
      flowNodesCovered: checkBoolean(semantic, 'flowNodesCovered'), blockersResolved: checkBoolean(semantic, 'blockersResolved'),
      exceptionsHandled: checkBoolean(semantic, 'exceptionsHandled'), exitsCovered: checkBoolean(semantic, 'exitsCovered'),
      recoveryCovered: checkBoolean(semantic, 'recoveryCovered'), noOverdesign: checkBoolean(semantic, 'noOverdesign')
    },
    sourceAnalysisPath: text(value.sourceAnalysisPath, 'sourceAnalysisPath'),
    sourceAnalysisStatus: sourceAnalysisStatus as 'confirmed' | 'draft', sourceFlowPath: text(value.sourceFlowPath, 'sourceFlowPath'),
    sourceFlowStatus: sourceFlowStatus as 'confirmed' | 'draft', confirmedAt: nullableText(value.confirmedAt, 'confirmedAt')
  }
}

function duplicates(values: string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))]
}

export function solutionCoverageCheck(solution: SolutionDesignModel, sourceFlowNodeIds: string[] = []): SolutionCheckResult {
  const missing: string[] = []
  const warnings: string[] = []
  const capabilityIds = solution.capabilities.map((item) => item.id)
  const capabilitySet = new Set(capabilityIds)
  if (!solution.capabilities.length) missing.push('capabilities_missing')
  for (const duplicate of duplicates(capabilityIds)) missing.push(`duplicate_capability:${duplicate}`)
  for (const capability of solution.capabilities) {
    if (!capability.relatedFlowNodeIds.length) missing.push(`flow_trace_missing:${capability.id}`)
    if (!capability.sourceScenarioIds.length) warnings.push(`scenario_trace_missing:${capability.id}`)
    if (!capability.input.length) missing.push(`input_missing:${capability.id}`)
    if (!capability.behavior.length) missing.push(`behavior_missing:${capability.id}`)
    if (!capability.output.length) missing.push(`output_missing:${capability.id}`)
  }
  if (sourceFlowNodeIds.length) {
    const covered = new Set(solution.capabilities.flatMap((item) => item.relatedFlowNodeIds))
    for (const nodeId of sourceFlowNodeIds) if (!covered.has(nodeId)) missing.push(`flow_node_uncovered:${nodeId}`)
  }
  for (const rule of solution.rules) for (const id of rule.capabilityIds) if (!capabilitySet.has(id)) missing.push(`rule_capability_reference:${rule.id}:${id}`)
  for (const recovery of solution.recoveries) if (!capabilitySet.has(recovery.responsibleCapabilityId)) missing.push(`recovery_capability_reference:${recovery.responsibleCapabilityId}`)
  for (const surface of solution.productSurfaces) for (const id of surface.capabilityIds) if (!capabilitySet.has(id)) missing.push(`surface_capability_reference:${surface.id}:${id}`)
  for (const data of solution.dataObjects) {
    for (const id of [...data.producedByCapabilityIds, ...data.consumedByCapabilityIds]) if (!capabilitySet.has(id)) missing.push(`data_capability_reference:${data.id}:${id}`)
  }
  if (solution.status === 'WAITING_CLARIFICATION' && !solution.openQuestions.length && !solution.flowConflicts.length) missing.push('clarification_reason_missing')
  if (solution.status === 'READY_FOR_CONFIRMATION' && solution.openQuestions.length) missing.push('blocking_open_questions')
  if (solution.status === 'READY_FOR_CONFIRMATION' && solution.decisions.length) missing.push('unresolved_decisions')
  if (solution.status === 'READY_FOR_CONFIRMATION' && solution.flowConflicts.length) missing.push('flow_conflicts')
  const semanticKeys = Object.entries(solution.semanticChecks).filter(([key, passed]) => key !== 'noOverdesign' && !passed).map(([key]) => key)
  missing.push(...semanticKeys.map((key) => `semantic:${key}`))
  return { passed: missing.length === 0, missing: [...new Set(missing)], warnings: [...new Set(warnings)] }
}

const technicalTerms = /(kafka|redis|微服务|数据库表|table schema|索引设计|cron|消息队列|分库分表|服务网格)/i
const platformTerms = /(统一.*平台|多服务商.*路由|智能.*路由|批量任务|ai.*自动外呼|独立设备管理)/i

export function solutionOverdesignCheck(solution: SolutionDesignModel): SolutionCheckResult {
  const missing: string[] = []
  const warnings: string[] = []
  const text = JSON.stringify({ overview: solution.overview, capabilities: solution.capabilities, rules: solution.rules, surfaces: solution.productSurfaces })
  if (technicalTerms.test(text)) missing.push('technical_implementation_leak')
  if (platformTerms.test(text)) missing.push('potential_platform_overdesign')
  for (const capability of solution.capabilities) {
    if (!capability.relatedFlowNodeIds.length && !capability.sourceScenarioIds.length && !capability.sourceDecisionIds.length) {
      missing.push(`ungrounded_capability:${capability.id}`)
    }
  }
  if (!solution.semanticChecks.noOverdesign) missing.push('semantic:noOverdesign')
  if (solution.capabilities.length > 30) warnings.push('capability_count_high')
  return { passed: missing.length === 0, missing: [...new Set(missing)], warnings }
}

export function solutionDesignReadiness(solution: SolutionDesignModel, sourceFlowNodeIds: string[] = []): SolutionDesignReadiness {
  const coverage = solutionCoverageCheck(solution, sourceFlowNodeIds)
  const overdesign = solutionOverdesignCheck(solution)
  const missing = [...coverage.missing, ...overdesign.missing]
  const warnings = [...coverage.warnings, ...overdesign.warnings]
  return {
    deterministicPassed: coverage.passed && overdesign.passed,
    semanticReady: Object.values(solution.semanticChecks).every(Boolean), coverage, overdesign,
    missing: [...new Set(missing)], warnings: [...new Set(warnings)]
  }
}

function list(values: string[]): string { return values.length ? values.map((item) => `- ${item}`).join('\n') : '—' }

export function renderSolutionDesignMarkdown(solution: SolutionDesignModel): string {
  const capabilities = solution.capabilities.map((capability) => `### ${capability.id} · ${capability.name}\n\n- Layer：${capability.layer}\n- Purpose：${capability.purpose}\n- Actor：${capability.actor}\n- Trigger：${capability.trigger}\n- Execution：${capability.execution}\n- Input：${capability.input.join('；') || '—'}\n- Behavior：${capability.behavior.join('；') || '—'}\n- Output：${capability.output.join('；') || '—'}\n- Product Surface：${capability.surfaces.join('；') || '—'}\n- Related Flow Nodes：${capability.relatedFlowNodeIds.join('、') || '—'}\n- Source Scenarios：${capability.sourceScenarioIds.join('、') || '—'}\n- Source Decisions：${capability.sourceDecisionIds.join('、') || '—'}\n- Rules：${capability.rules.join('；') || '—'}\n- Exceptions：${capability.exceptions.join('；') || '—'}`).join('\n\n')
  const rules = solution.rules.map((rule) => `- **${rule.id}** ${rule.description}（Capabilities：${rule.capabilityIds.join('、') || '—'}；Flow：${rule.sourceFlowNodeIds.join('、') || '—'}）`)
  const states = solution.states.map((state) => `- **${state.name}**：${state.meaning}；进入：${state.entryConditions.join('；') || '—'}；退出：${state.exitConditions.join('；') || '—'}`)
  const data = solution.dataObjects.map((item) => `- **${item.name}**：${item.purpose}；关键字段：${item.keyFields.join('、') || '—'}`)
  const recoveries = solution.recoveries.map((item) => `- **${item.exception}** → ${item.responsibleCapabilityId}：${item.behavior}；结果：${item.outcome}`)
  const surfaces = solution.productSurfaces.map((item) => `- **${item.name}**（${item.type}）：${item.purpose}；承载 ${item.capabilityIds.join('、') || '—'}`)
  const decisions = solution.decisions.map((item) => `### ${item.id} · ${item.question}\n\n${item.options.map((option) => `- **${option.name}**：${option.description}；Trade-off：${option.tradeOff}`).join('\n')}`)
  return `# Solution Design｜${solution.name}\n\n- Solution Status：${solution.status === 'READY_FOR_CONFIRMATION' ? 'confirmed' : solution.status.toLowerCase()}\n- Source Analysis：${solution.sourceAnalysisPath} (${solution.sourceAnalysisStatus})\n- Source Business Flow：${solution.sourceFlowPath} (${solution.sourceFlowStatus})\n\n## Solution Overview\n\n${solution.overview}\n\n## Scope\n\n### Included\n\n${list(solution.scope.included)}\n\n### Out of Scope\n\n${list(solution.scope.excluded)}\n\n## Capability Map\n\n${capabilities || '—'}\n\n## Key Rules\n\n${rules.join('\n') || '—'}\n\n## State\n\n${states.join('\n') || '—'}\n\n## Data\n\n${data.join('\n') || '—'}\n\n## Exception & Recovery\n\n${recoveries.join('\n') || '—'}\n\n## Product Surfaces\n\n${surfaces.join('\n') || '—'}\n\n## Decisions\n\n${decisions.join('\n\n') || '—'}\n\n## Open Questions\n\n${list(solution.openQuestions)}\n\n## Flow Conflicts\n\n${list(solution.flowConflicts)}\n`
}
