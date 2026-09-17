import assert from 'node:assert/strict'
import test from 'node:test'
import { deterministicScript, runtimeExecutionPlan, shouldUseLLM } from './executionPolicy'

test('Requirement Analysis 使用独立 analysis-conversation 策略并强制最小 Tool 面', () => {
  const plan = runtimeExecutionPlan('requirement-analysis', [
    'artifact_find', 'artifact_read', 'analysis_turn_submit', 'product_spec_submit', 'artifact_write'
  ], shouldUseLLM({ action: 'ANALYZE_REQUIREMENT', caller: 'test', task: '分析需求' }))
  assert.equal(plan.mode, 'analysis-conversation')
  assert.equal(plan.maxSteps, 3)
  assert.equal(plan.maxModelCalls, 3)
  assert.equal(plan.terminalTool, 'analysis_turn_submit')
  assert.deepEqual(plan.allowedTools, ['artifact_find', 'artifact_read', 'analysis_turn_submit'])
})

test('统一 Gate 对明确槽位更新返回 0 Call，对模糊理解只允许 1 Call', () => {
  const explicit = shouldUseLLM({ action: 'UPDATE_EXPLICIT_SLOT', caller: 'test', task: '需求目标：降低耗时', slot: '/goals/businessGoals' })
  assert.equal(explicit.allow, false)
  assert.equal(explicit.maxCalls, 0)
  assert.equal(explicit.maxInputTokens, 0)
  const ambiguous = shouldUseLLM({ action: 'UNDERSTAND_AMBIGUOUS_INPUT', caller: 'test', task: '现在比较乱，统一一下' })
  assert.equal(ambiguous.allow, true)
  assert.equal(ambiguous.maxCalls, 1)
  assert.equal(ambiguous.maxInputTokens, 6_000)
})

test('确定性 Script 明确禁止模型执行', () => {
  const script = deterministicScript('analysis_readiness_calculator')
  assert.equal(script.deterministic, true)
  assert.equal(script.modelAllowed, false)
})
