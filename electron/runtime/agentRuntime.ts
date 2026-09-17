import type { ModelProviderId } from '../../src/model'
import type { RuntimeEventType, RuntimeStatus, RuntimeType } from '../../src/runtime'

export interface RuntimeModelConfig {
  provider: ModelProviderId
  apiKey: string
  model: string
  baseUrl: string
}

export interface RuntimeToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface RuntimeToolBridgeConfig {
  url: string
  token: string
}

export interface RuntimeRunRequest {
  runId: string
  threadId: string
  turnId: string
  cwd: string
  input: string
  contextParts: RuntimeContextPart[]
  callReason: Exclude<RuntimeCallReason, 'tool_followup' | 'retry'>
  systemPrompt: string
  model: RuntimeModelConfig
  tools: RuntimeToolSpec[]
  toolBridge: RuntimeToolBridgeConfig
  maxSteps?: number
  maxModelCalls?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  terminalTool?: string | null
}

export type RuntimeContextSource = 'system' | 'tools' | 'skill' | 'workspace' | 'stage_slot' | 'mainline' | 'working' | 'artifact' | 'history' | 'user' | 'other'
export type RuntimeCallReason = 'analysis' | 'mainline_bootstrap' | 'decision' | 'generation' | 'tool_followup' | 'retry' | 'other'

export interface RuntimeContextPart {
  source: RuntimeContextSource
  content: string
}

export interface RuntimeTokenBreakdownItem {
  source: RuntimeContextSource
  tokens: number
  percentage: number
}

export interface RuntimeEvent {
  eventId?: string
  type: RuntimeEventType
  runId: string
  threadId: string
  turnId: string
  delta?: string
  content?: string
  toolName?: string
  followupRequired?: boolean
  followupReason?: 'NO_FOLLOWUP' | 'NEW_INFORMATION' | 'CONFLICT_FOUND' | 'EXECUTION_FAILED' | 'REPLAN_REQUIRED' | 'MISSING_CONTEXT'
  callId?: string
  step?: number
  modelCallId?: string
  callReason?: RuntimeCallReason
  durationMs?: number
  error?: string
  errorCode?: string
  usage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }
  createdAt?: string
  executionContent?: string
  metrics?: {
    messageCount: number
    toolCount: number
    systemPromptChars: number
    contextPackageChars: number
    toolSchemaChars: number
    assistantHistoryChars: number
    toolResultChars: number
    estimatedInputTokens: number
    historyTokens: number
    inputBreakdown: RuntimeTokenBreakdownItem[]
  }
}

export class RuntimeError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'not-installed'
      | 'start-failed'
      | 'connection-closed'
      | 'provider-config'
      | 'provider-auth'
      | 'provider-rate-limit'
      | 'provider-network'
      | 'provider-stream'
      | 'protocol-error'
      | 'run-conflict'
      | 'model-call-budget-exceeded'
      | 'run-failed',
    readonly technicalMessage: string = message
  ) {
    super(message)
    this.name = 'RuntimeError'
  }
}

export interface AgentRuntime {
  readonly type: RuntimeType
  start(): Promise<void>
  run(request: RuntimeRunRequest): AsyncIterable<RuntimeEvent>
  cancel(runId: string): Promise<boolean>
  shutdown(): Promise<void>
  getStatus(): RuntimeStatus
}
