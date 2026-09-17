import type { CreateRequirementInput, CreateRequirementResult, DeleteRequirementResult, RenameRequirementResult } from '../src/workspace'
import type { PersistenceService } from './persistenceService'
import type { LocalWorkspaceService } from './workspaceService'

interface RequirementPersistence {
  createThread: PersistenceService['createThread']
  syncRequirementSystemBinding?: PersistenceService['syncRequirementSystemBinding']
  renameRequirementMetadata?: PersistenceService['renameRequirementMetadata']
  deleteRequirementData?: PersistenceService['deleteRequirementData']
}

export class RequirementService {
  constructor(
    private readonly workspace: LocalWorkspaceService,
    private readonly persistence: RequirementPersistence
  ) {}

  async create(input: CreateRequirementInput): Promise<CreateRequirementResult> {
    const initialized = await this.workspace.initializeRequirement(input)
    try {
      const thread = this.persistence.createThread(initialized.workspace.id, initialized.requirement.id, '需求分析')
      this.persistence.syncRequirementSystemBinding?.(initialized.workspace.id, initialized.requirement.id, initialized.requirement.primarySystemId ?? null)
      return { workspace: initialized.workspace, requirement: initialized.requirement, thread }
    } catch (error) {
      await initialized.rollback()
      throw new Error(`创建 Requirement 失败：默认 Thread 创建失败：${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  async rename(requirementId: string, name: string): Promise<RenameRequirementResult> {
    const renamed = await this.workspace.renameRequirement(requirementId, name)
    try {
      if (!this.persistence.renameRequirementMetadata) throw new Error('Persistence 不支持 Requirement 重命名。')
      this.persistence.renameRequirementMetadata(renamed.workspace.id, requirementId, renamed.requirement.title)
      console.info('[requirement]', { operation: 'requirement_rename', requirementId, modelCalls: 0 })
      return { workspace: renamed.workspace, requirement: renamed.requirement }
    } catch (error) {
      await renamed.rollback()
      throw new Error(`重命名 Requirement 失败：数据库更新失败：${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  async delete(requirementId: string): Promise<DeleteRequirementResult> {
    const prepared = await this.workspace.prepareRequirementDeletion(requirementId)
    try {
      if (!this.persistence.deleteRequirementData) throw new Error('Persistence 不支持 Requirement 删除。')
      this.persistence.deleteRequirementData(prepared.workspaceId, requirementId, prepared.deleteDirectory)
      const workspace = await this.workspace.refreshCurrent()
      console.info('[requirement]', { operation: 'requirement_delete', requirementId, modelCalls: 0 })
      return { workspace, requirementId }
    } catch (error) {
      await this.workspace.refreshCurrent().catch(() => undefined)
      throw new Error(`删除 Requirement 失败：${error instanceof Error ? error.message : '未知错误'}`)
    }
  }
}
