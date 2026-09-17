export type SkillMode = 'start' | 'analysis' | 'delta' | 'flow' | 'solution' | 'interaction' | 'prototype' | 'product-spec' | 'review'

export interface SkillSelection {
  id: string
  name: string
  version: string
  mode: SkillMode
}

export type ChangeResultStatus = 'Assessed' | 'ClarificationRequired' | 'DecisionConflict'

export interface ChangeArtifactAssessment {
  artifactId: string | null
  path: string | null
  type: string
  reason: string
}

export interface DecisionImpact {
  id: string
  title: string
  conflict: boolean
  reason: string
}

export interface CandidateChange {
  artifactId: string | null
  path: string
  summary: string
}

export interface ChangeResult {
  status: ChangeResultStatus
  changeSummary: string
  impactAssessment: string
  affectedArtifacts: ChangeArtifactAssessment[]
  unaffectedArtifacts: ChangeArtifactAssessment[]
  openQuestions: string[]
  decisionsAffected: DecisionImpact[]
  filesRead: string[]
  candidateChanges: CandidateChange[]
  finalChanges: string[]
  validationResult: string | null
}

export type AnalysisStatus = 'Analyzing' | 'ReadyForConfirmation' | 'Confirmed'
export type AnalysisEvidenceType = 'FACT' | 'ASSUMPTION'

export interface AnalysisActor {
  name: string
  role: string
}

export interface AnalysisScenario {
  id: string
  name: string
  actor: string
  trigger: string
  currentFlow: string[]
  blocker: string
  expectedOutcome: string
  status: string
}

export interface AnalysisStatement {
  description: string
  evidenceType: AnalysisEvidenceType
  source: string | null
}

export interface AnalysisReadiness {
  deterministicPassed: boolean
  semanticReady: boolean
  missing: string[]
}

export interface RequirementAnalysisResult {
  analysisStatus: AnalysisStatus
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
  readiness: AnalysisReadiness
  artifactPath: string
  artifactCandidate: string
  artifactBaseHash: string | null
  confirmedAt: string | null
}

export type BusinessFlowStatus = 'DRAFT' | 'WAITING_CLARIFICATION' | 'READY_FOR_CONFIRMATION' | 'CONFIRMED'
export type FlowNodeType = 'start' | 'action' | 'decision' | 'system' | 'wait' | 'end'
export type FlowEdgeType = 'main' | 'branch' | 'exception' | 'recovery'

export interface FlowActor {
  id: string
  name: string
  role: string
  source: string
}

export interface FlowNode {
  id: string
  type: FlowNodeType
  title: string
  description: string
  actorId: string | null
  stage: string
  stateChange: string | null
  sourceScenarioIds: string[]
  sourceDecisionIds: string[]
}

export interface FlowEdge {
  id: string
  from: string
  to: string
  label: string
  type: FlowEdgeType
}

export interface FlowExit {
  nodeId: string
  condition: string
  recordBehavior: string
  stateImpact: string
  retryable: string
}

export interface FlowSemanticChecks {
  mainScenarioCovered: boolean
  blockersHandled: boolean
  keyExitsCovered: boolean
  asyncRecoveryCovered: boolean
  closedLoop: boolean
}

export interface BusinessFlowModel {
  id: string
  name: string
  scope: { goal: string; included: string[]; excluded: string[] }
  status: BusinessFlowStatus
  actors: FlowActor[]
  nodes: FlowNode[]
  edges: FlowEdge[]
  entry: string
  exits: FlowExit[]
  openQuestions: string[]
  semanticChecks: FlowSemanticChecks
  sourceAnalysisPath: string
  sourceAnalysisStatus: 'confirmed' | 'draft'
  confirmedAt: string | null
}

export interface BusinessFlowReadiness {
  deterministicPassed: boolean
  semanticReady: boolean
  missing: string[]
  warnings: string[]
}

export interface FlowStructureDiff {
  addedNodes: string[]
  removedNodes: string[]
  changedNodes: string[]
  addedEdges: string[]
  removedEdges: string[]
  changedEdges: string[]
}

export interface BusinessFlowResult {
  flowStatus: BusinessFlowStatus
  prerequisite: 'ConfirmedRequirementAnalysis' | 'DraftRequirementAnalysis'
  flow: BusinessFlowModel
  readiness: BusinessFlowReadiness
  modelPath: string
  htmlPath: string
  modelCandidate: string
  htmlCandidate: string
  baseFingerprint: string
  diff: FlowStructureDiff
  confirmedAt: string | null
}

export type SolutionDesignStatus = 'DRAFT' | 'WAITING_CLARIFICATION' | 'READY_FOR_CONFIRMATION' | 'CONFIRMED'
export type CapabilityLayer = 'user-facing' | 'system' | 'supporting'
export type CapabilityExecution = 'manual' | 'automatic'

export interface SolutionCapability {
  id: string
  name: string
  layer: CapabilityLayer
  purpose: string
  actor: string
  trigger: string
  execution: CapabilityExecution
  input: string[]
  behavior: string[]
  output: string[]
  relatedFlowNodeIds: string[]
  sourceScenarioIds: string[]
  sourceDecisionIds: string[]
  rules: string[]
  exceptions: string[]
  surfaces: string[]
}

export interface SolutionRule {
  id: string
  description: string
  capabilityIds: string[]
  sourceFlowNodeIds: string[]
}

export interface SolutionState {
  id: string
  name: string
  meaning: string
  entryConditions: string[]
  exitConditions: string[]
}

export interface SolutionDataObject {
  id: string
  name: string
  purpose: string
  keyFields: string[]
  producedByCapabilityIds: string[]
  consumedByCapabilityIds: string[]
}

export interface SolutionRecovery {
  exception: string
  responsibleCapabilityId: string
  behavior: string
  outcome: string
}

export interface ProductSurface {
  id: string
  name: string
  type: string
  purpose: string
  capabilityIds: string[]
}

export interface SolutionDecisionCandidate {
  id: string
  question: string
  options: Array<{ name: string; description: string; tradeOff: string }>
  affectedCapabilityIds: string[]
}

export interface SolutionSemanticChecks {
  goalCovered: boolean
  scenariosCovered: boolean
  flowNodesCovered: boolean
  blockersResolved: boolean
  exceptionsHandled: boolean
  exitsCovered: boolean
  recoveryCovered: boolean
  noOverdesign: boolean
}

export interface SolutionDesignModel {
  id: string
  name: string
  overview: string
  scope: { included: string[]; excluded: string[] }
  status: SolutionDesignStatus
  capabilities: SolutionCapability[]
  rules: SolutionRule[]
  states: SolutionState[]
  dataObjects: SolutionDataObject[]
  recoveries: SolutionRecovery[]
  productSurfaces: ProductSurface[]
  decisions: SolutionDecisionCandidate[]
  openQuestions: string[]
  flowConflicts: string[]
  semanticChecks: SolutionSemanticChecks
  sourceAnalysisPath: string
  sourceAnalysisStatus: 'confirmed' | 'draft'
  sourceFlowPath: string
  sourceFlowStatus: 'confirmed' | 'draft'
  confirmedAt: string | null
}

export interface SolutionCheckResult {
  passed: boolean
  missing: string[]
  warnings: string[]
}

export interface SolutionDesignReadiness {
  deterministicPassed: boolean
  semanticReady: boolean
  coverage: SolutionCheckResult
  overdesign: SolutionCheckResult
  missing: string[]
  warnings: string[]
}

export interface SolutionDesignResult {
  solutionStatus: SolutionDesignStatus
  prerequisite: 'ConfirmedAnalysisAndFlow' | 'DraftExploration'
  solution: SolutionDesignModel
  readiness: SolutionDesignReadiness
  modelPath: string
  markdownPath: string
  modelCandidate: string
  markdownCandidate: string
  baseFingerprint: string
  confirmedAt: string | null
}

export type InteractionDesignStatus = 'DRAFT' | 'WAITING_CLARIFICATION' | 'READY_FOR_CONFIRMATION' | 'CONFIRMED'
export type InteractionStateKind = 'default' | 'loading' | 'success' | 'empty' | 'error' | 'disabled' | 'processing' | 'waiting' | 'completed'
export type InteractionActionPriority = 'primary' | 'secondary' | 'high-risk'
export type InteractionFeedbackType = 'inline' | 'toast' | 'badge' | 'notification' | 'popup' | 'state-change' | 'navigation'

export interface InteractionSurface {
  id: string
  name: string
  type: string
  purpose: string
  existing: boolean
  sourceCapabilityIds: string[]
}

export interface InteractionPage {
  id: string
  name: string
  surfaceId: string
  purpose: string
  sections: string[]
  entryPoints: string[]
  sourceCapabilityIds: string[]
  sourceFlowNodeIds: string[]
  sourceScenarioIds: string[]
}

export interface InteractionComponent {
  id: string
  name: string
  pageId: string
  section: string
  kind: string
  purpose: string
  informationPriority: 'primary' | 'secondary' | 'supporting'
  sourceCapabilityIds: string[]
  sourceFlowNodeIds: string[]
  sourceScenarioIds: string[]
}

export interface InteractionAction {
  id: string
  name: string
  componentId: string
  priority: InteractionActionPriority
  trigger: string
  preconditions: string[]
  result: string
  feedbackIds: string[]
  sourceCapabilityIds: string[]
  sourceFlowNodeIds: string[]
  sourceScenarioIds: string[]
}

export interface InteractionState {
  id: string
  name: string
  componentId: string
  kind: InteractionStateKind
  description: string
  visibleInformation: string[]
  availableActionIds: string[]
  reason: string | null
}

export interface InteractionTransition {
  id: string
  fromStateId: string
  toStateId: string
  trigger: string
  userActionId: string | null
  systemFeedback: string
  recovery: string | null
}

export interface InteractionFeedback {
  id: string
  trigger: string
  type: InteractionFeedbackType
  message: string
  behavior: string
}

export interface InteractionRule {
  id: string
  trigger: string
  condition: string
  uiBehavior: string
  userAction: string
  systemFeedback: string
  result: string
  relatedCapabilityIds: string[]
  relatedFlowNodeIds: string[]
}

export interface InteractionUserPath {
  id: string
  name: string
  steps: string[]
  sourceCapabilityIds: string[]
  sourceFlowNodeIds: string[]
  sourceScenarioIds: string[]
}

export interface InteractionDecisionCandidate {
  id: string
  question: string
  options: Array<{ name: string; benefit: string; cost: string; impact: string }>
  affectedElementIds: string[]
}

export interface InteractionSemanticChecks {
  mainScenariosCompletable: boolean
  noDeadEnds: boolean
  errorsHaveFeedback: boolean
  recoveryExists: boolean
  crossPageContextPreserved: boolean
  cognitiveLoadAcceptable: boolean
}

export interface InteractionDesignModel {
  id: string
  name: string
  overview: string
  status: InteractionDesignStatus
  surfaces: InteractionSurface[]
  pages: InteractionPage[]
  components: InteractionComponent[]
  actions: InteractionAction[]
  states: InteractionState[]
  transitions: InteractionTransition[]
  feedback: InteractionFeedback[]
  interactionRules: InteractionRule[]
  userPaths: InteractionUserPath[]
  decisions: InteractionDecisionCandidate[]
  openQuestions: string[]
  solutionConflicts: string[]
  flowConflicts: string[]
  uiReferencePaths: string[]
  semanticChecks: InteractionSemanticChecks
  sourceAnalysisPath: string
  sourceAnalysisStatus: 'confirmed' | 'draft'
  sourceFlowPath: string
  sourceFlowStatus: 'confirmed' | 'draft'
  sourceSolutionPath: string
  sourceSolutionStatus: 'confirmed' | 'draft'
  confirmedAt: string | null
}

export interface InteractionDesignReadiness {
  deterministicPassed: boolean
  semanticReady: boolean
  missing: string[]
  warnings: string[]
}

export interface InteractionDesignResult {
  interactionStatus: InteractionDesignStatus
  prerequisite: 'ConfirmedAnalysisFlowAndSolution' | 'DraftExploration'
  interaction: InteractionDesignModel
  readiness: InteractionDesignReadiness
  modelPath: string
  markdownPath: string
  modelCandidate: string
  markdownCandidate: string
  baseFingerprint: string
  confirmedAt: string | null
}

export type PrototypeStatus = 'DRAFT' | 'WAITING_CLARIFICATION' | 'READY_FOR_CONFIRMATION' | 'CONFIRMED'

export interface PrototypeSemanticChecks {
  interactionImplemented: boolean
  mainUserPathComplete: boolean
  importantStatesVisible: boolean
  actionsHaveFeedback: boolean
  cognitiveLoadAcceptable: boolean
  noUnconfirmedFeatures: boolean
}

export interface PrototypeMetadata {
  id: string
  name: string
  version: number
  productSurface: string
  mode: 'create' | 'delta'
  status: PrototypeStatus
  sourceInteractionPath: string
  sourceInteractionStatus: 'confirmed' | 'draft'
  sourceSolutionPath: string | null
  sourceCapabilityIds: string[]
  sourceFlowIds: string[]
  existingPrototypePath: string | null
  uiReferencePaths: string[]
  requiredDomIds: string[]
  interactiveDomIds: string[]
  addedComponents: string[]
  changedComponents: string[]
  removedComponents: string[]
  interactionChanges: string[]
  stateChanges: string[]
  openQuestions: string[]
  interactionConflicts: string[]
  semanticChecks: PrototypeSemanticChecks
  confirmedAt: string | null
}

export interface PrototypeReadiness {
  deterministicPassed: boolean
  semanticReady: boolean
  missing: string[]
  warnings: string[]
}

export interface PrototypeResult {
  prototypeStatus: PrototypeStatus
  prerequisite: 'ConfirmedInteraction' | 'DraftExploration'
  prototype: PrototypeMetadata
  readiness: PrototypeReadiness
  htmlPath: string
  htmlCandidate: string
  baseFingerprint: string
  diff: string
  confirmedAt: string | null
}

export type ProductSpecStatus = 'DRAFT' | 'WAITING_CLARIFICATION' | 'READY_FOR_CONFIRMATION' | 'CONFIRMED'

export interface ProductSpecCapability {
  id: string
  name: string
  purpose: string
  trigger: string
  preconditions: string[]
  userActions: string[]
  systemBehavior: string[]
  businessRuleIds: string[]
  stateChanges: string[]
  successResult: string
  failureResult: string
  exceptionHandling: string[]
  relatedPageIds: string[]
  sourceCapabilityIds: string[]
  sourceFlowNodeIds: string[]
  sourceScenarioIds: string[]
  sourceDecisionIds: string[]
}

export interface ProductSpecRule {
  id: string
  description: string
  trigger: string
  condition: string
  behavior: string
  result: string
  relatedCapabilityIds: string[]
  sourceRefs: string[]
}

export interface ProductSpecState {
  id: string
  name: string
  meaning: string
  entryConditions: string[]
  exitConditions: string[]
  subsequentBehavior: string[]
  sourceRefs: string[]
}

export interface ProductSpecField {
  id: string
  name: string
  meaning: string
  source: string
  required: boolean
  usedAt: string[]
  format: string | null
  defaultValue: string | null
  allowedValues: string[]
  updateTiming: string
  emptyBehavior: string
  sourceRefs: string[]
}

export interface ProductSpecFailure {
  id: string
  condition: string
  systemBehavior: string
  userFeedback: string
  retry: string | null
  statusResult: string
  downstreamImpact: string
  sourceRefs: string[]
}

export interface ProductSpecRecovery {
  id: string
  trigger: string
  mechanism: string
  actor: string
  limit: string | null
  interval: string | null
  exhaustedBehavior: string
  result: string
  sourceRefs: string[]
}

export interface ProductSpecPageBehavior {
  id: string
  page: string
  change: string
  visibility: string
  operation: string
  result: string
  dataFieldIds: string[]
  sourceInteractionIds: string[]
  sourcePrototypePath: string | null
}

export interface ProductSpecAcceptanceCriterion {
  id: string
  capabilityId: string
  given: string[]
  when: string
  then: string[]
  sourceRefs: string[]
}

export interface ProductSpecIssue {
  id: string
  description: string
  impact: string
  requiredDecision: string
  blocking: boolean
}

export interface ProductSpecConflict {
  id: string
  type: 'Upstream Conflict' | 'Consistency Issue'
  sources: string[]
  description: string
  affectedSections: string[]
  requiredDecision: string
}

export interface ProductSpecSemanticChecks {
  noRedesign: boolean
  capabilitiesImplementable: boolean
  mainFlowSpecified: boolean
  failuresHaveResults: boolean
  fieldSourcesComplete: boolean
  statesHaveTransitions: boolean
  upstreamConsistent: boolean
  prototypeConsistent: boolean
  acceptanceTestable: boolean
}

export interface ProductSpecModel {
  id: string
  name: string
  status: ProductSpecStatus
  mode: 'create' | 'delta'
  documentInfo: { requirementName: string; requirementDate: string; documentDate: string; source: string; productManager: string }
  background: string[]
  goals: string[]
  value: string[]
  scope: { applicable: string[]; included: string[]; excluded: string[] }
  rolesAndScenarios: string[]
  businessFlowSummary: string[]
  solutionSummary: string[]
  capabilities: ProductSpecCapability[]
  rules: ProductSpecRule[]
  states: ProductSpecState[]
  fields: ProductSpecField[]
  failures: ProductSpecFailure[]
  recoveries: ProductSpecRecovery[]
  permissions: string[]
  externalDependencies: string[]
  pageBehaviors: ProductSpecPageBehavior[]
  openIssues: ProductSpecIssue[]
  conflicts: ProductSpecConflict[]
  acceptanceCriteria: ProductSpecAcceptanceCriterion[]
  semanticChecks: ProductSpecSemanticChecks
  sourceAnalysisPath: string
  sourceAnalysisStatus: 'confirmed' | 'draft'
  sourceFlowPath: string
  sourceFlowStatus: 'confirmed' | 'draft'
  sourceSolutionPath: string
  sourceSolutionStatus: 'confirmed' | 'draft'
  interactionRequired: boolean
  sourceInteractionPath: string | null
  sourceInteractionStatus: 'confirmed' | 'draft' | 'not-applicable'
  sourcePrototypePath: string | null
  existingPrdPath: string | null
  changedSections: string[]
  confirmedAt: string | null
}

export interface ProductSpecReadiness {
  deterministicPassed: boolean
  semanticReady: boolean
  prdReady: boolean
  missing: string[]
  warnings: string[]
}

export interface ProductSpecResult {
  productSpecStatus: ProductSpecStatus
  prerequisite: 'ConfirmedUpstream' | 'DraftExploration'
  productSpec: ProductSpecModel
  readiness: ProductSpecReadiness
  modelPath: string
  markdownPath: string
  modelCandidate: string
  markdownCandidate: string
  baseFingerprint: string
  artifactVersion: number
  confirmedAt: string | null
}

export type ReviewConclusion = 'READY' | 'READY_WITH_WARNINGS' | 'NOT_READY'
export type ReviewRunStatus = 'DRAFT_REVIEW' | 'READY_FOR_CONFIRMATION' | 'CONFIRMED' | 'STALE'
export type ReviewSeverity = 'BLOCKER' | 'WARNING' | 'INFO'
export type ReviewCategory = 'Scope' | 'Flow' | 'Solution' | 'Interaction' | 'Prototype' | 'Rule' | 'State' | 'Field' | 'Data' | 'Exception' | 'Recovery' | 'Dependency' | 'Consistency' | 'Acceptance'
export type ReviewIssueStatus = 'OPEN' | 'RESOLVED' | 'ACCEPTED'

export interface ReviewEvidence {
  artifactPath: string
  reference: string
  excerpt: string
}

export interface ReviewIssue {
  id: string
  severity: ReviewSeverity
  category: ReviewCategory
  title: string
  description: string
  evidence: ReviewEvidence[]
  impact: string
  sourceArtifacts: string[]
  recommendedStage: 'Requirement Analysis' | 'Business Flow' | 'Solution Design' | 'Interaction Design' | 'Prototype' | 'Product Spec'
  status: ReviewIssueStatus
}

export interface ReviewCoverage {
  dimension: string
  status: 'PASS' | 'ISSUE' | 'NOT_APPLICABLE'
  notes: string
}

export interface ReviewDependency {
  path: string
  hash: string
  version: number | null
}

export interface RequirementReviewModel {
  id: string
  name: string
  reviewStatus: ReviewRunStatus
  conclusion: ReviewConclusion
  summary: string
  issues: ReviewIssue[]
  coverage: ReviewCoverage[]
  consistency: string[]
  openIssues: string[]
  recommendedActions: string[]
  dependencies: ReviewDependency[]
  draftReview: boolean
  createdAt: string
  confirmedAt: string | null
}

export interface RequirementReviewReadiness {
  deterministicPassed: boolean
  resultConsistent: boolean
  missing: string[]
  warnings: string[]
}

export interface RequirementReviewResult {
  reviewStatus: ReviewRunStatus
  conclusion: ReviewConclusion
  prerequisite: 'ConfirmedProductSpec' | 'DraftReview'
  review: RequirementReviewModel
  readiness: RequirementReviewReadiness
  blockerCount: number
  warningCount: number
  infoCount: number
  artifactsReviewed: string[]
  modelPath: string
  markdownPath: string
  modelCandidate: string
  markdownCandidate: string
  baseFingerprint: string
  reviewVersion: number
  createdAt: string
  confirmedAt: string | null
}
