import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrototypeMetadata } from '../../src/skills'
import { parsePrototypeMetadata, prototypeReadiness } from './prototype'

function metadata(overrides: Partial<PrototypeMetadata> = {}): PrototypeMetadata {
  return {
    id: 'case-detail', name: '案件详情', version: 2, productSurface: 'Desktop Web', mode: 'delta',
    status: 'READY_FOR_CONFIRMATION', sourceInteractionPath: 'interaction/interaction-design-v1.json',
    sourceInteractionStatus: 'confirmed', sourceSolutionPath: 'solution/solution-design-v1.json',
    sourceCapabilityIds: ['CAP-01'], sourceFlowIds: ['FLOW-01'], existingPrototypePath: 'prototype/case-detail-v1.html',
    uiReferencePaths: [], requiredDomIds: ['app', 'call-button', 'call-status'], interactiveDomIds: ['call-button'],
    addedComponents: ['号码状态'], changedComponents: ['联系人列表'], removedComponents: [],
    interactionChanges: ['Device call 状态可演示'], stateChanges: ['默认 → 创建中 → 通话中 → 完成'],
    openQuestions: [], interactionConflicts: [],
    semanticChecks: { interactionImplemented: true, mainUserPathComplete: true, importantStatesVisible: true, actionsHaveFeedback: true, cognitiveLoadAcceptable: true, noUnconfirmedFeatures: true },
    confirmedAt: null, ...overrides
  }
}

const html = `<!doctype html><html><head><title>案件详情</title><meta name="espow:prototype-id" content="case-detail"><meta name="espow:prototype-version" content="2"><meta name="espow:source-interaction" content="interaction/interaction-design-v1.json"><meta name="espow:source-capabilities" content="CAP-01"><meta name="espow:source-flows" content="FLOW-01"><style>body{font-family:sans-serif}</style></head><body><main id="app"><button id="call-button">Device call</button><span id="call-status">默认</span></main><script>document.getElementById('call-button').addEventListener('click',()=>{document.getElementById('call-status').textContent='创建中'})</script></body></html>`

test('Prototype Validator 接受自包含 HTML、关键 DOM、真实交互与正确版本', () => {
  const value = metadata()
  assert.deepEqual(parsePrototypeMetadata(JSON.stringify(value)), value)
  const ready = prototypeReadiness(value, html, 'prototype/case-detail-v2.html')
  assert.equal(ready.deterministicPassed, true)
  assert.equal(ready.semanticReady, true)
})

test('Prototype Validator 拒绝缺失交互、外部依赖、脚本错误与 Interaction Conflict', () => {
  const value = metadata({ interactionConflicts: ['消息中心改为强制弹窗'] })
  const invalid = '<html><head><title>x</title><script src="https://example.com/app.js"></script></head><body><main id="app"><button id="call-button">call</button><span id="call-status"></span><script>const =</script></main></body></html>'
  const ready = prototypeReadiness(value, invalid, 'prototype/case-detail-v3.html')
  assert.equal(ready.deterministicPassed, false)
  assert.ok(ready.missing.includes('doctype_missing'))
  assert.ok(ready.missing.includes('external_core_resource'))
  assert.ok(ready.missing.includes('javascript_syntax_error'))
  assert.ok(ready.missing.includes('interaction_binding_missing:call-button'))
  assert.ok(ready.missing.includes('target_version_mismatch'))
  assert.ok(ready.missing.includes('interaction_conflicts'))
})
