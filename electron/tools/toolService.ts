import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { promises as fs } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createTwoFilesPatch } from 'diff'
import type { ArtifactDiffResult, EspowToolName, WriteApprovalRequest } from '../../src/tools'
import type {
  AnalysisActor, AnalysisScenario, AnalysisStatement, BusinessFlowModel, BusinessFlowResult, CandidateChange,
  ChangeArtifactAssessment, ChangeResult, DecisionImpact, InteractionDesignModel, InteractionDesignResult,
  ProductSpecModel, ProductSpecResult, PrototypeMetadata, PrototypeResult, RequirementAnalysisResult, RequirementReviewModel,
  RequirementReviewResult, ReviewDependency, SolutionDesignModel, SolutionDesignResult
} from '../../src/skills'
import type { WorkspaceArtifact } from '../../src/workspace'
import type { ContextPackage } from '../../src/context'
import type { AnalysisPatchOperation, AnalysisQuestionDraft, AnalysisRequirementType, AnalysisTurnSubmission, AnalysisWorkingQuestion } from '../../src/analysisState'
import { lifecycleStageOrder, type LifecycleStageState } from '../../src/lifecycleStageState'
import { LocalWorkspaceService } from '../workspaceService'
import { PersistenceService } from '../persistenceService'
import { analysisResultFromState, applyAnalysisSchemaDelta, applyAnalysisStatePatches, applyAnalysisWorkingDelta, buildAnalysisProjection, calculateAnalysisReadiness, createEmptyAnalysisState, detectAnalysisConflicts, finalizeAnalysisTurn, gateAnalysisQuestions, normalizeAnalysisState, resolveAnalysisQuestions } from '../runtime/analysisStateEngine'
import { deterministicScript, type DeterministicScriptName } from '../runtime/executionPolicy'
import {
  createSharedRequirementState, createStageState, markDownstreamStagesStale, sharedStateFromAnalysis, stageStateFromAnalysis,
  stageStateFromBusinessFlow, stageStateFromInteraction, stageStateFromProductSpec, stageStateFromPrototype, stageStateFromReview, stageStateFromSolution
} from '../runtime/lifecycleStageStateEngine'
import { businessFlowDiff, businessFlowReadiness, parseBusinessFlowJson, renderBusinessFlowHtml } from './businessFlow'
import {
  parseSolutionDesignJson, renderSolutionDesignMarkdown, solutionCoverageCheck, solutionDesignReadiness, solutionOverdesignCheck
} from './solutionDesign'
import { interactionDesignReadiness, parseInteractionDesignJson, renderInteractionDesignMarkdown } from './interactionDesign'
import { parsePrototypeMetadata, prototypeDiff, prototypeReadiness } from './prototype'
import { parseProductSpecJson, productSpecReadiness, renderProductSpecMarkdown } from './productSpec'
import { dependencyHash, parseRequirementReviewJson, renderRequirementReviewMarkdown, requirementReviewReadiness } from './requirementReview'

const maxArtifactBytes = 5 * 1024 * 1024
const supportedExtensions = new Set(['.md', '.txt', '.html', '.htm', '.json'])

export type ToolName = EspowToolName

export interface ToolExecutionContext {
  runId: string
  workspaceId?: string
  requirementId: string
  approvedApproval?: WriteApprovalRequest
  confirmedAnalysis?: { runId: string; path: string; candidate: string; baseHash: string | null }
  confirmedFlow?: BusinessFlowResult
  confirmedSolution?: SolutionDesignResult
  confirmedInteraction?: InteractionDesignResult
  confirmedPrototype?: PrototypeResult
  confirmedProductSpec?: ProductSpecResult
  confirmedRequirementReview?: RequirementReviewResult
  contextPackage?: ContextPackage
}

export class EspowToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'EspowToolError'
  }
}

function inputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EspowToolError('INVALID_INPUT', 'Tool 输入必须是对象。')
  return value as Record<string, unknown>
}

function optionalString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key]
  if (value === undefined) return null
  if (typeof value !== 'string' || !value.trim()) throw new EspowToolError('INVALID_INPUT', `${key} 必须是非空字符串。`)
  return value.trim()
}

function requiredString(input: Record<string, unknown>, key: string, trim = true): string {
  const value = input[key]
  if (typeof value !== 'string' || (trim ? !value.trim() : value.length === 0)) {
    throw new EspowToolError('INVALID_INPUT', `${key} 必须是非空字符串。`)
  }
  return trim ? value.trim() : value
}

function requiredArray(input: Record<string, unknown>, key: string): unknown[] {
  const value = input[key]
  if (!Array.isArray(value)) throw new EspowToolError('INVALID_INPUT', `${key} 必须是数组。`)
  return value
}

function stringArray(input: Record<string, unknown>, key: string): string[] {
  const values = requiredArray(input, key)
  if (!values.every((value) => typeof value === 'string')) throw new EspowToolError('INVALID_INPUT', `${key} 只能包含字符串。`)
  return values as string[]
}

function objectArray<T>(input: Record<string, unknown>, key: string, parse: (value: Record<string, unknown>) => T): T[] {
  return requiredArray(input, key).map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EspowToolError('INVALID_INPUT', `${key} 的元素必须是对象。`)
    return parse(value as Record<string, unknown>)
  })
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new EspowToolError('INVALID_INPUT', `${field} 必须是字符串或 null。`)
  return value
}

function isInside(root: string, target: string): boolean {
  const relation = relative(root, target)
  return relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation))
}

function rejectUnsafeRelativePath(path: string): void {
  if (isAbsolute(path) || path.startsWith('~') || path.includes('\0')) {
    throw new EspowToolError('WORKSPACE_SCOPE', '只允许当前 Requirement 内的相对路径。')
  }
  const segments = path.replaceAll('\\', '/').split('/')
  if (segments.some((segment) => segment === '..' || segment === '')) {
    throw new EspowToolError('WORKSPACE_SCOPE', '路径包含非法的越界或空片段。')
  }
}

function normalizeRelativePath(path: string): string {
  rejectUnsafeRelativePath(path)
  return path.replaceAll('\\', '/')
}

async function safeExistingPath(root: string, path: string): Promise<string> {
  const normalized = normalizeRelativePath(path)
  const realRoot = await fs.realpath(root)
  let target: string
  try {
    target = await fs.realpath(resolve(root, normalized))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new EspowToolError('ARTIFACT_NOT_FOUND', `Artifact 不存在：${normalized}`)
    throw error
  }
  if (!isInside(realRoot, target) || target === realRoot) throw new EspowToolError('WORKSPACE_SCOPE', 'Artifact 路径越过 Requirement 边界。')
  return target
}

async function safeNewPath(root: string, path: string): Promise<string> {
  const normalized = normalizeRelativePath(path)
  const extension = extname(normalized).toLowerCase()
  if (!supportedExtensions.has(extension)) throw new EspowToolError('INVALID_INPUT', '目标文件类型必须是 Markdown、Text 或 HTML。')
  const realRoot = await fs.realpath(root)
  const target = resolve(realRoot, normalized)
  const realParent = await fs.realpath(dirname(target))
  if (!isInside(realRoot, realParent) || !isInside(realRoot, target)) throw new EspowToolError('WORKSPACE_SCOPE', '目标路径越过 Requirement 边界。')
  return target
}

async function safePlannedPath(root: string, path: string): Promise<string> {
  const normalized = normalizeRelativePath(path)
  if (!supportedExtensions.has(extname(normalized).toLowerCase())) throw new EspowToolError('INVALID_INPUT', '目标文件类型不受支持。')
  const realRoot = await fs.realpath(root)
  const target = resolve(realRoot, normalized)
  if (!isInside(realRoot, target) || target === realRoot) throw new EspowToolError('WORKSPACE_SCOPE', '目标路径越过 Requirement 边界。')
  let existingParent = dirname(target)
  while (existingParent !== realRoot) {
    try { existingParent = await fs.realpath(existingParent); break } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      existingParent = dirname(existingParent)
    }
  }
  if (!isInside(realRoot, existingParent)) throw new EspowToolError('WORKSPACE_SCOPE', '目标目录越过 Requirement 边界。')
  return target
}

function artifactMetadata(artifact: WorkspaceArtifact): Record<string, unknown> {
  return {
    id: artifact.id,
    type: artifact.kind,
    path: artifact.relativePath,
    version: artifact.relativePath.match(/(?:^|[-_. ])v(\d+)(?=\.[^.]+$)/i)?.[1] ?? null,
    title: artifact.title,
    updatedAt: artifact.updatedAt,
    format: artifact.format,
    size: artifact.size
  }
}

function markdownSections(content: string): Map<string, string> {
  const sections = new Map<string, string>()
  let heading = 'Document'
  let lines: string[] = []
  const commit = () => sections.set(heading, lines.join('\n'))
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^#{1,6}\s+(.+?)\s*$/)
    if (match) {
      commit()
      heading = match[1]
      lines = [line]
    } else lines.push(line)
  }
  commit()
  return sections
}

function changedSections(before: string, after: string, extension: string): string[] {
  if (extension !== '.md') return before === after ? [] : ['Document']
  const left = markdownSections(before)
  const right = markdownSections(after)
  return [...new Set([...left.keys(), ...right.keys()])].filter((key) => left.get(key) !== right.get(key))
}

function requireSupportedArtifact(artifact: WorkspaceArtifact): void {
  if (!supportedExtensions.has(extname(artifact.relativePath).toLowerCase())) {
    throw new EspowToolError('UNSUPPORTED_FORMAT', 'V0.1 只支持 Markdown、Text、HTML 与 JSON Artifact。')
  }
  if (artifact.size > maxArtifactBytes) throw new EspowToolError('FILE_TOO_LARGE', 'Artifact 超过 5 MB。')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface ParsedAnalysis {
  status: RequirementAnalysisResult['analysisStatus']
  problemDefinition: string
  goal: string
  actors: AnalysisActor[]
  scenarios: AnalysisScenario[]
  currentFlow: string[]
  blockers: AnalysisStatement[]
  rootCauses: AnalysisStatement[]
  boundaries: string[]
  facts: string[]
  assumptions: string[]
  decisions: string[]
  openQuestions: string[]
  outOfScope: string[]
  semanticReady: boolean
}

function parseAnalysisJson(input: Record<string, unknown>): ParsedAnalysis {
  let value: Record<string, unknown>
  try {
    const result = input.resultJson
    value = inputRecord(typeof result === 'string' ? JSON.parse(requiredString(input, 'resultJson', false)) : result)
  } catch (error) {
    if (error instanceof EspowToolError) throw error
    throw new EspowToolError('INVALID_INPUT', 'resultJson 必须是合法的 JSON 对象或 JSON 对象字符串。')
  }
  const status = requiredString(value, 'analysisStatus')
  if (status !== 'Analyzing' && status !== 'ReadyForConfirmation') {
    throw new EspowToolError('INVALID_INPUT', '模型只能提交 Analyzing 或 ReadyForConfirmation。')
  }
  const actor = (item: Record<string, unknown>): AnalysisActor => ({
    name: requiredString(item, 'name'), role: requiredString(item, 'role')
  })
  const scenario = (item: Record<string, unknown>): AnalysisScenario => ({
    id: requiredString(item, 'id'), name: requiredString(item, 'name'), actor: requiredString(item, 'actor'),
    trigger: requiredString(item, 'trigger'), currentFlow: stringArray(item, 'currentFlow'),
    blocker: requiredString(item, 'blocker'), expectedOutcome: requiredString(item, 'expectedOutcome'),
    status: requiredString(item, 'status')
  })
  const statement = (item: Record<string, unknown>): AnalysisStatement => {
    const evidenceType = requiredString(item, 'evidenceType')
    if (evidenceType !== 'FACT' && evidenceType !== 'ASSUMPTION') throw new EspowToolError('INVALID_INPUT', 'evidenceType 必须是 FACT 或 ASSUMPTION。')
    return { description: requiredString(item, 'description'), evidenceType, source: nullableString(item.source, 'source') }
  }
  if (typeof value.semanticReady !== 'boolean') throw new EspowToolError('INVALID_INPUT', 'semanticReady 必须是布尔值。')
  return {
    status: status as ParsedAnalysis['status'], problemDefinition: requiredString(value, 'problemDefinition'),
    goal: requiredString(value, 'goal'), actors: objectArray(value, 'actors', actor),
    scenarios: objectArray(value, 'scenarios', scenario), currentFlow: stringArray(value, 'currentFlow'),
    blockers: objectArray(value, 'blockers', statement), rootCauses: objectArray(value, 'rootCauses', statement),
    boundaries: stringArray(value, 'boundaries'), facts: stringArray(value, 'facts'),
    assumptions: stringArray(value, 'assumptions'), decisions: stringArray(value, 'decisions'),
    openQuestions: stringArray(value, 'openQuestions'), outOfScope: stringArray(value, 'outOfScope'),
    semanticReady: value.semanticReady
  }
}

function analysisReadiness(value: ParsedAnalysis): RequirementAnalysisResult['readiness'] {
  const missing: string[] = []
  if (!value.problemDefinition.trim()) missing.push('problem_definition')
  if (!value.actors.length) missing.push('actors')
  if (!value.scenarios.length) missing.push('scenarios')
  if (!value.currentFlow.length) missing.push('current_flow')
  if (!value.blockers.length) missing.push('blockers')
  return { deterministicPassed: missing.length === 0, semanticReady: value.semanticReady, missing }
}

function list(values: string[]): string {
  return values.length ? values.map((value) => `- ${value}`).join('\n') : '—'
}

function renderAnalysis(value: ParsedAnalysis): string {
  const formalStatus = value.status === 'ReadyForConfirmation' ? 'confirmed' : 'draft'
  const displayedStatus = value.status === 'ReadyForConfirmation' ? 'Confirmed' : 'Draft'
  const actors = value.actors.length ? value.actors.map((actor) => `- **${actor.name}**：${actor.role}`).join('\n') : '—'
  const scenarios = value.scenarios.length ? value.scenarios.map((scenario) => [
    `### ${scenario.id}｜${scenario.name}`, `- Actor：${scenario.actor}`, `- Trigger：${scenario.trigger}`,
    `- Current Flow：${scenario.currentFlow.join(' → ')}`, `- Blocker：${scenario.blocker}`,
    `- Expected Outcome：${scenario.expectedOutcome}`, `- Status：${scenario.status}`
  ].join('\n')).join('\n\n') : '—'
  const statements = (values: AnalysisStatement[]) => values.length
    ? values.map((item) => `- [${item.evidenceType}] ${item.description}${item.source ? `（来源：${item.source}）` : ''}`).join('\n') : '—'
  return `# Requirement Analysis\n\n- Analysis Status：${formalStatus}\n\n## 1. Problem Definition\n\n${value.problemDefinition}\n\n## 2. Goal\n\n${value.goal}\n\n## 3. Actors\n\n${actors}\n\n## 4. Scenario Map\n\n${scenarios}\n\n## 5. Current Main Flow\n\n${value.currentFlow.join(' → ') || '—'}\n\n## 6. Blockers\n\n${statements(value.blockers)}\n\n## 7. Root Causes\n\n${statements(value.rootCauses)}\n\n## 8. Boundaries\n\n${list(value.boundaries)}\n\n## 9. FACT\n\n${list(value.facts)}\n\n## 10. ASSUMPTION\n\n${list(value.assumptions)}\n\n## 11. DECISION\n\n${list(value.decisions)}\n\n## 12. OPEN_QUESTION\n\n${list(value.openQuestions)}\n\n## 13. Out of Scope\n\n${list(value.outOfScope)}\n\n## 14. Analysis Status\n\n${displayedStatus}\n`
}

interface FlowWorkspaceState {
  version: number
  modelPath: string
  htmlPath: string
  fingerprint: string
  previous: BusinessFlowModel | null
}

async function flowWorkspaceState(root: string): Promise<FlowWorkspaceState> {
  const directory = resolve(root, 'flows')
  let entries: string[] = []
  try { entries = await fs.readdir(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const versions = entries.map((entry) => Number(entry.match(/^business-flow-v(\d+)\.(?:json|html)$/i)?.[1] ?? 0))
  const version = Math.max(0, ...versions) + 1
  const sources: Array<{ path: string; hash: string }> = []
  for (const entry of entries.filter((item) => /^business-flow-v\d+\.(?:json|html)$/i.test(item)).sort()) {
    const content = await fs.readFile(join(directory, entry), 'utf8')
    sources.push({ path: `flows/${entry}`, hash: createHash('sha256').update(content).digest('hex') })
  }
  let previous: BusinessFlowModel | null = null
  const previousModels = entries.map((entry) => ({ entry, version: Number(entry.match(/^business-flow-v(\d+)\.json$/i)?.[1] ?? 0) }))
    .filter((item) => item.version > 0).sort((left, right) => right.version - left.version)
  if (previousModels[0]) {
    try { previous = parseBusinessFlowJson(await fs.readFile(join(directory, previousModels[0].entry), 'utf8'), true) } catch { previous = null }
  }
  return {
    version,
    modelPath: `flows/business-flow-v${version}.json`,
    htmlPath: `flows/business-flow-v${version}.html`,
    fingerprint: createHash('sha256').update(JSON.stringify(sources)).digest('hex'),
    previous
  }
}

async function formalAnalysisStatus(root: string): Promise<'confirmed' | 'draft' | 'missing'> {
  try {
    const content = await fs.readFile(await safeExistingPath(root, 'analysis/requirement-analysis.md'), 'utf8')
    return /Analysis Status[：:]\s*(?:confirmed|已确认)/i.test(content) ? 'confirmed' : 'draft'
  } catch (error) {
    if (error instanceof EspowToolError && error.code === 'ARTIFACT_NOT_FOUND') return 'missing'
    throw error
  }
}

interface SolutionWorkspaceState {
  version: number
  modelPath: string
  markdownPath: string
  fingerprint: string
}

interface InteractionWorkspaceState {
  version: number
  modelPath: string
  markdownPath: string
  fingerprint: string
}

interface PrototypeWorkspaceState {
  version: number
  htmlPath: string
  sourcePath: string | null
  sourceContent: string
  fingerprint: string
}

interface ProductSpecWorkspaceState {
  version: number
  modelPath: string
  markdownPath: string
  fingerprint: string
  previousMarkdownPath: string | null
}

interface RequirementReviewWorkspaceState {
  version: number
  modelPath: string
  markdownPath: string
  dependencies: ReviewDependency[]
  fingerprint: string
  productSpecStatus: 'confirmed' | 'draft' | 'missing'
}

function numberedVersion(path: string): number | null {
  const value = Number(path.match(/(?:^|[-_.])v(\d+)(?=\.[^.]+$)/i)?.[1] ?? 0)
  return value || null
}

async function latestMatching(root: string, directory: string, pattern: RegExp): Promise<string | null> {
  let entries: string[] = []
  try { entries = await fs.readdir(resolve(root, directory)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const found = entries.map((entry) => ({ entry, version: Number(entry.match(pattern)?.[1] ?? 0) }))
    .filter((item) => item.version > 0).sort((left, right) => right.version - left.version)[0]
  return found ? `${directory}/${found.entry}` : null
}

async function latestVersionPerStem(root: string, directory: string, pattern: RegExp): Promise<string[]> {
  let entries: string[] = []
  try { entries = await fs.readdir(resolve(root, directory)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const latest = new Map<string, { entry: string; version: number }>()
  for (const entry of entries) {
    const match = entry.match(pattern)
    if (!match) continue
    const stem = match[1].toLowerCase()
    const version = Number(match[2])
    if (!latest.has(stem) || latest.get(stem)!.version < version) latest.set(stem, { entry, version })
  }
  return [...latest.values()].map((item) => `${directory}/${item.entry}`).sort()
}

async function requirementReviewWorkspaceState(root: string, additionalPaths: string[] = []): Promise<RequirementReviewWorkspaceState> {
  const reviewDirectory = resolve(root, 'review')
  let reviewEntries: string[] = []
  try { reviewEntries = await fs.readdir(reviewDirectory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const version = Math.max(0, ...reviewEntries.map((entry) => Number(entry.match(/^requirement-review-v(\d+)\.(?:json|md)$/i)?.[1] ?? 0))) + 1
  const paths = [
    'analysis/requirement-analysis.md',
    await latestMatching(root, 'flows', /^business-flow-v(\d+)\.json$/i),
    await latestMatching(root, 'solution', /^solution-design-v(\d+)\.json$/i),
    await latestMatching(root, 'interaction', /^interaction-design-v(\d+)\.json$/i),
    ...await latestVersionPerStem(root, 'prototype', /^(.+?)-v(\d+)\.html$/i),
    await latestMatching(root, 'prd', /^product-spec-v(\d+)\.json$/i),
    await latestMatching(root, 'prd', /^prd-v(\d+)\.md$/i),
    ...additionalPaths
  ].filter((item): item is string => Boolean(item))
  const dependencies: ReviewDependency[] = []
  for (const path of [...new Set(paths)].sort()) {
    try {
      const content = await fs.readFile(await safeExistingPath(root, path), 'utf8')
      dependencies.push({ path, hash: dependencyHash(content), version: numberedVersion(path) })
    } catch (error) {
      if (!(error instanceof EspowToolError) || error.code !== 'ARTIFACT_NOT_FOUND') throw error
    }
  }
  const productSpec = dependencies.find((item) => /^prd\/product-spec-v\d+\.json$/i.test(item.path))
  let productSpecStatus: RequirementReviewWorkspaceState['productSpecStatus'] = 'missing'
  if (productSpec) {
    try {
      const model = parseProductSpecJson(await fs.readFile(resolve(root, productSpec.path), 'utf8'), true)
      productSpecStatus = model.status === 'CONFIRMED' ? 'confirmed' : 'draft'
    } catch { productSpecStatus = 'draft' }
  }
  return {
    version, modelPath: `review/requirement-review-v${version}.json`, markdownPath: `review/requirement-review-v${version}.md`,
    dependencies, fingerprint: createHash('sha256').update(JSON.stringify(dependencies)).digest('hex'), productSpecStatus
  }
}

async function solutionWorkspaceState(root: string): Promise<SolutionWorkspaceState> {
  const directory = resolve(root, 'solution')
  let entries: string[] = []
  try { entries = await fs.readdir(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const versions = entries.map((entry) => Number(entry.match(/^solution-design-v(\d+)\.(?:json|md)$/i)?.[1] ?? 0))
  const version = Math.max(0, ...versions) + 1
  const sources: Array<{ path: string; hash: string }> = []
  for (const entry of entries.filter((item) => /^solution-design-v\d+\.(?:json|md)$/i.test(item)).sort()) {
    const content = await fs.readFile(join(directory, entry), 'utf8')
    sources.push({ path: `solution/${entry}`, hash: createHash('sha256').update(content).digest('hex') })
  }
  return {
    version, modelPath: `solution/solution-design-v${version}.json`, markdownPath: `solution/solution-design-v${version}.md`,
    fingerprint: createHash('sha256').update(JSON.stringify(sources)).digest('hex')
  }
}

async function interactionWorkspaceState(root: string): Promise<InteractionWorkspaceState> {
  const directory = resolve(root, 'interaction')
  let entries: string[] = []
  try { entries = await fs.readdir(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const versions = entries.map((entry) => Number(entry.match(/^interaction-design-v(\d+)\.(?:json|md)$/i)?.[1] ?? 0))
  const version = Math.max(0, ...versions) + 1
  const sources: Array<{ path: string; hash: string }> = []
  for (const entry of entries.filter((item) => /^interaction-design-v\d+\.(?:json|md)$/i.test(item)).sort()) {
    const content = await fs.readFile(join(directory, entry), 'utf8')
    sources.push({ path: `interaction/${entry}`, hash: createHash('sha256').update(content).digest('hex') })
  }
  return {
    version, modelPath: `interaction/interaction-design-v${version}.json`, markdownPath: `interaction/interaction-design-v${version}.md`,
    fingerprint: createHash('sha256').update(JSON.stringify(sources)).digest('hex')
  }
}

async function productSpecWorkspaceState(root: string): Promise<ProductSpecWorkspaceState> {
  const directory = resolve(root, 'prd')
  let entries: string[] = []
  try { entries = await fs.readdir(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const versions = entries.map((entry) => Number(entry.match(/^(?:product-spec|prd)-v(\d+)\.(?:json|md)$/i)?.[1] ?? 0))
  const version = Math.max(0, ...versions) + 1
  const previousMarkdown = entries.map((entry) => ({ entry, version: Number(entry.match(/^prd-v(\d+)\.md$/i)?.[1] ?? 0) }))
    .filter((item) => item.version > 0).sort((left, right) => right.version - left.version)[0]
  const sources: Array<{ path: string; hash: string }> = []
  for (const relativeDirectory of ['analysis', 'flows', 'solution', 'interaction', 'prototype', 'prd']) {
    let names: string[] = []
    try { names = await fs.readdir(resolve(root, relativeDirectory)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    for (const name of names.filter((item) => /\.(?:json|md|html)$/i.test(item)).sort()) {
      const content = await fs.readFile(resolve(root, relativeDirectory, name), 'utf8')
      sources.push({ path: `${relativeDirectory}/${name}`, hash: createHash('sha256').update(content).digest('hex') })
    }
  }
  return {
    version, modelPath: `prd/product-spec-v${version}.json`, markdownPath: `prd/prd-v${version}.md`,
    fingerprint: createHash('sha256').update(JSON.stringify(sources)).digest('hex'),
    previousMarkdownPath: previousMarkdown ? `prd/${previousMarkdown.entry}` : null
  }
}

async function prototypeWorkspaceState(root: string, requestedPath: string, existingPath: string | null, referencePaths: string[] = []): Promise<PrototypeWorkspaceState> {
  const normalized = normalizeRelativePath(requestedPath)
  const directory = dirname(normalized)
  const extension = extname(normalized)
  if (extension.toLowerCase() !== '.html') throw new EspowToolError('INVALID_INPUT', 'Prototype 目标必须是 HTML。')
  const stem = basename(normalized, extension)
  const match = stem.match(/^(.*?)([-_. ]v)(\d+)$/i)
  if (!match) throw new EspowToolError('INVALID_INPUT', 'Prototype 文件名必须包含 -vN 版本。')
  let entries: string[] = []
  try { entries = await fs.readdir(resolve(root, directory === '.' ? '' : directory)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const pattern = new RegExp(`^${escapeRegExp(match[1])}[-_. ]v(\\d+)${escapeRegExp(extension)}$`, 'i')
  const highest = Math.max(0, ...entries.map((entry) => Number(entry.match(pattern)?.[1] ?? 0)))
  const version = highest + 1
  const htmlPath = `${directory === '.' ? '' : `${directory.split(sep).join('/')}/`}${match[1]}${match[2]}${version}${extension}`
  let sourceContent = ''
  if (existingPath) {
    const existingName = basename(normalizeRelativePath(existingPath))
    const existingVersion = Number(existingName.match(pattern)?.[1] ?? 0)
    if (!existingVersion || existingVersion !== highest) throw new EspowToolError('SOURCE_CHANGED', 'Prototype Delta 必须基于当前最新有效版本。')
    sourceContent = await fs.readFile(await safeExistingPath(root, existingPath), 'utf8')
  } else if (highest > 0) {
    throw new EspowToolError('SOURCE_CHANGED', '已存在同名 Prototype，必须使用 Existing UI Delta 模式。')
  }
  const sources = entries.filter((entry) => pattern.test(entry)).sort()
  const hashes: Array<{ path: string; hash: string }> = []
  for (const entry of sources) {
    const content = await fs.readFile(resolve(root, directory, entry), 'utf8')
    hashes.push({ path: `${directory}/${entry}`, hash: createHash('sha256').update(content).digest('hex') })
  }
  for (const path of [...new Set(referencePaths)].sort()) {
    const content = await fs.readFile(await safeExistingPath(root, path), 'utf8')
    hashes.push({ path, hash: createHash('sha256').update(content).digest('hex') })
  }
  return { version, htmlPath, sourcePath: existingPath, sourceContent, fingerprint: createHash('sha256').update(JSON.stringify(hashes)).digest('hex') }
}

function prototypeReferencePaths(metadata: PrototypeMetadata): string[] {
  return [
    ...(metadata.sourceInteractionStatus === 'confirmed' ? [metadata.sourceInteractionPath] : []),
    ...(metadata.sourceSolutionPath ? [metadata.sourceSolutionPath] : []),
    ...metadata.uiReferencePaths
  ]
}

async function latestFormalFlow(root: string): Promise<{ status: 'confirmed' | 'draft' | 'missing'; path: string | null; nodeIds: string[] }> {
  const directory = resolve(root, 'flows')
  let entries: string[] = []
  try { entries = await fs.readdir(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing', path: null, nodeIds: [] }
    throw error
  }
  const models = entries.map((entry) => ({ entry, version: Number(entry.match(/^business-flow-v(\d+)\.json$/i)?.[1] ?? 0) }))
    .filter((item) => item.version > 0).sort((left, right) => right.version - left.version)
  if (!models[0]) return { status: 'missing', path: null, nodeIds: [] }
  try {
    const flow = parseBusinessFlowJson(await fs.readFile(join(directory, models[0].entry), 'utf8'), true)
    return { status: flow.status === 'CONFIRMED' ? 'confirmed' : 'draft', path: `flows/${models[0].entry}`, nodeIds: flow.nodes.map((node) => node.id) }
  } catch {
    return { status: 'draft', path: `flows/${models[0].entry}`, nodeIds: [] }
  }
}

async function latestFormalSolution(root: string): Promise<{ status: 'confirmed' | 'draft' | 'missing'; path: string | null; capabilityIds: string[] }> {
  const directory = resolve(root, 'solution')
  let entries: string[] = []
  try { entries = await fs.readdir(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing', path: null, capabilityIds: [] }
    throw error
  }
  const models = entries.map((entry) => ({ entry, version: Number(entry.match(/^solution-design-v(\d+)\.json$/i)?.[1] ?? 0) }))
    .filter((item) => item.version > 0).sort((left, right) => right.version - left.version)
  if (!models[0]) return { status: 'missing', path: null, capabilityIds: [] }
  try {
    const solution = parseSolutionDesignJson(await fs.readFile(join(directory, models[0].entry), 'utf8'), true)
    return { status: solution.status === 'CONFIRMED' ? 'confirmed' : 'draft', path: `solution/${models[0].entry}`, capabilityIds: solution.capabilities.map((item) => item.id) }
  } catch {
    return { status: 'draft', path: `solution/${models[0].entry}`, capabilityIds: [] }
  }
}

async function latestFormalInteraction(root: string): Promise<{ status: 'confirmed' | 'draft' | 'missing'; path: string | null }> {
  const directory = resolve(root, 'interaction')
  let entries: string[] = []
  try { entries = await fs.readdir(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing', path: null }
    throw error
  }
  const models = entries.map((entry) => ({ entry, version: Number(entry.match(/^interaction-design-v(\d+)\.json$/i)?.[1] ?? 0) }))
    .filter((item) => item.version > 0).sort((left, right) => right.version - left.version)
  if (!models[0]) return { status: 'missing', path: null }
  try {
    const interaction = parseInteractionDesignJson(await fs.readFile(join(directory, models[0].entry), 'utf8'), true)
    return { status: interaction.status === 'CONFIRMED' ? 'confirmed' : 'draft', path: `interaction/${models[0].entry}` }
  } catch { return { status: 'draft', path: `interaction/${models[0].entry}` } }
}

async function atomicCreate(path: string, content: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    const handle = await fs.open(temporary, 'r')
    await handle.sync()
    await handle.close()
    if (await fs.readFile(temporary, 'utf8') !== content) throw new EspowToolError('WRITE_FAILED', 'Business Flow 临时文件内容校验失败。')
    await fs.rename(temporary, path)
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined)
    throw error
  }
}

export class EspowToolService {
  constructor(private readonly workspace: LocalWorkspaceService, private readonly persistence?: PersistenceService) {}

  private persistLifecycleStageState(state: LifecycleStageState, context: ToolExecutionContext, eventType: string): LifecycleStageState {
    if (!this.persistence) return state
    const existing = this.persistence.getLifecycleStageState(state.requirementId, state.stageId)
    if (existing) state.version = existing.version + 1
    const allBefore = this.persistence.listLifecycleStageStates(state.requirementId)
    const upstreamVersions: LifecycleStageState['upstreamVersions'] = {}
    for (const item of allBefore) if (item.stageId !== state.stageId) upstreamVersions[item.stageId] = item.version
    state.upstreamVersions = upstreamVersions
    state.updatedAt = new Date().toISOString()
    const saved = this.persistence.saveLifecycleStageState(state, context.runId, eventType)
    if ((!existing || JSON.stringify(existing.slots) !== JSON.stringify(saved.slots))
      && Object.values(saved.slots).some((value) => Array.isArray(value) && value.length > 0)) {
      for (const stageId of lifecycleStageOrder) {
        if (lifecycleStageOrder.indexOf(stageId) <= lifecycleStageOrder.indexOf(state.stageId)) continue
        if (!this.persistence.getLifecycleStageState(state.requirementId, stageId)) {
          this.persistence.saveLifecycleStageState(createStageState(state.workspaceId, state.requirementId, stageId), context.runId, 'downstream-initialized')
        }
      }
      const stale = markDownstreamStagesStale(this.persistence.listLifecycleStageStates(state.requirementId), state.stageId, `${state.stageId} v${saved.version} 已更新`)
      for (const downstream of stale) {
        const before = this.persistence.getLifecycleStageState(state.requirementId, downstream.stageId)
        if (before && downstream.status === 'stale' && before.status !== 'stale') this.persistence.saveLifecycleStageState(downstream, context.runId, 'upstream-changed')
      }
    }
    return saved
  }

  async execute(name: ToolName, args: unknown, context: ToolExecutionContext): Promise<Record<string, unknown>> {
    const input = inputRecord(args)
    const requirementId = requiredString(input, 'requirementId')
    if (requirementId !== context.requirementId) throw new EspowToolError('WORKSPACE_SCOPE', 'Tool 只能访问当前 Run 的 Requirement。')
    if (this.persistence) {
      try { this.persistence.assertRunWritable(context.runId, context.workspaceId, context.requirementId) }
      catch (error) { throw new EspowToolError('RUN_NOT_WRITABLE', error instanceof Error ? error.message : 'Run 当前不可写。') }
    }
    switch (name) {
      case 'workspace_read': return this.workspaceRead(requirementId, context)
      case 'artifact_find': return this.artifactFind(requirementId, input)
      case 'artifact_read': return this.artifactRead(requirementId, input)
      case 'change_result_submit': return this.changeResultSubmit(input)
      case 'analysis_turn_submit': return this.analysisTurnSubmit(requirementId, input, context)
      case 'requirement_analysis_ready': return this.requirementAnalysisReady(input)
      case 'requirement_analysis_submit': return this.requirementAnalysisSubmit(requirementId, input)
      case 'requirement_analysis_write': return this.requirementAnalysisWrite(requirementId, input, context)
      case 'business_flow_next_version': return this.businessFlowNextVersion(requirementId)
      case 'business_flow_ready': return this.businessFlowReady(requirementId, input, context)
      case 'business_flow_submit': return this.businessFlowSubmit(requirementId, input, context)
      case 'business_flow_write': return this.businessFlowWrite(requirementId, input, context)
      case 'solution_design_next_version': return this.solutionDesignNextVersion(requirementId)
      case 'solution_coverage_check': return this.solutionCoverageCheck(requirementId, input)
      case 'solution_overdesign_check': return this.solutionOverdesignCheck(input)
      case 'solution_design_submit': return this.solutionDesignSubmit(requirementId, input, context)
      case 'solution_design_write': return this.solutionDesignWrite(requirementId, input, context)
      case 'interaction_design_next_version': return this.interactionDesignNextVersion(requirementId)
      case 'interaction_design_ready': return this.interactionDesignReady(requirementId, input, context)
      case 'interaction_design_submit': return this.interactionDesignSubmit(requirementId, input, context)
      case 'interaction_design_write': return this.interactionDesignWrite(requirementId, input, context)
      case 'prototype_ready': return this.prototypeReady(requirementId, input, context)
      case 'prototype_submit': return this.prototypeSubmit(requirementId, input, context)
      case 'prototype_write': return this.prototypeWrite(requirementId, input, context)
      case 'product_spec_next_version': return this.productSpecNextVersion(requirementId)
      case 'product_spec_ready': return this.productSpecReady(requirementId, input, context)
      case 'product_spec_submit': return this.productSpecSubmit(requirementId, input, context)
      case 'product_spec_write': return this.productSpecWrite(requirementId, input, context)
      case 'requirement_review_next_version': return this.requirementReviewNextVersion(requirementId, context)
      case 'requirement_review_ready': return this.requirementReviewReady(requirementId, input, context)
      case 'requirement_review_submit': return this.requirementReviewSubmit(requirementId, input, context)
      case 'requirement_review_status': return this.requirementReviewStatus(requirementId, input)
      case 'requirement_review_write': return this.requirementReviewWrite(requirementId, input, context)
      case 'artifact_next_version': return this.artifactNextVersion(requirementId, input)
      case 'artifact_diff': return this.artifactDiff(requirementId, input, context.runId)
      case 'artifact_write': return this.artifactWrite(requirementId, input, context)
      case 'workspace_validate': return this.workspaceValidate(requirementId, input)
    }
  }

  private async workspaceRead(requirementId: string, context: ToolExecutionContext): Promise<Record<string, unknown>> {
    const { requirement } = this.workspace.getRequirementScope(requirementId)
    const selected = context.contextPackage
    return {
      requirement: selected?.requirement ?? {
        id: requirement.id, title: requirement.title, status: requirement.status, stage: requirement.stage,
        updatedAt: requirement.updatedAt, overview: requirement.overview?.slice(0, 6_000) ?? null,
        currentArtifact: requirement.currentArtifact, warnings: requirement.warnings
      },
      artifacts: selected ? selected.artifacts.map((artifact) => ({
        id: artifact.id, type: artifact.type, path: artifact.path, title: artifact.title, updatedAt: artifact.updatedAt
      })) : requirement.artifacts.map(artifactMetadata),
      decisions: selected?.decisions ?? requirement.decisions,
      openIssues: selected?.openIssues ?? requirement.openIssues
    }
  }

  private async artifactFind(requirementId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { requirement } = this.workspace.getRequirementScope(requirementId)
    const type = optionalString(input, 'type')?.toLowerCase()
    const name = optionalString(input, 'name')?.toLowerCase()
    const path = optionalString(input, 'path')
    const query = optionalString(input, 'query')?.toLowerCase()
    if (path) rejectUnsafeRelativePath(path)
    const pathClue = path?.replaceAll('\\', '/').toLowerCase()
    const candidates = requirement.artifacts.filter((artifact) => {
      const haystack = `${artifact.title}\n${artifact.kind}\n${artifact.relativePath}`.toLowerCase()
      return (!type || artifact.kind.toLowerCase().includes(type))
        && (!name || haystack.includes(name))
        && (!pathClue || artifact.relativePath.toLowerCase().includes(pathClue))
        && (!query || haystack.includes(query))
    })
    return { candidates: candidates.map(artifactMetadata), count: candidates.length }
  }

  private async locate(requirementId: string, input: Record<string, unknown>): Promise<{ artifact: WorkspaceArtifact; absolutePath: string }> {
    const artifactId = optionalString(input, 'artifactId')
    const path = optionalString(input, 'path')
    if (!artifactId && !path) throw new EspowToolError('INVALID_INPUT', '必须提供 artifactId 或 path。')
    const artifact = artifactId
      ? this.workspace.getArtifact(requirementId, artifactId)
      : this.workspace.getArtifactByPath(requirementId, normalizeRelativePath(path!))
    if (!artifact) throw new EspowToolError('ARTIFACT_NOT_FOUND', 'Artifact 不存在或尚未被当前 Workspace 索引。')
    if (path && artifact.relativePath !== normalizeRelativePath(path)) throw new EspowToolError('INVALID_INPUT', 'artifactId 与 path 指向不同 Artifact。')
    requireSupportedArtifact(artifact)
    const { root } = this.workspace.getRequirementScope(requirementId)
    return { artifact, absolutePath: await safeExistingPath(root, artifact.relativePath) }
  }

  private async artifactRead(requirementId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { artifact, absolutePath } = await this.locate(requirementId, input)
    const section = optionalString(input, 'section')
    const fullContent = await fs.readFile(absolutePath, 'utf8')
    if (!section || extname(artifact.relativePath).toLowerCase() !== '.md') {
      return { metadata: { ...artifactMetadata(artifact), section: null }, content: fullContent }
    }
    const sections = markdownSections(fullContent)
    const match = [...sections.entries()].find(([heading]) => heading.toLowerCase().includes(section.toLowerCase()))
    if (!match) throw new EspowToolError('SECTION_NOT_FOUND', `Artifact 中未找到章节：${section}`)
    return { metadata: { ...artifactMetadata(artifact), section: match[0] }, content: match[1] }
  }

  private async changeResultSubmit(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    let resultInput: Record<string, unknown>
    try {
      const result = input.resultJson
      resultInput = inputRecord(typeof result === 'string' ? JSON.parse(requiredString(input, 'resultJson', false)) : result)
    } catch (error) {
      if (error instanceof EspowToolError) throw error
      throw new EspowToolError('INVALID_INPUT', 'resultJson 必须是合法的 JSON 对象或 JSON 对象字符串。')
    }
    const status = requiredString(resultInput, 'status')
    if (!['Assessed', 'ClarificationRequired', 'DecisionConflict'].includes(status)) {
      throw new EspowToolError('INVALID_INPUT', 'status 不是有效的 Change Result 状态。')
    }
    const artifact = (value: Record<string, unknown>): ChangeArtifactAssessment => ({
      artifactId: nullableString(value.artifactId, 'artifactId'),
      path: nullableString(value.path, 'path'),
      type: requiredString(value, 'type'),
      reason: requiredString(value, 'reason')
    })
    const decision = (value: Record<string, unknown>): DecisionImpact => ({
      id: requiredString(value, 'id'),
      title: requiredString(value, 'title'),
      conflict: typeof value.conflict === 'boolean' ? value.conflict : (() => { throw new EspowToolError('INVALID_INPUT', 'conflict 必须是布尔值。') })(),
      reason: requiredString(value, 'reason')
    })
    const candidate = (value: Record<string, unknown>): CandidateChange => ({
      artifactId: nullableString(value.artifactId, 'artifactId'),
      path: requiredString(value, 'path'),
      summary: requiredString(value, 'summary')
    })
    const validation = resultInput.validationResult ?? null
    if (validation !== null && typeof validation !== 'string') throw new EspowToolError('INVALID_INPUT', 'validationResult 必须是字符串或 null。')
    const changeResult: ChangeResult = {
      status: status as ChangeResult['status'],
      changeSummary: requiredString(resultInput, 'changeSummary'),
      impactAssessment: requiredString(resultInput, 'impactAssessment'),
      affectedArtifacts: objectArray(resultInput, 'affectedArtifacts', artifact),
      unaffectedArtifacts: objectArray(resultInput, 'unaffectedArtifacts', artifact),
      openQuestions: stringArray(resultInput, 'openQuestions'),
      decisionsAffected: objectArray(resultInput, 'decisionsAffected', decision),
      filesRead: stringArray(resultInput, 'filesRead'),
      candidateChanges: objectArray(resultInput, 'candidateChanges', candidate),
      finalChanges: stringArray(resultInput, 'finalChanges'),
      validationResult: validation
    }
    return { changeResult }
  }


  private async analysisTurnSubmit(
    requirementId: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<Record<string, unknown>> {
    if (!this.persistence) throw new EspowToolError('ANALYSIS_STATE_UNAVAILABLE', 'Analysis State 持久化服务不可用。')
    const assistantReply = requiredString(input, 'assistantReply')
    const slotStatuses = new Set(['unknown', 'inferred', 'open', 'discussing', 'confirmed', 'conflicted', 'not_applicable'])
    const patchSources = new Set(['user', 'agent', 'source', 'runtime'])
    const patches: AnalysisPatchOperation[] = objectArray(input, 'patches', (row) => {
      const op = requiredString(row, 'op')
      if (!['add', 'replace', 'remove'].includes(op)) throw new EspowToolError('INVALID_INPUT', 'patch.op 必须是 add / replace / remove。')
      const path = requiredString(row, 'path')
      if (!path.startsWith('/')) throw new EspowToolError('INVALID_INPUT', 'patch.path 必须以 / 开头。')
      const status = optionalString(row, 'status')
      if (status && !slotStatuses.has(status)) throw new EspowToolError('INVALID_INPUT', `无效的 Slot status：${status}`)
      const source = optionalString(row, 'source')
      if (source && !patchSources.has(source)) throw new EspowToolError('INVALID_INPUT', `无效的 patch source：${source}`)
      return {
        op: op as AnalysisPatchOperation['op'], path, value: row.value,
        ...(status ? { status: status as NonNullable<AnalysisPatchOperation['status']> } : {}),
        ...(source ? { source: source as NonNullable<AnalysisPatchOperation['source']> } : {})
      }
    })
    if (patches.length > 40) throw new EspowToolError('INVALID_INPUT', '单轮 Analysis Patch 最多 40 条。')
    const resolvedQuestionIds = stringArray(input, 'resolvedQuestionIds').map((value) => value.trim()).filter(Boolean)
    const newQuestions: AnalysisQuestionDraft[] = objectArray(input, 'newQuestions', (row) => {
      const priority = requiredString(row, 'priority')
      if (!['blocking', 'non_blocking'].includes(priority)) throw new EspowToolError('INVALID_INPUT', 'Question priority 必须是 blocking / non_blocking。')
      const targetStage = optionalString(row, 'targetStage')
      if (targetStage && !lifecycleStageOrder.includes(targetStage as (typeof lifecycleStageOrder)[number])) throw new EspowToolError('INVALID_INPUT', `无效的 targetStage：${targetStage}`)
      return {
        topic: requiredString(row, 'topic'),
        question: requiredString(row, 'question'),
        priority: priority as AnalysisQuestionDraft['priority'],
        reason: requiredString(row, 'reason'),
        ...(row.impact === undefined ? {} : { impact: stringArray(row, 'impact') }),
        ...(targetStage ? { targetStage: targetStage as AnalysisQuestionDraft['targetStage'] } : {})
      }
    })
    if (newQuestions.length > 5) throw new EspowToolError('INVALID_INPUT', '单轮最多新增 5 个高价值问题。')
    const schemaInput = input.schemaDelta
    let schemaDelta: AnalysisTurnSubmission['schemaDelta']
    if (schemaInput !== undefined) {
      if (!schemaInput || typeof schemaInput !== 'object' || Array.isArray(schemaInput)) throw new EspowToolError('INVALID_INPUT', 'schemaDelta 必须是对象。')
      const row = schemaInput as Record<string, unknown>
      const status = row.status
      if (status !== undefined && !['missing', 'proposed', 'confirmed'].includes(String(status))) throw new EspowToolError('INVALID_INPUT', '无效的 Mainline Schema status。')
      const types = row.requirementTypes
      if (types !== undefined && (!Array.isArray(types) || !types.every((value) => ['workflow', 'integration', 'page_interaction', 'decision_rule', 'data_mapping', 'account_permission'].includes(String(value))))) {
        throw new EspowToolError('INVALID_INPUT', 'requirementTypes 包含不支持的类型。')
      }
      const parseModules = (value: unknown, field: string): string[] | undefined => {
        if (value === undefined) return undefined
        if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim())) throw new EspowToolError('INVALID_INPUT', `${field} 必须是非空字符串数组。`)
        return value.map((item) => String(item).trim())
      }
      schemaDelta = {
        ...(status ? { status: String(status) as NonNullable<AnalysisTurnSubmission['schemaDelta']>['status'] } : {}),
        ...(types ? { requirementTypes: types as AnalysisRequirementType[] } : {}),
        ...(parseModules(row.modules, 'modules') ? { modules: parseModules(row.modules, 'modules') } : {}),
        ...(parseModules(row.addModules, 'addModules') ? { addModules: parseModules(row.addModules, 'addModules') } : {})
      }
    }
    const workingInput = input.workingDelta
    let workingDelta: AnalysisTurnSubmission['workingDelta']
    if (workingInput !== undefined) {
      if (!workingInput || typeof workingInput !== 'object' || Array.isArray(workingInput)) throw new EspowToolError('INVALID_INPUT', 'workingDelta 必须是对象。')
      const row = workingInput as Record<string, unknown>
      let currentQuestion: AnalysisWorkingQuestion | null | undefined
      if ('currentQuestion' in row) {
        if (row.currentQuestion === null) currentQuestion = null
        else {
          if (!row.currentQuestion || typeof row.currentQuestion !== 'object' || Array.isArray(row.currentQuestion)) throw new EspowToolError('INVALID_INPUT', 'currentQuestion 必须是对象或 null。')
          const question = row.currentQuestion as Record<string, unknown>
          currentQuestion = {
            id: requiredString(question, 'id'), question: requiredString(question, 'question'),
            options: objectArray(question, 'options', (option) => ({ id: requiredString(option, 'id'), label: requiredString(option, 'label') }))
          }
        }
      }
      workingDelta = {
        ...('currentTopic' in row ? { currentTopic: row.currentTopic === null ? null : requiredString(row, 'currentTopic') } : {}),
        ...('currentQuestion' in row ? { currentQuestion } : {}),
        ...(typeof row.clearCurrentQuestion === 'boolean' ? { clearCurrentQuestion: row.clearCurrentQuestion } : {})
      }
    }
    const submission: AnalysisTurnSubmission = { assistantReply, patches, resolvedQuestionIds, newQuestions, ...(schemaDelta ? { schemaDelta } : {}), ...(workingDelta ? { workingDelta } : {}) }
    const run = this.persistence.getRun(context.runId)
    let state = this.persistence.getAnalysisState(requirementId, run.threadId)
    if (!state) {
      state = createEmptyAnalysisState(run.workspaceId, requirementId, run.threadId)
      this.persistence.saveAnalysisState(state, context.runId, 'initialized')
    }

    const scriptEvents: Array<Record<string, unknown>> = []
    const runScript = <T>(name: DeterministicScriptName, action: () => T): T => {
      const spec = deterministicScript(name)
      const startedAt = Date.now()
      this.persistence!.recordRuntimeEvent(context.runId, 'script_started', { name: spec.name, label: spec.label, deterministic: true, modelAllowed: false })
      const value = action()
      const durationMs = Date.now() - startedAt
      const payload = { name: spec.name, label: spec.label, durationMs, deterministic: true, modelAllowed: false, tokenCost: 0 }
      this.persistence!.recordRuntimeEvent(context.runId, 'script_completed', payload)
      scriptEvents.push({ ...payload, status: 'success' })
      return value
    }

    state = normalizeAnalysisState(state)
    state.threadId = run.threadId
    state.workspaceId = run.workspaceId
    const schemaStatus = state.mainlineSchema.status
    if (schemaStatus === 'missing' && submission.schemaDelta?.status !== 'proposed') {
      throw new EspowToolError('INVALID_INPUT', 'Mainline 缺失时必须先提交 proposed Blueprint / Bootstrap。')
    }
    if (schemaStatus === 'proposed' && submission.schemaDelta?.status !== 'confirmed' && submission.schemaDelta?.status !== 'proposed') {
      throw new EspowToolError('INVALID_INPUT', 'Mainline 仍为 proposed，必须先处理整体基线确认。')
    }
    if (schemaStatus === 'confirmed' && submission.schemaDelta?.status && submission.schemaDelta.status !== 'confirmed') {
      throw new EspowToolError('INVALID_INPUT', '已确认 Mainline Schema 不得回退为 proposed 或 missing。')
    }
    if (schemaStatus === 'confirmed' && submission.schemaDelta?.modules) throw new EspowToolError('INVALID_INPUT', '已确认 Schema 不得整体重构；只能在用户明确确认后通过 addModules 扩展。')
    const schemaUpdated = runScript('mainline_schema_update', () => applyAnalysisSchemaDelta(state!, submission))
    const workingUpdated = runScript('analysis_working_update', () => applyAnalysisWorkingDelta(schemaUpdated, submission))
    const patched = runScript('mainline_delta_merge', () => applyAnalysisStatePatches(workingUpdated, submission.patches))
    const questionsResolved = runScript('question_resolver', () => resolveAnalysisQuestions(patched, submission.resolvedQuestionIds, []))
    const questionGate = runScript('question_gate', () => gateAnalysisQuestions(questionsResolved, submission.newQuestions))
    this.persistence.recordRuntimeEvent(context.runId, 'question_gate', {
      deterministic: true, tokenCost: 0, candidateCount: questionGate.candidateCount,
      dropCount: questionGate.droppedCount, deferCount: questionGate.deferredCount, blockingCount: questionGate.blockingCount
    })
    const conflictsChecked = runScript('analysis_conflict_detector', () => detectAnalysisConflicts(questionGate.state))
    const next = runScript('analysis_readiness_calculator', () => finalizeAnalysisTurn(conflictsChecked))
    next.readiness = calculateAnalysisReadiness(next)
    this.persistence.recordRuntimeEvent(context.runId, 'state_validated', {
      version: next.version, changedPaths: next.changedPaths, blockingQuestions: next.readiness.blockingQuestions
    })
    const projection = runScript('analysis_projection_builder', () => buildAnalysisProjection(next))
    const persisted = this.persistence.saveAnalysisState(next, context.runId, 'analysis-turn', {
      patches, resolvedQuestionIds, newQuestions, schemaDelta, workingDelta
    })
    const genericAnalysisState = stageStateFromAnalysis(run.workspaceId, requirementId, persisted)
    this.persistLifecycleStageState(genericAnalysisState, context, 'analysis-turn')
    let shared = this.persistence.getSharedRequirementState(requirementId)
      ?? createSharedRequirementState({ workspaceId: run.workspaceId, requirementId, name: context.contextPackage?.requirement?.name ?? requirementId, goal: context.contextPackage?.requirement?.currentGoal ?? '' })
    shared = sharedStateFromAnalysis(shared, persisted)
    this.persistence.saveSharedRequirementState(shared)
    this.persistence.recordRuntimeEvent(context.runId, 'state_updated', {
      version: persisted.version, changedPaths: persisted.changedPaths, readiness: persisted.readiness
    })

    const artifactPath = 'analysis/requirement-analysis.md'
    const { root } = this.workspace.getRequirementScope(requirementId)
    let artifactBaseHash: string | null = null
    try {
      const content = await fs.readFile(await safeExistingPath(root, artifactPath), 'utf8')
      artifactBaseHash = createHash('sha256').update(content).digest('hex')
    } catch (error) {
      if (!(error instanceof EspowToolError) || error.code !== 'ARTIFACT_NOT_FOUND') throw error
    }
    const analysisResult = analysisResultFromState(persisted, artifactBaseHash)
    this.persistence.setAnalysisResult(context.runId, analysisResult)
    const finalReply = persisted.readiness.readyForConfirmation
      ? `${assistantReply.replace(/(?:以上|当前).{0,24}(?:是否|可否).{0,24}(?:基线|确认|认可)[？?。！!]?/g, '').trim()}\n\n需求分析已完成，Blocking Issues：0。可以继续进入业务流程设计。`.trim()
      : assistantReply

    return {
      __espowTerminal: true,
      assistantReply: finalReply,
      stateVersion: persisted.version,
      schema: persisted.mainlineSchema,
      changedPaths: persisted.changedPaths,
      readiness: persisted.readiness,
      openQuestionCount: persisted.openQuestions.filter((item) => item.status === 'open').length,
      blockingQuestionCount: persisted.readiness.blockingQuestions,
      projectionChars: projection.length,
      workingChars: JSON.stringify(persisted.working).length,
      fullStateChars: JSON.stringify(persisted).length,
      scriptEvents
    }
  }

  private async requirementAnalysisReady(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const analysis = parseAnalysisJson(input)
    const readiness = analysisReadiness(analysis)
    return { ready: readiness.deterministicPassed && readiness.semanticReady, checks: readiness, analysisStatus: analysis.status }
  }

  private async requirementAnalysisSubmit(requirementId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const analysis = parseAnalysisJson(input)
    const readiness = analysisReadiness(analysis)
    if (analysis.status === 'ReadyForConfirmation' && (!readiness.deterministicPassed || !readiness.semanticReady)) {
      throw new EspowToolError('ANALYSIS_NOT_READY', `Requirement Analysis 尚未达到确认条件：${readiness.missing.join('、') || '语义检查未通过'}`)
    }
    const artifactPath = 'analysis/requirement-analysis.md'
    const { root } = this.workspace.getRequirementScope(requirementId)
    let artifactBaseHash: string | null = null
    try {
      const content = await fs.readFile(await safeExistingPath(root, artifactPath), 'utf8')
      artifactBaseHash = createHash('sha256').update(content).digest('hex')
    } catch (error) {
      if (!(error instanceof EspowToolError) || error.code !== 'ARTIFACT_NOT_FOUND') throw error
    }
    const analysisResult: RequirementAnalysisResult = {
      analysisStatus: analysis.status,
      problemDefinition: analysis.problemDefinition,
      goal: analysis.goal,
      actors: analysis.actors,
      scenarios: analysis.scenarios,
      currentFlow: analysis.currentFlow,
      blockers: analysis.blockers,
      rootCauses: analysis.rootCauses,
      boundaries: analysis.boundaries,
      facts: analysis.facts,
      assumptions: analysis.assumptions,
      decisions: analysis.decisions,
      openQuestions: analysis.openQuestions,
      outOfScope: analysis.outOfScope,
      readiness,
      artifactPath,
      artifactCandidate: renderAnalysis(analysis),
      artifactBaseHash,
      confirmedAt: null
    }
    return { analysisResult }
  }

  private async requirementAnalysisWrite(
    requirementId: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<Record<string, unknown>> {
    const analysisRunId = requiredString(input, 'analysisRunId')
    const path = normalizeRelativePath(requiredString(input, 'path'))
    const candidate = requiredString(input, 'candidate', false)
    const confirmed = context.confirmedAnalysis
    if (!confirmed || confirmed.runId !== analysisRunId || confirmed.path !== path || confirmed.candidate !== candidate) {
      return { status: 'approval-required', written: false }
    }
    if (analysisRunId !== context.runId || path !== 'analysis/requirement-analysis.md') {
      throw new EspowToolError('WORKSPACE_SCOPE', 'Requirement Analysis 只能写入当前 Run 的正式 Analysis Artifact。')
    }
    const { root } = this.workspace.getRequirementScope(requirementId)
    const realRoot = await fs.realpath(root)
    const target = resolve(realRoot, path)
    if (!isInside(realRoot, target)) throw new EspowToolError('WORKSPACE_SCOPE', '目标路径越过 Requirement 边界。')
    await fs.mkdir(dirname(target), { recursive: true })
    const realParent = await fs.realpath(dirname(target))
    if (!isInside(realRoot, realParent)) throw new EspowToolError('WORKSPACE_SCOPE', '目标目录越过 Requirement 边界。')
    let currentHash: string | null = null
    try {
      currentHash = createHash('sha256').update(await fs.readFile(target, 'utf8')).digest('hex')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (currentHash !== confirmed.baseHash) throw new EspowToolError('SOURCE_CHANGED', 'Requirement Analysis Artifact 在候选形成后发生变化，请重新分析。')
    const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`)
    try {
      await fs.writeFile(temporary, candidate, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      const handle = await fs.open(temporary, 'r')
      await handle.sync()
      await handle.close()
      if (await fs.readFile(temporary, 'utf8') !== candidate) throw new EspowToolError('WRITE_FAILED', '临时文件内容校验失败。')
      await fs.rename(temporary, target)
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined)
      throw error
    }
    return { status: 'written', written: true, path, bytes: Buffer.byteLength(candidate, 'utf8') }
  }

  private async businessFlowNextVersion(requirementId: string): Promise<Record<string, unknown>> {
    const { root } = this.workspace.getRequirementScope(requirementId)
    const state = await flowWorkspaceState(root)
    return { version: state.version, modelPath: state.modelPath, htmlPath: state.htmlPath, baseFingerprint: state.fingerprint }
  }

  private async businessFlowReady(
    requirementId: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<Record<string, unknown>> {
    let flow: BusinessFlowModel
    try { flow = parseBusinessFlowJson(requiredString(input, 'resultJson', false)) } catch (error) {
      throw new EspowToolError('INVALID_INPUT', error instanceof Error ? error.message : 'Business Flow JSON 无效。')
    }
    const { root } = this.workspace.getRequirementScope(requirementId)
    const analysisStatus = await formalAnalysisStatus(root)
    const draftAllowed = /(draft|草稿|探索|未确认)/i.test(context.contextPackage?.task ?? '')
      || context.contextPackage?.existingFlow?.prerequisite === 'DraftRequirementAnalysis'
    if (analysisStatus !== 'confirmed' && !(draftAllowed && context.contextPackage?.existingAnalysis)) {
      throw new EspowToolError('PREREQUISITE_NOT_READY', '当前需求分析尚未确认，不建议直接生成正式业务流程。')
    }
    if (analysisStatus === 'confirmed' && flow.sourceAnalysisStatus !== 'confirmed') {
      throw new EspowToolError('INVALID_INPUT', '已存在确认的 Requirement Analysis，Flow 必须标记 confirmed 来源。')
    }
    if (analysisStatus !== 'confirmed' && (flow.sourceAnalysisStatus !== 'draft' || flow.status === 'READY_FOR_CONFIRMATION')) {
      throw new EspowToolError('PREREQUISITE_NOT_READY', 'Draft Requirement Analysis 只能生成 Draft Business Flow。')
    }
    const readiness = businessFlowReadiness(flow)
    return { ready: readiness.deterministicPassed && readiness.semanticReady, checks: readiness, flowStatus: flow.status }
  }

  private async businessFlowSubmit(
    requirementId: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<Record<string, unknown>> {
    let flow: BusinessFlowModel
    try { flow = parseBusinessFlowJson(requiredString(input, 'resultJson', false)) } catch (error) {
      throw new EspowToolError('INVALID_INPUT', error instanceof Error ? error.message : 'Business Flow JSON 无效。')
    }
    const expectedVersion = Number(input.expectedVersion)
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new EspowToolError('INVALID_INPUT', 'expectedVersion 必须是正整数。')
    const readinessResult = await this.businessFlowReady(requirementId, input, context)
    const readiness = readinessResult.checks as BusinessFlowResult['readiness']
    if (flow.status === 'READY_FOR_CONFIRMATION' && (!readiness.deterministicPassed || !readiness.semanticReady)) {
      throw new EspowToolError('FLOW_NOT_READY', `Business Flow 尚未达到确认条件：${readiness.missing.join('、') || '语义检查未通过'}`)
    }
    const { root } = this.workspace.getRequirementScope(requirementId)
    const state = await flowWorkspaceState(root)
    if (expectedVersion !== state.version) throw new EspowToolError('VERSION_CONFLICT', `Business Flow 目标版本已变化，应使用 v${state.version}。`)
    const modelCandidate = `${JSON.stringify(flow, null, 2)}\n`
    const htmlCandidate = renderBusinessFlowHtml(flow)
    const result: BusinessFlowResult = {
      flowStatus: flow.status,
      prerequisite: flow.sourceAnalysisStatus === 'confirmed' ? 'ConfirmedRequirementAnalysis' : 'DraftRequirementAnalysis',
      flow,
      readiness,
      modelPath: state.modelPath,
      htmlPath: state.htmlPath,
      modelCandidate,
      htmlCandidate,
      baseFingerprint: state.fingerprint,
      diff: businessFlowDiff(state.previous, flow),
      confirmedAt: null
    }
    if (this.persistence) { const run = this.persistence.getRun(context.runId); this.persistLifecycleStageState(stageStateFromBusinessFlow(run.workspaceId, requirementId, flow, [state.modelPath, state.htmlPath]), context, 'business-flow-submit') }
    return { flowResult: result }
  }

  private async businessFlowWrite(
    requirementId: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<Record<string, unknown>> {
    const flowRunId = requiredString(input, 'flowRunId')
    const confirmed = context.confirmedFlow
    if (!confirmed || flowRunId !== context.runId) {
      return { status: 'approval-required', written: false }
    }
    if (confirmed.flowStatus !== 'READY_FOR_CONFIRMATION' || confirmed.prerequisite !== 'ConfirmedRequirementAnalysis') {
      throw new EspowToolError('FLOW_NOT_READY', '只有基于已确认分析且 Ready 的 Business Flow 可以写入。')
    }
    const { root } = this.workspace.getRequirementScope(requirementId)
    const state = await flowWorkspaceState(root)
    if (state.fingerprint !== confirmed.baseFingerprint || state.modelPath !== confirmed.modelPath || state.htmlPath !== confirmed.htmlPath) {
      throw new EspowToolError('SOURCE_CHANGED', 'Business Flow Artifact 在候选形成后发生变化，请重新生成候选。')
    }
    const formal: BusinessFlowModel = { ...confirmed.flow, status: 'CONFIRMED', confirmedAt: new Date().toISOString() }
    const modelContent = `${JSON.stringify(formal, null, 2)}\n`
    const htmlContent = renderBusinessFlowHtml(formal)
    await fs.mkdir(resolve(root, 'flows'), { recursive: true })
    const modelTarget = await safeNewPath(root, confirmed.modelPath)
    const htmlTarget = await safeNewPath(root, confirmed.htmlPath)
    for (const target of [modelTarget, htmlTarget]) {
      try { await fs.access(target, constants.F_OK); throw new EspowToolError('TARGET_EXISTS', 'Business Flow 目标版本已存在。') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    await atomicCreate(modelTarget, modelContent)
    try { await atomicCreate(htmlTarget, htmlContent) } catch (error) {
      await fs.unlink(modelTarget).catch(() => undefined)
      throw error
    }
    return {
      status: 'written', written: true, paths: [confirmed.modelPath, confirmed.htmlPath],
      path: confirmed.htmlPath, modelPath: confirmed.modelPath, htmlPath: confirmed.htmlPath,
      confirmedAt: formal.confirmedAt, bytes: Buffer.byteLength(modelContent, 'utf8') + Buffer.byteLength(htmlContent, 'utf8')
    }
  }

  private async solutionDesignNextVersion(requirementId: string): Promise<Record<string, unknown>> {
    const { root } = this.workspace.getRequirementScope(requirementId)
    return { ...await solutionWorkspaceState(root) }
  }

  private async solutionCoverageCheck(requirementId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    let solution: SolutionDesignModel
    try { solution = parseSolutionDesignJson(requiredString(input, 'resultJson', false)) } catch (error) {
      throw new EspowToolError('INVALID_INPUT', error instanceof Error ? error.message : 'Solution Design JSON 无效。')
    }
    const { root } = this.workspace.getRequirementScope(requirementId)
    const flow = await latestFormalFlow(root)
    return { ...solutionCoverageCheck(solution, flow.nodeIds) }
  }

  private async solutionOverdesignCheck(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    let solution: SolutionDesignModel
    try { solution = parseSolutionDesignJson(requiredString(input, 'resultJson', false)) } catch (error) {
      throw new EspowToolError('INVALID_INPUT', error instanceof Error ? error.message : 'Solution Design JSON 无效。')
    }
    return { ...solutionOverdesignCheck(solution) }
  }

  private async solutionDesignSubmit(
    requirementId: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<Record<string, unknown>> {
    let solution: SolutionDesignModel
    try { solution = parseSolutionDesignJson(requiredString(input, 'resultJson', false)) } catch (error) {
      throw new EspowToolError('INVALID_INPUT', error instanceof Error ? error.message : 'Solution Design JSON 无效。')
    }
    const expectedVersion = Number(input.expectedVersion)
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new EspowToolError('INVALID_INPUT', 'expectedVersion 必须是正整数。')
    const { root } = this.workspace.getRequirementScope(requirementId)
    const analysisStatus = await formalAnalysisStatus(root)
    const flow = await latestFormalFlow(root)
    const draftAllowed = /(draft|草稿|探索|未确认)/i.test(context.contextPackage?.task ?? '')
    const prerequisitesConfirmed = analysisStatus === 'confirmed' && flow.status === 'confirmed'
    if (!prerequisitesConfirmed && !draftAllowed) {
      throw new EspowToolError('PREREQUISITE_NOT_READY', '正式方案设计要求 Requirement Analysis 与 Business Flow 均已确认。')
    }
    if (prerequisitesConfirmed && (solution.sourceAnalysisStatus !== 'confirmed' || solution.sourceFlowStatus !== 'confirmed')) {
      throw new EspowToolError('INVALID_INPUT', '已存在确认的 Analysis 与 Flow，Solution 必须标记 confirmed 来源。')
    }
    if (!prerequisitesConfirmed && solution.status === 'READY_FOR_CONFIRMATION') {
      throw new EspowToolError('PREREQUISITE_NOT_READY', '前置事实未完全确认时只能提交 Draft Solution Exploration。')
    }
    if (flow.path && solution.sourceFlowPath !== flow.path) throw new EspowToolError('SOURCE_CHANGED', 'Solution 未引用最新 Business Flow Model。')
    const readiness = solutionDesignReadiness(solution, flow.nodeIds)
    if (solution.status === 'READY_FOR_CONFIRMATION' && (!readiness.deterministicPassed || !readiness.semanticReady)) {
      throw new EspowToolError('SOLUTION_NOT_READY', `Solution Design 尚未达到确认条件：${readiness.missing.join('、') || '语义检查未通过'}`)
    }
    const state = await solutionWorkspaceState(root)
    if (expectedVersion !== state.version) throw new EspowToolError('VERSION_CONFLICT', `Solution Design 目标版本已变化，应使用 v${state.version}。`)
    const result: SolutionDesignResult = {
      solutionStatus: solution.status,
      prerequisite: prerequisitesConfirmed ? 'ConfirmedAnalysisAndFlow' : 'DraftExploration',
      solution,
      readiness,
      modelPath: state.modelPath,
      markdownPath: state.markdownPath,
      modelCandidate: `${JSON.stringify(solution, null, 2)}\n`,
      markdownCandidate: renderSolutionDesignMarkdown(solution),
      baseFingerprint: state.fingerprint,
      confirmedAt: null
    }
    if (this.persistence) { const run = this.persistence.getRun(context.runId); this.persistLifecycleStageState(stageStateFromSolution(run.workspaceId, requirementId, solution, [state.modelPath, state.markdownPath]), context, 'solution-submit') }
    return { solutionResult: result }
  }

  private async solutionDesignWrite(
    requirementId: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<Record<string, unknown>> {
    const solutionRunId = requiredString(input, 'solutionRunId')
    const confirmed = context.confirmedSolution
    if (!confirmed || solutionRunId !== context.runId) return { status: 'approval-required', written: false }
    if (confirmed.solutionStatus !== 'READY_FOR_CONFIRMATION' || confirmed.prerequisite !== 'ConfirmedAnalysisAndFlow') {
      throw new EspowToolError('SOLUTION_NOT_READY', '只有基于已确认 Analysis 与 Flow 且 Ready 的 Solution Design 可以写入。')
    }
    const { root } = this.workspace.getRequirementScope(requirementId)
    const state = await solutionWorkspaceState(root)
    if (state.fingerprint !== confirmed.baseFingerprint || state.modelPath !== confirmed.modelPath || state.markdownPath !== confirmed.markdownPath) {
      throw new EspowToolError('SOURCE_CHANGED', 'Solution Design Artifact 在候选形成后发生变化，请重新生成候选。')
    }
    const formal: SolutionDesignModel = { ...confirmed.solution, status: 'CONFIRMED', confirmedAt: new Date().toISOString() }
    const modelContent = `${JSON.stringify(formal, null, 2)}\n`
    const markdownContent = renderSolutionDesignMarkdown(formal)
    await fs.mkdir(resolve(root, 'solution'), { recursive: true })
    const modelTarget = await safeNewPath(root, confirmed.modelPath)
    const markdownTarget = await safeNewPath(root, confirmed.markdownPath)
    for (const target of [modelTarget, markdownTarget]) {
      try { await fs.access(target, constants.F_OK); throw new EspowToolError('TARGET_EXISTS', 'Solution Design 目标版本已存在。') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    await atomicCreate(modelTarget, modelContent)
    try { await atomicCreate(markdownTarget, markdownContent) } catch (error) {
      await fs.unlink(modelTarget).catch(() => undefined)
      throw error
    }
    return {
      status: 'written', written: true, paths: [confirmed.modelPath, confirmed.markdownPath],
      path: confirmed.markdownPath, modelPath: confirmed.modelPath, markdownPath: confirmed.markdownPath,
      confirmedAt: formal.confirmedAt, bytes: Buffer.byteLength(modelContent, 'utf8') + Buffer.byteLength(markdownContent, 'utf8')
    }
  }

  private async interactionDesignNextVersion(requirementId: string): Promise<Record<string, unknown>> {
    const { root } = this.workspace.getRequirementScope(requirementId)
    return { ...await interactionWorkspaceState(root) }
  }

  private async interactionDesignReady(
    requirementId: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<Record<string, unknown>> {
    let interaction: InteractionDesignModel
    try { interaction = parseInteractionDesignJson(requiredString(input, 'resultJson', false)) } catch (error) {
      throw new EspowToolError('INVALID_INPUT', error instanceof Error ? error.message : 'Interaction Design JSON 无效。')
    }
    const { root } = this.workspace.getRequirementScope(requirementId)
    const analysisStatus = await formalAnalysisStatus(root)
    const flow = await latestFormalFlow(root)
    const solution = await latestFormalSolution(root)
    const draftAllowed = /(draft|草稿|探索|未确认)/i.test(context.contextPackage?.task ?? '')
    const prerequisitesConfirmed = analysisStatus === 'confirmed' && flow.status === 'confirmed' && solution.status === 'confirmed'
    if (!prerequisitesConfirmed && !draftAllowed) {
      throw new EspowToolError('PREREQUISITE_NOT_READY', '正式交互设计要求 Requirement Analysis、Business Flow 与 Solution Design 均已确认。')
    }
    if (prerequisitesConfirmed && (interaction.sourceAnalysisStatus !== 'confirmed' || interaction.sourceFlowStatus !== 'confirmed' || interaction.sourceSolutionStatus !== 'confirmed')) {
      throw new EspowToolError('INVALID_INPUT', '已存在确认的三个上游 Artifact，Interaction 必须标记 confirmed 来源。')
    }
    if (!prerequisitesConfirmed && interaction.status === 'READY_FOR_CONFIRMATION') {
      throw new EspowToolError('PREREQUISITE_NOT_READY', '前置事实未完全确认时只能提交 Draft Interaction Exploration。')
    }
    if (analysisStatus === 'confirmed' && interaction.sourceAnalysisPath !== 'analysis/requirement-analysis.md') {
      throw new EspowToolError('SOURCE_CHANGED', 'Interaction 未引用正式 Requirement Analysis。')
    }
    if (flow.path && interaction.sourceFlowPath !== flow.path) throw new EspowToolError('SOURCE_CHANGED', 'Interaction 未引用最新 Business Flow Model。')
    if (solution.path && interaction.sourceSolutionPath !== solution.path) throw new EspowToolError('SOURCE_CHANGED', 'Interaction 未引用最新 Solution Design Model。')
    const readiness = interactionDesignReadiness(interaction, solution.capabilityIds, flow.nodeIds)
    return { ready: readiness.deterministicPassed && readiness.semanticReady, checks: readiness, interactionStatus: interaction.status }
  }

  private async interactionDesignSubmit(
    requirementId: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<Record<string, unknown>> {
    let interaction: InteractionDesignModel
    try { interaction = parseInteractionDesignJson(requiredString(input, 'resultJson', false)) } catch (error) {
      throw new EspowToolError('INVALID_INPUT', error instanceof Error ? error.message : 'Interaction Design JSON 无效。')
    }
    const expectedVersion = Number(input.expectedVersion)
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new EspowToolError('INVALID_INPUT', 'expectedVersion 必须是正整数。')
    const readyResult = await this.interactionDesignReady(requirementId, input, context)
    const readiness = readyResult.checks as InteractionDesignResult['readiness']
    if (interaction.status === 'READY_FOR_CONFIRMATION' && (!readiness.deterministicPassed || !readiness.semanticReady)) {
      throw new EspowToolError('INTERACTION_NOT_READY', `Interaction Design 尚未达到确认条件：${readiness.missing.join('、') || '语义检查未通过'}`)
    }
    const { root } = this.workspace.getRequirementScope(requirementId)
    const analysisStatus = await formalAnalysisStatus(root)
    const flow = await latestFormalFlow(root)
    const solution = await latestFormalSolution(root)
    const state = await interactionWorkspaceState(root)
    if (expectedVersion !== state.version) throw new EspowToolError('VERSION_CONFLICT', `Interaction Design 目标版本已变化，应使用 v${state.version}。`)
    const prerequisitesConfirmed = analysisStatus === 'confirmed' && flow.status === 'confirmed' && solution.status === 'confirmed'
    const result: InteractionDesignResult = {
      interactionStatus: interaction.status,
      prerequisite: prerequisitesConfirmed ? 'ConfirmedAnalysisFlowAndSolution' : 'DraftExploration',
      interaction, readiness, modelPath: state.modelPath, markdownPath: state.markdownPath,
      modelCandidate: `${JSON.stringify(interaction, null, 2)}\n`, markdownCandidate: renderInteractionDesignMarkdown(interaction),
      baseFingerprint: state.fingerprint, confirmedAt: null
    }
    if (this.persistence) { const run = this.persistence.getRun(context.runId); this.persistLifecycleStageState(stageStateFromInteraction(run.workspaceId, requirementId, interaction, [state.modelPath, state.markdownPath]), context, 'interaction-submit') }
    return { interactionResult: result }
  }

  private async interactionDesignWrite(
    requirementId: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<Record<string, unknown>> {
    const interactionRunId = requiredString(input, 'interactionRunId')
    const confirmed = context.confirmedInteraction
    if (!confirmed || interactionRunId !== context.runId) return { status: 'approval-required', written: false }
    if (confirmed.interactionStatus !== 'READY_FOR_CONFIRMATION' || confirmed.prerequisite !== 'ConfirmedAnalysisFlowAndSolution') {
      throw new EspowToolError('INTERACTION_NOT_READY', '只有基于已确认 Analysis、Flow、Solution 且 Ready 的 Interaction Design 可以写入。')
    }
    const { root } = this.workspace.getRequirementScope(requirementId)
    const state = await interactionWorkspaceState(root)
    if (state.fingerprint !== confirmed.baseFingerprint || state.modelPath !== confirmed.modelPath || state.markdownPath !== confirmed.markdownPath) {
      throw new EspowToolError('SOURCE_CHANGED', 'Interaction Design Artifact 在候选形成后发生变化，请重新生成候选。')
    }
    const formal: InteractionDesignModel = { ...confirmed.interaction, status: 'CONFIRMED', confirmedAt: new Date().toISOString() }
    const modelContent = `${JSON.stringify(formal, null, 2)}\n`
    const markdownContent = renderInteractionDesignMarkdown(formal)
    await fs.mkdir(resolve(root, 'interaction'), { recursive: true })
    const modelTarget = await safeNewPath(root, confirmed.modelPath)
    const markdownTarget = await safeNewPath(root, confirmed.markdownPath)
    for (const target of [modelTarget, markdownTarget]) {
      try { await fs.access(target, constants.F_OK); throw new EspowToolError('TARGET_EXISTS', 'Interaction Design 目标版本已存在。') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    await atomicCreate(modelTarget, modelContent)
    try { await atomicCreate(markdownTarget, markdownContent) } catch (error) {
      await fs.unlink(modelTarget).catch(() => undefined)
      throw error
    }
    return {
      status: 'written', written: true, paths: [confirmed.modelPath, confirmed.markdownPath],
      path: confirmed.markdownPath, modelPath: confirmed.modelPath, markdownPath: confirmed.markdownPath,
      confirmedAt: formal.confirmedAt, bytes: Buffer.byteLength(modelContent, 'utf8') + Buffer.byteLength(markdownContent, 'utf8')
    }
  }

  private async prototypeReady(
    requirementId: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<Record<string, unknown>> {
    let metadata: PrototypeMetadata
    try { metadata = parsePrototypeMetadata(requiredString(input, 'metadataJson', false)) } catch (error) {
      throw new EspowToolError('INVALID_INPUT', error instanceof Error ? error.message : 'Prototype Metadata 无效。')
    }
    const html = requiredString(input, 'html', false)
    const targetPath = normalizeRelativePath(requiredString(input, 'targetPath'))
    const { root } = this.workspace.getRequirementScope(requirementId)
    const interaction = await latestFormalInteraction(root)
    const draftAllowed = /(draft|草稿|探索|未确认)/i.test(context.contextPackage?.task ?? '')
    if (interaction.status !== 'confirmed' && !draftAllowed) {
      throw new EspowToolError('PREREQUISITE_NOT_READY', '正式 Prototype 要求最新 Interaction Design 已确认。')
    }
    if (interaction.status === 'confirmed' && metadata.sourceInteractionStatus !== 'confirmed') {
      throw new EspowToolError('INVALID_INPUT', '已存在确认的 Interaction，Prototype 必须标记 confirmed 来源。')
    }
    if (interaction.status !== 'confirmed' && metadata.status === 'READY_FOR_CONFIRMATION') {
      throw new EspowToolError('PREREQUISITE_NOT_READY', 'Interaction 未确认时只能生成 Draft Prototype。')
    }
    if (interaction.path && metadata.sourceInteractionPath !== interaction.path) {
      throw new EspowToolError('SOURCE_CHANGED', 'Prototype 未引用最新 Interaction Design Model。')
    }
    const state = await prototypeWorkspaceState(root, targetPath, metadata.existingPrototypePath, prototypeReferencePaths(metadata))
    if (state.htmlPath !== targetPath || state.version !== metadata.version) {
      throw new EspowToolError('VERSION_CONFLICT', `Prototype 目标版本已变化，应使用 ${state.htmlPath}。`)
    }
    const readiness = prototypeReadiness(metadata, html, targetPath)
    if (metadata.status === 'READY_FOR_CONFIRMATION' && (!readiness.deterministicPassed || !readiness.semanticReady)) {
      throw new EspowToolError('PROTOTYPE_NOT_READY', `Prototype 尚未达到确认条件：${readiness.missing.join('、') || '语义检查未通过'}`)
    }
    return { ready: readiness.deterministicPassed && readiness.semanticReady, checks: readiness, prototypeStatus: metadata.status }
  }

  private async prototypeSubmit(
    requirementId: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<Record<string, unknown>> {
    let metadata: PrototypeMetadata
    try { metadata = parsePrototypeMetadata(requiredString(input, 'metadataJson', false)) } catch (error) {
      throw new EspowToolError('INVALID_INPUT', error instanceof Error ? error.message : 'Prototype Metadata 无效。')
    }
    const html = requiredString(input, 'html', false)
    const targetPath = normalizeRelativePath(requiredString(input, 'targetPath'))
    const ready = await this.prototypeReady(requirementId, input, context)
    const readiness = ready.checks as PrototypeResult['readiness']
    const { root } = this.workspace.getRequirementScope(requirementId)
    const state = await prototypeWorkspaceState(root, targetPath, metadata.existingPrototypePath, prototypeReferencePaths(metadata))
    const result: PrototypeResult = {
      prototypeStatus: metadata.status,
      prerequisite: metadata.sourceInteractionStatus === 'confirmed' ? 'ConfirmedInteraction' : 'DraftExploration',
      prototype: metadata,
      readiness,
      htmlPath: state.htmlPath,
      htmlCandidate: html,
      baseFingerprint: state.fingerprint,
      diff: prototypeDiff(state.sourcePath, state.htmlPath, state.sourceContent, html),
      confirmedAt: null
    }
    if (this.persistence) { const run = this.persistence.getRun(context.runId); this.persistLifecycleStageState(stageStateFromPrototype(run.workspaceId, requirementId, metadata, [result.htmlPath]), context, 'prototype-submit') }
    return { prototypeResult: result }
  }

  private async prototypeWrite(
    requirementId: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<Record<string, unknown>> {
    const prototypeRunId = requiredString(input, 'prototypeRunId')
    const confirmed = context.confirmedPrototype
    if (!confirmed || prototypeRunId !== context.runId) return { status: 'approval-required', written: false }
    if (confirmed.prototypeStatus !== 'READY_FOR_CONFIRMATION' || confirmed.prerequisite !== 'ConfirmedInteraction') {
      throw new EspowToolError('PROTOTYPE_NOT_READY', '只有基于已确认 Interaction 且 Ready 的 Prototype 可以写入。')
    }
    const { root } = this.workspace.getRequirementScope(requirementId)
    const state = await prototypeWorkspaceState(root, confirmed.htmlPath, confirmed.prototype.existingPrototypePath, prototypeReferencePaths(confirmed.prototype))
    if (state.fingerprint !== confirmed.baseFingerprint || state.htmlPath !== confirmed.htmlPath) {
      throw new EspowToolError('SOURCE_CHANGED', 'Prototype Artifact 在候选形成后发生变化，请重新生成候选。')
    }
    await fs.mkdir(resolve(root, dirname(confirmed.htmlPath)), { recursive: true })
    const target = await safeNewPath(root, confirmed.htmlPath)
    try { await fs.access(target, constants.F_OK); throw new EspowToolError('TARGET_EXISTS', 'Prototype 目标版本已存在。') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await atomicCreate(target, confirmed.htmlCandidate)
    return {
      status: 'written', written: true, path: confirmed.htmlPath, paths: [confirmed.htmlPath],
      confirmedAt: new Date().toISOString(), bytes: Buffer.byteLength(confirmed.htmlCandidate, 'utf8')
    }
  }

  private async productSpecNextVersion(requirementId: string): Promise<Record<string, unknown>> {
    const { root } = this.workspace.getRequirementScope(requirementId)
    return { ...await productSpecWorkspaceState(root) }
  }

  private async productSpecReady(
    requirementId: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<Record<string, unknown>> {
    let spec: ProductSpecModel
    try { spec = parseProductSpecJson(requiredString(input, 'resultJson', false)) } catch (error) {
      throw new EspowToolError('INVALID_INPUT', error instanceof Error ? error.message : 'Product Spec JSON 无效。')
    }
    const { root } = this.workspace.getRequirementScope(requirementId)
    const analysis = await formalAnalysisStatus(root)
    const flow = await latestFormalFlow(root)
    const solution = await latestFormalSolution(root)
    const interaction = await latestFormalInteraction(root)
    const prerequisitesConfirmed = analysis === 'confirmed' && flow.status === 'confirmed' && solution.status === 'confirmed'
      && (!spec.interactionRequired || interaction.status === 'confirmed')
    const draftAllowed = /(draft|草稿|探索|未确认)/i.test(context.contextPackage?.task ?? '')
    if (!prerequisitesConfirmed && !draftAllowed) throw new EspowToolError('PREREQUISITE_NOT_READY', '正式 PRD 要求 Analysis、Flow、Solution，以及适用时的 Interaction 均已确认。')
    if (!prerequisitesConfirmed && spec.status === 'READY_FOR_CONFIRMATION') throw new EspowToolError('PREREQUISITE_NOT_READY', '上游未确认时 Product Spec 只能是 Draft。')
    if (analysis === 'confirmed' && (spec.sourceAnalysisPath !== 'analysis/requirement-analysis.md' || spec.sourceAnalysisStatus !== 'confirmed')) throw new EspowToolError('SOURCE_CHANGED', 'Product Spec 未引用正式 Requirement Analysis。')
    if (flow.path && (spec.sourceFlowPath !== flow.path || spec.sourceFlowStatus !== 'confirmed')) throw new EspowToolError('SOURCE_CHANGED', 'Product Spec 未引用最新 Business Flow。')
    if (solution.path && (spec.sourceSolutionPath !== solution.path || spec.sourceSolutionStatus !== 'confirmed')) throw new EspowToolError('SOURCE_CHANGED', 'Product Spec 未引用最新 Solution Design。')
    if (spec.interactionRequired && interaction.path && (spec.sourceInteractionPath !== interaction.path || spec.sourceInteractionStatus !== 'confirmed')) throw new EspowToolError('SOURCE_CHANGED', '页面型 Product Spec 未引用最新 Interaction Design。')
    const productSpecState = await productSpecWorkspaceState(root)
    if (spec.mode === 'delta' && spec.existingPrdPath !== productSpecState.previousMarkdownPath) throw new EspowToolError('SOURCE_CHANGED', 'PRD Delta 必须基于当前最新版本。')
    if (spec.mode === 'create' && productSpecState.previousMarkdownPath) throw new EspowToolError('SOURCE_CHANGED', '已存在 PRD，必须使用 Delta 模式。')
    for (const path of [spec.sourceAnalysisPath, spec.sourceFlowPath, spec.sourceSolutionPath, spec.sourceInteractionPath, spec.sourcePrototypePath, spec.existingPrdPath].filter((item): item is string => Boolean(item))) {
      await safeExistingPath(root, path)
    }
    const readiness = productSpecReadiness(spec, solution.capabilityIds, flow.nodeIds)
    return { ready: readiness.prdReady, prdReady: readiness.prdReady, checks: readiness, productSpecStatus: spec.status }
  }

  private async productSpecSubmit(
    requirementId: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<Record<string, unknown>> {
    let spec: ProductSpecModel
    try { spec = parseProductSpecJson(requiredString(input, 'resultJson', false)) } catch (error) {
      throw new EspowToolError('INVALID_INPUT', error instanceof Error ? error.message : 'Product Spec JSON 无效。')
    }
    const expectedVersion = Number(input.expectedVersion)
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new EspowToolError('INVALID_INPUT', 'expectedVersion 必须是正整数。')
    const readyResult = await this.productSpecReady(requirementId, input, context)
    const readiness = readyResult.checks as ProductSpecResult['readiness']
    if (spec.status === 'READY_FOR_CONFIRMATION' && !readiness.prdReady) throw new EspowToolError('PRODUCT_SPEC_NOT_READY', `PRD 尚未达到确认条件：${readiness.missing.join('、') || readiness.warnings.join('、')}`)
    const { root } = this.workspace.getRequirementScope(requirementId)
    const state = await productSpecWorkspaceState(root)
    if (expectedVersion !== state.version) throw new EspowToolError('VERSION_CONFLICT', `Product Spec 目标版本已变化，应使用 v${state.version}。`)
    if (spec.mode === 'delta' && spec.existingPrdPath !== state.previousMarkdownPath) throw new EspowToolError('SOURCE_CHANGED', 'PRD Delta 必须基于当前最新版本。')
    if (spec.mode === 'create' && state.previousMarkdownPath) throw new EspowToolError('SOURCE_CHANGED', '已存在 PRD，必须使用 Delta 模式。')
    const prerequisitesConfirmed = spec.sourceAnalysisStatus === 'confirmed' && spec.sourceFlowStatus === 'confirmed'
      && spec.sourceSolutionStatus === 'confirmed' && (!spec.interactionRequired || spec.sourceInteractionStatus === 'confirmed')
    const result: ProductSpecResult = {
      productSpecStatus: spec.status,
      prerequisite: prerequisitesConfirmed ? 'ConfirmedUpstream' : 'DraftExploration',
      productSpec: spec, readiness, modelPath: state.modelPath, markdownPath: state.markdownPath,
      modelCandidate: `${JSON.stringify(spec, null, 2)}\n`, markdownCandidate: renderProductSpecMarkdown(spec),
      baseFingerprint: state.fingerprint, artifactVersion: state.version, confirmedAt: null
    }
    if (this.persistence) { const run = this.persistence.getRun(context.runId); this.persistLifecycleStageState(stageStateFromProductSpec(run.workspaceId, requirementId, spec, [state.modelPath, state.markdownPath]), context, 'product-spec-submit') }
    return { productSpecResult: result }
  }

  private async productSpecWrite(
    requirementId: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<Record<string, unknown>> {
    const productSpecRunId = requiredString(input, 'productSpecRunId')
    const confirmed = context.confirmedProductSpec
    if (!confirmed || productSpecRunId !== context.runId) return { status: 'approval-required', written: false }
    if (confirmed.productSpecStatus !== 'READY_FOR_CONFIRMATION' || confirmed.prerequisite !== 'ConfirmedUpstream' || !confirmed.readiness.prdReady) throw new EspowToolError('PRODUCT_SPEC_NOT_READY', '只有基于已确认上游且 Ready 的 Product Spec 可以写入。')
    const { root } = this.workspace.getRequirementScope(requirementId)
    const state = await productSpecWorkspaceState(root)
    if (state.fingerprint !== confirmed.baseFingerprint || state.modelPath !== confirmed.modelPath || state.markdownPath !== confirmed.markdownPath) throw new EspowToolError('SOURCE_CHANGED', 'Product Spec 来源或版本在候选形成后发生变化。')
    const confirmedAt = new Date().toISOString()
    const formal: ProductSpecModel = { ...confirmed.productSpec, status: 'CONFIRMED', confirmedAt }
    const modelContent = `${JSON.stringify(formal, null, 2)}\n`
    const markdownContent = renderProductSpecMarkdown(formal)
    await fs.mkdir(resolve(root, 'prd'), { recursive: true })
    const modelTarget = await safeNewPath(root, confirmed.modelPath)
    const markdownTarget = await safeNewPath(root, confirmed.markdownPath)
    for (const target of [modelTarget, markdownTarget]) {
      try { await fs.access(target, constants.F_OK); throw new EspowToolError('TARGET_EXISTS', 'Product Spec 目标版本已存在。') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    await atomicCreate(modelTarget, modelContent)
    try { await atomicCreate(markdownTarget, markdownContent) } catch (error) { await fs.unlink(modelTarget).catch(() => undefined); throw error }
    return { status: 'written', written: true, paths: [confirmed.modelPath, confirmed.markdownPath], path: confirmed.markdownPath, modelPath: confirmed.modelPath, markdownPath: confirmed.markdownPath, confirmedAt, bytes: Buffer.byteLength(modelContent) + Buffer.byteLength(markdownContent) }
  }

  private reviewAdditionalPaths(requirementId: string): string[] {
    const { requirement } = this.workspace.getRequirementScope(requirementId)
    return requirement.artifacts.filter((artifact) => artifact.kind === 'Decision' || artifact.kind === 'Open Issue')
      .map((artifact) => artifact.relativePath)
  }

  private async requirementReviewNextVersion(requirementId: string, context: ToolExecutionContext): Promise<Record<string, unknown>> {
    const { root } = this.workspace.getRequirementScope(requirementId)
    const state = await requirementReviewWorkspaceState(root, this.reviewAdditionalPaths(requirementId))
    const draftAllowed = /(draft|草稿|提前评审|预评审)/i.test(context.contextPackage?.task ?? '')
    if (state.productSpecStatus !== 'confirmed' && !draftAllowed) {
      throw new EspowToolError('PREREQUISITE_NOT_READY', '正式 Requirement Review 要求最新 Product Spec / PRD 已确认。')
    }
    return { ...state, draftReview: state.productSpecStatus !== 'confirmed' }
  }

  private async requirementReviewReady(
    requirementId: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<Record<string, unknown>> {
    let review: RequirementReviewModel
    try { review = parseRequirementReviewJson(requiredString(input, 'resultJson', false)) } catch (error) {
      throw new EspowToolError('INVALID_INPUT', error instanceof Error ? error.message : 'Requirement Review JSON 无效。')
    }
    const { root } = this.workspace.getRequirementScope(requirementId)
    const state = await requirementReviewWorkspaceState(root, this.reviewAdditionalPaths(requirementId))
    const draftAllowed = /(draft|草稿|提前评审|预评审)/i.test(context.contextPackage?.task ?? '')
    if (state.productSpecStatus !== 'confirmed' && !draftAllowed) throw new EspowToolError('PREREQUISITE_NOT_READY', '正式 Requirement Review 要求最新 Product Spec / PRD 已确认。')
    if (state.productSpecStatus !== 'confirmed' && (!review.draftReview || review.reviewStatus !== 'DRAFT_REVIEW')) {
      throw new EspowToolError('PREREQUISITE_NOT_READY', 'PRD 未确认时只能生成 Draft Review，不能形成最终 Ready Gate。')
    }
    if (JSON.stringify(review.dependencies) !== JSON.stringify(state.dependencies)) {
      throw new EspowToolError('SOURCE_CHANGED', 'Review 依赖不是当前有效 Artifact，或依赖在评审期间发生变化。')
    }
    const readiness = requirementReviewReadiness(review)
    return { ready: readiness.deterministicPassed, checks: readiness, conclusion: review.conclusion, reviewStatus: review.reviewStatus }
  }

  private async requirementReviewSubmit(
    requirementId: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<Record<string, unknown>> {
    let review: RequirementReviewModel
    try { review = parseRequirementReviewJson(requiredString(input, 'resultJson', false)) } catch (error) {
      throw new EspowToolError('INVALID_INPUT', error instanceof Error ? error.message : 'Requirement Review JSON 无效。')
    }
    const expectedVersion = Number(input.expectedVersion)
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new EspowToolError('INVALID_INPUT', 'expectedVersion 必须是正整数。')
    const ready = await this.requirementReviewReady(requirementId, input, context)
    const readiness = ready.checks as RequirementReviewResult['readiness']
    if (review.reviewStatus === 'READY_FOR_CONFIRMATION' && !readiness.deterministicPassed) {
      throw new EspowToolError('REVIEW_NOT_READY', `Requirement Review 结构不完整：${readiness.missing.join('、')}`)
    }
    const { root } = this.workspace.getRequirementScope(requirementId)
    const state = await requirementReviewWorkspaceState(root, this.reviewAdditionalPaths(requirementId))
    if (expectedVersion !== state.version) throw new EspowToolError('VERSION_CONFLICT', `Requirement Review 目标版本已变化，应使用 v${state.version}。`)
    const open = review.issues.filter((item) => item.status === 'OPEN')
    const result: RequirementReviewResult = {
      reviewStatus: review.reviewStatus, conclusion: review.conclusion,
      prerequisite: state.productSpecStatus === 'confirmed' ? 'ConfirmedProductSpec' : 'DraftReview',
      review, readiness, blockerCount: open.filter((item) => item.severity === 'BLOCKER').length,
      warningCount: open.filter((item) => item.severity === 'WARNING').length,
      infoCount: open.filter((item) => item.severity === 'INFO').length,
      artifactsReviewed: review.dependencies.map((item) => item.path), modelPath: state.modelPath, markdownPath: state.markdownPath,
      modelCandidate: `${JSON.stringify(review, null, 2)}\n`, markdownCandidate: renderRequirementReviewMarkdown(review),
      baseFingerprint: state.fingerprint, reviewVersion: state.version, createdAt: review.createdAt, confirmedAt: null
    }
    if (this.persistence) { const run = this.persistence.getRun(context.runId); this.persistLifecycleStageState(stageStateFromReview(run.workspaceId, requirementId, review, [state.modelPath, state.markdownPath]), context, 'review-submit') }
    return { requirementReviewResult: result }
  }

  private async requirementReviewStatus(requirementId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const reviewPath = normalizeRelativePath(requiredString(input, 'reviewPath'))
    const { root } = this.workspace.getRequirementScope(requirementId)
    let review: RequirementReviewModel
    try { review = parseRequirementReviewJson(await fs.readFile(await safeExistingPath(root, reviewPath), 'utf8'), true) } catch (error) {
      if (error instanceof EspowToolError) throw error
      throw new EspowToolError('INVALID_INPUT', error instanceof Error ? error.message : 'Review Artifact 无效。')
    }
    const current = await requirementReviewWorkspaceState(root, this.reviewAdditionalPaths(requirementId))
    const stale = JSON.stringify(review.dependencies) !== JSON.stringify(current.dependencies)
    return { status: stale ? 'STALE' : 'CURRENT', conclusion: stale ? null : review.conclusion, changedDependencies: stale ? current.dependencies.filter((item) => !review.dependencies.some((old) => old.path === item.path && old.hash === item.hash)) : [] }
  }

  private async requirementReviewWrite(
    requirementId: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext
  ): Promise<Record<string, unknown>> {
    const reviewRunId = requiredString(input, 'reviewRunId')
    const confirmed = context.confirmedRequirementReview
    if (!confirmed || reviewRunId !== context.runId) return { status: 'approval-required', written: false }
    if (confirmed.reviewStatus !== 'READY_FOR_CONFIRMATION' || confirmed.prerequisite !== 'ConfirmedProductSpec' || !confirmed.readiness.deterministicPassed) {
      throw new EspowToolError('REVIEW_NOT_READY', '只有基于已确认 PRD 且通过 Gate 的 Requirement Review 可以正式写入。')
    }
    const { root } = this.workspace.getRequirementScope(requirementId)
    const state = await requirementReviewWorkspaceState(root, this.reviewAdditionalPaths(requirementId))
    if (state.fingerprint !== confirmed.baseFingerprint || state.modelPath !== confirmed.modelPath || state.markdownPath !== confirmed.markdownPath) {
      throw new EspowToolError('SOURCE_CHANGED', 'Review 依赖或目标版本在候选形成后发生变化。')
    }
    const confirmedAt = new Date().toISOString()
    const formal: RequirementReviewModel = { ...confirmed.review, reviewStatus: 'CONFIRMED', confirmedAt }
    const modelContent = `${JSON.stringify(formal, null, 2)}\n`
    const markdownContent = renderRequirementReviewMarkdown(formal)
    await fs.mkdir(resolve(root, 'review'), { recursive: true })
    const modelTarget = await safeNewPath(root, confirmed.modelPath)
    const markdownTarget = await safeNewPath(root, confirmed.markdownPath)
    for (const target of [modelTarget, markdownTarget]) {
      try { await fs.access(target, constants.F_OK); throw new EspowToolError('TARGET_EXISTS', 'Requirement Review 目标版本已存在。') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    await atomicCreate(modelTarget, modelContent)
    try { await atomicCreate(markdownTarget, markdownContent) } catch (error) { await fs.unlink(modelTarget).catch(() => undefined); throw error }
    return { status: 'written', written: true, paths: [confirmed.modelPath, confirmed.markdownPath], path: confirmed.markdownPath, confirmedAt, bytes: Buffer.byteLength(modelContent) + Buffer.byteLength(markdownContent) }
  }

  private async artifactNextVersion(requirementId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const newPath = optionalString(input, 'newPath')
    const artifact = newPath ? null : (await this.locate(requirementId, input)).artifact
    const { root } = this.workspace.getRequirementScope(requirementId)
    const sourcePath = artifact?.relativePath ?? normalizeRelativePath(newPath!)
    const directory = dirname(sourcePath)
    const extension = extname(sourcePath)
    const stem = basename(sourcePath, extension)
    const match = stem.match(/^(.*?)([-_. ]v)(\d+)$/i)
    const base = match?.[1] ?? stem
    const separator = match?.[2] ?? '-v'
    let entries: string[] = []
    try { entries = await fs.readdir(resolve(root, directory === '.' ? '' : directory)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const pattern = new RegExp(`^${escapeRegExp(base)}[-_. ]v(\\d+)${escapeRegExp(extension)}$`, 'i')
    let highest = artifact ? (match ? Number(match[3]) : 1) : 0
    for (const entry of entries) {
      const version = entry.match(pattern)?.[1]
      if (version) highest = Math.max(highest, Number(version))
    }
    const targetName = `${base}${separator}${highest + 1}${extension}`
    const targetPath = directory === '.' ? targetName : `${directory.split(sep).join('/')}/${targetName}`
    const target = await safePlannedPath(root, targetPath)
    try {
      await fs.access(target, constants.F_OK)
      throw new EspowToolError('VERSION_CONFLICT', `目标版本已存在：${targetPath}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return { sourcePath: artifact?.relativePath ?? null, targetPath, version: highest + 1 }
  }

  private async artifactDiff(requirementId: string, input: Record<string, unknown>, runId: string): Promise<Record<string, unknown>> {
    const candidate = requiredString(input, 'candidate', false)
    const writeMode = optionalString(input, 'writeMode') ?? 'new-version'
    if (writeMode !== 'new-version' && writeMode !== 'overwrite') throw new EspowToolError('INVALID_INPUT', 'writeMode 只能是 new-version 或 overwrite。')
    if (Buffer.byteLength(candidate, 'utf8') > maxArtifactBytes) throw new EspowToolError('FILE_TOO_LARGE', '候选 Artifact 超过 5 MB。')
    const { artifact, absolutePath } = await this.locate(requirementId, input)
    const before = await fs.readFile(absolutePath, 'utf8')
    const hasChanges = before !== candidate
    const approvalId = hasChanges ? randomUUID() : null
    const result: ArtifactDiffResult = {
      artifactId: artifact.id,
      path: artifact.relativePath,
      before,
      after: candidate,
      diff: hasChanges ? createTwoFilesPatch(artifact.relativePath, artifact.relativePath, before, candidate, 'current', 'candidate', { context: 3 }) : '',
      changedSections: changedSections(before, candidate, extname(artifact.relativePath).toLowerCase()),
      hasChanges,
      approvalId
    }
    const approval: WriteApprovalRequest | null = approvalId ? {
      id: approvalId, runId, requirementId, sourceArtifactId: artifact.id, sourcePath: artifact.relativePath,
      candidate, writeMode, diff: result, status: 'Pending', createdAt: new Date().toISOString(), resolvedAt: null
    } : null
    return { ...result, approval }
  }

  private async artifactWrite(requirementId: string, input: Record<string, unknown>, context: ToolExecutionContext): Promise<Record<string, unknown>> {
    const approvalId = requiredString(input, 'approvalId')
    const targetPath = normalizeRelativePath(requiredString(input, 'targetPath'))
    const approval = context.approvedApproval
    if (!approval || approval.id !== approvalId || approval.status !== 'Approved') {
      return { status: 'approval-required', approvalId, written: false }
    }
    if (approval.requirementId !== requirementId || approval.runId !== context.runId) {
      throw new EspowToolError('APPROVAL_MISMATCH', 'Approval 与当前 Run 或 Requirement 不匹配。')
    }
    const { root } = this.workspace.getRequirementScope(requirementId)
    const source = await safeExistingPath(root, approval.sourcePath)
    if (await fs.readFile(source, 'utf8') !== approval.diff.before) {
      throw new EspowToolError('SOURCE_CHANGED', '源 Artifact 在 Diff 后已变化，请重新读取并生成 Diff。')
    }
    if (approval.writeMode === 'overwrite' && targetPath !== approval.sourcePath) {
      throw new EspowToolError('APPROVAL_MISMATCH', '覆盖 Approval 只能写回原 Artifact。')
    }
    if (approval.writeMode === 'new-version' && targetPath === approval.sourcePath) {
      throw new EspowToolError('APPROVAL_MISMATCH', '新版本 Approval 不允许覆盖原 Artifact。')
    }
    const target = await safeNewPath(root, targetPath)
    if (approval.writeMode !== 'overwrite') {
      try {
        await fs.access(target, constants.F_OK)
        throw new EspowToolError('TARGET_EXISTS', `目标文件已存在，未执行覆盖：${targetPath}`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`)
    try {
      await fs.writeFile(temporary, approval.candidate, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      const handle = await fs.open(temporary, 'r')
      await handle.sync()
      await handle.close()
      if ((await fs.readFile(temporary, 'utf8')) !== approval.candidate) throw new EspowToolError('WRITE_FAILED', '临时文件内容校验失败。')
      if (this.persistence) {
        try { this.persistence.assertRunWritable(context.runId, context.workspaceId, context.requirementId) }
        catch (error) { throw new EspowToolError('RUN_NOT_WRITABLE', error instanceof Error ? error.message : 'Run 在写入前已不可写。') }
      }
      await fs.rename(temporary, target)
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined)
      throw error
    }
    return { status: 'written', written: true, path: targetPath, bytes: Buffer.byteLength(approval.candidate, 'utf8') }
  }

  private async workspaceValidate(requirementId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const path = optionalString(input, 'path')
    const sourcePath = optionalString(input, 'sourcePath')
    const before = this.workspace.getRequirementScope(requirementId)
    if (path) await safeExistingPath(before.root, path)
    if (sourcePath) await safeExistingPath(before.root, sourcePath)
    if (path && sourcePath && normalizeRelativePath(path) === normalizeRelativePath(sourcePath)) {
      throw new EspowToolError('VALIDATION_FAILED', '新版本错误覆盖了源 Artifact。')
    }
    const snapshot = await this.workspace.refreshCurrent()
    const requirement = snapshot.requirements.find((item) => item.id === requirementId)
    const checks = {
      requirementReadable: Boolean(requirement && !requirement.error),
      targetExists: path ? Boolean(requirement?.artifacts.some((item) => item.relativePath === normalizeRelativePath(path))) : true,
      sourcePreserved: sourcePath ? Boolean(requirement?.artifacts.some((item) => item.relativePath === normalizeRelativePath(sourcePath))) : true,
      artifactIndexConsistent: Boolean(requirement)
    }
    const valid = Object.values(checks).every(Boolean)
    if (!valid) throw new EspowToolError('VALIDATION_FAILED', `Workspace 校验失败：${JSON.stringify(checks)}`)
    return { valid, checks, warnings: requirement?.warnings ?? [] }
  }
}
