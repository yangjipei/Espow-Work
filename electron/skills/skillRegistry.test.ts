import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { SkillRegistry } from './skillRegistry'

const registry = new SkillRegistry(join(process.cwd(), 'skills'))

test('明确 Delta 选择 requirement-change 并带版本', () => {
  const selected = registry.select('录音归档失败不重试不告警，补到 PRD，并检查流程是否受影响。')
  assert.equal(selected?.id, 'requirement-change')
  assert.equal(selected?.version, '0.1.0')
  assert.equal(selected?.mode, 'delta')
  assert.equal(selected?.clarificationRequired, false)
})

test('Skill 默认加载 Runtime Capsule，明确完整分析时回退 Full Skill', () => {
  const capsule = registry.select('开始分析当前需求')
  assert.equal(capsule?.loadMode, 'capsule')
  assert.match(capsule?.instructions ?? '', /Runtime Skill Capsule/)
  assert.match(capsule?.instructions ?? '', /Decision Rules/)
  const full = registry.select('重新完整分析当前需求并加载完整 Skill 规则')
  assert.equal(full?.loadMode, 'full')
  assert.match(full?.instructions ?? '', /^# 需求分析/)
})

test('局部 UI 变化选择 requirement-change', () => {
  const selected = registry.select('联系人列表新增号码状态字段，并检查操作记录是否需要同步调整。')
  assert.equal(selected?.id, 'requirement-change')
  assert.equal(selected?.clarificationRequired, false)
})

test('“补到 PRD”类明确补充请求选择 requirement-change', () => {
  assert.equal(registry.select('这个规则补到 PRD。')?.id, 'requirement-change')
})

test('模糊 Delta 进入 Clarification Required', () => {
  const selected = registry.select('这个规则调整一下。')
  assert.equal(selected?.id, 'requirement-change')
  assert.equal(selected?.clarificationRequired, true)
})

test('普通 Artifact 问答不强制选择 Skill', () => {
  assert.equal(registry.select('这个 PRD 讲了什么？'), null)
})

test('全新模糊诉求选择 requirement-analysis', () => {
  const selected = registry.select('我想优化催收联系人和客户消息这一块，现在坐席判断联系人效率比较低，而且 WhatsApp 客户回复也容易错过。')
  assert.equal(selected?.id, 'requirement-analysis')
  assert.equal(selected?.version, '0.4.0')
  assert.equal(selected?.mode, 'analysis')
})

test('重新梳理已有需求选择 requirement-analysis', () => {
  assert.equal(registry.select('重新帮我梳理一下这个需求现在到底解决什么问题。')?.id, 'requirement-analysis')
})

test('明确 Delta 不被 Requirement Analysis 抢占', () => {
  assert.equal(registry.select('联系人列表新增号码状态字段。')?.id, 'requirement-change')
})

test('已有 PRD 但要求纠正问题定义时仍选择 requirement-analysis', () => {
  assert.equal(registry.select('现有 PRD 把消息中心当成问题了，重新分析一下需求真正要解决的问题。')?.id, 'requirement-analysis')
})

test('已有清晰业务描述但显式要求需求分析时选择 requirement-analysis', () => {
  assert.equal(registry.select('做需求分析：坐席收到客户回复后需要在原案件内处理并记录结果。')?.id, 'requirement-analysis')
})

test('首次引导按钮文案稳定选择 requirement-analysis', () => {
  assert.equal(registry.select('开始分析当前需求')?.id, 'requirement-analysis')
})

test('基于已确认需求分析生成业务流程时选择 business-flow', () => {
  const selected = registry.select('基于已经确认的需求分析，生成 DeviceConnect Voice 的完整业务流程。')
  assert.equal(selected?.id, 'business-flow')
  assert.equal(selected?.version, '0.2.0')
  assert.equal(selected?.mode, 'flow')
})

test('已有流程规则变化仍由 requirement-change 判断影响', () => {
  assert.equal(registry.select('录音归档失败不重试不告警，看看流程需不需要改。')?.id, 'requirement-change')
  assert.equal(registry.select('修改现有业务流程中的录音归档失败分支。')?.id, 'requirement-change')
})

test('基于已确认 Analysis 与 Flow 设计产品方案时选择 solution-design', () => {
  const selected = registry.select('基于已经确认的需求分析和业务流程，设计 DeviceConnect Voice 的产品方案。')
  assert.equal(selected?.id, 'solution-design')
  assert.equal(selected?.version, '0.2.0')
  assert.equal(selected?.mode, 'solution')
})

test('明确说明不做方案设计时不会误路由 solution-design', () => {
  assert.equal(registry.select('补充事实：当前没有全局入口。本期只分析问题，不做方案设计。')?.id, 'requirement-analysis')
})

test('修改现有产品方案仍先由 requirement-change 做影响判断', () => {
  assert.equal(registry.select('修改现有产品方案中的 Query 补偿能力。')?.id, 'requirement-change')
  assert.equal(registry.select('取消 Query 补偿。')?.id, 'requirement-change')
})

test('基于确认方案设计页面交互时选择 interaction-design', () => {
  const selected = registry.select('基于已确认产品方案，设计 DeviceConnect Voice 的 App 交互')
  assert.equal(selected?.id, 'interaction-design')
  assert.equal(selected?.version, '0.2.0')
})

test('删除现有交互取消按钮仍先由 requirement-change 做影响判断', () => {
  assert.equal(registry.select('删除现有交互设计中的前端取消按钮')?.id, 'requirement-change')
})

test('基于确认交互生成 HTML 页面原型时选择 prototype', () => {
  const selected = registry.select('基于已确认的交互方案，生成可操作的 HTML 页面原型。')
  assert.equal(selected?.id, 'prototype')
  assert.equal(selected?.version, '0.2.0')
  assert.equal(selected?.mode, 'prototype')
})

test('基于已确认设计生成 PRD 时选择 product-spec', () => {
  const skill = registry.select('基于已确认的分析、流程和方案生成产品需求文档 PRD')
  assert.equal(skill?.id, 'product-spec')
  assert.equal(skill?.version, '0.2.0')
})

test('修改现有 PRD 规则仍先由 requirement-change 定位影响', () => {
  assert.equal(registry.select('把重试取消规则补到 PRD')?.id, 'requirement-change')
})

test('正式需求评审选择 requirement-review', () => {
  const skill = registry.select('评审一下当前需求是否已经具备研发条件')
  assert.equal(skill?.id, 'requirement-review')
  assert.equal(skill?.version, '0.2.0')
  assert.equal(skill?.mode, 'review')
  assert.equal(registry.select('评审 Prototype 与 PRD 是否一致')?.id, 'requirement-review')
})

test('明确生成 PRD 不会被通用效率描述误路由为需求分析', () => {
  assert.equal(registry.select('生成 PRD，优化流程效率。')?.id, 'product-spec')
})

test('已有未收敛阶段可强制延续原 Skill', () => {
  assert.equal(registry.select('管理员和运营人员。', true)?.id, 'requirement-analysis')
  assert.equal(registry.select('达到上限后记录失败状态。', false, false, true)?.id, 'solution-design')
  assert.equal(registry.select('阻断项已处理。', false, false, false, false, false, false, true)?.id, 'requirement-review')
})
