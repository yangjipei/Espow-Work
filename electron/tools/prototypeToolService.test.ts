import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { PrototypeMetadata, PrototypeResult } from '../../src/skills'
import { LocalWorkspaceService } from '../workspaceService'
import { interactionFixture } from './interactionTestFixture'
import { EspowToolService } from './toolService'

const html = (label: string, version: number) => `<!doctype html><html><head><title>案件详情</title><meta name="espow:prototype-id" content="case-detail"><meta name="espow:prototype-version" content="${version}"><meta name="espow:source-interaction" content="interaction/interaction-design-v1.json"><meta name="espow:source-capabilities" content="CAP-01"><meta name="espow:source-flows" content="start"><style>body{font-family:sans-serif}</style></head><body><main id="app"><h1>${label}</h1><button id="call-button">Device call</button><span id="call-status">默认</span></main><script>document.getElementById('call-button').addEventListener('click',()=>{document.getElementById('call-status').textContent='创建中'})</script></body></html>`

function metadata(version: number, existingPrototypePath: string | null): PrototypeMetadata {
  return {
    id: 'case-detail', name: '案件详情', version, productSurface: 'Desktop Web', mode: existingPrototypePath ? 'delta' : 'create',
    status: 'READY_FOR_CONFIRMATION', sourceInteractionPath: 'interaction/interaction-design-v1.json', sourceInteractionStatus: 'confirmed',
    sourceSolutionPath: null, sourceCapabilityIds: ['CAP-01'], sourceFlowIds: ['start'],
    existingPrototypePath, uiReferencePaths: [], requiredDomIds: ['app', 'call-button', 'call-status'], interactiveDomIds: ['call-button'],
    addedComponents: existingPrototypePath ? ['号码状态'] : ['案件详情'], changedComponents: existingPrototypePath ? ['联系人列表'] : [],
    removedComponents: [], interactionChanges: ['Device call 可点击'], stateChanges: ['默认 → 创建中'], openQuestions: [], interactionConflicts: [],
    semanticChecks: { interactionImplemented: true, mainUserPathComplete: true, importantStatesVisible: true, actionsHaveFeedback: true, cognitiveLoadAcceptable: true, noUnconfirmedFeatures: true }, confirmedAt: null
  }
}

test('Prototype Tool 用 artifact_next_version 创建 V1、保留历史并生成真实 Delta Diff', async (t) => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'espow-prototype-tool-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'workspace', 'requirements', 'DeviceConnect')
  await fs.mkdir(join(root, 'interaction'), { recursive: true })
  await fs.writeFile(join(root, 'state.yaml'), 'requirement_id: device-connect\nname: DeviceConnect\nstatus: ACTIVE\nlifecycle_stage: prototype\n')
  await fs.writeFile(join(root, 'overview.md'), '# DeviceConnect\n')
  await fs.writeFile(join(root, 'interaction', 'interaction-design-v1.json'), `${JSON.stringify({ ...interactionFixture('CONFIRMED'), confirmedAt: new Date().toISOString() }, null, 2)}\n`)
  const workspace = new LocalWorkspaceService()
  await workspace.scan(join(directory, 'workspace'))
  const tools = new EspowToolService(workspace)
  const context = { runId: 'run-v1', requirementId: 'device-connect', contextPackage: { task: '基于确认交互生成页面原型' } } as Parameters<typeof tools.execute>[2]

  const version = await tools.execute('artifact_next_version', { requirementId: 'device-connect', newPath: 'prototype/case-detail-v1.html' }, context)
  assert.deepEqual({ path: version.targetPath, version: version.version }, { path: 'prototype/case-detail-v1.html', version: 1 })
  const meta = metadata(1, null)
  const input = { requirementId: 'device-connect', targetPath: version.targetPath, metadataJson: JSON.stringify(meta), html: html('V1', 1) }
  assert.equal((await tools.execute('prototype_ready', input, context)).ready, true)
  const submitted = await tools.execute('prototype_submit', input, context)
  const result = submitted.prototypeResult as PrototypeResult
  assert.match(result.diff, /\/dev\/null/)
  await assert.rejects(fs.access(join(root, result.htmlPath)))
  const blocked = await tools.execute('prototype_write', { requirementId: 'device-connect', prototypeRunId: 'run-v1' }, context)
  assert.equal(blocked.written, false)
  await tools.execute('prototype_write', { requirementId: 'device-connect', prototypeRunId: 'run-v1' }, { ...context, confirmedPrototype: result })
  await workspace.refreshRequirement('device-connect')
  assert.match(await fs.readFile(join(root, 'prototype', 'case-detail-v1.html'), 'utf8'), /V1/)

  const artifact = workspace.getArtifactByPath('device-connect', 'prototype/case-detail-v1.html')!
  const deltaContext = { ...context, runId: 'run-v2' }
  const next = await tools.execute('artifact_next_version', { requirementId: 'device-connect', artifactId: artifact.id }, deltaContext)
  assert.deepEqual({ path: next.targetPath, version: next.version }, { path: 'prototype/case-detail-v2.html', version: 2 })
  const deltaInput = { requirementId: 'device-connect', targetPath: next.targetPath, metadataJson: JSON.stringify(metadata(2, artifact.relativePath)), html: html('V2 联系人号码状态', 2) }
  const delta = (await tools.execute('prototype_submit', deltaInput, deltaContext)).prototypeResult as PrototypeResult
  assert.match(delta.diff, /V1/)
  assert.match(delta.diff, /V2 联系人号码状态/)
  await tools.execute('prototype_write', { requirementId: 'device-connect', prototypeRunId: 'run-v2' }, { ...deltaContext, confirmedPrototype: delta })
  assert.match(await fs.readFile(join(root, 'prototype', 'case-detail-v2.html'), 'utf8'), /号码状态/)
  assert.match(await fs.readFile(join(root, 'prototype', 'case-detail-v1.html'), 'utf8'), /V1/)
})
