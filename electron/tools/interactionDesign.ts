import type {
  InteractionAction, InteractionComponent, InteractionDecisionCandidate, InteractionDesignModel,
  InteractionDesignReadiness, InteractionDesignStatus, InteractionFeedback, InteractionPage,
  InteractionRule, InteractionState, InteractionSurface, InteractionTransition, InteractionUserPath
} from '../../src/skills'

const statuses = new Set<InteractionDesignStatus>(['DRAFT', 'WAITING_CLARIFICATION', 'READY_FOR_CONFIRMATION'])
const stateKinds = new Set(['default', 'loading', 'success', 'empty', 'error', 'disabled', 'processing', 'waiting', 'completed'])
const priorities = new Set(['primary', 'secondary', 'high-risk'])
const feedbackTypes = new Set(['inline', 'toast', 'badge', 'notification', 'popup', 'state-change', 'navigation'])

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

function objects<T>(value: unknown, field: string, parser: (item: Record<string, unknown>) => T): T[] {
  if (!Array.isArray(value)) throw new Error(`${field} 必须是数组。`)
  return value.map((item, index) => parser(record(item, `${field}[${index}]`)))
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} 必须是布尔值。`)
  return value
}

export function parseInteractionDesignJson(raw: string, allowConfirmed = false): InteractionDesignModel {
  let value: Record<string, unknown>
  try { value = record(JSON.parse(raw), 'Interaction Design') } catch (error) {
    throw new Error(error instanceof SyntaxError ? 'resultJson 必须是合法的 JSON 对象。' : (error as Error).message)
  }
  const status = text(value.status, 'status') as InteractionDesignStatus
  if (!statuses.has(status) && !(allowConfirmed && status === 'CONFIRMED')) throw new Error('模型只能提交 DRAFT、WAITING_CLARIFICATION 或 READY_FOR_CONFIRMATION。')
  const surfaces = objects(value.surfaces, 'surfaces', (item): InteractionSurface => ({
    id: text(item.id, 'surface.id'), name: text(item.name, 'surface.name'), type: text(item.type, 'surface.type'),
    purpose: text(item.purpose, 'surface.purpose'), existing: bool(item.existing, 'surface.existing'),
    sourceCapabilityIds: strings(item.sourceCapabilityIds, 'surface.sourceCapabilityIds')
  }))
  const pages = objects(value.pages, 'pages', (item): InteractionPage => ({
    id: text(item.id, 'page.id'), name: text(item.name, 'page.name'), surfaceId: text(item.surfaceId, 'page.surfaceId'),
    purpose: text(item.purpose, 'page.purpose'), sections: strings(item.sections, 'page.sections'),
    entryPoints: strings(item.entryPoints, 'page.entryPoints'), sourceCapabilityIds: strings(item.sourceCapabilityIds, 'page.sourceCapabilityIds'),
    sourceFlowNodeIds: strings(item.sourceFlowNodeIds, 'page.sourceFlowNodeIds'), sourceScenarioIds: strings(item.sourceScenarioIds, 'page.sourceScenarioIds')
  }))
  const components = objects(value.components, 'components', (item): InteractionComponent => {
    const priority = text(item.informationPriority, 'component.informationPriority') as InteractionComponent['informationPriority']
    if (!['primary', 'secondary', 'supporting'].includes(priority)) throw new Error(`不支持的信息优先级：${priority}`)
    return {
      id: text(item.id, 'component.id'), name: text(item.name, 'component.name'), pageId: text(item.pageId, 'component.pageId'),
      section: text(item.section, 'component.section'), kind: text(item.kind, 'component.kind'), purpose: text(item.purpose, 'component.purpose'),
      informationPriority: priority, sourceCapabilityIds: strings(item.sourceCapabilityIds, 'component.sourceCapabilityIds'),
      sourceFlowNodeIds: strings(item.sourceFlowNodeIds, 'component.sourceFlowNodeIds'), sourceScenarioIds: strings(item.sourceScenarioIds, 'component.sourceScenarioIds')
    }
  })
  const actions = objects(value.actions, 'actions', (item): InteractionAction => {
    const priority = text(item.priority, 'action.priority') as InteractionAction['priority']
    if (!priorities.has(priority)) throw new Error(`不支持的操作优先级：${priority}`)
    return {
      id: text(item.id, 'action.id'), name: text(item.name, 'action.name'), componentId: text(item.componentId, 'action.componentId'),
      priority, trigger: text(item.trigger, 'action.trigger'), preconditions: strings(item.preconditions, 'action.preconditions'),
      result: text(item.result, 'action.result'), feedbackIds: strings(item.feedbackIds, 'action.feedbackIds'),
      sourceCapabilityIds: strings(item.sourceCapabilityIds, 'action.sourceCapabilityIds'), sourceFlowNodeIds: strings(item.sourceFlowNodeIds, 'action.sourceFlowNodeIds'),
      sourceScenarioIds: strings(item.sourceScenarioIds, 'action.sourceScenarioIds')
    }
  })
  const states = objects(value.states, 'states', (item): InteractionState => {
    const kind = text(item.kind, 'state.kind') as InteractionState['kind']
    if (!stateKinds.has(kind)) throw new Error(`不支持的交互状态：${kind}`)
    return {
      id: text(item.id, 'state.id'), name: text(item.name, 'state.name'), componentId: text(item.componentId, 'state.componentId'), kind,
      description: text(item.description, 'state.description'), visibleInformation: strings(item.visibleInformation, 'state.visibleInformation'),
      availableActionIds: strings(item.availableActionIds, 'state.availableActionIds'), reason: nullableText(item.reason, 'state.reason')
    }
  })
  const transitions = objects(value.transitions, 'transitions', (item): InteractionTransition => ({
    id: text(item.id, 'transition.id'), fromStateId: text(item.fromStateId, 'transition.fromStateId'),
    toStateId: text(item.toStateId, 'transition.toStateId'), trigger: text(item.trigger, 'transition.trigger'),
    userActionId: nullableText(item.userActionId, 'transition.userActionId'), systemFeedback: text(item.systemFeedback, 'transition.systemFeedback'),
    recovery: nullableText(item.recovery, 'transition.recovery')
  }))
  const feedback = objects(value.feedback, 'feedback', (item): InteractionFeedback => {
    const type = text(item.type, 'feedback.type') as InteractionFeedback['type']
    if (!feedbackTypes.has(type)) throw new Error(`不支持的反馈类型：${type}`)
    return { id: text(item.id, 'feedback.id'), trigger: text(item.trigger, 'feedback.trigger'), type, message: text(item.message, 'feedback.message'), behavior: text(item.behavior, 'feedback.behavior') }
  })
  const interactionRules = objects(value.interactionRules, 'interactionRules', (item): InteractionRule => ({
    id: text(item.id, 'rule.id'), trigger: text(item.trigger, 'rule.trigger'), condition: text(item.condition, 'rule.condition'),
    uiBehavior: text(item.uiBehavior, 'rule.uiBehavior'), userAction: text(item.userAction, 'rule.userAction'),
    systemFeedback: text(item.systemFeedback, 'rule.systemFeedback'), result: text(item.result, 'rule.result'),
    relatedCapabilityIds: strings(item.relatedCapabilityIds, 'rule.relatedCapabilityIds'), relatedFlowNodeIds: strings(item.relatedFlowNodeIds, 'rule.relatedFlowNodeIds')
  }))
  const userPaths = objects(value.userPaths, 'userPaths', (item): InteractionUserPath => ({
    id: text(item.id, 'path.id'), name: text(item.name, 'path.name'), steps: strings(item.steps, 'path.steps'),
    sourceCapabilityIds: strings(item.sourceCapabilityIds, 'path.sourceCapabilityIds'), sourceFlowNodeIds: strings(item.sourceFlowNodeIds, 'path.sourceFlowNodeIds'),
    sourceScenarioIds: strings(item.sourceScenarioIds, 'path.sourceScenarioIds')
  }))
  const decisions = objects(value.decisions, 'decisions', (item): InteractionDecisionCandidate => ({
    id: text(item.id, 'decision.id'), question: text(item.question, 'decision.question'),
    options: objects(item.options, 'decision.options', (option) => ({
      name: text(option.name, 'option.name'), benefit: text(option.benefit, 'option.benefit'), cost: text(option.cost, 'option.cost'), impact: text(option.impact, 'option.impact')
    })), affectedElementIds: strings(item.affectedElementIds, 'decision.affectedElementIds')
  }))
  const semantic = record(value.semanticChecks, 'semanticChecks')
  const sourceAnalysisStatus = text(value.sourceAnalysisStatus, 'sourceAnalysisStatus')
  const sourceFlowStatus = text(value.sourceFlowStatus, 'sourceFlowStatus')
  const sourceSolutionStatus = text(value.sourceSolutionStatus, 'sourceSolutionStatus')
  for (const sourceStatus of [sourceAnalysisStatus, sourceFlowStatus, sourceSolutionStatus]) {
    if (!['confirmed', 'draft'].includes(sourceStatus)) throw new Error('上游来源状态必须是 confirmed 或 draft。')
  }
  return {
    id: text(value.id, 'id'), name: text(value.name, 'name'), overview: text(value.overview, 'overview'), status,
    surfaces, pages, components, actions, states, transitions, feedback, interactionRules, userPaths, decisions,
    openQuestions: strings(value.openQuestions, 'openQuestions'), solutionConflicts: strings(value.solutionConflicts, 'solutionConflicts'),
    flowConflicts: strings(value.flowConflicts, 'flowConflicts'), uiReferencePaths: strings(value.uiReferencePaths, 'uiReferencePaths'),
    semanticChecks: {
      mainScenariosCompletable: bool(semantic.mainScenariosCompletable, 'semanticChecks.mainScenariosCompletable'),
      noDeadEnds: bool(semantic.noDeadEnds, 'semanticChecks.noDeadEnds'),
      errorsHaveFeedback: bool(semantic.errorsHaveFeedback, 'semanticChecks.errorsHaveFeedback'),
      recoveryExists: bool(semantic.recoveryExists, 'semanticChecks.recoveryExists'),
      crossPageContextPreserved: bool(semantic.crossPageContextPreserved, 'semanticChecks.crossPageContextPreserved'),
      cognitiveLoadAcceptable: bool(semantic.cognitiveLoadAcceptable, 'semanticChecks.cognitiveLoadAcceptable')
    },
    sourceAnalysisPath: text(value.sourceAnalysisPath, 'sourceAnalysisPath'), sourceAnalysisStatus: sourceAnalysisStatus as 'confirmed' | 'draft',
    sourceFlowPath: text(value.sourceFlowPath, 'sourceFlowPath'), sourceFlowStatus: sourceFlowStatus as 'confirmed' | 'draft',
    sourceSolutionPath: text(value.sourceSolutionPath, 'sourceSolutionPath'), sourceSolutionStatus: sourceSolutionStatus as 'confirmed' | 'draft',
    confirmedAt: nullableText(value.confirmedAt, 'confirmedAt')
  }
}

function duplicates(values: string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))]
}

export function interactionDesignReadiness(model: InteractionDesignModel, sourceCapabilityIds: string[] = [], sourceFlowNodeIds: string[] = []): InteractionDesignReadiness {
  const missing: string[] = []
  const warnings: string[] = []
  const ids = [...model.surfaces, ...model.pages, ...model.components, ...model.actions, ...model.states, ...model.transitions, ...model.feedback, ...model.interactionRules, ...model.userPaths].map((item) => item.id)
  for (const duplicate of duplicates(ids)) missing.push(`duplicate_id:${duplicate}`)
  const surfaceIds = new Set(model.surfaces.map((item) => item.id))
  const pageIds = new Set(model.pages.map((item) => item.id))
  const componentIds = new Set(model.components.map((item) => item.id))
  const actionIds = new Set(model.actions.map((item) => item.id))
  const stateIds = new Set(model.states.map((item) => item.id))
  const feedbackIds = new Set(model.feedback.map((item) => item.id))
  const sourceCapabilitySet = new Set(sourceCapabilityIds)
  const sourceFlowNodeSet = new Set(sourceFlowNodeIds)
  if (!model.surfaces.length) missing.push('surfaces_missing')
  if (!model.pages.length) missing.push('pages_missing')
  if (!model.components.length) missing.push('components_missing')
  if (!model.actions.length) missing.push('actions_missing')
  if (!model.userPaths.length) missing.push('user_paths_missing')
  for (const page of model.pages) {
    if (!surfaceIds.has(page.surfaceId)) missing.push(`page_surface_reference:${page.id}:${page.surfaceId}`)
    if (!page.entryPoints.length) missing.push(`page_entry_missing:${page.id}`)
  }
  for (const component of model.components) if (!pageIds.has(component.pageId)) missing.push(`component_page_reference:${component.id}:${component.pageId}`)
  for (const action of model.actions) {
    if (!componentIds.has(action.componentId)) missing.push(`action_component_reference:${action.id}:${action.componentId}`)
    if (!action.sourceCapabilityIds.length) missing.push(`action_capability_trace_missing:${action.id}`)
    for (const id of action.feedbackIds) if (!feedbackIds.has(id)) missing.push(`action_feedback_reference:${action.id}:${id}`)
  }
  for (const state of model.states) {
    if (!componentIds.has(state.componentId)) missing.push(`state_component_reference:${state.id}:${state.componentId}`)
    for (const id of state.availableActionIds) if (!actionIds.has(id)) missing.push(`state_action_reference:${state.id}:${id}`)
    if (state.kind === 'disabled' && !state.reason) missing.push(`disabled_reason_missing:${state.id}`)
  }
  for (const transition of model.transitions) {
    if (!stateIds.has(transition.fromStateId) || !stateIds.has(transition.toStateId)) missing.push(`transition_state_reference:${transition.id}`)
    if (transition.userActionId && !actionIds.has(transition.userActionId)) missing.push(`transition_action_reference:${transition.id}:${transition.userActionId}`)
    const target = model.states.find((state) => state.id === transition.toStateId)
    if (target?.kind === 'error' && !transition.recovery) missing.push(`error_recovery_missing:${transition.id}`)
  }
  if (sourceCapabilityIds.length) {
    const covered = new Set([
      ...model.surfaces.flatMap((item) => item.sourceCapabilityIds), ...model.pages.flatMap((item) => item.sourceCapabilityIds),
      ...model.components.flatMap((item) => item.sourceCapabilityIds), ...model.actions.flatMap((item) => item.sourceCapabilityIds)
    ])
    for (const id of sourceCapabilityIds) if (!covered.has(id)) missing.push(`capability_unplaced:${id}`)
  }
  const traced = [...model.surfaces, ...model.pages, ...model.components, ...model.actions].flatMap((item) => item.sourceCapabilityIds)
  const ruleCapabilities = model.interactionRules.flatMap((item) => item.relatedCapabilityIds)
  const pathCapabilities = model.userPaths.flatMap((item) => item.sourceCapabilityIds)
  if (sourceCapabilitySet.size) for (const id of [...traced, ...ruleCapabilities, ...pathCapabilities]) {
    if (!sourceCapabilitySet.has(id)) missing.push(`unknown_capability_reference:${id}`)
  }
  const flowReferences = [
    ...model.pages.flatMap((item) => item.sourceFlowNodeIds), ...model.components.flatMap((item) => item.sourceFlowNodeIds),
    ...model.actions.flatMap((item) => item.sourceFlowNodeIds), ...model.interactionRules.flatMap((item) => item.relatedFlowNodeIds),
    ...model.userPaths.flatMap((item) => item.sourceFlowNodeIds)
  ]
  if (sourceFlowNodeSet.size) for (const id of flowReferences) if (!sourceFlowNodeSet.has(id)) missing.push(`unknown_flow_reference:${id}`)
  if (model.status === 'WAITING_CLARIFICATION' && !model.openQuestions.length && !model.decisions.length && !model.solutionConflicts.length && !model.flowConflicts.length) missing.push('clarification_reason_missing')
  if (model.status === 'READY_FOR_CONFIRMATION') {
    if (model.openQuestions.length) missing.push('blocking_open_questions')
    if (model.decisions.length) missing.push('unresolved_decisions')
    if (model.solutionConflicts.length) missing.push('solution_conflicts')
    if (model.flowConflicts.length) missing.push('flow_conflicts')
  }
  for (const [key, passed] of Object.entries(model.semanticChecks)) if (!passed) missing.push(`semantic:${key}`)
  if (!model.uiReferencePaths.length) warnings.push('ui_reference_not_available')
  return {
    deterministicPassed: missing.length === 0,
    semanticReady: Object.values(model.semanticChecks).every(Boolean),
    missing: [...new Set(missing)], warnings: [...new Set(warnings)]
  }
}

function list(values: string[]): string { return values.length ? values.map((item) => `- ${item}`).join('\n') : '—' }

export function renderInteractionDesignMarkdown(model: InteractionDesignModel): string {
  const surfaces = model.surfaces.map((item) => `- **${item.name}**（${item.type}${item.existing ? '，Existing' : ''}）：${item.purpose}；Capabilities：${item.sourceCapabilityIds.join('、') || '—'}`)
  const pages = model.pages.map((item) => `### ${item.id} · ${item.name}\n\n- Surface：${item.surfaceId}\n- Purpose：${item.purpose}\n- Sections：${item.sections.join('；') || '—'}\n- Entry：${item.entryPoints.join('；') || '—'}\n- Trace：Capability ${item.sourceCapabilityIds.join('、') || '—'}；Flow ${item.sourceFlowNodeIds.join('、') || '—'}；Scenario ${item.sourceScenarioIds.join('、') || '—'}`)
  const paths = model.userPaths.map((item) => `### ${item.id} · ${item.name}\n\n${item.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`)
  const components = model.components.map((item) => `- **${item.id} · ${item.name}**：${item.pageId} / ${item.section}；${item.kind}；${item.informationPriority}；${item.purpose}`)
  const actions = model.actions.map((item) => `- **${item.id} · ${item.name}**（${item.priority}）：入口 ${item.trigger}；前置 ${item.preconditions.join('；') || '—'}；结果 ${item.result}`)
  const states = model.states.map((item) => `- **${item.id} · ${item.name}**（${item.kind}）：${item.description}${item.reason ? `；原因：${item.reason}` : ''}`)
  const transitions = model.transitions.map((item) => `- **${item.id}**：${item.fromStateId} → ${item.toStateId}；触发：${item.trigger}；反馈：${item.systemFeedback}${item.recovery ? `；恢复：${item.recovery}` : ''}`)
  const feedback = model.feedback.map((item) => `- **${item.id}**（${item.type}）：${item.trigger} → ${item.message}；${item.behavior}`)
  const rules = model.interactionRules.map((item) => `### ${item.id}\n\n- Trigger：${item.trigger}\n- Condition：${item.condition}\n- UI Behavior：${item.uiBehavior}\n- User Action：${item.userAction}\n- System Feedback：${item.systemFeedback}\n- Result：${item.result}\n- Trace：Capability ${item.relatedCapabilityIds.join('、') || '—'}；Flow ${item.relatedFlowNodeIds.join('、') || '—'}`)
  const decisions = model.decisions.map((item) => `### ${item.id} · ${item.question}\n\n${item.options.map((option) => `- **${option.name}**：Benefit ${option.benefit}；Cost ${option.cost}；Impact ${option.impact}`).join('\n')}`)
  return `# Interaction Design｜${model.name}\n\n- Interaction Status：${model.status.toLowerCase()}\n- Source Analysis：${model.sourceAnalysisPath} (${model.sourceAnalysisStatus})\n- Source Business Flow：${model.sourceFlowPath} (${model.sourceFlowStatus})\n- Source Solution：${model.sourceSolutionPath} (${model.sourceSolutionStatus})\n\n## Interaction Overview\n\n${model.overview}\n\n## Product Surfaces\n\n${surfaces.join('\n') || '—'}\n\n## Page / Section Structure\n\n${pages.join('\n\n') || '—'}\n\n## Main User Paths\n\n${paths.join('\n\n') || '—'}\n\n## Key Components\n\n${components.join('\n') || '—'}\n\n## Actions\n\n${actions.join('\n') || '—'}\n\n## States\n\n${states.join('\n') || '—'}\n\n## Transitions & Recovery\n\n${transitions.join('\n') || '—'}\n\n## Feedback\n\n${feedback.join('\n') || '—'}\n\n## Interaction Rules\n\n${rules.join('\n\n') || '—'}\n\n## UI References\n\n${list(model.uiReferencePaths)}\n\n## Decisions\n\n${decisions.join('\n\n') || '—'}\n\n## Open Questions\n\n${list(model.openQuestions)}\n\n## Solution Conflicts\n\n${list(model.solutionConflicts)}\n\n## Flow Conflicts\n\n${list(model.flowConflicts)}\n`
}
