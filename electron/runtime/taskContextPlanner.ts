import type { CurrentStageCandidateMode, TaskContextStrategy } from '../../src/context'
import type { LifecycleStageId, LifecycleStageState } from '../../src/lifecycleStageState'

export interface TaskContextPlan {
  strategy: TaskContextStrategy
  activeStageId: LifecycleStageId | null
  upstreamStageIds: LifecycleStageId[]
  includeThreadHistory: boolean
  includeRequirementMemory: boolean
  includeWorkspaceDecisions: boolean
  includeArtifactMetadata: boolean
  currentStageCandidateMode: CurrentStageCandidateMode
  reason: string
}

const prerequisites: Record<LifecycleStageId, LifecycleStageId[]> = {
  'requirement-analysis': [],
  'business-flow': ['requirement-analysis'],
  'solution-design': ['requirement-analysis', 'business-flow'],
  'interaction-design': ['requirement-analysis', 'business-flow', 'solution-design'],
  prototype: ['solution-design', 'interaction-design'],
  'product-spec': ['requirement-analysis', 'business-flow', 'solution-design', 'interaction-design', 'prototype'],
  'requirement-review': ['product-spec']
}

const explicitArtifactIntent = /(附件|资料|文档|artifact|source|prd|流程图|方案文档|交互文档|原型|html|json|对照|核对|review|评审)/i

function hasStageContent(state: LifecycleStageState | null): boolean {
  if (!state) return false
  return Object.values(state.slots).some((value) => Array.isArray(value) && value.length > 0)
    || state.openQuestions.length > 0
    || state.conflicts.length > 0
    || state.decisions.length > 0
}

export function planTaskContext(input: {
  task: string
  activeStageId: LifecycleStageId | null
  activeStageState: LifecycleStageState | null
  hasCurrentStageCandidate: boolean
  currentStageCandidateReferenceOnly?: boolean
  currentStageCandidateTokens?: number
  maxInlineCandidateTokens?: number
  forceFullContext?: boolean
}): TaskContextPlan {
  const { task, activeStageId, activeStageState, hasCurrentStageCandidate } = input
  if (!activeStageId) {
    return {
      strategy: 'general', activeStageId: null, upstreamStageIds: [], includeThreadHistory: true,
      includeRequirementMemory: true, includeWorkspaceDecisions: true,
      includeArtifactMetadata: explicitArtifactIntent.test(task), currentStageCandidateMode: 'none',
      reason: '非生命周期任务保留通用 Context 行为。'
    }
  }
  if (activeStageId === 'requirement-analysis') {
    return {
      strategy: 'analysis-mainline', activeStageId, upstreamStageIds: [], includeThreadHistory: Boolean(input.forceFullContext),
      includeRequirementMemory: Boolean(input.forceFullContext), includeWorkspaceDecisions: Boolean(input.forceFullContext),
      includeArtifactMetadata: Boolean(input.forceFullContext) || explicitArtifactIntent.test(task), currentStageCandidateMode: 'none',
      reason: input.forceFullContext
        ? '用户显式请求 Full Context；仍以 Analysis Mainline 为 Canonical State，但允许附加历史/记忆作为参考证据。'
        : 'Requirement Analysis 由 Canonical Mainline + Working Context + Current Input 驱动。'
    }
  }

  const stageHasWorkingState = hasStageContent(activeStageState)
  const strategy: TaskContextStrategy = activeStageId === 'requirement-review'
    ? 'stage-review'
    : (stageHasWorkingState || hasCurrentStageCandidate ? 'stage-delta' : 'stage-bootstrap')
  const inlineLimit = input.maxInlineCandidateTokens ?? 6_000
  const candidateTokens = input.currentStageCandidateTokens ?? 0
  const currentStageCandidateMode: CurrentStageCandidateMode = activeStageId === 'requirement-review' || input.currentStageCandidateReferenceOnly
    ? (hasCurrentStageCandidate ? 'reference' : 'none')
    : !hasCurrentStageCandidate
      ? 'none'
      : candidateTokens > inlineLimit ? 'reference' : 'inline'

  return {
    strategy,
    activeStageId,
    upstreamStageIds: prerequisites[activeStageId],
    includeThreadHistory: Boolean(input.forceFullContext),
    includeRequirementMemory: Boolean(input.forceFullContext),
    includeWorkspaceDecisions: Boolean(input.forceFullContext),
    includeArtifactMetadata: Boolean(input.forceFullContext) || strategy === 'stage-bootstrap' || strategy === 'stage-review' || (strategy === 'stage-delta' && currentStageCandidateMode !== 'inline') || explicitArtifactIntent.test(task),
    currentStageCandidateMode,
    reason: input.forceFullContext
      ? '用户显式请求 Full Context；保留 Stage Mainline 为主状态，同时允许附加 History/Memory/Workspace 状态。'
      : strategy === 'stage-bootstrap'
      ? '当前 Stage 尚无可复用候选，默认只注入 Stage Mainline 与必要上游 Stage 投影；精确正文按需 artifact_read。'
      : strategy === 'stage-delta'
        ? `当前 Stage 已有状态，按 Delta 处理；候选正文采用 ${currentStageCandidateMode === 'inline' ? '小体积内联' : '引用后按需读取'}。`
        : 'Requirement Review 只预装 Product Spec Stage 摘要；证据正文通过 artifact_read 按需获取。'
  }
}
