import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import type { ModelStreamEvent } from '../../src/model'
import { AgentTaskService } from '../agentTaskService'
import { PersistenceService } from '../persistenceService'
import { RuntimeService } from '../runtime/runtimeService'
import { LocalWorkspaceService } from '../workspaceService'
import { EspowToolBridge } from './toolBridge'
import { EspowToolService } from './toolService'
import { SkillRegistry } from '../skills/skillRegistry'
import { ContextManager } from '../runtime/contextManager'
import { MemoryManager } from '../runtime/memoryManager'
import { LifecycleEngine } from '../runtime/lifecycleEngine'

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`缺少验收环境变量 ${name}`)
  return value
}

function waitForTerminal(register: (resolve: (event: ModelStreamEvent) => void) => void): Promise<ModelStreamEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('真实 ESPow Runtime 验收等待超时（300 秒）。')), 300_000)
    register((event) => {
      if (!['completed', 'approval_required', 'error', 'cancelled'].includes(event.type)) return
      clearTimeout(timer)
      resolve(event)
    })
  })
}

async function main(): Promise<void> {
  const directory = await fs.mkdtemp(join(tmpdir(), 'espow-acceptance-'))
    const requirementRoot = join(directory, 'workspace', 'requirements', 'DeviceConnect Voice')
    const analysisRequirementRoot = join(directory, 'workspace', 'requirements', 'Collection Contact Message')
  const runtimeRoot = join(directory, 'runtime')
  let runtime: RuntimeService | null = null
  let persistence: PersistenceService | null = null
  try {
    await fs.mkdir(join(requirementRoot, 'prd'), { recursive: true })
    await fs.mkdir(join(requirementRoot, 'flows'), { recursive: true })
    await fs.writeFile(join(requirementRoot, 'state.yaml'), 'requirement_id: device-connect-voice\nname: DeviceConnect Voice\nstatus: ACTIVE\nlifecycle_stage: prd\ncurrent_artifact: prd/device-connect-prd-v1.md\n')
    await fs.writeFile(join(requirementRoot, 'overview.md'), '# Overview\n\nDeviceConnect Voice 负责催收通话。')
    await fs.writeFile(join(requirementRoot, 'prd', 'device-connect-prd-v1.md'), '# DeviceConnect Voice PRD\n\n## 录音归档\n\n通话结束后归档录音。归档失败时进入人工排查。\n')
    await fs.writeFile(join(requirementRoot, 'flows', 'business-flow.md'), '# Business Flow\n\n用户完成通话后，系统异步归档录音；归档结果不改变通话主流程。\n')
    await fs.mkdir(join(analysisRequirementRoot, 'source'), { recursive: true })
    await fs.writeFile(join(analysisRequirementRoot, 'state.yaml'), 'requirement_id: collection-contact-message\nname: 催收联系人与客户消息\nstatus: ACTIVE\nlifecycle_stage: analysis\n')
    await fs.writeFile(join(analysisRequirementRoot, 'overview.md'), '# Overview\n\n优化催收联系人判断效率和客户消息感知。')
    await fs.writeFile(join(analysisRequirementRoot, 'source', 'business-note.md'), '# 业务方原始描述\n\n坐席需要逐个查看联系人判断有效号码；WhatsApp/RCS 客户回复容易错过。当前是否有跨案件消息入口尚未说明。\n')

    const workspaceService = new LocalWorkspaceService()
    const workspace = await workspaceService.scan(join(directory, 'workspace'))
    const toolService = new EspowToolService(workspaceService)
    const bridge = new EspowToolBridge(toolService)
    runtime = new RuntimeService(process.cwd(), bridge)
    persistence = new PersistenceService(join(directory, 'acceptance.sqlite'))
    persistence.saveWorkspace({ id: workspace.id, path: workspace.rootPath, name: workspace.name })
    const provider = requiredEnv('ESPOW_ACCEPTANCE_PROVIDER') === 'deepseek' ? 'deepseek' : 'openai'
    persistence.saveModelConfig({
      provider,
      apiKey: requiredEnv('ESPOW_ACCEPTANCE_API_KEY'),
      model: requiredEnv('ESPOW_ACCEPTANCE_MODEL'),
      baseUrl: requiredEnv('ESPOW_ACCEPTANCE_BASE_URL')
    })
    const thread = persistence.createThread(workspace.id, 'device-connect-voice', 'Tool 闭环验收')
    const memory = new MemoryManager(persistence)
    const taskService = new AgentTaskService(
      persistence, workspaceService, runtime, toolService, new SkillRegistry(join(process.cwd(), 'skills')),
      new ContextManager(workspaceService, persistence, memory), new LifecycleEngine()
    )

    let resolveEvent: ((event: ModelStreamEvent) => void) | null = null
    const sender = {
      isDestroyed: () => false,
      send: (_channel: string, event: ModelStreamEvent) => resolveEvent?.(event)
    } as unknown as WebContents
    const firstTerminal = waitForTerminal((resolve) => { resolveEvent = resolve })
    const first = await taskService.startChat(sender, {
      workspaceId: workspace.id, requirementId: 'device-connect-voice', threadId: thread.id,
      content: '找到当前 PRD，并告诉我录音归档相关规则是什么。必须使用 ESPow Tools 基于真实 Artifact 回答。'
    })
    const firstEvent = await firstTerminal
    assert.equal(firstEvent.type, 'completed')
    const firstRun = persistence.getRun(first.run.id)
    assert.equal(firstRun.context?.level, 'L1')
    assert.ok(firstRun.context?.snapshot)
    assert.equal(firstRun.tools.includes('artifact_find'), true)
    assert.equal(firstRun.tools.includes('artifact_read'), true)

    const secondTerminal = waitForTerminal((resolve) => { resolveEvent = resolve })
    const second = await taskService.startChat(sender, {
      workspaceId: workspace.id, requirementId: 'device-connect-voice', threadId: thread.id,
      content: '录音归档失败不重试不告警，这个规则补到 PRD，并检查是否影响流程图。'
    })
    const secondEvent = await secondTerminal
    assert.equal(secondEvent.type, 'approval_required')
    const waiting = persistence.getRun(second.run.id)
    assert.equal(waiting.status, 'WaitingConfirmation')
    assert.equal(waiting.skill, 'requirement-change')
    assert.equal(waiting.skillVersion, '0.1.0')
    assert.equal(waiting.context?.level, 'L1')
    assert.equal(waiting.context?.skill?.id, 'requirement-change')
    assert.ok(waiting.changeResult)
    assert.equal(waiting.readFiles.some((path) => path.includes('prd/')), true)
    assert.equal(waiting.readFiles.some((path) => path.includes('flows/')), true)
    assert.equal(waiting.tools.includes('change_result_submit'), true)
    assert.equal(waiting.tools.includes('artifact_diff'), true)
    assert.equal(waiting.context?.artifacts.some((item) => item.path.includes('prd/')), true)
    assert.equal(waiting.context?.artifacts.some((item) => item.path.includes('flows/')), true)
    await assert.rejects(fs.access(join(requirementRoot, 'prd', 'device-connect-prd-v2.md')))

    const resolved = await taskService.resolveApproval(second.run.id, true)
    assert.equal(resolved.run.status, 'Completed')
    assert.ok(['artifact_next_version', 'artifact_write', 'workspace_validate'].every((tool) => resolved.run.tools.includes(tool)))
    const writtenContent = await fs.readFile(join(requirementRoot, 'prd', 'device-connect-prd-v2.md'), 'utf8')
    assert.match(writtenContent, /不.*重试/s)
    assert.match(writtenContent, /不.*告警/s)

    const filesBeforeReject = (await fs.readdir(join(requirementRoot, 'prd'))).sort()
    const rejectionRun = persistence.startRun(
      workspace.id, 'device-connect-voice', thread.id, '拒绝候选修改验收', persistence.getActiveModelConfig()
    )
    const writtenArtifact = workspaceService.getArtifactByPath('device-connect-voice', 'prd/device-connect-prd-v2.md')
    assert.ok(writtenArtifact)
    const rejectionDiff = await toolService.execute('artifact_diff', {
      requirementId: 'device-connect-voice', artifactId: writtenArtifact.id, candidate: `${writtenContent}\n拒绝的候选内容。\n`
    }, { runId: rejectionRun.run.id, requirementId: 'device-connect-voice' })
    const rejectionApproval = rejectionDiff.approval as unknown as NonNullable<typeof rejectionRun.run.approval>
    persistence.recordToolCall(rejectionRun.run.id, {
      id: 'reject-diff', name: 'artifact_diff', status: 'Completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), error: null
    }, rejectionDiff, rejectionApproval)
    persistence.waitForApproval(rejectionRun.run.id, '候选修改等待确认。')
    const rejected = await taskService.resolveApproval(rejectionRun.run.id, false)
    assert.equal(rejected.run.status, 'Cancelled')
    assert.deepEqual((await fs.readdir(join(requirementRoot, 'prd'))).sort(), filesBeforeReject)
    assert.equal(rejected.run.tools.includes('artifact_write'), false)

    await assert.rejects(() => toolService.execute('artifact_read', {
      requirementId: 'device-connect-voice', path: '../../etc/passwd'
    }, { runId: 'safety', requirementId: 'device-connect-voice' }))

    const analysisThread = persistence.createThread(workspace.id, 'collection-contact-message', '需求分析真实验收')
    const analysisFirstTerminal = waitForTerminal((resolve) => { resolveEvent = resolve })
    const analysisFirst = await taskService.startChat(sender, {
      workspaceId: workspace.id, requirementId: 'collection-contact-message', threadId: analysisThread.id,
      content: '我想优化催收联系人和客户消息，现在坐席判断联系人效率比较低，而且 WhatsApp/RCS 回复容易错过。请基于 Source 分析；当前全局消息入口不清楚，这会影响结论，请先提出必要问题，不要直接确认完成。'
    })
    assert.equal((await analysisFirstTerminal).type, 'completed')
    const analyzing = persistence.getRun(analysisFirst.run.id)
    assert.equal(analyzing.skill, 'requirement-analysis')
    assert.equal(analyzing.context?.level, 'L2')
    assert.equal(analyzing.analysisResult?.analysisStatus, 'Analyzing')
    assert.ok(analyzing.analysisResult?.openQuestions.length)
    await assert.rejects(fs.access(join(analysisRequirementRoot, 'analysis', 'requirement-analysis.md')))

    const analysisSecondTerminal = waitForTerminal((resolve) => { resolveEvent = resolve })
    const analysisSecond = await taskService.startChat(sender, {
      workspaceId: workspace.id, requirementId: 'collection-contact-message', threadId: analysisThread.id,
      content: '补充事实：当前没有任何跨案件 WhatsApp 或 RCS 消息入口。坐席只能切回原案件才能看到回复；联系人也没有号码有效状态，只能逐个尝试。正常主流程是案件进入、查看客户、选择联系人、触达、客户回复、处理并记录。本期只分析问题，不做方案设计。'
    })
    assert.equal((await analysisSecondTerminal).type, 'approval_required')
    const analysisWaiting = persistence.getRun(analysisSecond.run.id)
    assert.equal(analysisWaiting.analysisResult?.analysisStatus, 'ReadyForConfirmation')
    assert.equal(analysisWaiting.tools.includes('requirement_analysis_ready'), true)
    assert.equal(analysisWaiting.tools.includes('requirement_analysis_submit'), true)

    const analysisConfirmedTerminal = waitForTerminal((resolve) => { resolveEvent = resolve })
    await taskService.startChat(sender, {
      workspaceId: workspace.id, requirementId: 'collection-contact-message', threadId: analysisThread.id, content: '确认'
    })
    assert.equal((await analysisConfirmedTerminal).type, 'completed')
    const analysisConfirmed = persistence.getRun(analysisSecond.run.id)
    assert.equal(analysisConfirmed.analysisResult?.analysisStatus, 'Confirmed')
    assert.deepEqual(analysisConfirmed.tools.slice(-2), ['requirement_analysis_write', 'workspace_validate'])
    assert.match(await fs.readFile(join(analysisRequirementRoot, 'analysis', 'requirement-analysis.md'), 'utf8'), /Analysis Status：confirmed/)

    const flowTerminal = waitForTerminal((resolve) => { resolveEvent = resolve })
    const flowStarted = await taskService.startChat(sender, {
      workspaceId: workspace.id, requirementId: 'collection-contact-message', threadId: analysisThread.id,
      content: '基于已经确认的 Requirement Analysis，生成“坐席发现并处理跨案件客户回复”的完整业务流程。必须明确 Actor、入口、主流程、判断分支、提前退出与恢复回流；如果关键路径事实不足就进入 WAITING_CLARIFICATION，不要自行补规则。'
    })
    const flowEvent = await flowTerminal
    const flowRun = persistence.getRun(flowStarted.run.id)
    assert.equal(flowRun.skill, 'business-flow')
    assert.ok(flowRun.flowResult)
    if (flowRun.flowResult?.flowStatus === 'READY_FOR_CONFIRMATION') {
      assert.equal(flowEvent.type, 'approval_required')
      assert.equal(flowRun.tools.includes('business_flow_ready'), true)
      assert.equal(flowRun.tools.includes('business_flow_submit'), true)
      assert.equal(flowRun.readFiles.includes('analysis/requirement-analysis.md'), true)
      const flowConfirmedTerminal = waitForTerminal((resolve) => { resolveEvent = resolve })
      await taskService.startChat(sender, {
        workspaceId: workspace.id, requirementId: 'collection-contact-message', threadId: analysisThread.id, content: '确认流程'
      })
      assert.equal((await flowConfirmedTerminal).type, 'completed')
      const confirmedFlow = persistence.getRun(flowStarted.run.id)
      assert.equal(confirmedFlow.flowResult?.flowStatus, 'CONFIRMED')
      assert.deepEqual(confirmedFlow.changedFiles, ['flows/business-flow-v1.json', 'flows/business-flow-v1.html'])
      assert.match(await fs.readFile(join(analysisRequirementRoot, 'flows', 'business-flow-v1.html'), 'utf8'), /主流程/)
    } else {
      assert.equal(flowRun.flowResult?.flowStatus, 'WAITING_CLARIFICATION')
      assert.ok(flowRun.flowResult?.flow.openQuestions.length)
    }
    process.stdout.write(JSON.stringify({
      readTools: firstRun.tools,
      diffTools: waiting.tools,
      skill: `${waiting.skill}@${waiting.skillVersion}`,
      contextLevel: waiting.context?.level,
      contextSources: waiting.context?.sources,
      checkedFlow: waiting.readFiles.find((path) => path.includes('flows/')),
      writeTools: resolved.run.tools.filter((tool) => ['artifact_next_version', 'artifact_write', 'workspace_validate'].includes(tool)),
      status: resolved.run.status,
      output: 'prd/device-connect-prd-v2.md',
      rejection: 'Cancelled without artifact_write',
      safety: 'outside path rejected',
      requirementAnalysis: {
        first: analyzing.analysisResult?.analysisStatus,
        second: analysisWaiting.analysisResult?.analysisStatus,
        final: analysisConfirmed.analysisResult?.analysisStatus,
        output: 'analysis/requirement-analysis.md'
      },
      businessFlow: {
        status: persistence.getRun(flowStarted.run.id).flowResult?.flowStatus,
        prerequisite: flowRun.flowResult?.prerequisite,
        contextLevel: flowRun.context?.level,
        output: flowRun.flowResult?.flowStatus === 'READY_FOR_CONFIRMATION' ? ['flows/business-flow-v1.json', 'flows/business-flow-v1.html'] : null
      }
    }) + '\n')
  } finally {
    await runtime?.close().catch(() => undefined)
    persistence?.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
