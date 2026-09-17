import { createHash } from 'node:crypto'
import type { ContextLevel, ContextMode, ContextPackage, RequirementSnapshot, RunContextMetadata } from '../../src/context'
import type { WorkspaceArtifact, WorkspaceDecision, WorkspaceOpenIssue, WorkspaceRequirement } from '../../src/workspace'
import type { PersistenceService } from '../persistenceService'
import type { SelectedSkill } from '../skills/skillRegistry'
import type { LocalWorkspaceService } from '../workspaceService'
import type { MemoryManager } from './memoryManager'
import { buildAnalysisProjection, buildAnalysisWorkingProjection, deriveAnalysisStateForThread, migrateLegacyAnalysisState, normalizeAnalysisState } from './analysisStateEngine'
import type { LifecycleStageId, LifecycleStageState } from '../../src/lifecycleStageState'
import type { RuntimeContextPart, RuntimeContextSource } from './agentRuntime'
import { lifecycleStageOrder } from '../../src/lifecycleStageState'
import {
  buildSharedProjection, buildStageProjection, createSharedRequirementState, createStageState, sharedStateFromAnalysis,
  stageStateFromAnalysis, stageStateFromBusinessFlow, stageStateFromInteraction, stageStateFromProductSpec, stageStateFromPrototype,
  stageStateFromReview, stageStateFromSolution
} from './lifecycleStageStateEngine'
import { resolveWorkContext } from './workContextResolver'
import { estimateTokens } from './tokenEstimator'
import { planTaskContext } from './taskContextPlanner'

const simpleRequirementQuestion = /(当前|现在).*(目标|状态|阶段)|(目标|状态|阶段).*(是什么|如何|怎样)/i
const broadAnalysis = /(整体|全面|完整|全局|跨.*(?:artifact|文档|产物)|不一致|一致性|评审|review|方案.*prd|prd.*方案|端到端|全链路)/i
const closedStatuses = new Set(['resolved', 'closed', 'done', 'cancelled', 'canceled', '已解决', '已关闭', '已取消', '废弃'])
const commonTaskWords = new Set(['这个', '需求', '当前', '帮我', '检查', '是否', '有没有', '明显', '规则', '补到', '修改', '调整', '新增', '增加', '删除', '移除', '补充', '替换', '变更', '同步', '一下', '什么', '怎么', '如何'])
const artifactLimit: Record<ContextLevel, number> = { L0: 0, L1: 4, L2: 8 }
const semanticLimit: Record<ContextLevel, number> = { L0: 0, L1: 3, L2: 6 }

const lifecycleSkills = new Set<LifecycleStageId>(lifecycleStageOrder)

const lifecycleArtifactIdByStage: Record<LifecycleStageId, 'analysis' | 'business-flow' | 'solution' | 'interaction' | 'prototype' | 'product-spec' | 'review'> = {
  'requirement-analysis': 'analysis',
  'business-flow': 'business-flow',
  'solution-design': 'solution',
  'interaction-design': 'interaction',
  prototype: 'prototype',
  'product-spec': 'product-spec',
  'requirement-review': 'review'
}

function stageForSkill(skillId: string | null | undefined): LifecycleStageId | null {
  return skillId && lifecycleSkills.has(skillId as LifecycleStageId) ? skillId as LifecycleStageId : null
}

export interface ContextBuildInput {
  workspaceId: string
  requirementId: string
  threadId: string
  task: string
  skill: SelectedSkill | null
  contextMode?: ContextMode
}

export interface BuiltContext {
  package: ContextPackage
  metadata: RunContextMetadata
}

function levelFor(task: string, skill: SelectedSkill | null): ContextLevel {
  if (skill?.id === 'requirement-analysis') return 'L1'
  if (skill?.id === 'business-flow') return /(完整|全链路|端到端|as-is|to-be|现状.*目标)/i.test(task) ? 'L2' : 'L1'
  if (skill?.id === 'solution-design' || skill?.id === 'interaction-design' || skill?.id === 'product-spec' || skill?.id === 'requirement-review') return 'L2'
  if (skill?.id === 'prototype') return 'L1'
  if (broadAnalysis.test(task)) return 'L2'
  if (!skill && simpleRequirementQuestion.test(task)) return 'L0'
  return 'L1'
}

function modeFor(task: string, level: ContextLevel): ContextMode {
  if (/(完整上下文|全部上下文|full context|加载全部|完整重新分析)/i.test(task)) return 'full'
  if (level === 'L2') return 'extended'
  if (level === 'L1') return 'slice'
  return 'core'
}

export function nextContextMode(mode: ContextMode): ContextMode | null {
  if (mode === 'core') return 'slice'
  if (mode === 'slice') return 'extended'
  if (mode === 'extended') return 'full'
  return null
}

function normalizedStatus(status: string): string {
  return status.trim().toLowerCase()
}

function isActive(status: string): boolean {
  return !closedStatuses.has(normalizedStatus(status))
}

function taskTerms(task: string): string[] {
  const chunks = task.toLowerCase().match(/[a-z0-9_-]{2,}|[\u3400-\u9fff]{2,}/g) ?? []
  const terms = new Set<string>()
  for (const chunk of chunks) {
    if (!commonTaskWords.has(chunk)) terms.add(chunk)
    if (/^[\u3400-\u9fff]+$/.test(chunk)) {
      for (let size = 2; size <= Math.min(6, chunk.length); size += 1) {
        for (let index = 0; index + size <= chunk.length; index += 1) {
          const term = chunk.slice(index, index + size)
          if (!commonTaskWords.has(term)) terms.add(term)
        }
      }
    }
  }
  return [...terms].sort((left, right) => right.length - left.length)
}

function relevance(task: string, text: string): number {
  const haystack = text.toLowerCase()
  return taskTerms(task).reduce((score, term) => score + (haystack.includes(term) ? Math.min(term.length, 5) : 0), 0)
}

function selectSemantic<T extends { id: string; title: string; status: string }>(
  task: string,
  values: T[],
  level: ContextLevel,
  detail: (value: T) => string
): T[] {
  const limit = semanticLimit[level]
  if (!limit) return []
  const active = values.filter((value) => isActive(value.status))
    .map((value, index) => ({ value, index, score: relevance(task, `${value.id} ${value.title} ${detail(value)}`) }))
  const related = active.filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
  if (level === 'L1') return related.slice(0, limit).map((item) => item.value)
  const selected = [...related]
  for (const item of active) if (!selected.includes(item)) selected.push(item)
  return selected.slice(0, limit).map((item) => item.value)
}

function artifactIntent(task: string): string[] {
  const intents: string[] = []
  const checks: Array<[RegExp, string]> = [
    [/prd|产品需求文档/i, 'PRD'], [/流程|flow/i, 'Business Flow'], [/原型|prototype/i, 'Prototype'],
    [/方案|solution/i, 'Solution'], [/交互|interaction|页面流程/i, 'Interaction'], [/分析|analysis/i, 'Analysis'], [/评审|review/i, 'Review']
  ]
  for (const [pattern, kind] of checks) if (pattern.test(task)) intents.push(kind)
  return intents
}

function artifactVersion(path: string): number {
  return Number(path.match(/(?:^|[-_. ])v(\d+)(?=\.[^.]+$)/i)?.[1] ?? 0)
}

function latestArtifacts(artifacts: WorkspaceArtifact[]): WorkspaceArtifact[] {
  return [...artifacts].sort((left, right) => artifactVersion(right.relativePath) - artifactVersion(left.relativePath)
    || Number(!left.relativePath.endsWith('.json')) - Number(!right.relativePath.endsWith('.json'))
    || right.updatedAt.localeCompare(left.updatedAt, 'zh-CN') || left.relativePath.localeCompare(right.relativePath, 'zh-CN'))
}

function selectArtifacts(task: string, requirement: WorkspaceRequirement, level: ContextLevel, skill: SelectedSkill | null): WorkspaceArtifact[] {
  const limit = artifactLimit[level]
  if (!limit) return []
  const intents = artifactIntent(task)
  const ranked = latestArtifacts(requirement.artifacts).map((artifact, index) => {
    const intentScore = intents.includes(artifact.kind) ? 20 : 0
    const currentScore = artifact.relativePath === requirement.currentArtifact ? 10 : 0
    const analysisScore = skill?.id === 'requirement-analysis'
      ? (artifact.kind === 'Analysis' ? 30 : artifact.relativePath.startsWith('source/') ? 25 : /(^|\/)overview\.md$/i.test(artifact.relativePath) ? 20 : 0)
      : skill?.id === 'business-flow'
        ? (artifact.kind === 'Analysis' ? 40 : artifact.kind === 'Business Flow' ? 30 : /(^|\/)overview\.md$/i.test(artifact.relativePath) ? 10 : 0)
        : skill?.id === 'solution-design'
          ? (artifact.kind === 'Analysis' ? 50 : artifact.kind === 'Business Flow' ? 45 : artifact.kind === 'Solution' ? 30 : /(^|\/)overview\.md$/i.test(artifact.relativePath) ? 10 : 0)
          : skill?.id === 'interaction-design'
            ? (artifact.kind === 'Analysis' ? 50 : artifact.kind === 'Business Flow' ? 48 : artifact.kind === 'Solution' ? 46 : artifact.kind === 'Interaction' ? 35 : artifact.kind === 'Prototype' ? 30 : /(^|\/)overview\.md$/i.test(artifact.relativePath) ? 10 : 0)
          : skill?.id === 'prototype'
            ? (artifact.kind === 'Interaction' ? 50 : artifact.kind === 'Prototype' ? 48 : artifact.kind === 'Solution' ? 30 : /baseline|reference|style/i.test(artifact.relativePath) ? 35 : 0)
          : skill?.id === 'product-spec'
            ? (artifact.kind === 'Analysis' ? 60 : artifact.kind === 'Business Flow' ? 58 : artifact.kind === 'Solution' ? 56 : artifact.kind === 'Interaction' ? 54 : artifact.kind === 'Prototype' ? 48 : artifact.kind === 'PRD' ? 50 : 0)
          : skill?.id === 'requirement-review'
            ? (artifact.kind === 'Analysis' ? 60 : artifact.kind === 'Business Flow' ? 58 : artifact.kind === 'Solution' ? 56 : artifact.kind === 'Interaction' ? 54 : artifact.kind === 'Prototype' ? 52 : artifact.kind === 'PRD' ? 64 : artifact.kind === 'Decision' || artifact.kind === 'Open Issue' ? 50 : 0)
        : 0
    return { artifact, index, score: analysisScore + intentScore + currentScore + relevance(task, `${artifact.kind} ${artifact.title} ${artifact.relativePath}`) }
  }).filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
  const selected: WorkspaceArtifact[] = []
  for (const item of ranked) {
    const sourceInput = item.artifact.relativePath.startsWith('source/')
    if (sourceInput || !selected.some((artifact) => artifact.kind === item.artifact.kind && artifactVersion(artifact.relativePath) >= artifactVersion(item.artifact.relativePath))) {
      selected.push(item.artifact)
    }
    if (selected.length === limit) break
  }
  return selected
}

function compactGoal(overview: string | null, title: string): string {
  if (!overview) return title
  const lines = overview.split(/\r?\n/)
  const goalHeading = lines.findIndex((line) => /^#{1,6}\s+.*(?:目标|goal)/i.test(line))
  const source = goalHeading >= 0 ? lines.slice(goalHeading + 1) : lines
  const paragraph: string[] = []
  for (const line of source) {
    const value = line.trim()
    if (paragraph.length && (!value || /^#{1,6}\s+/.test(value))) break
    if (!value || /^#{1,6}\s+/.test(value) || value.startsWith('|') || value.startsWith('```')) continue
    paragraph.push(value.replace(/^[-*>]\s*/, ''))
  }
  return (paragraph.join(' ').slice(0, 800) || title).trim()
}

function representativeArtifacts(requirement: WorkspaceRequirement): WorkspaceArtifact[] {
  const selected: WorkspaceArtifact[] = []
  const current = requirement.currentArtifact
    ? requirement.artifacts.find((artifact) => artifact.relativePath === requirement.currentArtifact) : null
  if (current) selected.push(current)
  for (const artifact of latestArtifacts(requirement.artifacts)) {
    if (!selected.some((item) => item.kind === artifact.kind)) selected.push(artifact)
    if (selected.length === 6) break
  }
  return selected
}

function fingerprint(requirement: WorkspaceRequirement): string {
  const source = {
    id: requirement.id, title: requirement.title, status: requirement.status, stage: requirement.stage,
    updatedAt: requirement.updatedAt, overview: requirement.overview, currentArtifact: requirement.currentArtifact,
    artifacts: requirement.artifacts.map(({ id, relativePath, modifiedAt, size }) => ({ id, relativePath, modifiedAt, size })),
    decisions: requirement.decisions, openIssues: requirement.openIssues
  }
  return createHash('sha256').update(JSON.stringify(source)).digest('hex')
}

function createSnapshot(requirement: WorkspaceRequirement, sourceFingerprint: string): RequirementSnapshot {
  return {
    requirementId: requirement.id,
    name: requirement.title,
    currentGoal: compactGoal(requirement.overview, requirement.title),
    currentStage: requirement.stage,
    currentStatus: requirement.status,
    mainArtifacts: representativeArtifacts(requirement).map(({ id, kind, relativePath, updatedAt }) => ({ id, kind, relativePath, updatedAt })),
    keyDecisionIds: requirement.decisions.filter((item) => isActive(item.status)).slice(0, 6).map((item) => item.id),
    openIssueIds: requirement.openIssues.filter((item) => isActive(item.status)).slice(0, 6).map((item) => item.id),
    recentImportantChanges: requirement.currentArtifact ? [`当前 Artifact：${requirement.currentArtifact}`] : [],
    sourceUpdatedAt: requirement.updatedAt,
    sourceFingerprint,
    refreshedAt: new Date().toISOString()
  }
}


function toMetadata(context: ContextPackage, refreshedForRun: boolean): RunContextMetadata {
  const sources = context.requirement ? ['requirement-snapshot'] : []
  sources.push(...context.decisions.map((item) => `decision:${item.id}`))
  sources.push(...context.openIssues.map((item) => `open-issue:${item.id}`))
  if (context.skill) sources.push(`skill:${context.skill.id}@${context.skill.version}`)
  if (context.analysisWorkingState) sources.push(`analysis-mainline:v${context.analysisWorkingState.version}`)
  if (context.analysisWorkingContext) sources.push('analysis-working-context')
  if (context.analysisBootstrap) sources.push(`mainline-${context.analysisBootstrap.mode}:${context.analysisBootstrap.source}`)
  if (context.existingAnalysis) sources.push(`analysis-run:${context.existingAnalysis.sourceRunId}`)
  if (context.existingFlow) sources.push(`flow-run:${context.existingFlow.sourceRunId}`)
  if (context.existingSolution) sources.push(`solution-run:${context.existingSolution.sourceRunId}`)
  if (context.existingInteraction) sources.push(`interaction-run:${context.existingInteraction.sourceRunId}`)
  if (context.existingPrototype) sources.push(`prototype-run:${context.existingPrototype.sourceRunId}`)
  if (context.existingProductSpec) sources.push(`product-spec-run:${context.existingProductSpec.sourceRunId}`)
  if (context.taskContextPlan) sources.push(`task-context:${context.taskContextPlan.strategy}`)
  if (context.upstreamStageContexts?.length) sources.push(...context.upstreamStageContexts.map((item) => `upstream-stage:${item.stageId}@v${item.version}`))
  sources.push(...context.runtimePolicies.map((item) => `policy:${item.id}`))
  if (context.threadContext.summary) sources.push('thread-summary')
  if (context.threadContext.messages.length) sources.push('thread-history')
  sources.push(...context.memories.map((item) => `memory:${item.id}`))
  sources.push(...context.workContext.sources.map((source) => `work-context:${source}`))
  if (context.uiBaseline) sources.push(`ui-baseline:v${context.uiBaseline.version}`)
  return {
    level: context.level,
    mode: context.mode ?? 'core',
    snapshot: context.requirement ? {
      requirementId: context.requirement.requirementId,
      name: context.requirement.name,
      sourceUpdatedAt: context.requirement.sourceUpdatedAt,
      refreshedAt: context.requirement.refreshedAt,
      refreshedForRun
    } : null,
    artifacts: [],
    decisions: context.decisions.map(({ id, title }) => ({ id, title })),
    openIssues: context.openIssues.map(({ id, title }) => ({ id, title })),
    skill: context.skill ? { id: context.skill.id, version: context.skill.version, loadMode: context.skill.loadMode ?? 'capsule' } : null,
    analysisSourceRunId: context.existingAnalysis?.sourceRunId ?? null,
    flowSourceRunId: context.existingFlow?.sourceRunId ?? null,
    solutionSourceRunId: context.existingSolution?.sourceRunId ?? null,
    interactionSourceRunId: context.existingInteraction?.sourceRunId ?? null,
    prototypeSourceRunId: context.existingPrototype?.sourceRunId ?? null,
    productSpecSourceRunId: context.existingProductSpec?.sourceRunId ?? null,
    runtimePolicies: context.runtimePolicies.map((item) => item.id),
    memories: context.memories.map((item) => ({ id: item.id, scope: item.scope, category: item.category })),
    thread: {
      includedMessages: context.threadContext.messages.length,
      truncated: context.threadContext.truncated,
      summaryIncluded: Boolean(context.threadContext.summary),
      compactedMessageCount: context.threadContext.compactedMessageCount
    },
    sources,
    taskContext: context.taskContextPlan ? {
      strategy: context.taskContextPlan.strategy, activeStageId: context.taskContextPlan.activeStageId,
      upstreamStageIds: context.taskContextPlan.upstreamStageIds, currentStageCandidateMode: context.taskContextPlan.currentStageCandidateMode,
      historyIncluded: context.taskContextPlan.includeThreadHistory
    } : null,
    workContext: {
      used: context.workContext.used, reason: context.workContext.reason, sources: context.workContext.sources,
      primarySystemId: context.workContext.primarySystemId, relationCount: context.workContext.relationCount
    }
  }
}

export class ContextManager {
  constructor(
    private readonly workspace: LocalWorkspaceService,
    private readonly persistence: PersistenceService,
    private readonly memory: MemoryManager,
    private readonly uiBaselineResolver?: { resolveContext: (hint: string) => Promise<ContextPackage['uiBaseline'] | null> }
  ) {}

  async build(input: ContextBuildInput): Promise<BuiltContext> {
    const requirement = await this.workspace.refreshRequirement(input.requirementId)
    const workContext = resolveWorkContext(this.persistence.getWorkContext(), requirement.primarySystemId ?? null, input.task)
    const sourceFingerprint = fingerprint(requirement)
    const stored = this.persistence.getRequirementSnapshot(input.workspaceId, input.requirementId)
    const refreshedForRun = !stored || stored.sourceFingerprint !== sourceFingerprint
    const snapshot = refreshedForRun ? createSnapshot(requirement, sourceFingerprint) : stored
    if (refreshedForRun) this.persistence.saveRequirementSnapshot(input.workspaceId, snapshot)
    const level = levelFor(input.task, input.skill)
    const mode = input.contextMode ?? modeFor(input.task, level)
    const activeStageId = stageForSkill(input.skill?.id)
    let decisions = selectSemantic(input.task, requirement.decisions, level, (item: WorkspaceDecision) => `${item.detail} ${item.date}`)
    let openIssues = selectSemantic(input.task, requirement.openIssues, level, (item: WorkspaceOpenIssue) => `${item.detail} ${item.owner}`)
    let artifacts = selectArtifacts(input.task, requirement, level, input.skill).map((artifact) => ({
      id: artifact.id, title: artifact.title, type: artifact.kind, path: artifact.relativePath,
      updatedAt: artifact.updatedAt, section: null, content: null
    }))
    if (mode === 'full') {
      decisions = requirement.decisions.filter((item) => isActive(item.status))
      openIssues = requirement.openIssues.filter((item) => isActive(item.status))
      artifacts = latestArtifacts(requirement.artifacts).map((artifact) => ({
        id: artifact.id, title: artifact.title, type: artifact.kind, path: artifact.relativePath,
        updatedAt: artifact.updatedAt, section: null, content: null
      }))
    }

    this.memory.captureExplicitMemory({
      workspaceId: input.workspaceId, requirementId: input.requirementId, threadId: input.threadId, task: input.task
    })
    const thread = this.memory.buildThreadMemory(input.threadId)
    const analysisHistory = input.skill?.id === 'requirement-analysis'
      ? this.persistence.getLatestAnalysis(input.requirementId, input.threadId)
      : null
    let migratedHistoricalMainline = false
    let analysisState = input.skill?.id === 'requirement-analysis'
      ? this.persistence.getAnalysisState(input.requirementId, input.threadId)
      : null
    if (analysisState) analysisState = normalizeAnalysisState(analysisState)
    if (input.skill?.id === 'requirement-analysis' && !analysisState) {
      const requirementState = this.persistence.getLatestAnalysisState(input.requirementId, input.threadId)
      if (requirementState) {
        analysisState = deriveAnalysisStateForThread(requirementState, input.workspaceId, input.requirementId, input.threadId)
        this.persistence.saveAnalysisState(analysisState, null, 'derived-from-requirement-state')
      } else {
        analysisState = migrateLegacyAnalysisState(input.workspaceId, input.requirementId, input.threadId, analysisHistory?.result ?? null)
        migratedHistoricalMainline = Boolean(analysisHistory)
        this.persistence.saveAnalysisState(analysisState, null, analysisHistory ? 'migrated-from-analysis-result' : 'initialized')
      }
    }
    const canonicalAnalysisState = analysisState ?? this.persistence.getLatestAnalysisState(input.requirementId)
    const normalizedCanonicalAnalysisState = canonicalAnalysisState ? normalizeAnalysisState(canonicalAnalysisState) : null

    const latestFlow = activeStageId === 'business-flow'
      ? (this.persistence.getLatestFlow(input.requirementId, input.threadId) ?? this.persistence.getLatestFlow(input.requirementId))
      : this.persistence.getLatestFlow(input.requirementId)
    const latestSolution = activeStageId === 'solution-design'
      ? (this.persistence.getLatestSolution(input.requirementId, input.threadId) ?? this.persistence.getLatestSolution(input.requirementId))
      : this.persistence.getLatestSolution(input.requirementId)
    const latestInteraction = activeStageId === 'interaction-design'
      ? (this.persistence.getLatestInteraction(input.requirementId, input.threadId) ?? this.persistence.getLatestInteraction(input.requirementId))
      : this.persistence.getLatestInteraction(input.requirementId)
    const latestPrototype = activeStageId === 'prototype'
      ? (this.persistence.getLatestPrototype(input.requirementId, input.threadId) ?? this.persistence.getLatestPrototype(input.requirementId))
      : this.persistence.getLatestPrototype(input.requirementId)
    const latestProductSpec = activeStageId === 'product-spec'
      ? (this.persistence.getLatestProductSpec(input.requirementId, input.threadId) ?? this.persistence.getLatestProductSpec(input.requirementId))
      : this.persistence.getLatestProductSpec(input.requirementId)
    const latestRequirementReview = activeStageId === 'requirement-review'
      ? (this.persistence.getLatestRequirementReview(input.requirementId, input.threadId) ?? this.persistence.getLatestRequirementReview(input.requirementId))
      : this.persistence.getLatestRequirementReview(input.requirementId)

    // Shared Requirement State is cross-stage stable state. It is refreshed from the canonical Analysis Mainline,
    // but downstream stages never receive the complete Analysis result by default.
    let sharedRequirementState = this.persistence.getSharedRequirementState(input.requirementId)
    if (!sharedRequirementState) {
      sharedRequirementState = createSharedRequirementState({
        workspaceId: input.workspaceId, requirementId: input.requirementId, name: snapshot.name, goal: snapshot.currentGoal
      })
      this.persistence.saveSharedRequirementState(sharedRequirementState)
    }
    if (normalizedCanonicalAnalysisState) {
      const derivedShared = sharedStateFromAnalysis(sharedRequirementState, normalizedCanonicalAnalysisState)
      const comparableCurrent = { ...sharedRequirementState, version: 0, updatedAt: '' }
      const comparableDerived = { ...derivedShared, version: 0, updatedAt: '' }
      if (JSON.stringify(comparableDerived) !== JSON.stringify(comparableCurrent)) {
        sharedRequirementState = this.persistence.saveSharedRequirementState(derivedShared)
      }
    }

    // Build/restore Stage Mainlines from persisted Stage State first; historical stage results are only used
    // to bootstrap a missing Stage State. The resulting projections are the default cross-stage context.
    const stageStates = new Map(this.persistence.listLifecycleStageStates(input.requirementId).map((state) => [state.stageId, state] as const))
    const persistDerivedStage = (stageId: LifecycleStageId, state: LifecycleStageState): void => {
      if (stageStates.has(stageId)) return
      const saved = this.persistence.saveLifecycleStageState(state, null, 'context-stage-bootstrap')
      stageStates.set(stageId, saved)
    }
    if (normalizedCanonicalAnalysisState && !stageStates.has('requirement-analysis')) {
      persistDerivedStage('requirement-analysis', stageStateFromAnalysis(input.workspaceId, input.requirementId, normalizedCanonicalAnalysisState))
    }
    if (latestFlow && !stageStates.has('business-flow')) {
      persistDerivedStage('business-flow', stageStateFromBusinessFlow(input.workspaceId, input.requirementId, latestFlow.result.flow, [latestFlow.result.modelPath, latestFlow.result.htmlPath]))
    }
    if (latestSolution && !stageStates.has('solution-design')) {
      persistDerivedStage('solution-design', stageStateFromSolution(input.workspaceId, input.requirementId, latestSolution.result.solution, [latestSolution.result.modelPath, latestSolution.result.markdownPath]))
    }
    if (latestInteraction && !stageStates.has('interaction-design')) {
      persistDerivedStage('interaction-design', stageStateFromInteraction(input.workspaceId, input.requirementId, latestInteraction.result.interaction, [latestInteraction.result.modelPath, latestInteraction.result.markdownPath]))
    }
    if (latestPrototype && !stageStates.has('prototype')) {
      persistDerivedStage('prototype', stageStateFromPrototype(input.workspaceId, input.requirementId, latestPrototype.result.prototype, [latestPrototype.result.htmlPath]))
    }
    if (latestProductSpec && !stageStates.has('product-spec')) {
      persistDerivedStage('product-spec', stageStateFromProductSpec(input.workspaceId, input.requirementId, latestProductSpec.result.productSpec, [latestProductSpec.result.modelPath, latestProductSpec.result.markdownPath]))
    }
    if (latestRequirementReview && !stageStates.has('requirement-review')) {
      persistDerivedStage('requirement-review', stageStateFromReview(input.workspaceId, input.requirementId, latestRequirementReview.result.review, [latestRequirementReview.result.modelPath, latestRequirementReview.result.markdownPath]))
    }

    let activeStageState = activeStageId ? stageStates.get(activeStageId) ?? null : null
    if (activeStageId && !activeStageState) {
      activeStageState = createStageState(input.workspaceId, input.requirementId, activeStageId)
      activeStageState = this.persistence.saveLifecycleStageState(activeStageState, null, 'initialized-stage-mainline')
      stageStates.set(activeStageId, activeStageState)
    }

    const rawCurrentStageCandidate = activeStageId === 'business-flow' && latestFlow
      ? { ...latestFlow.result, modelCandidate: undefined, htmlCandidate: undefined, sourceRunId: latestFlow.runId }
      : activeStageId === 'solution-design' && latestSolution
        ? { ...latestSolution.result, modelCandidate: undefined, markdownCandidate: undefined, sourceRunId: latestSolution.runId }
        : activeStageId === 'interaction-design' && latestInteraction
          ? { ...latestInteraction.result, modelCandidate: undefined, markdownCandidate: undefined, sourceRunId: latestInteraction.runId }
          : activeStageId === 'prototype' && latestPrototype
            ? { ...latestPrototype.result, htmlCandidate: undefined, sourceRunId: latestPrototype.runId }
            : activeStageId === 'product-spec' && latestProductSpec
              ? { ...latestProductSpec.result, modelCandidate: undefined, markdownCandidate: undefined, sourceRunId: latestProductSpec.runId }
              : activeStageId === 'requirement-review' && latestRequirementReview
                ? { ...latestRequirementReview.result, modelCandidate: undefined, markdownCandidate: undefined, sourceRunId: latestRequirementReview.runId }
                : null
    const currentLifecycleArtifact = activeStageId
      ? requirement.lifecycle.artifacts.find((item) => item.id === lifecycleArtifactIdByStage[activeStageId]) ?? null
      : null
    const hasCurrentStageArtifact = Boolean(currentLifecycleArtifact?.paths.length)
    const taskContextPlan = planTaskContext({
      task: input.task,
      activeStageId,
      activeStageState,
      hasCurrentStageCandidate: Boolean(rawCurrentStageCandidate) || hasCurrentStageArtifact,
      currentStageCandidateReferenceOnly: !rawCurrentStageCandidate && hasCurrentStageArtifact,
      currentStageCandidateTokens: rawCurrentStageCandidate ? estimateTokens(JSON.stringify(rawCurrentStageCandidate)) : 0,
      forceFullContext: mode === 'full'
    })

    if (!taskContextPlan.includeWorkspaceDecisions) {
      decisions = []
      openIssues = []
    }
    const memories = taskContextPlan.includeRequirementMemory ? this.memory.retrieve({
      workspaceId: input.workspaceId, requirementId: input.requirementId, threadId: input.threadId, task: input.task,
      limit: undefined
    }) : []
    if (!taskContextPlan.includeArtifactMetadata) artifacts = []

    const ensureArtifactRefs = (refs: string[]): void => {
      for (const path of refs) {
        if (artifacts.some((item) => item.path === path)) continue
        const artifact = requirement.artifacts.find((item) => item.relativePath === path)
        artifacts.push(artifact ? {
          id: artifact.id, title: artifact.title, type: artifact.kind, path: artifact.relativePath,
          updatedAt: artifact.updatedAt, section: null, content: null
        } : {
          id: `ref:${path}`, title: path.split('/').at(-1) ?? path, type: 'Stage Artifact', path,
          updatedAt: requirement.updatedAt, section: null, content: null
        })
      }
    }
    if (taskContextPlan.includeArtifactMetadata) {
      if (activeStageState) ensureArtifactRefs(activeStageState.artifactRefs)
      ensureArtifactRefs(currentLifecycleArtifact?.paths ?? [])
      for (const stageId of taskContextPlan.upstreamStageIds) {
        const persistedRefs = stageStates.get(stageId)?.artifactRefs ?? []
        const lifecycleRefs = requirement.lifecycle.artifacts.find((item) => item.id === lifecycleArtifactIdByStage[stageId])?.paths ?? []
        ensureArtifactRefs([...persistedRefs, ...lifecycleRefs])
      }
    }

    if (input.skill?.id === 'requirement-analysis' && analysisState?.mainlineSchema.status !== 'missing') {
      if (!/(附件|资料|文档|artifact|prd|流程|原型|source|参考)/i.test(input.task)) artifacts = []
    }

    const analysisWorkingState = analysisState ? {
      version: analysisState.version,
      projection: buildAnalysisProjection(analysisState),
      fullStateChars: JSON.stringify(analysisState).length,
      readiness: analysisState.readiness
    } : undefined
    const analysisWorkingContext = analysisState ? {
      projection: buildAnalysisWorkingProjection(analysisState),
      fullStateChars: JSON.stringify(analysisState.working).length
    } : undefined
    const sharedWorkingState = { version: sharedRequirementState.version, projection: buildSharedProjection(sharedRequirementState), fullStateChars: JSON.stringify(sharedRequirementState).length, state: sharedRequirementState }
    const stageWorkingState = activeStageState ? {
      stageId: activeStageState.stageId, version: activeStageState.version, status: activeStageState.status,
      projection: buildStageProjection(activeStageState), readiness: activeStageState.readiness, fullStateChars: JSON.stringify(activeStageState).length
    } : undefined
    const upstreamStageContexts = taskContextPlan.upstreamStageIds.map((stageId) => {
      const state = stageStates.get(stageId)
      if (state) {
        return {
          stageId, version: state.version, status: state.status, source: 'stage-state' as const,
          projection: buildStageProjection(state), artifactRefs: [...state.artifactRefs]
        }
      }
      const lifecycleArtifact = requirement.lifecycle.artifacts.find((item) => item.id === lifecycleArtifactIdByStage[stageId])
      const artifactRefs = lifecycleArtifact?.paths ?? []
      return {
        stageId, version: lifecycleArtifact?.version ?? 0, status: 'artifact_only' as const, source: 'workspace-artifact' as const,
        projection: `[Stage Context ${stageId}] Canonical Stage State is unavailable. Workspace lifecycle reports ${lifecycleArtifact?.status ?? 'UNKNOWN'}. Do not infer missing business facts; read the referenced Artifact only if exact content is required.`,
        artifactRefs
      }
    })

    const inlineCurrentCandidate = taskContextPlan.currentStageCandidateMode === 'inline' ? rawCurrentStageCandidate : null
    const existingFlow = activeStageId === 'business-flow' && inlineCurrentCandidate ? inlineCurrentCandidate as ContextPackage['existingFlow'] : undefined
    const existingSolution = activeStageId === 'solution-design' && inlineCurrentCandidate ? inlineCurrentCandidate as ContextPackage['existingSolution'] : undefined
    const existingInteraction = activeStageId === 'interaction-design' && inlineCurrentCandidate ? inlineCurrentCandidate as ContextPackage['existingInteraction'] : undefined
    const existingPrototype = activeStageId === 'prototype' && inlineCurrentCandidate ? inlineCurrentCandidate as ContextPackage['existingPrototype'] : undefined
    const existingProductSpec = activeStageId === 'product-spec' && inlineCurrentCandidate ? inlineCurrentCandidate as ContextPackage['existingProductSpec'] : undefined
    let analysisBootstrap: ContextPackage['analysisBootstrap']
    let analysisInitialInput: string | undefined
    if (migratedHistoricalMainline) analysisBootstrap = { mode: 'historical', source: 'analysis_state' }
    if (input.skill?.id === 'requirement-analysis' && analysisState?.mainlineSchema.status === 'missing') {
      const populatedStage = activeStageState && Object.values(activeStageState.slots).some((value) => Array.isArray(value) && value.length > 0)
      const analysisArtifact = latestArtifacts(requirement.artifacts).find((item) => item.kind === 'Analysis')
      const downstreamArtifact = latestArtifacts(requirement.artifacts).find((item) => ['PRD', 'Business Flow', 'Interaction', 'Prototype', 'Solution'].includes(item.kind))
      const sourceInput = latestArtifacts(requirement.artifacts).find((item) => item.relativePath.startsWith('source/') && item.relativePath !== 'source/initial-request.txt')
      let priorUserMessages = thread.messages.filter((message) => message.role === 'user' && message.content.trim() !== input.task.trim())
      let source: NonNullable<ContextPackage['analysisBootstrap']>['source'] = populatedStage ? 'stage_state' : analysisArtifact ? 'analysis_artifact' : downstreamArtifact ? 'downstream_artifact'
        : sourceInput ? 'source_input' : 'none'
      if (source === 'none') {
        const allMessages = this.persistence.listMessages(input.threadId)
        priorUserMessages = allMessages.filter((message) => message.role === 'user' && message.content.trim() !== input.task.trim())
        if (allMessages.some((message) => message.role === 'assistant')) source = 'conversation'
      }
      const mode: NonNullable<ContextPackage['analysisBootstrap']>['mode'] = source === 'none' ? 'definition' : 'historical'
      analysisBootstrap = { mode, source }
      if (mode === 'historical') {
        const bootstrapArtifacts = latestArtifacts(requirement.artifacts).filter((item) =>
          item.kind === 'Analysis' || ['PRD', 'Business Flow', 'Interaction', 'Prototype', 'Solution'].includes(item.kind) || item.relativePath.startsWith('source/')
        ).slice(0, 6).map((artifact) => ({
          id: artifact.id, title: artifact.title, type: artifact.kind, path: artifact.relativePath,
          updatedAt: artifact.updatedAt, section: null, content: null
        }))
        artifacts = bootstrapArtifacts
        if (source === 'conversation') analysisInitialInput = priorUserMessages.map((message) => message.content).join('\n\n').slice(-12_000)
      } else {
        analysisInitialInput = priorUserMessages.map((message) => message.content).join('\n\n').slice(-12_000) || undefined
      }
    }
    const runtimePolicies = input.skill?.id === 'requirement-analysis' ? [{
      id: 'analysis-conversation-runtime',
      instruction: '需求分析由 Mainline 驱动。Conversation History 默认不注入；优先基于 Canonical Mainline + Working Context + Current User Input。普通 Turn 最终只调用一次 analysis_turn_submit；仅确需读取 Source/Artifact 时允许先调用最小读取工具。'
    }, {
      id: 'analysis-script-first',
      instruction: 'Rule First → Script First → Tool Second → Model Last。State Merge、Readiness、Question Resolve、Conflict Detection、Projection、ID、校验均由 Runtime 确定性执行，模型不得为这些动作额外调用模型或工具。'
    }, {
      id: 'analysis-evidence',
      instruction: 'Source 优先；模型推断必须标记 inferred，不能伪装 confirmed。只提出会改变产品结论的 1～5 个高价值问题。'
    }] : input.skill?.id === 'business-flow' ? [{
      id: 'business-flow-prerequisite',
      instruction: '正式 Business Flow 必须来源于已确认 Requirement Analysis；draft 探索不得升级为正式结论。'
    }, {
      id: 'business-flow-confirmation',
      instruction: 'Flow Model 是 Source of Truth；HTML 由 Tool 确定性渲染。Ready 后等待产品经理确认，确认前不得写入 Workspace。'
    }] : input.skill?.id === 'solution-design' ? [{
      id: 'solution-prerequisite',
      instruction: '正式 Solution Design 必须同时来源于已确认 Requirement Analysis 与已确认 Business Flow；前置未完成时只能做 Draft Exploration。'
    }, {
      id: 'solution-confirmation',
      instruction: 'Solution Model 是 Source of Truth；必须通过 Coverage 与 Overdesign Gate。Ready 后等待产品经理确认，确认前不得写入 Workspace。'
    }] : input.skill?.id === 'interaction-design' ? [{
      id: 'interaction-prerequisite',
      instruction: '正式 Interaction Design 必须来源于已确认 Requirement Analysis、Business Flow 与 Solution Design；Solution 未确认时只能 Draft Exploration。'
    }, {
      id: 'interaction-confirmation',
      instruction: 'Interaction Model 是 Source of Truth；Markdown 由 Tool 确定性渲染。Ready 后等待产品经理确认，确认前不得写入 Workspace 或生成 Prototype。'
    }] : input.skill?.id === 'prototype' ? [{
      id: 'prototype-prerequisite',
      instruction: '正式 Prototype 必须来源于最新已确认 Interaction Design；未确认时只能生成 Draft Prototype。'
    }, {
      id: 'prototype-existing-ui-first',
      instruction: '先判断 Existing Prototype；存在时只做局部 Delta。Candidate 先验证和预览，明确确认后才写入递增版本 HTML。'
    }] : input.skill?.id === 'product-spec' ? [{
      id: 'product-spec-prerequisite',
      instruction: '正式 PRD 要求已确认 Analysis、Flow、Solution，页面型需求还要求已确认 Interaction；Prototype 非强制，纯后台需求可为 N/A。'
    }, {
      id: 'product-spec-confirmation',
      instruction: 'Product Spec Model 是 Source of Truth；不得重设计上游。冲突或阻断未知必须等待澄清；Ready 后等待产品经理确认再写入版本化 PRD。'
    }] : input.skill?.id === 'requirement-review' ? [{
      id: 'requirement-review-prerequisite',
      instruction: '正式 Requirement Review 要求最新 Product Spec / PRD 已确认；Draft Review 不能形成最终 Ready Gate。'
    }, {
      id: 'requirement-review-boundary',
      instruction: 'Review 只检查、提供证据、影响与 recommended_stage；不得修改 Artifact、Decision、Open Issue 或 Requirement Stage。'
    }] : input.skill ? [{
      id: 'artifact-change-approval',
      instruction: '候选文件修改必须调用 artifact_diff；不得调用 artifact_write。写入只能在用户确认后由 ESPow 执行并校验。'
    }] : level === 'L0' ? [{
      id: 'snapshot-answer', instruction: 'Snapshot 足够时直接回答，不读取 Artifact。'
    }] : [{
      id: 'workspace-grounding', instruction: '只按需定位并读取与当前任务直接相关的 Artifact，不递归读取 Workspace。'
    }]
    if (activeStageId) runtimePolicies.unshift({
      id: 'lifecycle-stage-state',
      instruction: activeStageId === 'requirement-analysis'
        ? '当前生命周期阶段为 requirement-analysis。Analysis Mainline 是该阶段唯一 Canonical State；通用 Stage State 仅作为 UI/生命周期派生投影，不重复注入模型。'
        : `当前生命周期阶段为 ${activeStageId}。优先使用 Shared Requirement State + 当前 Stage State 槽位；不要把上游完整产物重放为工作记忆。每个阶段独立维护 slots/readiness/openQuestions/conflicts，阶段退出只依据该阶段 Readiness。`
    })

    const uiBaseline = input.skill?.id === 'prototype' && this.uiBaselineResolver
      ? await this.uiBaselineResolver.resolveContext(`${input.task}\n${stageWorkingState?.projection ?? ''}`) ?? undefined
      : undefined

    const contextPackage: ContextPackage = {
      level,
      mode,
      task: input.task,
      requirement: snapshot,
      decisions,
      openIssues,
      memories,
      artifacts,
      analysisWorkingState,
      analysisWorkingContext,
      analysisBootstrap,
      analysisInitialInput,
      sharedRequirementState: input.skill?.id === 'requirement-analysis' ? undefined : sharedWorkingState,
      stageWorkingState: input.skill?.id === 'requirement-analysis' ? undefined : stageWorkingState,
      upstreamStageContexts,
      taskContextPlan: {
        strategy: taskContextPlan.strategy, activeStageId: taskContextPlan.activeStageId, upstreamStageIds: taskContextPlan.upstreamStageIds,
        includeThreadHistory: taskContextPlan.includeThreadHistory, includeArtifactMetadata: taskContextPlan.includeArtifactMetadata,
        currentStageCandidateMode: taskContextPlan.currentStageCandidateMode, reason: taskContextPlan.reason
      },
      existingFlow,
      existingSolution,
      existingInteraction,
      existingPrototype,
      existingProductSpec,
      skill: input.skill ? {
        id: input.skill.id, name: input.skill.name, version: input.skill.version,
        mode: input.skill.mode, instructions: input.skill.instructions, loadMode: input.skill.loadMode ?? 'capsule'
      } : undefined,
      runtimePolicies,
      threadContext: {
        summary: taskContextPlan.includeThreadHistory ? thread.summary : null,
        messages: (taskContextPlan.includeThreadHistory ? thread.messages : [])
          .map(({ id, role, content, createdAt }) => ({ id, role, content, createdAt })),
        truncated: taskContextPlan.includeThreadHistory ? thread.truncated : thread.messages.length > 0 || thread.truncated,
        compactedMessageCount: taskContextPlan.includeThreadHistory ? thread.compactedMessageCount : thread.compactedMessageCount + thread.messages.length
      },
      workContext,
      uiBaseline
    }
    return { package: contextPackage, metadata: toMetadata(contextPackage, refreshedForRun) }
  }
}

export function serializeContextParts(context: ContextPackage): RuntimeContextPart[] {
  const promptSnapshot = context.requirement ? {
    requirementId: context.requirement.requirementId,
    name: context.requirement.name,
    currentGoal: context.requirement.currentGoal,
    currentStage: context.requirement.currentStage,
    currentStatus: context.requirement.currentStatus,
    mainArtifacts: context.requirement.mainArtifacts,
    keyDecisionIds: context.requirement.keyDecisionIds,
    openIssueIds: context.requirement.openIssueIds,
    recentImportantChanges: context.requirement.recentImportantChanges,
    lastUpdated: context.requirement.sourceUpdatedAt
  } : null
  const sections: RuntimeContextPart[] = []
  const push = (source: RuntimeContextSource, content: string): void => { sections.push({ source, content }) }
  push('workspace', `Requirement Snapshot:\n${JSON.stringify(promptSnapshot, null, 2)}`)
  if (context.decisions.length) push('workspace', `Selected Decisions:\n${JSON.stringify(context.decisions, null, 2)}`)
  if (context.openIssues.length) push('workspace', `Selected Open Issues:\n${JSON.stringify(context.openIssues, null, 2)}`)
  if (context.memories.length) push('workspace', `Relevant Long-term Memory:\n${JSON.stringify(context.memories.map(({ id, scope, category, content }) => ({ id, scope, category, content })), null, 2)}`)
  if (context.artifacts.length) push('artifact', `Candidate Artifact metadata (content not preloaded):\n${JSON.stringify(context.artifacts, null, 2)}`)
  if (context.workContext.used) push('workspace', `Relevant Work Context (long-term facts; do not copy into Requirement Mainline):\n${JSON.stringify({
    company: context.workContext.company,
    currentSystem: context.workContext.currentSystem,
    relations: context.workContext.relations,
    neighborSystems: context.workContext.neighborSystems
  }, null, 2)}`)
  if (context.uiBaseline) push('stage_slot', `Resolved UI Baseline (settings-level; minimal slice only; never revisit the learned website during Requirement execution):\n${JSON.stringify(context.uiBaseline, null, 2)}`)
  if (context.sharedRequirementState) push('workspace', `Shared Requirement State (cross-stage stable facts):\n${context.sharedRequirementState.projection}`)
  if (context.stageWorkingState) push('stage_slot', `Current Stage Mainline (canonical stage slots/readiness):\n${context.stageWorkingState.projection}`)
  if (context.upstreamStageContexts?.length) push('stage_slot', `Required Upstream Stage Context (compact projections; artifactRefs indicate exact sources to read only when necessary):\n${context.upstreamStageContexts.map((item) => `${item.projection}\nArtifactRefs: ${item.artifactRefs.join(', ') || '—'}`).join('\n\n')}`)
  if (context.taskContextPlan) push('stage_slot', `Task Context Plan:\nstrategy=${context.taskContextPlan.strategy}; activeStage=${context.taskContextPlan.activeStageId ?? 'none'}; upstream=${context.taskContextPlan.upstreamStageIds.join(',') || 'none'}; currentCandidate=${context.taskContextPlan.currentStageCandidateMode}; history=${context.taskContextPlan.includeThreadHistory ? 'included' : 'omitted'}\n${context.taskContextPlan.reason}`)
  if (context.analysisWorkingState) push('mainline', `Analysis Mainline (canonical current state):\n${context.analysisWorkingState.projection}`)
  if (context.analysisWorkingContext) push('working', `Analysis Working Context (short-lived):\n${context.analysisWorkingContext.projection}`)
  if (context.analysisBootstrap) push('working', `Mainline initialization mode:\n${JSON.stringify(context.analysisBootstrap, null, 2)}`)
  if (context.analysisInitialInput) push('user', `Original / bootstrap input (one-time, not conversation memory):\n${context.analysisInitialInput}`)
  if (context.existingAnalysis) push('artifact', `Existing Requirement Analysis candidate (do not repeat answered questions):\n${JSON.stringify(context.existingAnalysis, null, 2)}`)
  if (context.existingFlow) push('stage_slot', `Current Business Flow candidate (same-stage Delta source; do not rebuild from history):\n${JSON.stringify(context.existingFlow, null, 2)}`)
  if (context.existingSolution) push('stage_slot', `Current Solution Design candidate (same-stage Delta source; do not rebuild upstream):\n${JSON.stringify(context.existingSolution, null, 2)}`)
  if (context.existingInteraction) push('stage_slot', `Current Interaction Design candidate (same-stage Delta source):\n${JSON.stringify(context.existingInteraction, null, 2)}`)
  if (context.existingPrototype) push('stage_slot', `Current Prototype candidate metadata (same-stage Delta source):\n${JSON.stringify(context.existingPrototype, null, 2)}`)
  if (context.existingProductSpec) push('stage_slot', `Current Product Spec candidate (same-stage Delta source; upstream remains compact):\n${JSON.stringify(context.existingProductSpec, null, 2)}`)
  if (context.threadContext.summary) push('history', `Thread Summary (compacted, not a formal fact source):\n${context.threadContext.summary}`)
  if (context.threadContext.messages.length) push('history', `Recent Thread History:\n${JSON.stringify(context.threadContext.messages.map(({ role, content }) => ({ role, content })), null, 2)}`)
  if (context.skill) push('skill', `<espow_skill id="${context.skill.id}" version="${context.skill.version}" mode="${context.skill.mode}" load="${context.skill.loadMode}">\n${context.skill.instructions}\n</espow_skill>`)
  push('stage_slot', `Runtime Policies:\n${context.runtimePolicies.map((item) => `${item.id}: ${item.instruction}`).join('\n')}`)
  const stagePolicy: Record<string, string> = {
    'requirement-change': 'Delta：只读直接相关 Artifact；完成语义影响判断后提交 change_result_submit；已有正式产物只做受影响部分的下一版本 Candidate，不覆盖旧版本。',
    'requirement-analysis': 'Analysis：以 Mainline/Working 为当前事实；只提交本轮 Delta；每轮最终且仅调用一次 analysis_turn_submit；Readiness/merge/ID/冲突由 Runtime 计算；用户确认前不写正式 Analysis Artifact。',
    'business-flow': 'Flow：读取已确认 Analysis；按 next_version → ready → submit 形成候选；用户确认前不 write，不重新做需求分析。',
    'solution-design': 'Solution：读取已确认 Analysis + 最新 confirmed Flow；按 next_version → coverage/overdesign checks → submit；用户确认前不 write，不修改上游 Flow。',
    'interaction-design': 'Interaction：读取已确认 Analysis/Flow/Solution；按 next_version → ready → submit；用户确认前不 write，不生成 Prototype。',
    prototype: 'Prototype：读取最新 Interaction，必要时读取 Solution/Existing Prototype/UI Baseline；Existing UI First；按 next_version → ready → submit；用户确认前不 write。',
    'product-spec': 'PRD：按需读取已确认上游；只收敛不重做上游；按 next_version → ready → submit；阻断未知保持 WAITING_CLARIFICATION；用户确认前不 write。',
    'requirement-review': 'Review：只读取当前有效版本；按 next_version → ready → submit；只定位问题和推荐返回 Stage，不自动修复或回退；用户确认前不 write。'
  }
  if (context.skill && stagePolicy[context.skill.id]) push('stage_slot', `Stage Execution Contract:
${stagePolicy[context.skill.id]}`)
  push('user', `当前任务：\n${context.task}`)
  return sections
}

export function serializeContextPackage(context: ContextPackage): string {
  return serializeContextParts(context).map((part) => part.content).join('\n\n')
}
