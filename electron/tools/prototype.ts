import { Script } from 'node:vm'
import { createTwoFilesPatch } from 'diff'
import type { PrototypeMetadata, PrototypeReadiness } from '../../src/skills'

const statuses = new Set(['DRAFT', 'WAITING_CLARIFICATION', 'READY_FOR_CONFIRMATION'])

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

function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} 必须是布尔值。`)
  return value
}

export function parsePrototypeMetadata(raw: string, allowConfirmed = false): PrototypeMetadata {
  let value: Record<string, unknown>
  try { value = record(JSON.parse(raw), 'Prototype Metadata') } catch (error) {
    throw new Error(error instanceof SyntaxError ? 'metadataJson 必须是合法的 JSON 对象。' : (error as Error).message)
  }
  const status = text(value.status, 'status')
  if (!statuses.has(status) && !(allowConfirmed && status === 'CONFIRMED')) throw new Error('Prototype status 无效。')
  const mode = text(value.mode, 'mode')
  if (mode !== 'create' && mode !== 'delta') throw new Error('mode 必须是 create 或 delta。')
  const sourceInteractionStatus = text(value.sourceInteractionStatus, 'sourceInteractionStatus')
  if (sourceInteractionStatus !== 'confirmed' && sourceInteractionStatus !== 'draft') throw new Error('sourceInteractionStatus 必须是 confirmed 或 draft。')
  const version = Number(value.version)
  if (!Number.isInteger(version) || version < 1) throw new Error('version 必须是正整数。')
  const semantic = record(value.semanticChecks, 'semanticChecks')
  return {
    id: text(value.id, 'id'), name: text(value.name, 'name'), version,
    productSurface: text(value.productSurface, 'productSurface'), mode, status: status as PrototypeMetadata['status'],
    sourceInteractionPath: text(value.sourceInteractionPath, 'sourceInteractionPath'),
    sourceInteractionStatus, sourceSolutionPath: nullableText(value.sourceSolutionPath, 'sourceSolutionPath'),
    sourceCapabilityIds: strings(value.sourceCapabilityIds, 'sourceCapabilityIds'),
    sourceFlowIds: strings(value.sourceFlowIds, 'sourceFlowIds'),
    existingPrototypePath: nullableText(value.existingPrototypePath, 'existingPrototypePath'),
    uiReferencePaths: strings(value.uiReferencePaths, 'uiReferencePaths'),
    requiredDomIds: strings(value.requiredDomIds, 'requiredDomIds'),
    interactiveDomIds: strings(value.interactiveDomIds, 'interactiveDomIds'),
    addedComponents: strings(value.addedComponents, 'addedComponents'),
    changedComponents: strings(value.changedComponents, 'changedComponents'),
    removedComponents: strings(value.removedComponents, 'removedComponents'),
    interactionChanges: strings(value.interactionChanges, 'interactionChanges'),
    stateChanges: strings(value.stateChanges, 'stateChanges'),
    openQuestions: strings(value.openQuestions, 'openQuestions'),
    interactionConflicts: strings(value.interactionConflicts, 'interactionConflicts'),
    semanticChecks: {
      interactionImplemented: bool(semantic.interactionImplemented, 'semanticChecks.interactionImplemented'),
      mainUserPathComplete: bool(semantic.mainUserPathComplete, 'semanticChecks.mainUserPathComplete'),
      importantStatesVisible: bool(semantic.importantStatesVisible, 'semanticChecks.importantStatesVisible'),
      actionsHaveFeedback: bool(semantic.actionsHaveFeedback, 'semanticChecks.actionsHaveFeedback'),
      cognitiveLoadAcceptable: bool(semantic.cognitiveLoadAcceptable, 'semanticChecks.cognitiveLoadAcceptable'),
      noUnconfirmedFeatures: bool(semantic.noUnconfirmedFeatures, 'semanticChecks.noUnconfirmedFeatures')
    },
    confirmedAt: nullableText(value.confirmedAt, 'confirmedAt')
  }
}

function htmlIds(html: string): string[] {
  return [...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1])
}

function hasBoundInteraction(html: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const element = new RegExp(`<(?:button|a|input|select|textarea|summary)[^>]*\\bid=["']${escaped}["'][^>]*>`, 'i')
  const inlineHandler = new RegExp(`\\bid=["']${escaped}["'][^>]*\\bon(?:click|change|input|submit|keydown)=`, 'i')
  const listener = new RegExp(`(?:getElementById\\(["']${escaped}["']\\)|querySelector\\(["']#${escaped}["']\\))[\\s\\S]{0,160}?addEventListener\\(`, 'i')
  return inlineHandler.test(html) || listener.test(html) || element.test(html) && /<form\b/i.test(html)
}

function metaContent(html: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return html.match(new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, 'i'))?.[1]
    ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${escaped}["'][^>]*>`, 'i'))?.[1]
    ?? null
}

export function prototypeReadiness(metadata: PrototypeMetadata, html: string, targetPath: string): PrototypeReadiness {
  const missing: string[] = []
  const warnings: string[] = []
  if (!/^\s*<!doctype html>/i.test(html)) missing.push('doctype_missing')
  for (const tag of ['html', 'head', 'title', 'body']) if (!new RegExp(`<${tag}\\b`, 'i').test(html)) missing.push(`${tag}_missing`)
  if (!/<(?:main|div)\b[^>]*\bid=["'][^"']+["']/i.test(html)) missing.push('main_container_missing')
  if (metaContent(html, 'espow:prototype-id') !== metadata.id) missing.push('prototype_id_metadata_missing')
  if (metaContent(html, 'espow:prototype-version') !== String(metadata.version)) missing.push('prototype_version_metadata_missing')
  if (metaContent(html, 'espow:source-interaction') !== metadata.sourceInteractionPath) missing.push('source_interaction_metadata_missing')
  const capabilityTrace = new Set((metaContent(html, 'espow:source-capabilities') ?? '').split(',').map((item) => item.trim()).filter(Boolean))
  const flowTrace = new Set((metaContent(html, 'espow:source-flows') ?? '').split(',').map((item) => item.trim()).filter(Boolean))
  for (const id of metadata.sourceCapabilityIds) if (!capabilityTrace.has(id)) missing.push(`capability_trace_missing:${id}`)
  for (const id of metadata.sourceFlowIds) if (!flowTrace.has(id)) missing.push(`flow_trace_missing:${id}`)
  const ids = htmlIds(html)
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))]
  for (const id of duplicates) missing.push(`duplicate_dom_id:${id}`)
  const idSet = new Set(ids)
  for (const id of metadata.requiredDomIds) if (!idSet.has(id)) missing.push(`required_dom_missing:${id}`)
  for (const id of metadata.interactiveDomIds) {
    if (!idSet.has(id)) missing.push(`interactive_dom_missing:${id}`)
    else if (!hasBoundInteraction(html, id)) missing.push(`interaction_binding_missing:${id}`)
  }
  if (/<(?:script|link|img)[^>]+(?:src|href)\s*=\s*["']https?:\/\//i.test(html)) missing.push('external_core_resource')
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    try { new Script(match[1]) } catch { missing.push('javascript_syntax_error') }
  }
  if (!targetPath.toLowerCase().endsWith(`-v${metadata.version}.html`)) missing.push('target_version_mismatch')
  if (metadata.mode === 'delta' && !metadata.existingPrototypePath) missing.push('existing_prototype_missing')
  if (metadata.mode === 'create' && metadata.existingPrototypePath) missing.push('create_mode_has_existing_prototype')
  if (metadata.status === 'WAITING_CLARIFICATION' && !metadata.openQuestions.length && !metadata.interactionConflicts.length) missing.push('clarification_reason_missing')
  if (metadata.status === 'READY_FOR_CONFIRMATION') {
    if (metadata.sourceInteractionStatus !== 'confirmed') missing.push('interaction_not_confirmed')
    if (metadata.openQuestions.length) missing.push('blocking_open_questions')
    if (metadata.interactionConflicts.length) missing.push('interaction_conflicts')
  }
  for (const [name, passed] of Object.entries(metadata.semanticChecks)) if (!passed) missing.push(`semantic:${name}`)
  if (!metadata.uiReferencePaths.length && !metadata.existingPrototypePath) warnings.push('ui_reference_not_available_using_default_baseline')
  return {
    deterministicPassed: missing.length === 0,
    semanticReady: Object.values(metadata.semanticChecks).every(Boolean),
    missing: [...new Set(missing)], warnings
  }
}

export function prototypeDiff(sourcePath: string | null, targetPath: string, before: string, after: string): string {
  return createTwoFilesPatch(sourcePath ?? '/dev/null', targetPath, before, after, sourcePath ? 'current' : 'empty', 'candidate', { context: 3 })
}
