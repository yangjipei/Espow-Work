import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type {
  DeliveredQuestion, DesktopSelection, DesktopWorkspace, MessageRecord, RunEventRecord, RunRecord, RunStatus, ThreadRecord
} from '../src/persistence'
import type { ModelConfigDraft, ModelProviderId, ModelSettings, PublicModelConfig } from '../src/model'
import type { StoredModelConfig } from './modelProvider'
import type { RuntimeEventType, RuntimeType } from '../src/runtime'
import type { ToolCallRecord, WriteApprovalRequest } from '../src/tools'
import type { BusinessFlowResult, ChangeResult, InteractionDesignResult, ProductSpecResult, PrototypeResult, RequirementAnalysisResult, RequirementReviewResult, SkillSelection, SolutionDesignResult } from '../src/skills'
import type { RequirementSnapshot, RunContextMetadata } from '../src/context'
import type {
  ExecutionPath, ExecutionTraceStep, FollowupDecisionSummary, ModelCallReason, ObservedContextMode,
  ObservedSkillMode, RuntimeDistributionItem, RuntimeObservabilitySummary, TokenBreakdownItem, TokenStageId,
  TokenStageSummary, TokenUsageCall, TokenUsageSummary, TokenUsageTurn, TokenUsageWorkspace
} from '../src/tokenUsage'
import type { MemoryItem, MemoryScope, ThreadMemorySnapshot } from '../src/memory'
import type { AnalysisState } from '../src/analysisState'
import type { LifecycleStageId, LifecycleStageState, SharedRequirementState } from '../src/lifecycleStageState'
import { relationTypeLabels, type SaveRelationInput, type SaveSystemInput, type WorkContextCompany, type WorkContextSnapshot, type WorkContextSystem, type WorkContextSystemRelation } from '../src/workContext'
import { addDiagnosticBreadcrumb, reportDiagnosticError } from './diagnostics/diagnosticBridge'
import { canBeginCancellation, canResolveApproval, isRunWritable } from './runtime/runStateMachine'

type SqlValue = string | number | bigint | null

interface Row { [key: string]: SqlValue }

const tokenStages: Array<{ id: TokenStageId; label: string }> = [
  { id: 'requirement-analysis', label: '需求分析' },
  { id: 'business-flow', label: '业务流程' },
  { id: 'solution-design', label: '方案设计' },
  { id: 'interaction-design', label: '页面流程' },
  { id: 'prototype', label: 'HTML 原型' },
  { id: 'product-spec', label: 'PRD' },
  { id: 'requirement-review', label: '需求评审' },
  { id: 'requirement-change', label: 'Delta 修改' },
  { id: 'other', label: '其他' }
]

function tokenStage(skill: string | null): { id: TokenStageId; label: string } {
  return tokenStages.find((stage) => stage.id === skill) ?? tokenStages[tokenStages.length - 1]
}

function rowTokenUsage(row: Row): TokenUsageCall {
  const stage = tokenStage(row.stage === null ? null : String(row.stage))
  return {
    id: String(row.id), workspaceId: String(row.workspace_id),
    conversationId: row.conversation_id === null ? null : String(row.conversation_id),
    runId: row.run_id === null ? null : String(row.run_id),
    originalRunId: row.original_run_id === null || row.original_run_id === undefined ? (row.run_id === null ? null : String(row.run_id)) : String(row.original_run_id),
    turnId: row.turn_id === null || row.turn_id === undefined ? null : String(row.turn_id),
    stage: stage.id, stageLabel: stage.label,
    executionContent: String(row.execution_content),
    stepIndex: row.step_index === null || row.step_index === undefined ? null : Number(row.step_index),
    callId: row.call_id === null || row.call_id === undefined ? null : String(row.call_id),
    callIndex: Number(row.call_index ?? row.step_index ?? 1), routeType: String(row.route_type ?? 'llm') === 'script' ? 'script' : 'llm',
    callReason: String(row.call_reason ?? 'other') as ModelCallReason,
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    usageSource: 'provider_reported', breakdownType: 'estimated_breakdown',
    estimatedInputTokens: Number(row.estimated_input_tokens ?? 0),
    historyTokens: Number(row.history_tokens ?? 0),
    historyGrowth: null,
    inputBreakdown: parseTokenBreakdown(row.input_breakdown),
    messageCount: Number(row.message_count ?? 0), toolCount: Number(row.tool_count ?? 0),
    systemPromptChars: Number(row.system_prompt_chars ?? 0), contextPackageChars: Number(row.context_package_chars ?? 0),
    toolSchemaChars: Number(row.tool_schema_chars ?? 0), assistantHistoryChars: Number(row.assistant_history_chars ?? 0),
    toolResultChars: Number(row.tool_result_chars ?? 0), analysisProjectionChars: Number(row.analysis_projection_chars ?? 0),
    recentConversationChars: Number(row.recent_conversation_chars ?? 0), fullAnalysisStateChars: Number(row.full_analysis_state_chars ?? 0),
    provider: String(row.provider) as ModelProviderId, model: String(row.model),
    inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens),
    totalTokens: Number(row.total_tokens), createdAt: String(row.created_at)
  }
}

function parseTokenBreakdown(value: SqlValue | undefined): TokenBreakdownItem[] {
  if (typeof value !== 'string' || !value) return []
  try {
    const parsed = JSON.parse(value) as TokenBreakdownItem[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function parseObject(value: SqlValue | undefined): Record<string, unknown> {
  if (typeof value !== 'string' || !value) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : []
}

function distribution(values: string[], order: string[]): RuntimeDistributionItem[] {
  const total = values.length
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...new Set([...order, ...counts.keys()])]
    .map((key) => ({ key, count: counts.get(key) ?? 0, percentage: total ? (counts.get(key) ?? 0) / total * 100 : 0 }))
}

function isoNow(): string {
  return new Date().toISOString()
}

const emptyCompany: WorkContextCompany = {
  name: '', industry: '', description: '', coreBusiness: [], regions: [], terms: [], rawContext: '', updatedAt: null
}

function jsonArray<T>(value: SqlValue, fallback: T[] = []): T[] {
  if (typeof value !== 'string') return fallback
  try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed as T[] : fallback } catch { return fallback }
}

function rowWorkContextSystem(row: Row): WorkContextSystem {
  return {
    id: String(row.id), name: String(row.name), alias: String(row.alias),
    type: String(row.type) === 'external' ? 'external' : 'internal', positioning: String(row.positioning),
    coreUsers: jsonArray<string>(row.core_users), coreCapabilities: jsonArray<string>(row.core_capabilities),
    boundary: String(row.boundary), notes: String(row.notes), active: Number(row.active) === 1,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  }
}

function rowWorkContextRelation(row: Row): WorkContextSystemRelation {
  return {
    id: String(row.id), sourceSystemId: String(row.source_system_id),
    relationType: String(row.relation_type) as WorkContextSystemRelation['relationType'],
    customRelationName: String(row.custom_relation_name), targetSystemId: String(row.target_system_id),
    description: String(row.description), createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  }
}

function memorySearchTerms(value: string): string[] {
  const normalized = value.toLowerCase().trim()
  const terms = new Set(normalized.split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length >= 2 && term.length <= 32))
  const chineseRuns = normalized.match(/[\p{Script=Han}]{2,}/gu) ?? []
  for (const run of chineseRuns) {
    const chars = [...run]
    for (const size of [2, 3]) {
      for (let index = 0; index <= chars.length - size; index += 1) terms.add(chars.slice(index, index + size).join(''))
    }
  }
  return [...terms].slice(0, 48)
}

function stringArray(value: SqlValue): string[] {
  if (typeof value !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : []
  } catch {
    return []
  }
}

function toolCallArray(value: SqlValue): ToolCallRecord[] {
  if (typeof value !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed as ToolCallRecord[] : []
  } catch {
    return []
  }
}

function approvalValue(value: SqlValue): WriteApprovalRequest | null {
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as WriteApprovalRequest : null
  } catch {
    return null
  }
}

function changeResultValue(value: SqlValue): ChangeResult | null {
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as ChangeResult : null
  } catch {
    return null
  }
}

function analysisResultValue(value: SqlValue): RequirementAnalysisResult | null {
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as RequirementAnalysisResult : null
  } catch {
    return null
  }
}

function flowResultValue(value: SqlValue): BusinessFlowResult | null {
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as BusinessFlowResult : null
  } catch {
    return null
  }
}

function solutionResultValue(value: SqlValue): SolutionDesignResult | null {
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as SolutionDesignResult : null
  } catch {
    return null
  }
}

function interactionResultValue(value: SqlValue): InteractionDesignResult | null {
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as InteractionDesignResult : null
  } catch {
    return null
  }
}

function prototypeResultValue(value: SqlValue): PrototypeResult | null {
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as PrototypeResult : null
  } catch { return null }
}

function productSpecResultValue(value: SqlValue): ProductSpecResult | null {
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as ProductSpecResult : null
  } catch { return null }
}

function requirementReviewResultValue(value: SqlValue): RequirementReviewResult | null {
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as RequirementReviewResult : null
  } catch { return null }
}

function contextMetadataValue(value: SqlValue): RunContextMetadata | null {
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as RunContextMetadata : null
  } catch {
    return null
  }
}


function rowMemoryItem(row: Row): MemoryItem {
  return {
    id: String(row.id),
    scope: String(row.scope) as MemoryScope,
    workspaceId: row.workspace_id === null ? null : String(row.workspace_id),
    requirementId: row.requirement_id === null ? null : String(row.requirement_id),
    threadId: row.thread_id === null ? null : String(row.thread_id),
    category: String(row.category),
    content: String(row.content),
    importance: Number(row.importance),
    source: String(row.source),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function analysisStateValue(value: SqlValue): AnalysisState | null {
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as AnalysisState : null
  } catch {
    return null
  }
}


function lifecycleStageStateValue(value: SqlValue): LifecycleStageState | null {
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as LifecycleStageState : null
  } catch { return null }
}

function sharedRequirementStateValue(value: SqlValue): SharedRequirementState | null {
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as SharedRequirementState : null
  } catch { return null }
}

function rowThread(row: Row): ThreadRecord {
  return {
    id: String(row.id), workspaceId: String(row.workspace_id), requirementId: String(row.requirement_id),
    title: String(row.title), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }
}

function rowMessage(row: Row): MessageRecord {
  let questions: DeliveredQuestion[] = []
  if (typeof row.questions_json === 'string') {
    try {
      const parsed = JSON.parse(row.questions_json) as unknown
      if (Array.isArray(parsed)) questions = parsed.filter((item): item is DeliveredQuestion => Boolean(
        item && typeof item === 'object' && typeof (item as DeliveredQuestion).id === 'string'
        && typeof (item as DeliveredQuestion).content === 'string' && typeof (item as DeliveredQuestion).blocking === 'boolean'
      ))
    } catch { questions = [] }
  }
  return {
    id: String(row.id), threadId: String(row.thread_id), role: String(row.role) as MessageRecord['role'],
    content: String(row.content), questions, createdAt: String(row.created_at)
  }
}

function rowRun(row: Row): RunRecord {
  return {
    id: String(row.id), workspaceId: String(row.workspace_id), requirementId: String(row.requirement_id),
    threadId: String(row.thread_id), threadTitle: row.thread_title === null || row.thread_title === undefined ? null : String(row.thread_title),
    task: String(row.task), status: String(row.status) as RunStatus,
    skill: row.skill === null ? null : String(row.skill),
    skillVersion: row.skill_version === null || row.skill_version === undefined ? null : String(row.skill_version),
    changeResult: changeResultValue(row.change_result), analysisResult: analysisResultValue(row.analysis_result),
    flowResult: flowResultValue(row.flow_result), solutionResult: solutionResultValue(row.solution_result),
    interactionResult: interactionResultValue(row.interaction_result), prototypeResult: prototypeResultValue(row.prototype_result),
    productSpecResult: productSpecResultValue(row.product_spec_result), requirementReviewResult: requirementReviewResultValue(row.requirement_review_result), tools: stringArray(row.tools),
    readFiles: stringArray(row.read_files), changedFiles: stringArray(row.changed_files),
    startedAt: String(row.started_at), finishedAt: row.finished_at === null ? null : String(row.finished_at),
    error: row.error === null ? null : String(row.error),
    provider: row.provider === null || row.provider === undefined ? null : String(row.provider) as ModelProviderId,
    model: row.model === null || row.model === undefined ? null : String(row.model),
    turnId: row.turn_id === null || row.turn_id === undefined ? null : String(row.turn_id),
    runtimeType: row.runtime_type === null || row.runtime_type === undefined ? null : String(row.runtime_type) as RuntimeType,
    runtimeEvents: stringArray(row.runtime_event_summary) as RuntimeEventType[],
    toolCalls: toolCallArray(row.tool_calls),
    approval: approvalValue(row.approval_request),
    context: contextMetadataValue(row.context_metadata)
  }
}


const defaultConfigs: Record<ModelProviderId, Omit<StoredModelConfig, 'apiKey'>> = {
  openai: { provider: 'openai', model: 'gpt-5-mini', baseUrl: 'https://api.openai.com/v1' },
  deepseek: { provider: 'deepseek', model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com' }
}

function publicConfig(config: StoredModelConfig): PublicModelConfig {
  return {
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    apiKeyConfigured: Boolean(config.apiKey),
    apiKeyPreview: config.apiKey ? `••••••••${config.apiKey.slice(-4)}` : null
  }
}

export class PersistenceService {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')
    this.migrate()
    this.recoverInterruptedRuns()
    console.info('[persistence] SQLite initialized')
    addDiagnosticBreadcrumb({ layer: 'persistence', action: 'database_open', status: 'success' })
  }

  isOpen(): boolean { return this.db.isOpen }

  close(): void {
    if (!this.db.isOpen) {
      console.warn('[persistence] SQLite close skipped: database is already closed')
      return
    }
    this.db.close()
    console.info('[persistence] SQLite closed')
  }

  getWorkContext(): WorkContextSnapshot {
    const companyRow = this.db.prepare('SELECT * FROM work_context_company WHERE id = 1').get() as Row | undefined
    const company = companyRow ? {
      name: String(companyRow.name), industry: String(companyRow.industry), description: String(companyRow.description),
      coreBusiness: jsonArray<string>(companyRow.core_business), regions: jsonArray<string>(companyRow.regions),
      terms: jsonArray<WorkContextCompany['terms'][number]>(companyRow.terms), rawContext: String(companyRow.raw_context),
      updatedAt: String(companyRow.updated_at)
    } : emptyCompany
    const systems = (this.db.prepare('SELECT * FROM work_context_systems ORDER BY active DESC, updated_at DESC').all() as Row[]).map(rowWorkContextSystem)
    const relations = (this.db.prepare('SELECT * FROM work_context_relations ORDER BY updated_at DESC').all() as Row[]).map(rowWorkContextRelation)
    return { company, systems, relations }
  }

  saveWorkContextCompany(company: Omit<WorkContextCompany, 'updatedAt'>): WorkContextSnapshot {
    const now = isoNow()
    this.db.prepare(`INSERT INTO work_context_company (id, name, industry, description, core_business, regions, terms, raw_context, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, industry=excluded.industry, description=excluded.description,
      core_business=excluded.core_business, regions=excluded.regions, terms=excluded.terms, raw_context=excluded.raw_context, updated_at=excluded.updated_at`)
      .run(company.name.trim(), company.industry.trim(), company.description.trim(), JSON.stringify(company.coreBusiness),
        JSON.stringify(company.regions), JSON.stringify(company.terms), company.rawContext.trim(), now)
    return this.getWorkContext()
  }

  saveWorkContextSystem(input: SaveSystemInput): WorkContextSnapshot {
    const name = input.name.trim()
    if (!name) throw new Error('系统名称不能为空。')
    const id = input.id?.trim() || `system-${randomUUID()}`
    const existing = this.db.prepare('SELECT created_at FROM work_context_systems WHERE id = ?').get(id) as Row | undefined
    const now = isoNow()
    this.db.prepare(`INSERT INTO work_context_systems
      (id, name, alias, type, positioning, core_users, core_capabilities, boundary, notes, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, alias=excluded.alias, type=excluded.type, positioning=excluded.positioning,
      core_users=excluded.core_users, core_capabilities=excluded.core_capabilities, boundary=excluded.boundary,
      notes=excluded.notes, active=excluded.active, updated_at=excluded.updated_at`)
      .run(id, name, input.alias.trim(), input.type, input.positioning.trim(), JSON.stringify(input.coreUsers),
        JSON.stringify(input.coreCapabilities), input.boundary.trim(), input.notes.trim(), input.active ? 1 : 0,
        existing ? String(existing.created_at) : now, now)
    return this.getWorkContext()
  }

  setWorkContextSystemActive(systemId: string, active: boolean): WorkContextSnapshot {
    const result = this.db.prepare('UPDATE work_context_systems SET active = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, isoNow(), systemId)
    if (!result.changes) throw new Error('系统不存在。')
    return this.getWorkContext()
  }

  deleteWorkContextSystem(systemId: string): WorkContextSnapshot {
    const relations = Number((this.db.prepare('SELECT COUNT(*) AS count FROM work_context_relations WHERE source_system_id = ? OR target_system_id = ?').get(systemId, systemId) as Row).count)
    const workspaces = Number((this.db.prepare('SELECT COUNT(*) AS count FROM requirement_system_bindings WHERE system_id = ?').get(systemId) as Row).count)
    if (relations || workspaces) throw new Error(`系统正在被 ${workspaces} 个 Workspace 和 ${relations} 条系统关系使用，无法直接删除，请先停用或解除引用。`)
    this.db.prepare('DELETE FROM work_context_systems WHERE id = ?').run(systemId)
    return this.getWorkContext()
  }

  saveWorkContextRelation(input: SaveRelationInput): WorkContextSnapshot {
    if (input.sourceSystemId === input.targetSystemId) throw new Error('来源系统与目标系统不能相同。')
    if (!(input.relationType in relationTypeLabels)) throw new Error('关系类型无效。')
    if (input.relationType === 'OTHER' && !input.customRelationName.trim()) throw new Error('“其他”关系必须填写自定义名称。')
    const source = this.db.prepare('SELECT id FROM work_context_systems WHERE id = ?').get(input.sourceSystemId)
    const target = this.db.prepare('SELECT id FROM work_context_systems WHERE id = ?').get(input.targetSystemId)
    if (!source || !target) throw new Error('来源系统或目标系统不存在。')
    const id = input.id?.trim() || `relation-${randomUUID()}`
    const existing = this.db.prepare('SELECT created_at FROM work_context_relations WHERE id = ?').get(id) as Row | undefined
    const now = isoNow()
    this.db.prepare(`INSERT INTO work_context_relations
      (id, source_system_id, relation_type, custom_relation_name, target_system_id, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET source_system_id=excluded.source_system_id, relation_type=excluded.relation_type,
      custom_relation_name=excluded.custom_relation_name, target_system_id=excluded.target_system_id,
      description=excluded.description, updated_at=excluded.updated_at`)
      .run(id, input.sourceSystemId, input.relationType, input.customRelationName.trim(), input.targetSystemId,
        input.description.trim(), existing ? String(existing.created_at) : now, now)
    return this.getWorkContext()
  }

  deleteWorkContextRelation(relationId: string): WorkContextSnapshot {
    this.db.prepare('DELETE FROM work_context_relations WHERE id = ?').run(relationId)
    return this.getWorkContext()
  }

  syncRequirementSystemBinding(workspaceId: string, requirementId: string, systemId: string | null): void {
    if (!systemId) {
      this.db.prepare('DELETE FROM requirement_system_bindings WHERE workspace_id = ? AND requirement_id = ?').run(workspaceId, requirementId)
      return
    }
    if (!this.db.prepare('SELECT id FROM work_context_systems WHERE id = ?').get(systemId)) throw new Error('绑定的产品 / 系统不存在。')
    this.db.prepare(`INSERT INTO requirement_system_bindings (workspace_id, requirement_id, system_id, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_id, requirement_id) DO UPDATE SET system_id=excluded.system_id, updated_at=excluded.updated_at`)
      .run(workspaceId, requirementId, systemId, isoNow())
  }

  saveWorkspace(workspace: { id: string; path: string; name: string }): DesktopWorkspace {
    const lastOpenedAt = isoNow()
    this.db.prepare(`INSERT INTO workspaces (id, path, name, last_opened_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET path = excluded.path, name = excluded.name, last_opened_at = excluded.last_opened_at`)
      .run(workspace.id, workspace.path, workspace.name, lastOpenedAt)
    this.setState('recent_workspace_id', workspace.id)
    return { ...workspace, lastOpenedAt }
  }

  getRecentWorkspace(): DesktopWorkspace | null {
    const id = this.getState('recent_workspace_id')
    if (!id) return null
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Row | undefined
    return row ? { id: String(row.id), path: String(row.path), name: String(row.name), lastOpenedAt: String(row.last_opened_at) } : null
  }

  getSelection(workspaceId: string): DesktopSelection {
    const requirementId = this.getState(`workspace:${workspaceId}:active-requirement`)
    return {
      requirementId,
      threadId: requirementId ? this.getState(`workspace:${workspaceId}:requirement:${requirementId}:active-thread`) : null
    }
  }

  setActiveRequirement(workspaceId: string, requirementId: string): void {
    this.setState(`workspace:${workspaceId}:active-requirement`, requirementId)
  }

  setActiveThread(workspaceId: string, requirementId: string, threadId: string): void {
    this.setActiveRequirement(workspaceId, requirementId)
    this.setState(`workspace:${workspaceId}:requirement:${requirementId}:active-thread`, threadId)
  }

  renameRequirementMetadata(workspaceId: string, requirementId: string, name: string): void {
    this.transaction(() => {
      const row = this.db.prepare('SELECT snapshot FROM requirement_snapshots WHERE workspace_id = ? AND requirement_id = ?')
        .get(workspaceId, requirementId) as Row | undefined
      if (!row || typeof row.snapshot !== 'string') return
      const snapshot = JSON.parse(row.snapshot) as Record<string, unknown>
      snapshot.name = name
      this.db.prepare('UPDATE requirement_snapshots SET snapshot = ? WHERE workspace_id = ? AND requirement_id = ?')
        .run(JSON.stringify(snapshot), workspaceId, requirementId)
    })
  }

  deleteRequirementData(workspaceId: string, requirementId: string, deleteDirectory: () => void): void {
    this.transaction(() => {
      const threadIds = (this.db.prepare('SELECT id FROM threads WHERE workspace_id = ? AND requirement_id = ?')
        .all(workspaceId, requirementId) as Row[]).map((row) => String(row.id))
      const runIds = (this.db.prepare('SELECT id FROM runs WHERE workspace_id = ? AND requirement_id = ?')
        .all(workspaceId, requirementId) as Row[]).map((row) => String(row.id))
      if (runIds.length || threadIds.length) {
        const runPlaceholders = runIds.map(() => '?').join(', ')
        const threadPlaceholders = threadIds.map(() => '?').join(', ')
        const clauses: string[] = []
        const values: string[] = []
        if (runIds.length) {
          clauses.push(`run_id IN (${runPlaceholders})`, `original_run_id IN (${runPlaceholders})`)
          values.push(...runIds, ...runIds)
        }
        if (threadIds.length) {
          clauses.push(`conversation_id IN (${threadPlaceholders})`)
          values.push(...threadIds)
        }
        this.db.prepare(`DELETE FROM token_usage_calls WHERE ${clauses.join(' OR ')}`).run(...values)
      }
      this.db.prepare('DELETE FROM lifecycle_stage_state_events WHERE requirement_id = ?').run(requirementId)
      this.db.prepare('DELETE FROM lifecycle_stage_states WHERE workspace_id = ? AND requirement_id = ?').run(workspaceId, requirementId)
      this.db.prepare('DELETE FROM shared_requirement_states WHERE workspace_id = ? AND requirement_id = ?').run(workspaceId, requirementId)
      this.db.prepare('DELETE FROM analysis_state_events WHERE requirement_id = ?').run(requirementId)
      this.db.prepare('DELETE FROM analysis_mainlines WHERE workspace_id = ? AND requirement_id = ?').run(workspaceId, requirementId)
      this.db.prepare('DELETE FROM analysis_states WHERE workspace_id = ? AND requirement_id = ?').run(workspaceId, requirementId)
      this.db.prepare('DELETE FROM requirement_snapshots WHERE workspace_id = ? AND requirement_id = ?').run(workspaceId, requirementId)
      this.db.prepare('DELETE FROM requirement_system_bindings WHERE workspace_id = ? AND requirement_id = ?').run(workspaceId, requirementId)
      if (threadIds.length) {
        const placeholders = threadIds.map(() => '?').join(', ')
        this.db.prepare(`DELETE FROM memory_items WHERE (workspace_id = ? AND requirement_id = ?) OR thread_id IN (${placeholders})`)
          .run(workspaceId, requirementId, ...threadIds)
      } else {
        this.db.prepare('DELETE FROM memory_items WHERE workspace_id = ? AND requirement_id = ?').run(workspaceId, requirementId)
      }
      this.db.prepare('DELETE FROM runs WHERE workspace_id = ? AND requirement_id = ?').run(workspaceId, requirementId)
      this.db.prepare('DELETE FROM threads WHERE workspace_id = ? AND requirement_id = ?').run(workspaceId, requirementId)
      this.db.prepare('DELETE FROM app_state WHERE (key = ? AND value = ?) OR key LIKE ?')
        .run(`workspace:${workspaceId}:active-requirement`, requirementId, `workspace:${workspaceId}:requirement:${requirementId}:%`)
      deleteDirectory()
    })
  }

  listThreads(workspaceId: string, requirementId: string): ThreadRecord[] {
    return (this.db.prepare('SELECT * FROM threads WHERE workspace_id = ? AND requirement_id = ? ORDER BY updated_at DESC')
      .all(workspaceId, requirementId) as Row[]).map(rowThread)
  }

  createThread(workspaceId: string, requirementId: string, title: string): ThreadRecord {
    const normalizedTitle = title.trim()
    if (!normalizedTitle) throw new Error('Thread 标题不能为空。')
    const now = isoNow()
    const thread: ThreadRecord = { id: randomUUID(), workspaceId, requirementId, title: normalizedTitle, createdAt: now, updatedAt: now }
    this.transaction(() => {
      this.db.prepare('INSERT INTO threads (id, workspace_id, requirement_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(thread.id, thread.workspaceId, thread.requirementId, thread.title, thread.createdAt, thread.updatedAt)
      this.setActiveThread(workspaceId, requirementId, thread.id)
    })
    return thread
  }

  renameThread(threadId: string, title: string): ThreadRecord {
    const normalizedTitle = title.trim()
    if (!normalizedTitle) throw new Error('Thread 标题不能为空。')
    this.db.prepare('UPDATE threads SET title = ?, updated_at = ? WHERE id = ?').run(normalizedTitle, isoNow(), threadId)
    return this.requireThread(threadId)
  }

  deleteThread(threadId: string): void {
    const thread = this.requireThread(threadId)
    this.db.prepare('DELETE FROM threads WHERE id = ?').run(threadId)
    const activeKey = `workspace:${thread.workspaceId}:requirement:${thread.requirementId}:active-thread`
    if (this.getState(activeKey) === threadId) this.deleteState(activeKey)
  }

  listMessages(threadId: string): MessageRecord[] {
    return (this.db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at, rowid').all(threadId) as Row[]).map(rowMessage)
  }

  appendUserMessage(workspaceId: string, requirementId: string, threadId: string, content: string): MessageRecord {
    const thread = this.requireThread(threadId)
    if (thread.workspaceId !== workspaceId || thread.requirementId !== requirementId) throw new Error('Thread 不属于当前 Requirement。')
    const normalizedContent = content.trim()
    if (!normalizedContent) throw new Error('补充需求内容不能为空。')
    const now = isoNow()
    const message: MessageRecord = { id: randomUUID(), threadId, role: 'user', content: normalizedContent, questions: [], createdAt: now }
    this.transaction(() => {
      this.insertMessage(message)
      this.touchThread(threadId, now)
    })
    return message
  }

  truncateThreadFromUserMessage(threadId: string, messageId: string): void {
    const thread = this.requireThread(threadId)
    const target = this.db.prepare('SELECT rowid, role FROM messages WHERE id = ? AND thread_id = ?')
      .get(messageId, threadId) as Row | undefined
    if (!target || target.role !== 'user') throw new Error('要编辑的用户消息不存在。')
    const messageRowId = Number(target.rowid)
    const turnRows = this.db.prepare(`SELECT id FROM turns WHERE thread_id = ? AND rowid >= COALESCE(
      (SELECT rowid FROM turns WHERE user_message_id = ?),
      (SELECT MIN(rowid) FROM turns WHERE thread_id = ? AND created_at >= (SELECT created_at FROM messages WHERE id = ?))
    )`).all(threadId, messageId, threadId, messageId) as Row[]
    const turnIds = turnRows.map((row) => String(row.id))
    const runIds = turnIds.length
      ? (this.db.prepare(`SELECT id FROM runs WHERE turn_id IN (${turnIds.map(() => '?').join(', ')})`).all(...turnIds) as Row[]).map((row) => String(row.id))
      : []
    this.transaction(() => {
      if (runIds.length) {
        const runPlaceholders = runIds.map(() => '?').join(', ')
        this.db.prepare(`DELETE FROM analysis_state_events WHERE run_id IN (${runPlaceholders})`).run(...runIds)
      }
      if (turnIds.length) {
        const placeholders = turnIds.map(() => '?').join(', ')
        this.db.prepare(`DELETE FROM runs WHERE turn_id IN (${placeholders})`).run(...turnIds)
        this.db.prepare(`DELETE FROM turns WHERE id IN (${placeholders})`).run(...turnIds)
      }
      this.db.prepare('DELETE FROM messages WHERE thread_id = ? AND rowid >= ?').run(threadId, messageRowId)
      this.db.prepare('DELETE FROM thread_memory WHERE thread_id = ?').run(threadId)
      const latestState = this.db.prepare(`SELECT state_json FROM analysis_state_events
        WHERE thread_id = ? AND state_json IS NOT NULL ORDER BY rowid DESC LIMIT 1`).get(threadId) as Row | undefined
      if (latestState && typeof latestState.state_json === 'string') {
        const restored = analysisStateValue(latestState.state_json)
        if (restored) {
          this.db.prepare(`INSERT INTO analysis_states
            (workspace_id, requirement_id, thread_id, state_json, version, source, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(requirement_id, thread_id) DO UPDATE SET
            workspace_id = excluded.workspace_id, state_json = excluded.state_json, version = excluded.version,
            source = excluded.source, updated_at = excluded.updated_at`)
            .run(restored.workspaceId, restored.requirementId, restored.threadId, JSON.stringify(restored), restored.version, restored.source, restored.updatedAt)
        } else {
          this.db.prepare('DELETE FROM analysis_states WHERE thread_id = ?').run(threadId)
        }
      } else {
        this.db.prepare('DELETE FROM analysis_states WHERE thread_id = ?').run(threadId)
      }
      const latestRequirementState = this.db.prepare(`SELECT state_json FROM analysis_state_events
        WHERE requirement_id = ? AND state_json IS NOT NULL ORDER BY rowid DESC LIMIT 1`).get(thread.requirementId) as Row | undefined
      const restoredMainline = latestRequirementState ? analysisStateValue(latestRequirementState.state_json) : null
      if (restoredMainline) {
        this.db.prepare(`INSERT INTO analysis_mainlines
          (workspace_id, requirement_id, last_thread_id, state_json, version, source, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(requirement_id) DO UPDATE SET workspace_id=excluded.workspace_id, last_thread_id=excluded.last_thread_id,
          state_json=excluded.state_json, version=excluded.version, source=excluded.source, updated_at=excluded.updated_at`)
          .run(restoredMainline.workspaceId, restoredMainline.requirementId, restoredMainline.threadId, JSON.stringify(restoredMainline), restoredMainline.version, restoredMainline.source, restoredMainline.updatedAt)
      } else {
        this.db.prepare('DELETE FROM analysis_mainlines WHERE requirement_id = ?').run(thread.requirementId)
      }
    })
  }

  getRequirementSnapshot(workspaceId: string, requirementId: string): RequirementSnapshot | null {
    const row = this.db.prepare('SELECT snapshot FROM requirement_snapshots WHERE workspace_id = ? AND requirement_id = ?')
      .get(workspaceId, requirementId) as Row | undefined
    if (!row || typeof row.snapshot !== 'string') return null
    try {
      const parsed: unknown = JSON.parse(row.snapshot)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as RequirementSnapshot : null
    } catch {
      return null
    }
  }

  saveRequirementSnapshot(workspaceId: string, snapshot: RequirementSnapshot): void {
    this.db.prepare(`INSERT INTO requirement_snapshots (workspace_id, requirement_id, snapshot, refreshed_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id, requirement_id) DO UPDATE SET
      snapshot = excluded.snapshot, refreshed_at = excluded.refreshed_at`)
      .run(workspaceId, snapshot.requirementId, JSON.stringify(snapshot), snapshot.refreshedAt)
  }

  getModelSettings(): ModelSettings {
    const active = this.getState('active-model-provider')
    const activeProvider: ModelProviderId = active === 'deepseek' ? 'deepseek' : 'openai'
    return {
      activeProvider,
      configs: {
        openai: publicConfig(this.readModelConfig('openai')),
        deepseek: publicConfig(this.readModelConfig('deepseek'))
      }
    }
  }

  saveModelConfig(draft: ModelConfigDraft): ModelSettings {
    const config = this.resolveModelConfig(draft)
    this.setState(`model-config:${draft.provider}`, JSON.stringify(config))
    this.setState('active-model-provider', draft.provider)
    return this.getModelSettings()
  }

  getActiveModelConfig(): StoredModelConfig {
    const provider = this.getModelSettings().activeProvider
    return this.requireCompleteModelConfig(this.readModelConfig(provider))
  }

  resolveModelConfig(draft: ModelConfigDraft): StoredModelConfig {
    const saved = this.readModelConfig(draft.provider)
    return this.requireCompleteModelConfig({
      provider: draft.provider,
      apiKey: draft.apiKey.trim() || saved.apiKey,
      model: draft.model.trim(),
      baseUrl: draft.baseUrl.trim()
    })
  }

  startRun(
    workspaceId: string,
    requirementId: string,
    threadId: string,
    task: string,
    config: StoredModelConfig | null,
    runtime?: { type: RuntimeType; events?: RuntimeEventType[] },
    skill?: SkillSelection | null,
    context?: RunContextMetadata | null
  ): { message: MessageRecord; run: RunRecord } {
    const thread = this.requireThread(threadId)
    if (thread.workspaceId !== workspaceId || thread.requirementId !== requirementId) throw new Error('Thread 不属于当前 Requirement。')
    const normalizedTask = task.trim()
    if (!normalizedTask) throw new Error('消息内容不能为空。')
    const now = isoNow()
    const message: MessageRecord = { id: randomUUID(), threadId, role: 'user', content: normalizedTask, questions: [], createdAt: now }
    const turnId = randomUUID()
    const run: RunRecord = {
      id: randomUUID(), workspaceId, requirementId, threadId, threadTitle: thread.title, task: normalizedTask, status: 'Running',
      skill: skill?.id ?? null, skillVersion: skill?.version ?? null, changeResult: null, analysisResult: null, flowResult: null, solutionResult: null, interactionResult: null, prototypeResult: null, productSpecResult: null, requirementReviewResult: null,
      tools: [], readFiles: [], changedFiles: [],
      startedAt: now, finishedAt: null, error: null, provider: config?.provider ?? null, model: config?.model ?? null,
      turnId, runtimeType: runtime?.type ?? null, runtimeEvents: runtime?.events ?? [],
      toolCalls: [], approval: null, context: context ?? null
    }
    this.transaction(() => {
      this.insertMessage(message)
      this.db.prepare('INSERT INTO turns (id, thread_id, user_message_id, created_at) VALUES (?, ?, ?, ?)').run(turnId, threadId, message.id, now)
      this.db.prepare(`INSERT INTO runs
        (id, workspace_id, requirement_id, thread_id, task, status, skill, skill_version, change_result, analysis_result, flow_result, solution_result, interaction_result, prototype_result, product_spec_result, requirement_review_result, tools, read_files, changed_files, started_at, finished_at, error, provider, model, runtime_type, runtime_event_summary, tool_calls, approval_request, context_metadata, turn_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` )
        .run(run.id, run.workspaceId, run.requirementId, run.threadId, run.task, run.status, run.skill,
          run.skillVersion, null, null, null, null, null, null, null, null, JSON.stringify(run.tools), JSON.stringify(run.readFiles), JSON.stringify(run.changedFiles), run.startedAt, null, null, run.provider, run.model,
          run.runtimeType, JSON.stringify(run.runtimeEvents), JSON.stringify(run.toolCalls), null,
          run.context ? JSON.stringify(run.context) : null, run.turnId)
      this.touchThread(threadId, now)
    })
    return { message, run }
  }

  completeRun(runId: string, content: string, questions: DeliveredQuestion[] = []): { message: MessageRecord; run: RunRecord } {
    const run = this.requireRun(runId)
    if (run.status !== 'Running') throw new Error(`Run 当前状态为 ${run.status}，无法完成。`)
    const now = isoNow()
    const message: MessageRecord = {
      id: randomUUID(), threadId: run.threadId, role: 'assistant',
      content, questions,
      createdAt: now
    }
    this.transaction(() => {
      this.insertMessage(message)
      this.db.prepare("UPDATE runs SET status = 'Completed', finished_at = ? WHERE id = ?").run(now, runId)
      this.touchThread(run.threadId, now)
    })
    return { message, run: this.requireRun(runId) }
  }

  waitForApproval(runId: string, content: string): { message: MessageRecord; run: RunRecord } {
    const run = this.requireRun(runId)
    if (run.status !== 'Running' || !run.approval) throw new Error('Run 没有可确认的候选修改。')
    const now = isoNow()
    const message: MessageRecord = { id: randomUUID(), threadId: run.threadId, role: 'assistant', content, createdAt: now }
    this.transaction(() => {
      this.insertMessage(message)
      this.db.prepare("UPDATE runs SET status = 'WaitingConfirmation' WHERE id = ?").run(runId)
      this.touchThread(run.threadId, now)
    })
    return { message, run: this.requireRun(runId) }
  }

  waitForAnalysisConfirmation(runId: string, content: string, questions: DeliveredQuestion[] = []): { message: MessageRecord; run: RunRecord } {
    const run = this.requireRun(runId)
    if (run.status !== 'Running' || run.analysisResult?.analysisStatus !== 'ReadyForConfirmation') {
      throw new Error('Run 没有可确认的 Requirement Analysis。')
    }
    const now = isoNow()
    const message: MessageRecord = { id: randomUUID(), threadId: run.threadId, role: 'assistant', content, questions, createdAt: now }
    this.transaction(() => {
      this.insertMessage(message)
      this.db.prepare("UPDATE runs SET status = 'WaitingConfirmation' WHERE id = ?").run(runId)
      this.touchThread(run.threadId, now)
    })
    return { message, run: this.requireRun(runId) }
  }

  waitForFlowConfirmation(runId: string, content: string): { message: MessageRecord; run: RunRecord } {
    const run = this.requireRun(runId)
    if (run.status !== 'Running' || run.flowResult?.flowStatus !== 'READY_FOR_CONFIRMATION') {
      throw new Error('Run 没有可确认的 Business Flow。')
    }
    const now = isoNow()
    const message: MessageRecord = { id: randomUUID(), threadId: run.threadId, role: 'assistant', content, createdAt: now }
    this.transaction(() => {
      this.insertMessage(message)
      this.db.prepare("UPDATE runs SET status = 'WaitingConfirmation' WHERE id = ?").run(runId)
      this.touchThread(run.threadId, now)
    })
    return { message, run: this.requireRun(runId) }
  }

  recordToolCall(runId: string, call: ToolCallRecord, output?: Record<string, unknown>, approval?: WriteApprovalRequest): RunRecord {
    const run = this.requireRun(runId)
    const toolCalls = run.toolCalls.some((item) => item.id === call.id)
      ? run.toolCalls.map((item) => item.id === call.id ? call : item)
      : [...run.toolCalls, call]
    if (!isRunWritable(run.status)) {
      this.db.prepare('UPDATE runs SET tool_calls = ? WHERE id = ?').run(JSON.stringify(toolCalls), runId)
      return this.requireRun(runId)
    }
    const tools = run.tools.includes(call.name) ? run.tools : [...run.tools, call.name]
    const readFiles = [...run.readFiles]
    const metadata = output?.metadata
    if (call.status === 'Completed' && metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      const path = (metadata as Record<string, unknown>).path
      if (typeof path === 'string' && !readFiles.includes(path)) readFiles.push(path)
    }
    const changedFiles = [...run.changedFiles]
    if ((call.name === 'artifact_write' || call.name === 'requirement_analysis_write') && call.status === 'Completed'
      && typeof output?.path === 'string' && !changedFiles.includes(output.path)) {
      changedFiles.push(output.path)
    }
    if (call.name === 'business_flow_write' && call.status === 'Completed' && Array.isArray(output?.paths)) {
      for (const path of output.paths) if (typeof path === 'string' && !changedFiles.includes(path)) changedFiles.push(path)
    }
    if (call.name === 'solution_design_write' && call.status === 'Completed' && Array.isArray(output?.paths)) {
      for (const path of output.paths) if (typeof path === 'string' && !changedFiles.includes(path)) changedFiles.push(path)
    }
    if (call.name === 'interaction_design_write' && call.status === 'Completed' && Array.isArray(output?.paths)) {
      for (const path of output.paths) if (typeof path === 'string' && !changedFiles.includes(path)) changedFiles.push(path)
    }
    if (call.name === 'prototype_write' && call.status === 'Completed' && typeof output?.path === 'string' && !changedFiles.includes(output.path)) {
      changedFiles.push(output.path)
    }
    if (call.name === 'product_spec_write' && call.status === 'Completed' && Array.isArray(output?.paths)) {
      for (const path of output.paths) if (typeof path === 'string' && !changedFiles.includes(path)) changedFiles.push(path)
    }
    if (call.name === 'requirement_review_write' && call.status === 'Completed' && Array.isArray(output?.paths)) {
      for (const path of output.paths) if (typeof path === 'string' && !changedFiles.includes(path)) changedFiles.push(path)
    }
    const submitted = output?.changeResult && typeof output.changeResult === 'object' && !Array.isArray(output.changeResult)
      ? output.changeResult as ChangeResult : null
    const changeResult = submitted ? { ...submitted, filesRead: readFiles } : run.changeResult
    const submittedAnalysis = output?.analysisResult && typeof output.analysisResult === 'object' && !Array.isArray(output.analysisResult)
      ? output.analysisResult as RequirementAnalysisResult : null
    const analysisResult = submittedAnalysis ?? run.analysisResult
    const submittedFlow = output?.flowResult && typeof output.flowResult === 'object' && !Array.isArray(output.flowResult)
      ? output.flowResult as BusinessFlowResult : null
    const flowResult = submittedFlow ?? run.flowResult
    const submittedSolution = output?.solutionResult && typeof output.solutionResult === 'object' && !Array.isArray(output.solutionResult)
      ? output.solutionResult as SolutionDesignResult : null
    const solutionResult = submittedSolution ?? run.solutionResult
    const submittedInteraction = output?.interactionResult && typeof output.interactionResult === 'object' && !Array.isArray(output.interactionResult)
      ? output.interactionResult as InteractionDesignResult : null
    const interactionResult = submittedInteraction ?? run.interactionResult
    const submittedPrototype = output?.prototypeResult && typeof output.prototypeResult === 'object' && !Array.isArray(output.prototypeResult)
      ? output.prototypeResult as PrototypeResult : null
    const prototypeResult = submittedPrototype ?? run.prototypeResult
    const submittedProductSpec = output?.productSpecResult && typeof output.productSpecResult === 'object' && !Array.isArray(output.productSpecResult)
      ? output.productSpecResult as ProductSpecResult : null
    const productSpecResult = submittedProductSpec ?? run.productSpecResult
    const submittedRequirementReview = output?.requirementReviewResult && typeof output.requirementReviewResult === 'object' && !Array.isArray(output.requirementReviewResult)
      ? output.requirementReviewResult as RequirementReviewResult : null
    const requirementReviewResult = submittedRequirementReview ?? run.requirementReviewResult
    const context = run.context ? { ...run.context, artifacts: [...run.context.artifacts], sources: [...run.context.sources] } : null
    if (context && call.name === 'artifact_read' && call.status === 'Completed' && metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      const value = metadata as Record<string, unknown>
      const path = typeof value.path === 'string' ? value.path : null
      if (path && !context.artifacts.some((item) => item.path === path)) {
        context.artifacts.push({
          id: typeof value.id === 'string' ? value.id : null,
          path,
          type: typeof value.type === 'string' ? value.type : null,
          section: typeof value.section === 'string' ? value.section : null
        })
        context.sources.push(`artifact:${path}`)
      }
    }
    this.db.prepare('UPDATE runs SET tools = ?, tool_calls = ?, read_files = ?, changed_files = ?, approval_request = COALESCE(?, approval_request), change_result = COALESCE(?, change_result), analysis_result = COALESCE(?, analysis_result), flow_result = COALESCE(?, flow_result), solution_result = COALESCE(?, solution_result), interaction_result = COALESCE(?, interaction_result), prototype_result = COALESCE(?, prototype_result), product_spec_result = COALESCE(?, product_spec_result), requirement_review_result = COALESCE(?, requirement_review_result), context_metadata = COALESCE(?, context_metadata) WHERE id = ?')
      .run(JSON.stringify(tools), JSON.stringify(toolCalls), JSON.stringify(readFiles), JSON.stringify(changedFiles), approval ? JSON.stringify(approval) : null,
        changeResult ? JSON.stringify(changeResult) : null, analysisResult ? JSON.stringify(analysisResult) : null,
        flowResult ? JSON.stringify(flowResult) : null, solutionResult ? JSON.stringify(solutionResult) : null,
        interactionResult ? JSON.stringify(interactionResult) : null, prototypeResult ? JSON.stringify(prototypeResult) : null,
        productSpecResult ? JSON.stringify(productSpecResult) : null, requirementReviewResult ? JSON.stringify(requirementReviewResult) : null,
        context ? JSON.stringify(context) : null, runId)
    return this.requireRun(runId)
  }

  resolveApproval(runId: string, approval: WriteApprovalRequest, status: 'Completed' | 'Cancelled' | 'Failed', error: string | null = null): RunRecord {
    const run = this.requireRun(runId)
    if (run.status !== 'Running') throw new Error(`Run 当前状态为 ${run.status}，不能完成 Approval。`)
    const now = isoNow()
    const changeResult = run.changeResult ? {
      ...run.changeResult,
      finalChanges: status === 'Completed' ? run.changedFiles : [],
      validationResult: status === 'Completed' ? 'Passed' : status === 'Failed' ? `Failed: ${error ?? '未知错误'}` : 'Cancelled by user'
    } : null
    this.db.prepare('UPDATE runs SET status = ?, approval_request = ?, finished_at = ?, error = ?, change_result = COALESCE(?, change_result) WHERE id = ?')
      .run(status, JSON.stringify(approval), now, error, changeResult ? JSON.stringify(changeResult) : null, runId)
    this.touchThread(run.threadId, now)
    return this.requireRun(runId)
  }

  beginCancellation(runId: string): RunRecord {
    const run = this.requireRun(runId)
    if (!canBeginCancellation(run.status)) return run
    const result = this.db.prepare("UPDATE runs SET status = 'Cancelling' WHERE id = ? AND status IN ('Running','WaitingConfirmation')").run(runId)
    if (Number(result.changes) === 0) return this.requireRun(runId)
    return this.requireRun(runId)
  }

  completeCancellation(runId: string): RunRecord {
    const run = this.requireRun(runId)
    if (run.status === 'Cancelled') return run
    if (run.status !== 'Cancelling') return run
    const now = isoNow()
    this.db.prepare("UPDATE runs SET status = 'Cancelled', finished_at = ?, error = NULL WHERE id = ? AND status = 'Cancelling'").run(now, runId)
    this.touchThread(run.threadId, now)
    return this.requireRun(runId)
  }

  interruptRun(runId: string, error = 'Agent Runtime 执行被中断。'): RunRecord {
    const run = this.requireRun(runId)
    if (!['Running', 'Cancelling'].includes(run.status)) return run
    const now = isoNow()
    this.db.prepare("UPDATE runs SET status = 'Interrupted', finished_at = ?, error = ? WHERE id = ? AND status IN ('Running','Cancelling')")
      .run(now, error, runId)
    this.touchThread(run.threadId, now)
    return this.requireRun(runId)
  }

  assertRunWritable(runId: string, workspaceId?: string, requirementId?: string): RunRecord {
    const run = this.requireRun(runId)
    if (workspaceId && run.workspaceId !== workspaceId) throw new Error('RUN_WORKSPACE_MISMATCH')
    if (requirementId && run.requirementId !== requirementId) throw new Error('RUN_REQUIREMENT_MISMATCH')
    if (!isRunWritable(run.status)) throw new Error(`RUN_NOT_WRITABLE:${run.status}`)
    return run
  }

  claimApproval(runId: string, approval: WriteApprovalRequest, approved: boolean): RunRecord {
    const run = this.requireRun(runId)
    if (!canResolveApproval(run.status)) throw new Error('APPROVAL_ALREADY_RESOLVED')
    const now = isoNow()
    const nextStatus: RunStatus = approved ? 'Running' : 'Cancelled'
    const result = this.db.prepare(
      "UPDATE runs SET status = ?, approval_request = ?, finished_at = CASE WHEN ? = 'Cancelled' THEN ? ELSE finished_at END WHERE id = ? AND status = 'WaitingConfirmation'"
    ).run(nextStatus, JSON.stringify(approval), nextStatus, now, runId)
    if (Number(result.changes) !== 1) throw new Error('APPROVAL_ALREADY_RESOLVED')
    if (!approved) this.touchThread(run.threadId, now)
    return this.requireRun(runId)
  }

  getRun(runId: string): RunRecord {
    return this.requireRun(runId)
  }

  failRun(runId: string, error: string): RunRecord {
    return this.finishRun(runId, 'Failed', error)
  }

  cancelRun(runId: string): RunRecord {
    this.beginCancellation(runId)
    return this.completeCancellation(runId)
  }

  updateRunRuntimeEvents(runId: string, events: RuntimeEventType[]): void {
    const run = this.requireRun(runId)
    const merged = [...run.runtimeEvents]
    for (const event of events) {
      if (!merged.includes(event)) merged.push(event)
    }
    this.db.prepare('UPDATE runs SET runtime_event_summary = ? WHERE id = ?').run(JSON.stringify(merged), runId)
  }

  recordRuntimeEvent(runId: string, eventType: RuntimeEventType, payload?: unknown, createdAt = isoNow()): void {
    const run = this.requireRun(runId)
    this.db.prepare('INSERT INTO run_events (id, run_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), runId, eventType, payload ? JSON.stringify(payload) : null, createdAt)
    this.db.prepare('UPDATE runs SET runtime_event_summary = ? WHERE id = ?')
      .run(JSON.stringify([...run.runtimeEvents, eventType]), runId)
  }

  getThreadMemory(threadId: string): ThreadMemorySnapshot | null {
    const row = this.db.prepare('SELECT * FROM thread_memory WHERE thread_id = ?').get(threadId) as Row | undefined
    return row ? {
      threadId: String(row.thread_id),
      summary: String(row.summary),
      compactedMessageCount: Number(row.compacted_message_count),
      updatedAt: String(row.updated_at)
    } : null
  }

  saveThreadMemory(threadId: string, summary: string, compactedMessageCount: number): ThreadMemorySnapshot {
    this.requireThread(threadId)
    const value: ThreadMemorySnapshot = { threadId, summary, compactedMessageCount, updatedAt: isoNow() }
    this.db.prepare(`INSERT INTO thread_memory (thread_id, summary, compacted_message_count, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET
      summary = excluded.summary, compacted_message_count = excluded.compacted_message_count, updated_at = excluded.updated_at`)
      .run(value.threadId, value.summary, value.compactedMessageCount, value.updatedAt)
    return value
  }

  upsertMemory(input: {
    id?: string
    scope: MemoryScope
    workspaceId?: string | null
    requirementId?: string | null
    threadId?: string | null
    category: string
    content: string
    importance?: number
    source: string
  }): MemoryItem {
    const now = isoNow()
    const id = input.id ?? randomUUID()
    const importance = Math.max(1, Math.min(5, Math.round(input.importance ?? 1)))
    this.db.prepare(`INSERT INTO memory_items
      (id, scope, workspace_id, requirement_id, thread_id, category, content, importance, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET category = excluded.category, content = excluded.content,
      importance = excluded.importance, source = excluded.source, updated_at = excluded.updated_at`)
      .run(id, input.scope, input.workspaceId ?? null, input.requirementId ?? null, input.threadId ?? null,
        input.category.trim(), input.content.trim(), importance, input.source, now, now)
    return rowMemoryItem(this.db.prepare('SELECT * FROM memory_items WHERE id = ?').get(id) as Row)
  }

  searchMemory(input: { workspaceId: string; requirementId: string; threadId: string; query: string; limit?: number }): MemoryItem[] {
    const rows = this.db.prepare(`SELECT * FROM memory_items WHERE
      (scope = 'global') OR
      (scope = 'requirement' AND workspace_id = ? AND requirement_id = ?) OR
      (scope = 'thread' AND thread_id = ?)
      ORDER BY importance DESC, updated_at DESC LIMIT 100`).all(input.workspaceId, input.requirementId, input.threadId) as Row[]
    const terms = memorySearchTerms(input.query)
    const scored = rows.map((row) => {
      const item = rowMemoryItem(row)
      const haystack = `${item.category} ${item.content}`.toLowerCase()
      const score = item.importance * 2 + terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0)
      return { item, score }
    }).filter(({ score }) => score > 2)
    return scored.sort((a, b) => b.score - a.score || b.item.updatedAt.localeCompare(a.item.updatedAt))
      .slice(0, Math.max(1, Math.min(12, input.limit ?? 6))).map(({ item }) => item)
  }

  getAnalysisState(requirementId: string, _threadId: string): AnalysisState | null {
    const row = this.db.prepare('SELECT state_json FROM analysis_mainlines WHERE requirement_id = ?')
      .get(requirementId) as Row | undefined
    if (row) return analysisStateValue(row.state_json)
    const legacy = this.db.prepare('SELECT state_json FROM analysis_states WHERE requirement_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1')
      .get(requirementId) as Row | undefined
    return legacy ? analysisStateValue(legacy.state_json) : null
  }

  getLatestAnalysisState(requirementId: string, excludeThreadId?: string): AnalysisState | null {
    const row = excludeThreadId
      ? this.db.prepare('SELECT state_json FROM analysis_states WHERE requirement_id = ? AND thread_id <> ? ORDER BY updated_at DESC, rowid DESC LIMIT 1')
        .get(requirementId, excludeThreadId) as Row | undefined
      : this.db.prepare('SELECT state_json FROM analysis_states WHERE requirement_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1')
        .get(requirementId) as Row | undefined
    return row ? analysisStateValue(row.state_json) : null
  }

  saveAnalysisState(state: AnalysisState, runId?: string | null, eventType = 'state-updated', patch?: unknown): AnalysisState {
    this.requireThread(state.threadId)
    this.transaction(() => {
      this.db.prepare(`INSERT INTO analysis_mainlines
        (workspace_id, requirement_id, last_thread_id, state_json, version, source, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(requirement_id) DO UPDATE SET workspace_id=excluded.workspace_id, last_thread_id=excluded.last_thread_id,
        state_json=excluded.state_json, version=excluded.version, source=excluded.source, updated_at=excluded.updated_at`)
        .run(state.workspaceId, state.requirementId, state.threadId, JSON.stringify(state), state.version, state.source, state.updatedAt)
      this.db.prepare(`INSERT INTO analysis_states
        (workspace_id, requirement_id, thread_id, state_json, version, source, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(requirement_id, thread_id) DO UPDATE SET
        workspace_id = excluded.workspace_id, state_json = excluded.state_json, version = excluded.version,
        source = excluded.source, updated_at = excluded.updated_at`)
        .run(state.workspaceId, state.requirementId, state.threadId, JSON.stringify(state), state.version, state.source, state.updatedAt)
      this.db.prepare(`INSERT INTO analysis_state_events
        (id, requirement_id, thread_id, run_id, version, event_type, patch_json, state_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), state.requirementId, state.threadId, runId ?? null, state.version, eventType,
          patch === undefined ? null : JSON.stringify(patch), JSON.stringify(state), isoNow())
    })
    return state
  }

  projectAnalysisQuestions(runId: string): DeliveredQuestion[] {
    const current = this.db.prepare(`SELECT rowid, requirement_id, state_json FROM analysis_state_events
      WHERE run_id = ? ORDER BY rowid DESC LIMIT 1`).get(runId) as Row | undefined
    if (!current || typeof current.state_json !== 'string') return []
    const currentState = analysisStateValue(current.state_json)
    if (!currentState) return []
    const previous = this.db.prepare(`SELECT state_json FROM analysis_state_events
      WHERE requirement_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT 1`)
      .get(String(current.requirement_id), Number(current.rowid)) as Row | undefined
    const previousState = previous ? analysisStateValue(previous.state_json) : null
    const previousById = new Map((previousState?.openQuestions ?? []).map((question) => [question.id, question]))
    const enabledAt = this.getState('question_delivery_contract_enabled_at')
    return currentState.openQuestions.filter((question) => {
      if (question.status !== 'open') return false
      const before = previousById.get(question.id)
      const changedThisTurn = !before || before.status !== 'open' || before.question !== question.question || before.priority !== question.priority
      if (changedThisTurn) return true
      if (!enabledAt) return false
      const delivered = this.db.prepare(`SELECT 1 FROM messages m
        JOIN threads t ON t.id = m.thread_id, json_each(m.questions_json) q
        WHERE t.requirement_id = ? AND json_extract(q.value, '$.id') = ?
          AND json_extract(q.value, '$.content') = ? LIMIT 1`)
        .get(String(current.requirement_id), question.id, question.question)
      if (delivered) return false
      return Boolean(this.db.prepare(`SELECT 1 FROM analysis_state_events e, json_each(json_extract(e.state_json, '$.openQuestions')) q
        WHERE e.requirement_id = ? AND e.created_at >= ?
          AND json_extract(q.value, '$.id') = ? AND json_extract(q.value, '$.question') = ? LIMIT 1`)
        .get(String(current.requirement_id), enabledAt, question.id, question.question))
    }).map((question) => ({
      id: question.id,
      content: question.question,
      blocking: question.blocking ?? question.priority === 'blocking'
    }))
  }

  listAnalysisStateEvents(requirementId: string, threadId: string): Array<{ version: number; eventType: string; patch: unknown; createdAt: string }> {
    const rows = this.db.prepare('SELECT version, event_type, patch_json, created_at FROM analysis_state_events WHERE requirement_id = ? AND thread_id = ? ORDER BY created_at, rowid')
      .all(requirementId, threadId) as Row[]
    return rows.map((row) => {
      let patch: unknown = null
      if (typeof row.patch_json === 'string') { try { patch = JSON.parse(row.patch_json) as unknown } catch { patch = row.patch_json } }
      return { version: Number(row.version), eventType: String(row.event_type), patch, createdAt: String(row.created_at) }
    })
  }


  getSharedRequirementState(requirementId: string): SharedRequirementState | null {
    const row = this.db.prepare('SELECT state_json FROM shared_requirement_states WHERE requirement_id = ?').get(requirementId) as Row | undefined
    return row ? sharedRequirementStateValue(row.state_json) : null
  }

  saveSharedRequirementState(state: SharedRequirementState): SharedRequirementState {
    this.db.prepare(`INSERT INTO shared_requirement_states
      (workspace_id, requirement_id, state_json, version, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(requirement_id) DO UPDATE SET workspace_id=excluded.workspace_id, state_json=excluded.state_json,
      version=excluded.version, source=excluded.source, updated_at=excluded.updated_at`)
      .run(state.workspaceId, state.requirementId, JSON.stringify(state), state.version, state.source, state.updatedAt)
    return state
  }

  getLifecycleStageState(requirementId: string, stageId: LifecycleStageId): LifecycleStageState | null {
    const row = this.db.prepare('SELECT state_json FROM lifecycle_stage_states WHERE requirement_id = ? AND stage_id = ?')
      .get(requirementId, stageId) as Row | undefined
    return row ? lifecycleStageStateValue(row.state_json) : null
  }

  listLifecycleStageStates(requirementId: string): LifecycleStageState[] {
    return (this.db.prepare('SELECT state_json FROM lifecycle_stage_states WHERE requirement_id = ? ORDER BY updated_at, rowid').all(requirementId) as Row[])
      .map((row) => lifecycleStageStateValue(row.state_json)).filter((value): value is LifecycleStageState => Boolean(value))
  }

  saveLifecycleStageState(state: LifecycleStageState, runId?: string | null, eventType = 'stage-state-updated'): LifecycleStageState {
    this.db.prepare(`INSERT INTO lifecycle_stage_states
      (workspace_id, requirement_id, stage_id, state_json, version, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(requirement_id, stage_id) DO UPDATE SET workspace_id=excluded.workspace_id, state_json=excluded.state_json,
      version=excluded.version, status=excluded.status, updated_at=excluded.updated_at`)
      .run(state.workspaceId, state.requirementId, state.stageId, JSON.stringify(state), state.version, state.status, state.updatedAt)
    this.db.prepare(`INSERT INTO lifecycle_stage_state_events
      (id, requirement_id, stage_id, run_id, version, event_type, state_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), state.requirementId, state.stageId, runId ?? null, state.version, eventType, JSON.stringify(state), isoNow())
    return state
  }

  listRuns(workspaceId: string): RunRecord[] {
    return (this.db.prepare(`SELECT runs.*, threads.title AS thread_title FROM runs
      LEFT JOIN threads ON threads.id = runs.thread_id WHERE runs.workspace_id = ? ORDER BY runs.started_at DESC`)
      .all(workspaceId) as Row[]).map(rowRun)
  }

  listRunEvents(runId: string): RunEventRecord[] {
    this.requireRun(runId)
    return (this.db.prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY created_at, rowid').all(runId) as Row[])
      .map((row) => {
        let payload: unknown = null
        if (typeof row.payload === 'string') {
          try { payload = JSON.parse(row.payload) as unknown } catch { payload = row.payload }
        }
        return {
          id: String(row.id), runId: String(row.run_id), eventType: String(row.event_type) as RuntimeEventType,
          payload, createdAt: String(row.created_at)
        }
      })
  }

  listTokenUsageWorkspaces(): TokenUsageWorkspace[] {
    return (this.db.prepare('SELECT id, name, path FROM workspaces ORDER BY last_opened_at DESC').all() as Row[])
      .map((row) => ({ id: String(row.id), name: String(row.name), path: String(row.path) }))
  }

  recordTokenUsage(
    runId: string,
    usage: { inputTokens: number; outputTokens: number; totalTokens: number },
    createdAt: string,
    executionContent: string,
    stepIndex: number | null = null,
    metrics: {
      messageCount?: number; toolCount?: number; systemPromptChars?: number; contextPackageChars?: number;
      toolSchemaChars?: number; assistantHistoryChars?: number; toolResultChars?: number;
      analysisProjectionChars?: number; recentConversationChars?: number; fullAnalysisStateChars?: number
      turnId?: string; callId?: string | null; callReason?: ModelCallReason; durationMs?: number | null;
      estimatedInputTokens?: number; historyTokens?: number; inputBreakdown?: TokenBreakdownItem[]
    } | null = null
  ): TokenUsageCall {
    const run = this.requireRun(runId)
    if (!run.provider || !run.model) throw new Error('Run 缺少模型信息，无法记录 Token usage。')
    const counts = [usage.inputTokens, usage.outputTokens, usage.totalTokens]
    if (counts.some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error('Provider Token usage 无效。')
    const stage = tokenStage(run.skill)
    const call: TokenUsageCall = {
      id: randomUUID(), workspaceId: run.workspaceId, conversationId: run.threadId, runId: run.id, originalRunId: run.id,
      turnId: metrics?.turnId ?? run.turnId ?? null,
      stage: stage.id, stageLabel: stage.label,
      executionContent: executionContent.trim() || run.task, stepIndex,
      callId: metrics?.callId ?? null, callIndex: stepIndex ?? 1, routeType: 'llm',
      callReason: metrics?.callReason ?? 'other', durationMs: metrics?.durationMs ?? null,
      usageSource: 'provider_reported', breakdownType: 'estimated_breakdown',
      estimatedInputTokens: metrics?.estimatedInputTokens ?? 0, historyTokens: metrics?.historyTokens ?? 0, historyGrowth: null,
      inputBreakdown: metrics?.inputBreakdown ?? [],
      messageCount: metrics?.messageCount ?? 0, toolCount: metrics?.toolCount ?? 0,
      systemPromptChars: metrics?.systemPromptChars ?? 0, contextPackageChars: metrics?.contextPackageChars ?? 0,
      toolSchemaChars: metrics?.toolSchemaChars ?? 0, assistantHistoryChars: metrics?.assistantHistoryChars ?? 0,
      toolResultChars: metrics?.toolResultChars ?? 0, analysisProjectionChars: metrics?.analysisProjectionChars ?? 0,
      recentConversationChars: metrics?.recentConversationChars ?? 0, fullAnalysisStateChars: metrics?.fullAnalysisStateChars ?? 0,
      provider: run.provider, model: run.model,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens,
      createdAt
    }
    this.db.prepare(`INSERT INTO token_usage_calls
      (id, workspace_id, conversation_id, run_id, original_run_id, stage, provider, model, input_tokens, output_tokens, total_tokens,
       execution_content, step_index, message_count, tool_count, system_prompt_chars, context_package_chars, tool_schema_chars,
       assistant_history_chars, tool_result_chars, analysis_projection_chars, recent_conversation_chars, full_analysis_state_chars,
       turn_id, call_id, call_index, route_type, call_reason, duration_ms, usage_source, breakdown_type, estimated_input_tokens, history_tokens, input_breakdown, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(call.id, call.workspaceId, call.conversationId, call.runId, call.originalRunId, call.stage, call.provider, call.model,
        call.inputTokens, call.outputTokens, call.totalTokens, call.executionContent, call.stepIndex, call.messageCount, call.toolCount,
        call.systemPromptChars, call.contextPackageChars, call.toolSchemaChars, call.assistantHistoryChars, call.toolResultChars,
        call.analysisProjectionChars, call.recentConversationChars, call.fullAnalysisStateChars, call.turnId, call.callId,
        call.callIndex, call.routeType, call.callReason, call.durationMs, call.usageSource, call.breakdownType,
        call.estimatedInputTokens, call.historyTokens, JSON.stringify(call.inputBreakdown), call.createdAt)
    return call
  }

  getTokenUsageSummary(workspaceId: string): TokenUsageSummary {
    const calls = (this.db.prepare('SELECT * FROM token_usage_calls WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(workspaceId) as Row[]).map(rowTokenUsage)
    const callsByThread = new Map<string, TokenUsageCall[]>()
    for (const call of calls) {
      const key = call.conversationId ?? call.workspaceId
      callsByThread.set(key, [...(callsByThread.get(key) ?? []), call])
    }
    for (const threadCalls of callsByThread.values()) {
      const turns = new Map<string, TokenUsageCall[]>()
      for (const call of [...threadCalls].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        const key = call.turnId ?? call.originalRunId ?? call.runId ?? call.id
        turns.set(key, [...(turns.get(key) ?? []), call])
      }
      let previousHistoryTokens: number | null = null
      for (const turnCalls of turns.values()) {
        const historyTokens = turnCalls[0]?.historyTokens ?? 0
        const historyGrowth = previousHistoryTokens ? historyTokens / previousHistoryTokens : null
        for (const call of turnCalls) call.historyGrowth = historyGrowth
        previousHistoryTokens = historyTokens
      }
    }
    const inputTokens = calls.reduce((sum, call) => sum + call.inputTokens, 0)
    const outputTokens = calls.reduce((sum, call) => sum + call.outputTokens, 0)
    const totalTokens = calls.reduce((sum, call) => sum + call.totalTokens, 0)
    const stages: TokenStageSummary[] = tokenStages.flatMap((stage) => {
      const stageCalls = calls.filter((call) => call.stage === stage.id)
      if (!stageCalls.length) return []
      const stageTotal = stageCalls.reduce((sum, call) => sum + call.totalTokens, 0)
      return [{
        stage: stage.id, label: stage.label,
        inputTokens: stageCalls.reduce((sum, call) => sum + call.inputTokens, 0),
        outputTokens: stageCalls.reduce((sum, call) => sum + call.outputTokens, 0),
        totalTokens: stageTotal, callCount: stageCalls.length,
        percentage: totalTokens ? stageTotal / totalTokens * 100 : 0,
        calls: stageCalls
      }]
    })
    const scriptRunCount = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM run_events
      INNER JOIN runs ON runs.id = run_events.run_id WHERE runs.workspace_id = ? AND run_events.event_type = 'script_completed'`)
      .get(workspaceId) as Row | undefined)?.count ?? 0)
    const toolCallCount = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM run_events
      INNER JOIN runs ON runs.id = run_events.run_id WHERE runs.workspace_id = ? AND run_events.event_type = 'tool_completed'`)
      .get(workspaceId) as Row | undefined)?.count ?? 0)
    const deterministicExecutionRate = scriptRunCount + calls.length ? scriptRunCount / (scriptRunCount + calls.length) * 100 : 0
    const observabilityRows = this.db.prepare(`SELECT runs.id AS run_id, runs.turn_id, runs.task, runs.skill, runs.started_at,
      run_events.id AS event_id, run_events.event_type, run_events.payload, run_events.created_at AS event_created_at
      FROM runs LEFT JOIN run_events ON run_events.run_id = runs.id
      WHERE runs.workspace_id = ? ORDER BY runs.started_at DESC, run_events.created_at, run_events.rowid`).all(workspaceId) as Row[]
    const runRows = new Map<string, Row[]>()
    for (const row of observabilityRows) {
      const runId = String(row.run_id)
      runRows.set(runId, [...(runRows.get(runId) ?? []), row])
    }
    const callsByTurn = new Map<string, TokenUsageCall[]>()
    const callsByRun = new Map<string, TokenUsageCall[]>()
    for (const call of calls) {
      if (call.turnId) callsByTurn.set(call.turnId, [...(callsByTurn.get(call.turnId) ?? []), call])
      if (call.runId) callsByRun.set(call.runId, [...(callsByRun.get(call.runId) ?? []), call])
    }
    const turns: TokenUsageTurn[] = [...runRows.entries()].map(([runId, rows]) => {
      const first = rows[0]
      const turnId = first.turn_id === null ? runId : String(first.turn_id)
      const runCalls = [...(callsByTurn.get(turnId) ?? callsByRun.get(runId) ?? [])]
        .sort((a, b) => a.callIndex - b.callIndex || a.createdAt.localeCompare(b.createdAt))
      const events = rows.filter((row) => row.event_id !== null)
      const gateRow = events.find((row) => row.event_type === 'model_gate_evaluated')
      const gate = parseObject(gateRow?.payload)
      const rawPath = stringValue(gate.executionPath)?.toUpperCase()
      const executionPath: ExecutionPath = rawPath === 'SCRIPT' || rawPath === 'LLM' || rawPath === 'FALLBACK' ? rawPath : 'UNKNOWN'
      const rawContextMode = stringValue(gate.contextMode)?.toLowerCase()
      const contextMode: ObservedContextMode = rawContextMode === 'core' || rawContextMode === 'slice' || rawContextMode === 'extended' || rawContextMode === 'full'
        ? rawContextMode : 'unknown'
      const rawSkillMode = stringValue(gate.skillMode)?.toLowerCase()
      const skillMode: ObservedSkillMode = rawSkillMode === 'capsule' || rawSkillMode === 'full' ? rawSkillMode : rawSkillMode === null ? 'none' : 'unknown'
      const followups: FollowupDecisionSummary[] = events.filter((row) => row.event_type === 'followup_decision').map((row) => {
        const payload = parseObject(row.payload)
        return {
          tool: stringValue(payload.toolName), required: payload.followupRequired === true || payload.required === true,
          reason: stringValue(payload.followupReason) ?? stringValue(payload.reason) ?? 'NO_FOLLOWUP',
          step: typeof payload.step === 'number' ? payload.step : null
        }
      })
      const trace: ExecutionTraceStep[] = [{
        id: `${runId}-user`, kind: 'user', label: 'User Turn', detail: String(first.task), createdAt: String(first.started_at)
      }]
      for (const row of events) {
        const payload = parseObject(row.payload)
        const createdAt = String(row.event_created_at ?? first.started_at)
        const id = String(row.event_id)
        if (row.event_type === 'model_gate_evaluated') {
          trace.push({ id, kind: 'router', label: `Router · ${stringValue(payload.executionPath) ?? 'Unknown'}`, detail: [stringValue(payload.action), stringValue(payload.routerReason) ?? stringValue(payload.reason)].filter(Boolean).join(' · '), createdAt })
          if (stringValue(payload.contextMode)) trace.push({ id: `${id}-context`, kind: 'context', label: `Context Resolver · ${stringValue(payload.contextMode)}`, detail: stringList(payload.contextSources).join(' · ') || '未记录 Loaded Sections', createdAt })
          trace.push({ id: `${id}-skill`, kind: 'skill', label: `Skill Resolver · ${stringValue(payload.skillMode) ?? 'None'}`, detail: String(first.skill ?? 'No Skill'), createdAt })
        } else if (row.event_type === 'model_usage') {
          trace.push({ id, kind: 'model', label: `Call #${typeof payload.step === 'number' ? payload.step : 1} · ${stringValue(payload.callReason) ?? 'other'}`, detail: `Input ${Number(payload.actualInputTokens ?? 0).toLocaleString('zh-CN')} · Output ${Number(payload.actualOutputTokens ?? 0).toLocaleString('zh-CN')}`, createdAt })
        } else if (row.event_type === 'tool_completed') {
          trace.push({ id, kind: 'tool', label: `Tool · ${stringValue(payload.toolName) ?? 'Unknown'}`, detail: 'Completed', createdAt })
        } else if (row.event_type === 'followup_decision') {
          trace.push({ id, kind: 'followup', label: `Follow-up Gate · ${stringValue(payload.followupReason) ?? stringValue(payload.reason) ?? 'Unknown'}`, detail: payload.followupRequired === true || payload.required === true ? 'Call Next' : 'Finish', createdAt })
        } else if (row.event_type === 'script_completed') {
          trace.push({ id, kind: 'script', label: `Script · ${stringValue(payload.name) ?? 'Runtime'}`, detail: 'Completed · 0 Token', createdAt })
        } else if (row.event_type === 'run_completed' || row.event_type === 'run_failed' || row.event_type === 'run_cancelled') {
          trace.push({ id, kind: 'runtime', label: row.event_type === 'run_completed' ? 'Finish' : String(row.event_type), detail: stringValue(payload.error) ?? '', createdAt })
        }
      }
      return {
        id: turnId, runId,
        stage: stringValue(gate.stage) ?? (first.skill === null ? null : String(first.skill)),
        intent: stringValue(gate.action), executionPath,
        routerReason: stringValue(gate.routerReason) ?? stringValue(gate.reason),
        fallback: executionPath === 'FALLBACK' || gate.fallback === true,
        llmCalls: runCalls.length,
        scriptCalls: events.filter((row) => row.event_type === 'script_completed').length,
        inputTokens: runCalls.reduce((sum, call) => sum + call.inputTokens, 0),
        outputTokens: runCalls.reduce((sum, call) => sum + call.outputTokens, 0),
        contextMode, contextLevel: stringValue(gate.contextLevelFinal) ?? stringValue(gate.contextLevel),
        contextSources: stringList(gate.contextSources), contextExpansion: stringList(gate.contextExpansion),
        skillMode, skill: first.skill === null ? null : String(first.skill),
        skillFallbackReason: stringValue(gate.skillFallbackReason), toolsInjected: stringList(gate.toolsInjected),
        followups, createdAt: String(first.started_at), calls: runCalls, trace
      }
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const router = distribution(turns.map((turn) => turn.executionPath), ['SCRIPT', 'LLM', 'FALLBACK'])
    const contextModes = distribution(turns.map((turn) => turn.contextMode), ['core', 'slice', 'extended', 'full']).map((item) => {
      const matching = turns.filter((turn) => turn.contextMode === item.key)
      const modeInput = matching.reduce((sum, turn) => sum + turn.inputTokens, 0)
      return { ...item, inputTokens: modeInput, averageInputTokens: matching.length ? Math.round(modeInput / matching.length) : 0 }
    })
    const skillModes = distribution(turns.map((turn) => turn.skillMode), ['none', 'capsule', 'full'])
    const followupTurns = turns.filter((turn) => turn.followups.some((item) => item.required))
    const followupReasons = distribution(turns.flatMap((turn) => turn.followups.map((item) => item.reason)), [])
    const callsPerTurn = distribution(turns.map((turn) => turn.llmCalls >= 3 ? '3+' : String(turn.llmCalls)), ['0', '1', '2', '3+'])
    const observability: RuntimeObservabilitySummary = {
      turnCount: turns.length, router, contextModes, skillModes,
      followupRate: turns.length ? followupTurns.length / turns.length * 100 : 0,
      followupReasons, callsPerTurn, turns
    }
    return { workspaceId, inputTokens, outputTokens, totalTokens, callCount: calls.length, scriptRunCount, toolCallCount, deterministicExecutionRate, stages, observability }
  }

  getPendingAnalysis(threadId: string): RunRecord | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE thread_id = ? AND skill = 'requirement-analysis' AND status = 'WaitingConfirmation' ORDER BY started_at DESC LIMIT 1")
      .get(threadId) as Row | undefined
    const run = row ? rowRun(row) : null
    return run?.analysisResult?.analysisStatus === 'ReadyForConfirmation' ? run : null
  }

  getLatestAnalysis(requirementId: string, threadId?: string): { runId: string; result: RequirementAnalysisResult } | null {
    const row = threadId
      ? this.db.prepare("SELECT * FROM runs WHERE requirement_id = ? AND thread_id = ? AND analysis_result IS NOT NULL ORDER BY started_at DESC LIMIT 1").get(requirementId, threadId) as Row | undefined
      : this.db.prepare("SELECT * FROM runs WHERE requirement_id = ? AND analysis_result IS NOT NULL ORDER BY started_at DESC LIMIT 1").get(requirementId) as Row | undefined
    const run = row ? rowRun(row) : null
    return run?.analysisResult ? { runId: run.id, result: run.analysisResult } : null
  }

  beginAnalysisConfirmation(runId: string, content: string): { message: MessageRecord; run: RunRecord } {
    const run = this.requireRun(runId)
    if (run.status !== 'WaitingConfirmation' || run.analysisResult?.analysisStatus !== 'ReadyForConfirmation') {
      throw new Error('Requirement Analysis 当前不可确认。')
    }
    const now = isoNow()
    const message: MessageRecord = { id: randomUUID(), threadId: run.threadId, role: 'user', content: content.trim(), createdAt: now }
    this.transaction(() => {
      this.insertMessage(message)
      this.db.prepare("UPDATE runs SET status = 'Running' WHERE id = ?").run(runId)
      this.touchThread(run.threadId, now)
    })
    return { message, run: this.requireRun(runId) }
  }

  confirmAnalysis(runId: string): RunRecord {
    const run = this.requireRun(runId)
    if (!run.analysisResult) throw new Error('Run 没有 Requirement Analysis Result。')
    const result: RequirementAnalysisResult = {
      ...run.analysisResult, analysisStatus: 'Confirmed', confirmedAt: isoNow()
    }
    this.db.prepare('UPDATE runs SET analysis_result = ? WHERE id = ?').run(JSON.stringify(result), runId)
    return this.requireRun(runId)
  }

  supersedeAnalysisConfirmation(runId: string): RunRecord {
    const run = this.requireRun(runId)
    if (run.status !== 'WaitingConfirmation') return run
    const now = isoNow()
    this.db.prepare("UPDATE runs SET status = 'Cancelled', finished_at = ? WHERE id = ?").run(now, runId)
    this.touchThread(run.threadId, now)
    return this.requireRun(runId)
  }

  getPendingFlow(threadId: string): RunRecord | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE thread_id = ? AND status = 'WaitingConfirmation' AND flow_result IS NOT NULL ORDER BY started_at DESC LIMIT 1")
      .get(threadId) as Row | undefined
    const run = row ? rowRun(row) : null
    return run?.flowResult?.flowStatus === 'READY_FOR_CONFIRMATION' ? run : null
  }

  getLatestFlow(requirementId: string, threadId?: string): { runId: string; result: BusinessFlowResult } | null {
    const row = threadId
      ? this.db.prepare('SELECT * FROM runs WHERE requirement_id = ? AND thread_id = ? AND flow_result IS NOT NULL ORDER BY started_at DESC LIMIT 1').get(requirementId, threadId) as Row | undefined
      : this.db.prepare('SELECT * FROM runs WHERE requirement_id = ? AND flow_result IS NOT NULL ORDER BY started_at DESC LIMIT 1').get(requirementId) as Row | undefined
    const run = row ? rowRun(row) : null
    return run?.flowResult ? { runId: run.id, result: run.flowResult } : null
  }

  getPendingSolution(threadId: string): RunRecord | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE thread_id = ? AND status = 'WaitingConfirmation' AND solution_result IS NOT NULL ORDER BY started_at DESC LIMIT 1")
      .get(threadId) as Row | undefined
    const run = row ? rowRun(row) : null
    return run?.solutionResult?.solutionStatus === 'READY_FOR_CONFIRMATION' ? run : null
  }

  getLatestSolution(requirementId: string, threadId?: string): { runId: string; result: SolutionDesignResult } | null {
    const row = threadId
      ? this.db.prepare('SELECT * FROM runs WHERE requirement_id = ? AND thread_id = ? AND solution_result IS NOT NULL ORDER BY started_at DESC LIMIT 1').get(requirementId, threadId) as Row | undefined
      : this.db.prepare('SELECT * FROM runs WHERE requirement_id = ? AND solution_result IS NOT NULL ORDER BY started_at DESC LIMIT 1').get(requirementId) as Row | undefined
    const run = row ? rowRun(row) : null
    return run?.solutionResult ? { runId: run.id, result: run.solutionResult } : null
  }

  waitForSolutionConfirmation(runId: string, content: string): { message: MessageRecord; run: RunRecord } {
    const run = this.requireRun(runId)
    if (run.status !== 'Running' || run.solutionResult?.solutionStatus !== 'READY_FOR_CONFIRMATION') {
      throw new Error('Run 没有可确认的 Solution Design。')
    }
    const now = isoNow()
    const message: MessageRecord = { id: randomUUID(), threadId: run.threadId, role: 'assistant', content, createdAt: now }
    this.transaction(() => {
      this.insertMessage(message)
      this.db.prepare("UPDATE runs SET status = 'WaitingConfirmation' WHERE id = ?").run(runId)
      this.touchThread(run.threadId, now)
    })
    return { message, run: this.requireRun(runId) }
  }

  beginSolutionConfirmation(runId: string, content: string): { message: MessageRecord; run: RunRecord } {
    const run = this.requireRun(runId)
    if (run.status !== 'WaitingConfirmation' || run.solutionResult?.solutionStatus !== 'READY_FOR_CONFIRMATION') {
      throw new Error('Solution Design 当前不可确认。')
    }
    const now = isoNow()
    const message: MessageRecord = { id: randomUUID(), threadId: run.threadId, role: 'user', content: content.trim(), createdAt: now }
    this.transaction(() => {
      this.insertMessage(message)
      this.db.prepare("UPDATE runs SET status = 'Running' WHERE id = ?").run(runId)
      this.touchThread(run.threadId, now)
    })
    return { message, run: this.requireRun(runId) }
  }

  confirmSolution(runId: string, confirmedAt: string): RunRecord {
    const run = this.requireRun(runId)
    if (!run.solutionResult) throw new Error('Run 没有 Solution Design Result。')
    const result: SolutionDesignResult = {
      ...run.solutionResult,
      solutionStatus: 'CONFIRMED',
      solution: { ...run.solutionResult.solution, status: 'CONFIRMED', confirmedAt },
      confirmedAt
    }
    this.db.prepare('UPDATE runs SET solution_result = ? WHERE id = ?').run(JSON.stringify(result), runId)
    return this.requireRun(runId)
  }

  supersedeSolutionConfirmation(runId: string): RunRecord {
    return this.supersedeFlowConfirmation(runId)
  }

  rejectSolutionConfirmation(runId: string, content: string): { message: MessageRecord; run: RunRecord } {
    return this.rejectFlowConfirmation(runId, content)
  }

  getPendingInteraction(threadId: string): RunRecord | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE thread_id = ? AND status = 'WaitingConfirmation' AND interaction_result IS NOT NULL ORDER BY started_at DESC LIMIT 1")
      .get(threadId) as Row | undefined
    const run = row ? rowRun(row) : null
    return run?.interactionResult?.interactionStatus === 'READY_FOR_CONFIRMATION' ? run : null
  }

  getLatestInteraction(requirementId: string, threadId?: string): { runId: string; result: InteractionDesignResult } | null {
    const row = threadId
      ? this.db.prepare('SELECT * FROM runs WHERE requirement_id = ? AND thread_id = ? AND interaction_result IS NOT NULL ORDER BY started_at DESC LIMIT 1').get(requirementId, threadId) as Row | undefined
      : this.db.prepare('SELECT * FROM runs WHERE requirement_id = ? AND interaction_result IS NOT NULL ORDER BY started_at DESC LIMIT 1').get(requirementId) as Row | undefined
    const run = row ? rowRun(row) : null
    return run?.interactionResult ? { runId: run.id, result: run.interactionResult } : null
  }

  waitForInteractionConfirmation(runId: string, content: string): { message: MessageRecord; run: RunRecord } {
    const run = this.requireRun(runId)
    if (run.status !== 'Running' || run.interactionResult?.interactionStatus !== 'READY_FOR_CONFIRMATION') throw new Error('Run 没有可确认的 Interaction Design。')
    const now = isoNow()
    const message: MessageRecord = { id: randomUUID(), threadId: run.threadId, role: 'assistant', content, createdAt: now }
    this.transaction(() => {
      this.insertMessage(message)
      this.db.prepare("UPDATE runs SET status = 'WaitingConfirmation' WHERE id = ?").run(runId)
      this.touchThread(run.threadId, now)
    })
    return { message, run: this.requireRun(runId) }
  }

  beginInteractionConfirmation(runId: string, content: string): { message: MessageRecord; run: RunRecord } {
    const run = this.requireRun(runId)
    if (run.status !== 'WaitingConfirmation' || run.interactionResult?.interactionStatus !== 'READY_FOR_CONFIRMATION') throw new Error('Interaction Design 当前不可确认。')
    const now = isoNow()
    const message: MessageRecord = { id: randomUUID(), threadId: run.threadId, role: 'user', content: content.trim(), createdAt: now }
    this.transaction(() => {
      this.insertMessage(message)
      this.db.prepare("UPDATE runs SET status = 'Running' WHERE id = ?").run(runId)
      this.touchThread(run.threadId, now)
    })
    return { message, run: this.requireRun(runId) }
  }

  confirmInteraction(runId: string, confirmedAt: string): RunRecord {
    const run = this.requireRun(runId)
    if (!run.interactionResult) throw new Error('Run 没有 Interaction Design Result。')
    const result: InteractionDesignResult = {
      ...run.interactionResult, interactionStatus: 'CONFIRMED',
      interaction: { ...run.interactionResult.interaction, status: 'CONFIRMED', confirmedAt }, confirmedAt
    }
    this.db.prepare('UPDATE runs SET interaction_result = ? WHERE id = ?').run(JSON.stringify(result), runId)
    return this.requireRun(runId)
  }

  supersedeInteractionConfirmation(runId: string): RunRecord { return this.supersedeFlowConfirmation(runId) }

  rejectInteractionConfirmation(runId: string, content: string): { message: MessageRecord; run: RunRecord } {
    return this.rejectFlowConfirmation(runId, content)
  }

  getPendingPrototype(threadId: string): RunRecord | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE thread_id = ? AND status = 'WaitingConfirmation' AND prototype_result IS NOT NULL ORDER BY started_at DESC LIMIT 1")
      .get(threadId) as Row | undefined
    const run = row ? rowRun(row) : null
    return run?.prototypeResult?.prototypeStatus === 'READY_FOR_CONFIRMATION' ? run : null
  }

  getLatestPrototype(requirementId: string, threadId?: string): { runId: string; result: PrototypeResult } | null {
    const row = threadId
      ? this.db.prepare('SELECT * FROM runs WHERE requirement_id = ? AND thread_id = ? AND prototype_result IS NOT NULL ORDER BY started_at DESC LIMIT 1').get(requirementId, threadId) as Row | undefined
      : this.db.prepare('SELECT * FROM runs WHERE requirement_id = ? AND prototype_result IS NOT NULL ORDER BY started_at DESC LIMIT 1').get(requirementId) as Row | undefined
    const run = row ? rowRun(row) : null
    return run?.prototypeResult ? { runId: run.id, result: run.prototypeResult } : null
  }

  waitForPrototypeConfirmation(runId: string, content: string): { message: MessageRecord; run: RunRecord } {
    const run = this.requireRun(runId)
    if (run.status !== 'Running' || run.prototypeResult?.prototypeStatus !== 'READY_FOR_CONFIRMATION') throw new Error('Run 没有可确认的 Prototype。')
    const now = isoNow()
    const message: MessageRecord = { id: randomUUID(), threadId: run.threadId, role: 'assistant', content, createdAt: now }
    this.transaction(() => {
      this.insertMessage(message)
      this.db.prepare("UPDATE runs SET status = 'WaitingConfirmation' WHERE id = ?").run(runId)
      this.touchThread(run.threadId, now)
    })
    return { message, run: this.requireRun(runId) }
  }

  beginPrototypeConfirmation(runId: string, content: string): { message: MessageRecord; run: RunRecord } {
    const run = this.requireRun(runId)
    if (run.status !== 'WaitingConfirmation' || run.prototypeResult?.prototypeStatus !== 'READY_FOR_CONFIRMATION') throw new Error('Prototype 当前不可确认。')
    const now = isoNow()
    const message: MessageRecord = { id: randomUUID(), threadId: run.threadId, role: 'user', content: content.trim(), createdAt: now }
    this.transaction(() => {
      this.insertMessage(message)
      this.db.prepare("UPDATE runs SET status = 'Running' WHERE id = ?").run(runId)
      this.touchThread(run.threadId, now)
    })
    return { message, run: this.requireRun(runId) }
  }

  confirmPrototype(runId: string, confirmedAt: string): RunRecord {
    const run = this.requireRun(runId)
    if (!run.prototypeResult) throw new Error('Run 没有 Prototype Result。')
    const result: PrototypeResult = {
      ...run.prototypeResult, prototypeStatus: 'CONFIRMED',
      prototype: { ...run.prototypeResult.prototype, status: 'CONFIRMED', confirmedAt }, confirmedAt
    }
    this.db.prepare('UPDATE runs SET prototype_result = ? WHERE id = ?').run(JSON.stringify(result), runId)
    return this.requireRun(runId)
  }

  supersedePrototypeConfirmation(runId: string): RunRecord { return this.supersedeFlowConfirmation(runId) }

  rejectPrototypeConfirmation(runId: string, content: string): { message: MessageRecord; run: RunRecord } {
    return this.rejectFlowConfirmation(runId, content)
  }

  getPendingProductSpec(threadId: string): RunRecord | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE thread_id = ? AND status = 'WaitingConfirmation' AND product_spec_result IS NOT NULL ORDER BY started_at DESC LIMIT 1").get(threadId) as Row | undefined
    const run = row ? rowRun(row) : null
    return run?.productSpecResult?.productSpecStatus === 'READY_FOR_CONFIRMATION' ? run : null
  }

  getLatestProductSpec(requirementId: string, threadId?: string): { runId: string; result: ProductSpecResult } | null {
    const row = threadId
      ? this.db.prepare('SELECT * FROM runs WHERE requirement_id = ? AND thread_id = ? AND product_spec_result IS NOT NULL ORDER BY started_at DESC LIMIT 1').get(requirementId, threadId) as Row | undefined
      : this.db.prepare('SELECT * FROM runs WHERE requirement_id = ? AND product_spec_result IS NOT NULL ORDER BY started_at DESC LIMIT 1').get(requirementId) as Row | undefined
    const run = row ? rowRun(row) : null
    return run?.productSpecResult ? { runId: run.id, result: run.productSpecResult } : null
  }

  waitForProductSpecConfirmation(runId: string, content: string): { message: MessageRecord; run: RunRecord } {
    const run = this.requireRun(runId)
    if (run.status !== 'Running' || run.productSpecResult?.productSpecStatus !== 'READY_FOR_CONFIRMATION') throw new Error('Run 没有可确认的 Product Spec。')
    const now = isoNow(); const message: MessageRecord = { id: randomUUID(), threadId: run.threadId, role: 'assistant', content, createdAt: now }
    this.transaction(() => { this.insertMessage(message); this.db.prepare("UPDATE runs SET status = 'WaitingConfirmation' WHERE id = ?").run(runId); this.touchThread(run.threadId, now) })
    return { message, run: this.requireRun(runId) }
  }

  beginProductSpecConfirmation(runId: string, content: string): { message: MessageRecord; run: RunRecord } {
    const run = this.requireRun(runId)
    if (run.status !== 'WaitingConfirmation' || run.productSpecResult?.productSpecStatus !== 'READY_FOR_CONFIRMATION') throw new Error('Product Spec 当前不可确认。')
    const now = isoNow(); const message: MessageRecord = { id: randomUUID(), threadId: run.threadId, role: 'user', content: content.trim(), createdAt: now }
    this.transaction(() => { this.insertMessage(message); this.db.prepare("UPDATE runs SET status = 'Running' WHERE id = ?").run(runId); this.touchThread(run.threadId, now) })
    return { message, run: this.requireRun(runId) }
  }

  confirmProductSpec(runId: string, confirmedAt: string): RunRecord {
    const run = this.requireRun(runId); if (!run.productSpecResult) throw new Error('Run 没有 Product Spec Result。')
    const result: ProductSpecResult = { ...run.productSpecResult, productSpecStatus: 'CONFIRMED', productSpec: { ...run.productSpecResult.productSpec, status: 'CONFIRMED', confirmedAt }, confirmedAt }
    this.db.prepare('UPDATE runs SET product_spec_result = ? WHERE id = ?').run(JSON.stringify(result), runId)
    return this.requireRun(runId)
  }

  supersedeProductSpecConfirmation(runId: string): RunRecord { return this.supersedeFlowConfirmation(runId) }
  rejectProductSpecConfirmation(runId: string, content: string): { message: MessageRecord; run: RunRecord } { return this.rejectFlowConfirmation(runId, content) }

  getPendingRequirementReview(threadId: string): RunRecord | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE thread_id = ? AND status = 'WaitingConfirmation' AND requirement_review_result IS NOT NULL ORDER BY started_at DESC LIMIT 1").get(threadId) as Row | undefined
    const run = row ? rowRun(row) : null
    return run?.requirementReviewResult?.reviewStatus === 'READY_FOR_CONFIRMATION' ? run : null
  }

  getLatestRequirementReview(requirementId: string, threadId?: string): { runId: string; result: RequirementReviewResult } | null {
    const row = threadId
      ? this.db.prepare('SELECT * FROM runs WHERE requirement_id = ? AND thread_id = ? AND requirement_review_result IS NOT NULL ORDER BY started_at DESC LIMIT 1').get(requirementId, threadId) as Row | undefined
      : this.db.prepare('SELECT * FROM runs WHERE requirement_id = ? AND requirement_review_result IS NOT NULL ORDER BY started_at DESC LIMIT 1').get(requirementId) as Row | undefined
    const run = row ? rowRun(row) : null
    return run?.requirementReviewResult ? { runId: run.id, result: run.requirementReviewResult } : null
  }

  waitForRequirementReviewConfirmation(runId: string, content: string): { message: MessageRecord; run: RunRecord } {
    const run = this.requireRun(runId)
    if (run.status !== 'Running' || run.requirementReviewResult?.reviewStatus !== 'READY_FOR_CONFIRMATION') throw new Error('Run 没有可确认的 Requirement Review。')
    const now = isoNow(); const message: MessageRecord = { id: randomUUID(), threadId: run.threadId, role: 'assistant', content, createdAt: now }
    this.transaction(() => { this.insertMessage(message); this.db.prepare("UPDATE runs SET status = 'WaitingConfirmation' WHERE id = ?").run(runId); this.touchThread(run.threadId, now) })
    return { message, run: this.requireRun(runId) }
  }

  beginRequirementReviewConfirmation(runId: string, content: string): { message: MessageRecord; run: RunRecord } {
    const run = this.requireRun(runId)
    if (run.status !== 'WaitingConfirmation' || run.requirementReviewResult?.reviewStatus !== 'READY_FOR_CONFIRMATION') throw new Error('Requirement Review 当前不可确认。')
    const now = isoNow(); const message: MessageRecord = { id: randomUUID(), threadId: run.threadId, role: 'user', content: content.trim(), createdAt: now }
    this.transaction(() => { this.insertMessage(message); this.db.prepare("UPDATE runs SET status = 'Running' WHERE id = ?").run(runId); this.touchThread(run.threadId, now) })
    return { message, run: this.requireRun(runId) }
  }

  confirmRequirementReview(runId: string, confirmedAt: string): RunRecord {
    const run = this.requireRun(runId); if (!run.requirementReviewResult) throw new Error('Run 没有 Requirement Review Result。')
    const result: RequirementReviewResult = { ...run.requirementReviewResult, reviewStatus: 'CONFIRMED', review: { ...run.requirementReviewResult.review, reviewStatus: 'CONFIRMED', confirmedAt }, confirmedAt }
    this.db.prepare('UPDATE runs SET requirement_review_result = ? WHERE id = ?').run(JSON.stringify(result), runId)
    return this.requireRun(runId)
  }

  supersedeRequirementReviewConfirmation(runId: string): RunRecord { return this.supersedeFlowConfirmation(runId) }
  rejectRequirementReviewConfirmation(runId: string, content: string): { message: MessageRecord; run: RunRecord } { return this.rejectFlowConfirmation(runId, content) }

  beginFlowConfirmation(runId: string, content: string): { message: MessageRecord; run: RunRecord } {
    const run = this.requireRun(runId)
    if (run.status !== 'WaitingConfirmation' || run.flowResult?.flowStatus !== 'READY_FOR_CONFIRMATION') {
      throw new Error('Business Flow 当前不可确认。')
    }
    const now = isoNow()
    const message: MessageRecord = { id: randomUUID(), threadId: run.threadId, role: 'user', content: content.trim(), createdAt: now }
    this.transaction(() => {
      this.insertMessage(message)
      this.db.prepare("UPDATE runs SET status = 'Running' WHERE id = ?").run(runId)
      this.touchThread(run.threadId, now)
    })
    return { message, run: this.requireRun(runId) }
  }

  confirmFlow(runId: string, confirmedAt: string): RunRecord {
    const run = this.requireRun(runId)
    if (!run.flowResult) throw new Error('Run 没有 Business Flow Result。')
    const result: BusinessFlowResult = {
      ...run.flowResult,
      flowStatus: 'CONFIRMED',
      flow: { ...run.flowResult.flow, status: 'CONFIRMED', confirmedAt },
      confirmedAt
    }
    this.db.prepare('UPDATE runs SET flow_result = ? WHERE id = ?').run(JSON.stringify(result), runId)
    return this.requireRun(runId)
  }

  supersedeFlowConfirmation(runId: string): RunRecord {
    const run = this.requireRun(runId)
    if (run.status !== 'WaitingConfirmation') return run
    const now = isoNow()
    this.db.prepare("UPDATE runs SET status = 'Cancelled', finished_at = ? WHERE id = ?").run(now, runId)
    this.touchThread(run.threadId, now)
    return this.requireRun(runId)
  }

  rejectFlowConfirmation(runId: string, content: string): { message: MessageRecord; run: RunRecord } {
    const run = this.requireRun(runId)
    if (run.status !== 'WaitingConfirmation') throw new Error('Business Flow 当前不可拒绝。')
    const now = isoNow()
    const message: MessageRecord = { id: randomUUID(), threadId: run.threadId, role: 'user', content: content.trim(), createdAt: now }
    this.transaction(() => {
      this.insertMessage(message)
      this.db.prepare("UPDATE runs SET status = 'Cancelled', finished_at = ? WHERE id = ?").run(now, runId)
      this.touchThread(run.threadId, now)
    })
    return { message, run: this.requireRun(runId) }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version (version) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM schema_version);
    `)
    const version = Number((this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as Row).version)
    if (version > 25) throw new Error(`数据库版本 ${version} 高于当前应用支持的版本。`)
    if (version === 0) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE workspaces (
            id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, last_opened_at TEXT NOT NULL
          );
          CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE threads (
            id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, requirement_id TEXT NOT NULL, title TEXT NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
          );
          CREATE INDEX threads_requirement_idx ON threads(workspace_id, requirement_id, updated_at DESC);
          CREATE TABLE messages (
            id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
            content TEXT NOT NULL, created_at TEXT NOT NULL,
            FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
          );
          CREATE INDEX messages_thread_idx ON messages(thread_id, created_at);
          CREATE TABLE runs (
            id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, requirement_id TEXT NOT NULL, thread_id TEXT NOT NULL,
            task TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('Pending','Running','WaitingConfirmation','Completed','Failed','Cancelled')),
            skill TEXT, tools TEXT NOT NULL DEFAULT '[]', read_files TEXT NOT NULL DEFAULT '[]', changed_files TEXT NOT NULL DEFAULT '[]',
            started_at TEXT NOT NULL, finished_at TEXT, error TEXT,
            FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
          );
          CREATE INDEX runs_workspace_idx ON runs(workspace_id, started_at DESC);
          UPDATE schema_version SET version = 1;
        `)
      })
    }
    if (version < 2) {
      this.transaction(() => {
        this.db.exec('ALTER TABLE runs ADD COLUMN provider TEXT; ALTER TABLE runs ADD COLUMN model TEXT; UPDATE schema_version SET version = 2;')
      })
    }
    if (version < 3) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE runtime_sessions (
            thread_id TEXT NOT NULL, runtime_type TEXT NOT NULL, runtime_session_id TEXT NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            PRIMARY KEY (thread_id, runtime_type),
            UNIQUE (runtime_type, runtime_session_id),
            FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
          );
          ALTER TABLE runs ADD COLUMN runtime_type TEXT;
          ALTER TABLE runs ADD COLUMN runtime_session_id TEXT;
          ALTER TABLE runs ADD COLUMN runtime_event_summary TEXT NOT NULL DEFAULT '[]';
          UPDATE schema_version SET version = 3;
        `)
      })
    }
    if (version < 4) {
      this.transaction(() => {
        this.db.exec(`
          ALTER TABLE runs ADD COLUMN tool_calls TEXT NOT NULL DEFAULT '[]';
          ALTER TABLE runs ADD COLUMN approval_request TEXT;
          UPDATE schema_version SET version = 4;
        `)
      })
    }
    if (version < 5) {
      this.transaction(() => {
        this.db.exec(`
          ALTER TABLE runs ADD COLUMN skill_version TEXT;
          ALTER TABLE runs ADD COLUMN change_result TEXT;
          UPDATE schema_version SET version = 5;
        `)
      })
    }
    if (version < 6) {
      this.transaction(() => {
        this.db.exec(`
          ALTER TABLE runs ADD COLUMN context_metadata TEXT;
          CREATE TABLE requirement_snapshots (
            workspace_id TEXT NOT NULL, requirement_id TEXT NOT NULL, snapshot TEXT NOT NULL, refreshed_at TEXT NOT NULL,
            PRIMARY KEY (workspace_id, requirement_id),
            FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
          );
          UPDATE schema_version SET version = 6;
        `)
      })
    }
    if (version < 7) {
      this.transaction(() => {
        this.db.exec(`
          ALTER TABLE runs ADD COLUMN analysis_result TEXT;
          UPDATE schema_version SET version = 7;
        `)
      })
    }
    if (version < 8) {
      this.transaction(() => {
        this.db.exec(`
          ALTER TABLE runs ADD COLUMN flow_result TEXT;
          UPDATE schema_version SET version = 8;
        `)
      })
    }
    if (version < 9) {
      this.transaction(() => {
        this.db.exec(`
          ALTER TABLE runs ADD COLUMN solution_result TEXT;
          UPDATE schema_version SET version = 9;
        `)
      })
    }
    if (version < 10) {
      this.transaction(() => {
        this.db.exec(`
          ALTER TABLE runs ADD COLUMN interaction_result TEXT;
          UPDATE schema_version SET version = 10;
        `)
      })
    }
    if (version < 11) {
      this.transaction(() => {
        this.db.exec(`
          ALTER TABLE runs ADD COLUMN prototype_result TEXT;
          UPDATE schema_version SET version = 11;
        `)
      })
    }
    if (version < 12) {
      this.transaction(() => {
        this.db.exec('ALTER TABLE runs ADD COLUMN product_spec_result TEXT; UPDATE schema_version SET version = 12;')
      })
    }
    if (version < 13) {
      this.transaction(() => {
        this.db.exec('ALTER TABLE runs ADD COLUMN requirement_review_result TEXT; UPDATE schema_version SET version = 13;')
      })
    }
    if (version < 14) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE token_usage_calls (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            conversation_id TEXT,
            run_id TEXT,
            stage TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            input_tokens INTEGER NOT NULL CHECK(input_tokens >= 0),
            output_tokens INTEGER NOT NULL CHECK(output_tokens >= 0),
            total_tokens INTEGER NOT NULL CHECK(total_tokens >= 0),
            execution_content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
            FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE SET NULL
          );
          CREATE INDEX token_usage_workspace_idx ON token_usage_calls(workspace_id, created_at DESC);
          CREATE INDEX token_usage_run_idx ON token_usage_calls(run_id);
          UPDATE schema_version SET version = 14;
        `)
      })
    }
    if (version < 15) {
      this.transaction(() => {
        this.db.exec(`
          DROP TABLE IF EXISTS runtime_sessions;
          ALTER TABLE runs ADD COLUMN turn_id TEXT;
          CREATE TABLE turns (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL,
            user_message_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
            FOREIGN KEY (user_message_id) REFERENCES messages(id) ON DELETE CASCADE
          );
          CREATE INDEX turns_thread_idx ON turns(thread_id, created_at);
          CREATE TABLE run_events (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            payload TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
          );
          CREATE INDEX run_events_run_idx ON run_events(run_id, created_at);
          CREATE TABLE thread_memory (
            thread_id TEXT PRIMARY KEY,
            summary TEXT NOT NULL,
            compacted_message_count INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
          );
          CREATE TABLE memory_items (
            id TEXT PRIMARY KEY,
            scope TEXT NOT NULL CHECK(scope IN ('thread','requirement','global')),
            workspace_id TEXT,
            requirement_id TEXT,
            thread_id TEXT,
            category TEXT NOT NULL,
            content TEXT NOT NULL,
            importance INTEGER NOT NULL DEFAULT 1,
            source TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX memory_items_scope_idx ON memory_items(scope, workspace_id, requirement_id, thread_id, updated_at DESC);
          DELETE FROM app_state WHERE key LIKE 'runtime-session:%';
          UPDATE runs SET runtime_type = 'espow-runtime', runtime_session_id = NULL WHERE runtime_type = 'deepseek-harness';
          UPDATE schema_version SET version = 15;
        `)
      })
    }
    if (version < 16) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE analysis_states (
            workspace_id TEXT NOT NULL,
            requirement_id TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            state_json TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            source TEXT NOT NULL DEFAULT 'new',
            updated_at TEXT NOT NULL,
            PRIMARY KEY (requirement_id, thread_id),
            FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
            FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
          );
          CREATE INDEX analysis_states_requirement_idx ON analysis_states(requirement_id, updated_at DESC);
          CREATE TABLE analysis_state_events (
            id TEXT PRIMARY KEY,
            requirement_id TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            run_id TEXT,
            version INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            patch_json TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
            FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE SET NULL
          );
          CREATE INDEX analysis_state_events_thread_idx ON analysis_state_events(thread_id, created_at);
          UPDATE schema_version SET version = 16;
        `)
      })
    }
    if (version < 17) {
      this.transaction(() => {
        this.db.exec(`
          ALTER TABLE token_usage_calls ADD COLUMN original_run_id TEXT;
          ALTER TABLE token_usage_calls ADD COLUMN step_index INTEGER;
          ALTER TABLE token_usage_calls ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE token_usage_calls ADD COLUMN tool_count INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE token_usage_calls ADD COLUMN system_prompt_chars INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE token_usage_calls ADD COLUMN context_package_chars INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE token_usage_calls ADD COLUMN tool_schema_chars INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE token_usage_calls ADD COLUMN assistant_history_chars INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE token_usage_calls ADD COLUMN tool_result_chars INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE token_usage_calls ADD COLUMN analysis_projection_chars INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE token_usage_calls ADD COLUMN recent_conversation_chars INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE token_usage_calls ADD COLUMN full_analysis_state_chars INTEGER NOT NULL DEFAULT 0;
          UPDATE token_usage_calls SET original_run_id = run_id WHERE original_run_id IS NULL;
          UPDATE schema_version SET version = 17;
        `)
      })
    }
    if (version < 18) {
      this.transaction(() => {
        this.db.exec(`
          ALTER TABLE analysis_state_events ADD COLUMN state_json TEXT;
          UPDATE schema_version SET version = 18;
        `)
      })
    }
    if (version < 19) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE shared_requirement_states (
            workspace_id TEXT NOT NULL,
            requirement_id TEXT PRIMARY KEY,
            state_json TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            source TEXT NOT NULL DEFAULT 'new',
            updated_at TEXT NOT NULL,
            FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
          );
          CREATE TABLE lifecycle_stage_states (
            workspace_id TEXT NOT NULL,
            requirement_id TEXT NOT NULL,
            stage_id TEXT NOT NULL,
            state_json TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (requirement_id, stage_id),
            FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
          );
          CREATE INDEX lifecycle_stage_states_requirement_idx ON lifecycle_stage_states(requirement_id, updated_at);
          CREATE TABLE lifecycle_stage_state_events (
            id TEXT PRIMARY KEY,
            requirement_id TEXT NOT NULL,
            stage_id TEXT NOT NULL,
            run_id TEXT,
            version INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            state_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE SET NULL
          );
          CREATE INDEX lifecycle_stage_state_events_requirement_idx ON lifecycle_stage_state_events(requirement_id, stage_id, created_at);
          UPDATE schema_version SET version = 19;
        `)
      })
    }
    if (version < 20) {
      this.transaction(() => {
        this.db.exec(`
          ALTER TABLE token_usage_calls ADD COLUMN turn_id TEXT;
          ALTER TABLE token_usage_calls ADD COLUMN call_id TEXT;
          ALTER TABLE token_usage_calls ADD COLUMN call_index INTEGER NOT NULL DEFAULT 1;
          ALTER TABLE token_usage_calls ADD COLUMN route_type TEXT NOT NULL DEFAULT 'llm';
          ALTER TABLE token_usage_calls ADD COLUMN call_reason TEXT NOT NULL DEFAULT 'other';
          ALTER TABLE token_usage_calls ADD COLUMN duration_ms INTEGER;
          ALTER TABLE token_usage_calls ADD COLUMN usage_source TEXT NOT NULL DEFAULT 'provider_reported';
          ALTER TABLE token_usage_calls ADD COLUMN breakdown_type TEXT NOT NULL DEFAULT 'estimated_breakdown';
          ALTER TABLE token_usage_calls ADD COLUMN estimated_input_tokens INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE token_usage_calls ADD COLUMN input_breakdown TEXT NOT NULL DEFAULT '[]';
          UPDATE token_usage_calls SET turn_id = (SELECT runs.turn_id FROM runs WHERE runs.id = token_usage_calls.run_id);
          UPDATE token_usage_calls SET call_index = COALESCE(step_index, 1);
          UPDATE schema_version SET version = 20;
        `)
      })
    }
    if (version < 21) {
      this.transaction(() => {
        this.db.exec(`
          ALTER TABLE token_usage_calls ADD COLUMN history_tokens INTEGER NOT NULL DEFAULT 0;
          UPDATE token_usage_calls
          SET history_tokens = COALESCE((
            SELECT CAST(json_extract(value, '$.tokens') AS INTEGER)
            FROM json_each(token_usage_calls.input_breakdown)
            WHERE json_extract(value, '$.source') = 'history'
            LIMIT 1
          ), 0)
          WHERE json_valid(input_breakdown);
          UPDATE schema_version SET version = 21;
        `)
      })
    }
    if (version < 22) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE analysis_mainlines (
            workspace_id TEXT NOT NULL,
            requirement_id TEXT PRIMARY KEY,
            last_thread_id TEXT,
            state_json TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            source TEXT NOT NULL DEFAULT 'new',
            updated_at TEXT NOT NULL,
            FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
          );
          INSERT INTO analysis_mainlines (workspace_id, requirement_id, last_thread_id, state_json, version, source, updated_at)
          SELECT a.workspace_id, a.requirement_id, a.thread_id, a.state_json, a.version, a.source, a.updated_at
          FROM analysis_states a
          WHERE a.rowid = (SELECT b.rowid FROM analysis_states b WHERE b.requirement_id = a.requirement_id ORDER BY b.updated_at DESC, b.rowid DESC LIMIT 1);
          UPDATE schema_version SET version = 22;
        `)
      })
    }
    if (version < 23) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE work_context_company (
            id INTEGER PRIMARY KEY CHECK(id = 1), name TEXT NOT NULL DEFAULT '', industry TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '', core_business TEXT NOT NULL DEFAULT '[]', regions TEXT NOT NULL DEFAULT '[]',
            terms TEXT NOT NULL DEFAULT '[]', raw_context TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
          );
          CREATE TABLE work_context_systems (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, alias TEXT NOT NULL DEFAULT '', type TEXT NOT NULL CHECK(type IN ('internal','external')),
            positioning TEXT NOT NULL DEFAULT '', core_users TEXT NOT NULL DEFAULT '[]', core_capabilities TEXT NOT NULL DEFAULT '[]',
            boundary TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          CREATE TABLE work_context_relations (
            id TEXT PRIMARY KEY, source_system_id TEXT NOT NULL, relation_type TEXT NOT NULL, custom_relation_name TEXT NOT NULL DEFAULT '',
            target_system_id TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            CHECK(source_system_id <> target_system_id),
            FOREIGN KEY (source_system_id) REFERENCES work_context_systems(id) ON DELETE RESTRICT,
            FOREIGN KEY (target_system_id) REFERENCES work_context_systems(id) ON DELETE RESTRICT
          );
          CREATE INDEX work_context_relations_source_idx ON work_context_relations(source_system_id);
          CREATE INDEX work_context_relations_target_idx ON work_context_relations(target_system_id);
          CREATE TABLE requirement_system_bindings (
            workspace_id TEXT NOT NULL, requirement_id TEXT NOT NULL, system_id TEXT NOT NULL, updated_at TEXT NOT NULL,
            PRIMARY KEY (workspace_id, requirement_id),
            FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
            FOREIGN KEY (system_id) REFERENCES work_context_systems(id) ON DELETE RESTRICT
          );
          CREATE INDEX requirement_system_bindings_system_idx ON requirement_system_bindings(system_id);
          UPDATE schema_version SET version = 23;
        `)
      })
    }
    if (version < 24) {
      this.transaction(() => {
        this.db.exec(`
          ALTER TABLE messages ADD COLUMN questions_json TEXT NOT NULL DEFAULT '[]';
          INSERT OR IGNORE INTO app_state (key, value)
          VALUES ('question_delivery_contract_enabled_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
          UPDATE schema_version SET version = 24;
        `)
      })
    }
    if (version < 25) {
      this.db.exec('PRAGMA foreign_keys = OFF;')
      try {
        this.db.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE runs_v25 (
            id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, requirement_id TEXT NOT NULL, thread_id TEXT NOT NULL,
            task TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('Pending','Running','WaitingConfirmation','Cancelling','Completed','Failed','Cancelled','Interrupted')),
            skill TEXT, tools TEXT NOT NULL DEFAULT '[]', read_files TEXT NOT NULL DEFAULT '[]', changed_files TEXT NOT NULL DEFAULT '[]',
            started_at TEXT NOT NULL, finished_at TEXT, error TEXT, provider TEXT, model TEXT, runtime_type TEXT, runtime_session_id TEXT,
            runtime_event_summary TEXT NOT NULL DEFAULT '[]', tool_calls TEXT NOT NULL DEFAULT '[]', approval_request TEXT, skill_version TEXT,
            change_result TEXT, context_metadata TEXT, analysis_result TEXT, flow_result TEXT, solution_result TEXT, interaction_result TEXT,
            prototype_result TEXT, product_spec_result TEXT, requirement_review_result TEXT, turn_id TEXT,
            FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
          );
          INSERT INTO runs_v25 (id, workspace_id, requirement_id, thread_id, task, status, skill, tools, read_files, changed_files, started_at, finished_at, error, provider, model, runtime_type, runtime_session_id, runtime_event_summary, tool_calls, approval_request, skill_version, change_result, context_metadata, analysis_result, flow_result, solution_result, interaction_result, prototype_result, product_spec_result, requirement_review_result, turn_id)
          SELECT id, workspace_id, requirement_id, thread_id, task, status, skill, tools, read_files, changed_files, started_at, finished_at, error, provider, model, runtime_type, runtime_session_id, runtime_event_summary, tool_calls, approval_request, skill_version, change_result, context_metadata, analysis_result, flow_result, solution_result, interaction_result, prototype_result, product_spec_result, requirement_review_result, turn_id FROM runs;
          DROP TABLE runs;
          ALTER TABLE runs_v25 RENAME TO runs;
          CREATE INDEX runs_workspace_idx ON runs(workspace_id, started_at DESC);
          UPDATE schema_version SET version = 25;
          COMMIT;
        `)
      } catch (error) {
        try { this.db.exec('ROLLBACK;') } catch {}
        throw error
      } finally {
        this.db.exec('PRAGMA foreign_keys = ON;')
      }
    }
  }

  setChangeResult(runId: string, changeResult: ChangeResult): RunRecord {
    this.requireRun(runId)
    this.db.prepare('UPDATE runs SET change_result = ? WHERE id = ?').run(JSON.stringify(changeResult), runId)
    return this.requireRun(runId)
  }

  setAnalysisResult(runId: string, analysisResult: RequirementAnalysisResult): RunRecord {
    this.requireRun(runId)
    this.db.prepare('UPDATE runs SET analysis_result = ? WHERE id = ?').run(JSON.stringify(analysisResult), runId)
    return this.requireRun(runId)
  }

  private readModelConfig(provider: ModelProviderId): StoredModelConfig {
    const fallback: StoredModelConfig = { ...defaultConfigs[provider], apiKey: '' }
    const value = this.getState(`model-config:${provider}`)
    if (!value) return fallback
    try {
      const parsed = JSON.parse(value) as Partial<StoredModelConfig>
      return {
        provider,
        apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
        model: typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model : fallback.model,
        baseUrl: typeof parsed.baseUrl === 'string' && parsed.baseUrl.trim() ? parsed.baseUrl : fallback.baseUrl
      }
    } catch {
      return fallback
    }
  }

  private requireCompleteModelConfig(config: StoredModelConfig): StoredModelConfig {
    if (!config.apiKey) throw new Error('尚未配置 API Key，请先前往设置。')
    if (!config.model) throw new Error('Model 不能为空。')
    if (!config.baseUrl) throw new Error('Base URL 不能为空。')
    try {
      const url = new URL(config.baseUrl)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error()
    } catch {
      throw new Error('Base URL 格式无效，请填写完整的 http(s) 地址。')
    }
    return config
  }

  private finishRun(runId: string, status: 'Failed' | 'Cancelled', error: string | null): RunRecord {
    const run = this.requireRun(runId)
    if (run.status !== 'Running') return run
    const now = isoNow()
    this.db.prepare('UPDATE runs SET status = ?, finished_at = ?, error = ? WHERE id = ?').run(status, now, error, runId)
    this.touchThread(run.threadId, now)
    return this.requireRun(runId)
  }

  private recoverInterruptedRuns(): void {
    const now = isoNow()
    this.db.prepare("UPDATE runs SET status = 'Interrupted', finished_at = ?, error = ? WHERE status IN ('Running','Cancelling')")
      .run(now, '应用在模型回复完成前退出，本次 Run 已中断。')
  }

  private getState(key: string): string | null {
    this.assertOpen('getState')
    const row = this.db.prepare('SELECT value FROM app_state WHERE key = ?').get(key) as Row | undefined
    return row ? String(row.value) : null
  }

  private setState(key: string, value: string): void {
    this.assertOpen('setState')
    this.db.prepare(`INSERT INTO app_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value)
  }

  private deleteState(key: string): void {
    this.assertOpen('deleteState')
    this.db.prepare('DELETE FROM app_state WHERE key = ?').run(key)
  }

  private assertOpen(operation: string): void {
    if (this.db.isOpen) return
    console.error(`[persistence] SQLite is closed before ${operation}`)
    const error = new Error(`PersistenceService cannot ${operation}: database is closed`)
    reportDiagnosticError(error, { layer: 'persistence', module: 'PersistenceService', operation, errorCode: 'DB_NOT_OPEN' })
    throw error
  }

  private insertMessage(message: MessageRecord): void {
    this.db.prepare('INSERT INTO messages (id, thread_id, role, content, questions_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(message.id, message.threadId, message.role, message.content, JSON.stringify(message.questions ?? []), message.createdAt)
  }

  private touchThread(threadId: string, updatedAt: string): void {
    this.db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(updatedAt, threadId)
  }

  private requireThread(threadId: string): ThreadRecord {
    const row = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(threadId) as Row | undefined
    if (!row) throw new Error('Thread 不存在。')
    return rowThread(row)
  }

  private requireRun(runId: string): RunRecord {
    const row = this.db.prepare(`SELECT runs.*, threads.title AS thread_title FROM runs
      LEFT JOIN threads ON threads.id = runs.thread_id WHERE runs.id = ?`).get(runId) as Row | undefined
    if (!row) throw new Error('Run 不存在。')
    return rowRun(row)
  }

  private transaction(action: () => void): void {
    this.db.exec('BEGIN')
    try {
      action()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
