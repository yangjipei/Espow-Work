import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { SkillSelection } from '../../src/skills'
import { getEspowToolContract } from '../../src/tools'

interface SkillContract extends SkillSelection {
  description: string
  modes: SkillSelection['mode'][]
  inputs: string[]
  outputs: string[]
  allowed_tools: string[]
}

export interface SelectedSkill extends SkillSelection {
  instructions: string
  fullInstructions?: string
  loadMode?: 'capsule' | 'full'
  clarificationRequired: boolean
  allowedTools: string[]
}

function section(markdown: string, names: string[]): string {
  const headings = names.map((name) => name.toLowerCase())
  const lines = markdown.split(/\r?\n/)
  const selected: string[] = []
  let active = false
  for (const line of lines) {
    const match = line.match(/^##\s+(.+?)\s*$/)
    if (match) {
      active = headings.includes(match[1].trim().toLowerCase())
      continue
    }
    if (active && line.trim()) selected.push(line)
  }
  return selected.join('\n').trim()
}

function runtimeCapsule(contract: SkillContract, markdown: string): string {
  const decisionRules = section(markdown, ['Method', 'Principles', 'Analysis Focus', 'Interaction'])
  const exitCriteria = section(markdown, ['Completion', 'Output'])
  const constraints = section(markdown, ['Prerequisite', 'Script-First Contract', 'Evidence', 'Non-goals'])
  return [
    `# Runtime Skill Capsule: ${contract.name}`,
    `Role\n${contract.description}`,
    `Stage Goal\n${section(markdown, ['Purpose']) || contract.description}`,
    `Decision Rules\n${decisionRules || '基于当前 Stage 的结构化事实进行最小充分判断。'}`,
    `Exit Criteria\n${exitCriteria || `完成 ${contract.outputs.join('、')} 的结构化提交，并满足当前阶段 Gate。`}`,
    `Allowed Actions\n${contract.allowed_tools.join('\n')}`,
    `Critical Constraints\n${constraints || '遵守 Lifecycle、Approval 与 Workspace 边界。'}`
  ].join('\n\n')
}

function needsFullSkill(task: string): boolean {
  return /(完整(?:加载|规则|skill|技能)|全文(?:skill|技能)|规则冲突|未知场景|阶段切换|重新完整分析)/i.test(task)
}

const changeIntent = /(修改|调整|新增|增加|删除|移除|取消|补充|补到|补进|补上|替换|改成|变更|同步|不重试|不告警|重试\s*三次|update|change|remove|add|cancel)/i
const vagueChange = /^\s*(这个|这里|那个|那里)?\s*(规则|内容|地方|它)?\s*(修改|调整|改|变更|优化)(一下|下)?[\s。！！!]*$/i
const analysisIntent = /(新需求|需求分析|开始.*分析.*需求|分析一下.*需求|重新.*(?:梳理|分析)|梳理一下|到底解决什么问题|补充(?:事实|信息)|回答.*(?:问题|如下)|还有一个场景|问题.*(?:尚未|不清楚)|场景.*不清楚|主流程.*不清楚|阻碍.*不清楚|效率(?:比较)?低|容易错过|看看.*需求.*怎么做|怎么做这个需求|优化.*(?:效率|体验|流程)|发现问题|定义问题)/i
const businessFlowIntent = /(business[\s-]*flow|业务流程|生成.*流程图|设计.*业务.*流程|基于.*需求分析.*流程)/i
const solutionDesignIntent = /(solution[\s-]*design|方案设计|产品方案|设计.*方案|基于.*(?:需求分析|业务流程).*(?:方案|solution))/i
const excludesSolutionDesign = /(不做|不要|无需|不需要|不进入|不要开始).{0,10}(方案设计|产品方案|solution)/i
const interactionDesignIntent = /(interaction[\s-]*design|交互设计|交互方案|设计.*交互|app\s*交互|页面结构|页面流程|page[\s-]*flow|用户操作路径|基于.*(?:产品方案|solution).*(?:交互|页面))/i
const excludesInteractionDesign = /(不做|不要|无需|不需要|不进入|不要开始).{0,10}(交互设计|交互方案|interaction|页面流程)/i
const prototypeIntent = /(prototype|页面原型|html\s*原型|生成.*原型|基于.*交互.*(?:页面|原型)|可交互.*页面)/i
const productSpecIntent = /(product[\s-]*spec|(?:生成|编写|创建|产出|整理|收敛).{0,12}(?:\bprd\b|产品需求文档|产品规格)|(?:\bprd\b|产品需求文档|产品规格).{0,12}(?:生成|编写|创建|产出|整理|收敛))/i
const requirementReviewIntent = /(requirement[\s-]*review|需求评审|评审(?:一下|当前|这个|需求|prd)|评审.{0,24}(?:需求|prd|prototype|artifact|一致)|(?:检查|判断).{0,12}(?:是否|有没有).{0,8}(?:ready|准备好|开发条件|研发条件)|ready\s*gate)/i

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item)) {
    throw new Error(`Skill Contract ${field} 必须是非空字符串数组。`)
  }
  return value
}

export class SkillRegistry {
  private readonly contracts = new Map<string, SkillContract>()
  private readonly instructions = new Map<string, string>()

  constructor(skillRoot: string) {
    this.load(skillRoot, 'requirement-change', '需求变更', ['delta'])
    this.load(skillRoot, 'requirement-analysis', '需求分析', ['start', 'analysis'])
    this.load(skillRoot, 'business-flow', '业务流程', ['flow'])
    this.load(skillRoot, 'solution-design', '方案设计', ['solution'])
    this.load(skillRoot, 'interaction-design', '交互设计', ['interaction'])
    this.load(skillRoot, 'prototype', '页面原型', ['prototype'])
    this.load(skillRoot, 'product-spec', '产品需求文档', ['product-spec'])
    this.load(skillRoot, 'requirement-review', '需求评审', ['review'])
  }

  private load(skillRoot: string, id: string, name: string, expectedModes: SkillSelection['mode'][]): void {
    const directory = join(skillRoot, id)
    const raw = parseYaml(readFileSync(join(directory, 'skill.yaml'), 'utf8')) as Record<string, unknown>
    const modes = stringList(raw.mode, 'mode') as SkillSelection['mode'][]
    if (raw.id !== id || raw.name !== name || typeof raw.description !== 'string' || typeof raw.version !== 'string'
      || modes.length !== expectedModes.length || modes.some((mode, index) => mode !== expectedModes[index])) {
      throw new Error(`${id} Skill Contract 无效。`)
    }
    const allowedTools = stringList(raw.allowed_tools, 'allowed_tools')
    const unknownTools = allowedTools.filter((tool) => !getEspowToolContract(tool))
    if (unknownTools.length) throw new Error(`${id} Skill Contract 引用了未注册 Tool：${unknownTools.join('、')}`)
    this.contracts.set(id, {
      id, name, description: raw.description, version: raw.version, mode: modes.at(-1)!, modes,
      inputs: stringList(raw.inputs, 'inputs'), outputs: stringList(raw.outputs, 'outputs'),
      allowed_tools: allowedTools
    })
    const full = readFileSync(join(directory, 'SKILL.md'), 'utf8').trim()
    this.instructions.set(id, full)
  }

  select(task: string, forceAnalysis = false, forceBusinessFlow = false, forceSolutionDesign = false, forceInteractionDesign = false, forcePrototype = false, forceProductSpec = false, forceRequirementReview = false): SelectedSkill | null {
    this.currentTask = task
    const normalized = task.trim()
    if (forceRequirementReview) return this.selected('requirement-review', false)
    if (forceProductSpec) return this.selected('product-spec', false)
    if (forcePrototype) return this.selected('prototype', false)
    if (forceInteractionDesign) return this.selected('interaction-design', false)
    if (forceSolutionDesign) return this.selected('solution-design', false)
    if (forceBusinessFlow) return this.selected('business-flow', false)
    if (forceAnalysis) return this.selected('requirement-analysis', false)
    if (requirementReviewIntent.test(normalized)) return this.selected('requirement-review', false)
    if (prototypeIntent.test(normalized)) return this.selected('prototype', false)
    if (!excludesInteractionDesign.test(normalized) && interactionDesignIntent.test(normalized) && changeIntent.test(normalized) && !/(生成|构建|梳理|设计.+(?:交互|页面))/i.test(normalized)) {
      return this.selected('requirement-change', vagueChange.test(normalized))
    }
    if (!excludesInteractionDesign.test(normalized) && interactionDesignIntent.test(normalized)) return this.selected('interaction-design', false)
    if (!excludesSolutionDesign.test(normalized) && solutionDesignIntent.test(normalized) && changeIntent.test(normalized) && !/(生成|设计|构建|梳理)/i.test(normalized)) {
      return this.selected('requirement-change', vagueChange.test(normalized))
    }
    if (!excludesSolutionDesign.test(normalized) && solutionDesignIntent.test(normalized)) return this.selected('solution-design', false)
    if (businessFlowIntent.test(normalized) && changeIntent.test(normalized) && !/(生成|设计|构建|梳理)/i.test(normalized)) {
      return this.selected('requirement-change', vagueChange.test(normalized))
    }
    if (businessFlowIntent.test(normalized)) return this.selected('business-flow', false)
    if (productSpecIntent.test(normalized)) return this.selected('product-spec', false)
    if (analysisIntent.test(normalized)) return this.selected('requirement-analysis', false)
    if (!changeIntent.test(normalized)) return null
    return this.selected('requirement-change', vagueChange.test(normalized))
  }

  selectById(id: string, task: string): SelectedSkill | null {
    if (!this.contracts.has(id)) return null
    this.currentTask = task
    return this.selected(id, false)
  }

  private selected(id: string, clarificationRequired: boolean): SelectedSkill {
    const contract = this.contracts.get(id)!
    const fullInstructions = this.instructions.get(id)!
    const loadMode = needsFullSkill(this.currentTask) ? 'full' : 'capsule'
    return {
      id: contract.id, name: contract.name, version: contract.version, mode: contract.mode,
      instructions: loadMode === 'full' ? fullInstructions : runtimeCapsule(contract, fullInstructions),
      fullInstructions, loadMode, clarificationRequired, allowedTools: [...contract.allowed_tools]
    }
  }

  private currentTask = ''
}
