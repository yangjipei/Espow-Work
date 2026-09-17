import assert from 'node:assert/strict'
import test from 'node:test'
import { intentFromControlEvent, recognizeControlCommand, routeTurn } from './turnRouter'

test('Turn Router 将明确槽位和状态查询送入 Script Path', () => {
  assert.equal(routeTurn('需求目标：降低处理耗时').path, 'script')
  assert.equal(routeTurn('当前需求状态是什么？').path, 'script')
})

test('Turn Router 对普通语义任务直接进入主 Agent，不先调用 Intent LLM', () => {
  assert.deepEqual(routeTurn('分析当前方案是否遗漏异常路径'), {
    path: 'agent', intent: 'UNKNOWN', reason: '普通自由文本直接进入当前 Stage / Skill，由主 Agent 完成一次语义理解。'
  })
})

test('Turn Router 仅把短且有歧义的控制语义交给 Intent Recognition', () => {
  assert.equal(routeTurn('这个可以了吗', 'prototype').path, 'recognition')
  assert.equal(routeTurn('取消任务后允许重新创建任务', 'requirement-analysis').path, 'agent')
})

test('Turn Router 只为短且独立的控制命令提供 Fast Path', () => {
  assert.equal(recognizeControlCommand('继续', 'requirement-analysis')?.intent, 'CONTINUE_STAGE')
  assert.equal(recognizeControlCommand('确认', 'business-flow')?.intent, 'CONFIRM_STAGE')
  assert.equal(recognizeControlCommand('确认这个方案方向，但账号解绑逻辑还要改。', 'solution-design'), null)
  assert.equal(routeTurn('继续', 'requirement-analysis').path, 'script')
  assert.equal(routeTurn('结论呢？').path, 'script')
})

test('Structured UI Event 跳过 Intent Recognition', () => {
  const intent = intentFromControlEvent({ type: 'CONFIRM_STAGE', stageId: 'prototype' })
  assert.equal(intent.source, 'UI_EVENT')
  assert.equal(intent.intent, 'CONFIRM_STAGE')
  assert.equal(routeTurn('', 'prototype', { type: 'CONFIRM_STAGE', stageId: 'prototype' }).path, 'script')
})
