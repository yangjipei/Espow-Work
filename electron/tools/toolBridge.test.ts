import assert from 'node:assert/strict'
import test from 'node:test'
import { EspowToolBridge } from './toolBridge'
import { EspowToolService } from './toolService'
import { LocalWorkspaceService } from '../workspaceService'

async function request(url: string, token: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

test('Tool Bridge 使用 Run 级 Token 并拒绝旧 Run、未知 Tool 和未授权 Tool', async (t) => {
  const bridge = new EspowToolBridge(new EspowToolService(new LocalWorkspaceService()))
  await bridge.start()
  t.after(() => bridge.close())
  const binding = bridge.activate({
    runId: 'run-current', requirementId: 'requirement-1',
    onEvent: () => undefined
  }, ['artifact_read'])
  t.after(binding.release)

  const wrongToken = await request(binding.config.url, 'wrong-token', {
    runId: 'run-current', callId: 'call-1', name: 'artifact_read', args: {}
  })
  assert.equal(wrongToken.status, 403)

  const staleRun = await request(binding.config.url, binding.config.token, {
    runId: 'run-old', callId: 'call-2', name: 'artifact_read', args: {}
  })
  assert.equal(staleRun.status, 409)
  assert.equal((staleRun.body.error as { code?: string }).code, 'RUN_MISMATCH')

  const unknownTool = await request(binding.config.url, binding.config.token, {
    runId: 'run-current', callId: 'call-3', name: 'unknown_tool', args: {}
  })
  assert.equal(unknownTool.status, 400)
  assert.equal((unknownTool.body.error as { code?: string }).code, 'INVALID_INPUT')

  const unauthorizedTool = await request(binding.config.url, binding.config.token, {
    runId: 'run-current', callId: 'call-4', name: 'workspace_read', args: {}
  })
  assert.equal(unauthorizedTool.status, 400)
  assert.equal((unauthorizedTool.body.error as { code?: string }).code, 'PERMISSION_DENIED')
})

test('Tool Bridge 每次激活生成独立凭证', async (t) => {
  const bridge = new EspowToolBridge(new EspowToolService(new LocalWorkspaceService()))
  await bridge.start()
  t.after(() => bridge.close())
  const first = bridge.activate({ runId: 'run-1', requirementId: 'requirement-1', onEvent: () => undefined }, [])
  first.release()
  const second = bridge.activate({ runId: 'run-2', requirementId: 'requirement-1', onEvent: () => undefined }, [])
  t.after(second.release)
  assert.notEqual(first.config.token, second.config.token)
  assert.equal(second.config.runId, 'run-2')
})
