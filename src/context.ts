import type { MessageRole } from './persistence'
import type { MemoryItem } from './memory'
import type { BusinessFlowResult, InteractionDesignResult, ProductSpecResult, PrototypeResult, RequirementAnalysisResult, SolutionDesignResult } from './skills'
import type { WorkspaceArtifact, WorkspaceDecision, WorkspaceOpenIssue } from './workspace'
import type { AnalysisReadinessState } from './analysisState'
import type { LifecycleStageId, LifecycleStageStatus, SharedRequirementState, StageWorkingState } from './lifecycleStageState'
import type { ResolvedWorkContext } from './workContext'
import type { UiBaselineContext } from './prototypeStyle'

export type ContextLevel = 'L0' | 'L1' | 'L2'
export type ContextMode = 'core' | 'slice' | 'extended' | 'full'
export type TaskContextStrategy = 'analysis-mainline' | 'stage-bootstrap' | 'stage-delta' | 'stage-review' | 'general'
export type CurrentStageCandidateMode = 'none' | 'inline' | 'reference'

export interface RequirementSnapshot {
  requirementId: string
  name: string
  currentGoal: string
  currentStage: string
  currentStatus: string
  mainArtifacts: Array<Pick<WorkspaceArtifact, 'id' | 'kind' | 'relativePath' | 'updatedAt'>>
  keyDecisionIds: string[]
  openIssueIds: string[]
  recentImportantChanges: string[]
  sourceUpdatedAt: string
  sourceFingerprint: string
  refreshedAt: string
}

export interface ArtifactContext {
  id: string
  title: string
  type: string
  path: string
  updatedAt: string
  section: string | null
  content: string | null
}

export interface SkillContext {
  id: string
  name: string
  version: string
  mode: string
  instructions: string
  loadMode?: 'capsule' | 'full'
}

export interface RuntimePolicyContext {
  id: string
  instruction: string
}

export interface ThreadMessageContext {
  id: string
  role: MessageRole
  content: string
  createdAt: string
}

export interface ThreadContext {
  summary: string | null
  messages: ThreadMessageContext[]
  truncated: boolean
  compactedMessageCount: number
}


export interface UpstreamStageContext {
  stageId: LifecycleStageId
  version: number
  status: LifecycleStageStatus | 'artifact_only'
  source: 'stage-state' | 'workspace-artifact'
  projection: string
  artifactRefs: string[]
}

export interface TaskContextPlanContext {
  strategy: TaskContextStrategy
  activeStageId: LifecycleStageId | null
  upstreamStageIds: LifecycleStageId[]
  includeThreadHistory: boolean
  includeArtifactMetadata: boolean
  currentStageCandidateMode: CurrentStageCandidateMode
  reason: string
}

export interface ContextPackage {
  level: ContextLevel
  mode?: ContextMode
  task: string
  requirement?: RequirementSnapshot
  decisions: WorkspaceDecision[]
  openIssues: WorkspaceOpenIssue[]
  memories: MemoryItem[]
  artifacts: ArtifactContext[]
  analysisWorkingState?: { version: number; projection: string; fullStateChars: number; readiness: AnalysisReadinessState }
  analysisWorkingContext?: { projection: string; fullStateChars: number }
  analysisBootstrap?: { mode: 'definition' | 'historical'; source: 'analysis_state' | 'stage_state' | 'analysis_artifact' | 'downstream_artifact' | 'source_input' | 'conversation' | 'none' }
  analysisInitialInput?: string
  sharedRequirementState?: { version: number; projection: string; fullStateChars: number; state: SharedRequirementState }
  stageWorkingState?: StageWorkingState
  upstreamStageContexts?: UpstreamStageContext[]
  taskContextPlan?: TaskContextPlanContext
  existingAnalysis?: Omit<RequirementAnalysisResult, 'artifactCandidate'> & { sourceRunId: string }
  existingFlow?: Omit<BusinessFlowResult, 'modelCandidate' | 'htmlCandidate'> & { sourceRunId: string }
  existingSolution?: Omit<SolutionDesignResult, 'modelCandidate' | 'markdownCandidate'> & { sourceRunId: string }
  existingInteraction?: Omit<InteractionDesignResult, 'modelCandidate' | 'markdownCandidate'> & { sourceRunId: string }
  existingPrototype?: Omit<PrototypeResult, 'htmlCandidate'> & { sourceRunId: string }
  existingProductSpec?: Omit<ProductSpecResult, 'modelCandidate' | 'markdownCandidate'> & { sourceRunId: string }
  skill?: SkillContext
  runtimePolicies: RuntimePolicyContext[]
  threadContext: ThreadContext
  workContext: ResolvedWorkContext
  uiBaseline?: UiBaselineContext
}

export interface RunContextMetadata {
  level: ContextLevel
  mode: ContextMode
  snapshot: {
    requirementId: string
    name: string
    sourceUpdatedAt: string
    refreshedAt: string
    refreshedForRun: boolean
  } | null
  artifacts: Array<{ id: string | null; path: string; type: string | null; section: string | null }>
  decisions: Array<{ id: string; title: string }>
  openIssues: Array<{ id: string; title: string }>
  skill: { id: string; version: string; loadMode: 'capsule' | 'full' } | null
  analysisSourceRunId: string | null
  flowSourceRunId: string | null
  solutionSourceRunId: string | null
  interactionSourceRunId: string | null
  prototypeSourceRunId: string | null
  productSpecSourceRunId: string | null
  runtimePolicies: string[]
  memories: Array<{ id: string; scope: string; category: string }>
  thread: { includedMessages: number; truncated: boolean; summaryIncluded: boolean; compactedMessageCount: number }
  sources: string[]
  taskContext: { strategy: TaskContextStrategy; activeStageId: LifecycleStageId | null; upstreamStageIds: LifecycleStageId[]; currentStageCandidateMode: CurrentStageCandidateMode; historyIncluded: boolean } | null
  workContext: Pick<ResolvedWorkContext, 'used' | 'reason' | 'sources' | 'primarySystemId' | 'relationCount'>
}
