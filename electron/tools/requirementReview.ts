import { createHash } from 'node:crypto'
import type {
  RequirementReviewModel, RequirementReviewReadiness, ReviewCategory, ReviewConclusion,
  ReviewCoverage, ReviewDependency, ReviewEvidence, ReviewIssue, ReviewSeverity
} from '../../src/skills'

type Json = Record<string, unknown>

const severities = new Set<ReviewSeverity>(['BLOCKER', 'WARNING', 'INFO'])
const categories = new Set<ReviewCategory>(['Scope', 'Flow', 'Solution', 'Interaction', 'Prototype', 'Rule', 'State', 'Field', 'Data', 'Exception', 'Recovery', 'Dependency', 'Consistency', 'Acceptance'])
const stages = new Set<ReviewIssue['recommendedStage']>(['Requirement Analysis', 'Business Flow', 'Solution Design', 'Interaction Design', 'Prototype', 'Product Spec'])

function object(value: unknown, label: string): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象。`)
  return value as Json
}

function text(value: Json, field: string, nullable = false): string | null {
  const result = value[field]
  if (nullable && result === null) return null
  if (typeof result !== 'string' || (!nullable && !result.trim())) throw new Error(`${field} 必须是${nullable ? '字符串或 null' : '非空字符串'}。`)
  return result
}

function strings(value: Json, field: string): string[] {
  const result = value[field]
  if (!Array.isArray(result) || !result.every((item) => typeof item === 'string')) throw new Error(`${field} 必须是字符串数组。`)
  return result
}

function list<T>(value: Json, field: string, parse: (item: Json) => T): T[] {
  const result = value[field]
  if (!Array.isArray(result)) throw new Error(`${field} 必须是数组。`)
  return result.map((item) => parse(object(item, field)))
}

function boolean(value: Json, field: string): boolean {
  if (typeof value[field] !== 'boolean') throw new Error(`${field} 必须是布尔值。`)
  return value[field] as boolean
}

function parseEvidence(value: Json): ReviewEvidence {
  return { artifactPath: text(value, 'artifactPath')!, reference: text(value, 'reference')!, excerpt: text(value, 'excerpt')! }
}

function parseIssue(value: Json): ReviewIssue {
  const severity = text(value, 'severity') as ReviewSeverity
  const category = text(value, 'category') as ReviewCategory
  const recommendedStage = text(value, 'recommendedStage') as ReviewIssue['recommendedStage']
  const status = text(value, 'status') as ReviewIssue['status']
  if (!severities.has(severity)) throw new Error('severity 无效。')
  if (!categories.has(category)) throw new Error('category 无效。')
  if (!stages.has(recommendedStage)) throw new Error('recommendedStage 无效。')
  if (!['OPEN', 'RESOLVED', 'ACCEPTED'].includes(status)) throw new Error('issue status 无效。')
  return {
    id: text(value, 'id')!, severity, category, title: text(value, 'title')!, description: text(value, 'description')!,
    evidence: list(value, 'evidence', parseEvidence), impact: text(value, 'impact')!, sourceArtifacts: strings(value, 'sourceArtifacts'),
    recommendedStage, status
  }
}

function parseCoverage(value: Json): ReviewCoverage {
  const status = text(value, 'status') as ReviewCoverage['status']
  if (!['PASS', 'ISSUE', 'NOT_APPLICABLE'].includes(status)) throw new Error('coverage status 无效。')
  return { dimension: text(value, 'dimension')!, status, notes: text(value, 'notes')! }
}

function parseDependency(value: Json): ReviewDependency {
  const version = value.version
  if (version !== null && (!Number.isInteger(version) || Number(version) < 1)) throw new Error('dependency version 必须为正整数或 null。')
  return { path: text(value, 'path')!, hash: text(value, 'hash')!, version: version === null ? null : Number(version) }
}

export function parseRequirementReviewJson(json: string, allowConfirmed = false): RequirementReviewModel {
  const value = object(JSON.parse(json), 'Requirement Review')
  const reviewStatus = text(value, 'reviewStatus') as RequirementReviewModel['reviewStatus']
  const allowed = ['DRAFT_REVIEW', 'READY_FOR_CONFIRMATION', ...(allowConfirmed ? ['CONFIRMED', 'STALE'] : [])]
  if (!allowed.includes(reviewStatus)) throw new Error('reviewStatus 无效。')
  const conclusion = text(value, 'conclusion') as ReviewConclusion
  if (!['READY', 'READY_WITH_WARNINGS', 'NOT_READY'].includes(conclusion)) throw new Error('conclusion 无效。')
  return {
    id: text(value, 'id')!, name: text(value, 'name')!, reviewStatus, conclusion, summary: text(value, 'summary')!,
    issues: list(value, 'issues', parseIssue), coverage: list(value, 'coverage', parseCoverage),
    consistency: strings(value, 'consistency'), openIssues: strings(value, 'openIssues'), recommendedActions: strings(value, 'recommendedActions'),
    dependencies: list(value, 'dependencies', parseDependency), draftReview: boolean(value, 'draftReview'), createdAt: text(value, 'createdAt')!,
    confirmedAt: text(value, 'confirmedAt', true)
  }
}

export function conclusionFor(issues: ReviewIssue[]): ReviewConclusion {
  const open = issues.filter((item) => item.status === 'OPEN')
  if (open.some((item) => item.severity === 'BLOCKER')) return 'NOT_READY'
  if (open.some((item) => item.severity === 'WARNING')) return 'READY_WITH_WARNINGS'
  return 'READY'
}

export function requirementReviewReadiness(review: RequirementReviewModel): RequirementReviewReadiness {
  const missing: string[] = []
  const warnings: string[] = []
  if (!review.dependencies.length) missing.push('artifacts_reviewed')
  if (!review.coverage.length) missing.push('coverage')
  if (new Set(review.issues.map((item) => item.id)).size !== review.issues.length) missing.push('issue_ids_unique')
  if (review.issues.some((item) => !item.evidence.length || !item.sourceArtifacts.length)) missing.push('issue_evidence')
  if (review.issues.some((item) => item.evidence.some((evidence) => !item.sourceArtifacts.includes(evidence.artifactPath)))) missing.push('evidence_source_consistency')
  const dependencyPaths = new Set(review.dependencies.map((item) => item.path))
  if (review.issues.some((item) => item.sourceArtifacts.some((path) => !dependencyPaths.has(path)))) missing.push('issue_source_dependency')
  const calculated = conclusionFor(review.issues)
  const resultConsistent = calculated === review.conclusion
  if (!resultConsistent) missing.push('conclusion_severity_consistency')
  if (review.reviewStatus === 'READY_FOR_CONFIRMATION' && review.draftReview) missing.push('draft_cannot_be_final')
  if (review.issues.some((item) => item.severity === 'INFO' && /无法开发|无法验收|必须确认/.test(item.impact))) warnings.push('possible_understated_severity')
  return { deterministicPassed: missing.length === 0, resultConsistent, missing: [...new Set(missing)], warnings }
}

export function dependencyHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

const bullets = (items: string[]) => items.length ? items.map((item) => `- ${item}`).join('\n') : '—'

export function renderRequirementReviewMarkdown(review: RequirementReviewModel): string {
  const issues = (severity: ReviewSeverity) => review.issues.filter((item) => item.severity === severity).map((item) => {
    const evidence = item.evidence.map((entry) => `  - ${entry.artifactPath} · ${entry.reference}：${entry.excerpt}`).join('\n')
    return `- **${item.id} · ${item.category} · ${item.title}**\n  - 问题：${item.description}\n  - 影响：${item.impact}\n  - 建议阶段：${item.recommendedStage}\n  - 状态：${item.status}\n  - 证据：\n${evidence}`
  }).join('\n') || '—'
  const coverage = review.coverage.map((item) => `- **${item.dimension}**：${item.status} — ${item.notes}`).join('\n') || '—'
  return `# Requirement Review\n\n## Review Summary\n\n- Result：${review.conclusion}\n- Review Status：${review.reviewStatus}\n- Created At：${review.createdAt}\n- Draft Review：${review.draftReview ? 'Yes' : 'No'}\n\n${review.summary}\n\n## Blockers\n\n${issues('BLOCKER')}\n\n## Warnings\n\n${issues('WARNING')}\n\n## Info\n\n${issues('INFO')}\n\n## Coverage\n\n${coverage}\n\n## Consistency\n\n${bullets(review.consistency)}\n\n## Open Issues\n\n${bullets(review.openIssues)}\n\n## Recommended Actions\n\n${bullets(review.recommendedActions)}\n\n## Artifacts Reviewed\n\n${review.dependencies.map((item) => `- ${item.path} (${item.hash.slice(0, 12)})`).join('\n')}\n`
}
