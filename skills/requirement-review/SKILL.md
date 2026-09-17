# 需求评审

## Purpose

判断：如果今天把当前正式 Requirement 交给研发与测试，是否能在不依赖产品经理临时口头补充的前提下开始落地与验收。

## Boundary

- 只检查、定位问题、说明影响并建议回到哪个 Stage 解决。
- 不重新定义问题，不重做流程、方案、交互、Prototype 或 PRD。
- 不自动修改 Artifact、Decision、Open Issue 或 Requirement Stage。
- 不做技术架构评审；技术选型只有在影响业务行为时才属于 Review Issue。

## Prerequisite

- 正式 Review 要求当前 Product Spec / PRD 为 `CONFIRMED`。
- PRD 未确认时返回 `Prerequisite Not Ready`，不得给出正式 READY。
- 用户明确要求提前评审 Draft 时允许 `DRAFT_REVIEW`，但结论不是最终 Ready Gate。

## Inputs

只读取当前有效版本：Confirmed Analysis、Flow、Solution、适用时的 Interaction 与 Prototype、Confirmed Product Spec、Active Decisions、Open Issues、Requirement Snapshot，以及确有必要的 Source Material。不要默认读取所有历史版本。

## Method

1. 检查 Problem / Goal / In Scope / Out of Scope 与后续设计的一致性，识别 Scope 漂移。
2. 追踪主要 Scenario 到 Flow、Capability、Interaction、PRD Rule 与 Acceptance Criteria，发现遗漏、冲突、扩大、缩减和语义变化。
3. 检查 Flow 入口、主流程、判断分支、异常、退出、异步回流、恢复和终态是否闭环。
4. 检查重要 Flow 节点是否由 Solution Capability 承载；页面型需求检查入口、Loading、Disabled、错误、重试、取消、返回、关闭和成功反馈，避免用户死路。
5. 有 Prototype 时检查主要页面能力、关键状态和交互与 PRD 是否一致；Mock Data 不参与业务规则正确性判断。
6. 检查关键 Rule 是否明确触发、条件、行为、结果与失败处理；不接受“合理处理、根据实际情况、必要时、适当提示”等需要研发猜测的表达。
7. 按适用性检查 State、External Status Mapping、Field Source、Permission、Idempotency、Async、Timeout、Retry、Recovery、Exit、Failure、Boundary 与 Dependency。
8. 检查关键 Decision 一致性与 Open Issue 阻塞性；不自动替用户做未确认选择。
9. 从测试视角检查 Acceptance Criteria 是否具体、可执行、可观察且能判定通过或失败。

## Issue

每个 Issue 必须包含 ID、Severity、Category、标题、具体描述、证据、影响、来源 Artifact、Recommended Stage 与状态。证据应引用 Artifact 路径及章节、规则或节点；不要只写“这里不完善”。

- `BLOCKER`：研发或测试无法可靠继续，或关键业务行为仍需猜测。
- `WARNING`：可以继续，但存在明确风险。
- `INFO`：不影响当前落地的优化建议。

## Result

- 存在 OPEN BLOCKER：`NOT_READY`。
- 无 BLOCKER 但存在 OPEN WARNING：`READY_WITH_WARNINGS`。
- 无 BLOCKER 且无 WARNING：`READY`。
- 不为证明 Review 有价值而强行制造 Issue。

## Workflow

先用 `requirement_review_next_version` 获得版本与当前依赖，再按需读取依赖正文。结构化结论必须依次经过 `requirement_review_ready` 与 `requirement_review_submit`。正式候选等待产品经理确认后才由 `requirement_review_write` 写入 `review/requirement-review-vN.json` 和 `.md`。依赖内容变化后由 `requirement_review_status` 确定性返回 `STALE`。

## Non-goals

不自动修复问题，不自动回退生命周期，不自动进入开发，不实现 Development Agent、Code Review、技术架构评审、QA 自动化或多 Agent 评审委员会。
