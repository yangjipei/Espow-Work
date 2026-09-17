import type { ModelProviderId } from './model'
import type { RuntimeEventType, RuntimeType } from './runtime'
import type { ToolCallRecord, WriteApprovalRequest } from './tools'
import type { BusinessFlowResult, ChangeResult, InteractionDesignResult, ProductSpecResult, PrototypeResult, RequirementAnalysisResult, RequirementReviewResult, SolutionDesignResult } from './skills'
import type { RunContextMetadata } from './context'

export const persistenceIpc = {
  getSelection: 'persistence:get-selection',
  setActiveRequirement: 'persistence:set-active-requirement',
  listThreads: 'persistence:list-threads',
  createThread: 'persistence:create-thread',
  renameThread: 'persistence:rename-thread',
  deleteThread: 'persistence:delete-thread',
  setActiveThread: 'persistence:set-active-thread',
  listMessages: 'persistence:list-messages',
  appendUserMessage: 'persistence:append-user-message',
  listRuns: 'persistence:list-runs',
  listRunEvents: 'persistence:list-run-events',
} as const

export type MessageRole = 'user' | 'assistant' | 'system'
export type RunStatus = 'Pending' | 'Running' | 'WaitingConfirmation' | 'Cancelling' | 'Completed' | 'Failed' | 'Cancelled' | 'Interrupted'

export interface DeliveredQuestion {
  id: string
  content: string
  blocking: boolean
}

export interface DesktopWorkspace {
  id: string
  path: string
  name: string
  lastOpenedAt: string
}

export interface DesktopSelection {
  requirementId: string | null
  threadId: string | null
}

export interface ThreadRecord {
  id: string
  workspaceId: string
  requirementId: string
  title: string
  createdAt: string
  updatedAt: string
}

export interface MessageRecord {
  id: string
  threadId: string
  role: MessageRole
  content: string
  questions?: DeliveredQuestion[]
  createdAt: string
}

export interface RunEventRecord {
  id: string
  runId: string
  eventType: RuntimeEventType
  payload: unknown
  createdAt: string
}

export interface RunRecord {
  id: string
  workspaceId: string
  requirementId: string
  threadId: string
  threadTitle: string | null
  task: string
  status: RunStatus
  skill: string | null
  skillVersion: string | null
  changeResult: ChangeResult | null
  analysisResult: RequirementAnalysisResult | null
  flowResult: BusinessFlowResult | null
  solutionResult: SolutionDesignResult | null
  interactionResult: InteractionDesignResult | null
  prototypeResult: PrototypeResult | null
  productSpecResult: ProductSpecResult | null
  requirementReviewResult: RequirementReviewResult | null
  tools: string[]
  readFiles: string[]
  changedFiles: string[]
  startedAt: string
  finishedAt: string | null
  error: string | null
  provider: ModelProviderId | null
  model: string | null
  turnId: string | null
  runtimeType: RuntimeType | null
  runtimeEvents: RuntimeEventType[]
  toolCalls: ToolCallRecord[]
  approval: WriteApprovalRequest | null
  context: RunContextMetadata | null
}

export interface PersistenceApi {
  getSelection: (workspaceId: string) => Promise<DesktopSelection>
  setActiveRequirement: (workspaceId: string, requirementId: string) => Promise<void>
  listThreads: (workspaceId: string, requirementId: string) => Promise<ThreadRecord[]>
  createThread: (workspaceId: string, requirementId: string, title: string) => Promise<ThreadRecord>
  renameThread: (threadId: string, title: string) => Promise<ThreadRecord>
  deleteThread: (threadId: string) => Promise<void>
  setActiveThread: (workspaceId: string, requirementId: string, threadId: string) => Promise<void>
  listMessages: (threadId: string) => Promise<MessageRecord[]>
  appendUserMessage: (workspaceId: string, requirementId: string, threadId: string, content: string) => Promise<MessageRecord>
  listRuns: (workspaceId: string) => Promise<RunRecord[]>
  listRunEvents: (runId: string) => Promise<RunEventRecord[]>
}
