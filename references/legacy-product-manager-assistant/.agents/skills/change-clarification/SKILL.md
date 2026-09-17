# 开发答疑 / 需求变更

## Purpose
区分解释已有事实、信息补充和真正需求变更，并维护当前唯一事实源。

## When to use
根据当前产品工作场景按需使用，不因上一个 Skill 完成而自动调用。

## Interaction Contract
默认交互等级：**L3（Change）**。
遵循 Clarification / Confirmation / Decision 原则，已确认信息不重复询问。

## Output Contract
默认写入：`changes/` + 受影响产物（中文界面：决策与变更）。
输出写入 Requirement Workspace 对应成果目录，而不是创建以 Skill 命名的用户目录。

## Decision Rule
先判断是 Clarification / Supplement / Change。只有真正改变 Problem / Scope / Goal / Solution / Rule / Acceptance 的内容才作为 Change，并必须由产品经理确认。

## Non-goals
- 不自动推进下一 Skill。
- 不把模型推断静默升级为 FACT 或 DECISION。
