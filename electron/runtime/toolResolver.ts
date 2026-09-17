import type { SelectedSkill } from '../skills/skillRegistry'

export interface ToolResolution {
  tools: string[]
  mode: 'dynamic' | 'stage-fallback'
  reason: string
}

const readIntent = /(读取|查看|检查|对比|冲突|历史|资料|文档|附件|artifact|source|prd|流程|方案|交互|原型|评审)/i
const analysisSourceReadIntent = /(?:核对|对照|回看|读取|查看|检查).{0,12}(?:原始|source|资料|文档|附件)|(?:原始|source).{0,12}(?:核对|对照|读取|查看)/i
const stagePlans: Record<string, string[]> = {
  'business-flow': ['artifact_read', 'business_flow_next_version', 'business_flow_ready', 'business_flow_submit'],
  'solution-design': ['artifact_read', 'solution_design_next_version', 'solution_coverage_check', 'solution_overdesign_check', 'solution_design_submit'],
  'interaction-design': ['artifact_read', 'interaction_design_next_version', 'interaction_design_ready', 'interaction_design_submit'],
  prototype: ['artifact_read', 'artifact_next_version', 'prototype_ready', 'prototype_submit'],
  'product-spec': ['artifact_read', 'product_spec_next_version', 'product_spec_ready', 'product_spec_submit'],
  'requirement-review': ['artifact_read', 'requirement_review_next_version', 'requirement_review_ready', 'requirement_review_submit']
}

function allowed(skill: SelectedSkill, requested: string[]): string[] {
  const contract = new Set(skill.allowedTools)
  return requested.filter((tool, index) => contract.has(tool) && requested.indexOf(tool) === index)
}

export function resolveTools(task: string, skill: SelectedSkill | null): ToolResolution {
  if (!skill) {
    const tools = readIntent.test(task) ? ['workspace_read', 'artifact_find', 'artifact_read'] : []
    return { tools, mode: 'dynamic', reason: tools.length ? '当前问答需要核实 Workspace / Artifact。' : '当前问答可基于已解析 Context 回答。' }
  }
  if (skill.id === 'requirement-analysis') {
    const tools = analysisSourceReadIntent.test(task)
      ? ['artifact_find', 'artifact_read', 'analysis_turn_submit']
      : ['analysis_turn_submit']
    return { tools: allowed(skill, tools), mode: 'dynamic', reason: tools.length === 1 ? '本轮只提交 Mainline Delta。' : '本轮需先核实资料，再提交 Mainline Delta。' }
  }
  const stage = stagePlans[skill.id]
  if (stage) return { tools: allowed(skill, stage), mode: 'dynamic', reason: '仅注入当前 Stage 的读取、校验与结构化提交能力；确认后写入由 Runtime 执行。' }
  if (skill.id === 'requirement-change') {
    const tools = ['artifact_find', 'artifact_read', 'artifact_diff', 'change_result_submit']
    if (/流程|flow/i.test(task)) tools.push('business_flow_next_version', 'business_flow_ready', 'business_flow_submit')
    if (/方案|solution|能力/i.test(task)) tools.push('solution_design_next_version', 'solution_coverage_check', 'solution_overdesign_check', 'solution_design_submit')
    if (/交互|页面|interaction/i.test(task)) tools.push('interaction_design_next_version', 'interaction_design_ready', 'interaction_design_submit')
    if (/原型|prototype|html/i.test(task)) tools.push('artifact_next_version', 'prototype_ready', 'prototype_submit')
    if (/prd|产品需求文档|产品规格/i.test(task)) tools.push('product_spec_next_version', 'product_spec_ready', 'product_spec_submit')
    return { tools: allowed(skill, tools), mode: 'dynamic', reason: '按 Delta 涉及的 Artifact 类型注入最小能力集合。' }
  }
  return { tools: [...skill.allowedTools], mode: 'stage-fallback', reason: '无法可靠收敛能力范围，回退到 Skill Stage Tool Set。' }
}
