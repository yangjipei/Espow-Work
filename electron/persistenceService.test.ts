import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PersistenceService } from './persistenceService'
import type { WriteApprovalRequest } from '../src/tools'
import type { RequirementAnalysisResult } from '../src/skills'
import { createSharedRequirementState, createStageState } from './runtime/lifecycleStageStateEngine'
import { createEmptyAnalysisState } from './runtime/analysisStateEngine'

async function databaseFixture(): Promise<{ directory: string; path: string }> {
  const directory = await fs.mkdtemp(join(tmpdir(), 'espow-persistence-'))
  return { directory, path: join(directory, 'app.sqlite') }
}

test('Workspace、选择状态、Thread、Message 与 Run 可在重启后恢复', async (t) => {
  const fixture = await databaseFixture()
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }))
  let service = new PersistenceService(fixture.path)
  service.saveWorkspace({ id: 'workspace-1', path: '/tmp/workspace-1', name: 'Workspace 1' })
  service.saveModelConfig({ provider: 'openai', apiKey: 'sk-test-secret', model: 'test-model', baseUrl: 'https://example.com/v1' })
  const thread = service.createThread('workspace-1', 'requirement-1', '录音归档规则调整')
  const started = service.startRun('workspace-1', 'requirement-1', thread.id, '整理录音归档规则', service.getActiveModelConfig())
  assert.equal(started.run.status, 'Running')
  assert.equal(started.run.provider, 'openai')
  assert.equal(started.run.skill, null)
  const completed = service.completeRun(started.run.id, '已整理完成。')
  assert.equal(completed.run.status, 'Completed')
  service.close()

  service = new PersistenceService(fixture.path)
  t.after(() => service.close())
  assert.equal(service.getRecentWorkspace()?.path, '/tmp/workspace-1')
  assert.deepEqual(service.getSelection('workspace-1'), { requirementId: 'requirement-1', threadId: thread.id })
  assert.equal(service.listThreads('workspace-1', 'requirement-1')[0]?.title, '录音归档规则调整')
  assert.deepEqual(service.listMessages(thread.id).map((message) => message.role), ['user', 'assistant'])
  assert.equal(service.listRuns('workspace-1')[0]?.task, '整理录音归档规则')
  const settings = service.getModelSettings()
  assert.equal(settings.configs.openai.apiKeyConfigured, true)
  assert.equal(JSON.stringify(settings).includes('sk-test-secret'), false)
  assert.equal(JSON.stringify(service.listMessages(thread.id)).includes('sk-test-secret'), false)
  assert.equal(JSON.stringify(service.listRuns('workspace-1')).includes('sk-test-secret'), false)
})

test('真实 Token usage 按 Workspace 与实际 Skill 阶段持久化聚合', async (t) => {
  const fixture = await databaseFixture()
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }))
  let service = new PersistenceService(fixture.path)
  service.saveWorkspace({ id: 'workspace-1', path: '/tmp/workspace-1', name: 'Workspace 1' })
  service.saveModelConfig({ provider: 'openai', apiKey: 'secret', model: 'model-a', baseUrl: 'https://example.com/v1' })
  const thread = service.createThread('workspace-1', 'requirement-1', '需求分析')
  const started = service.startRun('workspace-1', 'requirement-1', thread.id, '分析当前需求', service.getActiveModelConfig(), undefined, {
    id: 'requirement-analysis', name: '需求分析', version: '0.1.0', mode: 'analysis'
  })
  service.recordTokenUsage(started.run.id, { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 }, '2026-09-14T12:00:00.000Z', '分析事实与假设', 1, {
    turnId: started.run.turnId ?? undefined, callId: 'call-1', callReason: 'analysis', durationMs: 125,
    estimatedInputTokens: 1180, historyTokens: 220,
    inputBreakdown: [{ source: 'tools', tokens: 600, percentage: 50.8 }, { source: 'history', tokens: 220, percentage: 18.6 }]
  })
  service.recordTokenUsage(started.run.id, { inputTokens: 800, outputTokens: 200, totalTokens: 1000 }, '2026-09-14T12:01:00.000Z', '生成分析结论')
  service.close()

  service = new PersistenceService(fixture.path)
  t.after(() => service.close())
  const summary = service.getTokenUsageSummary('workspace-1')
  assert.deepEqual({ input: summary.inputTokens, output: summary.outputTokens, total: summary.totalTokens, calls: summary.callCount },
    { input: 2000, output: 500, total: 2500, calls: 2 })
  assert.equal(summary.stages[0]?.stage, 'requirement-analysis')
  assert.equal(summary.stages[0]?.percentage, 100)
  assert.equal(summary.stages[0]?.calls[0]?.executionContent, '生成分析结论')
  const traced = summary.stages[0]?.calls.find((call) => call.callId === 'call-1')
  assert.equal(traced?.turnId, started.run.turnId)
  assert.equal(traced?.callReason, 'analysis')
  assert.equal(traced?.historyTokens, 220)
  assert.equal(traced?.inputBreakdown[0]?.source, 'tools')
  assert.equal(service.listTokenUsageWorkspaces()[0]?.id, 'workspace-1')
})

test('Runtime Observability 从 Event Store 聚合 Router、Context、Skill、Follow-up 与 Trace', async (t) => {
  const fixture = await databaseFixture()
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }))
  const service = new PersistenceService(fixture.path)
  t.after(() => service.close())
  service.saveWorkspace({ id: 'workspace-1', path: '/tmp/workspace-1', name: 'Workspace 1' })
  service.saveModelConfig({ provider: 'openai', apiKey: 'secret', model: 'model-a', baseUrl: 'https://example.com/v1' })
  const thread = service.createThread('workspace-1', 'requirement-1', '可观测性')
  const started = service.startRun('workspace-1', 'requirement-1', thread.id, '分析支付失败原因', service.getActiveModelConfig(), undefined, {
    id: 'requirement-analysis', name: '需求分析', version: '0.1.0', mode: 'analysis'
  })
  service.recordRuntimeEvent(started.run.id, 'model_gate_evaluated', {
    executionPath: 'LLM', reason: 'REQUIREMENT_ANALYSIS', action: 'ANALYZE_REQUIREMENT', stage: 'requirement-analysis',
    contextMode: 'slice', contextLevelFinal: 'L1', contextSources: ['analysis-mainline:v2', 'analysis-working-context'],
    skillMode: 'capsule', toolsInjected: ['artifact_read']
  })
  service.recordRuntimeEvent(started.run.id, 'tool_completed', { toolName: 'artifact_read', step: 1 })
  service.recordRuntimeEvent(started.run.id, 'followup_decision', {
    toolName: 'artifact_read', step: 1, followupRequired: true, followupReason: 'NEW_INFORMATION'
  })
  service.recordRuntimeEvent(started.run.id, 'model_usage', {
    step: 1, callReason: 'analysis', actualInputTokens: 400, actualOutputTokens: 80
  })
  service.recordTokenUsage(started.run.id, { inputTokens: 400, outputTokens: 80, totalTokens: 480 }, new Date().toISOString(), '分析', 1, {
    turnId: started.run.turnId ?? undefined, callReason: 'analysis'
  })

  const observability = service.getTokenUsageSummary('workspace-1').observability
  assert.equal(observability.turnCount, 1)
  assert.equal(observability.router.find((item) => item.key === 'LLM')?.count, 1)
  assert.equal(observability.router.find((item) => item.key === 'SCRIPT')?.count, 0)
  assert.equal(observability.contextModes.find((item) => item.key === 'slice')?.count, 1)
  assert.equal(observability.skillModes.find((item) => item.key === 'capsule')?.count, 1)
  assert.equal(observability.followupRate, 100)
  assert.equal(observability.turns[0]?.routerReason, 'REQUIREMENT_ANALYSIS')
  assert.deepEqual(observability.turns[0]?.toolsInjected, ['artifact_read'])
  assert.ok(observability.turns[0]?.trace.some((step) => step.kind === 'followup' && step.label.includes('NEW_INFORMATION')))
})

test('History Growth 比较同一 Thread 的上一有效 LLM Turn 并跳过 Script Turn', async (t) => {
  const fixture = await databaseFixture()
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }))
  const service = new PersistenceService(fixture.path)
  t.after(() => service.close())
  service.saveWorkspace({ id: 'workspace-1', path: '/tmp/workspace-1', name: 'Workspace 1' })
  service.saveModelConfig({ provider: 'openai', apiKey: 'secret', model: 'model-a', baseUrl: 'https://example.com/v1' })
  const thread = service.createThread('workspace-1', 'requirement-1', '需求分析')
  const first = service.startRun('workspace-1', 'requirement-1', thread.id, 'LLM Turn 1', service.getActiveModelConfig())
  service.recordTokenUsage(first.run.id, { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 }, '2026-09-14T12:00:00.000Z', 'Turn 1', 1, {
    turnId: first.run.turnId ?? undefined, historyTokens: 400
  })
  service.completeRun(first.run.id, '完成 1')
  const script = service.startRun('workspace-1', 'requirement-1', thread.id, 'Script Turn', service.getActiveModelConfig())
  service.recordRuntimeEvent(script.run.id, 'script_completed')
  service.completeRun(script.run.id, '完成 Script')
  const second = service.startRun('workspace-1', 'requirement-1', thread.id, 'LLM Turn 2', service.getActiveModelConfig())
  service.recordTokenUsage(second.run.id, { inputTokens: 1100, outputTokens: 100, totalTokens: 1200 }, '2026-09-14T12:02:00.000Z', 'Turn 2', 1, {
    turnId: second.run.turnId ?? undefined, historyTokens: 440
  })

  const calls = service.getTokenUsageSummary('workspace-1').stages[0]?.calls ?? []
  const secondCall = calls.find((call) => call.turnId === second.run.turnId)
  assert.equal(secondCall?.historyGrowth, 1.1)
})

test('彻底删除 Requirement 的运行、Token、Memory、Snapshot 与最新 Stage State，且不影响其他 Requirement', async (t) => {
  const fixture = await databaseFixture()
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }))
  const service = new PersistenceService(fixture.path)
  t.after(() => service.close())
  service.saveWorkspace({ id: 'workspace-1', path: '/tmp/workspace-1', name: 'Workspace 1' })
  service.saveModelConfig({ provider: 'openai', apiKey: 'secret', model: 'model-a', baseUrl: 'https://example.com/v1' })
  const threadA = service.createThread('workspace-1', 'requirement-a', 'A')
  const threadB = service.createThread('workspace-1', 'requirement-b', 'B')
  const runA = service.startRun('workspace-1', 'requirement-a', threadA.id, 'A task', service.getActiveModelConfig())
  const runB = service.startRun('workspace-1', 'requirement-b', threadB.id, 'B task', service.getActiveModelConfig())
  service.recordRuntimeEvent(runA.run.id, 'run_started')
  service.recordTokenUsage(runA.run.id, { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, new Date().toISOString(), 'A usage')
  service.recordTokenUsage(runB.run.id, { inputTokens: 20, outputTokens: 4, totalTokens: 24 }, new Date().toISOString(), 'B usage')
  service.upsertMemory({ scope: 'requirement', workspaceId: 'workspace-1', requirementId: 'requirement-a', category: 'fact', content: 'A memory', source: 'test' })
  service.upsertMemory({ scope: 'thread', workspaceId: 'workspace-1', threadId: threadA.id, category: 'fact', content: 'A thread memory', source: 'test' })
  service.upsertMemory({ scope: 'requirement', workspaceId: 'workspace-1', requirementId: 'requirement-b', category: 'fact', content: 'B memory', source: 'test' })
  service.saveRequirementSnapshot('workspace-1', {
    requirementId: 'requirement-a', name: 'A', currentGoal: 'A', currentStage: 'ANALYSIS', currentStatus: 'ACTIVE',
    mainArtifacts: [], keyDecisionIds: [], openIssueIds: [], recentImportantChanges: [], sourceUpdatedAt: new Date().toISOString(),
    sourceFingerprint: 'a', refreshedAt: new Date().toISOString()
  })
  service.saveSharedRequirementState(createSharedRequirementState({ workspaceId: 'workspace-1', requirementId: 'requirement-a', name: 'A' }))
  service.saveLifecycleStageState(createStageState('workspace-1', 'requirement-a', 'requirement-analysis'), runA.run.id)

  let directoryDeleted = false
  service.deleteRequirementData('workspace-1', 'requirement-a', () => { directoryDeleted = true })

  assert.equal(directoryDeleted, true)
  assert.equal(service.listThreads('workspace-1', 'requirement-a').length, 0)
  assert.equal(service.listRuns('workspace-1').some((run) => run.requirementId === 'requirement-a'), false)
  assert.equal(service.getTokenUsageSummary('workspace-1').totalTokens, 24)
  assert.equal(service.searchMemory({ workspaceId: 'workspace-1', requirementId: 'requirement-a', threadId: threadA.id, query: 'memory' }).length, 0)
  assert.equal(service.getRequirementSnapshot('workspace-1', 'requirement-a'), null)
  assert.equal(service.getSharedRequirementState('requirement-a'), null)
  assert.equal(service.getLifecycleStageState('requirement-a', 'requirement-analysis'), null)
  assert.equal(service.listThreads('workspace-1', 'requirement-b').length, 1)
  assert.equal(service.listRuns('workspace-1').some((run) => run.requirementId === 'requirement-b'), true)
  assert.equal(service.searchMemory({ workspaceId: 'workspace-1', requirementId: 'requirement-b', threadId: threadB.id, query: 'memory' }).length, 1)
})

test('Requirement 目录删除失败时数据库事务回滚', async (t) => {
  const fixture = await databaseFixture()
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }))
  const service = new PersistenceService(fixture.path)
  t.after(() => service.close())
  service.saveWorkspace({ id: 'workspace-1', path: '/tmp/workspace-1', name: 'Workspace 1' })
  const thread = service.createThread('workspace-1', 'requirement-a', 'A')
  assert.throws(() => service.deleteRequirementData('workspace-1', 'requirement-a', () => { throw new Error('模拟目录删除失败') }), /模拟目录删除失败/)
  assert.equal(service.listThreads('workspace-1', 'requirement-a')[0]?.id, thread.id)
})

test('PersistenceService close 可重复调用，关闭后查询会返回明确错误', async (t) => {
  const fixture = await databaseFixture()
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }))
  const service = new PersistenceService(fixture.path)
  service.close()
  service.close()
  assert.throws(() => service.getRecentWorkspace(), /database is closed/)
})

test('不同 Thread 的消息互相隔离，删除 Thread 不删除历史 Run', async (t) => {
  const fixture = await databaseFixture()
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }))
  const service = new PersistenceService(fixture.path)
  t.after(() => service.close())
  service.saveWorkspace({ id: 'workspace-1', path: '/tmp/workspace-1', name: 'Workspace 1' })
  service.saveModelConfig({ provider: 'deepseek', apiKey: 'deepseek-test-secret', model: 'test-model', baseUrl: 'https://example.com' })
  const first = service.createThread('workspace-1', 'requirement-1', 'Thread A')
  const second = service.createThread('workspace-1', 'requirement-1', 'Thread B')
  const run = service.startRun('workspace-1', 'requirement-1', first.id, '只属于 A', service.getActiveModelConfig())
  service.completeRun(run.run.id, '只回复 A')

  assert.equal(service.listMessages(first.id).length, 2)
  assert.equal(service.listMessages(second.id).length, 0)
  service.deleteThread(first.id)
  assert.equal(service.listThreads('workspace-1', 'requirement-1').length, 1)
  assert.equal(service.listRuns('workspace-1').length, 1)
})

test('首次分析前补充需求只保存 Message，不创建 Turn 或 Run', async (t) => {
  const fixture = await databaseFixture()
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }))
  const service = new PersistenceService(fixture.path)
  t.after(() => service.close())
  service.saveWorkspace({ id: 'workspace-1', path: '/tmp/workspace-1', name: 'Workspace 1' })
  const thread = service.createThread('workspace-1', 'requirement-1', '需求分析')

  const message = service.appendUserMessage('workspace-1', 'requirement-1', thread.id, '  补充业务背景  ')

  assert.equal(message.content, '补充业务背景')
  assert.deepEqual(service.listMessages(thread.id).map((item) => item.content), ['补充业务背景'])
  assert.equal(service.listRuns('workspace-1').length, 0)
})

test('编辑已发送消息时从该消息处覆盖后续 Message、Turn 与 Run', async (t) => {
  const fixture = await databaseFixture()
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }))
  const service = new PersistenceService(fixture.path)
  t.after(() => service.close())
  service.saveWorkspace({ id: 'workspace-1', path: '/tmp/workspace-1', name: 'Workspace 1' })
  service.saveModelConfig({ provider: 'openai', apiKey: 'secret', model: 'model-a', baseUrl: 'https://example.com/v1' })
  const thread = service.createThread('workspace-1', 'requirement-1', '编辑消息')
  const first = service.startRun('workspace-1', 'requirement-1', thread.id, '第一条', service.getActiveModelConfig())
  service.completeRun(first.run.id, '第一条回复')
  const second = service.startRun('workspace-1', 'requirement-1', thread.id, '发错的消息', service.getActiveModelConfig())
  service.cancelRun(second.run.id)

  service.truncateThreadFromUserMessage(thread.id, second.message.id)
  const replacement = service.startRun('workspace-1', 'requirement-1', thread.id, '修正后的消息', service.getActiveModelConfig())

  assert.deepEqual(service.listMessages(thread.id).map((message) => message.content), ['第一条', '第一条回复', '修正后的消息'])
  assert.deepEqual(service.listRuns('workspace-1').map((run) => run.id), [replacement.run.id, first.run.id])
})

test('失败、取消与异常退出会写入真实 Run 状态', async (t) => {
  const fixture = await databaseFixture()
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }))
  let service = new PersistenceService(fixture.path)
  service.saveWorkspace({ id: 'workspace-1', path: '/tmp/workspace-1', name: 'Workspace 1' })
  service.saveModelConfig({ provider: 'openai', apiKey: 'secret', model: 'model-a', baseUrl: 'https://example.com/v1' })
  const thread = service.createThread('workspace-1', 'requirement-1', '状态测试')
  const failed = service.startRun('workspace-1', 'requirement-1', thread.id, '失败任务', service.getActiveModelConfig())
  assert.equal(service.failRun(failed.run.id, '网络异常').status, 'Failed')
  const cancelled = service.startRun('workspace-1', 'requirement-1', thread.id, '取消任务', service.getActiveModelConfig())
  assert.equal(service.cancelRun(cancelled.run.id).status, 'Cancelled')
  service.startRun('workspace-1', 'requirement-1', thread.id, '中断任务', service.getActiveModelConfig())
  service.close()

  service = new PersistenceService(fixture.path)
  t.after(() => service.close())
  const interrupted = service.listRuns('workspace-1').find((run) => run.task === '中断任务')
  assert.equal(interrupted?.status, 'Failed')
  assert.match(interrupted?.error ?? '', /应用.*退出/)
})

test('ESPow 为每次用户输入创建独立 Turn / Run，并持久化 Runtime Event 与 Memory', async (t) => {
  const fixture = await databaseFixture()
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }))
  let service = new PersistenceService(fixture.path)
  service.saveWorkspace({ id: 'workspace-1', path: '/tmp/workspace-1', name: 'Workspace 1' })
  service.saveModelConfig({ provider: 'deepseek', apiKey: 'secret', model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com' })
  const thread = service.createThread('workspace-1', 'requirement-1', 'Thread A')
  const started = service.startRun(
    'workspace-1', 'requirement-1', thread.id, 'ESPow Runtime Task', service.getActiveModelConfig(),
    { type: 'espow-runtime', events: [] }
  )
  assert.ok(started.run.turnId)
  assert.equal(started.run.runtimeType, 'espow-runtime')
  service.recordRuntimeEvent(started.run.id, 'run_started', { source: 'test' })
  service.recordRuntimeEvent(started.run.id, 'message_delta', { delta: 'hello' })
  service.recordRuntimeEvent(started.run.id, 'run_completed')
  service.saveThreadMemory(thread.id, 'Earlier thread digest', 4)
  const memory = service.upsertMemory({
    scope: 'requirement', workspaceId: 'workspace-1', requirementId: 'requirement-1',
    category: 'rule', content: '录音归档失败不重试', importance: 4, source: 'test'
  })
  service.completeRun(started.run.id, 'ESPow Reply')
  const turnId = started.run.turnId
  service.close()

  service = new PersistenceService(fixture.path)
  t.after(() => service.close())
  const run = service.listRuns('workspace-1').find((item) => item.id === started.run.id)
  assert.equal(run?.turnId, turnId)
  assert.equal(run?.runtimeType, 'espow-runtime')
  assert.deepEqual(run?.runtimeEvents, ['run_started', 'message_delta', 'run_completed'])
  const events = service.listRunEvents(started.run.id)
  assert.deepEqual(events.map((event) => event.eventType), ['run_started', 'message_delta', 'run_completed'])
  assert.deepEqual(events[0]?.payload, { source: 'test' })
  assert.equal(service.getThreadMemory(thread.id)?.summary, 'Earlier thread digest')
  assert.equal(service.searchMemory({ workspaceId: 'workspace-1', requirementId: 'requirement-1', threadId: thread.id, query: '录音归档' })[0]?.id, memory.id)
})

test('Tool Call 与 WaitingConfirmation Approval 可持久化并显式取消', async (t) => {
  const fixture = await databaseFixture()
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }))
  let service = new PersistenceService(fixture.path)
  service.saveWorkspace({ id: 'workspace-1', path: '/tmp/workspace-1', name: 'Workspace 1' })
  service.saveModelConfig({ provider: 'openai', apiKey: 'secret', model: 'model-a', baseUrl: 'https://example.com/v1' })
  const thread = service.createThread('workspace-1', 'requirement-1', 'Approval')
  const started = service.startRun('workspace-1', 'requirement-1', thread.id, '候选修改', service.getActiveModelConfig())
  const approval: WriteApprovalRequest = {
    id: 'approval-1', runId: started.run.id, requirementId: 'requirement-1', sourceArtifactId: 'artifact-1', sourcePath: 'prd/prd-v1.md',
    candidate: '# V2', writeMode: 'new-version', status: 'Pending', createdAt: new Date().toISOString(), resolvedAt: null,
    diff: { artifactId: 'artifact-1', path: 'prd/prd-v1.md', before: '# V1', after: '# V2', diff: '-V1\n+V2', changedSections: ['Document'], hasChanges: true, approvalId: 'approval-1' }
  }
  service.recordToolCall(started.run.id, {
    id: 'call-1', name: 'artifact_diff', status: 'Completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), error: null
  }, {}, approval)
  service.waitForApproval(started.run.id, '已生成候选修改。')
  service.close()

  service = new PersistenceService(fixture.path)
  t.after(() => service.close())
  const restored = service.getRun(started.run.id)
  assert.equal(restored.status, 'WaitingConfirmation')
  assert.equal(restored.toolCalls[0]?.name, 'artifact_diff')
  assert.equal(restored.approval?.candidate, '# V2')
  const denied = { ...restored.approval!, status: 'Denied' as const, resolvedAt: new Date().toISOString() }
  assert.equal(service.resolveApproval(started.run.id, denied, 'Cancelled').status, 'Cancelled')
})

test('Requirement Change Skill 版本与结构化结果可持久化', async (t) => {
  const fixture = await databaseFixture()
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }))
  let service = new PersistenceService(fixture.path)
  service.saveWorkspace({ id: 'workspace-1', path: '/tmp/workspace-1', name: 'Workspace 1' })
  service.saveModelConfig({ provider: 'openai', apiKey: 'secret', model: 'model-a', baseUrl: 'https://example.com/v1' })
  const thread = service.createThread('workspace-1', 'requirement-1', 'Delta')
  const started = service.startRun('workspace-1', 'requirement-1', thread.id, '这个规则调整一下', service.getActiveModelConfig(), undefined, {
    id: 'requirement-change', name: '需求变更', version: '0.1.0', mode: 'delta'
  })
  service.setChangeResult(started.run.id, {
    status: 'ClarificationRequired', changeSummary: '变化不明确', impactAssessment: '无法判断',
    affectedArtifacts: [], unaffectedArtifacts: [], openQuestions: ['具体改什么？'], decisionsAffected: [], filesRead: [],
    candidateChanges: [], finalChanges: [], validationResult: null
  })
  service.completeRun(started.run.id, 'Clarification Required')
  service.close()

  service = new PersistenceService(fixture.path)
  t.after(() => service.close())
  const restored = service.getRun(started.run.id)
  assert.equal(restored.skill, 'requirement-change')
  assert.equal(restored.skillVersion, '0.1.0')
  assert.equal(restored.changeResult?.status, 'ClarificationRequired')
})

test('Requirement Analysis 必须经过等待确认才可进入 Confirmed', async (t) => {
  const fixture = await databaseFixture()
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }))
  const service = new PersistenceService(fixture.path)
  t.after(() => service.close())
  service.saveWorkspace({ id: 'workspace-1', path: '/tmp/workspace-1', name: 'Workspace 1' })
  service.saveModelConfig({ provider: 'openai', apiKey: 'secret', model: 'model-a', baseUrl: 'https://example.com/v1' })
  const thread = service.createThread('workspace-1', 'requirement-1', '需求分析')
  const started = service.startRun('workspace-1', 'requirement-1', thread.id, '梳理需求', service.getActiveModelConfig(), undefined, {
    id: 'requirement-analysis', name: '需求分析', version: '0.1.0', mode: 'analysis'
  })
  const result: RequirementAnalysisResult = {
    analysisStatus: 'ReadyForConfirmation', problemDefinition: '消息容易错过', goal: '及时处理回复',
    actors: [{ name: '坐席', role: '处理客户回复' }],
    scenarios: [{ id: 'S001', name: '跨案件回复', actor: '坐席', trigger: '客户回复', currentFlow: ['回复', '处理'], blocker: '无全局入口', expectedOutcome: '及时处理', status: '关键' }],
    currentFlow: ['客户回复', '坐席处理'], blockers: [{ description: '无全局入口', evidenceType: 'FACT', source: '用户' }],
    rootCauses: [], boundaries: [], facts: ['回复容易错过'], assumptions: [], decisions: [], openQuestions: [], outOfScope: [],
    readiness: { deterministicPassed: true, semanticReady: true, missing: [] }, artifactPath: 'analysis/requirement-analysis.md',
    artifactCandidate: '# Analysis', artifactBaseHash: null, confirmedAt: null
  }
  service.setAnalysisResult(started.run.id, result)
  const waiting = service.waitForAnalysisConfirmation(started.run.id, '请确认分析结论。').run
  assert.equal(waiting.status, 'WaitingConfirmation')
  assert.equal(waiting.analysisResult?.analysisStatus, 'ReadyForConfirmation')
  assert.equal(service.getPendingAnalysis(thread.id)?.id, started.run.id)

  service.beginAnalysisConfirmation(started.run.id, '确认')
  service.confirmAnalysis(started.run.id)
  const completed = service.completeRun(started.run.id, '已写入正式 Artifact。').run
  assert.equal(completed.status, 'Completed')
  assert.equal(completed.analysisResult?.analysisStatus, 'Confirmed')
  assert.ok(completed.analysisResult?.confirmedAt)
  assert.deepEqual(service.listMessages(thread.id).map((item) => item.role), ['user', 'assistant', 'user', 'assistant'])
})

test('Analysis Mainline 按 Requirement 唯一持久化，Thread 只保留事件归属', async (t) => {
  const fixture = await databaseFixture()
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }))
  const service = new PersistenceService(fixture.path)
  t.after(() => service.close())
  service.saveWorkspace({ id: 'workspace-1', path: '/tmp/workspace-1', name: 'Workspace 1' })
  service.saveModelConfig({ provider: 'openai', apiKey: 'secret', model: 'model-a', baseUrl: 'https://example.com/v1' })
  const threadA = service.createThread('workspace-1', 'requirement-1', '分析 A')
  const threadB = service.createThread('workspace-1', 'requirement-1', '分析 B')
  const state = {
    schemaVersion: 2 as const,
    workspaceId: 'workspace-1', requirementId: 'requirement-1', threadId: threadA.id, version: 3, source: 'new' as const,
    mainlineSchema: { version: 1, status: 'confirmed' as const, requirementTypes: [], modules: ['requirement_summary', 'current_state', 'problem', 'goal', 'actors', 'scope', 'out_of_scope', 'core_scenarios', 'main_flow', 'key_rules', 'exceptions', 'decisions', 'open_issues'] },
    working: { currentTopic: null, currentQuestion: null },
    moduleData: {},
    problem: {
      trigger: { value: '', status: 'unknown' as const, source: 'runtime' as const, updatedAt: new Date().toISOString(), openIssueId: null },
      currentProblem: { value: '客户回复容易错过', status: 'confirmed' as const, source: 'user' as const, updatedAt: new Date().toISOString(), openIssueId: null },
      rootCause: { value: '', status: 'unknown' as const, source: 'runtime' as const, updatedAt: new Date().toISOString(), openIssueId: null },
      businessImpact: { value: '', status: 'unknown' as const, source: 'runtime' as const, updatedAt: new Date().toISOString(), openIssueId: null },
      currentWorkaround: { value: '', status: 'unknown' as const, source: 'runtime' as const, updatedAt: new Date().toISOString(), openIssueId: null }
    },
    scenarios: [], goals: { businessGoals: [], userGoals: [], systemGoals: [], successCriteria: [] },
    flow: { entry: { value: '', status: 'unknown' as const, source: 'runtime' as const, updatedAt: new Date().toISOString(), openIssueId: null }, mainFlow: [], branches: [], exitConditions: [], failureFlows: [] },
    rules: [], scope: { inScope: ['App'], outOfScope: [], future: [], constraints: [] },
    impact: { systems: [], upstream: [], downstream: [], data: [], externalServices: [], historicalRequirements: [] },
    decisions: [], openQuestions: [],
    collectionMeta: { '/scope/inScope': { status: 'confirmed' as const, source: 'user' as const, updatedAt: new Date().toISOString() } },
    readiness: { status: 'NOT_READY' as const, problemClear: true, goalClear: false, scenarioClear: false, mainFlowClear: false, rulesClear: true, scopeClear: true, exceptionsClear: true, dependenciesClear: true, blockingQuestions: 0, readyForConfirmation: false },
    changedPaths: ['/problem/currentProblem'], updatedAt: new Date().toISOString()
  }
  service.saveAnalysisState(state, null, 'analysis-turn', { patches: 1 })
  assert.equal(service.getAnalysisState('requirement-1', threadA.id)?.problem.currentProblem.value, '客户回复容易错过')
  assert.equal(service.getLatestAnalysisState('requirement-1', threadB.id)?.threadId, threadA.id)
  assert.equal(service.listAnalysisStateEvents('requirement-1', threadA.id)[0]?.version, 3)
  const stateB = { ...state, threadId: threadB.id, version: 4, updatedAt: new Date().toISOString() }
  stateB.problem.currentProblem.value = '由 Thread B 更新后的当前问题'
  service.saveAnalysisState(stateB, null, 'analysis-turn')
  assert.equal(service.getAnalysisState('requirement-1', threadA.id)?.problem.currentProblem.value, '由 Thread B 更新后的当前问题')
  service.deleteThread(threadB.id)
  assert.equal(service.getAnalysisState('requirement-1', threadA.id)?.problem.currentProblem.value, '由 Thread B 更新后的当前问题')
})

test('Question Delivery 只投影本轮新增或更新的问题并随消息持久化', async (t) => {
  const fixture = await databaseFixture()
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }))
  let service = new PersistenceService(fixture.path)
  service.saveWorkspace({ id: 'workspace-1', path: '/tmp/workspace-1', name: 'Workspace 1' })
  service.saveModelConfig({ provider: 'openai', apiKey: 'secret', model: 'model-a', baseUrl: 'https://example.com/v1' })
  const thread = service.createThread('workspace-1', 'requirement-1', '问题交付')
  const baseline = createEmptyAnalysisState('workspace-1', 'requirement-1', thread.id)
  service.saveAnalysisState(baseline, null, 'initialized')

  const first = service.startRun('workspace-1', 'requirement-1', thread.id, '分析问题', service.getActiveModelConfig(), undefined, {
    id: 'requirement-analysis', name: '需求分析', version: '0.1.0', mode: 'analysis'
  })
  const withQuestions = structuredClone(baseline)
  withQuestions.version += 1
  withQuestions.openQuestions = [
    { id: 'Q32', topic: 'sync', question: 'Enable 后是否需要反向同步 94？', priority: 'blocking', reason: '同步规则未确认', status: 'open' },
    { id: 'Q39', topic: 'feedback', question: '同步成功或失败后如何反馈？', priority: 'non_blocking', reason: '反馈方式未确认', status: 'open' }
  ]
  service.saveAnalysisState(withQuestions, first.run.id, 'analysis-turn')
  const projected = service.projectAnalysisQuestions(first.run.id)
  assert.deepEqual(projected.map((question) => question.id), ['Q32', 'Q39'])
  service.completeRun(first.run.id, '还有两个问题需要确认。', projected)

  const second = service.startRun('workspace-1', 'requirement-1', thread.id, '继续分析', service.getActiveModelConfig(), undefined, {
    id: 'requirement-analysis', name: '需求分析', version: '0.1.0', mode: 'analysis'
  })
  const unchanged = structuredClone(withQuestions)
  unchanged.version += 1
  service.saveAnalysisState(unchanged, second.run.id, 'analysis-turn')
  assert.deepEqual(service.projectAnalysisQuestions(second.run.id), [])
  service.completeRun(second.run.id, '没有新的待确认问题。')

  const third = service.startRun('workspace-1', 'requirement-1', thread.id, '更新问题', service.getActiveModelConfig(), undefined, {
    id: 'requirement-analysis', name: '需求分析', version: '0.1.0', mode: 'analysis'
  })
  const updated = structuredClone(unchanged)
  updated.version += 1
  updated.openQuestions[0].question = 'Enable 后需要反向同步哪些字段到 94？'
  service.saveAnalysisState(updated, third.run.id, 'analysis-turn')
  assert.deepEqual(service.projectAnalysisQuestions(third.run.id).map((question) => question.id), ['Q32'])
  service.completeRun(third.run.id, 'Q32 已更新。', service.projectAnalysisQuestions(third.run.id))

  const interrupted = service.startRun('workspace-1', 'requirement-1', thread.id, '产生问题但交付中断', service.getActiveModelConfig(), undefined, {
    id: 'requirement-analysis', name: '需求分析', version: '0.1.0', mode: 'analysis'
  })
  const withUndelivered = structuredClone(updated)
  withUndelivered.version += 1
  withUndelivered.openQuestions.push({ id: 'Q40', topic: 'retry', question: '失败后是否允许重试？', priority: 'blocking', reason: '重试规则未确认', status: 'open' })
  service.saveAnalysisState(withUndelivered, interrupted.run.id, 'analysis-turn')
  service.failRun(interrupted.run.id, '模拟消息交付前中断')
  const recovery = service.startRun('workspace-1', 'requirement-1', thread.id, '继续', service.getActiveModelConfig(), undefined, {
    id: 'requirement-analysis', name: '需求分析', version: '0.1.0', mode: 'analysis'
  })
  const recoveredState = structuredClone(withUndelivered)
  recoveredState.version += 1
  service.saveAnalysisState(recoveredState, recovery.run.id, 'analysis-turn')
  assert.deepEqual(service.projectAnalysisQuestions(recovery.run.id).map((question) => question.id), ['Q40'])
  service.completeRun(recovery.run.id, '补交付未成功展示的问题。', service.projectAnalysisQuestions(recovery.run.id))
  service.close()

  service = new PersistenceService(fixture.path)
  t.after(() => service.close())
  const assistantMessages = service.listMessages(thread.id).filter((message) => message.role === 'assistant')
  assert.deepEqual(assistantMessages[0]?.questions?.map((question) => question.id), ['Q32', 'Q39'])
  assert.deepEqual(assistantMessages[1]?.questions, [])
  assert.deepEqual(assistantMessages[2]?.questions?.map((question) => question.id), ['Q32'])
  assert.deepEqual(assistantMessages[3]?.questions?.map((question) => question.id), ['Q40'])
})

test('工作上下文持久化系统关系，并阻止删除仍被引用的系统', async (t) => {
  const fixture = await databaseFixture()
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }))
  const service = new PersistenceService(fixture.path)
  t.after(() => service.close())
  service.saveWorkspace({ id: 'workspace-1', path: '/tmp/workspace-1', name: 'Workspace 1' })
  service.saveWorkContextCompany({ name: '示例公司', industry: '金融科技', description: '', coreBusiness: ['消费金融'], regions: ['墨西哥'], terms: [{ term: 'DPD', description: '逾期天数' }], rawContext: '' })
  service.saveWorkContextSystem({ id: 'collection', name: '催收系统', alias: 'Collection', type: 'internal', positioning: '催收作业平台', coreUsers: [], coreCapabilities: [], boundary: '', notes: '', active: true })
  service.saveWorkContextSystem({ id: 'decision', name: '决策引擎', alias: 'Decision', type: 'internal', positioning: '策略决策', coreUsers: [], coreCapabilities: [], boundary: '', notes: '', active: true })
  const snapshot = service.saveWorkContextRelation({ sourceSystemId: 'decision', relationType: 'PROVIDE_STRATEGY', customRelationName: '', targetSystemId: 'collection', description: '下发策略' })
  assert.equal(snapshot.company.terms[0]?.term, 'DPD')
  assert.equal(snapshot.relations[0]?.targetSystemId, 'collection')
  service.syncRequirementSystemBinding('workspace-1', 'requirement-1', 'collection')
  assert.throws(() => service.deleteWorkContextSystem('collection'), /1 个 Workspace 和 1 条系统关系/)
  service.deleteWorkContextRelation(snapshot.relations[0]!.id)
  service.syncRequirementSystemBinding('workspace-1', 'requirement-1', null)
  assert.equal(service.deleteWorkContextSystem('collection').systems.some((system) => system.id === 'collection'), false)
})
