export const workspaceIpc = {
  getRecent: 'workspace:get-recent',
  choose: 'workspace:choose',
  refresh: 'workspace:refresh',
  createRequirement: 'workspace:create-requirement',
  renameRequirement: 'workspace:rename-requirement',
  deleteRequirement: 'workspace:delete-requirement',
  updateRequirementSystem: 'workspace:update-requirement-system',
  addRequirementInfo: 'workspace:add-requirement-info',
  addSourceInputs: 'workspace:add-source-inputs',
  readArtifact: 'workspace:read-artifact'
} as const

export type ArtifactFormat = 'markdown' | 'text' | 'html' | 'json' | 'image'

export type RequirementStage = 'ANALYSIS' | 'BUSINESS_FLOW' | 'SOLUTION' | 'INTERACTION' | 'PROTOTYPE' | 'PRODUCT_SPEC' | 'REVIEW' | 'READY'
export type LifecycleArtifactId = 'analysis' | 'business-flow' | 'solution' | 'interaction' | 'prototype' | 'product-spec' | 'review'
export type LifecycleArtifactStatus = 'NOT_STARTED' | 'DRAFT' | 'WAITING_CLARIFICATION' | 'READY_FOR_CONFIRMATION' | 'CONFIRMED' | 'NOT_APPLICABLE' | 'NEEDS_RECHECK' | 'STALE'

export interface LifecycleArtifactState {
  id: LifecycleArtifactId
  label: string
  status: LifecycleArtifactStatus
  version: number | null
  updatedAt: string | null
  paths: string[]
  conclusion: 'READY' | 'READY_WITH_WARNINGS' | 'NOT_READY' | null
  blockerCount: number
  warningCount: number
}

export interface RequirementAttention {
  kind: 'OPEN_ISSUES' | 'ARTIFACT_RECHECK' | 'REVIEW_NOT_READY' | 'REVIEW_STALE'
  label: string
  count: number
}

export interface RequirementLifecycle {
  stage: RequirementStage
  stageLabel: string
  status: 'IN_PROGRESS' | 'NEEDS_ATTENTION' | 'READY' | 'READY_WITH_WARNINGS'
  artifacts: LifecycleArtifactState[]
  attention: RequirementAttention[]
  nextAction: string | null
}

export interface WorkspaceArtifact {
  id: string
  title: string
  kind: string
  format: ArtifactFormat
  relativePath: string
  updatedAt: string
  modifiedAt: string
  size: number
}

export interface WorkspaceDecision {
  id: string
  title: string
  detail: string
  date: string
  status: string
}

export interface WorkspaceOpenIssue {
  id: string
  title: string
  detail: string
  owner: string
  status: string
}

export interface WorkspaceRequirement {
  id: string
  directoryName: string
  title: string
  status: string
  stage: RequirementStage
  stageLabel: string
  lifecycle: RequirementLifecycle
  updatedAt: string
  overview: string | null
  overviewPath: string | null
  initialRequest: string | null
  currentArtifact: string | null
  primarySystemId?: string | null
  decisions: WorkspaceDecision[]
  openIssues: WorkspaceOpenIssue[]
  artifacts: WorkspaceArtifact[]
  warnings: string[]
  error: string | null
}

export interface CreateRequirementInput {
  name: string
  initialRequest?: string
  primarySystemId?: string | null
}

export interface CreateRequirementResult {
  workspace: WorkspaceSnapshot
  requirement: WorkspaceRequirement
  thread: ThreadRecord
}

export interface RenameRequirementResult {
  workspace: WorkspaceSnapshot
  requirement: WorkspaceRequirement
}

export interface DeleteRequirementResult {
  workspace: WorkspaceSnapshot
  requirementId: string
}

export interface AddSourceInputsResult {
  workspace: WorkspaceSnapshot | null
  added: WorkspaceArtifact[]
  canceled?: boolean
}

export interface AddRequirementInfoResult {
  workspace: WorkspaceSnapshot
  added: WorkspaceArtifact
}

export interface WorkspaceSnapshot {
  id: string
  rootPath: string
  name: string
  requirementsDirectory: string
  requirements: WorkspaceRequirement[]
  scannedAt: string
}

export interface WorkspaceResult {
  workspace: WorkspaceSnapshot | null
  canceled?: boolean
  error?: string
}

export interface ArtifactContentResult {
  artifact: WorkspaceArtifact | null
  content: string | null
  error?: string
}

export interface EspowApi {
  platform: string
  workspace: {
    getRecent: () => Promise<WorkspaceResult>
    choose: () => Promise<WorkspaceResult>
    refresh: () => Promise<WorkspaceResult>
    createRequirement: (input: CreateRequirementInput) => Promise<CreateRequirementResult>
    renameRequirement: (requirementId: string, name: string) => Promise<RenameRequirementResult>
    deleteRequirement: (requirementId: string) => Promise<DeleteRequirementResult>
    updateRequirementSystem: (requirementId: string, primarySystemId: string | null) => Promise<WorkspaceSnapshot>
    addRequirementInfo: (requirementId: string, content: string) => Promise<AddRequirementInfoResult>
    addSourceInputs: (requirementId: string) => Promise<AddSourceInputsResult>
    readArtifact: (requirementId: string, artifactId: string) => Promise<ArtifactContentResult>
  }
  persistence: PersistenceApi
  model: ModelApi
  runtime: RuntimeApi
  tools: ToolApi
  tokenUsage: TokenUsageApi
  workContext: WorkContextApi
  diagnostic: DiagnosticApi
  prototypeStyle: PrototypeStyleApi
}
import type { PersistenceApi, ThreadRecord } from './persistence'
import type { ModelApi } from './model'
import type { RuntimeApi } from './runtime'
import type { ToolApi } from './tools'
import type { TokenUsageApi } from './tokenUsage'
import type { WorkContextApi } from './workContext'
import type { DiagnosticApi } from './diagnostic'
import type { PrototypeStyleApi } from './prototypeStyle'
