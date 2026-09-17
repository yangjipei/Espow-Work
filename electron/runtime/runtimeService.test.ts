import assert from 'node:assert/strict'
import test from 'node:test'
import { ESPOW_SYSTEM_PROMPT, RuntimeService, toolSpecs } from './runtimeService'
import { LocalWorkspaceService } from '../workspaceService'
import { EspowToolService } from '../tools/toolService'
import { EspowToolBridge } from '../tools/toolBridge'

test('RuntimeService 暴露 ESPow 自有 Runtime 状态，未启动时不依赖模型 Provider Session', async () => {
  const workspace = new LocalWorkspaceService()
  const toolService = new EspowToolService(workspace)
  const bridge = new EspowToolBridge(toolService)
  const service = new RuntimeService(process.cwd(), bridge)
  assert.equal(service.getStatus().runtimeType, 'espow-runtime')
  assert.equal(service.getStatus().status, 'stopped')
  assert.equal(service.getStatus().activeRunId, null)
  await service.close()
})

test('Runtime 系统提示要求 Agent 的首句和过程回复默认使用简体中文', () => {
  assert.match(ESPOW_SYSTEM_PROMPT, /默认使用简体中文回复/)
  assert.match(ESPOW_SYSTEM_PROMPT, /开场语、过程说明、工具调用前后的说明/)
  assert.match(ESPOW_SYSTEM_PROMPT, /只有当用户在当前任务中明确要求其他语言/)
})

test('Requirement Analysis Tool 向模型暴露嵌套对象与布尔语义字段', () => {
  const tool = toolSpecs(['requirement_analysis_ready'])[0]
  const properties = tool.parameters.properties as Record<string, Record<string, unknown>>
  const resultJson = properties.resultJson
  const resultProperties = resultJson.properties as Record<string, Record<string, unknown>>
  assert.equal(resultJson.type, 'object')
  assert.equal(resultProperties.semanticReady.type, 'boolean')
  assert.deepEqual(tool.parameters.required, ['requirementId', 'resultJson'])
  assert.ok((resultJson.required as string[]).includes('semanticReady'))
  assert.equal('fieldRequired' in resultJson, false)
})

test('Requirement Change Tool 向模型暴露完整结果约束', () => {
  const tool = toolSpecs(['change_result_submit'])[0]
  const properties = tool.parameters.properties as Record<string, Record<string, unknown>>
  const resultJson = properties.resultJson
  const resultProperties = resultJson.properties as Record<string, Record<string, unknown>>
  assert.equal(resultJson.type, 'object')
  assert.deepEqual(resultProperties.status.enum, ['Assessed', 'ClarificationRequired', 'DecisionConflict'])
  assert.deepEqual(resultProperties.validationResult.type, ['string', 'null'])
  assert.deepEqual(tool.parameters.required, ['requirementId', 'resultJson'])
  assert.ok((resultJson.required as string[]).includes('validationResult'))
  assert.equal('fieldRequired' in resultJson, false)
})

test('Tool Registry 将 terminal 语义投影到 Runtime Tool Spec', () => {
  const specs = toolSpecs(['analysis_turn_submit', 'artifact_read'])
  assert.equal(specs.find((tool) => tool.name === 'analysis_turn_submit')?.terminal, true)
  assert.equal(specs.find((tool) => tool.name === 'artifact_read')?.terminal, false)
})
