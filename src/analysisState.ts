export type AnalysisSlotStatus = 'unknown' | 'inferred' | 'open' | 'discussing' | 'confirmed' | 'conflicted' | 'not_applicable'
export type AnalysisQuestionPriority = 'blocking' | 'non_blocking'
export type AnalysisQuestionType = 'BLOCKING' | 'NON_BLOCKING' | 'DEFERRED' | 'CLOSED'
export type AnalysisQuestionStatus = 'open' | 'deferred' | 'resolved' | 'superseded' | 'closed'
export type AnalysisReadinessStatus = 'NOT_READY' | 'READY_TO_CONFIRM' | 'COMPLETED'
export type AnalysisSchemaStatus = 'missing' | 'proposed' | 'confirmed'
export type AnalysisRequirementType = 'workflow' | 'integration' | 'page_interaction' | 'decision_rule' | 'data_mapping' | 'account_permission'

export interface AnalysisMainlineSchema {
  version: number
  status: AnalysisSchemaStatus
  requirementTypes: AnalysisRequirementType[]
  modules: string[]
}

export interface AnalysisWorkingQuestion {
  id: string
  question: string
  options: Array<{ id: string; label: string }>
}

export interface AnalysisWorkingContext {
  currentTopic: string | null
  currentQuestion: AnalysisWorkingQuestion | null
}

export interface AnalysisModuleField {
  value: unknown
  status: 'confirmed' | 'inferred' | 'open'
  source: 'user' | 'agent' | 'source' | 'migration' | 'runtime'
  updatedAt: string
}

export interface AnalysisSlot<T> {
  value: T
  status: AnalysisSlotStatus
  source: 'user' | 'agent' | 'source' | 'migration' | 'runtime'
  updatedAt: string
  openIssueId: string | null
}

export interface AnalysisProblemState {
  trigger: AnalysisSlot<string>
  currentProblem: AnalysisSlot<string>
  rootCause: AnalysisSlot<string>
  businessImpact: AnalysisSlot<string>
  currentWorkaround: AnalysisSlot<string>
}

export interface AnalysisScenarioState {
  scenarioId: string
  actor: string
  trigger: string
  preconditions: string[]
  intent: string
  currentActions: string[]
  painPoint: string
  expectedOutcome: string
  status: AnalysisSlotStatus
}

export interface AnalysisGoalsState {
  businessGoals: string[]
  userGoals: string[]
  systemGoals: string[]
  successCriteria: string[]
}

export interface AnalysisFlowState {
  entry: AnalysisSlot<string>
  mainFlow: string[]
  branches: string[]
  exitConditions: string[]
  failureFlows: string[]
}

export interface AnalysisRuleState {
  ruleId: string
  subject: string
  condition: string
  action: string
  priority: number | null
  exception: string | null
  status: AnalysisSlotStatus
}

export interface AnalysisScopeState {
  inScope: string[]
  outOfScope: string[]
  future: string[]
  constraints: string[]
}

export interface AnalysisHistoricalRequirement {
  name: string
  relation: 'extends' | 'changes' | 'replaces' | 'depends_on' | 'unknown'
  impact: string
  status: AnalysisSlotStatus
}

export interface AnalysisImpactState {
  systems: string[]
  upstream: string[]
  downstream: string[]
  data: string[]
  externalServices: string[]
  historicalRequirements: AnalysisHistoricalRequirement[]
}

export interface AnalysisDecisionState {
  id: string
  topic: string
  decision: string
  reason: string
  status: AnalysisSlotStatus
}

export interface AnalysisQuestionState {
  id: string
  topic: string
  question: string
  priority: AnalysisQuestionPriority
  reason: string
  impact?: string[]
  blocking?: boolean
  status: AnalysisQuestionStatus
  type?: AnalysisQuestionType
  targetStage?: 'requirement-analysis' | 'business-flow' | 'solution-design' | 'interaction-design' | 'prototype' | 'product-spec' | 'requirement-review'
}

export interface AnalysisCollectionMeta {
  status: AnalysisSlotStatus
  source: 'user' | 'agent' | 'source' | 'migration' | 'runtime'
  updatedAt: string
}

export interface AnalysisReadinessState {
  status: AnalysisReadinessStatus
  problemClear: boolean
  goalClear: boolean
  scenarioClear: boolean
  mainFlowClear: boolean
  rulesClear: boolean
  scopeClear: boolean
  exceptionsClear: boolean
  dependenciesClear: boolean
  blockingQuestions: number
  readyForConfirmation: boolean
}

export interface AnalysisState {
  schemaVersion: 2
  workspaceId: string
  requirementId: string
  threadId: string
  version: number
  source: 'new' | 'migrated' | 'derived'
  mainlineSchema: AnalysisMainlineSchema
  working: AnalysisWorkingContext
  moduleData: Record<string, AnalysisModuleField>
  problem: AnalysisProblemState
  scenarios: AnalysisScenarioState[]
  goals: AnalysisGoalsState
  flow: AnalysisFlowState
  rules: AnalysisRuleState[]
  scope: AnalysisScopeState
  impact: AnalysisImpactState
  decisions: AnalysisDecisionState[]
  openQuestions: AnalysisQuestionState[]
  collectionMeta: Record<string, AnalysisCollectionMeta>
  readiness: AnalysisReadinessState
  changedPaths: string[]
  updatedAt: string
}

export interface AnalysisPatchOperation {
  op: 'add' | 'replace' | 'remove'
  path: string
  value?: unknown
  status?: AnalysisSlotStatus
  source?: 'user' | 'agent' | 'source' | 'runtime'
}

export interface AnalysisQuestionDraft {
  topic: string
  question: string
  priority: AnalysisQuestionPriority
  reason: string
  impact?: string[]
  targetStage?: AnalysisQuestionState['targetStage']
}

export interface AnalysisTurnSubmission {
  assistantReply: string
  patches: AnalysisPatchOperation[]
  resolvedQuestionIds: string[]
  newQuestions: AnalysisQuestionDraft[]
  schemaDelta?: {
    status?: AnalysisSchemaStatus
    requirementTypes?: AnalysisRequirementType[]
    modules?: string[]
    addModules?: string[]
  }
  workingDelta?: {
    currentTopic?: string | null
    currentQuestion?: AnalysisWorkingQuestion | null
    clearCurrentQuestion?: boolean
  }
}

export interface AnalysisStateRecord {
  state: AnalysisState
  projection: string
}
