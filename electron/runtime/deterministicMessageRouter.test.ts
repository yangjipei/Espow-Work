import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDeterministicQuery } from './deterministicMessageRouter'

test('明确状态、阶段和目标查询走确定性路由', () => {
  assert.equal(parseDeterministicQuery('当前需求状态是什么？'), 'status')
  assert.equal(parseDeterministicQuery('现在到哪一阶段了'), 'stage')
  assert.equal(parseDeterministicQuery('需求目标是什么'), 'goal')
  assert.equal(parseDeterministicQuery('结论呢？'), 'conclusion')
})

test('需要分析的开放问题不误判为确定性查询', () => {
  assert.equal(parseDeterministicQuery('当前需求还有什么风险？'), null)
})
