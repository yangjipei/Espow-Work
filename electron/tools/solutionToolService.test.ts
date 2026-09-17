import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { BusinessFlowModel, SolutionDesignModel } from '../../src/skills'
import { LocalWorkspaceService } from '../workspaceService'
import { EspowToolError, EspowToolService } from './toolService'

async function fixture(confirmed = true) {
  const root = await fs.mkdtemp(join(tmpdir(), 'espow-solution-tools-'))
  const requirement = join(root, 'requirements', 'DeviceConnect Voice')
  await fs.mkdir(join(requirement, 'analysis'), { recursive: true })
  await fs.mkdir(join(requirement, 'flows'), { recursive: true })
  await fs.writeFile(join(requirement, 'state.yaml'), 'requirement_id: device-connect\nname: DeviceConnect Voice\nstatus: ACTIVE\nlifecycle_stage: solution\n')
  await fs.writeFile(join(requirement, 'overview.md'), '# Overview\n\nDevice call.')
  await fs.writeFile(join(requirement, 'analysis', 'requirement-analysis.md'), `# Requirement Analysis\n\n- Analysis Status：${confirmed ? 'confirmed' : 'draft'}\n`)
  const flow: BusinessFlowModel = {
    id: 'flow', name: 'Device call Flow', scope: { goal: '完成 Device call', included: ['单呼'], excluded: ['批量'] },
    status: confirmed ? 'CONFIRMED' : 'DRAFT', actors: [{ id: 'agent', name: '坐席', role: '发起通话', source: 'S001' }],
    nodes: [
      { id: 'start', type: 'start', title: '发起', description: '', actorId: 'agent', stage: '发起', stateChange: null, sourceScenarioIds: ['S001'], sourceDecisionIds: [] },
      { id: 'done', type: 'end', title: '完成', description: '', actorId: 'agent', stage: '完成', stateChange: 'COMPLETED', sourceScenarioIds: ['S001'], sourceDecisionIds: [] }
    ],
    edges: [{ id: 'e1', from: 'start', to: 'done', label: '完成', type: 'main' }], entry: 'start',
    exits: [{ nodeId: 'done', condition: '完成', recordBehavior: '记录', stateImpact: 'COMPLETED', retryable: '否' }], openQuestions: [],
    semanticChecks: { mainScenarioCovered: true, blockersHandled: true, keyExitsCovered: true, asyncRecoveryCovered: true, closedLoop: true },
    sourceAnalysisPath: 'analysis/requirement-analysis.md', sourceAnalysisStatus: confirmed ? 'confirmed' : 'draft', confirmedAt: confirmed ? new Date().toISOString() : null
  }
  await fs.writeFile(join(requirement, 'flows', 'business-flow-v1.json'), `${JSON.stringify(flow, null, 2)}\n`)
  const workspace = new LocalWorkspaceService()
  await workspace.scan(root)
  return { root, requirement, workspace, tools: new EspowToolService(workspace) }
}

function solution(status: SolutionDesignModel['status'] = 'READY_FOR_CONFIRMATION', confirmed = true): SolutionDesignModel {
  return {
    id: 'solution', name: 'DeviceConnect Voice 方案', overview: '提供发起、自动执行与结果展示能力。',
    scope: { included: ['人工单呼'], excluded: ['批量任务'] }, status,
    capabilities: [
      { id: 'CAP-01', name: 'Device call 发起', layer: 'user-facing', purpose: '允许坐席发起', actor: '坐席', trigger: '点击 Device call', execution: 'manual', input: ['case'], behavior: ['准入并创建'], output: ['orderNo'], relatedFlowNodeIds: ['start'], sourceScenarioIds: ['S001'], sourceDecisionIds: [], rules: [], exceptions: [], surfaces: ['案件详情'] },
      { id: 'CAP-02', name: '结果展示', layer: 'system', purpose: '自动记录并展示结果', actor: '系统', trigger: '结果回流', execution: 'automatic', input: ['orderNo'], behavior: ['回写结果'], output: ['call result'], relatedFlowNodeIds: ['done'], sourceScenarioIds: ['S001'], sourceDecisionIds: [], rules: [], exceptions: [], surfaces: ['案件详情'] }
    ],
    rules: [], states: [{ id: 'DONE', name: '已完成', meaning: '结果已记录', entryConditions: ['结果回流'], exitConditions: [] }],
    dataObjects: [{ id: 'CALL', name: '通话记录', purpose: '保存结果', keyFields: ['orderNo'], producedByCapabilityIds: ['CAP-01'], consumedByCapabilityIds: ['CAP-02'] }],
    recoveries: [], productSurfaces: [{ id: 'CASE', name: '案件详情', type: 'Web', purpose: '发起与查看', capabilityIds: ['CAP-01', 'CAP-02'] }],
    decisions: [], openQuestions: [], flowConflicts: [],
    semanticChecks: { goalCovered: true, scenariosCovered: true, flowNodesCovered: true, blockersResolved: true, exceptionsHandled: true, exitsCovered: true, recoveryCovered: true, noOverdesign: true },
    sourceAnalysisPath: 'analysis/requirement-analysis.md', sourceAnalysisStatus: confirmed ? 'confirmed' : 'draft',
    sourceFlowPath: 'flows/business-flow-v1.json', sourceFlowStatus: confirmed ? 'confirmed' : 'draft', confirmedAt: null
  }
}

test('Solution Tool 从双确认前置生成候选，经双 Validator 后确认写入配对 Artifact', async (t) => {
  const value = await fixture()
  t.after(() => fs.rm(value.root, { recursive: true, force: true }))
  const context = { runId: 'solution-run', requirementId: 'device-connect', contextPackage: { task: '设计产品方案' } as never }
  const version = await value.tools.execute('solution_design_next_version', { requirementId: 'device-connect' }, context)
  assert.equal(version.version, 1)
  const resultJson = JSON.stringify(solution())
  assert.equal((await value.tools.execute('solution_coverage_check', { requirementId: 'device-connect', resultJson }, context)).passed, true)
  assert.equal((await value.tools.execute('solution_overdesign_check', { requirementId: 'device-connect', resultJson }, context)).passed, true)
  const submitted = await value.tools.execute('solution_design_submit', { requirementId: 'device-connect', expectedVersion: 1, resultJson }, context)
  const result = submitted.solutionResult as unknown as import('../../src/skills').SolutionDesignResult
  assert.equal(result.solutionStatus, 'READY_FOR_CONFIRMATION')
  assert.match(result.markdownCandidate, /CAP-01 · Device call 发起/)
  const denied = await value.tools.execute('solution_design_write', { requirementId: 'device-connect', solutionRunId: 'solution-run' }, context)
  assert.equal(denied.written, false)
  const written = await value.tools.execute('solution_design_write', { requirementId: 'device-connect', solutionRunId: 'solution-run' }, { ...context, confirmedSolution: result })
  assert.deepEqual(written.paths, ['solution/solution-design-v1.json', 'solution/solution-design-v1.md'])
  assert.equal((JSON.parse(await fs.readFile(join(value.requirement, 'solution', 'solution-design-v1.json'), 'utf8')) as { status: string }).status, 'CONFIRMED')
  assert.match(await fs.readFile(join(value.requirement, 'solution', 'solution-design-v1.md'), 'utf8'), /Solution Status：confirmed/)
  assert.equal((await value.tools.execute('workspace_validate', { requirementId: 'device-connect', path: 'solution/solution-design-v1.md' }, context)).valid, true)
})

test('正式方案拒绝未确认前置；明确探索可保留 Draft', async (t) => {
  const value = await fixture(false)
  t.after(() => fs.rm(value.root, { recursive: true, force: true }))
  const resultJson = JSON.stringify(solution('DRAFT', false))
  await assert.rejects(() => value.tools.execute('solution_design_submit', {
    requirementId: 'device-connect', expectedVersion: 1, resultJson
  }, { runId: 'formal', requirementId: 'device-connect', contextPackage: { task: '设计正式产品方案' } as never }),
  (error: unknown) => error instanceof EspowToolError && error.code === 'PREREQUISITE_NOT_READY')
  const explored = await value.tools.execute('solution_design_submit', {
    requirementId: 'device-connect', expectedVersion: 1, resultJson
  }, { runId: 'draft', requirementId: 'device-connect', contextPackage: { task: '生成 Draft Solution Exploration' } as never })
  assert.equal((explored.solutionResult as { prerequisite: string }).prerequisite, 'DraftExploration')
})
