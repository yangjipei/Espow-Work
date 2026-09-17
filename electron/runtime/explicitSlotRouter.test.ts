import assert from 'node:assert/strict'
import test from 'node:test'
import { parseExplicitSlotUpdate } from './explicitSlotRouter'
import { routeSlotEditor } from './slotRouter'
import { slotRegistry } from '../../src/slotRegistry'

test('明确需求目标直接解析为 confirmed Analysis Slot Patch', () => {
  const update = parseExplicitSlotUpdate('需求目标：\n1. 降低处理耗时\n2. 统一账号规则')
  assert.equal(update?.slot, '/goals/businessGoals')
  assert.deepEqual(update?.values, ['降低处理耗时', '统一账号规则'])
  assert.deepEqual(update?.patches[0], {
    op: 'replace', path: '/goals/businessGoals', value: ['降低处理耗时', '统一账号规则'], status: 'confirmed', source: 'user'
  })
})

test('模糊自然语言不误判为明确槽位', () => {
  assert.equal(parseExplicitSlotUpdate('现在账号体系比较乱，希望统一一下。'), null)
})

test('同一消息中的多个明确槽位一次性确定性解析', () => {
  const update = parseExplicitSlotUpdate('需求目标：统一账号规则\n范围：94 账号\n非范围：历史数据迁移')
  assert.equal(update?.patches.length, 3)
  assert.equal(update?.slot, '/goals/businessGoals,/scope/inScope,/scope/outOfScope')
})

test('其他生命周期 Stage 使用同一个 Registry Router', () => {
  const update = parseExplicitSlotUpdate('退出条件：账号关闭完成并记录审计日志')
  assert.equal(update?.stage, 'business-flow')
  assert.equal(update?.slot, 'exits')
  assert.equal(update?.executionMode, 'SCRIPT')
  assert.equal(update?.source, 'explicit_slot_heading')
  const editor = routeSlotEditor({ stageId: 'solution-design', slotId: 'recoveries' }, '失败后重试一次')
  assert.equal(editor?.source, 'explicit_slot_editor')
  assert.equal(editor?.executionMode, 'SCRIPT')
  assert.equal(new Set(slotRegistry.map((slot) => slot.stageId)).size, 7)
})
