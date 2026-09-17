import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { WebContents } from 'electron'
import type { ModelStreamEvent } from '../src/model'
import type { RuntimeEvent } from './runtime/agentRuntime'
import type { RuntimeService } from './runtime/runtimeService'
import type { ActiveToolRun } from './tools/toolBridge'
import { AgentTaskService } from './agentTaskService'
import { ContextManager } from './runtime/contextManager'
import { createEmptyAnalysisState } from './runtime/analysisStateEngine'
import { MemoryManager } from './runtime/memoryManager'
import { LifecycleEngine } from './runtime/lifecycleEngine'
import { PersistenceService } from './persistenceService'
import { RequirementService } from './requirementService'
import { SkillRegistry } from './skills/skillRegistry'
import { EspowToolService } from './tools/toolService'
import { interactionFixture } from './tools/interactionTestFixture'
import { LocalWorkspaceService } from './workspaceService'

function analysisJson(): string {
  return JSON.stringify({
    analysisStatus: 'ReadyForConfirmation',
    problemDefinition: '坐席无法及时识别有效联系人，也无法及时感知跨案件客户回复。',
    goal: '让坐席在客户可联系窗口内识别联系人并处理回复。',
    actors: [{ name: '催收坐席', role: '负责联系客户并处理回复' }],
    scenarios: [{
      id: 'S001', name: '客户跨案件回复', actor: '催收坐席', trigger: '客户通过 WhatsApp 回复',
      currentFlow: ['坐席停留在其他案件', '客户回复', '坐席切回原案件'], blocker: '没有跨案件消息入口',
      expectedOutcome: '及时发现并处理回复', status: '关键场景'
    }],
    currentFlow: ['案件进入', '查看客户', '选择联系方式', '触达客户', '客户响应', '处理', '记录结果'],
    blockers: [{ description: '客户回复后无法跨案件感知', evidenceType: 'FACT', source: '业务方描述' }],
    rootCauses: [{ description: '可能依赖逐案查看', evidenceType: 'ASSUMPTION', source: null }],
    boundaries: ['覆盖 WhatsApp；RCS 待确认'], facts: ['客户回复容易错过'], assumptions: ['当前依赖逐案查看'],
    decisions: [], openQuestions: ['RCS 是否已有提醒入口？'], outOfScope: [], semanticReady: true
  })
}

function businessFlowJson(revised = false): string {
  return JSON.stringify({
    id: 'device-connect-flow', name: 'DeviceConnect Voice 业务流程',
    scope: { goal: '从案件详情发起 Device call 到结果回流与录音归档', included: ['准入', '通话', '回流', '归档'], excluded: ['完整催收生命周期'] },
    status: 'READY_FOR_CONFIRMATION',
    actors: [
      { id: 'agent', name: '催收坐席', role: '发起通话', source: 'S001' },
      { id: 'app', name: '催收 App', role: '检查并展示结果', source: 'S001' },
      { id: 'pt', name: 'PT 服务', role: '执行通话', source: 'S001' }
    ],
    nodes: [
      { id: 'start', type: 'start', title: '进入案件详情', description: '', actorId: 'agent', stage: '准入', stateChange: null, sourceScenarioIds: ['S001'], sourceDecisionIds: [] },
      { id: 'mic', type: 'decision', title: '麦克风是否授权？', description: '', actorId: 'app', stage: '准入', stateChange: null, sourceScenarioIds: ['S001'], sourceDecisionIds: [] },
      { id: 'call', type: 'system', title: '创建并执行通话', description: '', actorId: 'pt', stage: '通话', stateChange: 'PROCESSING', sourceScenarioIds: ['S001'], sourceDecisionIds: [] },
      { id: 'archive', type: 'system', title: '结果回写与录音归档', description: '', actorId: 'app', stage: '回流', stateChange: 'COMPLETED', sourceScenarioIds: ['S001'], sourceDecisionIds: [] },
      { id: 'done', type: 'end', title: '结束', description: '', actorId: 'app', stage: '回流', stateChange: 'COMPLETED', sourceScenarioIds: ['S001'], sourceDecisionIds: [] },
      { id: 'denied', type: 'end', title: '授权拒绝，结束本次发起', description: revised ? '不生成 orderNo，也不调用 PT' : '不调用 PT', actorId: 'app', stage: '准入', stateChange: '不改变已有状态', sourceScenarioIds: ['S001'], sourceDecisionIds: [] }
    ],
    edges: [
      { id: 'e1', from: 'start', to: 'mic', label: '点击 Device call', type: 'main' },
      { id: 'e2', from: 'mic', to: 'call', label: '已授权', type: 'main' },
      { id: 'e3', from: 'mic', to: 'denied', label: '拒绝', type: 'branch' },
      { id: 'e4', from: 'call', to: 'archive', label: '通话结束', type: 'main' },
      { id: 'e5', from: 'archive', to: 'done', label: '归档完成或记录失败状态', type: 'main' }
    ],
    entry: 'start',
    exits: [
      { nodeId: 'done', condition: '结果处理完成', recordBehavior: '保留通话记录', stateImpact: '终态', retryable: '否' },
      { nodeId: 'denied', condition: '麦克风拒绝', recordBehavior: revised ? '不生成 orderNo' : '记录拒绝', stateImpact: '不改变已有状态', retryable: '授权后可重新发起' }
    ],
    openQuestions: [],
    semanticChecks: { mainScenarioCovered: true, blockersHandled: true, keyExitsCovered: true, asyncRecoveryCovered: true, closedLoop: true },
    sourceAnalysisPath: 'analysis/requirement-analysis.md', sourceAnalysisStatus: 'confirmed'
  })
}

function solutionDesignJson(revised = false): string {
  const capability = (id: string, name: string, node: string, execution: 'manual' | 'automatic', layer: 'user-facing' | 'system' | 'supporting' = 'system') => ({
    id, name, layer, purpose: `承载 ${name}`, actor: execution === 'manual' ? '催收坐席' : '催收系统', trigger: `进入 ${node}`,
    execution, input: ['case', 'agent'], behavior: [`执行 ${name}`], output: [`${name} result`], relatedFlowNodeIds: [node],
    sourceScenarioIds: ['S001'], sourceDecisionIds: [], rules: [], exceptions: [], surfaces: execution === 'manual' ? ['案件详情'] : ['后台服务']
  })
  return JSON.stringify({
    id: 'device-connect-solution', name: 'DeviceConnect Voice 产品方案', overview: '让坐席完成人工单呼并获得可靠的结果与记录。',
    scope: { included: ['人工单呼', '结果记录'], excluded: ['AI 自动外呼', '批量任务'] }, status: 'READY_FOR_CONFIRMATION',
    capabilities: [
      capability('CAP-01', 'Device call 准入', 'start', 'manual', 'user-facing'),
      capability('CAP-02', '麦克风与设备校验', 'mic', 'manual', 'supporting'),
      capability('CAP-03', '通话创建与承载', 'call', 'automatic'),
      capability('CAP-04', '结果回写与录音归档', 'archive', 'automatic'),
      capability('CAP-05', 'Record 展示与 Add Record 催记渠道', 'done', 'automatic', 'user-facing'),
      { ...capability('CAP-06', '准入失败提示', 'denied', 'manual', 'user-facing'), output: revised ? ['提示且不生成 orderNo'] : ['失败提示'] }
    ],
    rules: [{ id: 'R-01', description: '麦克风拒绝不生成 orderNo', capabilityIds: ['CAP-02', 'CAP-06'], sourceFlowNodeIds: ['mic', 'denied'] }],
    states: [{ id: 'DONE', name: '已完成', meaning: '结果已记录', entryConditions: ['结果回写'], exitConditions: [] }],
    dataObjects: [{ id: 'CALL', name: '通话记录', purpose: '保存通话结果', keyFields: ['orderNo', 'call result', 'recording status'], producedByCapabilityIds: ['CAP-03'], consumedByCapabilityIds: ['CAP-04', 'CAP-05'] }],
    recoveries: [], productSurfaces: [{ id: 'CASE', name: '案件详情', type: 'Web', purpose: '发起并查看结果', capabilityIds: ['CAP-01', 'CAP-05', 'CAP-06'] }],
    decisions: [], openQuestions: [], flowConflicts: [],
    semanticChecks: { goalCovered: true, scenariosCovered: true, flowNodesCovered: true, blockersResolved: true, exceptionsHandled: true, exitsCovered: true, recoveryCovered: true, noOverdesign: true },
    sourceAnalysisPath: 'analysis/requirement-analysis.md', sourceAnalysisStatus: 'confirmed',
    sourceFlowPath: 'flows/business-flow-v1.json', sourceFlowStatus: 'confirmed', confirmedAt: null
  })
}

function terminalEvent(register: (resolve: (event: ModelStreamEvent) => void) => void): Promise<ModelStreamEvent> {
  return new Promise((resolve) => register((event) => {
    if (['completed', 'approval_required', 'error'].includes(event.type)) resolve(event)
  }))
}

test('明确槽位更新不要求模型配置且不会进入 Runtime', async (t) => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'espow-explicit-slot-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const workspaceRoot = join(directory, 'workspace')
  await fs.mkdir(workspaceRoot)
  const workspace = new LocalWorkspaceService()
  const initial = await workspace.scan(workspaceRoot)
  const persistence = new PersistenceService(join(directory, 'app.sqlite'))
  t.after(() => persistence.close())
  persistence.saveWorkspace({ id: initial.id, path: initial.rootPath, name: initial.name })
  const created = await new RequirementService(workspace, persistence).create({ name: '明确槽位零 Token' })
  let runtimeCalls = 0
  const runtime = { async run() { runtimeCalls += 1; throw new Error('不应调用 Runtime') }, async cancel() { return true }, async shutdown() {} } as unknown as RuntimeService
  const tools = new EspowToolService(workspace, persistence)
  const service = new AgentTaskService(
    persistence, workspace, runtime, tools, new SkillRegistry(join(process.cwd(), 'skills')),
    new ContextManager(workspace, persistence, new MemoryManager(persistence)), new LifecycleEngine()
  )
  let resolveEvent: ((event: ModelStreamEvent) => void) | null = null
  const sender = { isDestroyed: () => false, send: (_channel: string, event: ModelStreamEvent) => {
    if (event.type === 'completed' || event.type === 'error') resolveEvent?.(event)
  } } as unknown as WebContents
  const terminal = terminalEvent((resolve) => { resolveEvent = resolve })
  const started = await service.startChat(sender, {
    workspaceId: created.workspace.id, requirementId: created.requirement.id, threadId: created.thread.id,
    content: '需求目标：\n1. 降低处理耗时\n2. 统一账号规则'
  })
  assert.equal((await terminal).type, 'completed')
  assert.equal(runtimeCalls, 0)
  assert.equal(persistence.getRun(started.run.id).provider, null)
  assert.deepEqual(persistence.getAnalysisState(created.requirement.id, created.thread.id)?.goals.businessGoals, ['降低处理耗时', '统一账号规则'])
  assert.equal(persistence.getTokenUsageSummary(created.workspace.id).callCount, 0)
  const gate = persistence.listRunEvents(started.run.id).find((event) => event.eventType === 'model_gate_evaluated')
  assert.equal((gate?.payload as { allow?: boolean })?.allow, false)

  const secondTerminal = terminalEvent((resolve) => { resolveEvent = resolve })
  const second = await service.startChat(sender, {
    workspaceId: created.workspace.id, requirementId: created.requirement.id, threadId: created.thread.id,
    content: '账号关闭完成并写入审计记录',
    slotTarget: { stageId: 'business-flow', slotId: 'exits' }
  })
  assert.equal((await secondTerminal).type, 'completed')
  assert.deepEqual((persistence.getLifecycleStageState(created.requirement.id, 'business-flow')?.slots as { exits?: string[] }).exits, ['账号关闭完成并写入审计记录'])
  assert.equal(persistence.getLifecycleStageState(created.requirement.id, 'solution-design')?.status, 'stale')
  assert.equal(persistence.getRun(second.run.id).provider, null)
  assert.equal(runtimeCalls, 0)
})

test('模型配置缺失时不创建首次 Run，也不影响 Requirement 与默认 Thread', async (t) => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'espow-first-run-failure-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const workspaceRoot = join(directory, 'workspace')
  await fs.mkdir(workspaceRoot)
  const workspace = new LocalWorkspaceService()
  const initial = await workspace.scan(workspaceRoot)
  const persistence = new PersistenceService(join(directory, 'app.sqlite'))
  t.after(() => persistence.close())
  persistence.saveWorkspace({ id: initial.id, path: initial.rootPath, name: initial.name })
  const created = await new RequirementService(workspace, persistence)
    .create({ name: '首次分析失败保护', initialRequest: '需要优化人工登记流程。' })
  const service = new AgentTaskService(
    persistence, workspace, {} as RuntimeService, new EspowToolService(workspace),
    new SkillRegistry(join(process.cwd(), 'skills')), new ContextManager(workspace, persistence, new MemoryManager(persistence)), new LifecycleEngine()
  )

  await assert.rejects(service.startChat({} as WebContents, {
    workspaceId: created.workspace.id, requirementId: created.requirement.id, threadId: created.thread.id,
    content: '开始分析当前需求'
  }), /尚未配置 API Key/)
  assert.equal(persistence.listRuns(created.workspace.id).length, 0)
  assert.equal(persistence.listMessages(created.thread.id).length, 0)
  assert.equal(persistence.listThreads(created.workspace.id, created.requirement.id)[0]?.id, created.thread.id)
  assert.ok((await workspace.refreshCurrent()).requirements.some((item) => item.id === created.requirement.id))
})

test('Requirement Analysis 从真实 Workspace 分析到用户确认后写入正式 Artifact', async (t) => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'espow-analysis-e2e-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const requirementRoot = join(directory, 'workspace', 'requirements', '催收联系人与消息')
  await fs.mkdir(join(requirementRoot, 'source'), { recursive: true })
  await fs.writeFile(join(requirementRoot, 'state.yaml'), 'requirement_id: collection-contact-message\nname: 催收联系人与消息\nstatus: ACTIVE\nlifecycle_stage: analysis\n')
  await fs.writeFile(join(requirementRoot, 'overview.md'), '# Overview\n\n优化联系人判断效率和客户消息感知。')
  await fs.writeFile(join(requirementRoot, 'source', 'business-note.md'), '# 业务方描述\n\n坐席判断联系人效率低，WhatsApp/RCS 回复容易错过。')

  const workspace = new LocalWorkspaceService()
  const snapshot = await workspace.scan(join(directory, 'workspace'))
  const persistence = new PersistenceService(join(directory, 'app.sqlite'))
  t.after(() => persistence.close())
  persistence.saveWorkspace({ id: snapshot.id, path: snapshot.rootPath, name: snapshot.name })
  persistence.saveModelConfig({ provider: 'openai', apiKey: 'test-only', model: 'test', baseUrl: 'https://example.com/v1' })
  const thread = persistence.createThread(snapshot.id, 'collection-contact-message', '需求分析验收')
  const mainline = createEmptyAnalysisState(snapshot.id, 'collection-contact-message', thread.id)
  mainline.mainlineSchema = { version: 1, status: 'confirmed', requirementTypes: ['page_interaction'], modules: [...mainline.mainlineSchema.modules, 'page', 'interaction'] }
  persistence.saveAnalysisState(mainline, null, 'test-mainline-confirmed')
  const tools = new EspowToolService(workspace, persistence)
  let runtimeCalls = 0
  const fakeRuntime = {
    async run(_cwd: string, _config: unknown, identity: { runId: string; threadId: string; turnId: string }, _input: string, toolRun: ActiveToolRun): Promise<AsyncIterable<RuntimeEvent>> {
      runtimeCalls += 1
      const task = toolRun.contextPackage?.task ?? ''
      const patches: Array<Record<string, unknown>> = [
        { op: 'replace', path: '/problem/currentProblem', value: '坐席无法及时识别有效联系人，也无法及时感知跨案件客户回复。', status: 'confirmed', source: 'user' },
        { op: 'add', path: '/goals/businessGoals/-', value: '让坐席在客户可联系窗口内识别联系人并处理回复。', source: 'user' },
        { op: 'replace', path: '/flow/mainFlow', value: ['案件进入', '查看客户', '选择联系方式', '触达客户', '客户响应', '处理', '记录结果'], source: 'user' },
        { op: 'add', path: '/scope/inScope/-', value: '催收 App 联系人与消息感知', source: 'user' },
        { op: 'add', path: '/rules/-', value: { subject: '消息感知', condition: '客户通过支持渠道回复', action: '让坐席及时感知并处理', status: 'confirmed' }, status: 'confirmed', source: 'user' }
      ]
      if (/RCS/.test(task)) {
        patches.push({ op: 'add', path: '/scenarios/-', value: { actor: '催收坐席', trigger: '客户通过 RCS 回复', intent: '客户跨案件回复', currentActions: ['坐席停留在其他案件', '客户回复'], painPoint: '没有跨案件消息入口', expectedOutcome: '及时发现并处理 RCS 回复', status: 'confirmed' }, status: 'confirmed', source: 'user' })
      } else {
        patches.push({ op: 'add', path: '/scenarios/-', value: { actor: '催收坐席', trigger: '客户通过 WhatsApp 回复', intent: '客户跨案件回复', currentActions: ['坐席停留在其他案件', '客户回复'], painPoint: '没有跨案件消息入口', expectedOutcome: '及时发现并处理回复', status: 'confirmed' }, status: 'confirmed', source: 'user' })
      }
      if (/两个独立问题域/.test(task)) {
        patches.push({ op: 'add', path: '/decisions/-', value: { topic: 'problem-domain', decision: '联系人判断和消息感知作为两个独立问题域分析', status: 'confirmed' }, status: 'confirmed', source: 'user' })
      }
      const output = await tools.execute('analysis_turn_submit', {
        requirementId: toolRun.requirementId,
        assistantReply: '需求分析已收敛，请确认。',
        patches, resolvedQuestionIds: [], newQuestions: []
      }, toolRun)
      const now = new Date().toISOString()
      toolRun.onEvent({ call: { id: 'analysis-turn', name: 'analysis_turn_submit', status: 'Completed', startedAt: now, completedAt: now, error: null }, output })
      return (async function* () {
        yield { type: 'message_completed', ...identity, content: String(output.assistantReply ?? '需求分析已收敛，请确认。') } as RuntimeEvent
        yield { type: 'run_completed', ...identity } as RuntimeEvent
      })()
    },
    async cancel() { return true },
    async shutdown() {}
  } as unknown as RuntimeService
  const service = new AgentTaskService(
    persistence, workspace, fakeRuntime, tools, new SkillRegistry(join(process.cwd(), 'skills')),
    new ContextManager(workspace, persistence, new MemoryManager(persistence)), new LifecycleEngine()
  )
  let resolveEvent: ((event: ModelStreamEvent) => void) | null = null
  const sender = { isDestroyed: () => false, send: (_channel: string, event: ModelStreamEvent) => resolveEvent?.(event) } as unknown as WebContents

  const firstTerminal = terminalEvent((resolve) => { resolveEvent = resolve })
  const started = await service.startChat(sender, {
    workspaceId: snapshot.id, requirementId: 'collection-contact-message', threadId: thread.id,
    content: '我想优化催收联系人和客户消息，现在坐席判断联系人效率比较低，而且 WhatsApp/RCS 回复也容易错过。'
  })
  assert.equal((await firstTerminal).type, 'approval_required')
  const waiting = persistence.getRun(started.run.id)
  assert.equal(waiting.skill, 'requirement-analysis')
  assert.equal(waiting.context?.level, 'L1')
  assert.equal(waiting.analysisResult?.analysisStatus, 'ReadyForConfirmation')
  assert.deepEqual(waiting.tools, ['analysis_turn_submit'])
  await assert.rejects(fs.access(join(requirementRoot, 'analysis', 'requirement-analysis.md')))

  const conclusionTerminal = terminalEvent((resolve) => { resolveEvent = resolve })
  const conclusion = await service.startChat(sender, {
    workspaceId: snapshot.id, requirementId: 'collection-contact-message', threadId: thread.id, content: '结论呢？'
  })
  const conclusionEvent = await conclusionTerminal
  assert.equal(conclusionEvent.type, 'completed')
  assert.match(conclusionEvent.type === 'completed' ? conclusionEvent.message.content : '', /当前需求分析已完成/)
  assert.equal(runtimeCalls, 1)
  assert.equal(persistence.getRun(conclusion.run.id).provider, null)
  assert.equal(persistence.getRun(started.run.id).status, 'WaitingConfirmation')

  const revisedTerminal = terminalEvent((resolve) => { resolveEvent = resolve })
  const revised = await service.startChat(sender, {
    workspaceId: snapshot.id, requirementId: 'collection-contact-message', threadId: thread.id,
    content: '还有一个场景：客户也可能通过 RCS 回复。'
  })
  assert.equal((await revisedTerminal).type, 'approval_required')
  assert.equal(persistence.getRun(started.run.id).status, 'Cancelled')
  const revisedWaiting = persistence.getRun(revised.run.id)
  assert.equal(revisedWaiting.analysisResult?.analysisStatus, 'ReadyForConfirmation')
  assert.ok((revisedWaiting.context?.sources ?? []).some((source) => source.startsWith('analysis-mainline:')))

  const rejectedTerminal = terminalEvent((resolve) => { resolveEvent = resolve })
  const rejected = await service.startChat(sender, {
    workspaceId: snapshot.id, requirementId: 'collection-contact-message', threadId: thread.id,
    content: '这个分析结论不对：联系人判断和消息感知是两个独立问题域，请重新整理。'
  })
  assert.equal((await rejectedTerminal).type, 'approval_required')
  assert.equal(persistence.getRun(revised.run.id).status, 'Cancelled')
  assert.ok(persistence.getAnalysisState('collection-contact-message', thread.id))

  const confirmedTerminal = terminalEvent((resolve) => { resolveEvent = resolve })
  await service.startChat(sender, {
    workspaceId: snapshot.id, requirementId: 'collection-contact-message', threadId: thread.id, content: '确认'
  })
  assert.equal((await confirmedTerminal).type, 'completed')
  const confirmed = persistence.getRun(rejected.run.id)
  assert.equal(confirmed.status, 'Completed')
  assert.equal(confirmed.analysisResult?.analysisStatus, 'Confirmed')
  assert.equal(persistence.getAnalysisState('collection-contact-message', thread.id)?.readiness.status, 'COMPLETED')
  assert.equal(persistence.getLifecycleStageState('collection-contact-message', 'requirement-analysis')?.status, 'confirmed')
  assert.deepEqual(confirmed.tools.slice(-2), ['requirement_analysis_write', 'workspace_validate'])
  const artifact = await fs.readFile(join(requirementRoot, 'analysis', 'requirement-analysis.md'), 'utf8')
  assert.match(artifact, /Analysis Status：confirmed/)
  assert.match(artifact, /客户跨案件回复/)
})

test('Business Flow 从确认 Analysis 经预览、用户修改到确认后写入 v1 Model 与 HTML', async (t) => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'espow-flow-e2e-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const requirementRoot = join(directory, 'workspace', 'requirements', 'DeviceConnect Voice')
  await fs.mkdir(join(requirementRoot, 'analysis'), { recursive: true })
  await fs.writeFile(join(requirementRoot, 'state.yaml'), 'requirement_id: device-connect\nname: DeviceConnect Voice\nstatus: ACTIVE\nlifecycle_stage: flow\n')
  await fs.writeFile(join(requirementRoot, 'overview.md'), '# DeviceConnect Voice\n')
  await fs.writeFile(join(requirementRoot, 'analysis', 'requirement-analysis.md'), '# Requirement Analysis\n\n- Analysis Status：confirmed\n\n## Actors\n\n催收坐席、催收 App、PT 服务。\n\n## Scenario Map\n\nS001 Device call。\n')
  const workspace = new LocalWorkspaceService()
  const snapshot = await workspace.scan(join(directory, 'workspace'))
  const persistence = new PersistenceService(join(directory, 'app.sqlite'))
  t.after(() => persistence.close())
  persistence.saveWorkspace({ id: snapshot.id, path: snapshot.rootPath, name: snapshot.name })
  persistence.saveModelConfig({ provider: 'openai', apiKey: 'test-only', model: 'test', baseUrl: 'https://example.com/v1' })
  const thread = persistence.createThread(snapshot.id, 'device-connect', '业务流程验收')
  const tools = new EspowToolService(workspace)
  let revision = false
  const fakeRuntime = {
    async run(_cwd: string, _config: unknown, identity: { runId: string; threadId: string; turnId: string }, _input: string, toolRun: ActiveToolRun): Promise<AsyncIterable<RuntimeEvent>> {
      revision = revision || /不(?:要)?生成 orderNo/.test(toolRun.contextPackage?.task ?? '')
      const artifact = workspace.getArtifactByPath('device-connect', 'analysis/requirement-analysis.md')!
      const now = new Date().toISOString()
      const invoke = async (id: string, name: Parameters<typeof tools.execute>[0], args: Record<string, unknown>) => {
        const output = await tools.execute(name, args, toolRun)
        toolRun.onEvent({ call: { id, name, status: 'Completed', startedAt: now, completedAt: now, error: null }, output })
        return output
      }
      await invoke('read-analysis', 'artifact_read', { requirementId: 'device-connect', artifactId: artifact.id })
      const version = await invoke('flow-version', 'business_flow_next_version', { requirementId: 'device-connect' })
      const candidate = JSON.parse(businessFlowJson(revision)) as Record<string, unknown>
      if (/需要澄清/.test(toolRun.contextPackage?.task ?? '')) {
        candidate.status = 'WAITING_CLARIFICATION'
        candidate.openQuestions = ['Query 达到补偿上限后的业务状态是什么？']
        candidate.semanticChecks = { ...(candidate.semanticChecks as Record<string, boolean>), closedLoop: false }
      }
      const resultJson = JSON.stringify(candidate)
      await invoke('flow-ready', 'business_flow_ready', { requirementId: 'device-connect', resultJson })
      await invoke('flow-submit', 'business_flow_submit', { requirementId: 'device-connect', expectedVersion: version.version, resultJson })
      return (async function* () {
        yield { type: 'message_delta', ...identity, delta: '业务流程候选已生成，请预览并确认。' } as RuntimeEvent
        yield { type: 'run_completed', ...identity } as RuntimeEvent
      })()
    },
    async cancel() { return true },
    async shutdown() {}
  } as unknown as RuntimeService
  const service = new AgentTaskService(
    persistence, workspace, fakeRuntime, tools, new SkillRegistry(join(process.cwd(), 'skills')),
    new ContextManager(workspace, persistence, new MemoryManager(persistence)), new LifecycleEngine()
  )
  let resolveEvent: ((event: ModelStreamEvent) => void) | null = null
  const sender = { isDestroyed: () => false, send: (_channel: string, event: ModelStreamEvent) => resolveEvent?.(event) } as unknown as WebContents

  const firstTerminal = terminalEvent((resolve) => { resolveEvent = resolve })
  const first = await service.startChat(sender, {
    workspaceId: snapshot.id, requirementId: 'device-connect', threadId: thread.id,
    content: '基于已经确认的需求分析，生成 DeviceConnect Voice 的完整业务流程。'
  })
  assert.equal((await firstTerminal).type, 'approval_required')
  assert.equal(persistence.getRun(first.run.id).flowResult?.flowStatus, 'READY_FOR_CONFIRMATION')
  await assert.rejects(fs.access(join(requirementRoot, 'flows', 'business-flow-v1.html')))

  const revisedTerminal = terminalEvent((resolve) => { resolveEvent = resolve })
  const revised = await service.startChat(sender, {
    workspaceId: snapshot.id, requirementId: 'device-connect', threadId: thread.id,
    content: '麦克风拒绝后不要生成 orderNo，也不要调用 PT。'
  })
  assert.equal((await revisedTerminal).type, 'approval_required')
  assert.equal(persistence.getRun(first.run.id).status, 'Cancelled')
  assert.match(persistence.getRun(revised.run.id).flowResult?.htmlCandidate ?? '', /不生成 orderNo/)

  const confirmedTerminal = terminalEvent((resolve) => { resolveEvent = resolve })
  await service.startChat(sender, {
    workspaceId: snapshot.id, requirementId: 'device-connect', threadId: thread.id, content: '确认业务流程',
    controlEvent: { type: 'CONFIRM_STAGE', stageId: 'business-flow' }
  })
  assert.equal((await confirmedTerminal).type, 'completed')
  const confirmed = persistence.getRun(revised.run.id)
  assert.equal(confirmed.flowResult?.flowStatus, 'CONFIRMED')
  assert.deepEqual(confirmed.changedFiles, ['flows/business-flow-v1.json', 'flows/business-flow-v1.html'])
  assert.equal((JSON.parse(await fs.readFile(join(requirementRoot, 'flows', 'business-flow-v1.json'), 'utf8')) as { status: string }).status, 'CONFIRMED')
  assert.match(await fs.readFile(join(requirementRoot, 'flows', 'business-flow-v1.html'), 'utf8'), /全部展开/)

  const rejectedTerminal = terminalEvent((resolve) => { resolveEvent = resolve })
  const rejectedCandidate = await service.startChat(sender, {
    workspaceId: snapshot.id, requirementId: 'device-connect', threadId: thread.id, content: '重新生成业务流程供我确认。'
  })
  assert.equal((await rejectedTerminal).type, 'approval_required')
  const rejection = await service.startChat(sender, {
    workspaceId: snapshot.id, requirementId: 'device-connect', threadId: thread.id, content: '取消流程'
  })
  assert.equal(rejection.run.id, rejectedCandidate.run.id)
  assert.equal(rejection.run.status, 'Cancelled')
  await assert.rejects(fs.access(join(requirementRoot, 'flows', 'business-flow-v2.html')))

  const gapTerminal = terminalEvent((resolve) => { resolveEvent = resolve })
  const gap = await service.startChat(sender, {
    workspaceId: snapshot.id, requirementId: 'device-connect', threadId: thread.id, content: '业务流程需要澄清 Query 补偿上限后的状态。'
  })
  assert.equal((await gapTerminal).type, 'completed')
  assert.equal(persistence.getRun(gap.run.id).flowResult?.flowStatus, 'WAITING_CLARIFICATION')
  const answeredTerminal = terminalEvent((resolve) => { resolveEvent = resolve })
  const answered = await service.startChat(sender, {
    workspaceId: snapshot.id, requirementId: 'device-connect', threadId: thread.id,
    content: '补充：达到上限后记录失败状态，允许坐席重新发起。'
  })
  assert.equal((await answeredTerminal).type, 'approval_required')
  assert.equal(persistence.getRun(answered.run.id).skill, 'business-flow')
})

test('所有后续阶段在 Analysis 未确认时均被生命周期门禁拒绝且不调用模型', async (t) => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'espow-flow-prerequisite-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const requirementRoot = join(directory, 'workspace', 'requirements', 'No Analysis')
  await fs.mkdir(requirementRoot, { recursive: true })
  await fs.writeFile(join(requirementRoot, 'state.yaml'), 'requirement_id: no-analysis\nname: No Analysis\nstatus: ACTIVE\nlifecycle_stage: analysis\n')
  await fs.writeFile(join(requirementRoot, 'overview.md'), '# No Analysis\n')
  const workspace = new LocalWorkspaceService()
  const snapshot = await workspace.scan(join(directory, 'workspace'))
  const persistence = new PersistenceService(join(directory, 'app.sqlite'))
  t.after(() => persistence.close())
  persistence.saveWorkspace({ id: snapshot.id, path: snapshot.rootPath, name: snapshot.name })
  persistence.saveModelConfig({ provider: 'openai', apiKey: 'test-only', model: 'test', baseUrl: 'https://example.com/v1' })
  const thread = persistence.createThread(snapshot.id, 'no-analysis', '业务流程')
  let runtimeCalled = false
  const fakeRuntime = { async run() { runtimeCalled = true; throw new Error('不应调用') }, async cancel() { return true }, async shutdown() {} } as unknown as RuntimeService
  const service = new AgentTaskService(persistence, workspace, fakeRuntime, new EspowToolService(workspace), new SkillRegistry(join(process.cwd(), 'skills')), new ContextManager(workspace, persistence, new MemoryManager(persistence)), new LifecycleEngine())
  let resolveEvent: ((event: ModelStreamEvent) => void) | null = null
  const sender = { isDestroyed: () => false, send: (_channel: string, event: ModelStreamEvent) => resolveEvent?.(event) } as unknown as WebContents
  const cases = [
    ['生成正式业务流程。', 'business-flow'],
    ['开始方案设计。', 'solution-design'],
    ['开始交互设计。', 'interaction-design'],
    ['生成 HTML 页面原型。', 'prototype'],
    ['生成产品需求文档 PRD。', 'product-spec'],
    ['进行需求评审。', 'requirement-review']
  ] as const
  for (const [content, skill] of cases) {
    const terminal = terminalEvent((resolve) => { resolveEvent = resolve })
    const started = await service.startChat(sender, { workspaceId: snapshot.id, requirementId: 'no-analysis', threadId: thread.id, content })
    assert.equal((await terminal).type, 'completed')
    assert.match(persistence.listMessages(thread.id).at(-1)?.content ?? '', /前置条件未就绪/)
    assert.match(persistence.listMessages(thread.id).at(-1)?.content ?? '', /需求分析/)
    assert.equal(persistence.getRun(started.run.id).skill, skill)
  }
  assert.equal(runtimeCalled, false)
})

test('Solution Design 从确认 Analysis + Flow 经用户修改、拒绝和确认后写入正式 Artifact', async (t) => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'espow-solution-e2e-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const requirementRoot = join(directory, 'workspace', 'requirements', 'DeviceConnect Voice')
  await fs.mkdir(join(requirementRoot, 'analysis'), { recursive: true })
  await fs.mkdir(join(requirementRoot, 'flows'), { recursive: true })
  await fs.writeFile(join(requirementRoot, 'state.yaml'), 'requirement_id: device-connect\nname: DeviceConnect Voice\nstatus: ACTIVE\nlifecycle_stage: solution\n')
  await fs.writeFile(join(requirementRoot, 'overview.md'), '# DeviceConnect Voice\n')
  await fs.writeFile(join(requirementRoot, 'analysis', 'requirement-analysis.md'), '# Requirement Analysis\n\n- Analysis Status：confirmed\n')
  const confirmedFlow = JSON.parse(businessFlowJson(true)) as Record<string, unknown>
  confirmedFlow.status = 'CONFIRMED'
  confirmedFlow.confirmedAt = new Date().toISOString()
  await fs.writeFile(join(requirementRoot, 'flows', 'business-flow-v1.json'), `${JSON.stringify(confirmedFlow, null, 2)}\n`)
  const workspace = new LocalWorkspaceService()
  const snapshot = await workspace.scan(join(directory, 'workspace'))
  const persistence = new PersistenceService(join(directory, 'app.sqlite'))
  t.after(() => persistence.close())
  persistence.saveWorkspace({ id: snapshot.id, path: snapshot.rootPath, name: snapshot.name })
  persistence.saveModelConfig({ provider: 'openai', apiKey: 'test-only', model: 'test', baseUrl: 'https://example.com/v1' })
  const thread = persistence.createThread(snapshot.id, 'device-connect', '方案设计验收')
  const tools = new EspowToolService(workspace)
  const fakeRuntime = {
    async run(_cwd: string, _config: unknown, identity: { runId: string; threadId: string; turnId: string }, _input: string, toolRun: ActiveToolRun): Promise<AsyncIterable<RuntimeEvent>> {
      const now = new Date().toISOString()
      const invoke = async (id: string, name: Parameters<typeof tools.execute>[0], args: Record<string, unknown>) => {
        const output = await tools.execute(name, args, toolRun)
        toolRun.onEvent({ call: { id, name, status: 'Completed', startedAt: now, completedAt: now, error: null }, output })
        return output
      }
      const analysis = workspace.getArtifactByPath('device-connect', 'analysis/requirement-analysis.md')!
      const flow = workspace.getArtifactByPath('device-connect', 'flows/business-flow-v1.json')!
      await invoke('read-analysis', 'artifact_read', { requirementId: 'device-connect', artifactId: analysis.id })
      await invoke('read-flow', 'artifact_read', { requirementId: 'device-connect', artifactId: flow.id })
      const version = await invoke('solution-version', 'solution_design_next_version', { requirementId: 'device-connect' })
      const candidate = JSON.parse(solutionDesignJson(/全部后台自动/.test(toolRun.contextPackage?.task ?? ''))) as Record<string, unknown>
      if (/需要澄清/.test(toolRun.contextPackage?.task ?? '')) {
        candidate.status = 'WAITING_CLARIFICATION'
        candidate.openQuestions = ['补偿达到上限后的业务状态是什么？']
      }
      const resultJson = JSON.stringify(candidate)
      await invoke('coverage', 'solution_coverage_check', { requirementId: 'device-connect', resultJson })
      await invoke('overdesign', 'solution_overdesign_check', { requirementId: 'device-connect', resultJson })
      await invoke('submit', 'solution_design_submit', { requirementId: 'device-connect', expectedVersion: version.version, resultJson })
      return (async function* () {
        yield { type: 'message_delta', ...identity, delta: '方案候选已生成，请确认。' } as RuntimeEvent
        yield { type: 'run_completed', ...identity } as RuntimeEvent
      })()
    },
    async cancel() { return true }, async shutdown() {}
  } as unknown as RuntimeService
  const service = new AgentTaskService(persistence, workspace, fakeRuntime, tools, new SkillRegistry(join(process.cwd(), 'skills')), new ContextManager(workspace, persistence, new MemoryManager(persistence)), new LifecycleEngine())
  let resolveEvent: ((event: ModelStreamEvent) => void) | null = null
  const sender = { isDestroyed: () => false, send: (_channel: string, event: ModelStreamEvent) => resolveEvent?.(event) } as unknown as WebContents

  const firstTerminal = terminalEvent((resolve) => { resolveEvent = resolve })
  const first = await service.startChat(sender, {
    workspaceId: snapshot.id, requirementId: 'device-connect', threadId: thread.id,
    content: '基于已经确认的需求分析和业务流程，设计 DeviceConnect Voice 的产品方案。'
  })
  assert.equal((await firstTerminal).type, 'approval_required')
  assert.equal(persistence.getRun(first.run.id).solutionResult?.solutionStatus, 'READY_FOR_CONFIRMATION')
  assert.equal(persistence.getRun(first.run.id).context?.level, 'L2')

  const revisedTerminal = terminalEvent((resolve) => { resolveEvent = resolve })
  const revised = await service.startChat(sender, {
    workspaceId: snapshot.id, requirementId: 'device-connect', threadId: thread.id,
    content: 'Query 补偿不用人工入口，全部后台自动执行。'
  })
  assert.equal((await revisedTerminal).type, 'approval_required')
  assert.equal(persistence.getRun(first.run.id).status, 'Cancelled')
  assert.equal(persistence.getRun(revised.run.id).skill, 'solution-design')

  const rejected = await service.startChat(sender, {
    workspaceId: snapshot.id, requirementId: 'device-connect', threadId: thread.id, content: '取消方案'
  })
  assert.equal(rejected.run.status, 'Cancelled')
  await assert.rejects(fs.access(join(requirementRoot, 'solution', 'solution-design-v1.json')))

  const gapTerminal = terminalEvent((resolve) => { resolveEvent = resolve })
  const gap = await service.startChat(sender, {
    workspaceId: snapshot.id, requirementId: 'device-connect', threadId: thread.id,
    content: '方案设计需要澄清补偿达到上限后的状态。'
  })
  assert.equal((await gapTerminal).type, 'completed')
  assert.equal(persistence.getRun(gap.run.id).solutionResult?.solutionStatus, 'WAITING_CLARIFICATION')
  const answeredTerminal = terminalEvent((resolve) => { resolveEvent = resolve })
  const answered = await service.startChat(sender, {
    workspaceId: snapshot.id, requirementId: 'device-connect', threadId: thread.id,
    content: '达到上限后记录失败状态，允许坐席重新发起。'
  })
  assert.equal((await answeredTerminal).type, 'approval_required')
  assert.equal(persistence.getRun(answered.run.id).skill, 'solution-design')

  const finalTerminal = terminalEvent((resolve) => { resolveEvent = resolve })
  const finalCandidate = await service.startChat(sender, {
    workspaceId: snapshot.id, requirementId: 'device-connect', threadId: thread.id,
    content: '重新设计 DeviceConnect Voice 产品方案。'
  })
  assert.equal((await finalTerminal).type, 'approval_required')
  const confirmedTerminal = terminalEvent((resolve) => { resolveEvent = resolve })
  await service.startChat(sender, { workspaceId: snapshot.id, requirementId: 'device-connect', threadId: thread.id, content: '确认方案' })
  assert.equal((await confirmedTerminal).type, 'completed')
  const finalRun = persistence.getRun(finalCandidate.run.id)
  assert.equal(finalRun.solutionResult?.solutionStatus, 'CONFIRMED')
  assert.deepEqual(finalRun.changedFiles, ['solution/solution-design-v1.json', 'solution/solution-design-v1.md'])
  assert.equal((JSON.parse(await fs.readFile(join(requirementRoot, 'solution', 'solution-design-v1.json'), 'utf8')) as { status: string }).status, 'CONFIRMED')
})

test('Interaction Design 从三个确认上游经真实 Tool Run 等待确认并写入正式 Artifact', async (t) => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'espow-interaction-e2e-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const requirementRoot = join(directory, 'workspace', 'requirements', 'DeviceConnect Voice')
  await fs.mkdir(join(requirementRoot, 'analysis'), { recursive: true })
  await fs.mkdir(join(requirementRoot, 'flows'), { recursive: true })
  await fs.mkdir(join(requirementRoot, 'solution'), { recursive: true })
  await fs.mkdir(join(requirementRoot, 'prototype'), { recursive: true })
  await fs.writeFile(join(requirementRoot, 'state.yaml'), 'requirement_id: device-connect\nname: DeviceConnect Voice\nstatus: ACTIVE\nlifecycle_stage: interaction\n')
  await fs.writeFile(join(requirementRoot, 'overview.md'), '# DeviceConnect Voice\n')
  await fs.writeFile(join(requirementRoot, 'analysis', 'requirement-analysis.md'), '# Requirement Analysis\n\n- Analysis Status：confirmed\n')
  const flow = {
    id: 'flow', name: 'Device Call', scope: { goal: '完成呼叫', included: ['单呼'], excluded: [] }, status: 'CONFIRMED',
    actors: [{ id: 'agent', name: '坐席', role: '使用者', source: 'S001' }],
    nodes: [{ id: 'start', type: 'start', title: '发起', description: '', actorId: 'agent', stage: '发起', stateChange: null, sourceScenarioIds: ['S001'], sourceDecisionIds: [] }, { id: 'done', type: 'end', title: '完成', description: '', actorId: 'agent', stage: '完成', stateChange: 'DONE', sourceScenarioIds: ['S001'], sourceDecisionIds: [] }],
    edges: [{ id: 'e', from: 'start', to: 'done', label: '完成', type: 'main' }], entry: 'start', exits: [{ nodeId: 'done', condition: '完成', recordBehavior: '记录', stateImpact: 'DONE', retryable: '否' }], openQuestions: [],
    semanticChecks: { mainScenarioCovered: true, blockersHandled: true, keyExitsCovered: true, asyncRecoveryCovered: true, closedLoop: true }, sourceAnalysisPath: 'analysis/requirement-analysis.md', sourceAnalysisStatus: 'confirmed', confirmedAt: new Date().toISOString()
  }
  await fs.writeFile(join(requirementRoot, 'flows', 'business-flow-v1.json'), `${JSON.stringify(flow, null, 2)}\n`)
  const capability = (id: string, name: string, node: string, execution: 'manual' | 'automatic') => ({ id, name, layer: execution === 'manual' ? 'user-facing' : 'system', purpose: name, actor: execution === 'manual' ? '坐席' : '系统', trigger: node, execution, input: ['case'], behavior: [name], output: ['result'], relatedFlowNodeIds: [node], sourceScenarioIds: ['S001'], sourceDecisionIds: [], rules: [], exceptions: [], surfaces: ['案件详情'] })
  const solution = {
    id: 'solution', name: 'Device Call Solution', overview: '提供呼叫和结果能力', scope: { included: ['单呼'], excluded: [] }, status: 'CONFIRMED',
    capabilities: [capability('CAP-01', '发起呼叫', 'start', 'manual'), capability('CAP-02', '结果回写', 'done', 'automatic')], rules: [], states: [], dataObjects: [], recoveries: [],
    productSurfaces: [{ id: 'CASE', name: '案件详情', type: 'App', purpose: '操作', capabilityIds: ['CAP-01', 'CAP-02'] }], decisions: [], openQuestions: [], flowConflicts: [],
    semanticChecks: { goalCovered: true, scenariosCovered: true, flowNodesCovered: true, blockersResolved: true, exceptionsHandled: true, exitsCovered: true, recoveryCovered: true, noOverdesign: true },
    sourceAnalysisPath: 'analysis/requirement-analysis.md', sourceAnalysisStatus: 'confirmed', sourceFlowPath: 'flows/business-flow-v1.json', sourceFlowStatus: 'confirmed', confirmedAt: new Date().toISOString()
  }
  await fs.writeFile(join(requirementRoot, 'solution', 'solution-design-v1.json'), `${JSON.stringify(solution, null, 2)}\n`)
  await fs.writeFile(join(requirementRoot, 'prototype', 'case-detail-v1.html'), '<main>Existing Case Detail</main>')
  const workspace = new LocalWorkspaceService()
  const snapshot = await workspace.scan(join(directory, 'workspace'))
  const persistence = new PersistenceService(join(directory, 'app.sqlite'))
  t.after(() => persistence.close())
  persistence.saveWorkspace({ id: snapshot.id, path: snapshot.rootPath, name: snapshot.name })
  persistence.saveModelConfig({ provider: 'openai', apiKey: 'test-only', model: 'test', baseUrl: 'https://example.com/v1' })
  const thread = persistence.createThread(snapshot.id, 'device-connect', '交互设计验收')
  const tools = new EspowToolService(workspace)
  const fakeRuntime = {
    async run(_cwd: string, _config: unknown, identity: { runId: string; threadId: string; turnId: string }, _input: string, toolRun: ActiveToolRun): Promise<AsyncIterable<RuntimeEvent>> {
      const now = new Date().toISOString()
      const invoke = async (id: string, name: Parameters<typeof tools.execute>[0], args: Record<string, unknown>) => {
        const output = await tools.execute(name, args, toolRun)
        toolRun.onEvent({ call: { id, name, status: 'Completed', startedAt: now, completedAt: now, error: null }, output })
        return output
      }
      for (const path of ['analysis/requirement-analysis.md', 'flows/business-flow-v1.json', 'solution/solution-design-v1.json', 'prototype/case-detail-v1.html']) {
        const artifact = workspace.getArtifactByPath('device-connect', path)!
        await invoke(`read-${path}`, 'artifact_read', { requirementId: 'device-connect', artifactId: artifact.id })
      }
      const version = await invoke('interaction-version', 'interaction_design_next_version', { requirementId: 'device-connect' })
      const resultJson = JSON.stringify(interactionFixture())
      await invoke('interaction-ready', 'interaction_design_ready', { requirementId: 'device-connect', resultJson })
      await invoke('interaction-submit', 'interaction_design_submit', { requirementId: 'device-connect', expectedVersion: version.version, resultJson })
      return (async function* () {
        yield { type: 'message_delta', ...identity, delta: '交互候选已生成，请确认。' } as RuntimeEvent
        yield { type: 'run_completed', ...identity } as RuntimeEvent
      })()
    },
    async cancel() { return true }, async shutdown() {}
  } as unknown as RuntimeService
  const service = new AgentTaskService(persistence, workspace, fakeRuntime, tools, new SkillRegistry(join(process.cwd(), 'skills')), new ContextManager(workspace, persistence, new MemoryManager(persistence)), new LifecycleEngine())
  let resolveEvent: ((event: ModelStreamEvent) => void) | null = null
  const sender = { isDestroyed: () => false, send: (_channel: string, event: ModelStreamEvent) => resolveEvent?.(event) } as unknown as WebContents
  const waiting = terminalEvent((resolve) => { resolveEvent = resolve })
  const started = await service.startChat(sender, { workspaceId: snapshot.id, requirementId: 'device-connect', threadId: thread.id, content: '基于确认方案设计 DeviceConnect Voice 的 App 交互。' })
  const waitingEvent = await waiting
  assert.equal(waitingEvent.type, 'approval_required', waitingEvent.type === 'error' ? waitingEvent.error : undefined)
  const pending = persistence.getRun(started.run.id)
  assert.equal(pending.skill, 'interaction-design')
  assert.equal(pending.interactionResult?.interactionStatus, 'READY_FOR_CONFIRMATION')
  assert.equal(pending.context?.level, 'L2')
  assert.ok(pending.readFiles.includes('prototype/case-detail-v1.html'))
  await assert.rejects(fs.access(join(requirementRoot, 'interaction', 'interaction-design-v1.json')))
  const completed = terminalEvent((resolve) => { resolveEvent = resolve })
  await service.startChat(sender, { workspaceId: snapshot.id, requirementId: 'device-connect', threadId: thread.id, content: '确认交互' })
  assert.equal((await completed).type, 'completed')
  const finalRun = persistence.getRun(started.run.id)
  assert.equal(finalRun.interactionResult?.interactionStatus, 'CONFIRMED')
  assert.deepEqual(finalRun.changedFiles, ['interaction/interaction-design-v1.json', 'interaction/interaction-design-v1.md'])
})

test('Prototype 从确认 Interaction 读取 Existing UI，经局部反馈、预览和确认写入下一版本 HTML', async (t) => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'espow-prototype-e2e-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const requirementRoot = join(directory, 'workspace', 'requirements', 'DeviceConnect Prototype')
  await fs.mkdir(join(requirementRoot, 'analysis'), { recursive: true })
  await fs.mkdir(join(requirementRoot, 'flows'), { recursive: true })
  await fs.mkdir(join(requirementRoot, 'solution'), { recursive: true })
  await fs.mkdir(join(requirementRoot, 'interaction'), { recursive: true })
  await fs.mkdir(join(requirementRoot, 'prototype'), { recursive: true })
  await fs.writeFile(join(requirementRoot, 'state.yaml'), 'requirement_id: device-connect-prototype\nname: DeviceConnect Prototype\nstatus: ACTIVE\nlifecycle_stage: prototype\n')
  await fs.writeFile(join(requirementRoot, 'overview.md'), '# DeviceConnect Prototype\n')
  await fs.writeFile(join(requirementRoot, 'analysis', 'requirement-analysis.md'), '# Requirement Analysis\n\n- Analysis Status：confirmed\n')
  const confirmedFlow = JSON.parse(businessFlowJson()) as Record<string, unknown>
  confirmedFlow.status = 'CONFIRMED'
  confirmedFlow.confirmedAt = new Date().toISOString()
  await fs.writeFile(join(requirementRoot, 'flows', 'business-flow-v1.json'), `${JSON.stringify(confirmedFlow, null, 2)}\n`)
  const confirmedSolution = JSON.parse(solutionDesignJson()) as Record<string, unknown>
  confirmedSolution.status = 'CONFIRMED'
  confirmedSolution.confirmedAt = new Date().toISOString()
  await fs.writeFile(join(requirementRoot, 'solution', 'solution-design-v1.json'), `${JSON.stringify(confirmedSolution, null, 2)}\n`)
  const confirmedInteraction = { ...interactionFixture('CONFIRMED'), uiReferencePaths: ['prototype/case-detail-v1.html'], confirmedAt: new Date().toISOString() }
  await fs.writeFile(join(requirementRoot, 'interaction', 'interaction-design-v1.json'), `${JSON.stringify(confirmedInteraction, null, 2)}\n`)
  await fs.writeFile(join(requirementRoot, 'prototype', 'case-detail-v1.html'), '<!doctype html><html><head><title>V1</title></head><body><main id="app"><section id="contacts">旧联系人列表</section></main></body></html>')
  const workspace = new LocalWorkspaceService()
  const snapshot = await workspace.scan(join(directory, 'workspace'))
  const persistence = new PersistenceService(join(directory, 'app.sqlite'))
  t.after(() => persistence.close())
  persistence.saveWorkspace({ id: snapshot.id, path: snapshot.rootPath, name: snapshot.name })
  persistence.saveModelConfig({ provider: 'openai', apiKey: 'test-only', model: 'test', baseUrl: 'https://example.com/v1' })
  const thread = persistence.createThread(snapshot.id, 'device-connect-prototype', '页面原型验收')
  const tools = new EspowToolService(workspace)
  const candidateHtml = (simplified: boolean) => `<!doctype html><html><head><title>案件详情</title><meta name="espow:prototype-id" content="case-detail"><meta name="espow:prototype-version" content="2"><meta name="espow:source-interaction" content="interaction/interaction-design-v1.json"><meta name="espow:source-capabilities" content="CAP-01,CAP-02"><meta name="espow:source-flows" content="start,done"><style>body{font-family:sans-serif}main{max-width:960px;margin:auto}</style></head><body><main id="app"><section id="contacts"><h1>联系信息</h1><p>${simplified ? '主要联系人 · 可联系' : '主要联系人 · 手机 · 可联系 · 最近验证'}</p><button id="call-button">Device call</button><span id="call-status">默认</span></section></main><script>document.getElementById('call-button').addEventListener('click',()=>{document.getElementById('call-status').textContent='创建中';setTimeout(()=>{document.getElementById('call-status').textContent='通话中'},10)})</script></body></html>`
  const fakeRuntime = {
    async run(_cwd: string, _config: unknown, identity: { runId: string; threadId: string; turnId: string }, _input: string, toolRun: ActiveToolRun): Promise<AsyncIterable<RuntimeEvent>> {
      const simplified = /复杂|简化/.test(toolRun.contextPackage?.task ?? '')
      const now = new Date().toISOString()
      const invoke = async (id: string, name: Parameters<typeof tools.execute>[0], args: Record<string, unknown>) => {
        const output = await tools.execute(name, args, toolRun)
        toolRun.onEvent({ call: { id, name, status: 'Completed', startedAt: now, completedAt: now, error: null }, output })
        return output
      }
      for (const path of ['interaction/interaction-design-v1.json', 'prototype/case-detail-v1.html']) {
        const artifact = workspace.getArtifactByPath('device-connect-prototype', path)!
        await invoke(`read-${path}`, 'artifact_read', { requirementId: 'device-connect-prototype', artifactId: artifact.id })
      }
      const existing = workspace.getArtifactByPath('device-connect-prototype', 'prototype/case-detail-v1.html')!
      const version = await invoke('prototype-version', 'artifact_next_version', { requirementId: 'device-connect-prototype', artifactId: existing.id })
      const metadata = {
        id: 'case-detail', name: '案件详情', version: version.version, productSurface: 'Desktop Web', mode: 'delta', status: 'READY_FOR_CONFIRMATION',
        sourceInteractionPath: 'interaction/interaction-design-v1.json', sourceInteractionStatus: 'confirmed', sourceSolutionPath: null,
        sourceCapabilityIds: ['CAP-01', 'CAP-02'], sourceFlowIds: ['start', 'done'], existingPrototypePath: 'prototype/case-detail-v1.html', uiReferencePaths: [],
        requiredDomIds: ['app', 'contacts', 'call-button', 'call-status'], interactiveDomIds: ['call-button'], addedComponents: [], changedComponents: ['联系人列表'], removedComponents: [],
        interactionChanges: ['Device call 可演示'], stateChanges: ['默认 → 创建中 → 通话中'], openQuestions: [], interactionConflicts: [],
        semanticChecks: { interactionImplemented: true, mainUserPathComplete: true, importantStatesVisible: true, actionsHaveFeedback: true, cognitiveLoadAcceptable: true, noUnconfirmedFeatures: true }, confirmedAt: null
      }
      const input = { requirementId: 'device-connect-prototype', targetPath: version.targetPath, metadataJson: JSON.stringify(metadata), html: candidateHtml(simplified) }
      await invoke('prototype-ready', 'prototype_ready', input)
      await invoke('prototype-submit', 'prototype_submit', input)
      return (async function* () {
        yield { type: 'message_delta', ...identity, delta: simplified ? '联系人区域已局部简化，请预览并确认。' : 'Prototype Candidate 已生成，请预览。' } as RuntimeEvent
        yield { type: 'run_completed', ...identity } as RuntimeEvent
      })()
    },
    async cancel() { return true }, async shutdown() {}
  } as unknown as RuntimeService
  const service = new AgentTaskService(persistence, workspace, fakeRuntime, tools, new SkillRegistry(join(process.cwd(), 'skills')), new ContextManager(workspace, persistence, new MemoryManager(persistence)), new LifecycleEngine())
  let resolveEvent: ((event: ModelStreamEvent) => void) | null = null
  const sender = { isDestroyed: () => false, send: (_channel: string, event: ModelStreamEvent) => resolveEvent?.(event) } as unknown as WebContents

  const firstTerminal = terminalEvent((resolve) => { resolveEvent = resolve })
  const first = await service.startChat(sender, { workspaceId: snapshot.id, requirementId: 'device-connect-prototype', threadId: thread.id, content: '基于确认的交互和现有页面生成 HTML 页面原型。' })
  assert.equal((await firstTerminal).type, 'approval_required')
  assert.equal(persistence.getRun(first.run.id).prototypeResult?.htmlPath, 'prototype/case-detail-v2.html')
  await assert.rejects(fs.access(join(requirementRoot, 'prototype', 'case-detail-v2.html')))

  const deltaTerminal = terminalEvent((resolve) => { resolveEvent = resolve })
  const delta = await service.startChat(sender, { workspaceId: snapshot.id, requirementId: 'device-connect-prototype', threadId: thread.id, content: '联系人区域太复杂了，简化一下。' })
  assert.equal((await deltaTerminal).type, 'approval_required')
  assert.equal(persistence.getRun(first.run.id).status, 'Cancelled')
  const deltaRun = persistence.getRun(delta.run.id)
  assert.equal(deltaRun.skill, 'prototype')
  assert.match(deltaRun.prototypeResult?.htmlCandidate ?? '', /主要联系人 · 可联系/)
  assert.deepEqual(deltaRun.tools, ['artifact_read', 'artifact_next_version', 'prototype_ready', 'prototype_submit'])

  const completed = terminalEvent((resolve) => { resolveEvent = resolve })
  await service.startChat(sender, { workspaceId: snapshot.id, requirementId: 'device-connect-prototype', threadId: thread.id, content: '这个版本 OK' })
  assert.equal((await completed).type, 'completed')
  const confirmed = persistence.getRun(delta.run.id)
  assert.equal(confirmed.prototypeResult?.prototypeStatus, 'CONFIRMED')
  assert.deepEqual(confirmed.changedFiles, ['prototype/case-detail-v2.html'])
  assert.match(await fs.readFile(join(requirementRoot, 'prototype', 'case-detail-v2.html'), 'utf8'), /主要联系人 · 可联系/)
  assert.match(await fs.readFile(join(requirementRoot, 'prototype', 'case-detail-v1.html'), 'utf8'), /旧联系人列表/)
})
