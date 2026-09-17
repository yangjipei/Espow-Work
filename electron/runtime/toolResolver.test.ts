import assert from 'node:assert/strict'
import test from 'node:test'
import type { SelectedSkill } from '../skills/skillRegistry'
import { resolveTools } from './toolResolver'

function skill(id: string, allowedTools: string[]): SelectedSkill {
  return { id, name: id, version: '1', mode: 'analysis', instructions: '', clarificationRequired: false, allowedTools }
}

test('需求分析补充事实只暴露 terminal submit', () => {
  const result = resolveTools('需求目标：降低处理耗时', skill('requirement-analysis', ['artifact_find', 'artifact_read', 'analysis_turn_submit']))
  assert.deepEqual(result.tools, ['analysis_turn_submit'])
})

test('只有明确核对原始资料才允许需求分析回读 Source', () => {
  const selected = skill('requirement-analysis', ['artifact_find', 'artifact_read', 'analysis_turn_submit'])
  assert.deepEqual(resolveTools('解绑后立即终止正在执行的任务', selected).tools, ['analysis_turn_submit'])
  assert.deepEqual(resolveTools('请核对原始附件中的解绑规则', selected).tools, ['artifact_find', 'artifact_read', 'analysis_turn_submit'])
})

test('阶段生成不向模型暴露确认后写入能力', () => {
  const result = resolveTools('生成业务流程', skill('business-flow', ['artifact_read', 'business_flow_next_version', 'business_flow_ready', 'business_flow_submit', 'business_flow_write', 'workspace_validate']))
  assert.deepEqual(result.tools, ['artifact_read', 'business_flow_next_version', 'business_flow_ready', 'business_flow_submit'])
})

test('Delta 按受影响 Artifact 选择工具', () => {
  const names = ['artifact_find', 'artifact_read', 'artifact_diff', 'change_result_submit', 'product_spec_next_version', 'product_spec_ready', 'product_spec_submit', 'prototype_submit']
  const result = resolveTools('把规则补到 PRD', skill('requirement-change', names))
  assert.deepEqual(result.tools, ['artifact_find', 'artifact_read', 'artifact_diff', 'change_result_submit', 'product_spec_next_version', 'product_spec_ready', 'product_spec_submit'])
})
