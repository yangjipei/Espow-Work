# 数据 / 状态 / 权限 / 异常设计

## Purpose
补齐研发落地所需的产品语义。

## When to use
根据当前产品工作场景按需使用，不因上一个 Skill 完成而自动调用。

## Interaction Contract
默认交互等级：**L1/L2**。
遵循 Clarification / Confirmation / Decision 原则，已确认信息不重复询问。

## Output Contract
默认写入：`更新对应规则、页面与 PRD`。
输出写入 Requirement Workspace 对应成果目录，而不是创建以 Skill 命名的用户目录。

## Non-goals
- 不自动推进下一 Skill。
- 不把模型推断静默升级为 FACT 或 DECISION。
