# Requirement Review

`requirement-review @ 0.1.0` 判断当前产品方案是否已经具备研发评估、实现与测试设计条件。它是需求准备度 Gate，不是开发、测试或上线 Gate。

## 前置与模式

- 正式 Review 要求最新 Product Spec / PRD 为 `CONFIRMED`。
- 未满足时 Runtime 返回 `Prerequisite Not Ready`，不调用模型给出正式 READY。
- 用户明确要求提前评审 Draft 时允许 `DRAFT_REVIEW`，但不得写成最终 Ready Gate。

## Review Result

```text
存在 OPEN BLOCKER           → NOT_READY
无 BLOCKER、存在 WARNING    → READY_WITH_WARNINGS
无 BLOCKER、无 WARNING      → READY
```

INFO 不阻止 READY。Review 不为证明价值强行制造问题。

## Review Issue

`ReviewIssue` 包含 `id`、`severity`、`category`、`title`、`description`、`evidence[]`、`impact`、`sourceArtifacts[]`、`recommendedStage` 和 `status`。Evidence 使用 Artifact 路径、章节/规则/节点引用与短摘录，不能只写“这里不完善”。

V0.1 Category 为 Scope、Flow、Solution、Interaction、Prototype、Rule、State、Field、Data、Exception、Recovery、Dependency、Consistency、Acceptance。BLOCKER 只用于不解决就无法可靠开发或验收的问题。

## 检查范围

按适用性检查 Problem / Scope、Scenario Coverage、Flow 闭环、Solution Coverage、Interaction 完整性、Prototype 一致性、Rule 可执行性、State、第三方状态映射、Field / Data Source、Permission、Idempotency、Async / Timeout、Retry / Recovery、Exit、Failure、Boundary、Decision、Open Issue、上游一致性、Traceability 与 Acceptance Criteria。

Review 只定位问题并建议返回的 Stage。用户选择修复后，由对应 Skill 执行最小 Delta，再重新 Review；不重新串行执行完整生命周期。

## Artifact 与 Stale

正式 JSON 是 Source of Truth，Markdown 由 Tool 确定性渲染。每个 Review 保存实际依赖的路径、版本与 SHA-256 内容哈希。`requirement_review_status` 对比当前有效依赖；任何依赖内容变化或出现更高有效版本时返回 `STALE`，并隐藏旧结论。

## Runtime Trace

Run 展示 Skill / Version、Artifacts Reviewed、Result、Blocker / Warning / Info 数量、Open Issues、Review Version、Tool Calls 与 Context Metadata，不保存模型私有推理。
