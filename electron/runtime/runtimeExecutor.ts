import { EspowToolService, type ToolExecutionContext, type ToolName } from '../tools/toolService'

export type FollowupReason = 'NO_FOLLOWUP' | 'NEW_INFORMATION' | 'CONFLICT_FOUND' | 'EXECUTION_FAILED' | 'REPLAN_REQUIRED' | 'MISSING_CONTEXT'

export interface FollowupDecision {
  required: boolean
  reason: FollowupReason
}

const discoveryTools = new Set<ToolName>([
  'workspace_read', 'artifact_find', 'artifact_read', 'artifact_next_version',
  'business_flow_next_version', 'business_flow_ready', 'solution_design_next_version',
  'solution_coverage_check', 'solution_overdesign_check', 'interaction_design_next_version',
  'interaction_design_ready', 'prototype_ready', 'product_spec_next_version', 'product_spec_ready',
  'requirement_review_next_version', 'requirement_review_ready', 'requirement_review_status', 'artifact_diff'
])

const terminalResults: Array<[string, string]> = [
  ['changeResult', '需求变更影响分析已完成。'],
  ['flowResult', '业务流程候选已生成，请查看并确认。'],
  ['solutionResult', '产品方案候选已生成，请查看并确认。'],
  ['interactionResult', '交互设计候选已生成，请查看并确认。'],
  ['prototypeResult', '页面原型候选已生成，请查看并确认。'],
  ['productSpecResult', '产品规格候选已生成，请查看并确认。'],
  ['requirementReviewResult', '需求评审候选已生成，请查看并确认。']
]

function terminalReply(output: Record<string, unknown>): string | null {
  if (typeof output.assistantReply === 'string' && output.assistantReply.trim()) return output.assistantReply.trim()
  for (const [key, fallback] of terminalResults) {
    const value = output[key]
    if (!value || typeof value !== 'object') continue
    if (key === 'changeResult') {
      const result = value as Record<string, unknown>
      const summary = typeof result.changeSummary === 'string' ? result.changeSummary : fallback
      const questions = Array.isArray(result.openQuestions) && result.openQuestions.length
        ? `\n\n待确认：${result.openQuestions.join('；')}` : ''
      return `${summary}${questions}`
    }
    return fallback
  }
  return null
}

export function decideFollowup(name: ToolName, output: Record<string, unknown>): FollowupDecision {
  if (terminalReply(output)) return { required: false, reason: 'NO_FOLLOWUP' }
  if (discoveryTools.has(name)) return { required: true, reason: 'NEW_INFORMATION' }
  if (output.status === 'conflict' || output.status === 'stale') return { required: true, reason: 'CONFLICT_FOUND' }
  return { required: false, reason: 'NO_FOLLOWUP' }
}

export class RuntimeExecutor {
  constructor(private readonly tools: EspowToolService) {}

  async execute(name: ToolName, args: unknown, context: ToolExecutionContext): Promise<Record<string, unknown>> {
    const output = await this.tools.execute(name, args, context)
    const followup = decideFollowup(name, output)
    const assistantReply = terminalReply(output)
    return {
      ...output,
      __espowFollowup: followup,
      ...(assistantReply ? { __espowTerminal: true, assistantReply } : {})
    }
  }
}
