import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveWorkContext } from './workContextResolver'
import type { WorkContextSnapshot } from '../../src/workContext'

const empty: WorkContextSnapshot = {
  company: { name: '', industry: '', description: '', coreBusiness: [], regions: [], terms: [], rawContext: '', updatedAt: null },
  systems: [], relations: []
}

const configured: WorkContextSnapshot = {
  company: { name: '示例公司', industry: '金融科技', description: '', coreBusiness: ['消费金融'], regions: [], terms: [], rawContext: '', updatedAt: '2026-01-01' },
  systems: [
    { id: 'collection', name: '催收系统', alias: 'Collection', type: 'internal', positioning: '催收作业平台', coreUsers: ['催收坐席'], coreCapabilities: ['案件管理'], boundary: '', notes: '', active: true, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    { id: 'decision', name: '决策引擎', alias: 'Decision', type: 'internal', positioning: '策略决策', coreUsers: [], coreCapabilities: ['策略下发'], boundary: '', notes: '', active: true, createdAt: '2026-01-01', updatedAt: '2026-01-01' }
  ],
  relations: [{ id: 'r1', sourceSystemId: 'decision', relationType: 'PROVIDE_STRATEGY', customRelationName: '', targetSystemId: 'collection', description: '下发策略', createdAt: '2026-01-01', updatedAt: '2026-01-01' }]
}

test('zero configuration returns an empty optional context', () => {
  assert.deepEqual(resolveWorkContext(empty, null, '分析这个需求'), {
    used: false, reason: 'NOT_CONFIGURED', sources: [], primarySystemId: null, relationCount: 0
  })
})

test('configured context is skipped for an unrelated UI task', () => {
  assert.equal(resolveWorkContext(configured, 'collection', '把按钮移动到右侧').reason, 'NOT_REQUIRED')
})

test('impact analysis resolves only one-hop relations and neighbors', () => {
  const resolved = resolveWorkContext(configured, 'collection', '这个需求会影响哪些上下游系统？')
  assert.equal(resolved.reason, 'USED')
  assert.equal(resolved.relationCount, 1)
  assert.equal(resolved.currentSystem?.id, 'collection')
  assert.deepEqual(resolved.neighborSystems?.map((system) => system.id), ['decision'])
})

test('company positioning loads the structured company profile only', () => {
  const resolved = resolveWorkContext(configured, null, '这个方向是否符合公司的业务定位？')
  assert.deepEqual(resolved.sources, ['company'])
  assert.equal(resolved.company?.industry, '金融科技')
})
