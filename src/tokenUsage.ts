import type { ModelProviderId } from './model'

export const tokenUsageIpc = {
  listWorkspaces: 'token-usage:list-workspaces',
  getSummary: 'token-usage:get-summary'
} as const

export type TokenStageId =
  | 'requirement-analysis'
  | 'business-flow'
  | 'solution-design'
  | 'interaction-design'
  | 'prototype'
  | 'product-spec'
  | 'requirement-review'
  | 'requirement-change'
  | 'other'

export type ContextSource = 'system' | 'tools' | 'skill' | 'workspace' | 'stage_slot' | 'mainline' | 'working' | 'artifact' | 'history' | 'user' | 'other'
export type ModelCallReason = 'analysis' | 'mainline_bootstrap' | 'decision' | 'generation' | 'tool_followup' | 'retry' | 'other'
export type ExecutionPath = 'SCRIPT' | 'LLM' | 'FALLBACK' | 'UNKNOWN'
export type ObservedContextMode = 'core' | 'slice' | 'extended' | 'full' | 'unknown'
export type ObservedSkillMode = 'none' | 'capsule' | 'full' | 'unknown'
export type FollowupReason = 'NO_FOLLOWUP' | 'NEW_INFORMATION' | 'CONFLICT_FOUND' | 'EXECUTION_FAILED' | 'REPLAN_REQUIRED' | 'MISSING_CONTEXT' | string

export interface TokenBreakdownItem {
  source: ContextSource
  tokens: number
  percentage: number
}

export interface TokenUsageCall {
  id: string
  workspaceId: string
  conversationId: string | null
  runId: string | null
  originalRunId: string | null
  turnId: string | null
  stage: TokenStageId
  stageLabel: string
  executionContent: string
  stepIndex: number | null
  callId: string | null
  callIndex: number
  routeType: 'script' | 'llm'
  callReason: ModelCallReason
  durationMs: number | null
  usageSource: 'provider_reported'
  breakdownType: 'estimated_breakdown'
  estimatedInputTokens: number
  historyTokens: number
  historyGrowth: number | null
  inputBreakdown: TokenBreakdownItem[]
  messageCount: number
  toolCount: number
  systemPromptChars: number
  contextPackageChars: number
  toolSchemaChars: number
  assistantHistoryChars: number
  toolResultChars: number
  analysisProjectionChars: number
  recentConversationChars: number
  fullAnalysisStateChars: number
  provider: ModelProviderId
  model: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  createdAt: string
}

export interface TokenStageSummary {
  stage: TokenStageId
  label: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  callCount: number
  percentage: number
  calls: TokenUsageCall[]
}

export interface ExecutionTraceStep {
  id: string
  kind: 'user' | 'router' | 'context' | 'skill' | 'model' | 'tool' | 'followup' | 'script' | 'runtime'
  label: string
  detail: string
  createdAt: string
}

export interface FollowupDecisionSummary {
  tool: string | null
  required: boolean
  reason: FollowupReason
  step: number | null
}

export interface TokenUsageTurn {
  id: string
  runId: string
  stage: string | null
  intent: string | null
  executionPath: ExecutionPath
  routerReason: string | null
  fallback: boolean
  llmCalls: number
  scriptCalls: number
  inputTokens: number
  outputTokens: number
  contextMode: ObservedContextMode
  contextLevel: string | null
  contextSources: string[]
  contextExpansion: string[]
  skillMode: ObservedSkillMode
  skill: string | null
  skillFallbackReason: string | null
  toolsInjected: string[]
  followups: FollowupDecisionSummary[]
  createdAt: string
  calls: TokenUsageCall[]
  trace: ExecutionTraceStep[]
}

export interface RuntimeDistributionItem {
  key: string
  count: number
  percentage: number
  inputTokens?: number
  averageInputTokens?: number
}

export interface RuntimeObservabilitySummary {
  turnCount: number
  router: RuntimeDistributionItem[]
  contextModes: RuntimeDistributionItem[]
  skillModes: RuntimeDistributionItem[]
  followupRate: number
  followupReasons: RuntimeDistributionItem[]
  callsPerTurn: RuntimeDistributionItem[]
  turns: TokenUsageTurn[]
}

export interface TokenUsageSummary {
  workspaceId: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  callCount: number
  scriptRunCount: number
  toolCallCount: number
  deterministicExecutionRate: number
  stages: TokenStageSummary[]
  observability: RuntimeObservabilitySummary
}

export interface TokenUsageWorkspace {
  id: string
  name: string
  path: string
}

export interface TokenUsageApi {
  listWorkspaces: () => Promise<TokenUsageWorkspace[]>
  getSummary: (workspaceId: string) => Promise<TokenUsageSummary>
}
