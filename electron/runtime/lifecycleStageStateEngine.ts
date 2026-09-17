import type { AnalysisState } from '../../src/analysisState'
import type {
  BusinessFlowModel,
  InteractionDesignModel,
  ProductSpecModel,
  PrototypeMetadata,
  RequirementReviewModel,
  SolutionDesignModel
} from '../../src/skills'
import type {
  BusinessFlowStageSlots,
  InteractionDesignStageSlots,
  LifecycleStageId,
  LifecycleStageSlots,
  LifecycleStageState,
  ProductSpecStageSlots,
  PrototypeStageSlots,
  RequirementAnalysisStageSlots,
  RequirementReviewStageSlots,
  SharedRequirementState,
  SolutionDesignStageSlots,
  StageReadinessState
} from '../../src/lifecycleStageState'
import { lifecycleStageOrder } from '../../src/lifecycleStageState'

function now(): string { return new Date().toISOString() }
function uniq(values: string[]): string[] { return [...new Set(values.map((item) => item.trim()).filter(Boolean))] }
function has(values: string[]): boolean { return values.length > 0 }
function compact(values: string[], max = 8): string { return values.slice(0, max).join('；') || '—' }

export function createSharedRequirementState(input: {
  workspaceId: string
  requirementId: string
  name: string
  goal?: string
}): SharedRequirementState {
  return {
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    requirementId: input.requirementId,
    version: 1,
    name: input.name,
    goal: input.goal ?? '',
    actors: [], systems: [], scope: { included: [], excluded: [] }, constraints: [], globalDecisions: [],
    source: 'new', updatedAt: now()
  }
}

export function sharedStateFromAnalysis(base: SharedRequirementState, analysis: AnalysisState): SharedRequirementState {
  const next: SharedRequirementState = JSON.parse(JSON.stringify(base)) as SharedRequirementState
  next.version += 1
  next.goal = analysis.goals.businessGoals[0] ?? analysis.goals.systemGoals[0] ?? analysis.goals.userGoals[0] ?? next.goal
  next.actors = uniq([...next.actors, ...analysis.scenarios.map((item) => item.actor)])
  next.systems = uniq([...next.systems, ...analysis.impact.systems])
  next.scope.included = uniq([...next.scope.included, ...analysis.scope.inScope])
  next.scope.excluded = uniq([...next.scope.excluded, ...analysis.scope.outOfScope])
  next.constraints = uniq([...next.constraints, ...analysis.scope.constraints])
  next.globalDecisions = uniq([...next.globalDecisions, ...analysis.decisions.filter((item) => item.status === 'confirmed').map((item) => item.decision)])
  next.source = 'derived'
  next.updatedAt = now()
  return next
}

function emptySlots(stageId: LifecycleStageId): LifecycleStageSlots {
  switch (stageId) {
    case 'requirement-analysis': return { problem: [], scenarios: [], goals: [], mainFlow: [], rules: [], scope: [], impacts: [] }
    case 'business-flow': return { actors: [], entry: [], mainFlow: [], decisionNodes: [], branches: [], exits: [], failurePaths: [], systemBoundaries: [] }
    case 'solution-design': return { capabilities: [], scope: [], rules: [], states: [], dataObjects: [], recoveries: [], productSurfaces: [], traceability: [] }
    case 'interaction-design': return { surfaces: [], pages: [], components: [], actions: [], states: [], transitions: [], feedback: [], permissions: [], exceptions: [], userPaths: [] }
    case 'prototype': return { pages: [], components: [], layout: [], interactions: [], dataBindings: [], states: [], responsive: [], uiBaseline: [] }
    case 'product-spec': return { functionalRequirements: [], businessRules: [], fields: [], stateMachine: [], permissions: [], exceptions: [], compatibility: [], dependencies: [], acceptanceCriteria: [] }
    case 'requirement-review': return { blockers: [], ambiguities: [], missingRules: [], technicalDependencies: [], dataGaps: [], exceptionGaps: [], acceptanceGaps: [], recommendedActions: [] }
  }
}

function readiness(stageId: LifecycleStageId, slots: LifecycleStageSlots, blockingQuestions = 0, blockingConflicts = 0): StageReadinessState {
  let checks: Record<string, boolean>
  switch (stageId) {
    case 'requirement-analysis': {
      const value = slots as RequirementAnalysisStageSlots
      checks = { problemClear: has(value.problem), goalClear: has(value.goals), scenarioClear: has(value.scenarios), mainFlowClear: has(value.mainFlow), rulesClear: has(value.rules), scopeClear: has(value.scope) }
      break
    }
    case 'business-flow': {
      const value = slots as BusinessFlowStageSlots
      checks = { actorsClear: has(value.actors), entryClear: has(value.entry), mainFlowClear: has(value.mainFlow), branchesClear: has(value.branches) || has(value.decisionNodes), exitsClear: has(value.exits), failuresClear: has(value.failurePaths) || has(value.exits), boundariesClear: has(value.systemBoundaries) }
      break
    }
    case 'solution-design': {
      const value = slots as SolutionDesignStageSlots
      checks = { capabilitiesClear: has(value.capabilities), scopeClear: has(value.scope), rulesClear: has(value.rules), statesClear: has(value.states) || has(value.capabilities), dataClear: has(value.dataObjects) || has(value.capabilities), recoveryClear: has(value.recoveries), surfacesClear: has(value.productSurfaces), traceabilityClear: has(value.traceability) }
      break
    }
    case 'interaction-design': {
      const value = slots as InteractionDesignStageSlots
      checks = { surfacesClear: has(value.surfaces), pagesClear: has(value.pages), actionsClear: has(value.actions), statesClear: has(value.states), transitionsClear: has(value.transitions), feedbackClear: has(value.feedback), userPathsClear: has(value.userPaths), exceptionsClear: has(value.exceptions) || has(value.feedback) }
      break
    }
    case 'prototype': {
      const value = slots as PrototypeStageSlots
      checks = { pagesClear: has(value.pages) || has(value.components), componentsClear: has(value.components), interactionsClear: has(value.interactions), statesClear: has(value.states), baselineClear: has(value.uiBaseline) }
      break
    }
    case 'product-spec': {
      const value = slots as ProductSpecStageSlots
      checks = { functionsClear: has(value.functionalRequirements), rulesClear: has(value.businessRules), fieldsClear: has(value.fields), statesClear: has(value.stateMachine), exceptionsClear: has(value.exceptions), acceptanceClear: has(value.acceptanceCriteria) }
      break
    }
    case 'requirement-review': {
      const value = slots as RequirementReviewStageSlots
      checks = { blockersReviewed: true, ambiguitiesReviewed: true, rulesReviewed: true, dependenciesReviewed: true, dataReviewed: true, exceptionsReviewed: true, acceptanceReviewed: true, actionsClear: has(value.recommendedActions) || !has(value.blockers) }
      break
    }
  }
  const readyForConfirmation = Object.values(checks).every(Boolean) && blockingQuestions === 0 && blockingConflicts === 0
  return { status: readyForConfirmation ? 'READY_TO_CONFIRM' : 'NOT_READY', checks, blockingQuestions, blockingConflicts, readyForConfirmation }
}

export function applyStageSlotUpdates(
  state: LifecycleStageState,
  updates: Array<{ slotId: string; values: string[] }>
): LifecycleStageState {
  const next = JSON.parse(JSON.stringify(state)) as LifecycleStageState
  for (const update of updates) {
    if (!Object.prototype.hasOwnProperty.call(next.slots, update.slotId)) throw new Error(`未知生命周期槽位：${state.stageId}.${update.slotId}`)
    ;(next.slots as unknown as Record<string, string[]>)[update.slotId] = uniq(update.values)
    next.openQuestions = next.openQuestions.map((question) => question.topic === update.slotId && question.status === 'open'
      ? { ...question, status: 'resolved' as const }
      : question)
  }
  next.version += 1
  next.source = 'runtime'
  next.readiness = readiness(
    next.stageId,
    next.slots,
    next.openQuestions.filter((item) => item.priority === 'blocking' && item.status === 'open').length,
    next.conflicts.filter((item) => item.blocking && item.status === 'open').length
  )
  next.status = next.readiness.readyForConfirmation ? 'ready_for_confirmation' : 'in_progress'
  next.staleReason = null
  next.changedPaths = updates.map((update) => `/slots/${update.slotId}`)
  next.updatedAt = now()
  return next
}

export function createStageState(workspaceId: string, requirementId: string, stageId: LifecycleStageId): LifecycleStageState {
  const slots = emptySlots(stageId)
  return {
    schemaVersion: 1, workspaceId, requirementId, stageId, version: 1, source: 'new', status: 'not_started',
    slots, decisions: [], openQuestions: [], conflicts: [], readiness: readiness(stageId, slots), artifactRefs: [], upstreamVersions: {},
    staleReason: null, changedPaths: [], updatedAt: now()
  }
}

export function stageStateFromAnalysis(workspaceId: string, requirementId: string, analysis: AnalysisState): LifecycleStageState<RequirementAnalysisStageSlots> {
  const slots: RequirementAnalysisStageSlots = {
    problem: uniq([analysis.problem.trigger.value, analysis.problem.currentProblem.value, analysis.problem.rootCause.value, analysis.problem.businessImpact.value, analysis.problem.currentWorkaround.value]),
    scenarios: analysis.scenarios.map((item) => `${item.scenarioId} ${item.actor}：${item.trigger} → ${item.expectedOutcome}`),
    goals: uniq([...analysis.goals.businessGoals, ...analysis.goals.userGoals, ...analysis.goals.systemGoals, ...analysis.goals.successCriteria]),
    mainFlow: analysis.flow.mainFlow,
    rules: analysis.rules.map((item) => `${item.ruleId} ${item.subject}｜${item.condition}｜${item.action}`),
    scope: uniq([...analysis.scope.inScope.map((item) => `IN:${item}`), ...analysis.scope.outOfScope.map((item) => `OUT:${item}`), ...analysis.scope.constraints.map((item) => `CONSTRAINT:${item}`)]),
    impacts: uniq([...analysis.impact.systems, ...analysis.impact.upstream, ...analysis.impact.downstream, ...analysis.impact.externalServices])
  }
  const openQuestions = analysis.openQuestions.map((item) => ({ ...item }))
  const state: LifecycleStageState<RequirementAnalysisStageSlots> = {
    schemaVersion: 1, workspaceId, requirementId, stageId: 'requirement-analysis', version: analysis.version, source: analysis.source === 'new' ? 'new' : 'derived',
    status: analysis.readiness.readyForConfirmation ? 'ready_for_confirmation' : 'in_progress', slots,
    decisions: analysis.decisions.map((item) => ({ ...item })), openQuestions, conflicts: [],
    readiness: readiness('requirement-analysis', slots, analysis.readiness.blockingQuestions, 0), artifactRefs: ['analysis/requirement-analysis.md'], upstreamVersions: {},
    staleReason: null, changedPaths: analysis.changedPaths, updatedAt: analysis.updatedAt
  }
  return state
}

export function stageStateFromBusinessFlow(workspaceId: string, requirementId: string, model: BusinessFlowModel, artifactRefs: string[] = []): LifecycleStageState<BusinessFlowStageSlots> {
  const slots: BusinessFlowStageSlots = {
    actors: model.actors.map((item) => `${item.id} ${item.name}(${item.role})`),
    entry: uniq([model.entry]),
    mainFlow: model.nodes.filter((item) => item.type !== 'decision' && item.type !== 'end').map((item) => `${item.id} ${item.title}`),
    decisionNodes: model.nodes.filter((item) => item.type === 'decision').map((item) => `${item.id} ${item.title}`),
    branches: model.edges.filter((item) => item.type === 'branch').map((item) => `${item.from} → ${item.to}：${item.label}`),
    exits: model.exits.map((item) => `${item.nodeId}：${item.condition} / ${item.stateImpact}`),
    failurePaths: model.edges.filter((item) => item.type === 'exception' || item.type === 'recovery').map((item) => `${item.type}:${item.from}→${item.to} ${item.label}`),
    systemBoundaries: model.nodes.filter((item) => item.type === 'system').map((item) => `${item.id} ${item.title}`)
  }
  return stageFromSlots(workspaceId, requirementId, 'business-flow', slots, model.status, model.openQuestions, artifactRefs)
}

export function stageStateFromSolution(workspaceId: string, requirementId: string, model: SolutionDesignModel, artifactRefs: string[] = []): LifecycleStageState<SolutionDesignStageSlots> {
  const slots: SolutionDesignStageSlots = {
    capabilities: model.capabilities.map((item) => `${item.id} ${item.name}`), scope: uniq([...model.scope.included.map((item) => `IN:${item}`), ...model.scope.excluded.map((item) => `OUT:${item}`)]),
    rules: model.rules.map((item) => `${item.id} ${item.description}`), states: model.states.map((item) => `${item.id} ${item.name}`), dataObjects: model.dataObjects.map((item) => `${item.id} ${item.name}`),
    recoveries: model.recoveries.map((item) => `${item.exception} → ${item.behavior}`), productSurfaces: model.productSurfaces.map((item) => `${item.id} ${item.name}`),
    traceability: model.capabilities.flatMap((item) => item.relatedFlowNodeIds.map((id) => `${item.id}←${id}`))
  }
  const state = stageFromSlots(workspaceId, requirementId, 'solution-design', slots, model.status, model.openQuestions, artifactRefs)
  state.conflicts = model.flowConflicts.map((description, index) => ({ id: `C${index + 1}`, topic: 'flow', description, sourceStageIds: ['business-flow'], blocking: true, status: 'open' }))
  state.readiness = readiness('solution-design', slots, state.openQuestions.filter((item) => item.priority === 'blocking' && item.status === 'open').length, state.conflicts.length)
  return state
}

export function stageStateFromInteraction(workspaceId: string, requirementId: string, model: InteractionDesignModel, artifactRefs: string[] = []): LifecycleStageState<InteractionDesignStageSlots> {
  const slots: InteractionDesignStageSlots = {
    surfaces: model.surfaces.map((item) => `${item.id} ${item.name}`), pages: model.pages.map((item) => `${item.id} ${item.name}`), components: model.components.map((item) => `${item.id} ${item.name}`),
    actions: model.actions.map((item) => `${item.id} ${item.name}`), states: model.states.map((item) => `${item.id} ${item.name}`), transitions: model.transitions.map((item) => `${item.fromStateId}→${item.toStateId}:${item.trigger}`),
    feedback: model.feedback.map((item) => `${item.type}:${item.message}`), permissions: [], exceptions: model.feedback.filter((item) => /error|失败|异常/i.test(`${item.trigger} ${item.type} ${item.message}`)).map((item) => item.message),
    userPaths: model.userPaths.map((item) => `${item.id} ${item.name}`)
  }
  const state = stageFromSlots(workspaceId, requirementId, 'interaction-design', slots, model.status, model.openQuestions, artifactRefs)
  state.conflicts = [...model.solutionConflicts.map((description, index) => ({ id: `SC${index + 1}`, topic: 'solution', description, sourceStageIds: ['solution-design'] as LifecycleStageId[], blocking: true, status: 'open' as const })),
    ...model.flowConflicts.map((description, index) => ({ id: `FC${index + 1}`, topic: 'flow', description, sourceStageIds: ['business-flow'] as LifecycleStageId[], blocking: true, status: 'open' as const }))]
  state.readiness = readiness('interaction-design', slots, state.openQuestions.length, state.conflicts.length)
  return state
}

export function stageStateFromPrototype(workspaceId: string, requirementId: string, model: PrototypeMetadata, artifactRefs: string[] = []): LifecycleStageState<PrototypeStageSlots> {
  const slots: PrototypeStageSlots = {
    pages: uniq([model.productSurface]), components: uniq([...model.addedComponents, ...model.changedComponents]), layout: [], interactions: model.interactionChanges,
    dataBindings: [], states: model.stateChanges, responsive: [], uiBaseline: model.uiReferencePaths
  }
  const state = stageFromSlots(workspaceId, requirementId, 'prototype', slots, model.status, model.openQuestions, artifactRefs)
  state.conflicts = model.interactionConflicts.map((description, index) => ({ id: `IC${index + 1}`, topic: 'interaction', description, sourceStageIds: ['interaction-design'], blocking: true, status: 'open' }))
  state.readiness = readiness('prototype', slots, state.openQuestions.length, state.conflicts.length)
  return state
}

export function stageStateFromProductSpec(workspaceId: string, requirementId: string, model: ProductSpecModel, artifactRefs: string[] = []): LifecycleStageState<ProductSpecStageSlots> {
  const slots: ProductSpecStageSlots = {
    functionalRequirements: model.capabilities.map((item) => `${item.id} ${item.name}`), businessRules: model.rules.map((item) => `${item.id} ${item.description}`),
    fields: model.fields.map((item) => `${item.id} ${item.name}:${item.source}`), stateMachine: model.states.map((item) => `${item.id} ${item.name}`), permissions: model.permissions,
    exceptions: uniq([...model.failures.map((item) => `${item.id} ${item.condition}`), ...model.recoveries.map((item) => `${item.id} ${item.trigger}`)]), compatibility: model.scope.applicable,
    dependencies: model.externalDependencies, acceptanceCriteria: model.acceptanceCriteria.map((item) => `${item.id} ${item.when}`)
  }
  const state = stageFromSlots(workspaceId, requirementId, 'product-spec', slots, model.status, model.openIssues.map((item) => item.description), artifactRefs)
  state.conflicts = model.conflicts.map((item) => ({ id: item.id, topic: item.type, description: item.description, sourceStageIds: ['requirement-analysis', 'business-flow', 'solution-design', 'interaction-design'], blocking: true, status: 'open' }))
  state.readiness = readiness('product-spec', slots, state.openQuestions.length, state.conflicts.length)
  return state
}

export function stageStateFromReview(workspaceId: string, requirementId: string, model: RequirementReviewModel, artifactRefs: string[] = []): LifecycleStageState<RequirementReviewStageSlots> {
  const open = model.issues.filter((item) => item.status === 'OPEN')
  const slots: RequirementReviewStageSlots = {
    blockers: open.filter((item) => item.severity === 'BLOCKER').map((item) => `${item.id} ${item.title}`), ambiguities: open.filter((item) => /一致|歧义|冲突/i.test(`${item.title}${item.description}`)).map((item) => `${item.id} ${item.title}`),
    missingRules: open.filter((item) => item.category === 'Rule').map((item) => `${item.id} ${item.title}`), technicalDependencies: open.filter((item) => item.category === 'Dependency').map((item) => `${item.id} ${item.title}`),
    dataGaps: open.filter((item) => item.category === 'Data' || item.category === 'Field').map((item) => `${item.id} ${item.title}`), exceptionGaps: open.filter((item) => item.category === 'Exception' || item.category === 'Recovery').map((item) => `${item.id} ${item.title}`),
    acceptanceGaps: open.filter((item) => item.category === 'Acceptance').map((item) => `${item.id} ${item.title}`), recommendedActions: model.recommendedActions
  }
  const state = stageFromSlots(workspaceId, requirementId, 'requirement-review', slots, model.reviewStatus, model.openIssues, artifactRefs)
  state.status = model.reviewStatus === 'CONFIRMED' ? 'confirmed' : model.reviewStatus === 'READY_FOR_CONFIRMATION' ? 'ready_for_confirmation' : model.reviewStatus === 'STALE' ? 'stale' : 'in_progress'
  state.readiness = readiness('requirement-review', slots, 0, slots.blockers.length)
  return state
}

function stageFromSlots<T extends LifecycleStageSlots>(workspaceId: string, requirementId: string, stageId: LifecycleStageId, slots: T, sourceStatus: string, openQuestions: string[], artifactRefs: string[]): LifecycleStageState<T> {
  const questions = openQuestions.map((question, index) => ({ id: `Q${index + 1}`, topic: stageId, question, priority: 'blocking' as const, reason: '阶段结构化结果存在未决问题', status: 'open' as const }))
  const normalized = sourceStatus.toLowerCase()
  const status = normalized.includes('confirmed') ? 'confirmed' : normalized.includes('ready') ? 'ready_for_confirmation' : normalized.includes('waiting') ? 'blocked' : 'in_progress'
  return {
    schemaVersion: 1, workspaceId, requirementId, stageId, version: 1, source: 'runtime', status, slots, decisions: [], openQuestions: questions, conflicts: [],
    readiness: readiness(stageId, slots, questions.length, 0), artifactRefs: uniq(artifactRefs), upstreamVersions: {}, staleReason: null, changedPaths: ['/slots'], updatedAt: now()
  }
}

export function buildStageProjection(state: LifecycleStageState): string {
  const slotLines = Object.entries(state.slots).map(([key, value]) => `- ${key}: ${Array.isArray(value) ? compact(value as string[]) : String(value)}`)
  const open = state.openQuestions.filter((item) => item.status === 'open').slice(0, 5).map((item) => `- ${item.id} [${item.priority}] ${item.question}`)
  const conflicts = state.conflicts.filter((item) => item.status === 'open').slice(0, 5).map((item) => `- ${item.id} ${item.description}`)
  const checks = Object.entries(state.readiness.checks).map(([key, value]) => `${key}=${value ? 'ready' : 'missing'}`).join(', ')
  return [
    `[Stage State ${state.stageId} v${state.version}]`,
    `Status: ${state.status}`,
    '[Slots]', ...slotLines,
    ...(open.length ? ['[Open Questions]', ...open] : []),
    ...(conflicts.length ? ['[Conflicts]', ...conflicts] : []),
    `[Readiness] ${checks}; blockingQuestions=${state.readiness.blockingQuestions}; blockingConflicts=${state.readiness.blockingConflicts}; readyForConfirmation=${state.readiness.readyForConfirmation}`,
    state.staleReason ? `[Stale] ${state.staleReason}` : ''
  ].filter(Boolean).join('\n')
}

export function buildSharedProjection(state: SharedRequirementState): string {
  return [
    `[Shared Requirement State v${state.version}]`,
    `Name: ${state.name}`,
    `Goal: ${state.goal || '—'}`,
    `Actors: ${compact(state.actors)}`,
    `Systems: ${compact(state.systems)}`,
    `In Scope: ${compact(state.scope.included)}`,
    `Out of Scope: ${compact(state.scope.excluded)}`,
    `Constraints: ${compact(state.constraints)}`,
    `Global Decisions: ${compact(state.globalDecisions)}`
  ].join('\n')
}

export function markDownstreamStagesStale(states: LifecycleStageState[], changedStageId: LifecycleStageId, reason: string): LifecycleStageState[] {
  const changedIndex = lifecycleStageOrder.indexOf(changedStageId)
  return states.map((state) => {
    if (lifecycleStageOrder.indexOf(state.stageId) <= changedIndex || state.status === 'not_applicable') return state
    const next = JSON.parse(JSON.stringify(state)) as LifecycleStageState
    next.status = 'stale'
    next.version += 1
    next.staleReason = reason
    next.changedPaths = ['/status', '/staleReason']
    next.updatedAt = now()
    return next
  })
}

export function stageSummary(state: LifecycleStageState): string {
  return `${state.stageId}@v${state.version} [${state.status}] ${Object.entries(state.slots).map(([key, value]) => `${key}:${Array.isArray(value) ? (value as string[]).length : 1}`).join(', ')}`
}
