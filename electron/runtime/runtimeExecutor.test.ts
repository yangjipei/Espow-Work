import assert from 'node:assert/strict'
import test from 'node:test'
import { decideFollowup } from './runtimeExecutor'

test('读取产生新信息，需要再次推理', () => {
  assert.deepEqual(decideFollowup('artifact_read', { content: '事实' }), { required: true, reason: 'NEW_INFORMATION' })
})

test('结构化提交由 Runtime 直接结束，不机械回模型', () => {
  assert.deepEqual(decideFollowup('business_flow_submit', { flowResult: { flowStatus: 'DRAFT' } }), { required: false, reason: 'NO_FOLLOWUP' })
})

test('确定性写入成功不需要 follow-up', () => {
  assert.deepEqual(decideFollowup('workspace_validate', { valid: true }), { required: false, reason: 'NO_FOLLOWUP' })
})
