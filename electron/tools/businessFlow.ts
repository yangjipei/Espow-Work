import type {
  BusinessFlowModel, BusinessFlowReadiness, BusinessFlowStatus, FlowActor, FlowEdge, FlowEdgeType,
  FlowExit, FlowNode, FlowNodeType, FlowStructureDiff
} from '../../src/skills'

const nodeTypes = new Set<FlowNodeType>(['start', 'action', 'decision', 'system', 'wait', 'end'])
const edgeTypes = new Set<FlowEdgeType>(['main', 'branch', 'exception', 'recovery'])
const draftStatuses = new Set<BusinessFlowStatus>(['DRAFT', 'WAITING_CLARIFICATION', 'READY_FOR_CONFIRMATION'])

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} 必须是对象。`)
  return value as Record<string, unknown>
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 必须是非空字符串。`)
  return value.trim()
}

function nullableText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null
  return text(value, field)
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error(`${field} 必须是字符串数组。`)
  return value.map((item) => item.trim()).filter(Boolean)
}

function objects<T>(value: unknown, field: string, parser: (item: Record<string, unknown>, index: number) => T): T[] {
  if (!Array.isArray(value)) throw new Error(`${field} 必须是数组。`)
  return value.map((item, index) => parser(record(item, `${field}[${index}]`), index))
}

export function parseBusinessFlowJson(raw: string, allowConfirmed = false): BusinessFlowModel {
  let value: Record<string, unknown>
  try { value = record(JSON.parse(raw), 'Business Flow') } catch (error) {
    throw new Error(error instanceof SyntaxError ? 'resultJson 必须是合法的 JSON 对象。' : (error as Error).message)
  }
  const status = text(value.status, 'status') as BusinessFlowStatus
  if (!draftStatuses.has(status) && !(allowConfirmed && status === 'CONFIRMED')) throw new Error('模型只能提交 DRAFT、WAITING_CLARIFICATION 或 READY_FOR_CONFIRMATION。')
  const scope = record(value.scope, 'scope')
  const actors = objects(value.actors, 'actors', (item): FlowActor => ({
    id: text(item.id, 'actor.id'), name: text(item.name, 'actor.name'), role: text(item.role, 'actor.role'),
    source: text(item.source, 'actor.source')
  }))
  const nodes = objects(value.nodes, 'nodes', (item): FlowNode => {
    const type = text(item.type, 'node.type') as FlowNodeType
    if (!nodeTypes.has(type)) throw new Error(`不支持的节点类型：${type}`)
    return {
      id: text(item.id, 'node.id'), type, title: text(item.title, 'node.title'),
      description: typeof item.description === 'string' ? item.description.trim() : '',
      actorId: nullableText(item.actorId, 'node.actorId'), stage: text(item.stage, 'node.stage'),
      stateChange: nullableText(item.stateChange, 'node.stateChange'),
      sourceScenarioIds: strings(item.sourceScenarioIds, 'node.sourceScenarioIds'),
      sourceDecisionIds: strings(item.sourceDecisionIds, 'node.sourceDecisionIds')
    }
  })
  const edges = objects(value.edges, 'edges', (item): FlowEdge => {
    const type = text(item.type, 'edge.type') as FlowEdgeType
    if (!edgeTypes.has(type)) throw new Error(`不支持的连线类型：${type}`)
    return {
      id: text(item.id, 'edge.id'), from: text(item.from, 'edge.from'), to: text(item.to, 'edge.to'),
      label: typeof item.label === 'string' ? item.label.trim() : '', type
    }
  })
  const exits = objects(value.exits, 'exits', (item): FlowExit => ({
    nodeId: text(item.nodeId, 'exit.nodeId'), condition: text(item.condition, 'exit.condition'),
    recordBehavior: text(item.recordBehavior, 'exit.recordBehavior'), stateImpact: text(item.stateImpact, 'exit.stateImpact'),
    retryable: text(item.retryable, 'exit.retryable')
  }))
  const semantic = record(value.semanticChecks, 'semanticChecks')
  const check = (key: keyof BusinessFlowModel['semanticChecks']): boolean => {
    if (typeof semantic[key] !== 'boolean') throw new Error(`semanticChecks.${key} 必须是布尔值。`)
    return semantic[key] as boolean
  }
  const sourceAnalysisStatus = text(value.sourceAnalysisStatus, 'sourceAnalysisStatus')
  if (sourceAnalysisStatus !== 'confirmed' && sourceAnalysisStatus !== 'draft') throw new Error('sourceAnalysisStatus 必须是 confirmed 或 draft。')
  return {
    id: text(value.id, 'id'), name: text(value.name, 'name'),
    scope: { goal: text(scope.goal, 'scope.goal'), included: strings(scope.included, 'scope.included'), excluded: strings(scope.excluded, 'scope.excluded') },
    status, actors, nodes, edges, entry: text(value.entry, 'entry'), exits,
    openQuestions: strings(value.openQuestions, 'openQuestions'),
    semanticChecks: {
      mainScenarioCovered: check('mainScenarioCovered'), blockersHandled: check('blockersHandled'),
      keyExitsCovered: check('keyExitsCovered'), asyncRecoveryCovered: check('asyncRecoveryCovered'),
      closedLoop: check('closedLoop')
    },
    sourceAnalysisPath: text(value.sourceAnalysisPath, 'sourceAnalysisPath'),
    sourceAnalysisStatus, confirmedAt: null
  }
}

function duplicates(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) !== index)
}

function reachesEnd(entry: string, nodes: Map<string, FlowNode>, edges: FlowEdge[], mainOnly: boolean): boolean {
  const queue = [entry]
  const visited = new Set<string>()
  while (queue.length) {
    const id = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    if (nodes.get(id)?.type === 'end') return true
    for (const edge of edges) if (edge.from === id && (!mainOnly || edge.type === 'main')) queue.push(edge.to)
  }
  return false
}

export function businessFlowReadiness(flow: BusinessFlowModel): BusinessFlowReadiness {
  const missing: string[] = []
  const warnings: string[] = []
  const nodeIds = flow.nodes.map((node) => node.id)
  const edgeIds = flow.edges.map((edge) => edge.id)
  const actorIds = new Set(flow.actors.map((actor) => actor.id))
  const nodes = new Map(flow.nodes.map((node) => [node.id, node]))
  if (duplicates(nodeIds).length) missing.push('duplicate_node_ids')
  if (duplicates(edgeIds).length) missing.push('duplicate_edge_ids')
  if (!nodes.has(flow.entry)) missing.push('entry_missing')
  else if (nodes.get(flow.entry)?.type !== 'start') missing.push('entry_not_start')
  if (!flow.nodes.some((node) => node.type === 'end')) missing.push('end_missing')
  if (!flow.exits.length) missing.push('exits_missing')
  for (const edge of flow.edges) if (!nodes.has(edge.from) || !nodes.has(edge.to)) missing.push(`edge_target:${edge.id}`)
  for (const node of flow.nodes) if (node.actorId && !actorIds.has(node.actorId)) missing.push(`actor_reference:${node.id}`)
  for (const exit of flow.exits) if (!nodes.has(exit.nodeId)) missing.push(`exit_reference:${exit.nodeId}`)
  if (nodes.has(flow.entry) && !reachesEnd(flow.entry, nodes, flow.edges, true)) missing.push('main_flow_not_connected')
  for (const node of flow.nodes) {
    const incoming = flow.edges.filter((edge) => edge.to === node.id)
    const outgoing = flow.edges.filter((edge) => edge.from === node.id)
    if (node.id !== flow.entry && !incoming.length) missing.push(`isolated_incoming:${node.id}`)
    if (node.type !== 'end' && !outgoing.length) missing.push(`isolated_outgoing:${node.id}`)
    if (node.type === 'decision') {
      if (outgoing.length < 2) missing.push(`decision_branches:${node.id}`)
      if (outgoing.some((edge) => !edge.label)) missing.push(`decision_label:${node.id}`)
      if (new Set(outgoing.map((edge) => edge.label.toLowerCase())).size !== outgoing.length) missing.push(`decision_duplicate_labels:${node.id}`)
    }
    if (!reachesEnd(node.id, nodes, flow.edges, false)) missing.push(`unclosed_path:${node.id}`)
  }
  if (flow.status === 'WAITING_CLARIFICATION' && !flow.openQuestions.length) missing.push('clarification_question_missing')
  if (flow.status === 'READY_FOR_CONFIRMATION' && flow.openQuestions.length) missing.push('blocking_open_questions')
  if (flow.sourceAnalysisStatus === 'draft' && flow.status === 'READY_FOR_CONFIRMATION') missing.push('confirmed_analysis_required')
  if (flow.nodes.some((node) => node.type === 'wait') && !flow.edges.some((edge) => edge.type === 'recovery')) {
    warnings.push('async_recovery_edge_missing')
  }
  const semanticReady = Object.values(flow.semanticChecks).every(Boolean)
  return { deterministicPassed: missing.length === 0, semanticReady, missing: [...new Set(missing)], warnings }
}

function stable(value: unknown): string { return JSON.stringify(value) }

export function businessFlowDiff(previous: BusinessFlowModel | null, current: BusinessFlowModel): FlowStructureDiff {
  const previousNodes = new Map((previous?.nodes ?? []).map((node) => [node.id, node]))
  const currentNodes = new Map(current.nodes.map((node) => [node.id, node]))
  const previousEdges = new Map((previous?.edges ?? []).map((edge) => [edge.id, edge]))
  const currentEdges = new Map(current.edges.map((edge) => [edge.id, edge]))
  return {
    addedNodes: [...currentNodes.keys()].filter((id) => !previousNodes.has(id)),
    removedNodes: [...previousNodes.keys()].filter((id) => !currentNodes.has(id)),
    changedNodes: [...currentNodes.keys()].filter((id) => previousNodes.has(id) && stable(previousNodes.get(id)) !== stable(currentNodes.get(id))),
    addedEdges: [...currentEdges.keys()].filter((id) => !previousEdges.has(id)),
    removedEdges: [...previousEdges.keys()].filter((id) => !currentEdges.has(id)),
    changedEdges: [...currentEdges.keys()].filter((id) => previousEdges.has(id) && stable(previousEdges.get(id)) !== stable(currentEdges.get(id)))
  }
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;')
}

function badge(type: FlowNodeType): string {
  return ({ start: '开始', action: '业务动作', decision: '判断', system: '系统处理', wait: '等待/回流', end: '结束' })[type]
}

export function renderBusinessFlowHtml(flow: BusinessFlowModel): string {
  const stages = [...new Set(flow.nodes.map((node) => node.stage))]
  const mainEdges = flow.edges.filter((edge) => edge.type === 'main')
  const ordered: FlowNode[] = []
  const seen = new Set<string>()
  let current: string | undefined = flow.entry
  while (current && !seen.has(current)) {
    seen.add(current)
    const node = flow.nodes.find((item) => item.id === current)
    if (node) ordered.push(node)
    current = mainEdges.find((edge) => edge.from === current)?.to
  }
  const main = ordered.map((node, index) => {
    const edge = index < ordered.length - 1 ? mainEdges.find((item) => item.from === node.id && item.to === ordered[index + 1].id) : null
    return `<article class="node ${node.type}"><div class="node-meta"><span>${badge(node.type)}</span><code>${escapeHtml(node.id)}</code></div><h3>${escapeHtml(node.title)}</h3>${node.description ? `<p>${escapeHtml(node.description)}</p>` : ''}<div class="tags"><em>${escapeHtml(node.stage)}</em>${node.actorId ? `<em>${escapeHtml(flow.actors.find((actor) => actor.id === node.actorId)?.name ?? node.actorId)}</em>` : ''}${node.stateChange ? `<em>${escapeHtml(node.stateChange)}</em>` : ''}</div></article>${edge ? `<div class="arrow"><span>${escapeHtml(edge.label || '继续')}</span>↓</div>` : ''}`
  }).join('')
  const detailSections = stages.map((stage) => {
    const nodes = flow.nodes.filter((node) => node.stage === stage && !seen.has(node.id))
    if (!nodes.length) return ''
    return `<details class="supplement"><summary>${escapeHtml(stage)} · 分支与异常 <span>${nodes.length}</span></summary><div class="detail-grid">${nodes.map((node) => `<article class="mini-node ${node.type}"><b>${badge(node.type)} · ${escapeHtml(node.title)}</b><p>${escapeHtml(node.description || '—')}</p><small>${escapeHtml(flow.edges.filter((edge) => edge.from === node.id).map((edge) => `${edge.label || edge.type} → ${edge.to}`).join('；') || '终止')}</small></article>`).join('')}</div></details>`
  }).join('')
  const exits = flow.exits.map((item) => `<tr><td>${escapeHtml(flow.nodes.find((node) => node.id === item.nodeId)?.title ?? item.nodeId)}</td><td>${escapeHtml(item.condition)}</td><td>${escapeHtml(item.recordBehavior)}</td><td>${escapeHtml(item.stateImpact)}</td><td>${escapeHtml(item.retryable)}</td></tr>`).join('')
  const trace = flow.nodes.filter((node) => node.sourceScenarioIds.length || node.sourceDecisionIds.length).map((node) => `<li><b>${escapeHtml(node.title)}</b><span>${escapeHtml([...node.sourceScenarioIds, ...node.sourceDecisionIds].join(' · '))}</span></li>`).join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(flow.name)}</title><style>:root{color-scheme:light;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f4f7fb}*{box-sizing:border-box}body{margin:0}.page{max-width:1080px;margin:auto;padding:40px 28px 72px}header{background:linear-gradient(135deg,#fff,#eef4ff);border:1px solid #dce6f5;border-radius:20px;padding:28px;box-shadow:0 12px 35px #24466b12}header small{color:#3970b7;font-weight:700;letter-spacing:.08em}h1{margin:.35rem 0 .6rem;font-size:30px}header p{margin:.3rem 0;color:#526071}.scope{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.scope span,.tags em{font-style:normal;background:#eaf1fb;color:#315d91;border-radius:999px;padding:5px 9px;font-size:12px}.toolbar{display:flex;justify-content:flex-end;gap:8px;margin:18px 0}.toolbar button{border:1px solid #cdd9e8;background:#fff;border-radius:9px;padding:8px 12px;color:#315d91;cursor:pointer}.layout{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(280px,.8fr);gap:18px}.panel{background:#fff;border:1px solid #dde5ef;border-radius:16px;padding:22px}.panel h2{margin:0 0 18px;font-size:18px}.main-flow{max-width:620px;margin:auto}.node{border:1px solid #d8e2ee;border-left:5px solid #4a7fbe;border-radius:13px;padding:15px 16px;background:#fff}.node.start,.node.end{border-left-color:#2d9c78}.node.decision{border-left-color:#d7942a;background:#fffbf1}.node.wait{border-left-color:#8b6cc3}.node-meta{display:flex;justify-content:space-between;color:#65758a;font-size:11px}.node h3{margin:7px 0 4px;font-size:16px}.node p,.mini-node p{color:#5d6979;margin:5px 0;line-height:1.5}.tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}.arrow{text-align:center;color:#7c8ca1;font-size:22px;padding:6px}.arrow span{display:block;font-size:11px}.supplement{border:1px solid #e1e7ef;border-radius:11px;margin:0 0 10px}.supplement summary{padding:13px;cursor:pointer;font-weight:650}.supplement summary span{float:right;color:#78879a}.detail-grid{display:grid;gap:9px;padding:0 12px 12px}.mini-node{border-left:3px solid #86a7ce;background:#f8fafc;border-radius:8px;padding:10px 12px}.mini-node small{color:#78879a}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:9px;border-bottom:1px solid #e6ebf1;vertical-align:top}.trace{padding:0;list-style:none}.trace li{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid #edf0f4}.trace span{color:#6d7989;font-size:12px}.questions{color:#a66022}@media(max-width:800px){.layout{grid-template-columns:1fr}.page{padding:20px 14px}}</style></head><body><main class="page"><header><small>ESPOW · BUSINESS FLOW · ${escapeHtml(flow.status)}</small><h1>${escapeHtml(flow.name)}</h1><p>${escapeHtml(flow.scope.goal)}</p><div class="scope">${flow.actors.map((actor) => `<span>${escapeHtml(actor.name)}</span>`).join('')}</div></header><div class="toolbar"><button onclick="document.querySelectorAll('details').forEach(x=>x.open=true)">全部展开</button><button onclick="document.querySelectorAll('details').forEach(x=>x.open=false)">全部收起</button></div><div class="layout"><section class="panel"><h2>主流程</h2><div class="main-flow">${main}</div></section><aside><section class="panel"><h2>分支、异常与恢复</h2>${detailSections || '<p>当前没有独立补充路径。</p>'}</section></aside></div><section class="panel" style="margin-top:18px"><h2>退出条件</h2><table><thead><tr><th>出口</th><th>条件</th><th>记录</th><th>状态影响</th><th>可重试</th></tr></thead><tbody>${exits}</tbody></table></section><section class="panel" style="margin-top:18px"><details class="supplement"><summary>来源追踪</summary><ul class="trace">${trace || '<li>—</li>'}</ul></details><details class="supplement"><summary>Open Questions</summary><div class="questions">${flow.openQuestions.length ? `<ul>${flow.openQuestions.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '<p>无阻断问题。</p>'}</div></details></section></main></body></html>`
}
