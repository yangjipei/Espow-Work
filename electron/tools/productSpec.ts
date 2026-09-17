import type {
  ProductSpecAcceptanceCriterion, ProductSpecCapability, ProductSpecConflict, ProductSpecFailure, ProductSpecField,
  ProductSpecIssue, ProductSpecModel, ProductSpecPageBehavior, ProductSpecReadiness, ProductSpecRecovery,
  ProductSpecRule, ProductSpecState
} from '../../src/skills'

type Json = Record<string, unknown>

function record(value: unknown, field: string): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} 必须是对象。`)
  return value as Json
}

function text(value: Json, field: string, nullable = false): string | null {
  const item = value[field]
  if (nullable && item === null) return null
  if (typeof item !== 'string' || (!nullable && !item.trim())) throw new Error(`${field} 必须是${nullable ? '字符串或 null' : '非空字符串'}。`)
  return item
}

function bool(value: Json, field: string): boolean {
  if (typeof value[field] !== 'boolean') throw new Error(`${field} 必须是布尔值。`)
  return value[field] as boolean
}

function texts(value: Json, field: string): string[] {
  const items = value[field]
  if (!Array.isArray(items) || !items.every((item) => typeof item === 'string')) throw new Error(`${field} 必须是字符串数组。`)
  return items
}

function objects<T>(value: Json, field: string, parse: (item: Json) => T): T[] {
  const items = value[field]
  if (!Array.isArray(items)) throw new Error(`${field} 必须是数组。`)
  return items.map((item) => parse(record(item, field)))
}

function sourceStatus(value: Json, field: string, allowNa = false): 'confirmed' | 'draft' | 'not-applicable' {
  const status = text(value, field)
  if (status !== 'confirmed' && status !== 'draft' && !(allowNa && status === 'not-applicable')) throw new Error(`${field} 无效。`)
  return status
}

export function parseProductSpecJson(json: string, allowConfirmed = false): ProductSpecModel {
  const value = record(JSON.parse(json), 'Product Spec')
  const status = text(value, 'status')
  if (!['DRAFT', 'WAITING_CLARIFICATION', 'READY_FOR_CONFIRMATION', ...(allowConfirmed ? ['CONFIRMED'] : [])].includes(String(status))) throw new Error('Product Spec status 无效。')
  const mode = text(value, 'mode')
  if (mode !== 'create' && mode !== 'delta') throw new Error('mode 只能是 create 或 delta。')
  const documentInfo = record(value.documentInfo, 'documentInfo')
  const capability = (item: Json): ProductSpecCapability => ({
    id: text(item, 'id')!, name: text(item, 'name')!, purpose: text(item, 'purpose')!, trigger: text(item, 'trigger')!,
    preconditions: texts(item, 'preconditions'), userActions: texts(item, 'userActions'), systemBehavior: texts(item, 'systemBehavior'),
    businessRuleIds: texts(item, 'businessRuleIds'), stateChanges: texts(item, 'stateChanges'), successResult: text(item, 'successResult')!,
    failureResult: text(item, 'failureResult')!, exceptionHandling: texts(item, 'exceptionHandling'), relatedPageIds: texts(item, 'relatedPageIds'),
    sourceCapabilityIds: texts(item, 'sourceCapabilityIds'), sourceFlowNodeIds: texts(item, 'sourceFlowNodeIds'),
    sourceScenarioIds: texts(item, 'sourceScenarioIds'), sourceDecisionIds: texts(item, 'sourceDecisionIds')
  })
  const rule = (item: Json): ProductSpecRule => ({ id: text(item, 'id')!, description: text(item, 'description')!, trigger: text(item, 'trigger')!, condition: text(item, 'condition')!, behavior: text(item, 'behavior')!, result: text(item, 'result')!, relatedCapabilityIds: texts(item, 'relatedCapabilityIds'), sourceRefs: texts(item, 'sourceRefs') })
  const state = (item: Json): ProductSpecState => ({ id: text(item, 'id')!, name: text(item, 'name')!, meaning: text(item, 'meaning')!, entryConditions: texts(item, 'entryConditions'), exitConditions: texts(item, 'exitConditions'), subsequentBehavior: texts(item, 'subsequentBehavior'), sourceRefs: texts(item, 'sourceRefs') })
  const field = (item: Json): ProductSpecField => ({ id: text(item, 'id')!, name: text(item, 'name')!, meaning: text(item, 'meaning')!, source: text(item, 'source')!, required: bool(item, 'required'), usedAt: texts(item, 'usedAt'), format: text(item, 'format', true), defaultValue: text(item, 'defaultValue', true), allowedValues: texts(item, 'allowedValues'), updateTiming: text(item, 'updateTiming')!, emptyBehavior: text(item, 'emptyBehavior')!, sourceRefs: texts(item, 'sourceRefs') })
  const failure = (item: Json): ProductSpecFailure => ({ id: text(item, 'id')!, condition: text(item, 'condition')!, systemBehavior: text(item, 'systemBehavior')!, userFeedback: text(item, 'userFeedback')!, retry: text(item, 'retry', true), statusResult: text(item, 'statusResult')!, downstreamImpact: text(item, 'downstreamImpact')!, sourceRefs: texts(item, 'sourceRefs') })
  const recovery = (item: Json): ProductSpecRecovery => ({ id: text(item, 'id')!, trigger: text(item, 'trigger')!, mechanism: text(item, 'mechanism')!, actor: text(item, 'actor')!, limit: text(item, 'limit', true), interval: text(item, 'interval', true), exhaustedBehavior: text(item, 'exhaustedBehavior')!, result: text(item, 'result')!, sourceRefs: texts(item, 'sourceRefs') })
  const page = (item: Json): ProductSpecPageBehavior => ({ id: text(item, 'id')!, page: text(item, 'page')!, change: text(item, 'change')!, visibility: text(item, 'visibility')!, operation: text(item, 'operation')!, result: text(item, 'result')!, dataFieldIds: texts(item, 'dataFieldIds'), sourceInteractionIds: texts(item, 'sourceInteractionIds'), sourcePrototypePath: text(item, 'sourcePrototypePath', true) })
  const issue = (item: Json): ProductSpecIssue => ({ id: text(item, 'id')!, description: text(item, 'description')!, impact: text(item, 'impact')!, requiredDecision: text(item, 'requiredDecision')!, blocking: bool(item, 'blocking') })
  const conflict = (item: Json): ProductSpecConflict => { const type = text(item, 'type'); if (type !== 'Upstream Conflict' && type !== 'Consistency Issue') throw new Error('conflict.type 无效。'); return { id: text(item, 'id')!, type, sources: texts(item, 'sources'), description: text(item, 'description')!, affectedSections: texts(item, 'affectedSections'), requiredDecision: text(item, 'requiredDecision')! } }
  const ac = (item: Json): ProductSpecAcceptanceCriterion => ({ id: text(item, 'id')!, capabilityId: text(item, 'capabilityId')!, given: texts(item, 'given'), when: text(item, 'when')!, then: texts(item, 'then'), sourceRefs: texts(item, 'sourceRefs') })
  const checks = record(value.semanticChecks, 'semanticChecks')
  const interactionRequired = bool(value, 'interactionRequired')
  return {
    id: text(value, 'id')!, name: text(value, 'name')!, status: status as ProductSpecModel['status'], mode,
    documentInfo: { requirementName: text(documentInfo, 'requirementName')!, requirementDate: text(documentInfo, 'requirementDate')!, documentDate: text(documentInfo, 'documentDate')!, source: text(documentInfo, 'source')!, productManager: text(documentInfo, 'productManager')! },
    background: texts(value, 'background'), goals: texts(value, 'goals'), value: texts(value, 'value'),
    scope: { applicable: texts(record(value.scope, 'scope'), 'applicable'), included: texts(record(value.scope, 'scope'), 'included'), excluded: texts(record(value.scope, 'scope'), 'excluded') },
    rolesAndScenarios: texts(value, 'rolesAndScenarios'), businessFlowSummary: texts(value, 'businessFlowSummary'), solutionSummary: texts(value, 'solutionSummary'),
    capabilities: objects(value, 'capabilities', capability), rules: objects(value, 'rules', rule), states: objects(value, 'states', state), fields: objects(value, 'fields', field), failures: objects(value, 'failures', failure), recoveries: objects(value, 'recoveries', recovery),
    permissions: texts(value, 'permissions'), externalDependencies: texts(value, 'externalDependencies'), pageBehaviors: objects(value, 'pageBehaviors', page), openIssues: objects(value, 'openIssues', issue), conflicts: objects(value, 'conflicts', conflict), acceptanceCriteria: objects(value, 'acceptanceCriteria', ac),
    semanticChecks: { noRedesign: bool(checks, 'noRedesign'), capabilitiesImplementable: bool(checks, 'capabilitiesImplementable'), mainFlowSpecified: bool(checks, 'mainFlowSpecified'), failuresHaveResults: bool(checks, 'failuresHaveResults'), fieldSourcesComplete: bool(checks, 'fieldSourcesComplete'), statesHaveTransitions: bool(checks, 'statesHaveTransitions'), upstreamConsistent: bool(checks, 'upstreamConsistent'), prototypeConsistent: bool(checks, 'prototypeConsistent'), acceptanceTestable: bool(checks, 'acceptanceTestable') },
    sourceAnalysisPath: text(value, 'sourceAnalysisPath')!, sourceAnalysisStatus: sourceStatus(value, 'sourceAnalysisStatus') as 'confirmed' | 'draft',
    sourceFlowPath: text(value, 'sourceFlowPath')!, sourceFlowStatus: sourceStatus(value, 'sourceFlowStatus') as 'confirmed' | 'draft',
    sourceSolutionPath: text(value, 'sourceSolutionPath')!, sourceSolutionStatus: sourceStatus(value, 'sourceSolutionStatus') as 'confirmed' | 'draft',
    interactionRequired, sourceInteractionPath: text(value, 'sourceInteractionPath', true), sourceInteractionStatus: sourceStatus(value, 'sourceInteractionStatus', true),
    sourcePrototypePath: text(value, 'sourcePrototypePath', true), existingPrdPath: text(value, 'existingPrdPath', true), changedSections: texts(value, 'changedSections'), confirmedAt: text(value, 'confirmedAt', true)
  }
}

function uniqueIds(items: Array<{ id: string }>, missing: string[], label: string): void {
  if (new Set(items.map((item) => item.id)).size !== items.length) missing.push(`${label}_ids_unique`)
}

export function productSpecReadiness(spec: ProductSpecModel, sourceCapabilityIds: string[] = [], sourceFlowNodeIds: string[] = []): ProductSpecReadiness {
  const missing: string[] = []
  const warnings: string[] = []
  if (!spec.goals.length) missing.push('goals')
  if (!spec.scope.included.length || !spec.scope.excluded.length) missing.push('scope')
  if (!spec.capabilities.length) missing.push('capabilities')
  if (!spec.rules.length) missing.push('business_rules')
  if (!spec.acceptanceCriteria.length) missing.push('acceptance_criteria')
  uniqueIds(spec.capabilities, missing, 'capability'); uniqueIds(spec.rules, missing, 'rule'); uniqueIds(spec.states, missing, 'state'); uniqueIds(spec.fields, missing, 'field'); uniqueIds(spec.acceptanceCriteria, missing, 'acceptance')
  const ruleIds = new Set(spec.rules.map((item) => item.id))
  const capabilityIds = new Set(spec.capabilities.map((item) => item.id))
  if (spec.rules.some((item) => !/^BR\d+$/i.test(item.id))) missing.push('stable_rule_ids')
  if (spec.capabilities.some((item) => item.businessRuleIds.some((id) => !ruleIds.has(id)))) missing.push('capability_rule_references')
  if (spec.acceptanceCriteria.some((item) => !capabilityIds.has(item.capabilityId) || !item.then.length)) missing.push('acceptance_traceability')
  const unresolved = (value: string) => !value.trim() || /(待补充|待确认|未知|\btbd\b)/i.test(value)
  if (spec.fields.some((item) => unresolved(item.source) || unresolved(item.updateTiming) || unresolved(item.emptyBehavior))) missing.push('field_sources')
  if (spec.states.some((item) => !item.entryConditions.length || !item.exitConditions.length)) missing.push('state_transitions')
  if (spec.failures.some((item) => !item.systemBehavior.trim() || !item.statusResult.trim() || !item.downstreamImpact.trim())) missing.push('failure_results')
  if (spec.interactionRequired && (spec.sourceInteractionStatus !== 'confirmed' || !spec.sourceInteractionPath)) missing.push('confirmed_interaction')
  if (spec.interactionRequired && spec.pageBehaviors.some((item) => !item.sourceInteractionIds.length)) missing.push('page_interaction_traceability')
  if (spec.pageBehaviors.some((item) => item.sourcePrototypePath !== spec.sourcePrototypePath)) missing.push('prototype_consistency')
  if (sourceCapabilityIds.length && spec.capabilities.some((item) => item.sourceCapabilityIds.some((id) => !sourceCapabilityIds.includes(id)))) missing.push('source_capability_references')
  if (sourceFlowNodeIds.length && spec.capabilities.some((item) => item.sourceFlowNodeIds.some((id) => !sourceFlowNodeIds.includes(id)))) missing.push('source_flow_references')
  if (!spec.interactionRequired && (spec.sourceInteractionStatus !== 'not-applicable' || spec.pageBehaviors.length)) missing.push('non_ui_contract')
  if (spec.mode === 'delta' && (!spec.existingPrdPath || !spec.changedSections.length)) missing.push('delta_scope')
  if (spec.openIssues.some((item) => item.blocking)) missing.push('blocking_open_issues')
  if (spec.conflicts.length) missing.push('conflicts')
  const semanticReady = Object.values(spec.semanticChecks).every(Boolean)
  if (!semanticReady) warnings.push('semantic_checks')
  const deterministicPassed = missing.length === 0
  return { deterministicPassed, semanticReady, prdReady: deterministicPassed && semanticReady, missing: [...new Set(missing)], warnings }
}

const list = (values: string[]) => values.length ? values.map((item) => `- ${item}`).join('\n') : '—'

export function renderProductSpecMarkdown(spec: ProductSpecModel): string {
  const capabilities = spec.capabilities.map((item) => `## ${item.id} ${item.name}\n\n- 目的：${item.purpose}\n- 触发条件：${item.trigger}\n- 前置条件：${item.preconditions.join('；') || '—'}\n- 用户操作：${item.userActions.join('；') || '—'}\n- 系统行为：${item.systemBehavior.join('；') || '—'}\n- 业务规则：${item.businessRuleIds.join('、') || '—'}\n- 状态变化：${item.stateChanges.join('；') || '—'}\n- 成功结果：${item.successResult}\n- 失败结果：${item.failureResult}\n- 异常处理：${item.exceptionHandling.join('；') || '—'}\n- 相关页面：${item.relatedPageIds.join('、') || 'N/A'}\n- Traceability：${[...item.sourceScenarioIds, ...item.sourceFlowNodeIds, ...item.sourceCapabilityIds, ...item.sourceDecisionIds].join('、') || '—'}`).join('\n\n') || '—'
  const rules = spec.rules.map((item) => `- **${item.id}** ${item.description}；触发：${item.trigger}；条件：${item.condition}；处理：${item.behavior}；结果：${item.result}（来源：${item.sourceRefs.join('、') || '—'}）`).join('\n') || '—'
  const states = spec.states.map((item) => `- **${item.name}（${item.id}）**：${item.meaning}；进入：${item.entryConditions.join('；')}；退出：${item.exitConditions.join('；')}；后续：${item.subsequentBehavior.join('；') || '—'}`).join('\n') || '—'
  const fields = spec.fields.map((item) => `- **${item.name}（${item.id}）**：${item.meaning}；来源：${item.source}；${item.required ? '必填' : '非必填'}；位置：${item.usedAt.join('、') || '—'}；格式：${item.format ?? '—'}；默认值：${item.defaultValue ?? '—'}；更新时间：${item.updateTiming}；无数据：${item.emptyBehavior}`).join('\n') || '—'
  const failures = spec.failures.map((item) => `- **${item.id}** 条件：${item.condition}；系统：${item.systemBehavior}；用户反馈：${item.userFeedback}；重试：${item.retry ?? '不适用/未定义'}；状态：${item.statusResult}；后续影响：${item.downstreamImpact}`).join('\n') || '—'
  const recoveries = spec.recoveries.map((item) => `- **${item.id}** 触发：${item.trigger}；机制：${item.mechanism}；主体：${item.actor}；上限：${item.limit ?? '待补充'}；间隔：${item.interval ?? '待补充'}；达到上限：${item.exhaustedBehavior}；结果：${item.result}`).join('\n') || '—'
  const pages = spec.pageBehaviors.map((item) => `- **${item.page}（${item.id}）**：${item.change}；展示：${item.visibility}；操作：${item.operation}；结果：${item.result}；字段：${item.dataFieldIds.join('、') || '—'}；Prototype：${item.sourcePrototypePath ?? 'N/A'}`).join('\n') || 'N/A'
  const issues = spec.openIssues.map((item) => `- **${item.id}${item.blocking ? ' [Blocking]' : ''}** ${item.description}；影响：${item.impact}；需确认：${item.requiredDecision}`).join('\n') || '—'
  const conflicts = spec.conflicts.map((item) => `- **${item.id} ${item.type}** ${item.description}；来源：${item.sources.join(' ↔ ')}；影响：${item.affectedSections.join('、')}；需确认：${item.requiredDecision}`).join('\n') || '—'
  const ac = spec.acceptanceCriteria.map((item) => `- **${item.id}**（${item.capabilityId}）Given ${item.given.join('；') || '无额外前置'}；When ${item.when}；Then ${item.then.join('；')}（来源：${item.sourceRefs.join('、') || '—'}）`).join('\n') || '—'
  return `# ${spec.name}\n\n- Product Spec Status：${spec.status}\n- Mode：${spec.mode}\n- Requirement：${spec.documentInfo.requirementName}\n- Requirement Date：${spec.documentInfo.requirementDate}\n- Document Date：${spec.documentInfo.documentDate}\n- Source：${spec.documentInfo.source}\n- Product Manager：${spec.documentInfo.productManager}\n- Prototype：${spec.sourcePrototypePath ?? 'N/A'}\n\n# 业务背景\n\n${list(spec.background)}\n\n# 目标与价值\n\n## 业务目标\n\n${list(spec.goals)}\n\n## 预期价值\n\n${list(spec.value)}\n\n# 需求范围\n\n## 适用范围\n\n${list(spec.scope.applicable)}\n\n## In Scope\n\n${list(spec.scope.included)}\n\n## Out of Scope\n\n${list(spec.scope.excluded)}\n\n# 角色与场景\n\n${list(spec.rolesAndScenarios)}\n\n# 业务流程\n\n${list(spec.businessFlowSummary)}\n\n# 产品方案\n\n${list(spec.solutionSummary)}\n\n# 功能需求\n\n${capabilities}\n\n# 页面与交互\n\n${pages}\n\n# 业务规则\n\n${rules}\n\n# 状态与状态转换\n\n${states}\n\n# 数据 / 字段定义\n\n${fields}\n\n# 异常与失败处理\n\n${failures}\n\n# 补偿 / 恢复机制\n\n${recoveries}\n\n# 权限与操作边界\n\n${list(spec.permissions)}\n\n# 外部依赖\n\n${list(spec.externalDependencies)}\n\n# Open Issues\n\n${issues}\n\n# Consistency Issues\n\n${conflicts}\n\n# 验收标准\n\n${ac}\n`
}
