import assert from 'node:assert/strict'
import test from 'node:test'
import type { RuntimeContextPart } from './agentRuntime'
import { applyContextBudget } from './contextBudget'

const tools = [{ name: 'analysis_turn_submit', description: 'submit', parameters: { type: 'object' }, terminal: true }]

test('Context Budget 在预算足够时保持原 Context', () => {
  const parts: RuntimeContextPart[] = [
    { source: 'mainline', content: '主线'.repeat(100) },
    { source: 'user', content: '当前输入' }
  ]
  const result = applyContextBudget({ parts, systemPrompt: 'system', tools, maxInputTokens: 4_000 })
  assert.deepEqual(result.parts, parts)
  assert.equal(result.droppedPartCount, 0)
  assert.ok(result.estimatedTokensAfter <= 4_000)
})

test('Context Budget 优先保留当前任务、Mainline、Skill 与 Stage State，先丢弃历史和 Artifact 元数据', () => {
  const parts: RuntimeContextPart[] = [
    { source: 'workspace', content: 'workspace'.repeat(250) },
    { source: 'history', content: '历史'.repeat(1_400) },
    { source: 'artifact', content: 'artifact'.repeat(500) },
    { source: 'skill', content: 'skill'.repeat(120) },
    { source: 'stage_slot', content: 'stage'.repeat(120) },
    { source: 'mainline', content: '主线'.repeat(250) },
    { source: 'user', content: '本轮用户输入'.repeat(80) }
  ]
  const result = applyContextBudget({ parts, systemPrompt: 'system'.repeat(50), tools, maxInputTokens: 2_500 })
  assert.equal(result.parts.some((part) => part.source === 'user'), true)
  assert.equal(result.parts.some((part) => part.source === 'mainline'), true)
  assert.equal(result.parts.some((part) => part.source === 'skill'), true)
  assert.equal(result.parts.some((part) => part.source === 'stage_slot'), true)
  assert.ok(result.droppedSources.includes('history') || result.droppedSources.includes('artifact'))
  assert.ok(result.estimatedTokensAfter <= 2_500)
})

test('Context Budget 不静默截断必要上下文', () => {
  const parts: RuntimeContextPart[] = [
    { source: 'mainline', content: '主线'.repeat(2_000) },
    { source: 'user', content: '输入'.repeat(1_000) }
  ]
  assert.throws(
    () => applyContextBudget({ parts, systemPrompt: 'system', tools, maxInputTokens: 1_000 }),
    /CONTEXT_BUDGET_EXCEEDED/
  )
})
