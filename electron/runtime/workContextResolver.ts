import type { WorkContextSnapshot, ResolvedWorkContext, WorkContextSystem } from '../../src/workContext'

const companyIntent = /(公司|业务模式|业务定位|所属行业|核心业务|业务地区|业务术语|符合.*(?:业务|公司))/i
const relationIntent = /(上游|下游|上下游|其他系统|系统关系|依赖|调用|回传|同步|影响.*系统|系统.*影响)/i
const systemIntent = /(产品定位|系统定位|系统边界|能力.*放在|归属.*系统|哪个系统|产品\s*\/\s*系统)/i

function configured(snapshot: WorkContextSnapshot): boolean {
  const company = snapshot.company
  return Boolean(company.name || company.industry || company.description || company.coreBusiness.length || company.regions.length || company.terms.length || company.rawContext
    || snapshot.systems.length || snapshot.relations.length)
}

function mentions(task: string, system: WorkContextSystem): boolean {
  return [system.name, system.alias].filter(Boolean).some((name) => task.toLowerCase().includes(name.toLowerCase()))
}

export function resolveWorkContext(snapshot: WorkContextSnapshot, primarySystemId: string | null, task: string): ResolvedWorkContext {
  const base: Pick<ResolvedWorkContext, 'used' | 'sources' | 'primarySystemId' | 'relationCount'> = {
    used: false, sources: [], primarySystemId, relationCount: 0
  }
  if (!configured(snapshot)) return { ...base, reason: 'NOT_CONFIGURED' }
  const wantsCompany = companyIntent.test(task)
  const wantsRelations = relationIntent.test(task)
  const wantsSystem = wantsRelations || systemIntent.test(task) || snapshot.systems.some((system) => mentions(task, system))
  if (!wantsCompany && !wantsSystem) return { ...base, reason: 'NOT_REQUIRED' }

  const activeSystems = snapshot.systems.filter((system) => system.active)
  const currentSystem = activeSystems.find((system) => system.id === primarySystemId)
    ?? activeSystems.find((system) => mentions(task, system))
  const relations = wantsRelations && currentSystem
    ? snapshot.relations.filter((relation) => relation.sourceSystemId === currentSystem.id || relation.targetSystemId === currentSystem.id)
    : wantsRelations
      ? snapshot.relations.filter((relation) => {
        const source = activeSystems.find((system) => system.id === relation.sourceSystemId)
        const target = activeSystems.find((system) => system.id === relation.targetSystemId)
        return Boolean(source && target && (mentions(task, source) || mentions(task, target)))
      })
      : []
  const neighborIds = new Set(relations.flatMap((relation) => [relation.sourceSystemId, relation.targetSystemId]))
  if (currentSystem) neighborIds.delete(currentSystem.id)
  const namedSystems = activeSystems.filter((system) => mentions(task, system) && system.id !== currentSystem?.id)
  const neighborSystems = activeSystems.filter((system) => neighborIds.has(system.id) || namedSystems.some((named) => named.id === system.id))
  const sources: ResolvedWorkContext['sources'] = []
  const companyAvailable = wantsCompany && Boolean(snapshot.company.name || snapshot.company.industry || snapshot.company.description
    || snapshot.company.coreBusiness.length || snapshot.company.regions.length || snapshot.company.terms.length || snapshot.company.rawContext)
  if (companyAvailable) sources.push('company')
  if (currentSystem) sources.push('current_system')
  if (relations.length) sources.push('system_relations')
  if (neighborSystems.length) sources.push('neighbor_systems')
  if (!sources.length) return { ...base, reason: 'NO_RELEVANT_CONTEXT' }
  return {
    used: true, reason: 'USED', sources, primarySystemId: currentSystem?.id ?? primarySystemId, relationCount: relations.length,
    ...(companyAvailable ? { company: snapshot.company } : {}),
    ...(currentSystem ? { currentSystem } : {}),
    ...(relations.length ? { relations } : {}),
    ...(neighborSystems.length ? { neighborSystems } : {})
  }
}
