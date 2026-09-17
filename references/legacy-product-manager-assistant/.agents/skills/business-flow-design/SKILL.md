# 业务规则与流程设计

## Purpose
把已确认方案转成可执行、可测试的流程、规则与必要状态模型。

## When to use
根据当前产品工作场景按需使用，不因上一个 Skill 完成而自动调用。

## Interaction Contract
默认交互等级：**L2**。
遵循 Clarification / Confirmation / Decision 原则，已确认信息不重复询问。

## Output Contract
默认写入：`flows/`（中文界面：业务流程）。
输出写入 Requirement Workspace 对应成果目录，而不是创建以 Skill 命名的用户目录。

## Non-goals
- 不自动推进下一 Skill。
- 不把模型推断静默升级为 FACT 或 DECISION。
