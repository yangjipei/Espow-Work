import type { AnalysisSlotStatus } from './analysisState'

export type LifecycleStageId =
  | 'requirement-analysis'
  | 'business-flow'
  | 'solution-design'
  | 'interaction-design'
  | 'prototype'
  | 'product-spec'
  | 'requirement-review'

export type LifecycleStageStatus =
  | 'not_started'
  | 'in_progress'
  | 'ready_for_confirmation'
  | 'confirmed'
  | 'stale'
  | 'blocked'
  | 'not_applicable'

export interface StageDecisionState {
  id: string
  topic: string
  decision: string
  reason: string
  status: AnalysisSlotStatus
}

export interface StageQuestionState {
  id: string
  topic: string
  question: string
  priority: 'blocking' | 'non_blocking'
  reason: string
  status: 'open' | 'deferred' | 'resolved' | 'superseded' | 'closed'
  type?: 'BLOCKING' | 'NON_BLOCKING' | 'DEFERRED' | 'CLOSED'
  targetStage?: LifecycleStageId
}

export interface StageConflictState {
  id: string
  topic: string
  description: string
  sourceStageIds: LifecycleStageId[]
  blocking: boolean
  status: 'open' | 'resolved'
}

export interface SharedRequirementState {
  schemaVersion: 1
  workspaceId: string
  requirementId: string
  version: number
  name: string
  goal: string
  actors: string[]
  systems: string[]
  scope: { included: string[]; excluded: string[] }
  constraints: string[]
  globalDecisions: string[]
  source: 'new' | 'derived' | 'migrated'
  updatedAt: string
}

export interface RequirementAnalysisStageSlots {
  problem: string[]
  scenarios: string[]
  goals: string[]
  mainFlow: string[]
  rules: string[]
  scope: string[]
  impacts: string[]
}

export interface BusinessFlowStageSlots {
  actors: string[]
  entry: string[]
  mainFlow: string[]
  decisionNodes: string[]
  branches: string[]
  exits: string[]
  failurePaths: string[]
  systemBoundaries: string[]
}

export interface SolutionDesignStageSlots {
  capabilities: string[]
  scope: string[]
  rules: string[]
  states: string[]
  dataObjects: string[]
  recoveries: string[]
  productSurfaces: string[]
  traceability: string[]
}

export interface InteractionDesignStageSlots {
  surfaces: string[]
  pages: string[]
  components: string[]
  actions: string[]
  states: string[]
  transitions: string[]
  feedback: string[]
  permissions: string[]
  exceptions: string[]
  userPaths: string[]
}

export interface PrototypeStageSlots {
  pages: string[]
  components: string[]
  layout: string[]
  interactions: string[]
  dataBindings: string[]
  states: string[]
  responsive: string[]
  uiBaseline: string[]
}

export interface ProductSpecStageSlots {
  functionalRequirements: string[]
  businessRules: string[]
  fields: string[]
  stateMachine: string[]
  permissions: string[]
  exceptions: string[]
  compatibility: string[]
  dependencies: string[]
  acceptanceCriteria: string[]
}

export interface RequirementReviewStageSlots {
  blockers: string[]
  ambiguities: string[]
  missingRules: string[]
  technicalDependencies: string[]
  dataGaps: string[]
  exceptionGaps: string[]
  acceptanceGaps: string[]
  recommendedActions: string[]
}

export type LifecycleStageSlots =
  | RequirementAnalysisStageSlots
  | BusinessFlowStageSlots
  | SolutionDesignStageSlots
  | InteractionDesignStageSlots
  | PrototypeStageSlots
  | ProductSpecStageSlots
  | RequirementReviewStageSlots

export interface StageReadinessState {
  status: 'NOT_READY' | 'READY_TO_CONFIRM' | 'COMPLETED'
  checks: Record<string, boolean>
  blockingQuestions: number
  blockingConflicts: number
  readyForConfirmation: boolean
}

export interface LifecycleStageState<TSlots extends LifecycleStageSlots = LifecycleStageSlots> {
  schemaVersion: 1
  workspaceId: string
  requirementId: string
  stageId: LifecycleStageId
  version: number
  source: 'new' | 'derived' | 'migrated' | 'runtime'
  status: LifecycleStageStatus
  slots: TSlots
  decisions: StageDecisionState[]
  openQuestions: StageQuestionState[]
  conflicts: StageConflictState[]
  readiness: StageReadinessState
  artifactRefs: string[]
  upstreamVersions: Partial<Record<LifecycleStageId, number>>
  staleReason: string | null
  changedPaths: string[]
  updatedAt: string
}

export interface StageWorkingState {
  stageId: LifecycleStageId
  version: number
  status: LifecycleStageStatus
  projection: string
  readiness: StageReadinessState
  fullStateChars: number
}

export const lifecycleStageOrder: LifecycleStageId[] = [
  'requirement-analysis',
  'business-flow',
  'solution-design',
  'interaction-design',
  'prototype',
  'product-spec',
  'requirement-review'
]
