import type { LifecycleArtifactId, WorkspaceRequirement } from '../../src/workspace'

export type LifecycleSkillId = 'business-flow' | 'solution-design' | 'interaction-design' | 'prototype' | 'product-spec' | 'requirement-review'

const prerequisites: Record<LifecycleSkillId, LifecycleArtifactId[]> = {
  'business-flow': ['analysis'],
  'solution-design': ['analysis', 'business-flow'],
  'interaction-design': ['analysis', 'business-flow', 'solution'],
  prototype: ['analysis', 'business-flow', 'solution', 'interaction'],
  'product-spec': ['analysis', 'business-flow', 'solution', 'interaction', 'prototype'],
  'requirement-review': ['analysis', 'business-flow', 'solution', 'interaction', 'prototype', 'product-spec']
}

const labels: Record<LifecycleArtifactId, string> = {
  analysis: '需求分析',
  'business-flow': '业务流程',
  solution: '方案设计',
  interaction: '交互设计',
  prototype: '页面原型',
  'product-spec': 'PRD',
  review: '需求评审'
}

export class LifecycleEngine {
  isGatedSkill(id: string): id is LifecycleSkillId {
    return id in prerequisites
  }

  missingPrerequisites(requirement: WorkspaceRequirement, skillId: LifecycleSkillId): string[] {
    return prerequisites[skillId].filter((id) => {
      const status = requirement.lifecycle.artifacts.find((artifact) => artifact.id === id)?.status
      return status !== 'CONFIRMED' && status !== 'NOT_APPLICABLE'
    }).map((id) => labels[id])
  }
}
