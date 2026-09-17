import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { RequirementReviewModel, ReviewIssue } from '../../src/skills'
import { LocalWorkspaceService } from '../workspaceService'
import { conclusionFor, parseRequirementReviewJson, renderRequirementReviewMarkdown, requirementReviewReadiness } from './requirementReview'
import { EspowToolError, EspowToolService } from './toolService'

function issue(severity: ReviewIssue['severity'], category: ReviewIssue['category'] = 'Rule'): ReviewIssue {
  return {
    id: `RI-${severity}`, severity, category, title: 'Query 补偿缺少停止条件',
    description: 'PRD 仅说明自动补偿，未定义次数、间隔、超时与最终状态。',
    evidence: [{ artifactPath: 'prd/product-spec-v1.json', reference: 'RC01', excerpt: 'Query 自动补偿' }],
    impact: severity === 'BLOCKER' ? '研发无法实现补偿终止条件，测试无法判断最终结果。' : '存在明确风险。',
    sourceArtifacts: ['prd/product-spec-v1.json'], recommendedStage: 'Product Spec', status: 'OPEN'
  }
}

function review(dependencies: RequirementReviewModel['dependencies'], issues: ReviewIssue[] = []): RequirementReviewModel {
  return {
    id: 'review-device-connect', name: 'DeviceConnect Voice Requirement Review', reviewStatus: 'READY_FOR_CONFIRMATION',
    conclusion: conclusionFor(issues), summary: '从产品、研发与测试视角检查当前正式 Artifact。', issues,
    coverage: [
      { dimension: 'Problem & Scope', status: 'PASS', notes: '目标与范围一致。' },
      { dimension: 'Flow Completeness', status: issues.length ? 'ISSUE' : 'PASS', notes: issues.length ? '补偿规则不完整。' : '主流程与异常闭环。' },
      { dimension: 'Acceptance', status: 'PASS', notes: '验收标准可观察。' }
    ],
    consistency: ['Analysis → Flow → Solution → PRD 主链路一致'], openIssues: [],
    recommendedActions: issues.length ? ['回到 Product Spec 补充 Query 停止条件后重新评审'] : ['进入研发评估'],
    dependencies, draftReview: false, createdAt: '2026-09-14T00:00:00.000Z', confirmedAt: null
  }
}

test('BLOCKER、WARNING 与无问题分别确定 NOT_READY、READY_WITH_WARNINGS、READY', () => {
  assert.equal(conclusionFor([issue('BLOCKER')]), 'NOT_READY')
  assert.equal(conclusionFor([issue('WARNING')]), 'READY_WITH_WARNINGS')
  assert.equal(conclusionFor([issue('INFO')]), 'READY')
  assert.equal(conclusionFor([]), 'READY')
})

test('Issue 必须有证据且结论不能绕过严重度', () => {
  const model = review([{ path: 'prd/product-spec-v1.json', hash: 'abc', version: 1 }], [issue('BLOCKER')])
  model.conclusion = 'READY'
  assert.equal(requirementReviewReadiness(model).deterministicPassed, false)
  model.conclusion = 'NOT_READY'; model.issues[0].evidence = []
  assert.ok(requirementReviewReadiness(model).missing.includes('issue_evidence'))
})

test('Prototype 冲突能形成有证据的 Consistency Issue', () => {
  const conflict = issue('BLOCKER', 'Consistency')
  conflict.title = '创建中按钮状态与 PRD 冲突'
  conflict.sourceArtifacts = ['prd/product-spec-v1.json', 'prototype/case-v1.html']
  conflict.evidence.push({ artifactPath: 'prototype/case-v1.html', reference: '#create-button', excerpt: '创建中按钮仍可点击' })
  const model = review([{ path: 'prd/product-spec-v1.json', hash: 'abc', version: 1 }, { path: 'prototype/case-v1.html', hash: 'def', version: 1 }], [conflict])
  assert.equal(requirementReviewReadiness(model).deterministicPassed, true)
  assert.match(renderRequirementReviewMarkdown(model), /Consistency/)
})

test('缺 Scope、Flow Branch、State、Field Source、Error、Timeout、Retry、Decision 与 Acceptance 均可形成阻断 Issue', () => {
  const cases: Array<[ReviewIssue['category'], string]> = [
    ['Scope', 'In Scope / Out of Scope 缺失'], ['Flow', '判断节点缺少否分支'], ['State', 'PROCESSING 状态没有退出条件'],
    ['Data', '当前执行工具字段没有数据来源'], ['Exception', 'Create 失败后业务结果未知'], ['Recovery', 'Notify 超时未定义'],
    ['Recovery', 'Query 重试次数与停止条件缺失'], ['Consistency', '两个 Decision 对关闭语义结论冲突'],
    ['Dependency', 'Blocking Open Issue 尚未关闭'], ['Acceptance', 'AC 仅描述功能正常，无法判定通过或失败']
  ]
  const issues = cases.map(([category, title], index) => ({
    ...issue('BLOCKER', category), id: `RI-${String(index + 1).padStart(2, '0')}`, title
  }))
  const model = review([{ path: 'prd/product-spec-v1.json', hash: 'abc', version: 1 }], issues)
  assert.equal(model.conclusion, 'NOT_READY')
  assert.equal(requirementReviewReadiness(model).deterministicPassed, true)
  assert.deepEqual(new Set(model.issues.map((item) => item.category)), new Set(cases.map(([category]) => category)))
})

test('非阻塞文案问题保持 INFO，完整 Requirement 可直接 READY', () => {
  const info = issue('INFO', 'Interaction'); info.title = '辅助提示文案可更清晰'; info.impact = '不影响实现与验收。'
  const dependencies = [{ path: 'prd/product-spec-v1.json', hash: 'abc', version: 1 }]
  assert.equal(review(dependencies, [info]).conclusion, 'READY')
  const ready = review(dependencies)
  assert.equal(ready.conclusion, 'READY'); assert.equal(requirementReviewReadiness(ready).deterministicPassed, true)
})

function confirmedProductSpec(): Record<string, unknown> {
  return {
    id: 'prd', name: 'PRD', status: 'CONFIRMED', mode: 'create',
    documentInfo: { requirementName: 'DeviceConnect Voice', requirementDate: '2026-09-01', documentDate: '2026-09-14', source: 'Workspace', productManager: 'PM' },
    background: [], goals: [], value: [], scope: { applicable: [], included: [], excluded: [] }, rolesAndScenarios: [], businessFlowSummary: [], solutionSummary: [],
    capabilities: [], rules: [], states: [], fields: [], failures: [], recoveries: [], permissions: [], externalDependencies: [], pageBehaviors: [], openIssues: [], conflicts: [], acceptanceCriteria: [],
    semanticChecks: { noRedesign: true, capabilitiesImplementable: true, mainFlowSpecified: true, failuresHaveResults: true, fieldSourcesComplete: true, statesHaveTransitions: true, upstreamConsistent: true, prototypeConsistent: true, acceptanceTestable: true },
    sourceAnalysisPath: 'analysis/requirement-analysis.md', sourceAnalysisStatus: 'confirmed', sourceFlowPath: 'flows/business-flow-v1.json', sourceFlowStatus: 'confirmed', sourceSolutionPath: 'solution/solution-design-v1.json', sourceSolutionStatus: 'confirmed', interactionRequired: false, sourceInteractionPath: null, sourceInteractionStatus: 'not-applicable', sourcePrototypePath: null, existingPrdPath: null, changedSections: [], confirmedAt: '2026-09-14T00:00:00.000Z'
  }
}

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'espow-review-'))
  const requirement = join(root, 'requirements', 'DeviceConnect Voice')
  for (const directory of ['analysis', 'flows', 'solution', 'prd', 'review']) await fs.mkdir(join(requirement, directory), { recursive: true })
  await fs.writeFile(join(requirement, 'state.yaml'), 'requirement_id: device-connect\nname: DeviceConnect Voice\nstatus: ACTIVE\nlifecycle_stage: review\n')
  await fs.writeFile(join(requirement, 'overview.md'), '# DeviceConnect Voice\n')
  await fs.writeFile(join(requirement, 'analysis', 'requirement-analysis.md'), '# Analysis\n\nAnalysis Status: confirmed\n')
  await fs.writeFile(join(requirement, 'flows', 'business-flow-v1.json'), '{"status":"CONFIRMED"}\n')
  await fs.writeFile(join(requirement, 'solution', 'solution-design-v1.json'), '{"status":"CONFIRMED"}\n')
  await fs.writeFile(join(requirement, 'prd', 'product-spec-v1.json'), `${JSON.stringify(confirmedProductSpec(), null, 2)}\n`)
  await fs.writeFile(join(requirement, 'prd', 'prd-v1.md'), '# PRD\n\nQuery 自动补偿。\n')
  const workspace = new LocalWorkspaceService(); await workspace.scan(root)
  return { root, requirement, workspace, tools: new EspowToolService(workspace) }
}

test('正式 Review 生成、确认写入，并在 PRD Delta 后变为 STALE', async (t) => {
  const value = await fixture(); t.after(() => fs.rm(value.root, { recursive: true, force: true }))
  const context = { runId: 'review-run', requirementId: 'device-connect', contextPackage: { task: '正式需求评审' } as never }
  const next = await value.tools.execute('requirement_review_next_version', { requirementId: 'device-connect' }, context)
  const model = review(next.dependencies as RequirementReviewModel['dependencies'], [issue('BLOCKER')])
  assert.equal((await value.tools.execute('requirement_review_ready', { requirementId: 'device-connect', resultJson: JSON.stringify(model) }, context)).conclusion, 'NOT_READY')
  const submitted = await value.tools.execute('requirement_review_submit', { requirementId: 'device-connect', expectedVersion: 1, resultJson: JSON.stringify(model) }, context)
  const result = submitted.requirementReviewResult as import('../../src/skills').RequirementReviewResult
  assert.equal(result.blockerCount, 1)
  assert.equal((await value.tools.execute('requirement_review_write', { requirementId: 'device-connect', reviewRunId: 'review-run' }, context)).written, false)
  await value.tools.execute('requirement_review_write', { requirementId: 'device-connect', reviewRunId: 'review-run' }, { ...context, confirmedRequirementReview: result })
  const current = await value.tools.execute('requirement_review_status', { requirementId: 'device-connect', reviewPath: 'review/requirement-review-v1.json' }, context)
  assert.equal(current.status, 'CURRENT')
  await fs.writeFile(join(value.requirement, 'prd', 'prd-v1.md'), '# PRD\n\nQuery 最多补偿 3 次。\n')
  const stale = await value.tools.execute('requirement_review_status', { requirementId: 'device-connect', reviewPath: 'review/requirement-review-v1.json' }, context)
  assert.equal(stale.status, 'STALE'); assert.equal(stale.conclusion, null)
})

test('未确认 PRD 不允许正式 Review，但允许明确 Draft Review', async (t) => {
  const value = await fixture(); t.after(() => fs.rm(value.root, { recursive: true, force: true }))
  const path = join(value.requirement, 'prd', 'product-spec-v1.json')
  const spec = confirmedProductSpec(); spec.status = 'DRAFT'; await fs.writeFile(path, `${JSON.stringify(spec)}\n`)
  await assert.rejects(() => value.tools.execute('requirement_review_next_version', { requirementId: 'device-connect' }, { runId: 'r', requirementId: 'device-connect', contextPackage: { task: '正式需求评审' } as never }), (error: unknown) => error instanceof EspowToolError && error.code === 'PREREQUISITE_NOT_READY')
  const draft = await value.tools.execute('requirement_review_next_version', { requirementId: 'device-connect' }, { runId: 'r', requirementId: 'device-connect', contextPackage: { task: '提前评审 Draft PRD' } as never })
  assert.equal(draft.draftReview, true)
})

test('Review JSON parser 拒绝无效严重度', () => {
  const model = review([{ path: 'prd/product-spec-v1.json', hash: 'abc', version: 1 }], [issue('INFO')]) as unknown as Record<string, unknown>
  ;((model.issues as Array<Record<string, unknown>>)[0]).severity = 'CRITICAL'
  assert.throws(() => parseRequirementReviewJson(JSON.stringify(model)), /severity/)
})
