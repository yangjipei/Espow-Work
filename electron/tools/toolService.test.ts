import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { WriteApprovalRequest } from '../../src/tools'
import { LocalWorkspaceService } from '../workspaceService'
import { PersistenceService } from '../persistenceService'
import { EspowToolError, EspowToolService } from './toolService'

async function fixture(): Promise<{ root: string; workspace: LocalWorkspaceService; tools: EspowToolService }> {
  const root = await fs.mkdtemp(join(tmpdir(), 'espow-tools-'))
  const requirement = join(root, 'requirements', 'DeviceConnect Voice')
  await fs.mkdir(join(requirement, 'prd'), { recursive: true })
  await fs.writeFile(join(requirement, 'state.yaml'), 'requirement_id: device-connect\nname: DeviceConnect Voice\nstatus: ACTIVE\nlifecycle_stage: prd\ncurrent_artifact: prd/device-prd-v3.md\n')
  await fs.writeFile(join(requirement, 'overview.md'), '# Overview\n\nVoice collection.')
  await fs.writeFile(join(requirement, 'prd', 'device-prd-v1.md'), '# PRD\n\n旧版本。')
  await fs.writeFile(join(requirement, 'prd', 'device-PRD-V3.md'), '# PRD\n\n录音归档失败后重试。\n')
  await fs.writeFile(join(requirement, 'notes.txt'), 'plain text')
  const workspace = new LocalWorkspaceService()
  await workspace.scan(root)
  return { root, workspace, tools: new EspowToolService(workspace) }
}

async function rejectsCode(action: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof EspowToolError && error.code === code)
}

function analysisCandidate(status: 'Analyzing' | 'ReadyForConfirmation' = 'ReadyForConfirmation'): string {
  return JSON.stringify({
    analysisStatus: status,
    problemDefinition: '坐席无法及时识别有效联系人，也无法及时感知跨案件客户回复。',
    goal: '让坐席在客户可联系窗口内识别联系人并处理回复。',
    actors: [{ name: '催收坐席', role: '负责联系客户并记录结果' }],
    scenarios: [{
      id: 'S001', name: '客户跨案件回复', actor: '催收坐席', trigger: '客户通过 WhatsApp 回复',
      currentFlow: ['坐席停留在其他案件', '客户回复', '坐席稍后切回原案件'],
      blocker: '当前没有跨案件消息入口', expectedOutcome: '坐席及时发现并处理回复', status: '关键场景'
    }],
    currentFlow: ['案件进入', '查看客户', '选择联系方式', '触达客户', '客户响应', '坐席处理', '记录结果'],
    blockers: [{ description: '客户回复后坐席无法跨案件感知', evidenceType: 'FACT', source: '用户原始诉求' }],
    rootCauses: [{ description: '坐席可能依赖逐案切换查找新消息', evidenceType: 'ASSUMPTION', source: null }],
    boundaries: ['覆盖 WhatsApp 回复；RCS 处理方式待确认'],
    facts: ['客户回复容易错过'], assumptions: ['当前依赖逐案查看'], decisions: [],
    openQuestions: ['RCS 是否已有全局提醒入口？'], outOfScope: [], semanticReady: true
  })
}

function flowCandidate(status: 'DRAFT' | 'WAITING_CLARIFICATION' | 'READY_FOR_CONFIRMATION' = 'READY_FOR_CONFIRMATION'): string {
  return JSON.stringify({
    id: 'device-connect-call', name: 'DeviceConnect Voice 业务流程',
    scope: { goal: '从案件详情发起 Device call，直至结果回流与记录归档。', included: ['通话发起', '结果回流'], excluded: ['催收完整生命周期'] },
    status,
    actors: [
      { id: 'agent', name: '催收坐席', role: '发起通话并查看结果', source: 'S001' },
      { id: 'app', name: '催收 App', role: '校验准入并展示状态', source: 'S001' },
      { id: 'pt', name: 'PT 服务', role: '创建并执行通话', source: 'S001' }
    ],
    nodes: [
      { id: 'start', type: 'start', title: '进入案件详情', description: '', actorId: 'agent', stage: '准入', stateChange: null, sourceScenarioIds: ['S001'], sourceDecisionIds: [] },
      { id: 'check', type: 'decision', title: '设备标识与权限是否具备？', description: '', actorId: 'app', stage: '准入', stateChange: null, sourceScenarioIds: ['S001'], sourceDecisionIds: [] },
      { id: 'create', type: 'system', title: '创建 Device call', description: '', actorId: 'pt', stage: '发起', stateChange: 'INIT → PROCESSING', sourceScenarioIds: ['S001'], sourceDecisionIds: ['D001'] },
      { id: 'wait', type: 'wait', title: '等待通话结果 Notify', description: '', actorId: 'app', stage: '结果回流', stateChange: null, sourceScenarioIds: ['S001'], sourceDecisionIds: [] },
      { id: 'recover', type: 'system', title: 'Query 补偿查询', description: 'Notify 缺失时查询终态', actorId: 'pt', stage: '补偿', stateChange: null, sourceScenarioIds: ['S001'], sourceDecisionIds: [] },
      { id: 'done', type: 'end', title: '结果回写并结束', description: '', actorId: 'app', stage: '归档', stateChange: 'COMPLETED', sourceScenarioIds: ['S001'], sourceDecisionIds: [] },
      { id: 'exit', type: 'end', title: '本次创建提前结束', description: '不创建 orderNo，不调用 PT', actorId: 'app', stage: '准入', stateChange: '不改变已有状态', sourceScenarioIds: ['S001'], sourceDecisionIds: [] }
    ],
    edges: [
      { id: 'e1', from: 'start', to: 'check', label: '进入准入检查', type: 'main' },
      { id: 'e2', from: 'check', to: 'create', label: '是', type: 'main' },
      { id: 'e3', from: 'check', to: 'exit', label: '否', type: 'branch' },
      { id: 'e4', from: 'create', to: 'wait', label: '创建成功', type: 'main' },
      { id: 'e5', from: 'wait', to: 'done', label: '收到 Notify', type: 'main' },
      { id: 'e6', from: 'wait', to: 'recover', label: 'Notify 缺失', type: 'recovery' },
      { id: 'e7', from: 'recover', to: 'done', label: '查询到终态', type: 'recovery' }
    ],
    entry: 'start',
    exits: [
      { nodeId: 'done', condition: '结果已回写', recordBehavior: '保留通话记录', stateImpact: '进入终态', retryable: '否' },
      { nodeId: 'exit', condition: '准入失败', recordBehavior: '不生成 orderNo', stateImpact: '不改变已有状态', retryable: '条件满足后可重新发起' }
    ],
    openQuestions: status === 'WAITING_CLARIFICATION' ? ['Query 达到补偿上限后展示什么状态？'] : [],
    semanticChecks: { mainScenarioCovered: true, blockersHandled: true, keyExitsCovered: true, asyncRecoveryCovered: true, closedLoop: true },
    sourceAnalysisPath: 'analysis/requirement-analysis.md', sourceAnalysisStatus: 'confirmed'
  })
}

async function writeAnalysis(value: Awaited<ReturnType<typeof fixture>>, status: 'confirmed' | 'draft'): Promise<void> {
  const directory = join(value.root, 'requirements', 'DeviceConnect Voice', 'analysis')
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(join(directory, 'requirement-analysis.md'), `# Requirement Analysis\n\n- Analysis Status：${status}\n\n## Actors\n\n催收坐席、催收 App、PT 服务。\n`)
  await value.workspace.refreshCurrent()
}

test('读取、定位、内容读取与版本计算均来自当前 Requirement', async (t) => {
  const value = await fixture()
  t.after(() => fs.rm(value.root, { recursive: true, force: true }))
  const context = { runId: 'run-read', requirementId: 'device-connect' }
  const summary = await value.tools.execute('workspace_read', { requirementId: 'device-connect' }, context)
  assert.equal((summary.requirement as Record<string, unknown>).id, 'device-connect')
  assert.equal(Array.isArray(summary.artifacts), true)

  const found = await value.tools.execute('artifact_find', { requirementId: 'device-connect', type: 'PRD' }, context)
  const candidates = found.candidates as Array<Record<string, unknown>>
  assert.equal(candidates.length, 2)
  const current = candidates.find((item) => String(item.path).toLowerCase().endsWith('v3.md'))
  assert.ok(current)
  const read = await value.tools.execute('artifact_read', { requirementId: 'device-connect', artifactId: current.id }, context)
  assert.match(String(read.content), /录音归档/)
  const section = await value.tools.execute('artifact_read', {
    requirementId: 'device-connect', artifactId: current.id, section: 'PRD'
  }, context)
  assert.equal((section.metadata as Record<string, unknown>).section, 'PRD')
  await rejectsCode(() => value.tools.execute('artifact_read', {
    requirementId: 'device-connect', artifactId: current.id, section: '不存在章节'
  }, context), 'SECTION_NOT_FOUND')

  const version = await value.tools.execute('artifact_next_version', { requirementId: 'device-connect', artifactId: current.id }, context)
  assert.equal(String(version.targetPath).toLowerCase(), 'prd/device-prd-v4.md')
})

test('Diff 只生成候选；未授权写入被阻止，授权后原子写新版本并通过校验', async (t) => {
  const value = await fixture()
  t.after(() => fs.rm(value.root, { recursive: true, force: true }))
  const context = { runId: 'run-write', requirementId: 'device-connect' }
  const found = await value.tools.execute('artifact_find', { requirementId: 'device-connect', path: 'prd/device-PRD-V3.md' }, context)
  const artifact = (found.candidates as Array<Record<string, unknown>>)[0]
  const candidate = '# PRD\n\n录音归档失败不重试不告警。\n'
  const diff = await value.tools.execute('artifact_diff', {
    requirementId: 'device-connect', artifactId: artifact.id, candidate
  }, context)
  assert.equal(diff.hasChanges, true)
  assert.match(String(diff.diff), /不重试不告警/)
  const approval = diff.approval as unknown as WriteApprovalRequest
  assert.equal(approval.status, 'Pending')
  const target = 'prd/device-PRD-V4.md'

  const denied = await value.tools.execute('artifact_write', {
    requirementId: 'device-connect', approvalId: approval.id, targetPath: target
  }, context)
  assert.equal(denied.written, false)
  await assert.rejects(fs.access(join(value.root, 'requirements', 'DeviceConnect Voice', target)))

  const approved: WriteApprovalRequest = { ...approval, status: 'Approved', resolvedAt: new Date().toISOString() }
  const written = await value.tools.execute('artifact_write', {
    requirementId: 'device-connect', approvalId: approval.id, targetPath: target
  }, { ...context, approvedApproval: approved })
  assert.equal(written.written, true)
  assert.equal(await fs.readFile(join(value.root, 'requirements', 'DeviceConnect Voice', target), 'utf8'), candidate)
  assert.match(await fs.readFile(join(value.root, 'requirements', 'DeviceConnect Voice', 'prd/device-PRD-V3.md'), 'utf8'), /重试/)

  const validation = await value.tools.execute('workspace_validate', {
    requirementId: 'device-connect', path: target, sourcePath: 'prd/device-PRD-V3.md'
  }, context)
  assert.equal(validation.valid, true)
  await rejectsCode(() => value.tools.execute('artifact_write', {
    requirementId: 'device-connect', approvalId: approval.id, targetPath: target
  }, { ...context, approvedApproval: approved }), 'TARGET_EXISTS')
})

test('非法输入、不存在文件、越界路径与错误 Requirement 均失败关闭', async (t) => {
  const value = await fixture()
  t.after(() => fs.rm(value.root, { recursive: true, force: true }))
  const context = { runId: 'run-safe', requirementId: 'device-connect' }
  await rejectsCode(() => value.tools.execute('artifact_find', { requirementId: 'device-connect', path: '../../etc/passwd' }, context), 'WORKSPACE_SCOPE')
  await rejectsCode(() => value.tools.execute('artifact_read', { requirementId: 'device-connect', path: '../state.yaml' }, context), 'WORKSPACE_SCOPE')
  await rejectsCode(() => value.tools.execute('artifact_read', { requirementId: 'device-connect', path: '/etc/passwd' }, context), 'WORKSPACE_SCOPE')
  await rejectsCode(() => value.tools.execute('artifact_read', { requirementId: 'device-connect', path: 'prd/missing.md' }, context), 'ARTIFACT_NOT_FOUND')
  await rejectsCode(() => value.tools.execute('workspace_read', { requirementId: 'another-requirement' }, context), 'WORKSPACE_SCOPE')
  await rejectsCode(() => value.tools.execute('artifact_read', { requirementId: 'device-connect' }, context), 'INVALID_INPUT')
})

test('显式覆盖需 Approval，且 Diff 后源文件变化会拒绝陈旧写入', async (t) => {
  const value = await fixture()
  t.after(() => fs.rm(value.root, { recursive: true, force: true }))
  const context = { runId: 'run-overwrite', requirementId: 'device-connect' }
  const sourcePath = 'prd/device-PRD-V3.md'
  const artifact = value.workspace.getArtifactByPath('device-connect', sourcePath)
  assert.ok(artifact)
  const candidate = '# PRD\n\n覆盖后的规则。\n'
  const diff = await value.tools.execute('artifact_diff', {
    requirementId: 'device-connect', artifactId: artifact.id, candidate, writeMode: 'overwrite'
  }, context)
  const approval = { ...(diff.approval as unknown as WriteApprovalRequest), status: 'Approved' as const, resolvedAt: new Date().toISOString() }
  await value.tools.execute('artifact_write', {
    requirementId: 'device-connect', approvalId: approval.id, targetPath: sourcePath
  }, { ...context, approvedApproval: approval })
  assert.equal(await fs.readFile(join(value.root, 'requirements', 'DeviceConnect Voice', sourcePath), 'utf8'), candidate)

  const staleDiff = await value.tools.execute('artifact_diff', {
    requirementId: 'device-connect', artifactId: artifact.id, candidate: '# PRD\n\n第二次候选。\n'
  }, { runId: 'run-stale', requirementId: 'device-connect' })
  const staleApproval = { ...(staleDiff.approval as unknown as WriteApprovalRequest), status: 'Approved' as const, resolvedAt: new Date().toISOString() }
  await fs.writeFile(join(value.root, 'requirements', 'DeviceConnect Voice', sourcePath), '# PRD\n\n外部修改。\n')
  await rejectsCode(() => value.tools.execute('artifact_write', {
    requirementId: 'device-connect', approvalId: staleApproval.id, targetPath: 'prd/device-PRD-V4.md'
  }, { runId: 'run-stale', requirementId: 'device-connect', approvedApproval: staleApproval }), 'SOURCE_CHANGED')
})

test('Change Result 记录多 Artifact 检查、无需修改项、Decision Conflict 与 Open Issue Candidate', async (t) => {
  const value = await fixture()
  t.after(() => fs.rm(value.root, { recursive: true, force: true }))
  const output = await value.tools.execute('change_result_submit', {
    requirementId: 'device-connect',
    resultJson: JSON.stringify({
      status: 'DecisionConflict',
      changeSummary: '归档失败改为自动重试三次。',
      impactAssessment: 'PRD 需要修改；主流程已检查且无需修改。',
      affectedArtifacts: [{ artifactId: 'prd-1', path: 'prd/device-PRD-V3.md', type: 'PRD', reason: '异常规则变化。' }],
      unaffectedArtifacts: [{ artifactId: 'flow-1', path: 'flows/business-flow.md', type: 'Business Flow', reason: '不改变主流程。' }],
      openQuestions: ['每次重试间隔尚未定义。'],
      decisionsAffected: [{ id: 'D-1', title: '归档失败不重试', conflict: true, reason: '新要求直接相反。' }],
      filesRead: ['prd/device-PRD-V3.md', 'flows/business-flow.md'],
      candidateChanges: [], finalChanges: [], validationResult: null
    })
  }, { runId: 'run-result', requirementId: 'device-connect' })
  const result = output.changeResult as Record<string, unknown>
  assert.equal(result.status, 'DecisionConflict')
  assert.equal((result.unaffectedArtifacts as unknown[]).length, 1)
  assert.equal((result.openQuestions as unknown[]).length, 1)
  assert.equal((result.decisionsAffected as Array<Record<string, unknown>>)[0]?.conflict, true)
})

test('Change Result 接受 Tool schema 直接生成的 JSON 对象', async (t) => {
  const value = await fixture()
  t.after(() => fs.rm(value.root, { recursive: true, force: true }))
  const output = await value.tools.execute('change_result_submit', {
    requirementId: 'device-connect',
    resultJson: {
      status: 'Assessed',
      changeSummary: '取消任务规则已明确。',
      impactAssessment: '已完成影响判断。',
      affectedArtifacts: [], unaffectedArtifacts: [], openQuestions: [], decisionsAffected: [], filesRead: [],
      candidateChanges: [], finalChanges: [], validationResult: null
    }
  }, { runId: 'run-object-result', requirementId: 'device-connect' })
  assert.equal((output.changeResult as Record<string, unknown>).status, 'Assessed')
})

test('Change Result 拒绝缺失结构字段的输入', async (t) => {
  const value = await fixture()
  t.after(() => fs.rm(value.root, { recursive: true, force: true }))
  await rejectsCode(() => value.tools.execute('change_result_submit', {
    requirementId: 'device-connect', resultJson: JSON.stringify({ status: 'Assessed', changeSummary: '变更' })
  }, { runId: 'run-invalid-result', requirementId: 'device-connect' }), 'INVALID_INPUT')
})

test('Requirement Analysis Ready Gate 区分内容完整性与语义判断', async (t) => {
  const value = await fixture()
  t.after(() => fs.rm(value.root, { recursive: true, force: true }))
  const context = { runId: 'analysis-ready', requirementId: 'device-connect' }
  const ready = await value.tools.execute('requirement_analysis_ready', {
    requirementId: 'device-connect', resultJson: analysisCandidate()
  }, context)
  assert.equal(ready.ready, true)

  const incomplete = JSON.parse(analysisCandidate()) as Record<string, unknown>
  incomplete.currentFlow = []
  incomplete.blockers = []
  const checked = await value.tools.execute('requirement_analysis_ready', {
    requirementId: 'device-connect', resultJson: JSON.stringify(incomplete)
  }, context)
  assert.equal(checked.ready, false)
  assert.deepEqual((checked.checks as Record<string, unknown>).missing, ['current_flow', 'blockers'])
  await rejectsCode(() => value.tools.execute('requirement_analysis_submit', {
    requirementId: 'device-connect', resultJson: JSON.stringify(incomplete)
  }, context), 'ANALYSIS_NOT_READY')

  const boundaryUnknown = JSON.parse(analysisCandidate()) as Record<string, unknown>
  boundaryUnknown.boundaries = []
  boundaryUnknown.semanticReady = false
  const semanticCheck = await value.tools.execute('requirement_analysis_ready', {
    requirementId: 'device-connect', resultJson: JSON.stringify(boundaryUnknown)
  }, context)
  assert.equal(semanticCheck.ready, false)
  assert.equal((semanticCheck.checks as Record<string, unknown>).deterministicPassed, true)
  assert.equal((semanticCheck.checks as Record<string, unknown>).semanticReady, false)

  const objectInput = JSON.parse(analysisCandidate()) as Record<string, unknown>
  const objectCheck = await value.tools.execute('requirement_analysis_ready', {
    requirementId: 'device-connect', resultJson: objectInput
  }, context)
  assert.equal(objectCheck.ready, true)
})

test('Requirement Analysis 仅在明确确认后写入正式 Artifact 并拒绝陈旧候选', async (t) => {
  const value = await fixture()
  t.after(() => fs.rm(value.root, { recursive: true, force: true }))
  const context = { runId: 'analysis-confirm', requirementId: 'device-connect' }
  const submitted = await value.tools.execute('requirement_analysis_submit', {
    requirementId: 'device-connect', resultJson: analysisCandidate()
  }, context)
  const result = submitted.analysisResult as ReturnType<typeof JSON.parse>
  const args = {
    requirementId: 'device-connect', analysisRunId: context.runId,
    path: result.artifactPath, candidate: result.artifactCandidate
  }
  const denied = await value.tools.execute('requirement_analysis_write', args, context)
  assert.equal(denied.written, false)
  await assert.rejects(fs.access(join(value.root, 'requirements', 'DeviceConnect Voice', result.artifactPath)))

  const confirmedAnalysis = {
    runId: context.runId, path: result.artifactPath, candidate: result.artifactCandidate, baseHash: result.artifactBaseHash
  }
  const written = await value.tools.execute('requirement_analysis_write', args, { ...context, confirmedAnalysis })
  assert.equal(written.written, true)
  const content = await fs.readFile(join(value.root, 'requirements', 'DeviceConnect Voice', result.artifactPath), 'utf8')
  assert.match(content, /Analysis Status：confirmed/)
  assert.match(content, /S001｜客户跨案件回复/)
  const validation = await value.tools.execute('workspace_validate', {
    requirementId: 'device-connect', path: result.artifactPath
  }, context)
  assert.equal(validation.valid, true)

  await fs.appendFile(join(value.root, 'requirements', 'DeviceConnect Voice', result.artifactPath), '\n外部修改。\n')
  await rejectsCode(() => value.tools.execute('requirement_analysis_write', args, { ...context, confirmedAnalysis }), 'SOURCE_CHANGED')
})

test('Business Flow 从确认 Analysis 生成结构化 Model、HTML Preview、确认后成对写入并递增版本', async (t) => {
  const value = await fixture()
  t.after(() => fs.rm(value.root, { recursive: true, force: true }))
  await writeAnalysis(value, 'confirmed')
  const context = { runId: 'run-flow', requirementId: 'device-connect' }
  const version = await value.tools.execute('business_flow_next_version', { requirementId: 'device-connect' }, context)
  assert.equal(version.version, 1)
  const ready = await value.tools.execute('business_flow_ready', { requirementId: 'device-connect', resultJson: flowCandidate() }, context)
  assert.equal(ready.ready, true)
  const submitted = await value.tools.execute('business_flow_submit', {
    requirementId: 'device-connect', expectedVersion: 1, resultJson: flowCandidate()
  }, context)
  const flow = submitted.flowResult as import('../../src/skills').BusinessFlowResult
  assert.equal(flow.modelPath, 'flows/business-flow-v1.json')
  assert.equal(flow.htmlPath, 'flows/business-flow-v1.html')
  assert.match(flow.htmlCandidate, /全部展开/)
  assert.match(flow.htmlCandidate, /主流程/)
  assert.deepEqual(flow.diff.addedNodes, ['start', 'check', 'create', 'wait', 'recover', 'done', 'exit'])

  const blocked = await value.tools.execute('business_flow_write', {
    requirementId: 'device-connect', flowRunId: 'run-flow'
  }, context)
  assert.equal(blocked.written, false)
  const written = await value.tools.execute('business_flow_write', {
    requirementId: 'device-connect', flowRunId: 'run-flow'
  }, { ...context, confirmedFlow: flow })
  assert.deepEqual(written.paths, ['flows/business-flow-v1.json', 'flows/business-flow-v1.html'])
  const model = JSON.parse(await fs.readFile(join(value.root, 'requirements', 'DeviceConnect Voice', flow.modelPath), 'utf8')) as Record<string, unknown>
  assert.equal(model.status, 'CONFIRMED')
  assert.match(await fs.readFile(join(value.root, 'requirements', 'DeviceConnect Voice', flow.htmlPath), 'utf8'), /CONFIRMED/)

  await value.workspace.refreshCurrent()
  const next = await value.tools.execute('business_flow_next_version', { requirementId: 'device-connect' }, context)
  assert.equal(next.version, 2)
  const delta = JSON.parse(flowCandidate()) as { nodes: Array<{ id: string; description: string }> }
  delta.nodes.find((node) => node.id === 'recover')!.description = 'Notify 缺失时查询终态；达到上限后记录失败状态'
  const second = await value.tools.execute('business_flow_submit', {
    requirementId: 'device-connect', expectedVersion: 2, resultJson: JSON.stringify(delta)
  }, context)
  const secondFlow = second.flowResult as import('../../src/skills').BusinessFlowResult
  assert.deepEqual(secondFlow.diff.changedNodes, ['recover'])
  assert.deepEqual(secondFlow.diff.addedNodes, [])
  await value.tools.execute('business_flow_write', {
    requirementId: 'device-connect', flowRunId: 'run-flow'
  }, { ...context, confirmedFlow: secondFlow })
  assert.equal((JSON.parse(await fs.readFile(join(value.root, 'requirements', 'DeviceConnect Voice', 'flows', 'business-flow-v2.json'), 'utf8')) as { status: string }).status, 'CONFIRMED')
})

test('Business Flow 关键事实缺口保持 Waiting Clarification，未确认 Analysis 拒绝正式流程', async (t) => {
  const value = await fixture()
  t.after(() => fs.rm(value.root, { recursive: true, force: true }))
  await writeAnalysis(value, 'confirmed')
  const context = { runId: 'run-flow-gap', requirementId: 'device-connect' }
  const waiting = await value.tools.execute('business_flow_submit', {
    requirementId: 'device-connect', expectedVersion: 1, resultJson: flowCandidate('WAITING_CLARIFICATION')
  }, context)
  assert.equal((waiting.flowResult as import('../../src/skills').BusinessFlowResult).flowStatus, 'WAITING_CLARIFICATION')

  await writeAnalysis(value, 'draft')
  await rejectsCode(() => value.tools.execute('business_flow_ready', {
    requirementId: 'device-connect', resultJson: flowCandidate()
  }, context), 'PREREQUISITE_NOT_READY')
})

test('用户明确要求时可基于未确认 Analysis 生成 Draft Business Flow，但不能升级为 Ready', async (t) => {
  const value = await fixture()
  t.after(() => fs.rm(value.root, { recursive: true, force: true }))
  const draft = JSON.parse(flowCandidate('DRAFT')) as Record<string, unknown>
  draft.sourceAnalysisStatus = 'draft'
  const context = {
    runId: 'run-flow-draft', requirementId: 'device-connect',
    contextPackage: { task: '基于当前 draft 探索 Draft Business Flow', existingAnalysis: { sourceRunId: 'analysis-draft' } }
  } as unknown as import('./toolService').ToolExecutionContext
  const submitted = await value.tools.execute('business_flow_submit', {
    requirementId: 'device-connect', expectedVersion: 1, resultJson: JSON.stringify(draft)
  }, context)
  assert.equal((submitted.flowResult as import('../../src/skills').BusinessFlowResult).prerequisite, 'DraftRequirementAnalysis')

  draft.status = 'READY_FOR_CONFIRMATION'
  await rejectsCode(() => value.tools.execute('business_flow_ready', {
    requirementId: 'device-connect', resultJson: JSON.stringify(draft)
  }, context), 'PREREQUISITE_NOT_READY')
})

test('analysis_turn_submit 以 Script-First 方式增量更新 State，并作为 terminal tool 结束本轮且不写正式 Artifact', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'espow-analysis-turn-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const requirementRoot = join(root, 'requirements', '需求分析')
  await fs.mkdir(requirementRoot, { recursive: true })
  await fs.writeFile(join(requirementRoot, 'state.yaml'), 'requirement_id: requirement-1\nname: 需求分析\nstatus: ACTIVE\nlifecycle_stage: analysis\n')
  await fs.writeFile(join(requirementRoot, 'overview.md'), '# Overview\n')
  const workspace = new LocalWorkspaceService()
  const snapshot = await workspace.scan(root)
  const persistence = new PersistenceService(join(root, 'app.sqlite'))
  t.after(() => persistence.close())
  persistence.saveWorkspace({ id: snapshot.id, path: snapshot.rootPath, name: snapshot.name })
  persistence.saveModelConfig({ provider: 'openai', apiKey: 'test-only', model: 'test', baseUrl: 'https://example.com/v1' })
  const thread = persistence.createThread(snapshot.id, 'requirement-1', '分析')
  const started = persistence.startRun(snapshot.id, 'requirement-1', thread.id, '本期只做 App，不做 Web', persistence.getActiveModelConfig(), undefined, {
    id: 'requirement-analysis', name: '需求分析', version: '0.1.0', mode: 'analysis'
  })
  const tools = new EspowToolService(workspace, persistence)
  const output = await tools.execute('analysis_turn_submit', {
    requirementId: 'requirement-1',
    assistantReply: '已确认本期只做 App，不做 Web。',
    patches: [
      { op: 'replace', path: '/problem/currentProblem', value: '当前处理方式效率低', status: 'confirmed', source: 'user' },
      { op: 'add', path: '/scope/inScope/-', value: 'App', source: 'user' },
      { op: 'add', path: '/scope/outOfScope/-', value: 'Web', source: 'user' }
    ],
    resolvedQuestionIds: [],
    newQuestions: [{ topic: 'flow', question: '主流程如何结束？', priority: 'blocking', reason: '影响退出条件' }],
    schemaDelta: { status: 'proposed', requirementTypes: ['page_interaction'], modules: ['page', 'interaction'] }
  }, { runId: started.run.id, requirementId: 'requirement-1' })

  assert.equal(output.__espowTerminal, true)
  assert.equal(output.assistantReply, '已确认本期只做 App，不做 Web。')
  const state = persistence.getAnalysisState('requirement-1', thread.id)
  assert.ok(state)
  assert.deepEqual(state.scope.inScope, ['App'])
  assert.deepEqual(state.scope.outOfScope, ['Web'])
  assert.equal(state.openQuestions[0]?.priority, 'blocking')
  assert.equal((output.scriptEvents as Array<Record<string, unknown>>).every((item) => item.tokenCost === 0), true)
  assert.equal(persistence.getRun(started.run.id).analysisResult?.analysisStatus, 'Analyzing')
  await assert.rejects(fs.access(join(requirementRoot, 'analysis', 'requirement-analysis.md')))
})
