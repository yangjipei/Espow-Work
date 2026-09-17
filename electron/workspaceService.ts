import { promises as fs, rmSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { constants as fsConstants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { parse as parseYaml, parseDocument, stringify as stringifyYaml } from 'yaml'
import type {
  ArtifactContentResult,
  ArtifactFormat,
  LifecycleArtifactState,
  LifecycleArtifactStatus,
  RequirementLifecycle,
  RequirementStage,
  WorkspaceArtifact,
  WorkspaceDecision,
  WorkspaceOpenIssue,
  WorkspaceRequirement,
  WorkspaceSnapshot
} from '../src/workspace'
import type { CreateRequirementInput } from '../src/workspace'

const ignoredNames = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '__MACOSX', 'node_modules'])
const ignoredArtifactDirectories = new Set(['workdraft'])
const templateNames = new Set(['_template', 'template', 'templates'])
const overviewCandidates = ['overview.md', '00-snapshot.md']
const decisionCandidates = ['decisions.md', '01-decisions.md', 'changes/decisions.md']
const issueCandidates = ['open-issues.md', '02-open-issues.md', 'changes/open-issues.md', 'prd/requirement-supplement.md']
const maxArtifactBytes = 5 * 1024 * 1024
const textArtifactExtensions = new Set(['.md', '.txt', '.json', '.html', '.htm'])
const imageArtifactExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'])
const sourceInputExtensions = new Set([...textArtifactExtensions, ...imageArtifactExtensions])

interface RequirementLocation {
  id: string
  path: string
  artifactById: Map<string, WorkspaceArtifact>
}

interface StateFile {
  requirement_id?: unknown
  name?: unknown
  status?: unknown
  lifecycle_stage?: unknown
  current_artifact?: unknown
  updated_at?: unknown
  created_at?: unknown
  initial_request_path?: unknown
  primary_system_id?: unknown
}

export interface InitializedRequirement {
  workspace: WorkspaceSnapshot
  requirement: WorkspaceRequirement
  rollback: () => Promise<void>
}

export interface RenamedRequirement {
  workspace: WorkspaceSnapshot
  requirement: WorkspaceRequirement
  rollback: () => Promise<void>
}

export interface PreparedRequirementDeletion {
  workspaceId: string
  requirementId: string
  deleteDirectory: () => void
}

function isIgnored(name: string): boolean {
  return name.startsWith('.') || ignoredNames.has(name)
}

function text(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number') return String(value)
  return null
}

function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha1').update(value).digest('hex').slice(0, 12)}`
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date)
}

function requirementId(now: Date): string {
  const date = now.toISOString().slice(0, 10).replaceAll('-', '')
  return `REQ-${date}-${randomUUID().slice(0, 8).toUpperCase()}`
}

function safeDirectoryName(name: string, id: string): string {
  const base = name.normalize('NFKC').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^[.\s-]+|[.\s-]+$/g, '').slice(0, 72)
  if (!base) throw new Error('需求名称缺少可用于目录的字符。')
  return `${base}-${id.toLowerCase()}`
}

function normalizeRequirementName(value: string): string {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
  if (!name) throw new Error('需求名称不能为空。')
  if (name.length > 120) throw new Error('需求名称不能超过 120 个字符。')
  if (/[\u0000-\u001f\u007f/\\:*?"<>|]/.test(name) || name === '.' || name === '..') {
    throw new Error('需求名称包含非法目录字符。')
  }
  return name
}

const stageLabels: Record<RequirementStage, string> = {
  ANALYSIS: '需求分析', BUSINESS_FLOW: '业务流程', SOLUTION: '方案设计', INTERACTION: '交互设计',
  PROTOTYPE: '页面原型', PRODUCT_SPEC: 'PRD', REVIEW: '需求评审', READY: 'READY'
}

const nextActions: Record<Exclude<RequirementStage, 'READY'>, string> = {
  ANALYSIS: '开始分析当前需求',
  BUSINESS_FLOW: '基于已确认的需求分析，开始业务流程设计',
  SOLUTION: '基于已确认的需求分析和业务流程，开始方案设计',
  INTERACTION: '基于已确认的产品方案，开始交互设计',
  PROTOTYPE: '基于已确认的交互设计，生成页面原型',
  PRODUCT_SPEC: '基于已确认的上游产物，生成产品需求文档 PRD',
  REVIEW: '评审当前需求是否具备研发条件'
}

function artifactKind(path: string, format: ArtifactFormat): string {
  const lower = path.toLowerCase()
  if (lower.startsWith('source/')) return 'Source Input'
  if (lower.includes('analysis')) return 'Analysis'
  if (lower.includes('/prd/') || lower.startsWith('prd/') || /(^|\/)requirement[^/]*\.md$/.test(lower)) return 'PRD'
  if (lower.includes('prototype')) return 'Prototype'
  if (lower.includes('interaction')) return 'Interaction'
  if (lower.includes('flow')) return 'Business Flow'
  if (lower.includes('review')) return 'Review'
  if (lower.includes('solution') || lower.includes('方案')) return 'Solution'
  if (lower.includes('decision')) return 'Decision'
  if (lower.includes('open-issue')) return 'Open Issue'
  return format === 'html' ? 'HTML' : format === 'text' ? 'Text' : 'Markdown'
}

function artifactTitle(path: string): string {
  const file = basename(path, extname(path))
  return file.replace(/[-_]+/g, ' ').replace(/^\d+\s*/, '').trim() || file
}

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function firstExistingFile(root: string, candidates: string[]): Promise<{ path: string; content: string } | null> {
  for (const candidate of candidates) {
    const content = await readTextIfExists(join(root, candidate))
    if (content !== null) return { path: candidate, content }
  }
  return null
}

interface MarkdownTable {
  headers: string[]
  rows: string[][]
}

function relevantSection(content: string, heading: RegExp): string {
  const lines = content.split(/\r?\n/)
  const start = lines.findIndex((line) => /^#{1,6}\s+/.test(line) && heading.test(line))
  if (start < 0) return content
  const level = lines[start].match(/^#+/)?.[0].length ?? 1
  const endOffset = lines.slice(start + 1).findIndex((line) => {
    const match = line.match(/^(#+)\s+/)
    return match ? match[1].length <= level : false
  })
  return lines.slice(start, endOffset < 0 ? undefined : start + 1 + endOffset).join('\n')
}

function parseMarkdownTable(content: string): MarkdownTable | null {
  const rows = content.split(/\r?\n/)
    .filter((line) => line.trim().startsWith('|') && line.trim().endsWith('|'))
    .map((line) => line.trim().slice(1, -1).split('|').map((cell) => cell.trim()))
  if (rows.length < 2) return null
  const separator = rows.findIndex((row) => row.every((cell) => /^:?-{3,}:?$/.test(cell)))
  if (separator <= 0) return null
  return { headers: rows[separator - 1], rows: rows.slice(separator + 1).filter((row) => row.some(Boolean)) }
}

function tableCell(table: MarkdownTable, row: string[], aliases: string[], fallbackIndex: number): string {
  const index = table.headers.findIndex((header) => aliases.some((alias) => header.toLowerCase() === alias.toLowerCase()))
  return row[index >= 0 ? index : fallbackIndex] ?? ''
}

function parseDecisions(content: string): WorkspaceDecision[] {
  const table = parseMarkdownTable(relevantSection(content, /decisions?|决策/i))
  if (!table) return []
  return table.rows.map((row, index) => ({
    id: tableCell(table, row, ['ID', '决策编号'], 0) || `D-${index + 1}`,
    date: tableCell(table, row, ['日期', 'Date'], 1),
    title: tableCell(table, row, ['决策', 'Decision', '内容'], 2) || '未命名决策',
    detail: tableCell(table, row, ['背景/原因', '原因', '影响范围'], 3),
    status: tableCell(table, row, ['状态', 'Status'], 5)
  }))
}

function parseOpenIssues(content: string): WorkspaceOpenIssue[] {
  const table = parseMarkdownTable(relevantSection(content, /open issues?|待确认问题|未决/i))
  if (!table) return []
  return table.rows.map((row, index) => ({
    id: tableCell(table, row, ['ID', '问题编号'], 0) || `Q-${index + 1}`,
    title: tableCell(table, row, ['问题', 'Open Issue'], 1) || '未命名问题',
    detail: tableCell(table, row, ['影响', '影响范围', '来源'], 3),
    owner: tableCell(table, row, ['Owner', '责任人'], 4),
    status: tableCell(table, row, ['状态', 'Status'], 5)
  })).filter((issue) => !['resolved', 'closed', 'done', 'cancelled', 'canceled', '已解决', '已关闭', '已取消'].includes(issue.status.toLowerCase()))
}

async function firstStructuredFile<T>(root: string, candidates: string[], parser: (content: string) => T[]): Promise<T[]> {
  for (const candidate of candidates) {
    const content = await readTextIfExists(join(root, candidate))
    if (content === null) continue
    const values = parser(content)
    if (values.length) return values
  }
  return []
}

async function scanArtifacts(root: string): Promise<WorkspaceArtifact[]> {
  const artifacts: WorkspaceArtifact[] = []
  async function walk(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (isIgnored(entry.name) || templateNames.has(entry.name.toLowerCase())) continue
      const absolutePath = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!ignoredArtifactDirectories.has(entry.name.toLowerCase())) await walk(absolutePath)
        continue
      }
      if (!entry.isFile()) continue
      const extension = extname(entry.name).toLowerCase()
      if (!textArtifactExtensions.has(extension) && !imageArtifactExtensions.has(extension)) continue
      const stats = await fs.stat(absolutePath)
      const relativePath = relative(root, absolutePath).split(sep).join('/')
      const format: ArtifactFormat = imageArtifactExtensions.has(extension) ? 'image'
        : extension === '.md' ? 'markdown' : extension === '.txt' ? 'text'
          : extension === '.json' ? 'json' : 'html'
      artifacts.push({
        id: stableId('artifact', relativePath),
        title: artifactTitle(relativePath),
        kind: artifactKind(relativePath, format),
        format,
        relativePath,
        updatedAt: formatDate(stats.mtime),
        modifiedAt: stats.mtime.toISOString(),
        size: stats.size
      })
    }
  }
  await walk(root)
  return artifacts.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-CN'))
}

function artifactVersion(path: string): number | null {
  const value = Number(path.match(/-v(\d+)(?=\.[^.]+$)/i)?.[1] ?? 0)
  return value > 0 ? value : null
}

function latestArtifact(artifacts: WorkspaceArtifact[], pattern: RegExp): WorkspaceArtifact | null {
  return artifacts.filter((artifact) => pattern.test(artifact.relativePath)).sort((a, b) =>
    (artifactVersion(b.relativePath) ?? 0) - (artifactVersion(a.relativePath) ?? 0)
      || b.modifiedAt.localeCompare(a.modifiedAt))[0] ?? null
}

function normalizedStatus(value: unknown): LifecycleArtifactStatus {
  if (typeof value !== 'string') return 'DRAFT'
  const status = value.trim().replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[\s-]+/g, '_').toUpperCase()
  return ['DRAFT', 'WAITING_CLARIFICATION', 'READY_FOR_CONFIRMATION', 'CONFIRMED'].includes(status)
    ? status as LifecycleArtifactStatus : 'DRAFT'
}

async function jsonObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(path, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch { return null }
}

function blankLifecycleArtifact(id: LifecycleArtifactState['id'], label: string): LifecycleArtifactState {
  return { id, label, status: 'NOT_STARTED', version: null, updatedAt: null, paths: [], conclusion: null, blockerCount: 0, warningCount: 0 }
}

function sameVersionFamily(path: string, version: number): RegExp {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(`v${version}`, 'v(\\d+)')
  return new RegExp(`^${escaped}$`, 'i')
}

async function reviewIsStale(root: string, review: Record<string, unknown>, artifacts: WorkspaceArtifact[]): Promise<boolean> {
  const dependencies = Array.isArray(review.dependencies) ? review.dependencies : []
  if (!dependencies.length) return true
  for (const value of dependencies) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return true
    const dependency = value as Record<string, unknown>
    if (typeof dependency.path !== 'string' || typeof dependency.hash !== 'string') return true
    const content = await readTextIfExists(join(root, dependency.path))
    if (content === null || createHash('sha256').update(content).digest('hex') !== dependency.hash) return true
    if (typeof dependency.version === 'number') {
      const dependencyVersion = dependency.version
      const family = sameVersionFamily(dependency.path, dependencyVersion)
      if (artifacts.some((artifact) => Number(artifact.relativePath.match(family)?.[1] ?? 0) > dependencyVersion)) return true
    }
  }
  return false
}

async function deriveLifecycle(root: string, artifacts: WorkspaceArtifact[], openIssueCount: number): Promise<RequirementLifecycle> {
  const analysis = blankLifecycleArtifact('analysis', 'Requirement Analysis')
  const analysisArtifact = artifacts.find((artifact) => artifact.relativePath === 'analysis/requirement-analysis.md') ?? null
  if (analysisArtifact) {
    const content = await readTextIfExists(join(root, analysisArtifact.relativePath))
    const match = content?.match(/Analysis Status\s*[：:]\s*([A-Z_]+)/i)
    analysis.status = normalizedStatus(match?.[1])
    analysis.updatedAt = analysisArtifact.updatedAt
    analysis.paths = [analysisArtifact.relativePath]
  }

  const definitions: Array<[LifecycleArtifactState, RegExp, string]> = [
    [blankLifecycleArtifact('business-flow', 'Business Flow'), /^flows\/business-flow-v\d+\.json$/i, 'status'],
    [blankLifecycleArtifact('solution', 'Solution Design'), /^solution\/solution-design-v\d+\.json$/i, 'status'],
    [blankLifecycleArtifact('interaction', 'Interaction Design'), /^interaction\/interaction-design-v\d+\.json$/i, 'status'],
    [blankLifecycleArtifact('product-spec', 'Product Spec / PRD'), /^prd\/product-spec-v\d+\.json$/i, 'status'],
    [blankLifecycleArtifact('review', 'Requirement Review'), /^review\/requirement-review-v\d+\.json$/i, 'reviewStatus']
  ]
  const models = new Map<LifecycleArtifactState['id'], Record<string, unknown>>()
  const states = new Map<LifecycleArtifactState['id'], LifecycleArtifactState>([['analysis', analysis]])
  for (const [state, pattern, statusField] of definitions) {
    const artifact = latestArtifact(artifacts, pattern)
    if (artifact) {
      const model = await jsonObject(join(root, artifact.relativePath))
      if (model) {
        state.status = normalizedStatus(model[statusField])
        state.version = artifactVersion(artifact.relativePath)
        state.updatedAt = artifact.updatedAt
        state.paths = artifacts.filter((item) => artifactVersion(item.relativePath) === state.version && item.kind === artifact.kind).map((item) => item.relativePath)
        models.set(state.id, model)
        if (state.id === 'review') {
          state.conclusion = ['READY', 'READY_WITH_WARNINGS', 'NOT_READY'].includes(String(model.conclusion))
            ? model.conclusion as LifecycleArtifactState['conclusion'] : null
          const issues = Array.isArray(model.issues) ? model.issues.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) as Record<string, unknown>[] : []
          state.blockerCount = issues.filter((item) => item.status === 'OPEN' && item.severity === 'BLOCKER').length
          state.warningCount = issues.filter((item) => item.status === 'OPEN' && item.severity === 'WARNING').length
          if (await reviewIsStale(root, model, artifacts)) state.status = 'STALE'
        }
      }
    }
    states.set(state.id, state)
  }

  const prototype = blankLifecycleArtifact('prototype', 'Prototype')
  const prototypeArtifact = latestArtifact(artifacts, /^prototype\/.+-v\d+\.html$/i)
  if (prototypeArtifact) {
    prototype.status = 'CONFIRMED'
    prototype.version = artifactVersion(prototypeArtifact.relativePath)
    prototype.updatedAt = prototypeArtifact.updatedAt
    prototype.paths = [prototypeArtifact.relativePath]
  }
  states.set('prototype', prototype)

  const productSpec = models.get('product-spec')
  const interactionRequired = productSpec?.interactionRequired !== false
  if (!interactionRequired) {
    states.get('interaction')!.status = 'NOT_APPLICABLE'
    prototype.status = 'NOT_APPLICABLE'
  } else if (productSpec && productSpec.sourcePrototypePath === null && states.get('product-spec')?.status === 'CONFIRMED' && prototype.status === 'NOT_STARTED') {
    prototype.status = 'NOT_APPLICABLE'
  }

  const ordered = ['analysis', 'business-flow', 'solution', 'interaction', 'prototype', 'product-spec'] as const
  let latestUpstream = 0
  for (const id of ordered) {
    const state = states.get(id)!
    if (state.status === 'NOT_APPLICABLE') continue
    const modified = state.paths.reduce((latest, path) => Math.max(latest, Date.parse(artifacts.find((item) => item.relativePath === path)?.modifiedAt ?? '') || 0), 0)
    if (state.status === 'CONFIRMED' && latestUpstream > modified) state.status = 'NEEDS_RECHECK'
    latestUpstream = Math.max(latestUpstream, modified)
  }

  const confirmed = (id: LifecycleArtifactState['id']) => ['CONFIRMED', 'NOT_APPLICABLE'].includes(states.get(id)!.status)
  let stage: RequirementStage = !confirmed('analysis') ? 'ANALYSIS'
    : !confirmed('business-flow') ? 'BUSINESS_FLOW'
      : !confirmed('solution') ? 'SOLUTION'
        : !confirmed('interaction') ? 'INTERACTION'
          : !confirmed('prototype') ? 'PROTOTYPE'
            : !confirmed('product-spec') ? 'PRODUCT_SPEC'
              : states.get('review')!.status !== 'CONFIRMED' || states.get('review')!.conclusion === 'NOT_READY' ? 'REVIEW' : 'READY'

  const attention: RequirementLifecycle['attention'] = []
  if (openIssueCount) attention.push({ kind: 'OPEN_ISSUES', label: `${openIssueCount} 个 Open Issue`, count: openIssueCount })
  const recheckCount = [...states.values()].filter((state) => state.status === 'NEEDS_RECHECK').length
  if (recheckCount) attention.push({ kind: 'ARTIFACT_RECHECK', label: `${recheckCount} 个 Artifact 需要复核`, count: recheckCount })
  const review = states.get('review')!
  if (review.status === 'STALE') attention.push({ kind: 'REVIEW_STALE', label: 'Review 已过期', count: 1 })
  else if (review.status === 'CONFIRMED' && review.conclusion === 'NOT_READY') attention.push({ kind: 'REVIEW_NOT_READY', label: `Review 有 ${review.blockerCount} 个 Blocker`, count: review.blockerCount })
  const status = stage === 'READY' ? (review.conclusion === 'READY_WITH_WARNINGS' ? 'READY_WITH_WARNINGS' : 'READY')
    : attention.length ? 'NEEDS_ATTENTION' : 'IN_PROGRESS'
  return {
    stage, stageLabel: stageLabels[stage], status,
    artifacts: ['analysis', 'business-flow', 'solution', 'interaction', 'prototype', 'product-spec', 'review'].map((id) => states.get(id as LifecycleArtifactState['id'])!),
    attention, nextAction: stage === 'READY' ? null : nextActions[stage]
  }
}

function emptyLifecycle(): RequirementLifecycle {
  return { stage: 'ANALYSIS', stageLabel: stageLabels.ANALYSIS, status: 'IN_PROGRESS', artifacts: [
    blankLifecycleArtifact('analysis', 'Requirement Analysis'), blankLifecycleArtifact('business-flow', 'Business Flow'),
    blankLifecycleArtifact('solution', 'Solution Design'), blankLifecycleArtifact('interaction', 'Interaction Design'),
    blankLifecycleArtifact('prototype', 'Prototype'), blankLifecycleArtifact('product-spec', 'Product Spec / PRD'),
    blankLifecycleArtifact('review', 'Requirement Review')
  ], attention: [], nextAction: nextActions.ANALYSIS }
}

async function readState(requirementPath: string, warnings: string[]): Promise<StateFile> {
  const raw = await readTextIfExists(join(requirementPath, 'state.yaml'))
  if (raw === null) {
    warnings.push('缺少 state.yaml，状态与阶段使用默认值。')
    return {}
  }
  try {
    const parsed: unknown = parseYaml(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('根节点不是对象')
    return parsed as StateFile
  } catch (error) {
    warnings.push(`state.yaml 无法解析：${error instanceof Error ? error.message : '未知错误'}`)
    return {}
  }
}

export class LocalWorkspaceService {
  private currentRoot: string | null = null
  private currentRequirementsDirectory: string | null = null
  private requirementLocations = new Map<string, RequirementLocation>()
  private requirements = new Map<string, WorkspaceRequirement>()

  async scan(rootPath: string): Promise<WorkspaceSnapshot> {
    const root = resolve(rootPath)
    const rootStats = await fs.stat(root)
    if (!rootStats.isDirectory()) throw new Error('选择的路径不是目录。')

    const nestedRequirements = join(root, 'requirements')
    let requirementsDirectory = root
    try {
      if ((await fs.stat(nestedRequirements)).isDirectory()) requirementsDirectory = nestedRequirements
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    const entries = await fs.readdir(requirementsDirectory, { withFileTypes: true })
    const directories = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()
      && !isIgnored(entry.name) && !templateNames.has(entry.name.toLowerCase()))
    const requirements = await Promise.all(directories.map((entry) => this.scanRequirement(join(requirementsDirectory, entry.name), entry.name)))
    requirements.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt, 'zh-CN'))

    this.currentRoot = root
    this.currentRequirementsDirectory = requirementsDirectory
    this.requirementLocations = new Map(requirements.map((requirement) => [requirement.id, {
      id: requirement.id,
      path: join(requirementsDirectory, requirement.directoryName),
      artifactById: new Map(requirement.artifacts.map((artifact) => [artifact.id, artifact]))
    }]))
    this.requirements = new Map(requirements.map((requirement) => [requirement.id, requirement]))
    return {
      id: stableId('workspace', root),
      rootPath: root,
      name: basename(root),
      requirementsDirectory: relative(root, requirementsDirectory) || '.',
      requirements,
      scannedAt: new Date().toISOString()
    }
  }

  getRuntimeContext(requirementId: string): {
    cwd: string
    id: string
    title: string
    status: string
    stage: string
    overview: string | null
  } {
    const location = this.requirementLocations.get(requirementId)
    const requirement = this.requirements.get(requirementId)
    if (!location || !requirement || !this.currentRoot) throw new Error('Requirement 不属于当前 Workspace。')
    return {
      cwd: location.path,
      id: requirement.id,
      title: requirement.title,
      status: requirement.status,
      stage: requirement.stage,
      overview: requirement.overview?.slice(0, 6_000) ?? null
    }
  }

  getRequirementScope(requirementId: string): { root: string; requirement: WorkspaceRequirement } {
    const location = this.requirementLocations.get(requirementId)
    const requirement = this.requirements.get(requirementId)
    if (!location || !requirement || !this.currentRoot) throw new Error('Requirement 不属于当前 Workspace。')
    return { root: location.path, requirement }
  }

  getArtifact(requirementId: string, artifactId: string): WorkspaceArtifact | null {
    return this.requirementLocations.get(requirementId)?.artifactById.get(artifactId) ?? null
  }

  getArtifactByPath(requirementId: string, relativePath: string): WorkspaceArtifact | null {
    const location = this.requirementLocations.get(requirementId)
    if (!location) return null
    const normalized = relativePath.split('\\').join('/')
    return [...location.artifactById.values()].find((artifact) => artifact.relativePath === normalized) ?? null
  }

  async refreshCurrent(): Promise<WorkspaceSnapshot> {
    if (!this.currentRoot) throw new Error('尚未选择 Workspace。')
    return this.scan(this.currentRoot)
  }

  async updateRequirementSystem(requirementId: string, primarySystemId: string | null): Promise<WorkspaceSnapshot> {
    const { location } = await this.requireSafeRequirementLocation(requirementId)
    const statePath = join(location.path, 'state.yaml')
    const original = await fs.readFile(statePath, 'utf8')
    const document = parseDocument(original)
    if (document.errors.length) throw document.errors[0]
    if (primarySystemId) document.set('primary_system_id', primarySystemId)
    else document.delete('primary_system_id')
    document.set('updated_at', new Date().toISOString())
    const temporary = join(location.path, `.state-${randomUUID()}.tmp`)
    try {
      await fs.writeFile(temporary, document.toString(), { encoding: 'utf8', flag: 'wx' })
      await fs.rename(temporary, statePath)
      return await this.scan(this.currentRoot!)
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined)
      await fs.writeFile(statePath, original, 'utf8').catch(() => undefined)
      await this.scan(this.currentRoot!).catch(() => undefined)
      throw new Error(`更新所属产品 / 系统失败：${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  async renameRequirement(requirementId: string, requestedName: string): Promise<RenamedRequirement> {
    const { location, requirementsRoot } = await this.requireSafeRequirementLocation(requirementId)
    const name = normalizeRequirementName(requestedName)
    if ([...this.requirements.values()].some((item) => item.id !== requirementId
      && item.title.normalize('NFKC').toLocaleLowerCase() === name.normalize('NFKC').toLocaleLowerCase())) {
      throw new Error('已存在同名需求，请使用其他名称。')
    }

    const directoryName = safeDirectoryName(name, requirementId)
    const targetPath = join(requirementsRoot, directoryName)
    if (targetPath !== location.path) {
      try {
        await fs.lstat(targetPath)
        throw new Error('已存在同名需求，请使用其他名称。')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }

    const originalPath = location.path
    const originalState = await fs.readFile(join(originalPath, 'state.yaml'), 'utf8')
    let moved = false
    let stateChanged = false
    let temporaryState: string | null = null
    try {
      if (targetPath !== originalPath) {
        await fs.rename(originalPath, targetPath)
        moved = true
      }
      const document = parseDocument(originalState)
      if (document.errors.length) throw document.errors[0]
      document.set('name', name)
      temporaryState = join(targetPath, `.state-${randomUUID()}.tmp`)
      await fs.writeFile(temporaryState, document.toString(), { encoding: 'utf8', flag: 'wx' })
      await fs.rename(temporaryState, join(targetPath, 'state.yaml'))
      temporaryState = null
      stateChanged = true
      const workspace = await this.scan(this.currentRoot!)
      const renamed = workspace.requirements.find((item) => item.id === requirementId)
      if (!renamed || renamed.title !== name) throw new Error('重命名后的 Requirement 无法被 Workspace Scanner 识别。')
      return {
        workspace,
        requirement: renamed,
        rollback: async () => {
          const currentPath = moved ? targetPath : originalPath
          if (stateChanged) await fs.writeFile(join(currentPath, 'state.yaml'), originalState, 'utf8')
          if (moved) await fs.rename(targetPath, originalPath)
          await this.scan(this.currentRoot!)
        }
      }
    } catch (error) {
      const currentPath = moved ? targetPath : originalPath
      if (temporaryState) await fs.unlink(temporaryState).catch(() => undefined)
      if (stateChanged) await fs.writeFile(join(currentPath, 'state.yaml'), originalState, 'utf8').catch(() => undefined)
      if (moved) await fs.rename(targetPath, originalPath).catch(() => undefined)
      await this.scan(this.currentRoot!).catch(() => undefined)
      throw new Error(`重命名 Requirement 失败：${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  async prepareRequirementDeletion(requirementId: string): Promise<PreparedRequirementDeletion> {
    const { location } = await this.requireSafeRequirementLocation(requirementId)
    return {
      workspaceId: stableId('workspace', this.currentRoot!),
      requirementId,
      deleteDirectory: () => rmSync(location.path, { recursive: true })
    }
  }

  private async requireSafeRequirementLocation(requirementId: string): Promise<{
    location: RequirementLocation
    requirement: WorkspaceRequirement
    requirementsRoot: string
  }> {
    const location = this.requirementLocations.get(requirementId)
    const requirement = this.requirements.get(requirementId)
    if (!location || !requirement || !this.currentRoot || !this.currentRequirementsDirectory) {
      throw new Error('Requirement 不属于当前 Workspace。')
    }
    const expectedRequirementsRoot = resolve(this.currentRoot, 'requirements')
    if (resolve(this.currentRequirementsDirectory) !== expectedRequirementsRoot) {
      throw new Error('Requirement 目录不在当前 Workspace 的 requirements/ 下。')
    }
    const requirementsRoot = await fs.realpath(this.currentRequirementsDirectory)
    const stats = await fs.lstat(location.path)
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('Requirement 目录无效或为符号链接。')
    const target = await fs.realpath(location.path)
    if (dirname(target) !== requirementsRoot || target === requirementsRoot || target === resolve(this.currentRoot)
      || !target.startsWith(`${requirementsRoot}${sep}`)) {
      throw new Error('Requirement 路径越过当前 Workspace 的 requirements/ 边界。')
    }
    return { location: { ...location, path: target }, requirement, requirementsRoot }
  }

  async addSourceInputs(requirementId: string, sourcePaths: string[]): Promise<{ workspace: WorkspaceSnapshot; added: WorkspaceArtifact[] }> {
    const location = this.requirementLocations.get(requirementId)
    if (!location || !this.currentRoot) throw new Error('Requirement 不属于当前 Workspace。')
    if (!Array.isArray(sourcePaths) || !sourcePaths.length) throw new Error('没有选择参考资料。')
    const inputs = await Promise.all(sourcePaths.map(async (sourcePath) => {
      const extension = extname(sourcePath).toLowerCase()
      if (!sourceInputExtensions.has(extension)) throw new Error(`暂不支持 ${extension || '无扩展名'} 文件。`)
      const stats = await fs.stat(sourcePath)
      if (!stats.isFile()) throw new Error(`${basename(sourcePath)} 不是文件。`)
      if (stats.size > maxArtifactBytes) throw new Error(`${basename(sourcePath)} 超过 5 MB。`)
      return { sourcePath, name: basename(sourcePath), extension }
    }))
    const sourceDirectory = join(location.path, 'source')
    await fs.mkdir(sourceDirectory, { recursive: true })
    const copied: string[] = []
    try {
      for (const input of inputs) {
        const stem = basename(input.name, input.extension)
        let candidate = input.name
        let suffix = 2
        while (true) {
          const target = join(sourceDirectory, candidate)
          try {
            await fs.copyFile(input.sourcePath, target, fsConstants.COPYFILE_EXCL)
            copied.push(target)
            break
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
            candidate = `${stem}-${suffix}${input.extension}`
            suffix += 1
          }
        }
      }
      const workspace = await this.scan(this.currentRoot)
      const requirement = workspace.requirements.find((item) => item.id === requirementId)
      if (!requirement) throw new Error('添加参考资料后无法恢复 Requirement。')
      const copiedRelativePaths = new Set(copied.map((path) => relative(location.path, path).split(sep).join('/')))
      return { workspace, added: requirement.artifacts.filter((artifact) => copiedRelativePaths.has(artifact.relativePath)) }
    } catch (error) {
      await Promise.all(copied.map((path) => fs.unlink(path).catch(() => undefined)))
      throw new Error(`添加参考资料失败：${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  async addRequirementInfo(requirementId: string, value: string): Promise<{ workspace: WorkspaceSnapshot; added: WorkspaceArtifact }> {
    const content = typeof value === 'string' ? value.trim() : ''
    if (!content) throw new Error('补充需求信息不能为空。')
    const { location } = await this.requireSafeRequirementLocation(requirementId)
    const sourceDirectory = join(location.path, 'source')
    await fs.mkdir(sourceDirectory, { recursive: true })
    let index = 1
    let target = join(sourceDirectory, 'requirement-info.md')
    while (true) {
      try {
        await fs.writeFile(target, `${content}\n`, { encoding: 'utf8', flag: 'wx' })
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        index += 1
        target = join(sourceDirectory, `requirement-info-${index}.md`)
      }
    }
    try {
      const workspace = await this.scan(this.currentRoot!)
      const requirement = workspace.requirements.find((item) => item.id === requirementId)
      const relativePath = relative(location.path, target).split(sep).join('/')
      const added = requirement?.artifacts.find((artifact) => artifact.relativePath === relativePath)
      if (!added) throw new Error('补充信息写入后无法恢复。')
      return { workspace, added }
    } catch (error) {
      await fs.unlink(target).catch(() => undefined)
      await this.scan(this.currentRoot!).catch(() => undefined)
      throw new Error(`新增需求信息失败：${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  async initializeRequirement(input: CreateRequirementInput): Promise<InitializedRequirement> {
    if (!this.currentRoot || !this.currentRequirementsDirectory) throw new Error('尚未选择 Workspace。')
    const name = typeof input?.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : ''
    if (!name) throw new Error('需求名称不能为空。')
    if (name.length > 120) throw new Error('需求名称不能超过 120 个字符。')
    const initialRequest = typeof input.initialRequest === 'string' ? input.initialRequest.trim() : ''
    const now = new Date()
    const id = requirementId(now)
    const currentDirectory = this.currentRequirementsDirectory
    const useNestedDirectory = currentDirectory === this.currentRoot && this.requirements.size === 0
    const requirementsDirectory = useNestedDirectory ? join(this.currentRoot, 'requirements') : currentDirectory
    let createdRequirementsDirectory = false
    let temporaryPath: string | null = null
    let targetPath: string | null = null
    let committedTarget = false

    try {
      try {
        const stats = await fs.stat(requirementsDirectory)
        if (!stats.isDirectory()) throw new Error('requirements 路径不是目录。')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await fs.mkdir(requirementsDirectory)
        createdRequirementsDirectory = true
      }
      await fs.access(requirementsDirectory, fsConstants.W_OK)
      const directoryName = safeDirectoryName(name, id)
      targetPath = join(requirementsDirectory, directoryName)
      temporaryPath = await fs.mkdtemp(join(requirementsDirectory, '.espow-requirement-'))
      const createdAt = now.toISOString()
      const state: Record<string, string> = {
        requirement_id: id,
        name,
        status: 'ACTIVE',
        lifecycle_stage: 'analysis',
        created_at: createdAt,
        updated_at: createdAt
      }
      if (input.primarySystemId) state.primary_system_id = input.primarySystemId
      if (initialRequest) state.initial_request_path = 'source/initial-request.txt'
      await fs.writeFile(join(temporaryPath, 'state.yaml'), stringifyYaml(state), { encoding: 'utf8', flag: 'wx' })
      await fs.writeFile(join(temporaryPath, 'overview.md'), `# ${name}\n\n创建时间：${createdAt}\n\n当前状态：ACTIVE\n\n当前阶段：需求分析\n`, { encoding: 'utf8', flag: 'wx' })
      if (initialRequest) {
        await fs.mkdir(join(temporaryPath, 'source'))
        await fs.writeFile(join(temporaryPath, 'source', 'initial-request.txt'), `${initialRequest}\n`, { encoding: 'utf8', flag: 'wx' })
      }
      try {
        await fs.lstat(targetPath)
        throw new Error('Requirement ID 冲突，请重试。')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await fs.rename(temporaryPath, targetPath)
      committedTarget = true
      temporaryPath = null
      const workspace = await this.scan(this.currentRoot)
      const requirement = workspace.requirements.find((item) => item.id === id)
      if (!requirement || requirement.error) throw new Error('新 Requirement 无法被 Workspace Scanner 识别。')
      return {
        workspace,
        requirement,
        rollback: async () => {
          if (targetPath && committedTarget) await fs.rm(targetPath, { recursive: true, force: true })
          if (createdRequirementsDirectory) await fs.rmdir(requirementsDirectory).catch(() => undefined)
          await this.scan(this.currentRoot!)
        }
      }
    } catch (error) {
      if (temporaryPath) await fs.rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined)
      if (targetPath && committedTarget) await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined)
      if (createdRequirementsDirectory) await fs.rmdir(requirementsDirectory).catch(() => undefined)
      if (this.currentRoot) await this.scan(this.currentRoot).catch(() => undefined)
      throw new Error(`创建 Requirement 失败：${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  async refreshRequirement(requirementId: string): Promise<WorkspaceRequirement> {
    const location = this.requirementLocations.get(requirementId)
    const current = this.requirements.get(requirementId)
    if (!location || !current || !this.currentRoot) throw new Error('Requirement 不属于当前 Workspace。')
    const requirement = await this.scanRequirement(location.path, current.directoryName)
    if (requirement.id !== requirementId) throw new Error('Requirement identity 已变化，请刷新 Workspace。')
    this.requirements.set(requirementId, requirement)
    this.requirementLocations.set(requirementId, {
      id: requirementId,
      path: location.path,
      artifactById: new Map(requirement.artifacts.map((artifact) => [artifact.id, artifact]))
    })
    return requirement
  }

  async readArtifact(requirementId: string, artifactId: string): Promise<ArtifactContentResult> {
    const location = this.requirementLocations.get(requirementId)
    const artifact = location?.artifactById.get(artifactId)
    if (!location || !artifact || !this.currentRoot) return { artifact: null, content: null, error: 'Artifact 不属于当前 Workspace。' }
    if (artifact.size > maxArtifactBytes) return { artifact, content: null, error: 'Artifact 超过 5 MB，暂不支持预览。' }
    const absolutePath = resolve(location.path, artifact.relativePath)
    if (!absolutePath.startsWith(`${resolve(location.path)}${sep}`)) return { artifact, content: null, error: 'Artifact 路径越过 Requirement 边界。' }
    try {
      if (artifact.format === 'image') {
        const mimeTypes: Record<string, string> = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
          '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp'
        }
        const data = await fs.readFile(absolutePath)
        return { artifact, content: `data:${mimeTypes[extname(absolutePath).toLowerCase()]};base64,${data.toString('base64')}` }
      }
      return { artifact, content: await fs.readFile(absolutePath, 'utf8') }
    } catch (error) {
      return { artifact, content: null, error: `读取 Artifact 失败：${error instanceof Error ? error.message : '未知错误'}` }
    }
  }

  private async scanRequirement(requirementPath: string, directoryName: string): Promise<WorkspaceRequirement> {
    const warnings: string[] = []
    try {
      const state = await readState(requirementPath, warnings)
      const overviewFile = await firstExistingFile(requirementPath, overviewCandidates)
      if (!overviewFile) warnings.push('缺少 Overview（overview.md 或 00-snapshot.md）。')
      const decisions = await firstStructuredFile(requirementPath, decisionCandidates, parseDecisions)
      const openIssues = await firstStructuredFile(requirementPath, issueCandidates, parseOpenIssues)
      const artifacts = await scanArtifacts(requirementPath)
      const lifecycle = await deriveLifecycle(requirementPath, artifacts, openIssues.length)
      const initialRequestPath = text(state.initial_request_path)
      if (initialRequestPath && initialRequestPath !== 'source/initial-request.txt') warnings.push('initial_request_path 不符合当前 Workspace Contract。')
      const initialRequest = initialRequestPath === 'source/initial-request.txt'
        ? await readTextIfExists(join(requirementPath, initialRequestPath)) : null
      const stats = await fs.stat(requirementPath)
      const stateUpdatedAt = text(state.updated_at)
      const latestUpdate = Math.max(stats.mtimeMs, Date.parse(stateUpdatedAt ?? '') || 0,
        ...artifacts.map((artifact) => Date.parse(artifact.modifiedAt) || 0))
      const updatedAt = formatDate(new Date(latestUpdate))
      return {
        id: text(state.requirement_id) ?? stableId('requirement', directoryName),
        directoryName,
        title: text(state.name) ?? directoryName,
        status: text(state.status) ?? '未标注',
        stage: lifecycle.stage,
        stageLabel: lifecycle.stageLabel,
        lifecycle,
        updatedAt,
        overview: overviewFile?.content ?? null,
        overviewPath: overviewFile?.path ?? null,
        initialRequest: initialRequest?.trim() || null,
        currentArtifact: text(state.current_artifact),
        primarySystemId: text(state.primary_system_id),
        decisions,
        openIssues,
        artifacts,
        warnings,
        error: null
      }
    } catch (error) {
      return {
        id: stableId('requirement', directoryName), directoryName, title: directoryName, status: '异常', stage: 'ANALYSIS', stageLabel: stageLabels.ANALYSIS, lifecycle: emptyLifecycle(),
        updatedAt: '', overview: null, overviewPath: null, initialRequest: null, currentArtifact: null, primarySystemId: null, decisions: [], openIssues: [], artifacts: [], warnings,
        error: error instanceof Error ? error.message : '未知扫描错误'
      }
    }
  }
}
