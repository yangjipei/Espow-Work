export const runtimeIpc = {
  getStatus: 'runtime:get-status'
} as const

export type RuntimeType = 'espow-runtime'
export type RuntimeProcessStatus = 'stopped' | 'starting' | 'running' | 'error'

export interface RuntimeStatus {
  runtimeType: RuntimeType
  label: string
  status: RuntimeProcessStatus
  version: string
  activeRunId: string | null
  error: string | null
}

export type RuntimeEventType =
  | 'run_started'
  | 'model_started'
  | 'message_delta'
  | 'message_completed'
  | 'tool_started'
  | 'tool_completed'
  | 'followup_decision'
  | 'model_usage'
  | 'intent_recognized'
  | 'model_gate_evaluated'
  | 'context_budget_applied'
  | 'script_started'
  | 'script_completed'
  | 'state_updated'
  | 'state_validated'
  | 'question_projection'
  | 'question_delivery_guard'
  | 'question_gate'
  | 'approval_required'
  | 'run_completed'
  | 'run_cancelled'
  | 'run_failed'

export interface RuntimeApi {
  getStatus: () => Promise<RuntimeStatus>
}
