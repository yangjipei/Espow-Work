import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { BusinessFlowModel, SolutionDesignModel } from '../../src/skills'
import { LocalWorkspaceService } from '../workspaceService'
import { EspowToolError, EspowToolService } from './toolService'
import { interactionFixture } from './interactionTestFixture'

async function fixture(solutionConfirmed = true) {
  const root = await fs.mkdtemp(join(tmpdir(), 'espow-interaction-tools-'))
  const requirement = join(root, 'requirements', 'DeviceConnect Voice')
  await fs.mkdir(join(requirement, 'analysis'), { recursive: true })
  await fs.mkdir(join(requirement, 'flows'), { recursive: true })
  await fs.mkdir(join(requirement, 'solution'), { recursive: true })
  await fs.mkdir(join(requirement, 'prototype'), { recursive: true })
  await fs.writeFile(join(requirement, 'state.yaml'), 'requirement_id: device-connect\nname: DeviceConnect Voice\nstatus: ACTIVE\nlifecycle_stage: interaction\n')
  await fs.writeFile(join(requirement, 'overview.md'), '# Overview\n')
  await fs.writeFile(join(requirement, 'analysis', 'requirement-analysis.md'), '# Analysis\n\n- Analysis Status：confirmed\n')
  const flow: BusinessFlowModel = {
    id: 'flow', name: 'Flow', scope: { goal: '呼叫', included: ['单呼'], excluded: [] }, status: 'CONFIRMED',
    actors: [{ id: 'agent', name: '坐席', role: '使用者', source: 'S001' }],
    nodes: [{ id: 'start', type: 'start', title: '发起', description: '', actorId: 'agent', stage: '发起', stateChange: null, sourceScenarioIds: ['S001'], sourceDecisionIds: [] }, { id: 'done', type: 'end', title: '完成', description: '', actorId: 'agent', stage: '完成', stateChange: 'DONE', sourceScenarioIds: ['S001'], sourceDecisionIds: [] }],
    edges: [{ id: 'e', from: 'start', to: 'done', label: '完成', type: 'main' }], entry: 'start', exits: [{ nodeId: 'done', condition: '完成', recordBehavior: '记录', stateImpact: 'DONE', retryable: '否' }], openQuestions: [],
    semanticChecks: { mainScenarioCovered: true, blockersHandled: true, keyExitsCovered: true, asyncRecoveryCovered: true, closedLoop: true }, sourceAnalysisPath: 'analysis/requirement-analysis.md', sourceAnalysisStatus: 'confirmed', confirmedAt: new Date().toISOString()
  }
  await fs.writeFile(join(requirement, 'flows', 'business-flow-v1.json'), `${JSON.stringify(flow, null, 2)}\n`)
  const solution: SolutionDesignModel = {
    id: 'solution', name: 'Solution', overview: '呼叫能力', scope: { included: ['单呼'], excluded: [] }, status: solutionConfirmed ? 'CONFIRMED' : 'DRAFT',
    capabilities: [
      { id: 'CAP-01', name: '发起', layer: 'user-facing', purpose: '发起', actor: '坐席', trigger: '点击', execution: 'manual', input: ['case'], behavior: ['创建'], output: ['order'], relatedFlowNodeIds: ['start'], sourceScenarioIds: ['S001'], sourceDecisionIds: [], rules: [], exceptions: [], surfaces: ['案件详情'] },
      { id: 'CAP-02', name: '结果', layer: 'system', purpose: '展示', actor: '系统', trigger: '回流', execution: 'automatic', input: ['order'], behavior: ['回写'], output: ['result'], relatedFlowNodeIds: ['done'], sourceScenarioIds: ['S001'], sourceDecisionIds: [], rules: [], exceptions: [], surfaces: ['案件详情'] }
    ], rules: [], states: [], dataObjects: [], recoveries: [], productSurfaces: [{ id: 'CASE', name: '案件详情', type: 'App', purpose: '操作', capabilityIds: ['CAP-01', 'CAP-02'] }], decisions: [], openQuestions: [], flowConflicts: [],
    semanticChecks: { goalCovered: true, scenariosCovered: true, flowNodesCovered: true, blockersResolved: true, exceptionsHandled: true, exitsCovered: true, recoveryCovered: true, noOverdesign: true },
    sourceAnalysisPath: 'analysis/requirement-analysis.md', sourceAnalysisStatus: 'confirmed', sourceFlowPath: 'flows/business-flow-v1.json', sourceFlowStatus: 'confirmed', confirmedAt: solutionConfirmed ? new Date().toISOString() : null
  }
  await fs.writeFile(join(requirement, 'solution', 'solution-design-v1.json'), `${JSON.stringify(solution, null, 2)}\n`)
  await fs.writeFile(join(requirement, 'prototype', 'case-detail-v1.html'), '<main>Existing case detail</main>')
  const workspace = new LocalWorkspaceService()
  await workspace.scan(root)
  return { root, requirement, tools: new EspowToolService(workspace) }
}

test('Interaction Tool 从三项确认前置生成候选，确认后写入配对 Model 与 Markdown', async (t) => {
  const value = await fixture()
  t.after(() => fs.rm(value.root, { recursive: true, force: true }))
  const context = { runId: 'interaction-run', requirementId: 'device-connect', contextPackage: { task: '设计交互' } as never }
  const version = await value.tools.execute('interaction_design_next_version', { requirementId: 'device-connect' }, context)
  assert.equal(version.version, 1)
  const resultJson = JSON.stringify(interactionFixture())
  assert.equal((await value.tools.execute('interaction_design_ready', { requirementId: 'device-connect', resultJson }, context)).ready, true)
  const submitted = await value.tools.execute('interaction_design_submit', { requirementId: 'device-connect', expectedVersion: 1, resultJson }, context)
  const result = submitted.interactionResult as unknown as import('../../src/skills').InteractionDesignResult
  assert.match(result.markdownCandidate, /Interaction Rules/)
  assert.doesNotMatch(result.markdownCandidate, /<html/i)
  assert.equal((await value.tools.execute('interaction_design_write', { requirementId: 'device-connect', interactionRunId: 'interaction-run' }, context)).written, false)
  const written = await value.tools.execute('interaction_design_write', { requirementId: 'device-connect', interactionRunId: 'interaction-run' }, { ...context, confirmedInteraction: result })
  assert.deepEqual(written.paths, ['interaction/interaction-design-v1.json', 'interaction/interaction-design-v1.md'])
  assert.equal((JSON.parse(await fs.readFile(join(value.requirement, 'interaction', 'interaction-design-v1.json'), 'utf8')) as { status: string }).status, 'CONFIRMED')
  assert.match(await fs.readFile(join(value.requirement, 'interaction', 'interaction-design-v1.md'), 'utf8'), /Interaction Status：confirmed/)
})

test('正式交互拒绝未确认 Solution；明确探索只能保留 Draft', async (t) => {
  const value = await fixture(false)
  t.after(() => fs.rm(value.root, { recursive: true, force: true }))
  const model = interactionFixture('DRAFT')
  model.sourceSolutionStatus = 'draft'
  const resultJson = JSON.stringify(model)
  await assert.rejects(() => value.tools.execute('interaction_design_submit', { requirementId: 'device-connect', expectedVersion: 1, resultJson }, { runId: 'formal', requirementId: 'device-connect', contextPackage: { task: '设计正式交互' } as never }), (error: unknown) => error instanceof EspowToolError && error.code === 'PREREQUISITE_NOT_READY')
  const explored = await value.tools.execute('interaction_design_submit', { requirementId: 'device-connect', expectedVersion: 1, resultJson }, { runId: 'draft', requirementId: 'device-connect', contextPackage: { task: '生成 Draft Interaction Exploration' } as never })
  assert.equal((explored.interactionResult as { prerequisite: string }).prerequisite, 'DraftExploration')
})
