import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SelectedSkill } from '../skills/skillRegistry'
import { PersistenceService } from '../persistenceService'
import { LocalWorkspaceService } from '../workspaceService'
import { ContextManager, serializeContextPackage, serializeContextParts } from './contextManager'
import { MemoryManager } from './memoryManager'
import { estimateTokens } from './tokenEstimator'
import { createStageState } from './lifecycleStageStateEngine'

const changeSkill: SelectedSkill = {
  id: 'requirement-change', name: '需求变更', version: '0.1.0', mode: 'delta',
  instructions: '只处理最小必要变更。', clarificationRequired: false, allowedTools: []
}

const analysisSkill: SelectedSkill = {
  id: 'requirement-analysis', name: '需求分析', version: '0.1.0', mode: 'analysis',
  instructions: '# 需求分析', clarificationRequired: false, allowedTools: []
}

const flowSkill: SelectedSkill = {
  id: 'business-flow', name: '业务流程', version: '0.1.0', mode: 'flow',
  instructions: '# 业务流程', clarificationRequired: false, allowedTools: []
}

const solutionSkill: SelectedSkill = {
  id: 'solution-design', name: '方案设计', version: '0.1.0', mode: 'solution',
  instructions: '# 方案设计', clarificationRequired: false, allowedTools: []
}

const interactionSkill: SelectedSkill = {
  id: 'interaction-design', name: '交互设计', version: '0.1.0', mode: 'interaction',
  instructions: '# 交互设计', clarificationRequired: false, allowedTools: []
}

const prototypeSkill: SelectedSkill = {
  id: 'prototype', name: '页面原型', version: '0.1.0', mode: 'prototype',
  instructions: '# 页面原型', clarificationRequired: false, allowedTools: []
}

const productSpecSkill: SelectedSkill = {
  id: 'product-spec', name: '产品需求文档', version: '0.1.0', mode: 'product-spec',
  instructions: '# 产品需求文档', clarificationRequired: false, allowedTools: []
}

const requirementReviewSkill: SelectedSkill = {
  id: 'requirement-review', name: '需求评审', version: '0.1.0', mode: 'review',
  instructions: '# 需求评审', clarificationRequired: false, allowedTools: []
}

async function fixture(): Promise<{
  directory: string
  requirementRoot: string
  workspaceId: string
  threadId: string
  persistence: PersistenceService
  workspace: LocalWorkspaceService
  manager: ContextManager
}> {
  const directory = await fs.mkdtemp(join(tmpdir(), 'espow-context-'))
  const requirementRoot = join(directory, 'workspace', 'requirements', 'DeviceConnect Voice')
  await fs.mkdir(join(requirementRoot, 'prd'), { recursive: true })
  await fs.mkdir(join(requirementRoot, 'flows'), { recursive: true })
  await fs.mkdir(join(requirementRoot, 'solution'), { recursive: true })
  await fs.writeFile(join(requirementRoot, 'state.yaml'), 'requirement_id: device-connect\nname: DeviceConnect Voice\nstatus: ACTIVE\nlifecycle_stage: prd\ncurrent_artifact: prd/device-prd-v3.md\nupdated_at: 2026-09-13\n')
  await fs.writeFile(join(requirementRoot, 'overview.md'), '# Overview\n\n## 当前目标\n\n稳定归档催收通话录音，并保持主流程一致。\n')
  const unrelatedDecisions = Array.from({ length: 20 }, (_, index) => `| D-${index + 10} | 2026-09-01 | 无关主题 ${index} | 其他模块 | Other | CONFIRMED |`).join('\n')
  await fs.writeFile(join(requirementRoot, '01-decisions.md'), `# Decisions\n\n| ID | 日期 | 决策 | 原因 | 影响 | 状态 |\n|---|---|---|---|---|---|\n| D-003 | 2026-09-12 | 录音归档失败不重试 | 避免重复归档 | PRD | CONFIRMED |\n${unrelatedDecisions}\n`)
  await fs.writeFile(join(requirementRoot, '02-open-issues.md'), '# Open Issues\n\n| ID | 问题 | 来源 | 影响 | Owner | 状态 |\n|---|---|---|---|---|---|\n| Q-001 | 录音归档是否告警 | Delta | PRD | 产品 | OPEN |\n| Q-002 | 已关闭问题 | 历史 | 无 | 产品 | CLOSED |\n')
  await fs.writeFile(join(requirementRoot, 'prd', 'device-prd-v3.md'), '# PRD\n\n## 录音归档\n\n失败后进入人工排查。\n')
  await fs.writeFile(join(requirementRoot, 'flows', 'business-flow.md'), '# Business Flow\n\n归档不改变主流程。\n')
  await fs.writeFile(join(requirementRoot, 'solution', 'solution.md'), '# Solution\n\n异步归档方案。\n')
  const workspace = new LocalWorkspaceService()
  const snapshot = await workspace.scan(join(directory, 'workspace'))
  const persistence = new PersistenceService(join(directory, 'app.sqlite'))
  persistence.saveWorkspace({ id: snapshot.id, path: snapshot.rootPath, name: snapshot.name })
  persistence.saveModelConfig({ provider: 'openai', apiKey: 'test-secret', model: 'test', baseUrl: 'https://example.com/v1' })
  const thread = persistence.createThread(snapshot.id, 'device-connect', 'Context Test')
  return {
    directory, requirementRoot, workspaceId: snapshot.id, threadId: thread.id,
    persistence, workspace, manager: new ContextManager(workspace, persistence, new MemoryManager(persistence))
  }
}

test('L0 只装配任务、Snapshot 与受限 Thread，不预载 Artifact', async (t) => {
  const value = await fixture()
  t.after(() => { value.persistence.close(); return fs.rm(value.directory, { recursive: true, force: true }) })
  const built = await value.manager.build({
    workspaceId: value.workspaceId, requirementId: 'device-connect', threadId: value.threadId,
    task: '这个需求当前目标是什么？', skill: null
  })
  assert.equal(built.package.level, 'L0')
  assert.match(built.package.requirement?.currentGoal ?? '', /稳定归档/)
  assert.deepEqual(built.package.artifacts, [])
  assert.deepEqual(built.package.decisions, [])
  assert.deepEqual(built.package.openIssues, [])
  assert.equal(built.metadata.snapshot?.refreshedForRun, true)
  const serialized = serializeContextPackage(built.package)
  const parts = serializeContextParts(built.package)
  assert.equal(parts.map((part) => part.content).join('\n\n'), serialized)
  assert.equal(parts.some((part) => part.source === 'workspace' && part.content.includes('Requirement Snapshot')), true)
  assert.equal(parts.some((part) => part.source === 'user' && part.content.includes(built.package.task)), true)
  assert.equal(serialized.includes('失败后进入人工排查'), false)
  assert.equal(serialized.includes('输出语言：默认使用简体中文'), false)
})

test('L1 Delta 只选择相关状态与 Artifact 元数据，并且只加载一个主 Skill', async (t) => {
  const value = await fixture()
  t.after(() => { value.persistence.close(); return fs.rm(value.directory, { recursive: true, force: true }) })
  const built = await value.manager.build({
    workspaceId: value.workspaceId, requirementId: 'device-connect', threadId: value.threadId,
    task: '录音归档失败不重试不告警，这个规则补到 PRD，并检查是否影响流程图。', skill: changeSkill
  })
  assert.equal(built.package.level, 'L1')
  assert.equal(built.package.skill?.id, 'requirement-change')
  assert.deepEqual(built.package.decisions.map((item) => item.id), ['D-003'])
  assert.deepEqual(built.package.openIssues.map((item) => item.id), ['Q-001'])
  assert.deepEqual(new Set(built.package.artifacts.map((item) => item.type)), new Set(['PRD', 'Business Flow']))
  assert.ok(built.package.artifacts.every((item) => item.content === null))
  assert.deepEqual(built.metadata.artifacts, [])
  assert.equal(built.package.runtimePolicies.length, 1)
})

test('L2 可装配多个相关 Artifact，但不会递归注入整个 Workspace', async (t) => {
  const value = await fixture()
  t.after(() => { value.persistence.close(); return fs.rm(value.directory, { recursive: true, force: true }) })
  for (let index = 0; index < 40; index += 1) {
    await fs.writeFile(join(value.requirementRoot, `unrelated-${index}.md`), `# unrelated ${index}\n`)
  }
  const built = await value.manager.build({
    workspaceId: value.workspaceId, requirementId: 'device-connect', threadId: value.threadId,
    task: '帮我检查这个需求从方案到 PRD 有没有明显不一致。', skill: null
  })
  assert.equal(built.package.level, 'L2')
  assert.ok(built.package.artifacts.some((item) => item.type === 'PRD'))
  assert.ok(built.package.artifacts.some((item) => item.type === 'Solution'))
  assert.ok(built.package.artifacts.length <= 8)
  assert.equal(built.package.artifacts.some((item) => item.path.startsWith('unrelated-')), false)
})

test('Snapshot 缺失时生成、有效时复用、正式 Artifact 变化后刷新', async (t) => {
  const value = await fixture()
  t.after(() => { value.persistence.close(); return fs.rm(value.directory, { recursive: true, force: true }) })
  const input = {
    workspaceId: value.workspaceId, requirementId: 'device-connect', threadId: value.threadId,
    task: '这个需求当前目标是什么？', skill: null
  }
  const first = await value.manager.build(input)
  const second = await value.manager.build(input)
  assert.equal(first.metadata.snapshot?.refreshedForRun, true)
  assert.equal(second.metadata.snapshot?.refreshedForRun, false)
  await fs.appendFile(join(value.requirementRoot, 'prd', 'device-prd-v3.md'), '\n新增正式规则。\n')
  const third = await value.manager.build(input)
  assert.equal(third.metadata.snapshot?.refreshedForRun, true)
  assert.notEqual(third.package.requirement?.sourceFingerprint, second.package.requirement?.sourceFingerprint)
})

test('超长 Thread 使用摘要加最近 Messages，并受数量与字符软预算限制', async (t) => {
  const value = await fixture()
  t.after(() => { value.persistence.close(); return fs.rm(value.directory, { recursive: true, force: true }) })
  for (let index = 0; index < 12; index += 1) {
    const run = value.persistence.startRun(value.workspaceId, 'device-connect', value.threadId, `历史问题 ${index} ${'问'.repeat(300)}`, value.persistence.getActiveModelConfig())
    value.persistence.completeRun(run.run.id, `历史结论 ${index} ${'答'.repeat(300)}`)
  }
  const built = await value.manager.build({
    workspaceId: value.workspaceId, requirementId: 'device-connect', threadId: value.threadId,
    task: '继续当前问题', skill: null
  })
  assert.ok(built.package.threadContext.messages.length <= 8)
  assert.equal(built.package.threadContext.truncated, true)
  assert.ok(built.package.threadContext.messages.reduce((sum, item) => sum + item.content.length, 0) <= 6_000)
  assert.ok(built.package.threadContext.summary)
  assert.ok(built.package.threadContext.compactedMessageCount > 0)
  const repeated = await value.manager.build({
    workspaceId: value.workspaceId, requirementId: 'device-connect', threadId: value.threadId,
    task: '继续当前问题', skill: null
  })
  assert.equal(repeated.package.threadContext.summary, built.package.threadContext.summary)
  assert.deepEqual(repeated.package.threadContext.messages, built.package.threadContext.messages)
})

test('Run 只在 artifact_read 实际完成后记录 Artifact Context 来源', async (t) => {
  const value = await fixture()
  t.after(() => { value.persistence.close(); return fs.rm(value.directory, { recursive: true, force: true }) })
  const built = await value.manager.build({
    workspaceId: value.workspaceId, requirementId: 'device-connect', threadId: value.threadId,
    task: '检查 PRD', skill: null
  })
  const started = value.persistence.startRun(
    value.workspaceId, 'device-connect', value.threadId, '检查 PRD', value.persistence.getActiveModelConfig(), undefined, null, built.metadata
  )
  assert.deepEqual(started.run.context?.artifacts, [])
  const completedAt = new Date().toISOString()
  const updated = value.persistence.recordToolCall(started.run.id, {
    id: 'read-1', name: 'artifact_read', status: 'Completed', startedAt: completedAt, completedAt, error: null
  }, { metadata: { id: 'prd-1', path: 'prd/device-prd-v3.md', type: 'PRD', section: '录音归档' } })
  assert.deepEqual(updated.context?.artifacts.map((item) => item.path), ['prd/device-prd-v3.md'])
  assert.ok(updated.context?.sources.includes('artifact:prd/device-prd-v3.md'))
})

test('Requirement Analysis 使用 L1 + Mainline/Working，默认不注入历史上下文', async (t) => {
  const value = await fixture()
  t.after(() => { value.persistence.close(); return fs.rm(value.directory, { recursive: true, force: true }) })
  await fs.mkdir(join(value.requirementRoot, 'source'), { recursive: true })
  await fs.mkdir(join(value.requirementRoot, 'analysis'), { recursive: true })
  await fs.writeFile(join(value.requirementRoot, 'source', 'business-note.md'), '# 业务方描述\n\n客户回复容易错过。')
  await fs.writeFile(join(value.requirementRoot, 'source', 'current-flow.txt'), '当前流程：逐个案件检查客户回复。')
  await fs.writeFile(join(value.requirementRoot, 'analysis', 'requirement-analysis.md'), '# Requirement Analysis\n\n旧分析。')
  await value.workspace.refreshRequirement('device-connect')
  const run = value.persistence.startRun(
    value.workspaceId, 'device-connect', value.threadId, '旧分析', value.persistence.getActiveModelConfig(), undefined, analysisSkill
  )
  value.persistence.setAnalysisResult(run.run.id, {
    analysisStatus: 'Analyzing', problemDefinition: '回复容易错过', goal: '及时处理回复',
    actors: [], scenarios: [], currentFlow: [], blockers: [], rootCauses: [], boundaries: [], facts: [], assumptions: [],
    decisions: [], openQuestions: ['当前是否有全局入口？'], outOfScope: [],
    readiness: { deterministicPassed: false, semanticReady: false, missing: ['actors'] },
    artifactPath: 'analysis/requirement-analysis.md', artifactCandidate: '', artifactBaseHash: null, confirmedAt: null
  })
  value.persistence.completeRun(run.run.id, '请补充当前入口情况。')
  const built = await value.manager.build({
    workspaceId: value.workspaceId, requirementId: 'device-connect', threadId: value.threadId,
    task: '重新帮我梳理一下这个需求到底解决什么问题。', skill: analysisSkill
  })
  assert.equal(built.package.level, 'L1')
  assert.equal(built.package.existingAnalysis, undefined)
  assert.ok(built.package.analysisWorkingState)
  assert.match(built.package.analysisWorkingState?.projection ?? '', /回复容易错过/)
  assert.match(built.package.analysisWorkingState?.projection ?? '', /当前是否有全局入口/)
  assert.ok(built.package.runtimePolicies.some((item) => item.id === 'analysis-conversation-runtime'))
  assert.ok(built.package.runtimePolicies.some((item) => item.id === 'analysis-script-first'))
  assert.equal(built.package.threadContext.summary, null)
  assert.equal(built.package.threadContext.messages.length, 0)
  assert.deepEqual(built.package.analysisBootstrap, { mode: 'historical', source: 'analysis_state' })
  assert.match(built.package.analysisWorkingState?.projection ?? '', /Schema v1 · proposed/)
  const serialized = serializeContextPackage(built.package)
  assert.match(serialized, /Mainline-Driven Requirement Analysis/)
  assert.match(serialized, /Analysis Mainline \(canonical current state\)/)
  assert.doesNotMatch(serialized, /Recent Thread History/)
  assert.match(serialized, /analysis_turn_submit/)
  assert.match(serialized, /默认 Conversation History 为 0/)
  assert.equal(serialized.includes('Existing Requirement Analysis candidate'), false)
})

test('历史需求缺少 Mainline 时按需 Bootstrap，proposed 后保持幂等', async (t) => {
  const value = await fixture()
  t.after(() => { value.persistence.close(); return fs.rm(value.directory, { recursive: true, force: true }) })
  const first = await value.manager.build({
    workspaceId: value.workspaceId, requirementId: 'device-connect', threadId: value.threadId,
    task: '继续需求分析', skill: analysisSkill
  })
  assert.deepEqual(first.package.analysisBootstrap, { mode: 'historical', source: 'downstream_artifact' })
  assert.ok(first.package.artifacts.some((item) => item.type === 'PRD'))
  assert.equal(first.package.threadContext.messages.length, 0)

  const proposed = value.persistence.getAnalysisState('device-connect', value.threadId)
  assert.ok(proposed)
  proposed.mainlineSchema.status = 'proposed'
  value.persistence.saveAnalysisState(proposed, null, 'bootstrap-proposed')
  const second = await value.manager.build({
    workspaceId: value.workspaceId, requirementId: 'device-connect', threadId: value.threadId,
    task: '继续需求分析', skill: analysisSkill
  })
  assert.equal(second.package.analysisBootstrap, undefined)
  assert.equal(second.package.threadContext.messages.length, 0)
})

test('历史 Requirement 已有 Analysis Stage Slot 时优先于 Artifact Bootstrap', async (t) => {
  const value = await fixture()
  t.after(() => { value.persistence.close(); return fs.rm(value.directory, { recursive: true, force: true }) })
  const stage = createStageState(value.workspaceId, 'device-connect', 'requirement-analysis')
  ;(stage.slots as { problem: string[] }).problem = ['当前有效问题来自结构化 Stage Slot']
  value.persistence.saveLifecycleStageState(stage, null, 'legacy-stage-state')
  const built = await value.manager.build({
    workspaceId: value.workspaceId, requirementId: 'device-connect', threadId: value.threadId,
    task: '继续需求分析', skill: analysisSkill
  })
  assert.deepEqual(built.package.analysisBootstrap, { mode: 'historical', source: 'stage_state' })
})

test('新需求只有分析前用户补充时进入 Mainline Definition，不误判历史 Bootstrap', async (t) => {
  const value = await fixture()
  t.after(() => { value.persistence.close(); return fs.rm(value.directory, { recursive: true, force: true }) })
  await fs.rm(join(value.requirementRoot, 'prd'), { recursive: true })
  await fs.rm(join(value.requirementRoot, 'flows'), { recursive: true })
  await fs.rm(join(value.requirementRoot, 'solution'), { recursive: true })
  await value.workspace.refreshRequirement('device-connect')
  value.persistence.appendUserMessage(value.workspaceId, 'device-connect', value.threadId, '我们需要增加一种第三方设备呼叫方式。')
  const built = await value.manager.build({
    workspaceId: value.workspaceId, requirementId: 'device-connect', threadId: value.threadId,
    task: '开始分析当前需求', skill: analysisSkill
  })
  assert.deepEqual(built.package.analysisBootstrap, { mode: 'definition', source: 'none' })
  assert.match(built.package.analysisInitialInput ?? '', /第三方设备呼叫方式/)
})

test('只有 Conversation 的历史需求仅在 Bootstrap 时一次性读取，确认后 History 为 0', async (t) => {
  const value = await fixture()
  t.after(() => { value.persistence.close(); return fs.rm(value.directory, { recursive: true, force: true }) })
  await fs.rm(join(value.requirementRoot, 'prd'), { recursive: true })
  await fs.rm(join(value.requirementRoot, 'flows'), { recursive: true })
  await fs.rm(join(value.requirementRoot, 'solution'), { recursive: true })
  await value.workspace.refreshRequirement('device-connect')
  value.persistence.appendUserMessage(value.workspaceId, 'device-connect', value.threadId, '最终规则是每天最多 3 轮。')
  const historicalRun = value.persistence.startRun(value.workspaceId, 'device-connect', value.threadId, '历史分析', value.persistence.getActiveModelConfig())
  value.persistence.completeRun(historicalRun.run.id, '已记录历史规则。')
  const bootstrap = await value.manager.build({
    workspaceId: value.workspaceId, requirementId: 'device-connect', threadId: value.threadId,
    task: '继续分析', skill: analysisSkill
  })
  assert.deepEqual(bootstrap.package.analysisBootstrap, { mode: 'historical', source: 'conversation' })
  assert.match(bootstrap.package.analysisInitialInput ?? '', /每天最多 3 轮/)
  assert.equal(bootstrap.package.threadContext.messages.length, 0)

  const confirmed = value.persistence.getAnalysisState('device-connect', value.threadId)
  assert.ok(confirmed)
  confirmed.mainlineSchema.status = 'confirmed'
  value.persistence.saveAnalysisState(confirmed, null, 'bootstrap-confirmed')
  const normal = await value.manager.build({
    workspaceId: value.workspaceId, requirementId: 'device-connect', threadId: value.threadId,
    task: '下一步', skill: analysisSkill
  })
  assert.equal(normal.package.analysisInitialInput, undefined)
  assert.equal(normal.package.threadContext.messages.length, 0)
  assert.doesNotMatch(serializeContextPackage(normal.package), /每天最多 3 轮/)
})

test('Mainline Context 相比 Stage Slot + History 输入不随 20 Turn 增长', async (t) => {
  const value = await fixture()
  t.after(() => { value.persistence.close(); return fs.rm(value.directory, { recursive: true, force: true }) })
  for (let index = 0; index < 20; index += 1) {
    value.persistence.appendUserMessage(value.workspaceId, 'device-connect', value.threadId, `第 ${index + 1} 轮补充：${'历史需求事实'.repeat(20)}`)
  }
  await value.manager.build({ workspaceId: value.workspaceId, requirementId: 'device-connect', threadId: value.threadId, task: '开始分析', skill: analysisSkill })
  const state = value.persistence.getAnalysisState('device-connect', value.threadId)
  assert.ok(state)
  state.mainlineSchema.status = 'confirmed'
  state.problem.currentProblem.value = '历史事实已进入当前 Mainline'
  state.problem.currentProblem.status = 'confirmed'
  value.persistence.saveAnalysisState(state, null, 'token-comparison')
  const built = await value.manager.build({ workspaceId: value.workspaceId, requirementId: 'device-connect', threadId: value.threadId, task: '继续分析当前问题', skill: analysisSkill })
  const after = estimateTokens(serializeContextPackage(built.package))
  const legacy = structuredClone(built.package)
  legacy.threadContext = new MemoryManager(value.persistence).buildThreadMemory(value.threadId)
  legacy.stageWorkingState = {
    stageId: 'requirement-analysis', version: state.version, status: 'in_progress',
    projection: built.package.analysisWorkingState?.projection ?? '', readiness: { status: 'NOT_READY', checks: {}, blockingQuestions: 0, blockingConflicts: 0, readyForConfirmation: false },
    fullStateChars: JSON.stringify(state).length
  }
  const before = estimateTokens(serializeContextPackage(legacy))
  const history = estimateTokens(`${legacy.threadContext.summary ?? ''}\n${JSON.stringify(legacy.threadContext.messages.map(({ role, content }) => ({ role, content })))}`)
  const stageSlot = estimateTokens(legacy.stageWorkingState?.projection ?? '')
  assert.equal(built.package.threadContext.messages.length, 0)
  assert.ok(before > after)
  console.log(`TOKEN_COMPARISON before=${before} before_history=${history} before_stage_slot=${stageSlot} after=${after} after_history=0 mainline=${estimateTokens(built.package.analysisWorkingState?.projection ?? '')} working=${estimateTokens(built.package.analysisWorkingContext?.projection ?? '')}`)
})

test('Business Flow 使用 L1/L2 最小上下文并优先提供确认 Analysis 与 Flow Policy', async (t) => {
  const value = await fixture()
  t.after(() => { value.persistence.close(); return fs.rm(value.directory, { recursive: true, force: true }) })
  await fs.mkdir(join(value.requirementRoot, 'analysis'), { recursive: true })
  await fs.writeFile(join(value.requirementRoot, 'analysis', 'requirement-analysis.md'), '# Requirement Analysis\n\n- Analysis Status：confirmed\n')
  await value.workspace.refreshRequirement('device-connect')
  const built = await value.manager.build({
    workspaceId: value.workspaceId, requirementId: 'device-connect', threadId: value.threadId,
    task: '基于已确认分析生成完整业务流程', skill: flowSkill
  })
  assert.equal(built.package.level, 'L2')
  assert.ok(built.package.artifacts.some((item) => item.path === 'analysis/requirement-analysis.md'))
  assert.ok(built.package.artifacts.some((item) => item.type === 'Business Flow'))
  assert.ok(built.package.runtimePolicies.some((item) => item.id === 'business-flow-prerequisite'))
  assert.match(serializeContextPackage(built.package), /business_flow_ready/)
  assert.equal(built.metadata.flowSourceRunId, null)
})

test('Solution Design 默认 L2，只装配 Analysis、Flow、Solution 与双 Gate Policy', async (t) => {
  const value = await fixture()
  t.after(() => { value.persistence.close(); return fs.rm(value.directory, { recursive: true, force: true }) })
  await fs.mkdir(join(value.requirementRoot, 'analysis'), { recursive: true })
  await fs.writeFile(join(value.requirementRoot, 'analysis', 'requirement-analysis.md'), '# Requirement Analysis\n\n- Analysis Status：confirmed\n')
  await value.workspace.refreshRequirement('device-connect')
  const built = await value.manager.build({
    workspaceId: value.workspaceId, requirementId: 'device-connect', threadId: value.threadId,
    task: '基于已经确认的需求分析和业务流程设计产品方案', skill: solutionSkill
  })
  assert.equal(built.package.level, 'L2')
  assert.ok(built.package.artifacts.some((item) => item.type === 'Analysis'))
  assert.ok(built.package.artifacts.some((item) => item.type === 'Business Flow'))
  assert.ok(built.package.artifacts.some((item) => item.type === 'Solution'))
  assert.ok(built.package.runtimePolicies.some((item) => item.id === 'solution-prerequisite'))
  assert.match(serializeContextPackage(built.package), /solution_coverage_check/)
  assert.match(serializeContextPackage(built.package), /不得进入交互、原型或 PRD/)
})

test('Interaction Design 默认 L2，装配三个上游、Existing UI 元数据与确认 Policy', async (t) => {
  const value = await fixture()
  t.after(() => { value.persistence.close(); return fs.rm(value.directory, { recursive: true, force: true }) })
  await fs.mkdir(join(value.requirementRoot, 'analysis'), { recursive: true })
  await fs.mkdir(join(value.requirementRoot, 'prototype'), { recursive: true })
  await fs.writeFile(join(value.requirementRoot, 'analysis', 'requirement-analysis.md'), '# Requirement Analysis\n\n- Analysis Status：confirmed\n')
  await fs.writeFile(join(value.requirementRoot, 'prototype', 'case-detail-v1.html'), '<main>Existing UI</main>')
  await value.workspace.refreshRequirement('device-connect')
  const built = await value.manager.build({
    workspaceId: value.workspaceId, requirementId: 'device-connect', threadId: value.threadId,
    task: '基于确认方案设计 DeviceConnect Voice 交互，并复用现有原型', skill: interactionSkill
  })
  assert.equal(built.package.level, 'L2')
  assert.ok(built.package.artifacts.some((item) => item.type === 'Analysis'))
  assert.ok(built.package.artifacts.some((item) => item.type === 'Business Flow'))
  assert.ok(built.package.artifacts.some((item) => item.type === 'Solution'))
  assert.ok(built.package.artifacts.some((item) => item.type === 'Prototype'))
  assert.ok(built.package.runtimePolicies.some((item) => item.id === 'interaction-prerequisite'))
  assert.match(serializeContextPackage(built.package), /interaction_design_ready/)
  assert.match(serializeContextPackage(built.package), /不得生成 HTML、React、图片或 Prototype/)
})

test('Prototype 使用 L1，只装配最新 Interaction、必要 Solution、Existing Prototype 与确认 Policy', async (t) => {
  const value = await fixture()
  t.after(() => { value.persistence.close(); return fs.rm(value.directory, { recursive: true, force: true }) })
  await fs.mkdir(join(value.requirementRoot, 'interaction'), { recursive: true })
  await fs.mkdir(join(value.requirementRoot, 'prototype'), { recursive: true })
  await fs.writeFile(join(value.requirementRoot, 'interaction', 'interaction-design-v1.json'), '{"status":"CONFIRMED"}')
  await fs.writeFile(join(value.requirementRoot, 'prototype', 'case-detail-v3.html'), '<main>Existing UI</main>')
  await value.workspace.refreshRequirement('device-connect')
  const built = await value.manager.build({
    workspaceId: value.workspaceId, requirementId: 'device-connect', threadId: value.threadId,
    task: '基于确认交互和现有页面生成 Prototype Delta', skill: prototypeSkill
  })
  assert.equal(built.package.level, 'L1')
  assert.ok(built.package.artifacts.some((item) => item.type === 'Interaction'))
  assert.ok(built.package.artifacts.some((item) => item.type === 'Prototype'))
  assert.ok(built.package.artifacts.some((item) => item.type === 'Solution'))
  assert.ok(built.package.runtimePolicies.some((item) => item.id === 'prototype-existing-ui-first'))
  assert.match(serializeContextPackage(built.package), /artifact_next_version/)
  assert.match(serializeContextPackage(built.package), /不得生成 PRD/)
})

test('Product Spec 默认 L2，装配确认上游、可选 Prototype、现有 PRD 与专属 Policy', async (t) => {
  const value = await fixture()
  t.after(() => { value.persistence.close(); return fs.rm(value.directory, { recursive: true, force: true }) })
  await fs.mkdir(join(value.requirementRoot, 'analysis'), { recursive: true })
  await fs.mkdir(join(value.requirementRoot, 'interaction'), { recursive: true })
  await fs.mkdir(join(value.requirementRoot, 'prototype'), { recursive: true })
  await fs.writeFile(join(value.requirementRoot, 'analysis', 'requirement-analysis.md'), '# Requirement Analysis\n\n- Analysis Status：confirmed\n')
  await fs.writeFile(join(value.requirementRoot, 'interaction', 'interaction-design-v1.json'), '{"status":"CONFIRMED"}')
  await fs.writeFile(join(value.requirementRoot, 'prototype', 'case-detail-v1.html'), '<main>Confirmed UI</main>')
  await value.workspace.refreshRequirement('device-connect')
  const built = await value.manager.build({ workspaceId: value.workspaceId, requirementId: 'device-connect', threadId: value.threadId, task: '基于已确认设计生成 PRD', skill: productSpecSkill })
  assert.equal(built.package.level, 'L2')
  for (const kind of ['Analysis', 'Business Flow', 'Solution', 'Interaction', 'Prototype', 'PRD']) assert.ok(built.package.artifacts.some((item) => item.type === kind), kind)
  assert.ok(built.package.runtimePolicies.some((item) => item.id === 'product-spec-prerequisite'))
  const prompt = serializeContextPackage(built.package)
  assert.match(prompt, /Mock Data 不是业务事实/); assert.match(prompt, /product_spec_ready/); assert.match(prompt, /不得进入 Review/)
})

test('Requirement Review 使用 L2、只装配一个主 Skill 并要求按当前依赖逐一读取', async (t) => {
  const value = await fixture()
  t.after(() => { value.persistence.close(); return fs.rm(value.directory, { recursive: true, force: true }) })
  const built = await value.manager.build({ workspaceId: value.workspaceId, requirementId: 'device-connect', threadId: value.threadId, task: '评审当前需求是否具备研发条件', skill: requirementReviewSkill })
  assert.equal(built.package.level, 'L2')
  assert.equal(built.package.skill?.id, 'requirement-review')
  assert.ok(built.package.runtimePolicies.some((item) => item.id === 'requirement-review-prerequisite'))
  const prompt = serializeContextPackage(built.package)
  assert.match(prompt, /requirement_review_next_version/)
  assert.match(prompt, /不得自动修复、回退 Stage 或进入开发/)
})

test('UI Baseline 仅在 Prototype 阶段按最小切片注入，不影响其他生命周期阶段', async (t) => {
  const value = await fixture()
  t.after(() => { value.persistence.close(); return fs.rm(value.directory, { recursive: true, force: true }) })
  let resolveCalls = 0
  const resolver = {
    async resolveContext() {
      resolveCalls += 1
      return {
        version: 2,
        name: 'Company UI',
        updatedAt: '2026-09-17T00:00:00.000Z',
        globals: { page: { fontSize: '14px' } },
        pattern: { list_page: { components: ['table', 'button'] } },
        components: { table: { height: 44 }, button: { height: 36 } },
        loadedKeys: ['globals.page', 'patterns.list_page', 'components.table', 'components.button']
      }
    }
  }
  const manager = new ContextManager(value.workspace, value.persistence, new MemoryManager(value.persistence), resolver)
  const prototype = await manager.build({
    workspaceId: value.workspaceId, requirementId: 'device-connect', threadId: value.threadId,
    task: '生成客户列表页 HTML 原型', skill: prototypeSkill
  })
  assert.equal(resolveCalls, 1)
  assert.equal(prototype.package.uiBaseline?.name, 'Company UI')
  assert.deepEqual(prototype.package.uiBaseline?.loadedKeys, ['globals.page', 'patterns.list_page', 'components.table', 'components.button'])
  assert.match(serializeContextPackage(prototype.package), /Resolved UI Baseline/)

  const solution = await manager.build({
    workspaceId: value.workspaceId, requirementId: 'device-connect', threadId: value.threadId,
    task: '继续产品方案设计', skill: solutionSkill
  })
  assert.equal(resolveCalls, 1)
  assert.equal(solution.package.uiBaseline, undefined)
})
