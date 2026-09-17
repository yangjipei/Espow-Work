import type { MessageRecord, RunRecord } from './persistence'
import type { LifecycleStageId } from './lifecycleStageState'

export const modelIpc = {
  getConfigs: 'model:get-configs',
  saveConfig: 'model:save-config',
  testConnection: 'model:test-connection',
  startChat: 'model:start-chat',
  cancelChat: 'model:cancel-chat',
  event: 'model:event'
} as const

export type ModelProviderId = 'openai' | 'deepseek'

export interface ModelConfigDraft {
  provider: ModelProviderId
  apiKey: string
  model: string
  baseUrl: string
}

export interface PublicModelConfig {
  provider: ModelProviderId
  model: string
  baseUrl: string
  apiKeyConfigured: boolean
  apiKeyPreview: string | null
}

export interface ModelSettings {
  activeProvider: ModelProviderId
  configs: Record<ModelProviderId, PublicModelConfig>
}

export interface ConnectionTestResult {
  success: boolean
  message: string
}

export interface StartChatRequest {
  workspaceId: string
  requirementId: string
  threadId: string
  content: string
  replaceMessageId?: string
  slotTarget?: { stageId: LifecycleStageId; slotId: string }
  controlEvent?: RuntimeControlEvent
}

export type RuntimeControlEvent =
  | { type: 'CONFIRM_STAGE'; stageId: LifecycleStageId }
  | { type: 'REJECT_STAGE'; stageId: LifecycleStageId }
  | { type: 'CONTINUE_STAGE'; stageId: LifecycleStageId }


export type ExecutionActivityKind = 'model' | 'tool' | 'script' | 'state' | 'artifact'
export type ExecutionActivityStatus = 'running' | 'success' | 'failed' | 'skipped'

export interface ExecutionActivity {
  id: string
  kind: ExecutionActivityKind
  name: string
  label: string
  status: ExecutionActivityStatus
  startedAt: string
  endedAt?: string | null
  durationMs?: number | null
  detail?: string | null
  inputTokens?: number
  outputTokens?: number
  tokenCost?: number
}

export interface ChatStart {
  message: MessageRecord
  run: RunRecord
}

export type ModelStreamEvent =
  | { type: 'activity'; runId: string; threadId: string; activity: ExecutionActivity }
  | { type: 'delta'; runId: string; threadId: string; delta: string }
  | { type: 'run_updated'; runId: string; threadId: string; run: RunRecord }
  | { type: 'approval_required'; runId: string; threadId: string; message: MessageRecord; run: RunRecord }
  | { type: 'completed'; runId: string; threadId: string; message: MessageRecord; run: RunRecord }
  | { type: 'error'; runId: string; threadId: string; error: string; run: RunRecord }
  | { type: 'cancelled'; runId: string; threadId: string; run: RunRecord }

export interface ModelApi {
  getConfigs: () => Promise<ModelSettings>
  saveConfig: (config: ModelConfigDraft) => Promise<ModelSettings>
  testConnection: (config: ModelConfigDraft) => Promise<ConnectionTestResult>
  startChat: (request: StartChatRequest) => Promise<ChatStart>
  cancelChat: (runId: string) => Promise<boolean>
  onEvent: (listener: (event: ModelStreamEvent) => void) => () => void
}
