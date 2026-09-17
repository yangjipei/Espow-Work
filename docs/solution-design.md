# Solution Design Contract

## 定位

`solution-design @ 0.1.0` 将已确认的 Requirement Analysis 与 Business Flow 转为可继续指导交互设计、原型和 PRD 的产品方案。它回答“为了让业务真正跑起来，产品必须提供哪些能力”，不负责页面细节、PRD 或技术实现。

## 前置与 Context

正式方案要求：

```text
Requirement Analysis = CONFIRMED
Business Flow = CONFIRMED
```

Context 默认 L2，只选择 Requirement Snapshot、已确认 Analysis、最新 confirmed Flow JSON、Relevant Decisions、Active Open Issues、已有 Solution（Delta 时）和一个 `solution-design` Skill。未确认前置只允许明确请求的 Draft Solution Exploration。

## Solution Model

结构化 JSON 是 Source of Truth，核心字段为：

- Solution identity、overview、scope、status 与来源 Artifact；
- Capability：ID、Name、Layer、Purpose、Actor、Trigger、Manual / Automatic、Input、Behavior、Output、Related Flow Nodes、Rules、Exceptions、Surfaces 与来源引用；
- Product Rules、States、Data Objects、Exception & Recovery、Product Surfaces；
- Decision Candidates、Open Questions、Flow Conflicts；
- 显式 Semantic Checks。

状态支持：

```text
DRAFT
WAITING_CLARIFICATION
READY_FOR_CONFIRMATION
CONFIRMED
```

## Validator

`solution_coverage_check` 确定性检查 Capability ID、Input / Behavior / Output、Flow Node 覆盖、场景与决策追踪、Rule / Recovery / Surface / Data 引用，以及 Ready 状态下未决问题、Decision 和 Flow Conflict。

`solution_overdesign_check` 检查无来源 Capability、提前泄漏的技术实现、平台化范围扩张和异常高的能力数量。语义覆盖与无过度设计仍由模型显式判断，Tool 负责结构和可机械识别的 Gate。

## Artifact 与确认

候选只保存在 Run 的 `solution_result` 中，由 Tool 确定性渲染 Markdown。用户明确确认后成对原子写入：

```text
solution/solution-design-vN.json
solution/solution-design-vN.md
```

版本号来自真实文件；写入前比较来源指纹，写入后分别执行 Workspace Validator。用户拒绝不会写文件。确认后不得自动进入下一个 Skill。

Requirement Change 通过 `sourceScenarioIds`、`relatedFlowNodeIds` 与 `sourceDecisionIds` 定位受影响 Capability，并只生成最小结构化 Delta。
