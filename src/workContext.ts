export const workContextIpc = {
  get: 'work-context:get',
  saveCompany: 'work-context:save-company',
  saveSystem: 'work-context:save-system',
  setSystemActive: 'work-context:set-system-active',
  deleteSystem: 'work-context:delete-system',
  saveRelation: 'work-context:save-relation',
  deleteRelation: 'work-context:delete-relation'
} as const

export interface WorkContextTerm { term: string; description: string }

export interface WorkContextCompany {
  name: string
  industry: string
  description: string
  coreBusiness: string[]
  regions: string[]
  terms: WorkContextTerm[]
  rawContext: string
  updatedAt: string | null
}

export type WorkContextSystemType = 'internal' | 'external'

export interface WorkContextSystem {
  id: string
  name: string
  alias: string
  type: WorkContextSystemType
  positioning: string
  coreUsers: string[]
  coreCapabilities: string[]
  boundary: string
  notes: string
  active: boolean
  createdAt: string
  updatedAt: string
}

export const relationTypeLabels = {
  PROVIDE_DATA: '提供数据', PROVIDE_CASE: '提供案件', PROVIDE_STRATEGY: '提供策略', CALL: '调用',
  CALLED_BY: '被调用', SYNC_DATA: '同步数据', SYNC_STATUS: '同步状态', RETURN_RESULT: '回传结果',
  DEPEND_ON: '依赖', OTHER: '其他'
} as const

export type WorkContextRelationType = keyof typeof relationTypeLabels

export interface WorkContextSystemRelation {
  id: string
  sourceSystemId: string
  relationType: WorkContextRelationType
  customRelationName: string
  targetSystemId: string
  description: string
  createdAt: string
  updatedAt: string
}

export interface WorkContextSnapshot {
  company: WorkContextCompany
  systems: WorkContextSystem[]
  relations: WorkContextSystemRelation[]
}

export type WorkContextReason = 'USED' | 'NOT_CONFIGURED' | 'NOT_REQUIRED' | 'NO_RELEVANT_CONTEXT'

export interface ResolvedWorkContext {
  used: boolean
  reason: WorkContextReason
  sources: Array<'company' | 'current_system' | 'system_relations' | 'neighbor_systems'>
  primarySystemId: string | null
  relationCount: number
  company?: WorkContextCompany
  currentSystem?: WorkContextSystem
  relations?: WorkContextSystemRelation[]
  neighborSystems?: WorkContextSystem[]
}

export type SaveSystemInput = Omit<WorkContextSystem, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
export type SaveRelationInput = Omit<WorkContextSystemRelation, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }

export interface WorkContextApi {
  get: () => Promise<WorkContextSnapshot>
  saveCompany: (company: Omit<WorkContextCompany, 'updatedAt'>) => Promise<WorkContextSnapshot>
  saveSystem: (system: SaveSystemInput) => Promise<WorkContextSnapshot>
  setSystemActive: (systemId: string, active: boolean) => Promise<WorkContextSnapshot>
  deleteSystem: (systemId: string) => Promise<WorkContextSnapshot>
  saveRelation: (relation: SaveRelationInput) => Promise<WorkContextSnapshot>
  deleteRelation: (relationId: string) => Promise<WorkContextSnapshot>
}
