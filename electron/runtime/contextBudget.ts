import type { RuntimeContextPart, RuntimeToolSpec } from './agentRuntime'
import { estimateTokens } from './tokenEstimator'

export interface ContextBudgetInput {
  parts: RuntimeContextPart[]
  systemPrompt: string
  tools: RuntimeToolSpec[]
  maxInputTokens: number
}

export interface ContextBudgetResult {
  parts: RuntimeContextPart[]
  maxInputTokens: number
  fixedTokens: number
  estimatedTokensBefore: number
  estimatedTokensAfter: number
  droppedSources: string[]
  droppedPartCount: number
}

const sourcePriority: Record<RuntimeContextPart['source'], number> = {
  user: 0,
  mainline: 0,
  working: 0,
  skill: 0,
  stage_slot: 0,
  workspace: 1,
  artifact: 2,
  history: 3,
  other: 4,
  system: 4,
  tools: 4
}

function partTokens(part: RuntimeContextPart): number {
  return estimateTokens(part.content)
}

function fixedTokens(systemPrompt: string, tools: RuntimeToolSpec[]): number {
  // Reserve a small protocol/message envelope so the hard limit applies to the real Provider payload,
  // not only to the visible context text.
  return estimateTokens(systemPrompt) + estimateTokens(JSON.stringify(tools)) + 256
}

export function applyContextBudget(input: ContextBudgetInput): ContextBudgetResult {
  if (!Number.isFinite(input.maxInputTokens) || input.maxInputTokens < 1) {
    throw new Error('Context maxInputTokens 必须大于 0。')
  }
  const fixed = fixedTokens(input.systemPrompt, input.tools)
  const budgetForParts = input.maxInputTokens - fixed
  const weighted = input.parts.map((part, index) => ({ part, index, tokens: partTokens(part), priority: sourcePriority[part.source] ?? 4 }))
  const before = fixed + weighted.reduce((sum, item) => sum + item.tokens, 0)
  if (before <= input.maxInputTokens) {
    return {
      parts: [...input.parts], maxInputTokens: input.maxInputTokens, fixedTokens: fixed,
      estimatedTokensBefore: before, estimatedTokensAfter: before, droppedSources: [], droppedPartCount: 0
    }
  }
  if (budgetForParts <= 0) {
    throw new Error(`CONTEXT_BUDGET_EXCEEDED: System Prompt 与 Tool Schema 已超过输入预算 ${input.maxInputTokens} tokens。`)
  }

  const required = weighted.filter((item) => item.priority === 0)
  const requiredTokens = required.reduce((sum, item) => sum + item.tokens, 0)
  if (requiredTokens > budgetForParts) {
    throw new Error(`CONTEXT_BUDGET_EXCEEDED: 当前任务、Mainline/Working、Skill 或 Stage State 等必要上下文约 ${requiredTokens} tokens，超过可用预算 ${budgetForParts} tokens。`)
  }

  const kept = new Set(required.map((item) => item.index))
  let used = requiredTokens
  const optional = weighted.filter((item) => item.priority > 0)
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
  for (const item of optional) {
    if (used + item.tokens > budgetForParts) continue
    kept.add(item.index)
    used += item.tokens
  }

  const parts = weighted.filter((item) => kept.has(item.index)).sort((a, b) => a.index - b.index).map((item) => item.part)
  const dropped = weighted.filter((item) => !kept.has(item.index))
  const droppedSources = [...new Set(dropped.map((item) => item.part.source))]
  const notice: RuntimeContextPart = {
    source: 'stage_slot',
    content: `Context Budget Notice: omitted optional sources [${droppedSources.join(', ')}]. Do not assume omitted context is absent as a fact; use the allowed Tool when it is required for the current task.`
  }
  let after = fixed + parts.reduce((sum, part) => sum + partTokens(part), 0)
  if (dropped.length && after + partTokens(notice) <= input.maxInputTokens) {
    const userIndex = parts.findIndex((part) => part.source === 'user')
    if (userIndex >= 0) parts.splice(userIndex, 0, notice)
    else parts.push(notice)
    after += partTokens(notice)
  }
  return {
    parts,
    maxInputTokens: input.maxInputTokens,
    fixedTokens: fixed,
    estimatedTokensBefore: before,
    estimatedTokensAfter: after,
    droppedSources,
    droppedPartCount: dropped.length
  }
}
