import type { AnalysisPatchOperation } from '../../src/analysisState'
import type { LifecycleStageId } from '../../src/lifecycleStageState'
import { findSlot, slotRegistry, type SlotExecutionMode } from '../../src/slotRegistry'

export type SlotRouteSource = 'explicit_slot_editor' | 'explicit_slot_heading' | 'deterministic_rule' | 'llm_intent_detection'

export interface SlotRoute {
  stage: LifecycleStageId
  slot: string
  action: 'UPDATE_SLOT'
  executionMode: SlotExecutionMode
  reason: string
  source: SlotRouteSource
  label: string
  values: string[]
  updates: Array<{ slotId: string; values: string[] }>
  analysisPatches: AnalysisPatchOperation[]
  patches: AnalysisPatchOperation[]
}

export interface ExplicitSlotTarget { stageId: LifecycleStageId; slotId: string }

function valuesFrom(body: string): string[] {
  return body.split(/\r?\n/).map((line) => line.trim().replace(/^(?:[-*•]|\d+[.)、])\s*/, '').trim()).filter(Boolean)
}

function analysisPatches(label: string, values: string[]): AnalysisPatchOperation[] {
  switch (label) {
    case '需求背景': return [{ op: 'replace', path: '/problem/currentProblem', value: values.join('\n'), status: 'confirmed', source: 'user' }]
    case '需求目标': return [{ op: 'replace', path: '/goals/businessGoals', value: values, status: 'confirmed', source: 'user' }]
    case '范围': return [{ op: 'replace', path: '/scope/inScope', value: values, status: 'confirmed', source: 'user' }]
    case '非范围': return [{ op: 'replace', path: '/scope/outOfScope', value: values, status: 'confirmed', source: 'user' }]
    case '异常规则': return [{ op: 'replace', path: '/flow/failureFlows', value: values, status: 'confirmed', source: 'user' }]
    case '主流程': return [{ op: 'replace', path: '/flow/mainFlow', value: values, status: 'confirmed', source: 'user' }]
    case '参与方': return values.map((actor) => ({ op: 'add', path: '/scenarios/-', value: { actor, trigger: '', painPoint: '', expectedOutcome: '', status: 'confirmed' }, status: 'confirmed', source: 'user' }))
    case '业务规则': return values.map((value) => ({ op: 'add', path: '/rules/-', value: { subject: '业务规则', condition: '用户明确指定', action: value, status: 'confirmed' }, status: 'confirmed', source: 'user' }))
    default: return []
  }
}

function candidates(label: string, stageId?: LifecycleStageId): typeof slotRegistry {
  return slotRegistry.filter((slot) => (!stageId || slot.stageId === stageId)
    && [slot.label, ...slot.aliases].some((alias) => alias.toLowerCase() === label.toLowerCase()))
}

export function routeSlotEditor(target: ExplicitSlotTarget, content: string): SlotRoute | null {
  const definition = findSlot(target.stageId, target.slotId)
  const values = valuesFrom(content)
  if (!definition?.editable || !values.length) return null
  const patches = definition.stageId === 'requirement-analysis' ? analysisPatches(definition.label, values) : []
  return {
    stage: definition.stageId, slot: definition.slotId, action: 'UPDATE_SLOT', executionMode: 'SCRIPT',
    reason: '前端已提供明确 stage/slot，不需要再次识别意图。', source: 'explicit_slot_editor',
    label: definition.label, values, updates: [{ slotId: definition.slotId, values }], analysisPatches: patches, patches
  }
}

export function routeExplicitSlotHeadings(task: string, activeStageId?: LifecycleStageId): SlotRoute | null {
  const lines = task.trim().split(/\r?\n/)
  const sections: Array<{ label: string; body: string[]; stageId: LifecycleStageId; slotId: string }> = []
  for (const line of lines) {
    const heading = line.match(/^([^：:]{1,20})[：:]\s*(.*)$/)
    if (heading) {
      const label = heading[1].trim()
      const matches = candidates(label, activeStageId)
      if (matches.length !== 1) return null
      sections.push({ label, body: heading[2].trim() ? [heading[2]] : [], stageId: matches[0].stageId, slotId: matches[0].slotId })
    } else if (sections.length) sections.at(-1)!.body.push(line)
    else return null
  }
  if (!sections.length || new Set(sections.map((section) => section.stageId)).size !== 1) return null
  const parsed = sections.map((section) => ({ ...section, values: valuesFrom(section.body.join('\n')) }))
  if (parsed.some((section) => !section.values.length)) return null
  const stage = parsed[0].stageId
  const patches = stage === 'requirement-analysis' ? parsed.flatMap((section) => analysisPatches(section.label, section.values)) : []
  return {
    stage, slot: patches.length ? patches.map((patch) => patch.path).join(',') : parsed.map((section) => section.slotId).join(','), action: 'UPDATE_SLOT', executionMode: 'SCRIPT',
    reason: '输入使用 Registry 中唯一的显式槽位标题，可确定性路由。', source: 'explicit_slot_heading',
    label: parsed.map((section) => section.label).join('、'), values: parsed.flatMap((section) => section.values),
    updates: parsed.map((section) => ({ slotId: section.slotId, values: section.values })),
    analysisPatches: patches, patches
  }
}
