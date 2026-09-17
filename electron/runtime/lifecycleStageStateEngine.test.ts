import test from 'node:test'
import assert from 'node:assert/strict'
import { createEmptyAnalysisState } from './analysisStateEngine'
import {
  buildSharedProjection,
  buildStageProjection,
  createSharedRequirementState,
  createStageState,
  markDownstreamStagesStale,
  sharedStateFromAnalysis,
  stageStateFromAnalysis
} from './lifecycleStageStateEngine'

test('每个生命周期阶段拥有独立 Slot Schema 与 Readiness', () => {
  const ids = ['requirement-analysis','business-flow','solution-design','interaction-design','prototype','product-spec','requirement-review'] as const
  const slotKeys = ids.map((id) => Object.keys(createStageState('w','r',id).slots))
  assert.equal(new Set(slotKeys.map((keys) => keys.join('|'))).size, ids.length)
  assert.deepEqual(Object.keys(createStageState('w','r','business-flow').slots), ['actors','entry','mainFlow','decisionNodes','branches','exits','failurePaths','systemBoundaries'])
  assert.deepEqual(Object.keys(createStageState('w','r','product-spec').slots), ['functionalRequirements','businessRules','fields','stateMachine','permissions','exceptions','compatibility','dependencies','acceptanceCriteria'])
})

test('Analysis State 下沉为 requirement-analysis Stage State，并同步 Shared Requirement State', () => {
  const analysis = createEmptyAnalysisState('w','r','t')
  analysis.problem.currentProblem.value = '坐席无法稳定触达客户'
  analysis.problem.currentProblem.status = 'confirmed'
  analysis.goals.businessGoals.push('提升触达率')
  analysis.scenarios.push({ scenarioId:'S1', actor:'催收坐席', trigger:'处理案件', preconditions:[], intent:'联系客户', currentActions:[], painPoint:'号码失效', expectedOutcome:'成功触达', status:'confirmed' })
  analysis.flow.mainFlow.push('打开案件','发起呼叫')
  analysis.rules.push({ ruleId:'R1', subject:'设备标识', condition:'存在 deviceTag', action:'优先使用 deviceTag', priority:null, exception:null, status:'confirmed' })
  analysis.scope.inScope.push('App')
  const stage = stageStateFromAnalysis('w','r',analysis)
  assert.equal(stage.stageId, 'requirement-analysis')
  assert.match(buildStageProjection(stage), /当前|坐席|requirement-analysis/)
  const shared = sharedStateFromAnalysis(createSharedRequirementState({ workspaceId:'w', requirementId:'r', name:'Demo' }), analysis)
  assert.equal(shared.goal, '提升触达率')
  assert.deepEqual(shared.actors, ['催收坐席'])
  assert.match(buildSharedProjection(shared), /提升触达率/)
})

test('上游阶段更新只将已有下游阶段标记 stale，不重跑生命周期', () => {
  const analysis = createStageState('w','r','requirement-analysis')
  analysis.status = 'confirmed'
  const flow = createStageState('w','r','business-flow')
  flow.status = 'confirmed'
  const prd = createStageState('w','r','product-spec')
  prd.status = 'confirmed'
  const next = markDownstreamStagesStale([analysis, flow, prd], 'business-flow', '业务流程更新')
  assert.equal(next[0].status, 'confirmed')
  assert.equal(next[1].status, 'confirmed')
  assert.equal(next[2].status, 'stale')
  assert.match(next[2].staleReason ?? '', /业务流程更新/)
})
