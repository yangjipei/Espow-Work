import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { BusinessFlowModel, ProductSpecModel, SolutionDesignModel } from '../../src/skills'
import { LocalWorkspaceService } from '../workspaceService'
import { interactionFixture } from './interactionTestFixture'
import { parseProductSpecJson, productSpecReadiness, renderProductSpecMarkdown } from './productSpec'
import { EspowToolError, EspowToolService } from './toolService'
import './requirementReview.test'

function specFixture(interactionRequired = true): ProductSpecModel {
  return {
    id: 'prd-device-connect', name: 'DeviceConnect Voice PRD', status: 'READY_FOR_CONFIRMATION', mode: 'create',
    documentInfo: { requirementName: 'DeviceConnect Voice', requirementDate: '待补充', documentDate: '待补充', source: 'Workspace', productManager: '待补充' },
    background: ['坐席当前缺少设备通话入口'], goals: ['坐席可对存在设备标识的案件发起人工单呼'], value: ['减少跨系统操作'],
    scope: { applicable: ['案件详情'], included: ['人工单呼'], excluded: ['批量自动外呼'] }, rolesAndScenarios: ['坐席处理案件'], businessFlowSummary: ['准入 → 创建 → 等待结果 → 回写'], solutionSummary: ['提供设备通话与结果回写能力'],
    capabilities: [{ id: 'FR01', name: 'Device call 创建', purpose: '创建人工单呼', trigger: '坐席点击 Device call', preconditions: ['案件存在 deviceTag'], userActions: ['点击入口'], systemBehavior: ['使用 deviceTag 创建通话请求'], businessRuleIds: ['BR01'], stateChanges: ['进入 PROCESSING'], successResult: '返回 orderNo 并展示处理中', failureResult: '展示失败且不进入通话', exceptionHandling: ['创建失败允许人工重试'], relatedPageIds: interactionRequired ? ['PAGE-CASE'] : [], sourceCapabilityIds: ['CAP-01'], sourceFlowNodeIds: ['start'], sourceScenarioIds: ['S001'], sourceDecisionIds: [] }],
    rules: [{ id: 'BR01', description: '仅案件存在 deviceTag 时允许发起', trigger: '展示或点击入口', condition: 'deviceTag 存在', behavior: '启用入口并以 deviceTag 创建请求', result: '创建一笔人工单呼', relatedCapabilityIds: ['FR01'], sourceRefs: ['CAP-01', 'start'] }],
    states: [{ id: 'PROCESSING', name: '处理中', meaning: '已创建且未获得终态', entryConditions: ['Create 成功'], exitConditions: ['Notify 或 Query 返回终态'], subsequentBehavior: ['回写最终结果'], sourceRefs: ['CAP-01'] }],
    fields: [{ id: 'deviceTag', name: '设备标识', meaning: '定位呼叫设备', source: '案件设备信息', required: true, usedAt: ['Create 请求'], format: null, defaultValue: null, allowedValues: [], updateTiming: '读取案件时', emptyBehavior: '入口 Disabled 并提示当前设备不可呼叫', sourceRefs: ['CAP-01'] }],
    failures: [{ id: 'ERR01', condition: 'Create 失败', systemBehavior: '不创建本地通话任务', userFeedback: '展示创建失败', retry: '允许用户再次点击', statusResult: 'FAILED', downstreamImpact: '不进入结果等待', sourceRefs: ['CAP-01'] }], recoveries: [], permissions: ['仅有案件操作权限的坐席可用'], externalDependencies: ['DeviceConnect 服务'],
    pageBehaviors: interactionRequired ? [{ id: 'PAGE-CASE', page: '案件详情', change: '新增 Device call 入口', visibility: '案件联系区域展示', operation: '点击创建单呼', result: '展示通话状态', dataFieldIds: ['deviceTag'], sourceInteractionIds: ['ACT-CALL'], sourcePrototypePath: 'prototype/case-detail-v1.html' }] : [],
    openIssues: [], conflicts: [], acceptanceCriteria: [{ id: 'AC01', capabilityId: 'FR01', given: ['案件存在 deviceTag'], when: '坐席点击 Device call', then: ['系统使用 deviceTag 创建请求', '成功后展示 PROCESSING'], sourceRefs: ['S001', 'start', 'CAP-01'] }],
    semanticChecks: { noRedesign: true, capabilitiesImplementable: true, mainFlowSpecified: true, failuresHaveResults: true, fieldSourcesComplete: true, statesHaveTransitions: true, upstreamConsistent: true, prototypeConsistent: true, acceptanceTestable: true },
    sourceAnalysisPath: 'analysis/requirement-analysis.md', sourceAnalysisStatus: 'confirmed', sourceFlowPath: 'flows/business-flow-v1.json', sourceFlowStatus: 'confirmed', sourceSolutionPath: 'solution/solution-design-v1.json', sourceSolutionStatus: 'confirmed',
    interactionRequired, sourceInteractionPath: interactionRequired ? 'interaction/interaction-design-v1.json' : null, sourceInteractionStatus: interactionRequired ? 'confirmed' : 'not-applicable', sourcePrototypePath: interactionRequired ? 'prototype/case-detail-v1.html' : null,
    existingPrdPath: null, changedSections: [], confirmedAt: null
  }
}

test('页面型 PRD 具备能力、规则、状态、字段来源、异常和可测试验收时 Ready', () => {
  const spec = parseProductSpecJson(JSON.stringify(specFixture()))
  assert.equal(productSpecReadiness(spec).prdReady, true)
  const markdown = renderProductSpecMarkdown(spec)
  assert.match(markdown, /# 功能需求/); assert.match(markdown, /BR01/); assert.match(markdown, /Given 案件存在 deviceTag/)
})

test('纯后台需求允许 Interaction 与 Prototype 为 N/A，且不制造页面规格', () => {
  const spec = specFixture(false)
  spec.name = '后台自动归档 PRD'; spec.capabilities[0].relatedPageIds = []; spec.sourcePrototypePath = null
  assert.equal(productSpecReadiness(spec).prdReady, true)
  assert.match(renderProductSpecMarkdown(spec), /# 页面与交互\n\nN\/A/)
})

test('字段来源缺失、状态缺少退出、异常无结果会阻止 Ready', () => {
  const spec = specFixture(); spec.fields[0].source = ''; spec.states[0].exitConditions = []; spec.failures[0].statusResult = ''
  const result = productSpecReadiness(spec)
  assert.equal(result.prdReady, false); assert.ok(result.missing.includes('field_sources')); assert.ok(result.missing.includes('state_transitions')); assert.ok(result.missing.includes('failure_results'))
})

test('未知 Retry/Timeout 以阻断 Open Issue 保留，不自行补默认次数', () => {
  const spec = specFixture(); spec.openIssues.push({ id: 'OI01', description: 'Query 最大次数与间隔未知', impact: '研发无法实现补偿终止条件', requiredDecision: '确认次数、间隔和超时结果', blocking: true }); spec.status = 'WAITING_CLARIFICATION'
  const result = productSpecReadiness(spec)
  assert.equal(result.prdReady, false); assert.ok(result.missing.includes('blocking_open_issues'))
})

test('Decision/Prototype 上游冲突不被静默消解', () => {
  const spec = specFixture(); spec.conflicts.push({ id: 'CF01', type: 'Upstream Conflict', sources: ['Business Flow', 'Prototype'], description: '关闭 UI 是否改变通话状态不一致', affectedSections: ['状态', '页面与交互'], requiredDecision: '确认关闭语义' }); spec.semanticChecks.upstreamConsistent = false
  const result = productSpecReadiness(spec)
  assert.equal(result.prdReady, false); assert.ok(result.missing.includes('conflicts'))
})

test('第三方 Callback / Query / Retry / Idempotency 可作为可执行 Rule 与 Recovery 规格化', () => {
  const spec = specFixture(); spec.rules.push({ id: 'BR02', description: 'Notify 重复回调按 orderNo 幂等处理', trigger: '收到 Notify', condition: 'orderNo 已处理', behavior: '返回成功且不重复改写终态', result: '终态保持不变', relatedCapabilityIds: ['FR01'], sourceRefs: ['CAP-01'] }); spec.recoveries.push({ id: 'RC01', trigger: 'Notify 超时', mechanism: 'Query 补偿', actor: '系统', limit: '由已确认 Decision 定义', interval: '由已确认 Decision 定义', exhaustedBehavior: '记录 FAILED', result: '任务进入终态', sourceRefs: ['CAP-01'] })
  assert.equal(productSpecReadiness(spec).prdReady, true)
  assert.match(renderProductSpecMarkdown(spec), /orderNo 幂等处理/)
})

async function workspaceFixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'espow-product-spec-'))
  const requirement = join(root, 'requirements', 'DeviceConnect Voice')
  for (const dir of ['analysis', 'flows', 'solution', 'interaction', 'prototype']) await fs.mkdir(join(requirement, dir), { recursive: true })
  await fs.writeFile(join(requirement, 'state.yaml'), 'requirement_id: device-connect\nname: DeviceConnect Voice\nstatus: ACTIVE\nlifecycle_stage: prd\n')
  await fs.writeFile(join(requirement, 'overview.md'), '# Overview\n')
  await fs.writeFile(join(requirement, 'analysis', 'requirement-analysis.md'), '# Analysis\n\n- Analysis Status：confirmed\n')
  const flow: BusinessFlowModel = { id: 'flow', name: 'Flow', scope: { goal: '呼叫', included: ['人工单呼'], excluded: ['批量外呼'] }, status: 'CONFIRMED', actors: [{ id: 'agent', name: '坐席', role: '操作人', source: 'S001' }], nodes: [{ id: 'start', type: 'start', title: '创建', description: '', actorId: 'agent', stage: '创建', stateChange: 'PROCESSING', sourceScenarioIds: ['S001'], sourceDecisionIds: [] }, { id: 'done', type: 'end', title: '完成', description: '', actorId: 'agent', stage: '完成', stateChange: 'COMPLETED', sourceScenarioIds: ['S001'], sourceDecisionIds: [] }], edges: [{ id: 'e1', from: 'start', to: 'done', label: '完成', type: 'main' }], entry: 'start', exits: [{ nodeId: 'done', condition: '获得终态', recordBehavior: '记录', stateImpact: 'COMPLETED', retryable: '否' }], openQuestions: [], semanticChecks: { mainScenarioCovered: true, blockersHandled: true, keyExitsCovered: true, asyncRecoveryCovered: true, closedLoop: true }, sourceAnalysisPath: 'analysis/requirement-analysis.md', sourceAnalysisStatus: 'confirmed', confirmedAt: new Date().toISOString() }
  await fs.writeFile(join(requirement, 'flows', 'business-flow-v1.json'), `${JSON.stringify(flow, null, 2)}\n`)
  const solution: SolutionDesignModel = { id: 'solution', name: 'Solution', overview: '单呼', scope: { included: ['人工单呼'], excluded: ['批量外呼'] }, status: 'CONFIRMED', capabilities: [{ id: 'CAP-01', name: '创建', layer: 'user-facing', purpose: '创建', actor: '坐席', trigger: '点击', execution: 'manual', input: ['deviceTag'], behavior: ['创建'], output: ['orderNo'], relatedFlowNodeIds: ['start', 'done'], sourceScenarioIds: ['S001'], sourceDecisionIds: [], rules: [], exceptions: [], surfaces: ['案件详情'] }], rules: [], states: [], dataObjects: [], recoveries: [], productSurfaces: [], decisions: [], openQuestions: [], flowConflicts: [], semanticChecks: { goalCovered: true, scenariosCovered: true, flowNodesCovered: true, blockersResolved: true, exceptionsHandled: true, exitsCovered: true, recoveryCovered: true, noOverdesign: true }, sourceAnalysisPath: 'analysis/requirement-analysis.md', sourceAnalysisStatus: 'confirmed', sourceFlowPath: 'flows/business-flow-v1.json', sourceFlowStatus: 'confirmed', confirmedAt: new Date().toISOString() }
  await fs.writeFile(join(requirement, 'solution', 'solution-design-v1.json'), `${JSON.stringify(solution, null, 2)}\n`)
  const interaction = interactionFixture('CONFIRMED'); interaction.confirmedAt = new Date().toISOString()
  await fs.writeFile(join(requirement, 'interaction', 'interaction-design-v1.json'), `${JSON.stringify(interaction, null, 2)}\n`)
  await fs.writeFile(join(requirement, 'prototype', 'case-detail-v1.html'), '<main id="case">Confirmed prototype</main>')
  const workspace = new LocalWorkspaceService(); await workspace.scan(root)
  return { root, requirement, tools: new EspowToolService(workspace) }
}

test('Product Spec Tool 从已确认上游生成 Candidate，确认后写入版本化 JSON 与 PRD', async (t) => {
  const value = await workspaceFixture(); t.after(() => fs.rm(value.root, { recursive: true, force: true }))
  const context = { runId: 'prd-run', requirementId: 'device-connect', contextPackage: { task: '生成正式 PRD' } as never }
  const next = await value.tools.execute('product_spec_next_version', { requirementId: 'device-connect' }, context); assert.equal(next.version, 1)
  const resultJson = JSON.stringify(specFixture())
  assert.equal((await value.tools.execute('product_spec_ready', { requirementId: 'device-connect', resultJson }, context)).prdReady, true)
  const submitted = await value.tools.execute('product_spec_submit', { requirementId: 'device-connect', expectedVersion: 1, resultJson }, context)
  const result = submitted.productSpecResult as unknown as import('../../src/skills').ProductSpecResult
  assert.equal((await value.tools.execute('product_spec_write', { requirementId: 'device-connect', productSpecRunId: 'prd-run' }, context)).written, false)
  const written = await value.tools.execute('product_spec_write', { requirementId: 'device-connect', productSpecRunId: 'prd-run' }, { ...context, confirmedProductSpec: result })
  assert.deepEqual(written.paths, ['prd/product-spec-v1.json', 'prd/prd-v1.md'])
  assert.equal((JSON.parse(await fs.readFile(join(value.requirement, 'prd', 'product-spec-v1.json'), 'utf8')) as { status: string }).status, 'CONFIRMED')
})

test('Existing PRD Delta 必须基于最新版本并只声明受影响章节', async (t) => {
  const value = await workspaceFixture(); t.after(() => fs.rm(value.root, { recursive: true, force: true }))
  await fs.mkdir(join(value.requirement, 'prd')); await fs.writeFile(join(value.requirement, 'prd', 'prd-v5.md'), '# PRD V5\n')
  const workspace = new LocalWorkspaceService(); await workspace.scan(value.root); const tools = new EspowToolService(workspace)
  const spec = specFixture(); spec.mode = 'delta'; spec.existingPrdPath = 'prd/prd-v5.md'; spec.changedSections = ['业务规则', '验收标准']
  const context = { runId: 'delta', requirementId: 'device-connect', contextPackage: { task: '更新 PRD' } as never }
  const next = await tools.execute('product_spec_next_version', { requirementId: 'device-connect' }, context); assert.equal(next.version, 6)
  const submitted = await tools.execute('product_spec_submit', { requirementId: 'device-connect', expectedVersion: 6, resultJson: JSON.stringify(spec) }, context)
  assert.equal((submitted.productSpecResult as { markdownPath: string }).markdownPath, 'prd/prd-v6.md')
  spec.existingPrdPath = 'prd/prd-v4.md'
  await assert.rejects(() => tools.execute('product_spec_submit', { requirementId: 'device-connect', expectedVersion: 6, resultJson: JSON.stringify(spec) }, context), (error: unknown) => error instanceof EspowToolError && error.code === 'SOURCE_CHANGED')
})
