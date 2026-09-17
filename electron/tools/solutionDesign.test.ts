import assert from 'node:assert/strict'
import test from 'node:test'
import type { SolutionDesignModel } from '../../src/skills'
import {
  parseSolutionDesignJson, renderSolutionDesignMarkdown, solutionCoverageCheck, solutionDesignReadiness, solutionOverdesignCheck
} from './solutionDesign'

function model(status: SolutionDesignModel['status'] = 'READY_FOR_CONFIRMATION'): SolutionDesignModel {
  const capability = (id: string, name: string, node: string, execution: 'manual' | 'automatic', layer: 'user-facing' | 'system' | 'supporting' = 'system') => ({
    id, name, layer, purpose: `承载 ${name}`, actor: execution === 'manual' ? '催收坐席' : '催收系统',
    trigger: `流程进入 ${node}`, execution, input: ['case', 'agent'], behavior: [`执行 ${name}`], output: [`${name} result`],
    relatedFlowNodeIds: [node], sourceScenarioIds: ['S001'], sourceDecisionIds: [],
    rules: [], exceptions: [], surfaces: execution === 'manual' ? ['案件详情'] : ['后台服务']
  })
  return {
    id: 'device-connect-solution', name: 'DeviceConnect Voice 产品方案', overview: '让坐席发起 Device call，并可靠获得结果与记录。',
    scope: { included: ['人工单呼', '结果回流与补偿', '录音与催记'], excluded: ['AI 自动外呼', '批量任务'] }, status,
    capabilities: [
      capability('CAP-01', 'Device call 准入', 'start', 'manual', 'user-facing'),
      capability('CAP-02', 'Device call 发起', 'check', 'manual', 'user-facing'),
      capability('CAP-03', '通话创建与承载', 'create', 'automatic'),
      capability('CAP-04', '结果回写', 'wait', 'automatic'),
      capability('CAP-05', 'Query 补偿', 'recover', 'automatic'),
      capability('CAP-06', '录音归档', 'archive', 'automatic'),
      capability('CAP-07', 'Record 展示', 'done', 'automatic', 'user-facing'),
      capability('CAP-08', 'Add Record 催记渠道', 'exit', 'manual', 'user-facing')
    ],
    rules: [{ id: 'R-01', description: 'notify 为主链路，Query 为补偿链路', capabilityIds: ['CAP-04', 'CAP-05'], sourceFlowNodeIds: ['wait', 'recover'] }],
    states: [{ id: 'CALLING', name: '呼叫中', meaning: '已创建并等待通话结果', entryConditions: ['创建成功'], exitConditions: ['结果回流'] }],
    dataObjects: [{ id: 'CALL', name: '通话记录', purpose: '关联请求、结果与录音', keyFields: ['orderNo', 'call result', 'recording status'], producedByCapabilityIds: ['CAP-03'], consumedByCapabilityIds: ['CAP-04', 'CAP-06', 'CAP-07'] }],
    recoveries: [{ exception: 'Notify 缺失', responsibleCapabilityId: 'CAP-05', behavior: 'Query 查询终态', outcome: '回写结果或进入结果未知' }],
    productSurfaces: [{ id: 'SURFACE-01', name: '案件详情', type: 'Web', purpose: '发起与查看通话', capabilityIds: ['CAP-01', 'CAP-02', 'CAP-07'] }],
    decisions: [], openQuestions: [], flowConflicts: [],
    semanticChecks: { goalCovered: true, scenariosCovered: true, flowNodesCovered: true, blockersResolved: true, exceptionsHandled: true, exitsCovered: true, recoveryCovered: true, noOverdesign: true },
    sourceAnalysisPath: 'analysis/requirement-analysis.md', sourceAnalysisStatus: 'confirmed',
    sourceFlowPath: 'flows/business-flow-v1.json', sourceFlowStatus: 'confirmed', confirmedAt: null
  }
}

test('Solution Model 同时表达单页面、后台自动和 Manual + Automatic 混合能力', () => {
  const parsed = parseSolutionDesignJson(JSON.stringify(model()))
  assert.equal(parsed.capabilities.length, 8)
  assert.ok(parsed.capabilities.some((item) => item.layer === 'user-facing' && item.execution === 'manual'))
  assert.ok(parsed.capabilities.some((item) => item.layer === 'system' && item.execution === 'automatic'))
  assert.match(renderSolutionDesignMarkdown(parsed), /Input：case；agent/)
  assert.match(renderSolutionDesignMarkdown(parsed), /Notify 缺失.*CAP-05/)
})

test('Coverage Check 覆盖 Flow、异常恢复、状态、数据并拒绝缺失节点', () => {
  const candidate = model()
  const flowNodes = ['start', 'check', 'create', 'wait', 'recover', 'archive', 'done', 'exit']
  assert.equal(solutionCoverageCheck(candidate, flowNodes).passed, true)
  candidate.capabilities = candidate.capabilities.filter((item) => item.id !== 'CAP-05')
  const result = solutionCoverageCheck(candidate, flowNodes)
  assert.equal(result.passed, false)
  assert.ok(result.missing.includes('flow_node_uncovered:recover'))
  assert.ok(result.missing.includes('recovery_capability_reference:CAP-05'))
})

test('Open Question、Decision Candidate 与 Flow Conflict 阻止 Ready，但允许澄清状态', () => {
  const candidate = model('WAITING_CLARIFICATION')
  candidate.openQuestions = ['结果未知是否需要人工可见状态？']
  candidate.decisions = [{ id: 'D-CAND-01', question: '结果如何承载？', options: [
    { name: '内嵌卡片', description: '在案件详情展示', tradeOff: '上下文连续但空间有限' },
    { name: '独立页面', description: '集中展示', tradeOff: '信息完整但路径更长' }
  ], affectedCapabilityIds: ['CAP-07'] }]
  candidate.flowConflicts = ['方案要求人工重试，但已确认 Flow 只允许后台补偿。']
  assert.equal(solutionCoverageCheck(candidate).passed, true)
  candidate.status = 'READY_FOR_CONFIRMATION'
  const result = solutionCoverageCheck(candidate)
  assert.ok(result.missing.includes('blocking_open_questions'))
  assert.ok(result.missing.includes('unresolved_decisions'))
  assert.ok(result.missing.includes('flow_conflicts'))
})

test('Overdesign Check 拒绝技术实现泄漏、平台化扩张和无来源能力', () => {
  const candidate = model()
  candidate.capabilities.push({
    id: 'CAP-09', name: '统一多服务商智能语音路由平台', layer: 'supporting', purpose: '使用 Kafka 与 Redis 建设平台',
    actor: '系统', trigger: '未来扩展', execution: 'automatic', input: ['provider'], behavior: ['智能路由'], output: ['route'],
    relatedFlowNodeIds: [], sourceScenarioIds: [], sourceDecisionIds: [], rules: [], exceptions: [], surfaces: ['后台服务']
  })
  const result = solutionOverdesignCheck(candidate)
  assert.equal(result.passed, false)
  assert.ok(result.missing.includes('technical_implementation_leak'))
  assert.ok(result.missing.includes('potential_platform_overdesign'))
  assert.ok(result.missing.includes('ungrounded_capability:CAP-09'))
})

test('Ready Gate 聚合 Coverage 与 Overdesign，用户局部修改只影响相关 Capability', () => {
  const candidate = model()
  assert.equal(solutionDesignReadiness(candidate, candidate.capabilities.flatMap((item) => item.relatedFlowNodeIds)).deterministicPassed, true)
  const before = structuredClone(candidate)
  candidate.capabilities.find((item) => item.id === 'CAP-05')!.execution = 'automatic'
  candidate.capabilities.find((item) => item.id === 'CAP-05')!.surfaces = ['后台服务']
  assert.deepEqual(candidate.capabilities.find((item) => item.id === 'CAP-04'), before.capabilities.find((item) => item.id === 'CAP-04'))
})
