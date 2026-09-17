# 需求分析 + 场景分析

## Purpose
把模糊需求转成明确的问题定义、场景地图、主流程、阻碍、根因和边界。

## When to use
根据当前产品工作场景按需使用，不因上一个 Skill 完成而自动调用。

## Interaction Contract
默认交互等级：**L3**。
遵循 Clarification / Confirmation / Decision 原则，已确认信息不重复询问。

## Output Contract
默认写入：`analysis/requirement-analysis.md`、`analysis/scenario-map.md`（中文界面：问题与场景）。
输出写入 Requirement Workspace 对应成果目录，而不是创建以 Skill 命名的用户目录。

## Analysis Focus
- 用户 / 角色
- 场景 / 用户任务
- 主流程 / 阻碍
- 根因 / 边界
- 正常、异常、边界、退出、恢复场景

## Quality Gate
主流程、关键场景、阻碍和边界清晰；产品经理确认后才视为收敛。

## Non-goals
- 不自动推进下一 Skill。
- 不把模型推断静默升级为 FACT 或 DECISION。
