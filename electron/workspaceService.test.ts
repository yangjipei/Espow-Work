import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import test, { mock } from 'node:test'
import { LocalWorkspaceService } from './workspaceService'
import { RequirementService } from './requirementService'
import { PersistenceService } from './persistenceService'

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'espow-workspace-'))
  const requirements = join(root, 'requirements')
  const valid = join(requirements, '真实需求')
  await fs.mkdir(join(valid, 'prd'), { recursive: true })
  await fs.mkdir(join(valid, 'prototype', 'workdraft'), { recursive: true })
  await fs.mkdir(join(requirements, '_template'), { recursive: true })
  await fs.mkdir(join(requirements, '.hidden'), { recursive: true })
  await fs.mkdir(join(requirements, '缺失状态'), { recursive: true })
  await fs.writeFile(join(valid, 'state.yaml'), 'requirement_id: req-real\nname: 真实 Requirement\nstatus: ACTIVE\nlifecycle_stage: prd\ncurrent_artifact: prd/requirement.md\nupdated_at: 2026-09-13\n')
  await fs.writeFile(join(valid, 'overview.md'), '# Overview\n\n真实内容。')
  await fs.writeFile(join(valid, '01-decisions.md'), '# Decisions\n\n| ID | 日期 | 决策 | 原因 | 影响 | 状态 |\n|---|---|---|---|---|---|\n| D001 | 2026-09-13 | 使用真实数据 | 验收 | Desktop | CONFIRMED |\n')
  await fs.writeFile(join(valid, '02-open-issues.md'), '# Open Issues\n\n| ID | 问题 | 来源 | 影响 | Owner | 状态 |\n|---|---|---|---|---|---|\n| Q001 | 待确认问题 | 需求 | 阻塞 | 产品 | OPEN |\n')
  await fs.writeFile(join(valid, 'prd', 'requirement.md'), '# PRD\n\n真实 PRD。')
  await fs.writeFile(join(valid, 'prototype', 'screen-v1.html'), '<h1>真实 HTML</h1>')
  await fs.writeFile(join(valid, 'prototype', 'workdraft', 'draft.html'), '<h1>草稿</h1>')
  await fs.writeFile(join(requirements, '_template', 'overview.md'), '# Template')
  await fs.writeFile(join(requirements, '.DS_Store'), 'junk')
  return root
}

test('扫描真实 Requirement，并忽略模板、隐藏项和 workdraft', async (t) => {
  const root = await fixture()
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const service = new LocalWorkspaceService()
  const workspace = await service.scan(root)

  assert.equal(workspace.requirementsDirectory, 'requirements')
  assert.equal(workspace.requirements.length, 2)
  const requirement = workspace.requirements.find((item) => item.id === 'req-real')
  assert.ok(requirement)
  assert.equal(requirement.title, '真实 Requirement')
  assert.equal(requirement.stage, 'ANALYSIS')
  assert.equal(requirement.stageLabel, '需求分析')
  assert.match(requirement.overview ?? '', /真实内容/)
  assert.equal(requirement.decisions[0]?.id, 'D001')
  assert.equal(requirement.openIssues[0]?.id, 'Q001')
  assert.deepEqual(requirement.artifacts.map((item) => item.relativePath), [
    '01-decisions.md', '02-open-issues.md', 'overview.md', 'prd/requirement.md', 'prototype/screen-v1.html'
  ])

  const html = requirement.artifacts.find((item) => item.format === 'html')
  assert.ok(html)
  const content = await service.readArtifact(requirement.id, html.id)
  assert.equal(content.content, '<h1>真实 HTML</h1>')
})

test('Requirement Stage 由正式 Artifact 派生，并在上游 Delta 后标记复核与 Review Stale', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'espow-lifecycle-'))
  const requirementRoot = join(root, 'requirements', 'device-connect')
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(join(requirementRoot, 'analysis'), { recursive: true })
  await fs.mkdir(join(requirementRoot, 'flows'), { recursive: true })
  await fs.mkdir(join(requirementRoot, 'solution'), { recursive: true })
  await fs.mkdir(join(requirementRoot, 'interaction'), { recursive: true })
  await fs.mkdir(join(requirementRoot, 'prototype'), { recursive: true })
  await fs.mkdir(join(requirementRoot, 'prd'), { recursive: true })
  await fs.mkdir(join(requirementRoot, 'review'), { recursive: true })
  await fs.writeFile(join(requirementRoot, 'state.yaml'), 'requirement_id: device-connect\nname: DeviceConnect Voice\nstatus: ACTIVE\nlifecycle_stage: analysis\n')
  await fs.writeFile(join(requirementRoot, 'overview.md'), '# DeviceConnect Voice\n')
  let timestamp = Date.parse('2026-09-14T00:00:00.000Z')
  const write = async (path: string, content: string) => {
    const target = join(requirementRoot, path)
    await fs.writeFile(target, content)
    timestamp += 1_000
    const date = new Date(timestamp)
    await fs.utimes(target, date, date)
  }
  await write('analysis/requirement-analysis.md', '# Analysis\n\n- Analysis Status：confirmed\n')
  const flowV1 = `${JSON.stringify({ status: 'CONFIRMED', confirmedAt: '2026-09-14T00:00:01.000Z' }, null, 2)}\n`
  await write('flows/business-flow-v1.json', flowV1)
  await write('flows/business-flow-v1.html', '<main>Flow</main>')
  await write('solution/solution-design-v1.json', `${JSON.stringify({ status: 'CONFIRMED', confirmedAt: '2026-09-14T00:00:03.000Z' }, null, 2)}\n`)
  await write('solution/solution-design-v1.md', '# Solution\n')
  await write('interaction/interaction-design-v1.json', `${JSON.stringify({ status: 'CONFIRMED', confirmedAt: '2026-09-14T00:00:05.000Z' }, null, 2)}\n`)
  await write('interaction/interaction-design-v1.md', '# Interaction\n')
  await write('prototype/case-v1.html', '<main>Prototype</main>')
  const prdV1 = `${JSON.stringify({ status: 'CONFIRMED', interactionRequired: true, sourcePrototypePath: 'prototype/case-v1.html', confirmedAt: '2026-09-14T00:00:08.000Z' }, null, 2)}\n`
  await write('prd/product-spec-v1.json', prdV1)
  await write('prd/prd-v1.md', '# PRD\n')
  const review = {
    reviewStatus: 'CONFIRMED', conclusion: 'READY', issues: [], confirmedAt: '2026-09-14T00:00:10.000Z',
    dependencies: [
      { path: 'flows/business-flow-v1.json', hash: createHash('sha256').update(flowV1).digest('hex'), version: 1 },
      { path: 'prd/product-spec-v1.json', hash: createHash('sha256').update(prdV1).digest('hex'), version: 1 }
    ]
  }
  await write('review/requirement-review-v1.json', `${JSON.stringify(review, null, 2)}\n`)
  await write('review/requirement-review-v1.md', '# Review\n')

  const service = new LocalWorkspaceService()
  let requirement = (await service.scan(root)).requirements[0]
  assert.equal(requirement.stage, 'READY')
  assert.equal(requirement.lifecycle.status, 'READY')

  const flowV2 = `${JSON.stringify({ status: 'CONFIRMED', confirmedAt: '2026-09-14T00:00:12.000Z' }, null, 2)}\n`
  await write('flows/business-flow-v2.json', flowV2)
  await write('flows/business-flow-v2.html', '<main>Changed Flow</main>')
  requirement = await service.refreshRequirement('device-connect')
  assert.equal(requirement.stage, 'SOLUTION')
  assert.equal(requirement.lifecycle.artifacts.find((item) => item.id === 'solution')?.status, 'NEEDS_RECHECK')
  assert.equal(requirement.lifecycle.artifacts.find((item) => item.id === 'review')?.status, 'STALE')
  assert.ok(requirement.lifecycle.attention.some((item) => item.kind === 'REVIEW_STALE'))
})

test('后台 Requirement 可由 Product Spec 明确将 Interaction 与 Prototype 标记为 N/A', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'espow-backend-lifecycle-'))
  const requirementRoot = join(root, 'backend')
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(join(requirementRoot, 'analysis'), { recursive: true })
  await fs.mkdir(join(requirementRoot, 'flows'), { recursive: true })
  await fs.mkdir(join(requirementRoot, 'solution'), { recursive: true })
  await fs.mkdir(join(requirementRoot, 'prd'), { recursive: true })
  await fs.writeFile(join(requirementRoot, 'state.yaml'), 'requirement_id: backend\nname: 后台编排\nstatus: ACTIVE\n')
  await fs.writeFile(join(requirementRoot, 'overview.md'), '# 后台编排\n')
  await fs.writeFile(join(requirementRoot, 'analysis', 'requirement-analysis.md'), '- Analysis Status：confirmed\n')
  await fs.writeFile(join(requirementRoot, 'flows', 'business-flow-v1.json'), '{"status":"CONFIRMED"}\n')
  await fs.writeFile(join(requirementRoot, 'solution', 'solution-design-v1.json'), '{"status":"CONFIRMED"}\n')
  await fs.writeFile(join(requirementRoot, 'prd', 'product-spec-v1.json'), '{"status":"CONFIRMED","interactionRequired":false,"sourcePrototypePath":null}\n')

  const requirement = (await new LocalWorkspaceService().scan(root)).requirements[0]
  assert.equal(requirement.stage, 'REVIEW')
  assert.equal(requirement.lifecycle.artifacts.find((item) => item.id === 'interaction')?.status, 'NOT_APPLICABLE')
  assert.equal(requirement.lifecycle.artifacts.find((item) => item.id === 'prototype')?.status, 'NOT_APPLICABLE')
})

test('缺失文件只影响单个 Requirement，越界 Artifact 不可读取', async (t) => {
  const root = await fixture()
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const service = new LocalWorkspaceService()
  const workspace = await service.scan(join(root, 'requirements'))
  const incomplete = workspace.requirements.find((item) => item.directoryName === '缺失状态')

  assert.ok(incomplete)
  assert.equal(incomplete.error, null)
  assert.ok(incomplete.warnings.some((warning) => warning.includes('state.yaml')))
  assert.ok(incomplete.warnings.some((warning) => warning.includes('Overview')))
  const rejected = await service.readArtifact(incomplete.id, 'not-an-artifact')
  assert.match(rejected.error ?? '', /不属于当前 Workspace/)
})

test('兼容读取项目中的真实 Legacy Workspace，但不依赖手工 Artifact Index', async () => {
  const root = join(process.cwd(), 'references', 'legacy-product-manager-assistant')
  const service = new LocalWorkspaceService()
  const workspace = await service.scan(root)
  const requirement = workspace.requirements.find((item) => item.directoryName === '尼日利亚-催收-作业编排能力建设')

  assert.ok(requirement)
  assert.equal(requirement.title, '尼日利亚-催收-作业编排能力建设')
  assert.equal(requirement.decisions.length, 9)
  assert.equal(requirement.openIssues.length, 6)
  assert.ok(requirement.artifacts.some((artifact) => artifact.relativePath === 'prd/requirement.md'))
  assert.ok(requirement.artifacts.some((artifact) => artifact.relativePath === 'prototype/app-case-list-v1.html'))
  assert.ok(!requirement.artifacts.some((artifact) => artifact.relativePath.includes('workdraft/')))

  const prd = requirement.artifacts.find((artifact) => artifact.relativePath === 'prd/requirement.md')
  assert.ok(prd)
  const preview = await service.readArtifact(requirement.id, prd.id)
  assert.match(preview.content ?? '', /# 1\. 文档信息/)
})

test('新增 Requirement 初始化最小 Workspace，Scanner 可发现且同名 ID 唯一', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'espow-create-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const service = new LocalWorkspaceService()
  await service.scan(root)

  const first = await service.initializeRequirement({
    name: '多国催收 / DeviceConnect: Voice 能力',
    initialRequest: '手机分期催收希望支持通过设备发起人工呼叫。'
  })
  const second = await service.initializeRequirement({ name: '多国催收 / DeviceConnect: Voice 能力' })

  assert.match(first.requirement.id, /^REQ-\d{8}-[A-F0-9]{8}$/)
  assert.notEqual(first.requirement.id, second.requirement.id)
  assert.notEqual(first.requirement.directoryName, second.requirement.directoryName)
  assert.ok(!/[\\/:*?"<>|]/.test(first.requirement.directoryName))
  assert.equal(first.requirement.status, 'ACTIVE')
  assert.equal(first.requirement.stage, 'ANALYSIS')
  assert.equal(first.requirement.stageLabel, '需求分析')
  assert.equal(first.requirement.initialRequest, '手机分期催收希望支持通过设备发起人工呼叫。')
  assert.equal(second.requirement.initialRequest, null)
  assert.ok(first.requirement.artifacts.some((item) => item.relativePath === 'overview.md'))
  assert.ok(first.requirement.artifacts.some((item) => item.relativePath === 'source/initial-request.txt'))
  assert.deepEqual((await service.refreshCurrent()).requirements.map((item) => item.id).sort(),
    [first.requirement.id, second.requirement.id].sort())
})

test('参考资料复制到 Requirement Source Input，重名递增且不覆盖', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'espow-source-input-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspaceRoot = join(root, 'workspace')
  const inputRoot = join(root, 'inputs')
  await fs.mkdir(workspaceRoot)
  await fs.mkdir(inputRoot)
  const service = new LocalWorkspaceService()
  await service.scan(workspaceRoot)
  const created = await service.initializeRequirement({ name: '资料导入', initialRequest: '原始需求' })
  const note = join(inputRoot, '业务背景.md')
  await fs.writeFile(note, '# 背景\n\n现有流程依赖人工登记。')

  const first = await service.addSourceInputs(created.requirement.id, [note])
  const second = await service.addSourceInputs(created.requirement.id, [note])
  assert.deepEqual(first.added.map((item) => item.relativePath), ['source/业务背景.md'])
  assert.deepEqual(second.added.map((item) => item.relativePath), ['source/业务背景-2.md'])
  assert.ok(second.added.every((item) => item.kind === 'Source Input'))
  assert.equal(await fs.readFile(join(workspaceRoot, 'requirements', created.requirement.directoryName, 'source', '业务背景.md'), 'utf8'), '# 背景\n\n现有流程依赖人工登记。')
})

test('新增 Requirement 拒绝空名称，初始化中途失败不留下目录', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'espow-create-failure-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const service = new LocalWorkspaceService()
  await service.scan(root)
  await assert.rejects(() => service.initializeRequirement({ name: '   ' }), /需求名称不能为空/)

  const rename = mock.method(fs, 'rename', async () => { throw new Error('模拟提交失败') })
  await assert.rejects(() => service.initializeRequirement({ name: '不会残留' }), /模拟提交失败/)
  rename.mock.restore()
  const entries = await fs.readdir(root)
  assert.deepEqual(entries, [])
  assert.equal((await service.refreshCurrent()).requirements.length, 0)
})

test('未选择 Workspace 时不能新增 Requirement', async () => {
  const service = new LocalWorkspaceService()
  await assert.rejects(() => service.initializeRequirement({ name: '无 Workspace' }), /尚未选择 Workspace/)
})

test('requirements 不可写时返回明确错误', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'espow-create-readonly-'))
  const requirements = join(root, 'requirements')
  await fs.mkdir(requirements)
  t.after(async () => {
    await fs.chmod(requirements, 0o700).catch(() => undefined)
    await fs.rm(root, { recursive: true, force: true })
  })
  const service = new LocalWorkspaceService()
  await service.scan(root)
  await fs.chmod(requirements, 0o500)
  await assert.rejects(() => service.initializeRequirement({ name: '无写权限' }), /创建 Requirement 失败/)
  assert.deepEqual(await fs.readdir(requirements), [])
})

test('创建默认 Thread，重启后恢复 Requirement、Thread 与 Initial Request', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'espow-create-restart-'))
  const databasePath = join(root, 'app.sqlite')
  const workspaceRoot = join(root, 'workspace')
  await fs.mkdir(workspaceRoot)
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  let workspaceService = new LocalWorkspaceService()
  const initialWorkspace = await workspaceService.scan(workspaceRoot)
  let persistence = new PersistenceService(databasePath)
  persistence.saveWorkspace({ id: initialWorkspace.id, path: workspaceRoot, name: initialWorkspace.name })
  const created = await new RequirementService(workspaceService, persistence).create({ name: '重启恢复', initialRequest: '原始输入' })
  assert.equal(created.thread.title, '需求分析')
  assert.equal(persistence.listRuns(created.workspace.id).length, 0)
  assert.deepEqual(persistence.getSelection(created.workspace.id), { requirementId: created.requirement.id, threadId: created.thread.id })
  persistence.close()

  workspaceService = new LocalWorkspaceService()
  const restoredWorkspace = await workspaceService.scan(workspaceRoot)
  persistence = new PersistenceService(databasePath)
  t.after(() => persistence.close())
  const restored = restoredWorkspace.requirements.find((item) => item.id === created.requirement.id)
  assert.equal(restored?.initialRequest, '原始输入')
  assert.equal(persistence.listThreads(restoredWorkspace.id, created.requirement.id)[0]?.title, '需求分析')
})

test('默认 Thread 创建失败时回滚 Requirement', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'espow-create-thread-failure-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspaceService = new LocalWorkspaceService()
  await workspaceService.scan(root)
  const service = new RequirementService(workspaceService, {
    createThread: () => { throw new Error('模拟数据库失败') }
  })

  await assert.rejects(() => service.create({ name: '不会成为幽灵需求' }), /默认 Thread 创建失败/)
  assert.equal((await workspaceService.refreshCurrent()).requirements.length, 0)
  assert.deepEqual(await fs.readdir(root), [])
})

test('Requirement 重命名保持 ID、Thread 与数据目录内容，重复名称被拒绝', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'espow-requirement-rename-'))
  const workspaceRoot = join(root, 'workspace')
  const databasePath = join(root, 'app.sqlite')
  await fs.mkdir(workspaceRoot)
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = new LocalWorkspaceService()
  const initial = await workspace.scan(workspaceRoot)
  const persistence = new PersistenceService(databasePath)
  t.after(() => persistence.close())
  persistence.saveWorkspace({ id: initial.id, path: initial.rootPath, name: initial.name })
  const service = new RequirementService(workspace, persistence)
  const first = await service.create({ name: '旧名称', initialRequest: '保留内容' })
  await service.create({ name: '已有名称' })
  const originalDirectory = join(workspaceRoot, 'requirements', first.requirement.directoryName)

  const renamed = await service.rename(first.requirement.id, '新名称')
  assert.equal(renamed.requirement.id, first.requirement.id)
  assert.equal(renamed.requirement.title, '新名称')
  assert.equal(renamed.requirement.initialRequest, '保留内容')
  assert.equal(persistence.listThreads(renamed.workspace.id, first.requirement.id)[0]?.id, first.thread.id)
  await assert.rejects(() => fs.stat(originalDirectory))
  assert.equal((await fs.stat(join(workspaceRoot, 'requirements', renamed.requirement.directoryName))).isDirectory(), true)

  await assert.rejects(() => service.rename(first.requirement.id, '已有名称'), /已存在同名需求/)
  const unchanged = (await workspace.refreshCurrent()).requirements.find((item) => item.id === first.requirement.id)
  assert.equal(unchanged?.title, '新名称')
})

test('Requirement 数据库重命名失败时回滚名称和目录', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'espow-requirement-rename-rollback-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = new LocalWorkspaceService()
  await workspace.scan(root)
  const initialized = await workspace.initializeRequirement({ name: '原名称' })
  const service = new RequirementService(workspace, {
    createThread: () => { throw new Error('未使用') },
    renameRequirementMetadata: () => { throw new Error('模拟数据库失败') },
    deleteRequirementData: () => { throw new Error('未使用') }
  })

  await assert.rejects(() => service.rename(initialized.requirement.id, '新名称'), /数据库更新失败/)
  const restored = (await workspace.refreshCurrent()).requirements.find((item) => item.id === initialized.requirement.id)
  assert.equal(restored?.title, '原名称')
  assert.equal(restored?.directoryName, initialized.requirement.directoryName)
})

test('Requirement 目录 rename 失败时不修改名称或原目录', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'espow-requirement-rename-fs-failure-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = new LocalWorkspaceService()
  await workspace.scan(root)
  const initialized = await workspace.initializeRequirement({ name: '原名称' })
  const originalPath = join(root, 'requirements', initialized.requirement.directoryName)
  const rename = mock.method(fs, 'rename', async () => { throw new Error('模拟目录 rename 失败') })

  await assert.rejects(() => workspace.renameRequirement(initialized.requirement.id, '新名称'), /模拟目录 rename 失败/)
  rename.mock.restore()
  assert.equal((await fs.stat(originalPath)).isDirectory(), true)
  assert.equal((await workspace.refreshCurrent()).requirements[0]?.title, '原名称')
})

test('彻底删除 Requirement 目录与数据库数据，其他 Requirement 不受影响', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'espow-requirement-delete-'))
  const workspaceRoot = join(root, 'workspace')
  const databasePath = join(root, 'app.sqlite')
  await fs.mkdir(workspaceRoot)
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = new LocalWorkspaceService()
  const initial = await workspace.scan(workspaceRoot)
  const persistence = new PersistenceService(databasePath)
  t.after(() => persistence.close())
  persistence.saveWorkspace({ id: initial.id, path: initial.rootPath, name: initial.name })
  const service = new RequirementService(workspace, persistence)
  const first = await service.create({ name: '待删除' })
  const second = await service.create({ name: '保留' })
  const firstPath = join(workspaceRoot, 'requirements', first.requirement.directoryName)
  const secondPath = join(workspaceRoot, 'requirements', second.requirement.directoryName)

  const deleted = await service.delete(first.requirement.id)
  await assert.rejects(() => fs.stat(firstPath))
  assert.equal((await fs.stat(secondPath)).isDirectory(), true)
  assert.equal(deleted.workspace.requirements.some((item) => item.id === first.requirement.id), false)
  assert.equal(deleted.workspace.requirements.some((item) => item.id === second.requirement.id), true)
  assert.equal(persistence.listThreads(deleted.workspace.id, first.requirement.id).length, 0)
  assert.equal(persistence.listThreads(deleted.workspace.id, second.requirement.id).length, 1)
})

test('Requirement 路径不在 workspace/requirements 下时拒绝重命名和删除', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'espow-requirement-path-'))
  const legacyRequirement = join(root, 'legacy')
  await fs.mkdir(legacyRequirement)
  await fs.writeFile(join(legacyRequirement, 'state.yaml'), 'requirement_id: legacy\nname: Legacy\n')
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = new LocalWorkspaceService()
  await workspace.scan(root)

  await assert.rejects(() => workspace.prepareRequirementDeletion('legacy'), /requirements\//)
  await assert.rejects(() => workspace.renameRequirement('legacy', '新名称'), /requirements\//)
  assert.equal((await fs.stat(legacyRequirement)).isDirectory(), true)
})
