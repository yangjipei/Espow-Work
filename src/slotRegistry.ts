import type { LifecycleStageId } from './lifecycleStageState'

export type SlotExecutionMode = 'SCRIPT' | 'LLM_NORMALIZE' | 'LLM_REASON' | 'LLM_REVIEW'

export interface SlotDefinition {
  stageId: LifecycleStageId
  slotId: string
  label: string
  aliases: string[]
  editable: boolean
  required: boolean
  dependencies: string[]
  executionPolicy: SlotExecutionMode
}

type StageSlots = Record<LifecycleStageId, Array<Omit<SlotDefinition, 'stageId' | 'editable' | 'executionPolicy'>>>

const definitions: StageSlots = {
  'requirement-analysis': [
    { slotId: 'problem', label: '需求背景', aliases: ['问题', '现状问题', '背景'], required: true, dependencies: [] },
    { slotId: 'scenarios', label: '参与方', aliases: ['角色与场景', '业务场景', '场景'], required: true, dependencies: ['problem'] },
    { slotId: 'goals', label: '需求目标', aliases: ['目标', '业务目标'], required: false, dependencies: ['problem'] },
    { slotId: 'mainFlow', label: '主流程', aliases: ['核心流程'], required: true, dependencies: ['scenarios'] },
    { slotId: 'rules', label: '业务规则', aliases: ['规则', '异常规则'], required: true, dependencies: ['problem'] },
    { slotId: 'scope', label: '范围', aliases: ['需求范围', '非范围'], required: true, dependencies: ['goals'] },
    { slotId: 'impacts', label: '影响范围', aliases: ['影响'], required: false, dependencies: ['scope'] }
  ],
  'business-flow': [
    { slotId: 'actors', label: '流程参与方', aliases: ['参与角色'], required: true, dependencies: [] },
    { slotId: 'entry', label: '进入条件', aliases: ['入口条件', '触发条件'], required: true, dependencies: ['actors'] },
    { slotId: 'mainFlow', label: '业务主流程', aliases: ['流程步骤'], required: true, dependencies: ['entry'] },
    { slotId: 'decisionNodes', label: '判断节点', aliases: ['决策节点'], required: false, dependencies: ['mainFlow'] },
    { slotId: 'branches', label: '流程分支', aliases: ['分支'], required: false, dependencies: ['decisionNodes'] },
    { slotId: 'exits', label: '退出条件', aliases: ['结束条件', '出口条件'], required: true, dependencies: ['mainFlow'] },
    { slotId: 'failurePaths', label: '失败路径', aliases: ['异常流程', '异常路径'], required: false, dependencies: ['mainFlow'] },
    { slotId: 'systemBoundaries', label: '系统边界', aliases: ['流程边界'], required: true, dependencies: ['mainFlow'] }
  ],
  'solution-design': [
    { slotId: 'capabilities', label: '产品能力', aliases: ['能力'], required: true, dependencies: [] },
    { slotId: 'scope', label: '方案范围', aliases: [], required: true, dependencies: ['capabilities'] },
    { slotId: 'rules', label: '方案规则', aliases: [], required: true, dependencies: ['capabilities'] },
    { slotId: 'states', label: '业务状态', aliases: ['状态设计'], required: false, dependencies: ['capabilities'] },
    { slotId: 'dataObjects', label: '数据对象', aliases: ['核心数据'], required: false, dependencies: ['capabilities'] },
    { slotId: 'recoveries', label: '恢复机制', aliases: ['异常恢复'], required: true, dependencies: ['rules'] },
    { slotId: 'productSurfaces', label: '产品载体', aliases: ['产品界面'], required: true, dependencies: ['capabilities'] },
    { slotId: 'traceability', label: '需求追踪', aliases: ['追踪关系'], required: true, dependencies: ['capabilities'] }
  ],
  'interaction-design': [
    { slotId: 'surfaces', label: '交互载体', aliases: [], required: true, dependencies: [] },
    { slotId: 'pages', label: '页面', aliases: ['页面清单'], required: true, dependencies: ['surfaces'] },
    { slotId: 'components', label: '组件', aliases: ['组件清单'], required: false, dependencies: ['pages'] },
    { slotId: 'actions', label: '用户操作', aliases: ['操作'], required: true, dependencies: ['pages'] },
    { slotId: 'states', label: '页面状态', aliases: [], required: true, dependencies: ['pages'] },
    { slotId: 'transitions', label: '状态流转', aliases: ['交互流转'], required: true, dependencies: ['states'] },
    { slotId: 'feedback', label: '交互反馈', aliases: ['反馈'], required: true, dependencies: ['actions'] },
    { slotId: 'permissions', label: '交互权限', aliases: [], required: false, dependencies: ['actions'] },
    { slotId: 'exceptions', label: '交互异常', aliases: ['异常状态'], required: false, dependencies: ['actions'] },
    { slotId: 'userPaths', label: '用户路径', aliases: ['操作路径'], required: true, dependencies: ['pages'] }
  ],
  prototype: [
    { slotId: 'pages', label: '原型页面', aliases: [], required: false, dependencies: [] },
    { slotId: 'components', label: '原型组件', aliases: [], required: true, dependencies: ['pages'] },
    { slotId: 'layout', label: '页面布局', aliases: ['布局'], required: false, dependencies: ['pages'] },
    { slotId: 'interactions', label: '原型交互', aliases: [], required: true, dependencies: ['components'] },
    { slotId: 'dataBindings', label: '数据绑定', aliases: [], required: false, dependencies: ['components'] },
    { slotId: 'states', label: '原型状态', aliases: [], required: true, dependencies: ['components'] },
    { slotId: 'responsive', label: '响应式规则', aliases: [], required: false, dependencies: ['layout'] },
    { slotId: 'uiBaseline', label: 'UI 基线', aliases: ['视觉基线'], required: true, dependencies: [] }
  ],
  'product-spec': [
    { slotId: 'functionalRequirements', label: '功能需求', aliases: ['功能规格'], required: true, dependencies: [] },
    { slotId: 'businessRules', label: 'PRD 业务规则', aliases: [], required: true, dependencies: ['functionalRequirements'] },
    { slotId: 'fields', label: '字段定义', aliases: ['字段'], required: true, dependencies: ['functionalRequirements'] },
    { slotId: 'stateMachine', label: '状态机', aliases: [], required: true, dependencies: ['functionalRequirements'] },
    { slotId: 'permissions', label: '权限规则', aliases: ['权限'], required: false, dependencies: ['functionalRequirements'] },
    { slotId: 'exceptions', label: '异常处理', aliases: [], required: true, dependencies: ['functionalRequirements'] },
    { slotId: 'compatibility', label: '兼容性', aliases: [], required: false, dependencies: ['functionalRequirements'] },
    { slotId: 'dependencies', label: '外部依赖', aliases: ['依赖'], required: false, dependencies: ['functionalRequirements'] },
    { slotId: 'acceptanceCriteria', label: '验收标准', aliases: ['验收条件', 'AC'], required: true, dependencies: ['functionalRequirements'] }
  ],
  'requirement-review': [
    { slotId: 'blockers', label: '阻断问题', aliases: ['Blocker'], required: false, dependencies: [] },
    { slotId: 'ambiguities', label: '歧义问题', aliases: ['歧义'], required: false, dependencies: [] },
    { slotId: 'missingRules', label: '缺失规则', aliases: [], required: false, dependencies: [] },
    { slotId: 'technicalDependencies', label: '技术依赖', aliases: [], required: false, dependencies: [] },
    { slotId: 'dataGaps', label: '数据缺口', aliases: [], required: false, dependencies: [] },
    { slotId: 'exceptionGaps', label: '异常缺口', aliases: [], required: false, dependencies: [] },
    { slotId: 'acceptanceGaps', label: '验收缺口', aliases: [], required: false, dependencies: [] },
    { slotId: 'recommendedActions', label: '建议动作', aliases: ['整改建议'], required: false, dependencies: [] }
  ]
}

export const slotRegistry: SlotDefinition[] = Object.entries(definitions).flatMap(([stageId, slots]) => slots.map((slot) => ({
  ...slot,
  stageId: stageId as LifecycleStageId,
  editable: true,
  executionPolicy: 'SCRIPT' as const
})))

export function slotsForStage(stageId: LifecycleStageId): SlotDefinition[] {
  return slotRegistry.filter((slot) => slot.stageId === stageId)
}

export function findSlot(stageId: LifecycleStageId, slotId: string): SlotDefinition | null {
  return slotRegistry.find((slot) => slot.stageId === stageId && slot.slotId === slotId) ?? null
}
