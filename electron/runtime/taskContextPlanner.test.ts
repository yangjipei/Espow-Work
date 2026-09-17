import assert from 'node:assert/strict'
import test from 'node:test'
import { createStageState } from './lifecycleStageStateEngine'
import { planTaskContext } from './taskContextPlanner'

test('通用任务保留 Thread History，生命周期 Stage 默认不依赖 History', () => {
  const general = planTaskContext({ task: '继续聊一下', activeStageId: null, activeStageState: null, hasCurrentStageCandidate: false })
  assert.equal(general.strategy, 'general')
  assert.equal(general.includeThreadHistory, true)

  const analysis = planTaskContext({
    task: '补充一条规则', activeStageId: 'requirement-analysis',
    activeStageState: createStageState('w', 'r', 'requirement-analysis'), hasCurrentStageCandidate: false
  })
  assert.equal(analysis.strategy, 'analysis-mainline')
  assert.equal(analysis.includeThreadHistory, false)
  assert.equal(analysis.includeRequirementMemory, false)
})

test('首次进入 Stage 只注入必要上游 Stage Mainline，并允许按需读取 Artifact', () => {
  const plan = planTaskContext({
    task: '基于需求分析生成业务流程', activeStageId: 'business-flow',
    activeStageState: createStageState('w', 'r', 'business-flow'), hasCurrentStageCandidate: false
  })
  assert.equal(plan.strategy, 'stage-bootstrap')
  assert.deepEqual(plan.upstreamStageIds, ['requirement-analysis'])
  assert.equal(plan.includeThreadHistory, false)
  assert.equal(plan.includeArtifactMetadata, true)
  assert.equal(plan.currentStageCandidateMode, 'none')
})

test('已有小候选的同 Stage 修改以内联候选作为 Delta Source，不重放上游正文', () => {
  const stage = createStageState('w', 'r', 'solution-design')
  ;(stage.slots as { capabilities: string[] }).capabilities = ['CAP-01 设备呼叫']
  const plan = planTaskContext({
    task: '补充设备忙时的恢复规则', activeStageId: 'solution-design', activeStageState: stage,
    hasCurrentStageCandidate: true, currentStageCandidateTokens: 2_000
  })
  assert.equal(plan.strategy, 'stage-delta')
  assert.deepEqual(plan.upstreamStageIds, ['requirement-analysis', 'business-flow'])
  assert.equal(plan.currentStageCandidateMode, 'inline')
  assert.equal(plan.includeArtifactMetadata, false)
})

test('大候选降级为引用，避免单轮把完整 Stage Candidate 塞入 Prompt', () => {
  const stage = createStageState('w', 'r', 'product-spec')
  ;(stage.slots as { functionalRequirements: string[] }).functionalRequirements = ['FR-01 Device call']
  const plan = planTaskContext({
    task: '调整 PRD 的异常处理', activeStageId: 'product-spec', activeStageState: stage,
    hasCurrentStageCandidate: true, currentStageCandidateTokens: 9_000
  })
  assert.equal(plan.strategy, 'stage-delta')
  assert.equal(plan.currentStageCandidateMode, 'reference')
  assert.equal(plan.includeArtifactMetadata, true)
})

test('Requirement Review 始终以 Artifact 证据按需读取，不内联旧 Review 全文', () => {
  const stage = createStageState('w', 'r', 'requirement-review')
  const plan = planTaskContext({
    task: '继续评审当前需求', activeStageId: 'requirement-review', activeStageState: stage,
    hasCurrentStageCandidate: true, currentStageCandidateTokens: 1_000
  })
  assert.equal(plan.strategy, 'stage-review')
  assert.deepEqual(plan.upstreamStageIds, ['product-spec'])
  assert.equal(plan.currentStageCandidateMode, 'reference')
  assert.equal(plan.includeArtifactMetadata, true)
  assert.equal(plan.includeThreadHistory, false)
})

test('显式 Full Context 是受控逃生口，不改变 Stage Mainline 主状态', () => {
  const plan = planTaskContext({
    task: '加载全部上下文重新核对方案', activeStageId: 'solution-design',
    activeStageState: createStageState('w', 'r', 'solution-design'), hasCurrentStageCandidate: false,
    forceFullContext: true
  })
  assert.equal(plan.includeThreadHistory, true)
  assert.equal(plan.includeRequirementMemory, true)
  assert.equal(plan.includeWorkspaceDecisions, true)
  assert.equal(plan.includeArtifactMetadata, true)
  assert.deepEqual(plan.upstreamStageIds, ['requirement-analysis', 'business-flow'])
})
