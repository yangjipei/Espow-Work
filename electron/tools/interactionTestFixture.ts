import type { InteractionDesignModel } from '../../src/skills'

export function interactionFixture(status: InteractionDesignModel['status'] = 'READY_FOR_CONFIRMATION'): InteractionDesignModel {
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
      { id: 'ACT-RETRY', name: '重试', componentId: 'COMP-CARD', priority: 'secondary', trigger: '创建失败后点击重试', preconditions: ['失败可恢复'], result: '重新进入创建中', feedbackIds: ['FB-CREATING'], sourceCapabilityIds: ['CAP-02'], sourceFlowNodeIds: ['done'], sourceScenarioIds: ['S001'] }
    ],
    states: [
      { id: 'STATE-DEFAULT', name: '可发起', componentId: 'COMP-CALL', kind: 'default', description: '显示主操作', visibleInformation: ['Device call'], availableActionIds: ['ACT-CALL'], reason: null },
      { id: 'STATE-DISABLED', name: '不可发起', componentId: 'COMP-CALL', kind: 'disabled', description: '按钮不可操作并解释原因', visibleInformation: ['缺少设备标识'], availableActionIds: [], reason: '当前案件没有 deviceTag / IMEI' },
      { id: 'STATE-CREATING', name: '创建中', componentId: 'COMP-CARD', kind: 'loading', description: '禁止重复创建', visibleInformation: ['正在创建通话'], availableActionIds: [], reason: null },
      { id: 'STATE-ERROR', name: '创建失败', componentId: 'COMP-CARD', kind: 'error', description: '展示用户可理解的错误', visibleInformation: ['设备暂时无法呼叫，请稍后重试'], availableActionIds: ['ACT-RETRY'], reason: null },
      { id: 'STATE-DONE', name: '已完成', componentId: 'COMP-CARD', kind: 'completed', description: '结果已回写', visibleInformation: ['通话结果'], availableActionIds: [], reason: null }
    ],
    transitions: [
      { id: 'TR-CREATE', fromStateId: 'STATE-DEFAULT', toStateId: 'STATE-CREATING', trigger: '发起呼叫', userActionId: 'ACT-CALL', systemFeedback: '显示创建中并禁用重复点击', recovery: null },
      { id: 'TR-FAIL', fromStateId: 'STATE-CREATING', toStateId: 'STATE-ERROR', trigger: '创建失败', userActionId: null, systemFeedback: '显示可行动错误', recovery: '用户可重试，案件上下文保持不变' },
      { id: 'TR-DONE', fromStateId: 'STATE-CREATING', toStateId: 'STATE-DONE', trigger: '结果回流', userActionId: null, systemFeedback: '更新通话卡片与案件历史', recovery: null }
    ],
    feedback: [{ id: 'FB-CREATING', trigger: '发起或重试', type: 'inline', message: '正在创建通话…', behavior: '卡片内显示' }],
    interactionRules: [{ id: 'RULE-CLOSE', trigger: '关闭通话卡片', condition: '通话事实已经创建', uiBehavior: '仅关闭卡片', userAction: '返回案件详情', systemFeedback: '历史记录仍可查看', result: '不取消或删除通话事实', relatedCapabilityIds: ['CAP-02'], relatedFlowNodeIds: ['done'] }],
    userPaths: [{ id: 'PATH-CALL', name: '单页面呼叫', steps: ['进入案件详情', '点击 Device call', '查看创建中', '通话完成', '结果回写'], sourceCapabilityIds: ['CAP-01', 'CAP-02'], sourceFlowNodeIds: ['start', 'done'], sourceScenarioIds: ['S001'] }],
    decisions: [], openQuestions: [], solutionConflicts: [], flowConflicts: [], uiReferencePaths: ['prototype/case-detail-v1.html'],
    semanticChecks: { mainScenariosCompletable: true, noDeadEnds: true, errorsHaveFeedback: true, recoveryExists: true, crossPageContextPreserved: true, cognitiveLoadAcceptable: true },
    sourceAnalysisPath: 'analysis/requirement-analysis.md', sourceAnalysisStatus: 'confirmed', sourceFlowPath: 'flows/business-flow-v1.json', sourceFlowStatus: 'confirmed', sourceSolutionPath: 'solution/solution-design-v1.json', sourceSolutionStatus: 'confirmed', confirmedAt: null
  }
}
