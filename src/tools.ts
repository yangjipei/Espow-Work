import type { RunRecord } from './persistence'
import type { BusinessFlowResult, ChangeResult, InteractionDesignResult, ProductSpecResult, PrototypeResult, RequirementAnalysisResult, RequirementReviewResult, SolutionDesignResult } from './skills'

export type ToolPermission = 'read' | 'write'
export type ToolRiskLevel = 'low' | 'high'
export type ToolCallStatus = 'Running' | 'Completed' | 'Failed' | 'WaitingConfirmation' | 'Cancelled'

export interface EspowToolContract {
  id: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  permission: ToolPermission
  riskLevel: ToolRiskLevel
  requiresApproval: boolean
  errors: string[]
}

export interface ToolCallRecord {
  id: string
  name: string
  status: ToolCallStatus
  startedAt: string
  completedAt: string | null
  error: string | null
}

export interface ArtifactDiffResult {
  artifactId: string
  path: string
  before: string
  after: string
  diff: string
  changedSections: string[]
  hasChanges: boolean
  approvalId: string | null
}

export interface WriteApprovalRequest {
  id: string
  runId: string
  requirementId: string
  sourceArtifactId: string
  sourcePath: string
  candidate: string
  writeMode: 'new-version' | 'overwrite'
  diff: ArtifactDiffResult
  status: 'Pending' | 'Approved' | 'Denied'
  createdAt: string
  resolvedAt: string | null
}

export interface ApprovalResolution {
  run: RunRecord
  approval: WriteApprovalRequest
}

export interface ChangeResultSubmission {
  changeResult: ChangeResult
}

export interface RequirementAnalysisSubmission {
  analysisResult: RequirementAnalysisResult
}

export interface BusinessFlowSubmission {
  flowResult: BusinessFlowResult
}

export interface SolutionDesignSubmission {
  solutionResult: SolutionDesignResult
}

export interface InteractionDesignSubmission {
  interactionResult: InteractionDesignResult
}

export interface PrototypeSubmission {
  prototypeResult: PrototypeResult
}

export interface ProductSpecSubmission {
  productSpecResult: ProductSpecResult
}

export interface RequirementReviewSubmission {
  requirementReviewResult: RequirementReviewResult
}

export const toolIpc = {
  resolveApproval: 'tool:resolve-approval'
} as const

export interface ToolApi {
  resolveApproval: (runId: string, approved: boolean) => Promise<ApprovalResolution>
}

const identity = {
  requirementId: {
    type: 'string',
    required: true,
    description: 'The current Requirement identity supplied in ESPow context.'
  }
} as const

const analysisStatementSchema = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    evidenceType: { type: 'string', enum: ['FACT', 'ASSUMPTION'] },
    source: { type: ['string', 'null'] }
  },
  required: ['description', 'evidenceType', 'source'],
  additionalProperties: false
}

const requirementAnalysisSchema = {
  type: 'object',
  properties: {
    analysisStatus: { type: 'string', enum: ['Analyzing', 'ReadyForConfirmation'] },
    problemDefinition: { type: 'string' },
    goal: { type: 'string' },
    actors: {
      type: 'array', items: {
        type: 'object', properties: { name: { type: 'string' }, role: { type: 'string' } },
        required: ['name', 'role'], additionalProperties: false
      }
    },
    scenarios: {
      type: 'array', items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, name: { type: 'string' }, actor: { type: 'string' },
          trigger: { type: 'string' }, currentFlow: { type: 'array', items: { type: 'string' } },
          blocker: { type: 'string' }, expectedOutcome: { type: 'string' }, status: { type: 'string' }
        },
        required: ['id', 'name', 'actor', 'trigger', 'currentFlow', 'blocker', 'expectedOutcome', 'status'],
        additionalProperties: false
      }
    },
    currentFlow: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: analysisStatementSchema },
    rootCauses: { type: 'array', items: analysisStatementSchema },
    boundaries: { type: 'array', items: { type: 'string' } },
    facts: { type: 'array', items: { type: 'string' } },
    assumptions: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
    outOfScope: { type: 'array', items: { type: 'string' } },
    semanticReady: {
      type: 'boolean',
      description: 'The model semantic-completeness judgment. Use the JSON boolean true or false, never a string.'
    }
  },
  required: [
    'analysisStatus', 'problemDefinition', 'goal', 'actors', 'scenarios', 'currentFlow', 'blockers',
    'rootCauses', 'boundaries', 'facts', 'assumptions', 'decisions', 'openQuestions', 'outOfScope', 'semanticReady'
  ],
  additionalProperties: false,
  fieldRequired: true
}

const analysisPatchSchema = {
  type: 'object',
  properties: {
    op: { type: 'string', enum: ['add', 'replace', 'remove'] },
    path: { type: 'string', description: 'Mainline Delta path. Core roots: /problem, /scenarios, /goals, /flow, /rules, /scope, /impact, /decisions. A confirmed dynamic field uses /modules/<module-name>.' },
    value: {},
    status: { type: 'string', enum: ['unknown', 'inferred', 'open', 'discussing', 'confirmed', 'conflicted', 'not_applicable'] },
    source: { type: 'string', enum: ['user', 'agent', 'source', 'runtime'] }
  },
  required: ['op', 'path'],
  additionalProperties: false
}

const analysisQuestionDraftSchema = {
  type: 'object',
  properties: {
    topic: { type: 'string' },
    question: { type: 'string' },
    priority: { type: 'string', enum: ['blocking', 'non_blocking'] },
    reason: { type: 'string' },
    impact: { type: 'array', items: { type: 'string' } },
    targetStage: { type: 'string', enum: ['requirement-analysis', 'business-flow', 'solution-design', 'interaction-design', 'prototype', 'product-spec', 'requirement-review'] }
  },
  required: ['topic', 'question', 'priority', 'reason'],
  additionalProperties: false
}

const analysisSchemaDeltaSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['missing', 'proposed', 'confirmed'] },
    requirementTypes: { type: 'array', items: { type: 'string', enum: ['workflow', 'integration', 'page_interaction', 'decision_rule', 'data_mapping', 'account_permission'] } },
    modules: { type: 'array', items: { type: 'string' } },
    addModules: { type: 'array', items: { type: 'string' } }
  },
  additionalProperties: false
}

const analysisWorkingDeltaSchema = {
  type: 'object',
  properties: {
    currentTopic: { type: ['string', 'null'] },
    currentQuestion: {
      type: ['object', 'null'], properties: {
        id: { type: 'string' }, question: { type: 'string' },
        options: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } }, required: ['id', 'label'], additionalProperties: false } }
      }, required: ['id', 'question', 'options'], additionalProperties: false
    },
    clearCurrentQuestion: { type: 'boolean' }
  },
  additionalProperties: false
}

const changeArtifactSchema = {
  type: 'object',
  properties: {
    artifactId: { type: ['string', 'null'] },
    path: { type: ['string', 'null'] },
    type: { type: 'string' },
    reason: { type: 'string' }
  },
  required: ['artifactId', 'path', 'type', 'reason'],
  additionalProperties: false
}

const changeResultSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['Assessed', 'ClarificationRequired', 'DecisionConflict'] },
    changeSummary: { type: 'string' },
    impactAssessment: { type: 'string' },
    affectedArtifacts: { type: 'array', items: changeArtifactSchema },
    unaffectedArtifacts: { type: 'array', items: changeArtifactSchema },
    openQuestions: { type: 'array', items: { type: 'string' } },
    decisionsAffected: {
      type: 'array', items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, title: { type: 'string' }, conflict: { type: 'boolean' }, reason: { type: 'string' }
        },
        required: ['id', 'title', 'conflict', 'reason'],
        additionalProperties: false
      }
    },
    filesRead: { type: 'array', items: { type: 'string' } },
    candidateChanges: {
      type: 'array', items: {
        type: 'object',
        properties: {
          artifactId: { type: ['string', 'null'] }, path: { type: 'string' }, summary: { type: 'string' }
        },
        required: ['artifactId', 'path', 'summary'],
        additionalProperties: false
      }
    },
    finalChanges: { type: 'array', items: { type: 'string' } },
    validationResult: { type: ['string', 'null'] }
  },
  required: [
    'status', 'changeSummary', 'impactAssessment', 'affectedArtifacts', 'unaffectedArtifacts',
    'openQuestions', 'decisionsAffected', 'filesRead', 'candidateChanges', 'finalChanges', 'validationResult'
  ],
  additionalProperties: false,
  fieldRequired: true
}

export const espowToolContracts: EspowToolContract[] = [
  {
    id: 'workspace_read', name: 'workspace_read', permission: 'read', riskLevel: 'low', requiresApproval: false,
    description: 'Read a compact summary of the current ESPow Requirement Workspace, including Artifact metadata, decisions, and open issues. Never returns all file contents or chat history.',
    inputSchema: identity,
    outputSchema: { type: 'json' },
    errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE', 'REQUIREMENT_NOT_FOUND']
  },
  {
    id: 'artifact_find', name: 'artifact_find', permission: 'read', riskLevel: 'low', requiresApproval: false,
    description: 'Find candidate Artifacts in the current Requirement by type, title, workspace-relative path, or query. Returns every plausible candidate; do not assume the first is uniquely correct.',
    inputSchema: {
      ...identity,
      type: { type: 'string', description: 'Artifact type such as PRD, Prototype, Business Flow, Markdown, Text, or HTML.' },
      name: { type: 'string', description: 'Artifact title or filename clue.' },
      path: { type: 'string', description: 'Workspace-relative path clue. Absolute and traversal paths are rejected.' },
      query: { type: 'string', description: 'Additional semantic clue.' }
    },
    outputSchema: { type: 'json' },
    errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE']
  },
  {
    id: 'artifact_read', name: 'artifact_read', permission: 'read', riskLevel: 'low', requiresApproval: false,
    description: 'Read one already located Markdown, text, HTML, or JSON Artifact by Artifact id or approved Requirement-relative path. Use artifact_find first when the target is ambiguous.',
    inputSchema: {
      ...identity,
      artifactId: { type: 'string', description: 'Artifact id returned by workspace_read or artifact_find.' },
      path: { type: 'string', description: 'Requirement-relative Artifact path. Absolute and traversal paths are rejected.' },
      section: { type: 'string', description: 'Optional Markdown heading clue. When present, return only the matching section.' }
    },
    outputSchema: { type: 'json' },
    errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE', 'ARTIFACT_NOT_FOUND', 'UNSUPPORTED_FORMAT', 'FILE_TOO_LARGE', 'SECTION_NOT_FOUND']
  },
  {
    id: 'change_result_submit', name: 'change_result_submit', permission: 'read', riskLevel: 'low', requiresApproval: false,
    description: 'Submit the structured Requirement Change assessment for the current Run. This records semantic judgment only and never changes Workspace files.',
    inputSchema: {
      ...identity,
      resultJson: changeResultSchema
    },
    outputSchema: { type: 'json' },
    errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE']
  },
  {
    id: 'analysis_turn_submit', name: 'analysis_turn_submit', permission: 'read', riskLevel: 'low', requiresApproval: false,
    description: 'Terminal tool for one Requirement Analysis conversation turn. Submit only the incremental Analysis State patch plus the final user-facing reply. Runtime deterministically merges state, resolves questions, detects structural conflicts, computes readiness, builds the next projection, and ends the turn without another model call.',
    inputSchema: {
      ...identity,
      assistantReply: { type: 'string', required: true, description: 'Final Simplified Chinese reply shown to the user for this turn. Do not include hidden reasoning or state JSON.' },
      patches: { type: 'array', required: true, items: analysisPatchSchema, description: 'Only facts or structures added/changed in this turn. Never resend the complete Analysis State.' },
      resolvedQuestionIds: { type: 'array', required: true, items: { type: 'string' } },
      newQuestions: { type: 'array', required: true, items: analysisQuestionDraftSchema, description: 'At most 5 high-value questions; use blocking only when the answer changes product conclusions.' },
      schemaDelta: { ...analysisSchemaDeltaSchema, description: 'Required while Mainline Schema is missing/proposed; confirmed schemas may only be extended through addModules after explicit user approval.' },
      workingDelta: { ...analysisWorkingDeltaSchema, description: 'Short-lived current topic/question. Clear it as soon as the referenced question is resolved.' }
    },
    outputSchema: { type: 'json' },
    errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE', 'ANALYSIS_STATE_UNAVAILABLE']
  },
  {
    id: 'requirement_analysis_ready', name: 'requirement_analysis_ready', permission: 'read', riskLevel: 'low', requiresApproval: false,
    description: 'Deterministically check whether a structured Requirement Analysis has the minimum content required before asking the product manager for confirmation. Semantic readiness remains the model’s explicit judgment.',
    inputSchema: {
      ...identity,
      resultJson: requirementAnalysisSchema
    },
    outputSchema: { type: 'json' },
    errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE']
  },
  {
    id: 'requirement_analysis_submit', name: 'requirement_analysis_submit', permission: 'read', riskLevel: 'low', requiresApproval: false,
    description: 'Submit the structured Requirement Analysis candidate for the current Run. It records analysis only and never writes the formal Workspace Artifact.',
    inputSchema: {
      ...identity,
      resultJson: requirementAnalysisSchema
    },
    outputSchema: { type: 'json' },
    errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE', 'ANALYSIS_NOT_READY']
  },
  {
    id: 'requirement_analysis_write', name: 'requirement_analysis_write', permission: 'write', riskLevel: 'high', requiresApproval: true,
    description: 'Write the exact Requirement Analysis candidate only after the product manager explicitly confirms the linked ReadyForConfirmation result.',
    inputSchema: {
      ...identity,
      analysisRunId: { type: 'string', required: true },
      path: { type: 'string', required: true },
      candidate: { type: 'string', required: true }
    },
    outputSchema: { type: 'json' },
    errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE', 'APPROVAL_REQUIRED', 'SOURCE_CHANGED', 'WRITE_FAILED']
  },
  {
    id: 'business_flow_next_version', name: 'business_flow_next_version', permission: 'read', riskLevel: 'low', requiresApproval: false,
    description: 'Deterministically calculate the next paired Business Flow model and HTML version from the current Requirement files.',
    inputSchema: identity,
    outputSchema: { type: 'json' },
    errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE']
  },
  {
    id: 'business_flow_ready', name: 'business_flow_ready', permission: 'read', riskLevel: 'low', requiresApproval: false,
    description: 'Validate Business Flow graph structure and explicit semantic closure before it can be shown for product-manager confirmation.',
    inputSchema: {
      ...identity,
      resultJson: { type: 'string', required: true, description: 'Complete structured Business Flow JSON candidate.' }
    },
    outputSchema: { type: 'json' },
    errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE', 'PREREQUISITE_NOT_READY']
  },
  {
    id: 'business_flow_submit', name: 'business_flow_submit', permission: 'read', riskLevel: 'low', requiresApproval: false,
    description: 'Record a structured Business Flow candidate and deterministically render its HTML preview. This never writes Workspace files.',
    inputSchema: {
      ...identity,
      expectedVersion: { type: 'number', required: true, description: 'Version returned by business_flow_next_version.' },
      resultJson: { type: 'string', required: true, description: 'Complete structured Business Flow JSON candidate.' }
    },
    outputSchema: { type: 'json' },
    errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE', 'PREREQUISITE_NOT_READY', 'FLOW_NOT_READY', 'VERSION_CONFLICT']
  },
  {
    id: 'business_flow_write', name: 'business_flow_write', permission: 'write', riskLevel: 'high', requiresApproval: true,
    description: 'Atomically write the confirmed Flow Model and paired HTML version only after explicit product-manager confirmation.',
    inputSchema: {
      ...identity,
      flowRunId: { type: 'string', required: true }
    },
    outputSchema: { type: 'json' },
    errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE', 'APPROVAL_REQUIRED', 'FLOW_NOT_READY', 'SOURCE_CHANGED', 'TARGET_EXISTS', 'WRITE_FAILED']
  },
  {
    id: 'solution_design_next_version', name: 'solution_design_next_version', permission: 'read', riskLevel: 'low', requiresApproval: false,
    description: 'Deterministically calculate the next paired Solution Design model and Markdown version from current Requirement files.',
    inputSchema: identity, outputSchema: { type: 'json' }, errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE']
  },
  {
    id: 'solution_coverage_check', name: 'solution_coverage_check', permission: 'read', riskLevel: 'low', requiresApproval: false,
    description: 'Check Capability traceability and coverage of the confirmed goal, scenarios, flow nodes, blockers, exits, exceptions, and recovery.',
    inputSchema: { ...identity, resultJson: { type: 'string', required: true, description: 'Complete structured Solution Design JSON candidate.' } },
    outputSchema: { type: 'json' }, errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE']
  },
  {
    id: 'solution_overdesign_check', name: 'solution_overdesign_check', permission: 'read', riskLevel: 'low', requiresApproval: false,
    description: 'Check the Solution candidate for ungrounded platform scope, premature technical design, and unrelated capabilities.',
    inputSchema: { ...identity, resultJson: { type: 'string', required: true, description: 'Complete structured Solution Design JSON candidate.' } },
    outputSchema: { type: 'json' }, errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE']
  },
  {
    id: 'solution_design_submit', name: 'solution_design_submit', permission: 'read', riskLevel: 'low', requiresApproval: false,
    description: 'Record a structured Solution Design candidate and deterministically render its Markdown preview without writing Workspace files.',
    inputSchema: {
      ...identity,
      expectedVersion: { type: 'number', required: true, description: 'Version returned by solution_design_next_version.' },
      resultJson: { type: 'string', required: true, description: 'Complete structured Solution Design JSON candidate.' }
    },
    outputSchema: { type: 'json' },
    errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE', 'PREREQUISITE_NOT_READY', 'SOLUTION_NOT_READY', 'SOURCE_CHANGED', 'VERSION_CONFLICT']
  },
  {
    id: 'solution_design_write', name: 'solution_design_write', permission: 'write', riskLevel: 'high', requiresApproval: true,
    description: 'Atomically write the confirmed Solution Model and paired Markdown version only after explicit product-manager confirmation.',
    inputSchema: { ...identity, solutionRunId: { type: 'string', required: true } },
    outputSchema: { type: 'json' },
    errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE', 'APPROVAL_REQUIRED', 'SOLUTION_NOT_READY', 'SOURCE_CHANGED', 'TARGET_EXISTS', 'WRITE_FAILED']
  },
  {
    id: 'interaction_design_next_version', name: 'interaction_design_next_version', permission: 'read', riskLevel: 'low', requiresApproval: false,
    description: 'Deterministically calculate the next paired Interaction Design model and Markdown version from current Requirement files.',
    inputSchema: identity, outputSchema: { type: 'json' }, errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE']
  },
  {
    id: 'interaction_design_ready', name: 'interaction_design_ready', permission: 'read', riskLevel: 'low', requiresApproval: false,
    description: 'Validate that capabilities have surfaces, actions have entries and results, states and references are complete, and semantic interaction checks pass.',
    inputSchema: { ...identity, resultJson: { type: 'string', required: true, description: 'Complete structured Interaction Design JSON candidate.' } },
    outputSchema: { type: 'json' }, errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE', 'PREREQUISITE_NOT_READY', 'SOURCE_CHANGED']
  },
  {
    id: 'interaction_design_submit', name: 'interaction_design_submit', permission: 'read', riskLevel: 'low', requiresApproval: false,
    description: 'Record a structured Interaction Design candidate and deterministically render its Markdown preview without writing Workspace files.',
    inputSchema: {
      ...identity,
      expectedVersion: { type: 'number', required: true, description: 'Version returned by interaction_design_next_version.' },
      resultJson: { type: 'string', required: true, description: 'Complete structured Interaction Design JSON candidate.' }
    },
    outputSchema: { type: 'json' },
    errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE', 'PREREQUISITE_NOT_READY', 'INTERACTION_NOT_READY', 'SOURCE_CHANGED', 'VERSION_CONFLICT']
  },
  {
    id: 'interaction_design_write', name: 'interaction_design_write', permission: 'write', riskLevel: 'high', requiresApproval: true,
    description: 'Atomically write the confirmed Interaction Model and paired Markdown version only after explicit product-manager confirmation.',
    inputSchema: { ...identity, interactionRunId: { type: 'string', required: true } },
    outputSchema: { type: 'json' },
    errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE', 'APPROVAL_REQUIRED', 'INTERACTION_NOT_READY', 'SOURCE_CHANGED', 'TARGET_EXISTS', 'WRITE_FAILED']
  },
  {
    id: 'prototype_ready', name: 'prototype_ready', permission: 'read', riskLevel: 'low', requiresApproval: false,
    description: 'Validate a self-contained HTML Prototype candidate, its required DOM, interaction bindings, source traceability, script syntax, and target version before confirmation.',
    inputSchema: {
      ...identity,
      targetPath: { type: 'string', required: true, description: 'Versioned target path returned by artifact_next_version.' },
      metadataJson: { type: 'string', required: true, description: 'Complete Prototype Metadata JSON candidate.' },
      html: { type: 'string', required: true, description: 'Complete self-contained HTML candidate.' }
    },
    outputSchema: { type: 'json' },
    errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE', 'PREREQUISITE_NOT_READY', 'SOURCE_CHANGED', 'PROTOTYPE_NOT_READY']
  },
  {
    id: 'prototype_submit', name: 'prototype_submit', permission: 'read', riskLevel: 'low', requiresApproval: false,
    description: 'Record the validated Prototype HTML candidate, deterministic diff, version, references, and validation without writing Workspace files.',
    inputSchema: {
      ...identity,
      targetPath: { type: 'string', required: true, description: 'Versioned target path returned by artifact_next_version.' },
      metadataJson: { type: 'string', required: true },
      html: { type: 'string', required: true }
    },
    outputSchema: { type: 'json' },
    errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE', 'PREREQUISITE_NOT_READY', 'SOURCE_CHANGED', 'PROTOTYPE_NOT_READY', 'VERSION_CONFLICT']
  },
  {
    id: 'prototype_write', name: 'prototype_write', permission: 'write', riskLevel: 'high', requiresApproval: true,
    description: 'Atomically create the confirmed versioned HTML Prototype only after explicit product-manager confirmation.',
    inputSchema: { ...identity, prototypeRunId: { type: 'string', required: true } },
    outputSchema: { type: 'json' },
    errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE', 'APPROVAL_REQUIRED', 'PROTOTYPE_NOT_READY', 'SOURCE_CHANGED', 'TARGET_EXISTS', 'WRITE_FAILED']
  },
  {
    id: 'product_spec_next_version', name: 'product_spec_next_version', permission: 'read', riskLevel: 'low', requiresApproval: false,
    description: 'Deterministically calculate the next paired Product Spec model and versioned PRD Markdown path from current Requirement files.',
    inputSchema: identity, outputSchema: { type: 'json' }, errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE']
  },
  {
    id: 'product_spec_ready', name: 'product_spec_ready', permission: 'read', riskLevel: 'low', requiresApproval: false,
    description: 'Validate Product Spec prerequisites, capability/rule/state/field/error completeness, traceability, conflicts, open issues, prototype consistency, and acceptance criteria.',
    inputSchema: { ...identity, resultJson: { type: 'string', required: true, description: 'Complete structured Product Spec JSON candidate.' } },
    outputSchema: { type: 'json' }, errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE', 'PREREQUISITE_NOT_READY', 'SOURCE_CHANGED']
  },
  {
    id: 'product_spec_submit', name: 'product_spec_submit', permission: 'read', riskLevel: 'low', requiresApproval: false,
    description: 'Record a structured Product Spec candidate and deterministically render the PRD Markdown preview without writing Workspace files.',
    inputSchema: { ...identity, expectedVersion: { type: 'number', required: true }, resultJson: { type: 'string', required: true } },
    outputSchema: { type: 'json' }, errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE', 'PREREQUISITE_NOT_READY', 'PRODUCT_SPEC_NOT_READY', 'SOURCE_CHANGED', 'VERSION_CONFLICT']
  },
  {
    id: 'product_spec_write', name: 'product_spec_write', permission: 'write', riskLevel: 'high', requiresApproval: true,
    description: 'Atomically write the confirmed Product Spec model and versioned PRD Markdown only after explicit product-manager confirmation.',
    inputSchema: { ...identity, productSpecRunId: { type: 'string', required: true } },
    outputSchema: { type: 'json' }, errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE', 'APPROVAL_REQUIRED', 'PRODUCT_SPEC_NOT_READY', 'SOURCE_CHANGED', 'TARGET_EXISTS', 'WRITE_FAILED']
  },
  {
    id: 'requirement_review_next_version', name: 'requirement_review_next_version', permission: 'read', riskLevel: 'low', requiresApproval: false,
    description: 'Resolve the next Requirement Review version and fingerprint the current effective review dependencies.',
    inputSchema: identity, outputSchema: { type: 'json' }, errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE', 'PREREQUISITE_NOT_READY']
  },
  {
    id: 'requirement_review_ready', name: 'requirement_review_ready', permission: 'read', riskLevel: 'low', requiresApproval: false,
    description: 'Validate ReviewIssue evidence, severity/result consistency, dependency coverage, and the confirmed Product Spec prerequisite.',
    inputSchema: { ...identity, resultJson: { type: 'string', required: true } }, outputSchema: { type: 'json' },
    errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE', 'PREREQUISITE_NOT_READY', 'SOURCE_CHANGED']
  },
  {
    id: 'requirement_review_submit', name: 'requirement_review_submit', permission: 'read', riskLevel: 'low', requiresApproval: false,
    description: 'Record the structured Requirement Review and render its Markdown candidate without modifying reviewed Artifacts.',
    inputSchema: { ...identity, expectedVersion: { type: 'number', required: true }, resultJson: { type: 'string', required: true } }, outputSchema: { type: 'json' },
    errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE', 'PREREQUISITE_NOT_READY', 'REVIEW_NOT_READY', 'SOURCE_CHANGED', 'VERSION_CONFLICT']
  },
  {
    id: 'requirement_review_status', name: 'requirement_review_status', permission: 'read', riskLevel: 'low', requiresApproval: false,
    description: 'Compare a Review dependency snapshot with current files and return CURRENT or STALE deterministically.',
    inputSchema: { ...identity, reviewPath: { type: 'string', required: true } }, outputSchema: { type: 'json' },
    errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE', 'ARTIFACT_NOT_FOUND']
  },
  {
    id: 'requirement_review_write', name: 'requirement_review_write', permission: 'write', riskLevel: 'high', requiresApproval: true,
    description: 'Write the confirmed Requirement Review model and Markdown as a new version without changing upstream Artifacts or lifecycle stage.',
    inputSchema: { ...identity, reviewRunId: { type: 'string', required: true } }, outputSchema: { type: 'json' },
    errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE', 'APPROVAL_REQUIRED', 'REVIEW_NOT_READY', 'SOURCE_CHANGED', 'TARGET_EXISTS', 'WRITE_FAILED']
  },
  {
    id: 'artifact_next_version', name: 'artifact_next_version', permission: 'read', riskLevel: 'low', requiresApproval: false,
    description: 'Deterministically calculate the next legal versioned filename for an Artifact from real files in the current Requirement. Never guess version numbers.',
    inputSchema: {
      ...identity,
      artifactId: { type: 'string', description: 'Existing Artifact id.' },
      path: { type: 'string', description: 'Existing Requirement-relative Artifact path.' },
      newPath: { type: 'string', description: 'For a new Artifact only, a safe versionable Requirement-relative path such as prototype/case-detail-v1.html.' }
    },
    outputSchema: { type: 'json' },
    errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE', 'ARTIFACT_NOT_FOUND', 'VERSION_CONFLICT']
  },
  {
    id: 'artifact_diff', name: 'artifact_diff', permission: 'read', riskLevel: 'low', requiresApproval: false,
    description: 'Generate a deterministic structured diff between one real Artifact and candidate content. This creates a candidate only and never writes a file.',
    inputSchema: {
      ...identity,
      artifactId: { type: 'string', description: 'Existing Artifact id.' },
      path: { type: 'string', description: 'Existing Requirement-relative Artifact path.' },
      candidate: { type: 'string', required: true, description: 'Complete candidate file content.' },
      writeMode: { type: 'string', enum: ['new-version', 'overwrite'], description: 'Defaults to new-version. Use overwrite only when the user explicitly requested replacing the current file.' }
    },
    outputSchema: { type: 'json' },
    errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE', 'ARTIFACT_NOT_FOUND', 'NO_CHANGES', 'FILE_TOO_LARGE']
  },
  {
    id: 'artifact_write', name: 'artifact_write', permission: 'write', riskLevel: 'high', requiresApproval: true,
    description: 'Write a previously diffed candidate only after ESPow records explicit user approval. Calling this without granted approval never writes and returns approval-required.',
    inputSchema: {
      ...identity,
      approvalId: { type: 'string', required: true, description: 'Approval id returned by artifact_diff.' },
      targetPath: { type: 'string', required: true, description: 'Approved Requirement-relative target path returned by artifact_next_version.' }
    },
    outputSchema: { type: 'json' },
    errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE', 'APPROVAL_REQUIRED', 'APPROVAL_MISMATCH', 'SOURCE_CHANGED', 'TARGET_EXISTS', 'WRITE_FAILED']
  },
  {
    id: 'workspace_validate', name: 'workspace_validate', permission: 'read', riskLevel: 'low', requiresApproval: false,
    description: 'Deterministically validate the current Requirement Workspace and an optional newly written Artifact after a controlled write.',
    inputSchema: {
      ...identity,
      path: { type: 'string', description: 'Newly written Requirement-relative path to validate.' },
      sourcePath: { type: 'string', description: 'Original Artifact path that must remain intact for a versioned write.' }
    },
    outputSchema: { type: 'json' },
    errors: ['INVALID_INPUT', 'WORKSPACE_SCOPE', 'VALIDATION_FAILED']
  }
]
