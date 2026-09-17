import assert from 'node:assert/strict'
import test from 'node:test'
import type { InteractionDesignModel } from '../../src/skills'
import { interactionDesignReadiness, parseInteractionDesignJson, renderInteractionDesignMarkdown } from './interactionDesign'

export function interactionCandidate(status: InteractionDesignModel['status'] = 'READY_FOR_CONFIRMATION'): InteractionDesignModel {
  return {
    id: 'IXD-DEVICE', name: 'DeviceConnect Voice 交互', overview: '在现有案件详情内完成单次设备通话并保留案件上下文。', status,
    surfaces: [{ id: 'SURFACE-APP', name: 'App 案件详情', type: 'App', purpose: '发起与查看通话', existing: true, sourceCapabilityIds: ['CAP-01', 'CAP-02'] }],
    pages: [{ id: 'PAGE-CASE', name: '案件详情', surfaceId: 'SURFACE-APP', purpose: '保持案件上下文', sections: ['联系信息', '通话卡片'], entryPoints: ['案件列表点击案件'], sourceCapabilityIds: ['CAP-01', 'CAP-02'], sourceFlowNodeIds: ['start', 'done'], sourceScenarioIds: ['S001'] }],
    components: [
      { id: 'COMP-CALL', name: 'Device call 操作', pageId: 'PAGE-CASE', section: '联系信息', kind: 'Inline Action', purpose: '发起通话', informationPriority: 'primary', sourceCapabilityIds: ['CAP-01'], sourceFlowNodeIds: ['start'], sourceScenarioIds: ['S001'] },
      { id: 'COMP-CARD', name: '通话卡片', pageId: 'PAGE-CASE', section: '通话卡片', kind: 'Card / WebView', purpose: '展示创建、通话与结果', informationPriority: 'primary', sourceCapabilityIds: ['CAP-02'], sourceFlowNodeIds: ['done'], sourceScenarioIds: ['S001'] }
    ],
    actions: [
      { id: 'ACT-CALL', name: '发起呼叫', componentId: 'COMP-CALL', priority: 'primary', trigger: '点击 Device call', preconditions: ['存在设备标识', '麦克风已授权'], result: '进入创建中', feedbackIds: ['FB-CREATING'], sourceCapabilityIds: ['CAP-01'], sourceFlowNodeIds: ['start'], sourceScenarioIds: ['S001'] },
      { id: 'ACT-RETRY', name: '重试', componentId: 'COMP-CARD', priority: 'secondary', trigger: '创建失败后点击重试', preconditions: ['失败可恢复'], result: '重新进入创建中', feedbackIds: ['FB-CREATING'], sourceCapabilityIds: ['CAP-02'], sourceFlowNodeIds: ['done'], sourceScenarioIds: ['S001'] },
      { id: 'ACT-CLOSE', name: '关闭卡片', componentId: 'COMP-CARD', priority: 'secondary', trigger: '点击关闭', preconditions: [], result: '关闭 UI 但保留通话事实', feedbackIds: [], sourceCapabilityIds: ['CAP-02'], sourceFlowNodeIds: ['done'], sourceScenarioIds: ['S001'] }
    ],
    states: [
      { id: 'STATE-DEFAULT', name: '可发起', componentId: 'COMP-CALL', kind: 'default', description: '显示主操作', visibleInformation: ['Device call'], availableActionIds: ['ACT-CALL'], reason: null },
      { id: 'STATE-DISABLED', name: '不可发起', componentId: 'COMP-CALL', kind: 'disabled', description: '按钮不可操作并解释原因', visibleInformation: ['缺少设备标识'], availableActionIds: [], reason: '当前案件没有 deviceTag / IMEI' },
      { id: 'STATE-CREATING', name: '创建中', componentId: 'COMP-CARD', kind: 'loading', description: '禁止重复创建，可继续查看案件', visibleInformation: ['正在创建通话'], availableActionIds: ['ACT-CLOSE'], reason: null },
      { id: 'STATE-ERROR', name: '创建失败', componentId: 'COMP-CARD', kind: 'error', description: '展示用户可理解的错误', visibleInformation: ['设备暂时无法呼叫，请稍后重试'], availableActionIds: ['ACT-RETRY', 'ACT-CLOSE'], reason: null },
      { id: 'STATE-DONE', name: '已完成', componentId: 'COMP-CARD', kind: 'completed', description: '结果已回写', visibleInformation: ['通话结果'], availableActionIds: ['ACT-CLOSE'], reason: null }
    ],
    transitions: [
      { id: 'TR-CREATE', fromStateId: 'STATE-DEFAULT', toStateId: 'STATE-CREATING', trigger: '发起呼叫', userActionId: 'ACT-CALL', systemFeedback: '显示创建中并禁用重复点击', recovery: null },
      { id: 'TR-FAIL', fromStateId: 'STATE-CREATING', toStateId: 'STATE-ERROR', trigger: '创建失败', userActionId: null, systemFeedback: '显示可行动错误', recovery: '用户可重试，案件上下文保持不变' },
      { id: 'TR-DONE', fromStateId: 'STATE-CREATING', toStateId: 'STATE-DONE', trigger: '结果回流', userActionId: null, systemFeedback: '更新通话卡片与案件历史', recovery: null }
    ],
    feedback: [{ id: 'FB-CREATING', trigger: '发起或重试', type: 'inline', message: '正在创建通话…', behavior: '卡片内显示，不使用 Toast' }],
    interactionRules: [
      { id: 'RULE-CLOSE', trigger: '关闭通话卡片', condition: '通话事实已经创建', uiBehavior: '仅关闭卡片', userAction: '返回案件详情', systemFeedback: '历史记录仍可查看', result: '不取消或删除通话事实', relatedCapabilityIds: ['CAP-02'], relatedFlowNodeIds: ['done'] },
      { id: 'RULE-CROSS', trigger: '案件 B 收到 WhatsApp', condition: '用户正在案件 A', uiBehavior: '全局消息入口显示 Badge', userAction: '点击后打开案件 B 对应消息', systemFeedback: '保留案件 A 未提交输入', result: '完成跨上下文跳转', relatedCapabilityIds: ['CAP-02'], relatedFlowNodeIds: ['done'] }
    ],
    userPaths: [{ id: 'PATH-CALL', name: '单页面呼叫', steps: ['进入案件详情', '点击 Device call', '查看创建中', '通话完成', '结果回写'], sourceCapabilityIds: ['CAP-01', 'CAP-02'], sourceFlowNodeIds: ['start', 'done'], sourceScenarioIds: ['S001'] }],
    decisions: [], openQuestions: [], solutionConflicts: [], flowConflicts: [], uiReferencePaths: ['prototype/case-detail-v1.html'],
    semanticChecks: { mainScenariosCompletable: true, noDeadEnds: true, errorsHaveFeedback: true, recoveryExists: true, crossPageContextPreserved: true, cognitiveLoadAcceptable: true },
    sourceAnalysisPath: 'analysis/requirement-analysis.md', sourceAnalysisStatus: 'confirmed', sourceFlowPath: 'flows/business-flow-v1.json', sourceFlowStatus: 'confirmed', sourceSolutionPath: 'solution/solution-design-v1.json', sourceSolutionStatus: 'confirmed', confirmedAt: null
  }
}

test('Interaction Model 表达入口、单页面路径、Modal/WebView、异步状态、关闭语义与跨上下文提醒', () => {
  const model = parseInteractionDesignJson(JSON.stringify(interactionCandidate()))
  const ready = interactionDesignReadiness(model, ['CAP-01', 'CAP-02'])
  assert.equal(ready.deterministicPassed, true)
  const markdown = renderInteractionDesignMarkdown(model)
  assert.match(markdown, /Device call/)
  assert.match(markdown, /关闭 UI 但保留通话事实/)
  assert.match(markdown, /案件 B 收到 WhatsApp/)
  assert.doesNotMatch(markdown, /font-size|border-radius|<html/i)
})

test('Ready Validator 拒绝悬空能力、无入口、Disabled 无原因、异常无恢复和引用错误', () => {
  const model = interactionCandidate()
  model.surfaces[0].sourceCapabilityIds = ['CAP-01']
  model.pages[0].sourceCapabilityIds = ['CAP-01']
  model.components[1].sourceCapabilityIds = []
  model.actions[1].sourceCapabilityIds = []
  model.pages[0].entryPoints = []
  model.states[1].reason = null
  model.transitions[1].recovery = null
  model.actions[0].feedbackIds = ['MISSING']
  const result = interactionDesignReadiness(model, ['CAP-01', 'CAP-02', 'CAP-03'])
  assert.equal(result.deterministicPassed, false)
  assert.ok(result.missing.includes('capability_unplaced:CAP-03'))
  assert.ok(result.missing.some((item) => item.startsWith('page_entry_missing')))
  assert.ok(result.missing.some((item) => item.startsWith('disabled_reason_missing')))
  assert.ok(result.missing.some((item) => item.startsWith('error_recovery_missing')))
})

test('Decision、Open Question、Solution Conflict 与 Flow Conflict 会阻止 Ready，但可保持 Waiting Clarification', () => {
  const model = interactionCandidate('WAITING_CLARIFICATION')
  model.decisions = [{ id: 'DEC-01', question: '消息采用弹窗还是消息中心？', options: [{ name: '消息中心', benefit: '低打扰', cost: '需要主动查看', impact: '新增全局入口' }, { name: '弹窗', benefit: '强提醒', cost: '打断工作', impact: '保留当前输入' }], affectedElementIds: ['RULE-CROSS'] }]
  model.openQuestions = ['跨案件提醒方式待确认']
  assert.equal(interactionDesignReadiness(model, ['CAP-01', 'CAP-02']).deterministicPassed, true)
  model.status = 'READY_FOR_CONFIRMATION'
  model.solutionConflicts = ['Solution 未定义补偿状态']
  model.flowConflicts = ['交互取消与 Flow 不一致']
  const result = interactionDesignReadiness(model, ['CAP-01', 'CAP-02'])
  assert.equal(result.deterministicPassed, false)
  assert.ok(result.missing.includes('unresolved_decisions'))
  assert.ok(result.missing.includes('solution_conflicts'))
  assert.ok(result.missing.includes('flow_conflicts'))
})
