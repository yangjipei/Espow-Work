import assert from 'node:assert/strict'
import test from 'node:test'
import type { BusinessFlowModel } from '../../src/skills'
import { businessFlowDiff, businessFlowReadiness, renderBusinessFlowHtml } from './businessFlow'

function linear(): BusinessFlowModel {
  return {
    id: 'linear', name: '简单线性流程', scope: { goal: '完成一次业务处理', included: ['处理'], excluded: [] },
    status: 'READY_FOR_CONFIRMATION',
    actors: [{ id: 'user', name: '业务用户', role: '发起', source: 'S1' }, { id: 'system', name: '业务系统', role: '处理', source: 'S1' }],
    nodes: [
      { id: 'start', type: 'start', title: '开始', description: '', actorId: 'user', stage: '发起', stateChange: null, sourceScenarioIds: ['S1'], sourceDecisionIds: [] },
      { id: 'action', type: 'system', title: '系统处理', description: '', actorId: 'system', stage: '处理', stateChange: '处理中', sourceScenarioIds: ['S1'], sourceDecisionIds: [] },
      { id: 'end', type: 'end', title: '完成', description: '', actorId: 'system', stage: '完成', stateChange: '已完成', sourceScenarioIds: ['S1'], sourceDecisionIds: [] }
    ],
    edges: [
      { id: 'e1', from: 'start', to: 'action', label: '提交', type: 'main' },
      { id: 'e2', from: 'action', to: 'end', label: '处理完成', type: 'main' }
    ],
    entry: 'start', exits: [{ nodeId: 'end', condition: '处理完成', recordBehavior: '记录结果', stateImpact: '终态', retryable: '否' }],
    openQuestions: [],
    semanticChecks: { mainScenarioCovered: true, blockersHandled: true, keyExitsCovered: true, asyncRecoveryCovered: true, closedLoop: true },
    sourceAnalysisPath: 'analysis/requirement-analysis.md', sourceAnalysisStatus: 'confirmed', confirmedAt: null
  }
}

test('Flow Ready Validator 接受简单线性、多 Actor 且闭环的流程', () => {
  const result = businessFlowReadiness(linear())
  assert.equal(result.deterministicPassed, true)
  assert.equal(result.semanticReady, true)
})

test('Flow Ready Validator 拒绝无结束、孤立节点与 Decision 缺失分支', () => {
  const noEnd = linear()
  noEnd.nodes = noEnd.nodes.filter((node) => node.id !== 'end')
  noEnd.edges = noEnd.edges.filter((edge) => edge.to !== 'end')
  assert.ok(businessFlowReadiness(noEnd).missing.includes('end_missing'))

  const isolated = linear()
  isolated.nodes.push({ id: 'orphan', type: 'action', title: '孤立节点', description: '', actorId: 'user', stage: '处理', stateChange: null, sourceScenarioIds: [], sourceDecisionIds: [] })
  assert.ok(businessFlowReadiness(isolated).missing.includes('isolated_incoming:orphan'))

  const decision = linear()
  decision.nodes[1] = { ...decision.nodes[1], type: 'decision', title: '是否满足条件？' }
  assert.ok(businessFlowReadiness(decision).missing.includes('decision_branches:action'))
})

test('异步等待缺少恢复路径会给出警告，HTML 保持主流程常显并折叠补充信息', () => {
  const flow = linear()
  flow.nodes[1] = { ...flow.nodes[1], type: 'wait', title: '等待异步结果' }
  const readiness = businessFlowReadiness(flow)
  assert.ok(readiness.warnings.includes('async_recovery_edge_missing'))
  const html = renderBusinessFlowHtml(flow)
  assert.match(html, /class="main-flow"/)
  assert.match(html, /<details class="supplement">/)
  assert.match(html, /全部收起/)
})

test('结构化 Flow Diff 精确报告节点与连线的新增、删除和变化', () => {
  const before = linear()
  const after = linear()
  after.nodes[1] = { ...after.nodes[1], title: '更新后的处理' }
  after.nodes.push({ id: 'retry', type: 'action', title: '恢复处理', description: '', actorId: 'system', stage: '恢复', stateChange: null, sourceScenarioIds: ['S1'], sourceDecisionIds: [] })
  after.edges = [{ ...after.edges[0], label: '确认提交' }, after.edges[1], { id: 'e3', from: 'retry', to: 'end', label: '恢复成功', type: 'recovery' }]
  const diff = businessFlowDiff(before, after)
  assert.deepEqual(diff.addedNodes, ['retry'])
  assert.deepEqual(diff.changedNodes, ['action'])
  assert.deepEqual(diff.addedEdges, ['e3'])
  assert.deepEqual(diff.changedEdges, ['e1'])
})
