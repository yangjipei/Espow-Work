# 方案产品化 / PRD

## Purpose
把已确认事实与决策组织成正式 PRD 和补充文档。

## When to use
根据当前产品工作场景按需使用，不因上一个 Skill 完成而自动调用。

## Interaction Contract
默认交互等级：**L0/L1**。
遵循 Clarification / Confirmation / Decision 原则，已确认信息不重复询问。

## Output Contract
默认写入：`prd/`（中文界面：产品文档）。
输出写入 Requirement Workspace 对应成果目录，而不是创建以 Skill 命名的用户目录。

## Quality Gate
PRD 只组织已确认 FACT / DECISION；ASSUMPTION 不写成确定规则；OPEN_QUESTION 保留到待确认问题。

## Non-goals
- 不自动推进下一 Skill。
- 不把模型推断静默升级为 FACT 或 DECISION。
