import assert from 'node:assert/strict'
import test from 'node:test'
import type { WorkspaceRequirement } from '../../src/workspace'
import { LifecycleEngine } from './lifecycleEngine'

function requirement(statuses: Partial<Record<string, string>>): WorkspaceRequirement {
  const ids = ['analysis', 'business-flow', 'solution', 'interaction', 'prototype', 'product-spec', 'review'] as const
  return {
    id: 'req', directoryName: 'req', title: 'Requirement', status: 'ACTIVE', stage: 'ANALYSIS', stageLabel: '需求分析',
    lifecycle: {
      stage: 'ANALYSIS', stageLabel: '需求分析', status: 'IN_PROGRESS',
      artifacts: ids.map((id) => ({
        id, label: id, status: (statuses[id] ?? 'NOT_STARTED') as never,
        version: null, updatedAt: null, paths: [], conclusion: null, blockerCount: 0, warningCount: 0
      })),
      attention: [], nextAction: null
    },
    updatedAt: new Date().toISOString(), overview: null, overviewPath: null, initialRequest: null, currentArtifact: null,
    decisions: [], openIssues: [], artifacts: [], warnings: [], error: null
  } as WorkspaceRequirement
}

test('LifecycleEngine blocks a later skill until prerequisites are confirmed', () => {
  const engine = new LifecycleEngine()
  const missing = engine.missingPrerequisites(requirement({ analysis: 'CONFIRMED' }), 'prototype')
  assert.deepEqual(missing, ['业务流程', '方案设计', '交互设计'])
})

test('LifecycleEngine accepts NOT_APPLICABLE prerequisite', () => {
  const engine = new LifecycleEngine()
  const missing = engine.missingPrerequisites(requirement({
    analysis: 'CONFIRMED', 'business-flow': 'CONFIRMED', solution: 'CONFIRMED', interaction: 'NOT_APPLICABLE', prototype: 'CONFIRMED'
  }), 'product-spec')
  assert.deepEqual(missing, [])
})
