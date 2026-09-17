import assert from 'node:assert/strict'
import test from 'node:test'
import type { RequirementAnalysisResult } from '../../src/skills'
import {
  applyAnalysisTurn,
  buildAnalysisProjection,
  calculateAnalysisReadiness,
  createEmptyAnalysisState,
  deriveAnalysisStateForThread,
  gateAnalysisQuestions,
  migrateLegacyAnalysisState
} from './analysisStateEngine'

test('首次只生成 proposed Blueprint，确认后保持 Schema 稳定并显式扩展 Module', () => {
  let state = createEmptyAnalysisState('workspace', 'requirement', 'thread')
  state = applyAnalysisTurn(state, {
    assistantReply: '建议按流程和外部接入分析，请确认主线。', patches: [], resolvedQuestionIds: [], newQuestions: [],
    schemaDelta: { status: 'proposed', requirementTypes: ['workflow', 'integration'], modules: ['workflow', 'trigger_conditions', 'exit_conditions', 'identifier', 'callback', 'idempotency'] },
    workingDelta: { currentTopic: 'mainline_blueprint', currentQuestion: { id: 'mainline_blueprint', question: '是否确认该分析主线？', options: [{ id: 'A', label: '确认' }, { id: 'B', label: '调整' }] } }
  })
  assert.equal(state.mainlineSchema.status, 'proposed')
  assert.ok(state.mainlineSchema.modules.includes('requirement_summary'))
  assert.ok(state.mainlineSchema.modules.includes('callback'))
  assert.equal(state.working.currentQuestion?.options[1]?.id, 'B')

  state = applyAnalysisTurn(state, {
    assistantReply: '主线已确认。', patches: [], resolvedQuestionIds: ['mainline_blueprint'], newQuestions: [],
    schemaDelta: { status: 'confirmed' }, workingDelta: { clearCurrentQuestion: true, currentTopic: null }
  })
  assert.equal(state.mainlineSchema.status, 'confirmed')
  assert.equal(state.working.currentQuestion, null)
  const schemaVersion = state.mainlineSchema.version

  state = applyAnalysisTurn(state, {
    assistantReply: '已增加账务模块。', patches: [], resolvedQuestionIds: [], newQuestions: [],
    schemaDelta: { addModules: ['billing'] }
  })
  assert.equal(state.mainlineSchema.version, schemaVersion + 1)
  assert.ok(state.mainlineSchema.modules.includes('billing'))
})

test('Mainline 连续补充、替换旧值和 12 Turn 后只保留当前态', () => {
  let state = createEmptyAnalysisState('workspace', 'requirement', 'thread')
  state.mainlineSchema = { version: 1, status: 'confirmed', requirementTypes: ['integration'], modules: [...state.mainlineSchema.modules, 'identifier'] }
  state = applyAnalysisTurn(state, {
    assistantReply: '', resolvedQuestionIds: [], newQuestions: [],
    patches: [{ op: 'replace', path: '/modules/identifier', value: { supported: ['deviceTag', 'IMEI'], priority: ['deviceTag', 'IMEI'], editable: false }, status: 'confirmed', source: 'user' }]
  })
  state = applyAnalysisTurn(state, {
    assistantReply: '', resolvedQuestionIds: [], newQuestions: [],
    patches: [{ op: 'add', path: '/rules/-', value: { subject: '每日轮次', condition: '每天', action: '最多 5 轮' }, status: 'confirmed', source: 'user' }]
  })
  for (let turn = 0; turn < 10; turn += 1) {
    state = applyAnalysisTurn(state, {
      assistantReply: '', resolvedQuestionIds: [], newQuestions: [],
      patches: [{ op: 'replace', path: '/rules/R1', value: { subject: '每日轮次', condition: '每天', action: `最多 ${turn === 9 ? 3 : 4} 轮` }, status: 'confirmed', source: 'user' }]
    })
  }
  assert.deepEqual(state.moduleData.identifier.value, { supported: ['deviceTag', 'IMEI'], priority: ['deviceTag', 'IMEI'], editable: false })
  assert.equal(state.rules.length, 1)
  assert.equal(state.rules[0]?.action, '最多 3 轮')
  assert.doesNotMatch(JSON.stringify(state), /最多 5 轮/)
})

test('Analysis State 使用增量 Patch、确定性 ID、Question Resolve 与 Readiness', () => {
  const initial = createEmptyAnalysisState('workspace', 'requirement', 'thread')
  initial.mainlineSchema.status = 'confirmed'
  initial.openQuestions.push({
    id: 'Q1', topic: 'scope', question: '是否仅做 App？', priority: 'blocking', reason: '影响范围', status: 'open'
  })
  const next = applyAnalysisTurn(initial, {
    assistantReply: '已确认本期只做 App。',
    patches: [
      { op: 'replace', path: '/problem/currentProblem', value: '坐席无法及时处理客户回复', status: 'confirmed', source: 'user' },
      { op: 'add', path: '/goals/businessGoals/-', value: '确保客户回复被及时处理', source: 'user' },
      { op: 'add', path: '/scenarios/-', value: { actor: '催收坐席', trigger: '客户回复', painPoint: '跨案件无法感知', expectedOutcome: '及时处理回复' }, status: 'confirmed', source: 'user' },
      { op: 'replace', path: '/flow/mainFlow', value: ['客户回复', '系统提醒坐席', '坐席处理'], source: 'user' },
      { op: 'add', path: '/rules/-', value: { subject: '提醒', condition: '收到客户回复', action: '生成全局消息提醒' }, status: 'confirmed', source: 'user' },
      { op: 'add', path: '/scope/inScope/-', value: 'App', source: 'user' },
      { op: 'add', path: '/scope/outOfScope/-', value: 'Web', source: 'user' }
    ],
    resolvedQuestionIds: ['Q1'],
    newQuestions: []
  })

  assert.equal(next.version, 2)
  assert.equal(next.scenarios[0]?.scenarioId, 'S1')
  assert.equal(next.scenarios[0]?.status, 'confirmed')
  assert.equal(next.rules[0]?.ruleId, 'R1')
  assert.equal(next.openQuestions[0]?.status, 'closed')
  assert.equal(next.readiness.blockingQuestions, 0)
  assert.equal(next.readiness.readyForConfirmation, true)
  assert.equal(next.readiness.status, 'READY_TO_CONFIRM')
})

test('Question Gate 删除阶段确认型问题并延后 Toast 等非阻塞细节', () => {
  let state = createEmptyAnalysisState('workspace', 'requirement', 'thread')
  state.mainlineSchema.status = 'confirmed'
  state = applyAnalysisTurn(state, {
    assistantReply: '', resolvedQuestionIds: [], newQuestions: [],
    patches: [
      { op: 'replace', path: '/problem/currentProblem', value: '账号同步失败后缺少反馈', source: 'user' },
      { op: 'add', path: '/goals/businessGoals/-', value: '提升同步成功率', source: 'user' },
      { op: 'add', path: '/scenarios/-', value: { actor: '运营', trigger: '同步账号', painPoint: '失败原因不可见', expectedOutcome: '明确反馈结果' }, status: 'confirmed', source: 'user' },
      { op: 'replace', path: '/flow/mainFlow', value: ['提交同步', '系统执行', '返回结果'], source: 'user' },
      { op: 'add', path: '/rules/-', value: { subject: '同步', condition: '执行失败', action: '返回失败状态' }, status: 'confirmed', source: 'user' },
      { op: 'add', path: '/scope/inScope/-', value: '账号同步', source: 'user' }
    ]
  })
  assert.equal(state.readiness.readyForConfirmation, true)
  const gated = gateAnalysisQuestions(state, [
    { topic: 'lifecycle', question: '以上内容是否可以作为本期需求分析基线？', priority: 'blocking', reason: '阶段确认' },
    { topic: 'toast', question: 'Toast 文案是否写成“94账号同步失败，请重试”？', priority: 'non_blocking', reason: '文案细节', targetStage: 'interaction-design' }
  ])
  assert.equal(gated.droppedCount, 1)
  assert.equal(gated.deferredCount, 1)
  assert.equal(gated.state.openQuestions[0]?.status, 'deferred')
  assert.equal(gated.state.readiness.readyForConfirmation, true)
})

test('Question Gate 阻止重复问题，并保留真正改变主流程的阻塞项', () => {
  const state = createEmptyAnalysisState('workspace', 'requirement', 'thread')
  state.mainlineSchema.status = 'confirmed'
  state.decisions.push({ id: 'D1', topic: 'format', decision: '账号格式与组命名格式不做强一致限制', reason: '', status: 'confirmed' })
  const gated = gateAnalysisQuestions(state, [
    { topic: 'format', question: '账号格式与组命名格式不做强一致限制吗？', priority: 'blocking', reason: '规则确认' },
    { topic: 'main_flow', question: '解绑账号时，运行中的任务是立即终止还是等待完成？', priority: 'blocking', reason: '不解决会导致主流程存在两个不同方案' }
  ])
  assert.equal(gated.droppedCount, 1)
  assert.equal(gated.blockingCount, 1)
  assert.equal(gated.state.openQuestions.find((item) => item.status === 'open')?.type, 'BLOCKING')
  assert.equal(gated.state.readiness.readyForConfirmation, false)
})

test('Analysis State 检测明确范围冲突并阻止确认', () => {
  const initial = createEmptyAnalysisState('workspace', 'requirement', 'thread')
  initial.mainlineSchema.status = 'confirmed'
  const next = applyAnalysisTurn(initial, {
    assistantReply: '需要继续确认范围。',
    patches: [
      { op: 'add', path: '/scope/inScope/-', value: 'Web', source: 'user' },
      { op: 'add', path: '/scope/outOfScope/-', value: 'Web', source: 'user' }
    ],
    resolvedQuestionIds: [],
    newQuestions: []
  })
  assert.equal(next.openQuestions.some((item) => item.priority === 'blocking' && item.status === 'open'), true)
  assert.equal(next.readiness.readyForConfirmation, false)
  assert.match(next.openQuestions[0]?.question ?? '', /Web/)
})

test('Working State Projection 只保留有效工作记忆，不重复 resolved question', () => {
  const state = createEmptyAnalysisState('workspace', 'requirement', 'thread')
  state.problem.currentProblem = { value: '客户回复容易错过', status: 'confirmed', source: 'user', updatedAt: new Date().toISOString(), openIssueId: null }
  state.scope.inScope = ['App']
  state.openQuestions = [
    { id: 'Q1', topic: 'scope', question: '已解决问题', priority: 'blocking', reason: '', status: 'resolved' },
    { id: 'Q2', topic: 'flow', question: '失败时如何退出？', priority: 'blocking', reason: '影响主流程', status: 'open' }
  ]
  state.readiness = calculateAnalysisReadiness(state)
  const projection = buildAnalysisProjection(state)
  assert.match(projection, /客户回复容易错过/)
  assert.match(projection, /Q2 失败时如何退出/)
  assert.doesNotMatch(projection, /已解决问题/)
  assert.ok(projection.length < JSON.stringify(state).length)
})

test('历史 Requirement Analysis 可迁移为 Analysis State', () => {
  const legacy: RequirementAnalysisResult = {
    analysisStatus: 'Analyzing', problemDefinition: '坐席无法跨案件感知消息', goal: '及时处理回复',
    actors: [{ name: '坐席', role: '处理客户回复' }],
    scenarios: [{ id: 'S001', name: '回复', actor: '坐席', trigger: '客户回复', currentFlow: ['逐案查看'], blocker: '容易错过', expectedOutcome: '及时提醒', status: '关键场景' }],
    currentFlow: ['客户回复', '坐席查看'], blockers: [],
    rootCauses: [{ description: '缺少统一入口', evidenceType: 'FACT', source: '历史分析' }],
    boundaries: ['只做 App'], facts: [], assumptions: [], decisions: ['使用全局提醒'],
    openQuestions: ['RCS 是否同样处理？'], outOfScope: ['Web'],
    readiness: { deterministicPassed: false, semanticReady: false, missing: [] },
    artifactPath: 'analysis/requirement-analysis.md', artifactCandidate: '', artifactBaseHash: null, confirmedAt: null
  }
  const migrated = migrateLegacyAnalysisState('workspace', 'requirement', 'thread', legacy)
  assert.equal(migrated.source, 'migrated')
  assert.equal(migrated.problem.currentProblem.value, legacy.problemDefinition)
  assert.equal(migrated.scenarios.length, 1)
  assert.equal(migrated.decisions[0]?.decision, '使用全局提醒')
  assert.equal(migrated.openQuestions[0]?.priority, 'blocking')
})


test('同一需求新 Thread 可派生已有 Analysis State，但保持独立 Thread 身份', () => {
  const source = createEmptyAnalysisState('workspace', 'requirement', 'thread-a')
  source.problem.currentProblem = { value: '已确认问题', status: 'confirmed', source: 'user', updatedAt: new Date().toISOString(), openIssueId: null }
  source.scope.inScope = ['App']
  source.version = 4
  const derived = deriveAnalysisStateForThread(source, 'workspace', 'requirement', 'thread-b')
  assert.equal(derived.threadId, 'thread-b')
  assert.equal(derived.source, 'derived')
  assert.equal(derived.version, 4)
  assert.equal(derived.problem.currentProblem.value, '已确认问题')
  assert.deepEqual(derived.scope.inScope, ['App'])
  derived.scope.inScope.push('Web')
  assert.deepEqual(source.scope.inScope, ['App'])
})
