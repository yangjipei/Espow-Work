import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import type { ChatStart, ExecutionActivity, ModelStreamEvent, StartChatRequest } from '../src/model'
import { modelIpc } from '../src/model'
import { PersistenceService } from './persistenceService'
import { ESPOW_SYSTEM_PROMPT, RuntimeService, toolSpecs } from './runtime/runtimeService'
import { LocalWorkspaceService } from './workspaceService'
import { EspowToolService, type ToolName } from './tools/toolService'
import type { ApprovalResolution, ToolCallRecord, WriteApprovalRequest } from '../src/tools'
import type { ToolBridgeEvent } from './tools/toolBridge'
import { SkillRegistry, type SelectedSkill } from './skills/skillRegistry'
import type { BusinessFlowResult, ChangeResult, InteractionDesignResult, ProductSpecResult, PrototypeResult, RequirementReviewResult, SolutionDesignResult } from '../src/skills'
import type { ContextPackage } from '../src/context'
import type { RunRecord } from '../src/persistence'
import { ContextManager, serializeContextParts } from './runtime/contextManager'
import { applyContextBudget } from './runtime/contextBudget'
import { LifecycleEngine } from './runtime/lifecycleEngine'
import { runtimeExecutionPlan, shouldUseLLM, type LlmGateDecision, type RuntimeAction } from './runtime/executionPolicy'
import type { ExplicitSlotUpdate } from './runtime/explicitSlotRouter'
import type { DeterministicQuery } from './runtime/deterministicMessageRouter'
import { routeSlotEditor } from './runtime/slotRouter'
import { resolveTools } from './runtime/toolResolver'
import { routeTurn, type RecognizedIntent } from './runtime/turnRouter'
import { IntentRecognitionService, type IntentRecognitionResult } from './runtime/intentRecognition'
import { calculateAnalysisReadiness } from './runtime/analysisStateEngine'
import { applyStageSlotUpdates, createStageState, markDownstreamStagesStale } from './runtime/lifecycleStageStateEngine'
import { lifecycleStageOrder } from '../src/lifecycleStageState'
import { addDiagnosticBreadcrumb, reportDiagnostic, reportDiagnosticError } from './diagnostics/diagnosticBridge'

interface PendingStage {
  stageId: (typeof lifecycleStageOrder)[number]
  run: RunRecord
}

function modelAction(skill: SelectedSkill | null): RuntimeAction {
  if (!skill) return 'UNDERSTAND_AMBIGUOUS_INPUT'
  if (skill.id === 'requirement-analysis') return 'ANALYZE_REQUIREMENT'
  if (skill.id === 'requirement-change') return 'ASSESS_REQUIREMENT_CHANGE'
  if (skill.id === 'requirement-review') return 'REVIEW_REQUIREMENT'
  return 'GENERATE_STAGE_ARTIFACT'
}

export class AgentTaskService {
  private activeRunId: string | null = null
  private activeSender: WebContents | null = null

  constructor(
    private readonly persistence: PersistenceService,
    private readonly workspace: LocalWorkspaceService,
    private readonly runtime: RuntimeService,
    private readonly tools: EspowToolService,
    private readonly skills: SkillRegistry,
    private readonly contextManager: ContextManager,
    private readonly lifecycle: LifecycleEngine,
    private readonly intentRecognition: IntentRecognitionService | null = null
  ) {}

  async startChat(sender: WebContents, request: StartChatRequest): Promise<ChatStart> {
    if (this.activeRunId) throw new Error('当前已有 Agent Run 正在执行。')
    if (!request.content.trim()) throw new Error('消息内容不能为空。')
    if (request.replaceMessageId) {
      this.persistence.truncateThreadFromUserMessage(request.threadId, request.replaceMessageId)
    }
    if (request.slotTarget) {
      const slotRoute = routeSlotEditor(request.slotTarget, request.content)
      if (!slotRoute) throw new Error('明确槽位或内容无效。')
      return this.startExplicitSlotUpdate(sender, request, slotRoute)
    }
    const pendingStages = this.pendingStages(request.threadId)
    const pendingStage = pendingStages[0] ?? null
    const currentStage = pendingStage?.stageId ?? this.currentRuntimeStage(request.requirementId)
    const turnRoute = routeTurn(request.content, currentStage, request.controlEvent)
    if (turnRoute.path === 'script' && turnRoute.intent === 'requirement-query') {
      return this.startDeterministicQuery(sender, request, turnRoute.query)
    }
    if (turnRoute.path === 'script' && turnRoute.intent === 'explicit-slot-update') return this.startExplicitSlotUpdate(sender, request, turnRoute.update)

    let recognition: IntentRecognitionResult | null = null
    let recognized: RecognizedIntent | null = turnRoute.path === 'script' && turnRoute.intent === 'runtime-control'
      ? turnRoute.recognized : null
    let config: ReturnType<PersistenceService['getActiveModelConfig']> | null = null
    if (!recognized && turnRoute.path === 'recognition' && this.intentRecognition) {
      config = this.persistence.getActiveModelConfig()
      const openQuestion = this.persistence.getAnalysisState(request.requirementId, request.threadId)?.openQuestions
        .find((item) => item.status === 'open') ?? null
      recognition = await this.intentRecognition.recognize({
        message: request.content,
        currentStage,
        pendingQuestion: openQuestion ? { id: openQuestion.id, question: openQuestion.question } : null
      }, config)
      recognized = recognition.recognized
    }

    if (recognized && ['CONFIRM_STAGE', 'CONTINUE_STAGE', 'REJECT_STAGE'].includes(recognized.intent)) {
      if (!pendingStage || recognized.targetStage !== pendingStage.stageId) {
        return this.startIntentFallback(sender, request, config, recognition, '当前没有与该操作匹配的待确认阶段。')
      }
      if (recognized.intent === 'REJECT_STAGE') return this.rejectPendingStage(pendingStage, request.content)
      return this.confirmPendingStage(sender, pendingStage, request.content)
    }

    if (recognized?.intent === 'UNKNOWN') {
      return this.startIntentFallback(sender, request, config, recognition, '我无法可靠判断你想执行的操作。请明确说明是提问、补充/修改需求，还是确认/拒绝当前阶段。')
    }

    const pendingAnalysis = this.persistence.getPendingAnalysis(request.threadId)
    const pendingFlow = this.persistence.getPendingFlow(request.threadId)
    const pendingSolution = this.persistence.getPendingSolution(request.threadId)
    const pendingInteraction = this.persistence.getPendingInteraction(request.threadId)
    const pendingPrototype = this.persistence.getPendingPrototype(request.threadId)
    const pendingProductSpec = this.persistence.getPendingProductSpec(request.threadId)
    const pendingRequirementReview = this.persistence.getPendingRequirementReview(request.threadId)
    const previousAnalysis = pendingAnalysis ? null : this.persistence.getLatestAnalysis(request.requirementId, request.threadId)
    const continuingAnalysis = Boolean(previousAnalysis
      && previousAnalysis.result.analysisStatus === 'Analyzing')
    const previousFlow = pendingFlow ? null : this.persistence.getLatestFlow(request.requirementId, request.threadId)
    const continuingFlow = Boolean(previousFlow
      && ['DRAFT', 'WAITING_CLARIFICATION'].includes(previousFlow.result.flowStatus))
    const previousSolution = pendingSolution ? null : this.persistence.getLatestSolution(request.requirementId, request.threadId)
    const continuingSolution = Boolean(previousSolution
      && ['DRAFT', 'WAITING_CLARIFICATION'].includes(previousSolution.result.solutionStatus))
    const previousInteraction = pendingInteraction ? null : this.persistence.getLatestInteraction(request.requirementId, request.threadId)
    const continuingInteraction = Boolean(previousInteraction
      && ['DRAFT', 'WAITING_CLARIFICATION'].includes(previousInteraction.result.interactionStatus))
    const previousPrototype = pendingPrototype ? null : this.persistence.getLatestPrototype(request.requirementId, request.threadId)
    const continuingPrototype = Boolean(previousPrototype
      && ['DRAFT', 'WAITING_CLARIFICATION'].includes(previousPrototype.result.prototypeStatus))
    const previousProductSpec = pendingProductSpec ? null : this.persistence.getLatestProductSpec(request.requirementId, request.threadId)
    const continuingProductSpec = Boolean(previousProductSpec
      && ['DRAFT', 'WAITING_CLARIFICATION'].includes(previousProductSpec.result.productSpecStatus))
    const previousRequirementReview = pendingRequirementReview ? null : this.persistence.getLatestRequirementReview(request.requirementId, request.threadId)
    const continuingRequirementReview = Boolean(previousRequirementReview
      && previousRequirementReview.result.reviewStatus === 'DRAFT_REVIEW')
    const structuredSkillId = recognized
      ? this.skillIdForIntent(recognized, currentStage)
      : null
    let skill = recognized
      ? structuredSkillId ? this.skills.selectById(structuredSkillId, request.content) : null
      : structuredSkillId ? this.skills.selectById(structuredSkillId, request.content) : this.skills.select(
          request.content,
          Boolean(pendingAnalysis) || continuingAnalysis,
          Boolean(pendingFlow) || continuingFlow,
          Boolean(pendingSolution) || continuingSolution,
          Boolean(pendingInteraction) || continuingInteraction,
          Boolean(pendingPrototype) || continuingPrototype,
          Boolean(pendingProductSpec) || continuingProductSpec,
          Boolean(pendingRequirementReview) || continuingRequirementReview
        )
    if (!skill && !recognized && turnRoute.path === 'agent' && currentStage) {
      skill = this.skills.selectById(currentStage, request.content)
    }
    const invalidatesPending = recognized
      ? ['MODIFY_REQUIREMENT', 'PROVIDE_INFORMATION', 'ANSWER_CLARIFICATION', 'REQUEST_ARTIFACT'].includes(recognized.intent)
      : turnRoute.path === 'agent' && skill !== null
    if (invalidatesPending) {
      for (const pending of pendingStages) {
        const superseded = this.supersedePendingStage(pending)
        this.emit(sender, { type: 'run_updated', runId: superseded.id, threadId: superseded.threadId, run: superseded })
      }
    }

    if (skill && this.lifecycle.isGatedSkill(skill.id)) {
      const requirement = await this.workspace.refreshRequirement(request.requirementId)
      const missing = this.lifecycle.missingPrerequisites(requirement, skill.id)
      if (missing.length) return this.startPrerequisiteBlocked(sender, request, skill, missing)
    }
    if (skill?.clarificationRequired) {
      const started = this.persistence.startRun(
        request.workspaceId, request.requirementId, request.threadId, request.content, null, undefined, skill, null
      )
      this.activeRunId = started.run.id
      this.activeSender = sender
      setTimeout(() => this.completeClarification(sender, started, skill), 0)
      return started
    }
    const gate = shouldUseLLM({
      action: modelAction(skill), caller: 'AgentTaskService.startChat', task: request.content, stage: skill?.id ?? null
    })
    if (!gate.allow) throw new Error(`LLM Gate 拒绝执行：${gate.reason}`)
    config ??= this.persistence.getActiveModelConfig()
    const context = await this.contextManager.build({
      workspaceId: request.workspaceId, requirementId: request.requirementId, threadId: request.threadId,
      task: request.content, skill
    })
    const toolResolution = resolveTools(request.content, skill)
    const allowedTools = toolResolution.tools
    const started = this.persistence.startRun(
      request.workspaceId,
      request.requirementId,
      request.threadId,
      request.content,
      config,
      { type: 'espow-runtime' },
      skill,
      context.metadata
    )
    if (recognized) {
      this.persistence.recordRuntimeEvent(started.run.id, 'intent_recognized', {
        inputType: request.controlEvent ? 'UI_EVENT' : 'FREE_TEXT',
        intentRecognitionUsed: recognized.source === 'LLM',
        recognizedIntent: recognized.intent,
        intentConfidence: recognized.confidence,
        intentSource: recognized.source,
        targetStage: recognized.targetStage,
        routeSelected: structuredSkillId ?? 'GENERAL_RESPONSE_PATH',
        reasoningUsed: recognized.needsReasoning
      })
      if (recognition?.usage) {
        this.persistence.recordTokenUsage(started.run.id, recognition.usage, new Date().toISOString(), 'Intent Recognition', 1, {
          turnId: started.run.turnId ?? undefined, callId: `intent-${started.run.id}`, callReason: 'decision', durationMs: recognition.durationMs
        })
      }
    }
    this.persistence.recordRuntimeEvent(started.run.id, 'model_gate_evaluated', {
      ...gate, contextSources: context.metadata.sources,
      executionPath: 'LLM',
      contextMode: context.package.mode,
      contextLevelFinal: context.package.level,
      skillMode: skill?.loadMode ?? null,
      toolsInjected: allowedTools,
      toolResolutionMode: toolResolution.mode,
      toolResolutionReason: toolResolution.reason,
      intent: recognized?.intent ?? turnRoute.intent,
      intentRecognitionUsed: recognized?.source === 'LLM',
      intentConfidence: recognized?.confidence ?? 1,
      routeSelected: structuredSkillId ?? skill?.id ?? 'general',
      mainlineRead: Boolean(context.package.analysisWorkingState),
      sourceReadAllowed: allowedTools.includes('artifact_read'),
      requirementAnalysisCalled: skill?.id === 'requirement-analysis',
      questionGeneratorAllowed: skill?.id === 'requirement-analysis' && !context.package.analysisWorkingState?.readiness.readyForConfirmation
    })
    this.activeRunId = started.run.id
    this.activeSender = sender
    setTimeout(() => void this.execute(sender, started, config, context.package, allowedTools, gate), 0)
    return started
  }

  private pendingStages(threadId: string): PendingStage[] {
    const candidates: Array<PendingStage | null> = [
      this.persistence.getPendingAnalysis(threadId) ? { stageId: 'requirement-analysis', run: this.persistence.getPendingAnalysis(threadId)! } : null,
      this.persistence.getPendingFlow(threadId) ? { stageId: 'business-flow', run: this.persistence.getPendingFlow(threadId)! } : null,
      this.persistence.getPendingSolution(threadId) ? { stageId: 'solution-design', run: this.persistence.getPendingSolution(threadId)! } : null,
      this.persistence.getPendingInteraction(threadId) ? { stageId: 'interaction-design', run: this.persistence.getPendingInteraction(threadId)! } : null,
      this.persistence.getPendingPrototype(threadId) ? { stageId: 'prototype', run: this.persistence.getPendingPrototype(threadId)! } : null,
      this.persistence.getPendingProductSpec(threadId) ? { stageId: 'product-spec', run: this.persistence.getPendingProductSpec(threadId)! } : null,
      this.persistence.getPendingRequirementReview(threadId) ? { stageId: 'requirement-review', run: this.persistence.getPendingRequirementReview(threadId)! } : null
    ]
    return candidates.filter((item): item is PendingStage => item !== null)
      .sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt))
  }

  private currentRuntimeStage(requirementId: string): PendingStage['stageId'] | null {
    let hasStageState = false
    for (const stageId of lifecycleStageOrder) {
      const state = this.persistence.getLifecycleStageState(requirementId, stageId)
      hasStageState ||= state !== null
      if (state && state.status !== 'confirmed' && state.status !== 'not_applicable') return stageId
    }
    return hasStageState ? null : 'requirement-analysis'
  }

  private skillIdForIntent(intent: RecognizedIntent, currentStage: PendingStage['stageId'] | null): string | null {
    if (intent.intent === 'MODIFY_REQUIREMENT') return 'requirement-change'
    const stage = intent.targetStage ?? currentStage
    if (intent.intent === 'ANSWER_CLARIFICATION' || intent.intent === 'PROVIDE_INFORMATION') return stage ?? 'requirement-analysis'
    if (intent.intent === 'REQUEST_ARTIFACT') return stage
    return null
  }

  private confirmPendingStage(sender: WebContents, pending: PendingStage, content: string): ChatStart {
    let started: ChatStart
    switch (pending.stageId) {
      case 'requirement-analysis': started = this.persistence.beginAnalysisConfirmation(pending.run.id, content); break
      case 'business-flow': started = this.persistence.beginFlowConfirmation(pending.run.id, content); break
      case 'solution-design': started = this.persistence.beginSolutionConfirmation(pending.run.id, content); break
      case 'interaction-design': started = this.persistence.beginInteractionConfirmation(pending.run.id, content); break
      case 'prototype': started = this.persistence.beginPrototypeConfirmation(pending.run.id, content); break
      case 'product-spec': started = this.persistence.beginProductSpecConfirmation(pending.run.id, content); break
      case 'requirement-review': started = this.persistence.beginRequirementReviewConfirmation(pending.run.id, content); break
    }
    this.activeRunId = started.run.id
    this.activeSender = sender
    const execute = {
      'requirement-analysis': this.executeAnalysisConfirmation.bind(this),
      'business-flow': this.executeFlowConfirmation.bind(this),
      'solution-design': this.executeSolutionConfirmation.bind(this),
      'interaction-design': this.executeInteractionConfirmation.bind(this),
      prototype: this.executePrototypeConfirmation.bind(this),
      'product-spec': this.executeProductSpecConfirmation.bind(this),
      'requirement-review': this.executeRequirementReviewConfirmation.bind(this)
    }[pending.stageId]
    setTimeout(() => void execute(sender, started), 0)
    return started
  }

  private rejectPendingStage(pending: PendingStage, content: string): ChatStart {
    switch (pending.stageId) {
      case 'requirement-analysis': return this.persistence.rejectFlowConfirmation(pending.run.id, content)
      case 'business-flow': return this.persistence.rejectFlowConfirmation(pending.run.id, content)
      case 'solution-design': return this.persistence.rejectSolutionConfirmation(pending.run.id, content)
      case 'interaction-design': return this.persistence.rejectInteractionConfirmation(pending.run.id, content)
      case 'prototype': return this.persistence.rejectPrototypeConfirmation(pending.run.id, content)
      case 'product-spec': return this.persistence.rejectProductSpecConfirmation(pending.run.id, content)
      case 'requirement-review': return this.persistence.rejectRequirementReviewConfirmation(pending.run.id, content)
    }
  }

  private supersedePendingStage(pending: PendingStage): RunRecord {
    return this.persistence.supersedeFlowConfirmation(pending.run.id)
  }

  private startIntentFallback(
    sender: WebContents,
    request: StartChatRequest,
    config: ReturnType<PersistenceService['getActiveModelConfig']> | null,
    recognition: IntentRecognitionResult | null,
    reply: string
  ): ChatStart {
    const started = this.persistence.startRun(
      request.workspaceId, request.requirementId, request.threadId, request.content,
      config, config ? { type: 'espow-runtime' } : undefined, null, null
    )
    this.persistence.recordRuntimeEvent(started.run.id, 'intent_recognized', {
      inputType: request.controlEvent ? 'UI_EVENT' : 'FREE_TEXT',
      intentRecognitionUsed: recognition !== null,
      recognizedIntent: recognition?.recognized.intent ?? 'UNKNOWN',
      intentConfidence: recognition?.recognized.confidence ?? 0,
      routeSelected: 'SAFE_FALLBACK_PATH',
      reasoningUsed: false
    })
    if (recognition?.usage) {
      this.persistence.recordTokenUsage(started.run.id, recognition.usage, new Date().toISOString(), 'Intent Recognition', 1, {
        turnId: started.run.turnId ?? undefined, callId: `intent-${started.run.id}`, callReason: 'decision', durationMs: recognition.durationMs
      })
    }
    this.activeRunId = started.run.id
    this.activeSender = sender
    setTimeout(() => {
      const completed = this.persistence.completeRun(started.run.id, reply)
      this.releaseActive(started.run.id)
      this.emit(sender, { type: 'completed', runId: started.run.id, threadId: started.run.threadId, ...completed })
    }, 0)
    return started
  }

  async cancelChat(runId: string): Promise<boolean> {
    if (this.activeRunId !== runId) return false
    const sender = this.activeSender
    const cancelling = this.persistence.beginCancellation(runId)
    if (sender) this.emit(sender, { type: 'run_updated', runId, threadId: cancelling.threadId, run: cancelling })
    let confirmed = false
    try { confirmed = await this.runtime.cancel() } catch { confirmed = false }
    const run = confirmed
      ? this.persistence.completeCancellation(runId)
      : this.persistence.interruptRun(runId, '取消请求未得到 Runtime 确认，本次 Run 已标记为 Interrupted。')
    this.releaseActive(runId)
    if (sender) {
      if (run.status === 'Cancelled') this.emit(sender, { type: 'cancelled', runId, threadId: run.threadId, run })
      else this.emit(sender, { type: 'error', runId, threadId: run.threadId, error: run.error ?? 'Run 已中断。', run })
    }
    return true
  }

  async resolveApproval(runId: string, approved: boolean): Promise<ApprovalResolution> {
    const run = this.persistence.getRun(runId)
    const pending = run.approval
    if (!pending || pending.status !== 'Pending') throw new Error('Run 没有待处理的 Approval。')
    const resolvedAt = new Date().toISOString()
    if (!approved) {
      const approval: WriteApprovalRequest = { ...pending, status: 'Denied', resolvedAt }
      return { approval, run: this.persistence.claimApproval(runId, approval, false) }
    }
    const approval: WriteApprovalRequest = { ...pending, status: 'Approved', resolvedAt }
    this.persistence.claimApproval(runId, approval, true)
    try {
      const version = approval.writeMode === 'overwrite' ? { targetPath: approval.sourcePath } : await this.executeApprovedTool(runId, 'artifact_next_version', {
          requirementId: run.requirementId,
          artifactId: approval.sourceArtifactId
        }, approval)
      if (typeof version.targetPath !== 'string') throw new Error('Artifact 写入目标路径无效。')
      await this.executeApprovedTool(runId, 'artifact_write', {
        requirementId: run.requirementId,
        approvalId: approval.id,
        targetPath: version.targetPath
      }, approval)
      await this.executeApprovedTool(runId, 'workspace_validate', {
        requirementId: run.requirementId,
        path: version.targetPath,
        sourcePath: approval.writeMode === 'new-version' ? approval.sourcePath : undefined
      }, approval)
      return { approval, run: this.persistence.resolveApproval(runId, approval, 'Completed') }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Artifact 写入或校验失败。'
      return { approval, run: this.persistence.resolveApproval(runId, approval, 'Failed', message) }
    }
  }

  private async execute(
    sender: WebContents,
    started: ChatStart,
    config: ReturnType<PersistenceService['getActiveModelConfig']>,
    contextPackage: ContextPackage,
    allowedTools: string[],
    gate: LlmGateDecision
  ): Promise<void> {
    const events = [...started.run.runtimeEvents]
    let content = ''
    let terminal = false
    try {
      const context = this.workspace.getRuntimeContext(started.run.requirementId)
      if (!started.run.turnId) throw new Error('Run 缺少 ESPow Turn ID。')
      const executionPlan = runtimeExecutionPlan(started.run.skill, allowedTools, gate)
      const rawContextParts = serializeContextParts(contextPackage)
      const budget = applyContextBudget({
        parts: rawContextParts,
        systemPrompt: ESPOW_SYSTEM_PROMPT,
        tools: toolSpecs(executionPlan.allowedTools),
        maxInputTokens: gate.maxInputTokens
      })
      const contextParts = budget.parts
      this.persistence.recordRuntimeEvent(started.run.id, 'context_budget_applied', {
        maxInputTokens: budget.maxInputTokens,
        fixedTokens: budget.fixedTokens,
        estimatedTokensBefore: budget.estimatedTokensBefore,
        estimatedTokensAfter: budget.estimatedTokensAfter,
        droppedSources: budget.droppedSources,
        droppedPartCount: budget.droppedPartCount
      })
      const callReason = contextPackage.analysisBootstrap?.mode === 'historical'
        ? 'mainline_bootstrap' as const
        : gate.action === 'ANALYZE_REQUIREMENT' || gate.action === 'REVIEW_REQUIREMENT' || gate.action === 'UNDERSTAND_AMBIGUOUS_INPUT'
        ? 'analysis' as const
        : gate.action === 'GENERATE_STAGE_ARTIFACT'
          ? 'generation' as const
          : gate.action === 'ASSESS_REQUIREMENT_CHANGE'
            ? 'decision' as const
            : 'other' as const
      const stream = await this.runtime.run(
        context.cwd,
        config,
        { runId: started.run.id, threadId: started.run.threadId, turnId: started.run.turnId },
        contextParts.map((part) => part.content).join('\n\n'),
        {
          runId: started.run.id,
          workspaceId: started.run.workspaceId,
          requirementId: started.run.requirementId,
          contextPackage,
          onEvent: (event) => this.handleToolEvent(sender, started.run.id, started.run.threadId, event)
        },
        executionPlan.allowedTools,
        {
          maxSteps: executionPlan.maxSteps,
          maxModelCalls: executionPlan.maxModelCalls,
          maxInputTokens: gate.maxInputTokens,
          maxOutputTokens: gate.maxOutputTokens,
          terminalTool: executionPlan.terminalTool,
          contextParts,
          callReason
        }
      )
      for await (const event of stream) {
        if (events.at(-1) !== event.type) events.push(event.type)
        if (event.type !== 'message_delta') {
          this.persistence.recordRuntimeEvent(started.run.id, event.type, event.type === 'model_usage' ? {
            ...event,
            stage: gate.stage,
            slot: gate.slot,
            executionMode: gate.mode,
            reason: gate.reason,
            contextLevelFinal: contextPackage.level,
            maxCalls: gate.maxCalls,
            maxInputTokens: gate.maxInputTokens,
            currentCallIndex: event.step ?? 1,
            estimatedInputTokens: event.usage?.inputTokens ?? 0,
            actualInputTokens: event.usage?.inputTokens ?? 0,
            actualOutputTokens: event.usage?.outputTokens ?? 0,
            maxOutputTokens: gate.maxOutputTokens,
            budgetExceeded: (event.usage?.outputTokens ?? 0) > gate.maxOutputTokens,
            blockedReason: null
          } : event, event.createdAt)
        }
        const diagnosticContext = {
          workspaceId: started.run.workspaceId, sessionId: started.run.threadId, runId: started.run.id,
          stage: gate.stage ?? undefined, slot: gate.slot ?? undefined, provider: config.provider, model: config.model
        }
        if (event.type === 'run_started') {
          addDiagnosticBreadcrumb({ layer: 'runtime', action: 'run_start', status: 'start', workspaceId: started.run.workspaceId, runId: started.run.id })
          reportDiagnostic({ level: 'info', layer: 'runtime', module: 'AgentRuntime', operation: 'run.start', ...diagnosticContext })
        } else if (event.type === 'model_started') {
          addDiagnosticBreadcrumb({ layer: 'model', action: 'model_request', status: 'start', workspaceId: started.run.workspaceId, runId: started.run.id })
        } else if (event.type === 'model_usage' && event.usage) {
          reportDiagnostic({ level: 'info', layer: 'model', module: 'ModelGateway', operation: 'request.complete', ...diagnosticContext, inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens, durationMs: event.durationMs })
        } else if (event.type === 'tool_started') {
          addDiagnosticBreadcrumb({ layer: 'tool', action: `tool_start:${event.toolName ?? 'unknown'}`, status: 'start', workspaceId: started.run.workspaceId, runId: started.run.id })
        } else if (event.type === 'tool_completed') {
          addDiagnosticBreadcrumb({ layer: 'tool', action: `tool_complete:${event.toolName ?? 'unknown'}`, status: 'success', workspaceId: started.run.workspaceId, runId: started.run.id })
        } else if (event.type === 'run_completed') {
          addDiagnosticBreadcrumb({ layer: 'runtime', action: 'run_complete', status: 'success', workspaceId: started.run.workspaceId, runId: started.run.id })
          reportDiagnostic({ level: 'info', layer: 'runtime', module: 'AgentRuntime', operation: 'run.complete', ...diagnosticContext })
        } else if (event.type === 'run_failed') {
          const modelFailure = event.errorCode?.startsWith('MODEL_') === true
          const code = modelFailure ? event.errorCode! : 'RUNTIME_UNHANDLED_ERROR'
          reportDiagnosticError(new Error(event.error ?? 'Agent Runtime 执行失败。'), { layer: modelFailure ? 'model' : 'runtime', module: modelFailure ? 'ModelGateway' : 'AgentRuntime', operation: 'run.failed', errorCode: code, ...diagnosticContext })
        }
        if (event.type === 'model_started') {
          const step = event.step ?? 1
          this.emitActivity(sender, started.run.id, started.run.threadId, {
            id: `model-${step}`, kind: 'model', name: 'model_call',
            label: started.run.skill === 'requirement-analysis' ? '正在理解你的补充信息' : '正在调用大模型',
            status: 'running', startedAt: event.createdAt ?? new Date().toISOString(), detail: `Agent Step ${step}`
          })
        }
        if (event.type === 'model_usage' && event.usage) {
          const step = event.step ?? 1
          this.emitActivity(sender, started.run.id, started.run.threadId, {
            id: `model-${step}`, kind: 'model', name: 'model_call',
            label: started.run.skill === 'requirement-analysis' ? '已完成本轮语义分析' : '大模型调用完成',
            status: 'success', startedAt: event.createdAt ?? new Date().toISOString(), endedAt: event.createdAt ?? new Date().toISOString(),
            detail: event.executionContent ?? `Agent Step ${step}`,
            inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens, tokenCost: event.usage.totalTokens
          })
          this.persistence.recordTokenUsage(
            started.run.id,
            event.usage,
            event.createdAt ?? new Date().toISOString(),
            `${gate.reason} · ${event.executionContent ?? '模型调用'}`,
            event.step ?? null,
            {
              ...(event.metrics ?? {}),
              turnId: event.turnId,
              callId: event.modelCallId ?? null,
              callReason: event.callReason ?? callReason,
              durationMs: event.durationMs ?? null,
              historyTokens: event.metrics?.historyTokens ?? 0,
              analysisProjectionChars: contextPackage.analysisWorkingState?.projection.length ?? 0,
              recentConversationChars: contextPackage.threadContext.messages.reduce((sum, message) => sum + message.content.length, 0),
              fullAnalysisStateChars: contextPackage.analysisWorkingState?.fullStateChars ?? 0
            }
          )
        } else if (event.type === 'message_delta' && event.delta) {
          content += event.delta
          this.emit(sender, {
            type: 'delta', runId: started.run.id, threadId: started.run.threadId, delta: event.delta
          })
        } else if (event.type === 'message_completed') {
          if (typeof event.content === 'string' && event.content.trim()) content = event.content
        } else if (event.type === 'run_failed') {
          terminal = true
          const message = event.error ?? 'Agent Runtime 执行失败。'
          this.persistence.updateRunRuntimeEvents(started.run.id, events)
          const failed = this.persistence.failRun(started.run.id, message)
          this.releaseActive(started.run.id)
          this.emit(sender, {
            type: 'error', runId: started.run.id, threadId: started.run.threadId, error: message, run: failed
          })
        } else if (event.type === 'run_cancelled') {
          terminal = true
          if (this.activeRunId === started.run.id) {
            const cancelled = this.persistence.cancelRun(started.run.id)
            this.releaseActive(started.run.id)
            this.emit(sender, { type: 'cancelled', runId: started.run.id, threadId: started.run.threadId, run: cancelled })
          }
        } else if (event.type === 'run_completed') {
          terminal = true
          if (!content.trim()) throw new Error('Agent Runtime 没有返回可显示的回复。')
          const current = this.persistence.getRun(started.run.id)
          if (current.skill === 'requirement-change' && !current.changeResult) {
            throw new Error('requirement-change 未提交结构化 Change Result。')
          }
          if (current.skill === 'requirement-analysis' && !current.analysisResult) {
            throw new Error('requirement-analysis 未提交结构化 Requirement Analysis Result。')
          }
          if (current.skill === 'business-flow' && !current.flowResult) {
            throw new Error('business-flow 未提交结构化 Business Flow Result。')
          }
          if (current.skill === 'solution-design' && !current.solutionResult) {
            throw new Error('solution-design 未提交结构化 Solution Design Result。')
          }
          if (current.skill === 'interaction-design' && !current.interactionResult) {
            throw new Error('interaction-design 未提交结构化 Interaction Design Result。')
          }
          if (current.skill === 'prototype' && !current.prototypeResult) throw new Error('prototype 未提交结构化 Prototype Result。')
          if (current.skill === 'product-spec' && !current.productSpecResult) throw new Error('product-spec 未提交结构化 Product Spec Result。')
          if (current.skill === 'requirement-review' && !current.requirementReviewResult) throw new Error('requirement-review 未提交结构化 Requirement Review Result。')
          const deliveredQuestions = current.skill === 'requirement-analysis'
            ? this.persistence.projectAnalysisQuestions(started.run.id)
            : []
          if (current.skill === 'requirement-analysis') {
            this.persistence.recordRuntimeEvent(started.run.id, 'question_projection', {
              deterministic: true, tokenCost: 0, deliveredCount: deliveredQuestions.length,
              questionIds: deliveredQuestions.map((question) => question.id)
            })
            this.persistence.recordRuntimeEvent(started.run.id, 'question_delivery_guard', {
              deterministic: true, tokenCost: 0, deliveredCount: deliveredQuestions.length,
              status: deliveredQuestions.length ? 'delivered' : 'not_applicable'
            })
          }
          if (current.analysisResult?.analysisStatus === 'ReadyForConfirmation') {
            if (!current.tools.includes('analysis_turn_submit')) {
              throw new Error('requirement-analysis 未执行 analysis_turn_submit。')
            }
            this.persistence.updateRunRuntimeEvents(started.run.id, events)
            const waiting = this.persistence.waitForAnalysisConfirmation(started.run.id, content, deliveredQuestions)
            this.releaseActive(started.run.id)
            this.emit(sender, { type: 'approval_required', runId: started.run.id, threadId: started.run.threadId, ...waiting })
            continue
          }
          if (current.flowResult?.flowStatus === 'READY_FOR_CONFIRMATION') {
            if (!current.tools.includes('business_flow_ready')) throw new Error('business-flow 未执行 business_flow_ready。')
            if (!current.readFiles.includes('analysis/requirement-analysis.md')) {
              throw new Error('business-flow 未读取已确认的 Requirement Analysis。')
            }
            this.persistence.updateRunRuntimeEvents(started.run.id, events)
            const waiting = this.persistence.waitForFlowConfirmation(started.run.id, content)
            this.releaseActive(started.run.id)
            this.emit(sender, { type: 'approval_required', runId: started.run.id, threadId: started.run.threadId, ...waiting })
            continue
          }
          if (current.solutionResult?.solutionStatus === 'READY_FOR_CONFIRMATION') {
            if (!current.tools.includes('solution_coverage_check') || !current.tools.includes('solution_overdesign_check')) {
              throw new Error('solution-design 未执行 Coverage / Overdesign Validator。')
            }
            if (!current.readFiles.includes('analysis/requirement-analysis.md')
              || !current.readFiles.includes(current.solutionResult.solution.sourceFlowPath)) {
              throw new Error('solution-design 未读取已确认 Analysis 与最新 Business Flow Model。')
            }
            this.persistence.updateRunRuntimeEvents(started.run.id, events)
            const waiting = this.persistence.waitForSolutionConfirmation(started.run.id, content)
            this.releaseActive(started.run.id)
            this.emit(sender, { type: 'approval_required', runId: started.run.id, threadId: started.run.threadId, ...waiting })
            continue
          }
          if (current.interactionResult?.interactionStatus === 'READY_FOR_CONFIRMATION') {
            if (!current.tools.includes('interaction_design_ready')) throw new Error('interaction-design 未执行 interaction_design_ready。')
            const model = current.interactionResult.interaction
            if (!current.readFiles.includes(model.sourceAnalysisPath) || !current.readFiles.includes(model.sourceFlowPath)
              || !current.readFiles.includes(model.sourceSolutionPath)) {
              throw new Error('interaction-design 未读取已确认 Analysis、最新 Flow Model 与最新 Solution Model。')
            }
            if (model.uiReferencePaths.some((path) => !current.readFiles.includes(path))) {
              throw new Error('interaction-design 声明了 Existing UI Reference，但未读取对应 Artifact。')
            }
            this.persistence.updateRunRuntimeEvents(started.run.id, events)
            const waiting = this.persistence.waitForInteractionConfirmation(started.run.id, content)
            this.releaseActive(started.run.id)
            this.emit(sender, { type: 'approval_required', runId: started.run.id, threadId: started.run.threadId, ...waiting })
            continue
          }
          if (current.prototypeResult?.prototypeStatus === 'READY_FOR_CONFIRMATION') {
            if (!current.tools.includes('artifact_next_version') || !current.tools.includes('prototype_ready')) {
              throw new Error('prototype 未执行 artifact_next_version / prototype_ready。')
            }
            const model = current.prototypeResult.prototype
            if (!current.readFiles.includes(model.sourceInteractionPath)) throw new Error('prototype 未读取最新 Interaction Design。')
            const requiredReferences = [model.sourceSolutionPath, model.existingPrototypePath, ...model.uiReferencePaths].filter((path): path is string => Boolean(path))
            if (requiredReferences.some((path) => !current.readFiles.includes(path))) throw new Error('prototype 声明了 Existing UI / Reference，但未读取对应 Artifact。')
            this.persistence.updateRunRuntimeEvents(started.run.id, events)
            const waiting = this.persistence.waitForPrototypeConfirmation(started.run.id, content)
            this.releaseActive(started.run.id)
            this.emit(sender, { type: 'approval_required', runId: started.run.id, threadId: started.run.threadId, ...waiting })
            continue
          }
          if (current.productSpecResult?.productSpecStatus === 'READY_FOR_CONFIRMATION') {
            if (!current.tools.includes('product_spec_ready') || !current.tools.includes('product_spec_next_version')) throw new Error('product-spec 未执行版本解析与 Ready Validator。')
            const spec = current.productSpecResult.productSpec
            const requiredSources = [spec.sourceAnalysisPath, spec.sourceFlowPath, spec.sourceSolutionPath, spec.interactionRequired ? spec.sourceInteractionPath : null, spec.sourcePrototypePath, spec.existingPrdPath].filter((path): path is string => Boolean(path))
            if (requiredSources.some((path) => !current.readFiles.includes(path))) throw new Error('product-spec 未按需读取声明的正式上游或 PRD 来源。')
            this.persistence.updateRunRuntimeEvents(started.run.id, events)
            const waiting = this.persistence.waitForProductSpecConfirmation(started.run.id, content)
            this.releaseActive(started.run.id)
            this.emit(sender, { type: 'approval_required', runId: started.run.id, threadId: started.run.threadId, ...waiting })
            continue
          }
          if (current.requirementReviewResult?.reviewStatus === 'READY_FOR_CONFIRMATION') {
            if (!current.tools.includes('requirement_review_next_version') || !current.tools.includes('requirement_review_ready')) throw new Error('requirement-review 未执行版本解析与 Ready Gate。')
            if (current.requirementReviewResult.artifactsReviewed.some((path) => !current.readFiles.includes(path))) throw new Error('requirement-review 未读取声明的当前有效 Artifact。')
            this.persistence.updateRunRuntimeEvents(started.run.id, events)
            const waiting = this.persistence.waitForRequirementReviewConfirmation(started.run.id, content)
            this.releaseActive(started.run.id)
            this.emit(sender, { type: 'approval_required', runId: started.run.id, threadId: started.run.threadId, ...waiting })
            continue
          }
          if (current.approval?.status === 'Pending') {
            events.push('approval_required')
            this.persistence.updateRunRuntimeEvents(started.run.id, events)
            const waiting = this.persistence.waitForApproval(started.run.id, content)
            this.releaseActive(started.run.id)
            this.emit(sender, { type: 'approval_required', runId: started.run.id, threadId: started.run.threadId, ...waiting })
          } else {
            this.persistence.updateRunRuntimeEvents(started.run.id, events)
            const completed = this.persistence.completeRun(started.run.id, content, deliveredQuestions)
            this.releaseActive(started.run.id)
            this.emit(sender, { type: 'completed', runId: started.run.id, threadId: started.run.threadId, ...completed })
          }
        }
      }
      if (!terminal) throw new Error('Agent Runtime Streaming 意外中断。')
    } catch (error) {
      if (this.activeRunId !== started.run.id) return
      const message = error instanceof Error ? error.message : 'Agent Runtime 执行失败。'
      reportDiagnosticError(error, { layer: 'runtime', module: 'AgentTaskService', operation: 'execute', errorCode: /没有返回|no content/i.test(message) ? 'MODEL_EMPTY_RESPONSE' : 'RUNTIME_UNHANDLED_ERROR', workspaceId: started.run.workspaceId, sessionId: started.run.threadId, runId: started.run.id, stage: gate.stage ?? undefined, slot: gate.slot ?? undefined, provider: config.provider, model: config.model })
      const interrupted = /连接|中断|Streaming 意外中断|connection-closed|Runtime exited/i.test(message)
      events.push(interrupted ? 'run_failed' : 'run_failed')
      this.persistence.updateRunRuntimeEvents(started.run.id, events)
      const failed = interrupted
        ? this.persistence.interruptRun(started.run.id, message)
        : this.persistence.failRun(started.run.id, message)
      this.releaseActive(started.run.id)
      this.emit(sender, {
        type: 'error', runId: started.run.id, threadId: started.run.threadId, error: message, run: failed
      })
    } finally {
      if (this.activeRunId === started.run.id) {
        this.activeRunId = null
        this.activeSender = null
      }
    }
  }

  private completeClarification(sender: WebContents, started: ChatStart, skill: SelectedSkill): void {
    const result: ChangeResult = {
      status: 'ClarificationRequired',
      changeSummary: '当前变更表述缺少可执行的变化对象或新规则。',
      impactAssessment: '信息不足，尚无法基于 Artifact 判断影响。',
      affectedArtifacts: [], unaffectedArtifacts: [], openQuestions: ['请说明要调整的具体规则以及调整后的内容。'],
      decisionsAffected: [], filesRead: [], candidateChanges: [], finalChanges: [], validationResult: null
    }
    this.persistence.setChangeResult(started.run.id, result)
    const reply = `需要补充信息\n\n请说明要调整的具体规则以及调整后的内容。`
    const completed = this.persistence.completeRun(started.run.id, reply)
    this.releaseActive(started.run.id)
    this.emit(sender, { type: 'completed', runId: started.run.id, threadId: started.run.threadId, ...completed })
  }

  private async startExplicitSlotUpdate(
    sender: WebContents,
    request: StartChatRequest,
    update: ExplicitSlotUpdate
  ): Promise<ChatStart> {
    const gate = shouldUseLLM({
      action: 'UPDATE_EXPLICIT_SLOT', caller: 'AgentTaskService.startChat', task: request.content,
      stage: update.stage, slot: update.slot
    })
    const started = this.persistence.startRun(
      request.workspaceId, request.requirementId, request.threadId, request.content, null, undefined, null, null
    )
    this.persistence.recordRuntimeEvent(started.run.id, 'model_gate_evaluated', {
      ...gate, executionPath: 'SCRIPT', executionMode: update.executionMode, routerReason: update.reason, source: update.source,
      router: { stage: update.stage, slot: update.slot, action: update.action, executionMode: update.executionMode, reason: update.reason, source: update.source }
    })
    this.activeRunId = started.run.id
    this.activeSender = sender
    setTimeout(() => void this.executeExplicitSlotUpdate(sender, started, update), 0)
    return started
  }

  private async executeExplicitSlotUpdate(sender: WebContents, started: ChatStart, update: ExplicitSlotUpdate): Promise<void> {
    const callId = randomUUID()
    const startedAt = new Date().toISOString()
    try {
      if (update.stage === 'requirement-analysis') {
        const currentMainline = this.persistence.getAnalysisState(started.run.requirementId, started.run.threadId)
        this.handleToolEvent(sender, started.run.id, started.run.threadId, {
          call: { id: callId, name: 'analysis_turn_submit', status: 'Running', startedAt, completedAt: null, error: null }
        })
        const output = await this.tools.execute('analysis_turn_submit', {
          requirementId: started.run.requirementId,
          assistantReply: `已更新${update.label}：${update.values.join('；')}。`,
          patches: update.analysisPatches,
          resolvedQuestionIds: [],
          newQuestions: [],
          ...(currentMainline?.mainlineSchema?.status === 'confirmed' ? {} : { schemaDelta: { status: 'proposed', requirementTypes: [], modules: [] } })
        }, { runId: started.run.id, requirementId: started.run.requirementId })
        this.handleToolEvent(sender, started.run.id, started.run.threadId, {
          call: { id: callId, name: 'analysis_turn_submit', status: 'Completed', startedAt, completedAt: new Date().toISOString(), error: null }, output
        })
      } else {
        this.persistence.recordRuntimeEvent(started.run.id, 'script_started', { name: 'lifecycle_slot_update', stage: update.stage, slot: update.slot, tokenCost: 0 })
        const base = this.persistence.getLifecycleStageState(started.run.requirementId, update.stage)
          ?? createStageState(started.run.workspaceId, started.run.requirementId, update.stage)
        const saved = applyStageSlotUpdates(base, update.updates)
        this.persistence.saveLifecycleStageState(saved, started.run.id, 'explicit-slot-update')
        for (const stageId of lifecycleStageOrder) {
          if (lifecycleStageOrder.indexOf(stageId) <= lifecycleStageOrder.indexOf(update.stage)) continue
          if (!this.persistence.getLifecycleStageState(started.run.requirementId, stageId)) {
            this.persistence.saveLifecycleStageState(createStageState(started.run.workspaceId, started.run.requirementId, stageId), started.run.id, 'downstream-initialized')
          }
        }
        for (const downstream of markDownstreamStagesStale(this.persistence.listLifecycleStageStates(started.run.requirementId), update.stage, `${update.stage}.${update.slot} 已更新`)) {
          const before = this.persistence.getLifecycleStageState(started.run.requirementId, downstream.stageId)
          if (before && downstream.status === 'stale' && before.status !== 'stale') this.persistence.saveLifecycleStageState(downstream, started.run.id, 'upstream-changed')
        }
        this.persistence.recordRuntimeEvent(started.run.id, 'script_completed', { name: 'lifecycle_slot_update', stage: update.stage, slot: update.slot, tokenCost: 0 })
      }
      const completed = this.persistence.completeRun(started.run.id, `已直接写入${update.label}槽位，并完成完整度、冲突和下游影响状态计算。模型调用：0。`)
      this.releaseActive(started.run.id)
      this.emit(sender, { type: 'completed', runId: started.run.id, threadId: started.run.threadId, ...completed })
    } catch (error) {
      const message = error instanceof Error ? error.message : '明确槽位更新失败。'
      const failed = this.persistence.failRun(started.run.id, message)
      this.releaseActive(started.run.id)
      this.emit(sender, { type: 'error', runId: started.run.id, threadId: started.run.threadId, error: message, run: failed })
    }
  }

  private async startDeterministicQuery(
    sender: WebContents,
    request: StartChatRequest,
    query: DeterministicQuery
  ): Promise<ChatStart> {
    const requirement = await this.workspace.refreshRequirement(request.requirementId)
    const mainline = query === 'conclusion' ? this.persistence.getAnalysisState(request.requirementId, request.threadId) : null
    const gate = shouldUseLLM({ action: 'READ_SLOT', caller: 'AgentTaskService.startChat', task: request.content, stage: requirement.stage })
    const started = this.persistence.startRun(
      request.workspaceId, request.requirementId, request.threadId, request.content, null, undefined, null, null
    )
    this.persistence.recordRuntimeEvent(started.run.id, 'model_gate_evaluated', {
      ...gate, executionPath: 'SCRIPT', intent: query === 'conclusion' ? 'REQUEST_CONCLUSION' : 'GENERAL_QUERY',
      contextSource: query === 'conclusion' ? 'mainline' : 'requirement_snapshot', mainlineRead: Boolean(mainline), sourceRead: false,
      requirementAnalysisCalled: false, questionGeneratorRun: false, llmCallCount: 0
    })
    this.activeRunId = started.run.id
    this.activeSender = sender
    setTimeout(() => {
      const content = query === 'conclusion'
        ? this.composeAnalysisConclusion(mainline)
        : query === 'status' ? `当前需求状态：${requirement.status}。`
        : query === 'stage' ? `当前需求阶段：${requirement.stageLabel}（${requirement.stage}）。`
          : `当前需求目标：${requirement.overview?.trim() || requirement.title}。`
      const completed = this.persistence.completeRun(started.run.id, `${content}\n\n模型调用：0。`)
      this.releaseActive(started.run.id)
      this.emit(sender, { type: 'completed', runId: started.run.id, threadId: started.run.threadId, ...completed })
    }, 0)
    return started
  }

  private composeAnalysisConclusion(mainline: ReturnType<PersistenceService['getAnalysisState']>): string {
    if (!mainline) return '结论：当前尚未建立需求分析 Mainline，暂时无法给出阶段结论。'
    const readiness = calculateAnalysisReadiness(mainline)
    if (readiness.readyForConfirmation) {
      return '结论：当前需求分析已完成。\n\n问题、目标、范围、主流程、关键场景和核心规则已经清晰，目前没有阻塞项。剩余细节不影响本阶段结束，可在后续设计阶段继续细化。\n\n可以进入业务流程设计。'
    }
    const missing = [
      !readiness.problemClear ? '问题' : '', !readiness.goalClear ? '目标' : '', !readiness.scopeClear ? '范围' : '',
      !readiness.mainFlowClear ? '主流程' : '', !readiness.scenarioClear ? '关键场景' : '', !readiness.rulesClear ? '核心规则' : ''
    ].filter(Boolean)
    return `结论：当前需求分析尚未完成。${missing.length ? `\n\n仍需明确：${missing.join('、')}。` : ''}${readiness.blockingQuestions ? `\n\n当前阻塞项：${readiness.blockingQuestions} 个。` : ''}`
  }


  private async startPrerequisiteBlocked(
    sender: WebContents,
    request: StartChatRequest,
    skill: SelectedSkill,
    missing: string[]
  ): Promise<ChatStart> {
    const context = await this.contextManager.build({
      workspaceId: request.workspaceId, requirementId: request.requirementId, threadId: request.threadId,
      task: request.content, skill
    })
    const started = this.persistence.startRun(
      request.workspaceId, request.requirementId, request.threadId, request.content, null, undefined, skill, context.metadata
    )
    this.activeRunId = started.run.id
    this.activeSender = sender
    setTimeout(() => {
      const reply = `前置条件未就绪\n\n${skill.name}门禁未通过。请先完成并确认：${missing.join('、')}。所有前置阶段通过后才能进入当前阶段。`
      const completed = this.persistence.completeRun(started.run.id, reply)
      this.releaseActive(started.run.id)
      this.emit(sender, { type: 'completed', runId: started.run.id, threadId: started.run.threadId, ...completed })
    }, 0)
    return started
  }

  private async executeAnalysisConfirmation(sender: WebContents, started: ChatStart): Promise<void> {
    const run = this.persistence.getRun(started.run.id)
    const analysis = run.analysisResult
    if (!analysis || analysis.analysisStatus !== 'ReadyForConfirmation') return
    try {
      await this.executeAnalysisTool(run.id, 'requirement_analysis_write', {
        requirementId: run.requirementId,
        analysisRunId: run.id,
        path: analysis.artifactPath,
        candidate: analysis.artifactCandidate
      }, {
        runId: run.id,
        path: analysis.artifactPath,
        candidate: analysis.artifactCandidate,
        baseHash: analysis.artifactBaseHash
      })
      await this.executeAnalysisTool(run.id, 'workspace_validate', {
        requirementId: run.requirementId,
        path: analysis.artifactPath
      })
      this.persistence.confirmAnalysis(run.id)
      const mainline = this.persistence.getAnalysisState(run.requirementId, run.threadId)
      if (mainline) {
        mainline.readiness = { ...calculateAnalysisReadiness(mainline), status: 'COMPLETED' }
        mainline.changedPaths = []
        this.persistence.saveAnalysisState(mainline, run.id, 'stage-completed')
        const stageState = this.persistence.getLifecycleStageState(run.requirementId, 'requirement-analysis')
        if (stageState) {
          stageState.status = 'confirmed'
          stageState.readiness = { ...stageState.readiness, status: 'COMPLETED', readyForConfirmation: true }
          stageState.changedPaths = []
          this.persistence.saveLifecycleStageState(stageState, run.id, 'stage-completed')
        }
      }
      const completed = this.persistence.completeRun(run.id, `需求分析已确认并写入正式 Artifact：${analysis.artifactPath}`)
      this.releaseActive(run.id)
      this.emit(sender, { type: 'completed', runId: run.id, threadId: run.threadId, ...completed })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Requirement Analysis 写入或校验失败。'
      const failed = this.persistence.failRun(run.id, message)
      this.releaseActive(run.id)
      this.emit(sender, { type: 'error', runId: run.id, threadId: run.threadId, error: message, run: failed })
    }
  }

  private async executeFlowConfirmation(sender: WebContents, started: ChatStart): Promise<void> {
    const run = this.persistence.getRun(started.run.id)
    const flow = run.flowResult
    if (!flow || flow.flowStatus !== 'READY_FOR_CONFIRMATION') return
    try {
      const written = await this.executeFlowTool(run.id, 'business_flow_write', {
        requirementId: run.requirementId,
        flowRunId: run.id
      }, flow)
      await this.executeFlowTool(run.id, 'workspace_validate', {
        requirementId: run.requirementId,
        path: flow.modelPath
      })
      await this.executeFlowTool(run.id, 'workspace_validate', {
        requirementId: run.requirementId,
        path: flow.htmlPath
      })
      const confirmedAt = typeof written.confirmedAt === 'string' ? written.confirmedAt : new Date().toISOString()
      this.persistence.confirmFlow(run.id, confirmedAt)
      const completed = this.persistence.completeRun(run.id, `业务流程已确认并写入正式 Artifact：${flow.modelPath}、${flow.htmlPath}`)
      this.releaseActive(run.id)
      this.emit(sender, { type: 'completed', runId: run.id, threadId: run.threadId, ...completed })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Business Flow 写入或校验失败。'
      const failed = this.persistence.failRun(run.id, message)
      this.releaseActive(run.id)
      this.emit(sender, { type: 'error', runId: run.id, threadId: run.threadId, error: message, run: failed })
    }
  }

  private async executeSolutionConfirmation(sender: WebContents, started: ChatStart): Promise<void> {
    const run = this.persistence.getRun(started.run.id)
    const solution = run.solutionResult
    if (!solution || solution.solutionStatus !== 'READY_FOR_CONFIRMATION') return
    try {
      const written = await this.executeSolutionTool(run.id, 'solution_design_write', {
        requirementId: run.requirementId, solutionRunId: run.id
      }, solution)
      await this.executeSolutionTool(run.id, 'workspace_validate', { requirementId: run.requirementId, path: solution.modelPath })
      await this.executeSolutionTool(run.id, 'workspace_validate', { requirementId: run.requirementId, path: solution.markdownPath })
      const confirmedAt = typeof written.confirmedAt === 'string' ? written.confirmedAt : new Date().toISOString()
      this.persistence.confirmSolution(run.id, confirmedAt)
      const completed = this.persistence.completeRun(run.id, `方案设计已确认并写入正式 Artifact：${solution.modelPath}、${solution.markdownPath}`)
      this.releaseActive(run.id)
      this.emit(sender, { type: 'completed', runId: run.id, threadId: run.threadId, ...completed })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Solution Design 写入或校验失败。'
      const failed = this.persistence.failRun(run.id, message)
      this.releaseActive(run.id)
      this.emit(sender, { type: 'error', runId: run.id, threadId: run.threadId, error: message, run: failed })
    }
  }

  private async executeInteractionConfirmation(sender: WebContents, started: ChatStart): Promise<void> {
    const run = this.persistence.getRun(started.run.id)
    const interaction = run.interactionResult
    if (!interaction || interaction.interactionStatus !== 'READY_FOR_CONFIRMATION') return
    try {
      const written = await this.executeInteractionTool(run.id, 'interaction_design_write', {
        requirementId: run.requirementId, interactionRunId: run.id
      }, interaction)
      await this.executeInteractionTool(run.id, 'workspace_validate', { requirementId: run.requirementId, path: interaction.modelPath })
      await this.executeInteractionTool(run.id, 'workspace_validate', { requirementId: run.requirementId, path: interaction.markdownPath })
      const confirmedAt = typeof written.confirmedAt === 'string' ? written.confirmedAt : new Date().toISOString()
      this.persistence.confirmInteraction(run.id, confirmedAt)
      const completed = this.persistence.completeRun(run.id, `交互设计已确认并写入正式 Artifact：${interaction.modelPath}、${interaction.markdownPath}`)
      this.releaseActive(run.id)
      this.emit(sender, { type: 'completed', runId: run.id, threadId: run.threadId, ...completed })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Interaction Design 写入或校验失败。'
      const failed = this.persistence.failRun(run.id, message)
      this.releaseActive(run.id)
      this.emit(sender, { type: 'error', runId: run.id, threadId: run.threadId, error: message, run: failed })
    }
  }

  private async executePrototypeConfirmation(sender: WebContents, started: ChatStart): Promise<void> {
    const run = this.persistence.getRun(started.run.id)
    const prototype = run.prototypeResult
    if (!prototype || prototype.prototypeStatus !== 'READY_FOR_CONFIRMATION') return
    try {
      const written = await this.executePrototypeTool(run.id, 'prototype_write', {
        requirementId: run.requirementId, prototypeRunId: run.id
      }, prototype)
      await this.executePrototypeTool(run.id, 'workspace_validate', {
        requirementId: run.requirementId, path: prototype.htmlPath,
        sourcePath: prototype.prototype.existingPrototypePath ?? undefined
      })
      const confirmedAt = typeof written.confirmedAt === 'string' ? written.confirmedAt : new Date().toISOString()
      this.persistence.confirmPrototype(run.id, confirmedAt)
      const completed = this.persistence.completeRun(run.id, `页面原型已确认并写入正式 Artifact：${prototype.htmlPath}`)
      this.releaseActive(run.id)
      this.emit(sender, { type: 'completed', runId: run.id, threadId: run.threadId, ...completed })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Prototype 写入或校验失败。'
      const failed = this.persistence.failRun(run.id, message)
      this.releaseActive(run.id)
      this.emit(sender, { type: 'error', runId: run.id, threadId: run.threadId, error: message, run: failed })
    }
  }

  private async executeProductSpecConfirmation(sender: WebContents, started: ChatStart): Promise<void> {
    const run = this.persistence.getRun(started.run.id)
    const spec = run.productSpecResult
    if (!spec || spec.productSpecStatus !== 'READY_FOR_CONFIRMATION') return
    try {
      const written = await this.executeProductSpecTool(run.id, 'product_spec_write', { requirementId: run.requirementId, productSpecRunId: run.id }, spec)
      await this.executeProductSpecTool(run.id, 'workspace_validate', { requirementId: run.requirementId, path: spec.modelPath })
      await this.executeProductSpecTool(run.id, 'workspace_validate', { requirementId: run.requirementId, path: spec.markdownPath, sourcePath: spec.productSpec.existingPrdPath ?? undefined })
      const confirmedAt = typeof written.confirmedAt === 'string' ? written.confirmedAt : new Date().toISOString()
      this.persistence.confirmProductSpec(run.id, confirmedAt)
      const completed = this.persistence.completeRun(run.id, `Product Spec 已确认并写入正式 Artifact：${spec.modelPath}、${spec.markdownPath}`)
      this.releaseActive(run.id); this.emit(sender, { type: 'completed', runId: run.id, threadId: run.threadId, ...completed })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Product Spec 写入或校验失败。'
      const failed = this.persistence.failRun(run.id, message); this.releaseActive(run.id)
      this.emit(sender, { type: 'error', runId: run.id, threadId: run.threadId, error: message, run: failed })
    }
  }

  private async executeRequirementReviewConfirmation(sender: WebContents, started: ChatStart): Promise<void> {
    const run = this.persistence.getRun(started.run.id)
    const review = run.requirementReviewResult
    if (!review || review.reviewStatus !== 'READY_FOR_CONFIRMATION') return
    try {
      const written = await this.executeRequirementReviewTool(run.id, 'requirement_review_write', { requirementId: run.requirementId, reviewRunId: run.id }, review)
      await this.executeRequirementReviewTool(run.id, 'workspace_validate', { requirementId: run.requirementId, path: review.modelPath })
      await this.executeRequirementReviewTool(run.id, 'workspace_validate', { requirementId: run.requirementId, path: review.markdownPath })
      const confirmedAt = typeof written.confirmedAt === 'string' ? written.confirmedAt : new Date().toISOString()
      this.persistence.confirmRequirementReview(run.id, confirmedAt)
      const completed = this.persistence.completeRun(run.id, `Requirement Review 已确认并写入正式 Artifact：${review.modelPath}、${review.markdownPath}`)
      this.releaseActive(run.id); this.emit(sender, { type: 'completed', runId: run.id, threadId: run.threadId, ...completed })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Requirement Review 写入或校验失败。'
      const failed = this.persistence.failRun(run.id, message); this.releaseActive(run.id)
      this.emit(sender, { type: 'error', runId: run.id, threadId: run.threadId, error: message, run: failed })
    }
  }

  private emitActivity(sender: WebContents, runId: string, threadId: string, activity: ExecutionActivity): void {
    this.emit(sender, { type: 'activity', runId, threadId, activity })
  }

  private emit(sender: WebContents, event: ModelStreamEvent): void {
    if (!sender.isDestroyed()) sender.send(modelIpc.event, event)
  }

  private releaseActive(runId: string): void {
    if (this.activeRunId !== runId) return
    this.activeRunId = null
    this.activeSender = null
  }

  private handleToolEvent(sender: WebContents, runId: string, threadId: string, event: ToolBridgeEvent): void {
    const run = this.persistence.recordToolCall(runId, event.call, event.output, event.approval)
    const status = event.call.status === 'Running' ? 'running' : event.call.status === 'Failed' ? 'failed' : 'success'
    addDiagnosticBreadcrumb({ layer: 'tool', action: `${event.call.status === 'Running' ? 'tool_start' : 'tool_complete'}:${event.call.name}`, status: event.call.status === 'Running' ? 'start' : event.call.status === 'Failed' ? 'failure' : 'success', workspaceId: run.workspaceId, runId })
    if (event.call.status === 'Failed') reportDiagnosticError(new Error(event.call.error ?? `${event.call.name} failed`), { layer: 'tool', module: 'ToolRuntime', operation: 'execute', errorCode: 'TOOL_EXECUTION_FAILED', workspaceId: run.workspaceId, sessionId: threadId, runId, stage: run.skill ?? undefined, toolName: event.call.name })
    const toolLabels: Record<string, string> = {
      artifact_find: '正在定位参考资料', artifact_read: '正在读取参考资料',
      analysis_turn_submit: '正在提交本轮需求分析增量'
    }
    this.emitActivity(sender, runId, threadId, {
      id: `tool-${event.call.id}`, kind: 'tool', name: event.call.name,
      label: toolLabels[event.call.name] ?? `调用工具：${event.call.name}`,
      status, startedAt: event.call.startedAt, endedAt: event.call.completedAt,
      durationMs: event.call.completedAt ? Math.max(0, new Date(event.call.completedAt).getTime() - new Date(event.call.startedAt).getTime()) : null,
      detail: event.call.error
    })
    if (event.output && Array.isArray(event.output.scriptEvents)) {
      for (const item of event.output.scriptEvents) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue
        const row = item as Record<string, unknown>
        const name = typeof row.name === 'string' ? row.name : 'script'
        const durationMs = typeof row.durationMs === 'number' ? row.durationMs : null
        if (row.status === 'failed') reportDiagnosticError(new Error(`${name} failed`), { layer: 'script', module: 'ScriptRuntime', operation: 'execute', errorCode: 'SCRIPT_EXECUTION_FAILED', workspaceId: run.workspaceId, sessionId: threadId, runId, stage: run.skill ?? undefined, scriptName: name, durationMs: durationMs ?? undefined })
        this.emitActivity(sender, runId, threadId, {
          id: `script-${event.call.id}-${name}`, kind: 'script', name,
          label: typeof row.label === 'string' ? row.label : `执行脚本：${name}`,
          status: row.status === 'failed' ? 'failed' : 'success',
          startedAt: event.call.startedAt, endedAt: event.call.completedAt, durationMs,
          detail: '确定性本地执行 · Token 0', tokenCost: 0
        })
      }
    }
    if (event.output && typeof event.output.stateVersion === 'number') {
      this.emitActivity(sender, runId, threadId, {
        id: `state-${event.call.id}`, kind: 'state', name: 'analysis_state_update',
        label: `Analysis State 已更新到 v${event.output.stateVersion}`, status: 'success',
        startedAt: event.call.startedAt, endedAt: event.call.completedAt, tokenCost: 0
      })
    }
    this.emit(sender, { type: 'run_updated', runId, threadId, run })
  }

  private async executeApprovedTool(
    runId: string,
    name: ToolName,
    args: Record<string, unknown>,
    approval: WriteApprovalRequest
  ): Promise<Record<string, unknown>> {
    const started: ToolCallRecord = {
      id: randomUUID(), name, status: 'Running', startedAt: new Date().toISOString(), completedAt: null, error: null
    }
    this.persistence.recordToolCall(runId, started)
    try {
      const run = this.persistence.getRun(runId)
      const output = await this.tools.execute(name, args, { runId, workspaceId: run.workspaceId, requirementId: approval.requirementId, approvedApproval: approval })
      this.persistence.recordToolCall(runId, { ...started, status: 'Completed', completedAt: new Date().toISOString() }, output)
      return output
    } catch (error) {
      const message = error instanceof Error ? error.message : `${name} 执行失败。`
      this.persistence.recordToolCall(runId, { ...started, status: 'Failed', completedAt: new Date().toISOString(), error: message })
      throw error
    }
  }

  private async executeAnalysisTool(
    runId: string,
    name: Extract<ToolName, 'requirement_analysis_write' | 'workspace_validate'>,
    args: Record<string, unknown>,
    confirmedAnalysis?: { runId: string; path: string; candidate: string; baseHash: string | null }
  ): Promise<Record<string, unknown>> {
    const run = this.persistence.getRun(runId)
    const started: ToolCallRecord = {
      id: randomUUID(), name, status: 'Running', startedAt: new Date().toISOString(), completedAt: null, error: null
    }
    this.persistence.recordToolCall(runId, started)
    try {
      const output = await this.tools.execute(name, args, {
        runId, workspaceId: run.workspaceId, requirementId: run.requirementId, confirmedAnalysis
      })
      this.persistence.recordToolCall(runId, { ...started, status: 'Completed', completedAt: new Date().toISOString() }, output)
      return output
    } catch (error) {
      const message = error instanceof Error ? error.message : `${name} 执行失败。`
      this.persistence.recordToolCall(runId, { ...started, status: 'Failed', completedAt: new Date().toISOString(), error: message })
      throw error
    }
  }

  private async executeFlowTool(
    runId: string,
    name: Extract<ToolName, 'business_flow_write' | 'workspace_validate'>,
    args: Record<string, unknown>,
    confirmedFlow?: BusinessFlowResult
  ): Promise<Record<string, unknown>> {
    const run = this.persistence.getRun(runId)
    const started: ToolCallRecord = {
      id: randomUUID(), name, status: 'Running', startedAt: new Date().toISOString(), completedAt: null, error: null
    }
    this.persistence.recordToolCall(runId, started)
    try {
      const output = await this.tools.execute(name, args, { runId, workspaceId: run.workspaceId, requirementId: run.requirementId, confirmedFlow })
      this.persistence.recordToolCall(runId, { ...started, status: 'Completed', completedAt: new Date().toISOString() }, output)
      return output
    } catch (error) {
      const message = error instanceof Error ? error.message : `${name} 执行失败。`
      this.persistence.recordToolCall(runId, { ...started, status: 'Failed', completedAt: new Date().toISOString(), error: message })
      throw error
    }
  }

  private async executeSolutionTool(
    runId: string,
    name: Extract<ToolName, 'solution_design_write' | 'workspace_validate'>,
    args: Record<string, unknown>,
    confirmedSolution?: SolutionDesignResult
  ): Promise<Record<string, unknown>> {
    const run = this.persistence.getRun(runId)
    const started: ToolCallRecord = {
      id: randomUUID(), name, status: 'Running', startedAt: new Date().toISOString(), completedAt: null, error: null
    }
    this.persistence.recordToolCall(runId, started)
    try {
      const output = await this.tools.execute(name, args, { runId, workspaceId: run.workspaceId, requirementId: run.requirementId, confirmedSolution })
      this.persistence.recordToolCall(runId, { ...started, status: 'Completed', completedAt: new Date().toISOString() }, output)
      return output
    } catch (error) {
      const message = error instanceof Error ? error.message : `${name} 执行失败。`
      this.persistence.recordToolCall(runId, { ...started, status: 'Failed', completedAt: new Date().toISOString(), error: message })
      throw error
    }
  }

  private async executeInteractionTool(
    runId: string,
    name: Extract<ToolName, 'interaction_design_write' | 'workspace_validate'>,
    args: Record<string, unknown>,
    confirmedInteraction?: InteractionDesignResult
  ): Promise<Record<string, unknown>> {
    const run = this.persistence.getRun(runId)
    const started: ToolCallRecord = {
      id: randomUUID(), name, status: 'Running', startedAt: new Date().toISOString(), completedAt: null, error: null
    }
    this.persistence.recordToolCall(runId, started)
    try {
      const output = await this.tools.execute(name, args, { runId, workspaceId: run.workspaceId, requirementId: run.requirementId, confirmedInteraction })
      this.persistence.recordToolCall(runId, { ...started, status: 'Completed', completedAt: new Date().toISOString() }, output)
      return output
    } catch (error) {
      const message = error instanceof Error ? error.message : `${name} 执行失败。`
      this.persistence.recordToolCall(runId, { ...started, status: 'Failed', completedAt: new Date().toISOString(), error: message })
      throw error
    }
  }

  private async executePrototypeTool(
    runId: string,
    name: Extract<ToolName, 'prototype_write' | 'workspace_validate'>,
    args: Record<string, unknown>,
    confirmedPrototype?: PrototypeResult
  ): Promise<Record<string, unknown>> {
    const run = this.persistence.getRun(runId)
    const started: ToolCallRecord = {
      id: randomUUID(), name, status: 'Running', startedAt: new Date().toISOString(), completedAt: null, error: null
    }
    this.persistence.recordToolCall(runId, started)
    try {
      const output = await this.tools.execute(name, args, { runId, workspaceId: run.workspaceId, requirementId: run.requirementId, confirmedPrototype })
      this.persistence.recordToolCall(runId, { ...started, status: 'Completed', completedAt: new Date().toISOString() }, output)
      return output
    } catch (error) {
      const message = error instanceof Error ? error.message : `${name} 执行失败。`
      this.persistence.recordToolCall(runId, { ...started, status: 'Failed', completedAt: new Date().toISOString(), error: message })
      throw error
    }
  }

  private async executeProductSpecTool(
    runId: string,
    name: Extract<ToolName, 'product_spec_write' | 'workspace_validate'>,
    args: Record<string, unknown>,
    confirmedProductSpec?: ProductSpecResult
  ): Promise<Record<string, unknown>> {
    const run = this.persistence.getRun(runId)
    const started: ToolCallRecord = { id: randomUUID(), name, status: 'Running', startedAt: new Date().toISOString(), completedAt: null, error: null }
    this.persistence.recordToolCall(runId, started)
    try {
      const output = await this.tools.execute(name, args, { runId, workspaceId: run.workspaceId, requirementId: run.requirementId, confirmedProductSpec })
      this.persistence.recordToolCall(runId, { ...started, status: 'Completed', completedAt: new Date().toISOString() }, output)
      return output
    } catch (error) {
      const message = error instanceof Error ? error.message : `${name} 执行失败。`
      this.persistence.recordToolCall(runId, { ...started, status: 'Failed', completedAt: new Date().toISOString(), error: message })
      throw error
    }
  }

  private async executeRequirementReviewTool(
    runId: string,
    name: Extract<ToolName, 'requirement_review_write' | 'workspace_validate'>,
    args: Record<string, unknown>,
    confirmedRequirementReview?: RequirementReviewResult
  ): Promise<Record<string, unknown>> {
    const run = this.persistence.getRun(runId)
    const started: ToolCallRecord = { id: randomUUID(), name, status: 'Running', startedAt: new Date().toISOString(), completedAt: null, error: null }
    this.persistence.recordToolCall(runId, started)
    try {
      const output = await this.tools.execute(name, args, { runId, workspaceId: run.workspaceId, requirementId: run.requirementId, confirmedRequirementReview })
      this.persistence.recordToolCall(runId, { ...started, status: 'Completed', completedAt: new Date().toISOString() }, output)
      return output
    } catch (error) {
      const message = error instanceof Error ? error.message : `${name} 执行失败。`
      this.persistence.recordToolCall(runId, { ...started, status: 'Failed', completedAt: new Date().toISOString(), error: message })
      throw error
    }
  }
}
