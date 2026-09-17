# ESPow Skills

本文档只记录已经接入真实 Runtime 的 Skill。

## Requirement Review

```text
ID: requirement-review
名称：需求评审
版本：0.1.0
模式：Review
```

用于从产品、研发与测试视角检查当前正式 Requirement 是否具备无需产品经理临时口头补充的落地条件。它不重新做需求，不修改上游 Artifact，只输出带证据、影响和 `recommendedStage` 的结构化 `ReviewIssue[]`。

正式评审要求最新 Product Spec / PRD 为 `CONFIRMED`；用户明确要求时可对 Draft 做 `DRAFT_REVIEW`，但不能形成最终 Ready Gate。结论由 OPEN Issue 严重度确定：存在 `BLOCKER` 为 `NOT_READY`，只有 `WARNING` 为 `READY_WITH_WARNINGS`，否则为 `READY`。

候选链路为 `requirement_review_next_version → artifact_read 当前依赖 → requirement_review_ready → requirement_review_submit → WaitingConfirmation → requirement_review_write → workspace_validate`。正式 Artifact 为 `review/requirement-review-vN.json` 与 `.md`。每次 Review 绑定依赖路径、版本和内容哈希；依赖变化后 `requirement_review_status` 确定性返回 `STALE`，旧 READY 不再作为当前结论。完整规则见 `docs/requirement-review.md`。

## Product Spec

```text
ID: product-spec
名称：产品需求文档 / PRD
版本：0.1.0
模式：Product Spec
```

用于把已确认 Requirement Analysis、Business Flow、Solution Design，以及页面型需求的 Interaction Design，收敛为研发、测试和产品可直接使用的规格。Prototype 可作为页面行为参考但不是强制前置；纯后台需求允许 Prototype = N/A。

Product Spec Model 是 Source of Truth，按 Capability 组织功能，以稳定 `BRxx` 记录业务规则，并覆盖适用的状态、字段来源、异常、Retry / Timeout、Callback、幂等、退出、恢复、依赖与验收标准。Mock Data 不会成为业务事实。上游冲突、Prototype 一致性问题或阻断 Open Issue 会保持 `WAITING_CLARIFICATION`。

候选链路为 `product_spec_next_version → product_spec_ready → product_spec_submit → WaitingConfirmation → product_spec_write → workspace_validate`。正式 Artifact 为 `prd/product-spec-vN.json` 与 `prd/prd-vN.md`；已有 PRD 只生成受影响章节的下一版本 Delta。完整规则见 `docs/product-spec.md`。

## Prototype

```text
ID: prototype
名称：页面原型
版本：0.1.0
模式：Prototype
```

用于把最新 Interaction Design 表现为自包含、可打开、可操作的 HTML 产品原型。正式候选要求 Interaction 已确认；未确认时只能生成 Draft。执行时遵循 Existing UI First，优先读取当前有效 Prototype 并只做局部 Delta，没有页面时创建 V1。

版本由 `artifact_next_version` 从真实 Workspace 文件计算。Candidate 依次经过 `prototype_ready → prototype_submit → Preview / Diff → 用户确认 → prototype_write → workspace_validate`；确认前不写入 Workspace，默认保留历史版本。完整规则见 `docs/prototype.md`，Contract 位于 `skills/prototype/skill.yaml`。

## Interaction Design

```text
ID: interaction-design
名称：交互设计
版本：0.1.0
模式：Interaction
```

用于把已确认 Requirement Analysis、Business Flow 与 Solution Design 转化为可供 Prototype 消费的结构化交互方案。它优先复用 Existing Product / UI Baseline，明确 Product Surface、页面/区域/组件、入口、用户路径、状态、反馈、异常、恢复、取消/关闭和跨上下文规则，不生成 HTML、React、图片或最终 Prototype。

Interaction Model 是 Source of Truth，Markdown 由确定性 Renderer 生成。正式候选必须读取三个已确认上游，执行 `interaction_design_next_version → interaction_design_ready → interaction_design_submit`；产品经理确认后才写入递增版本 `interaction-design-vN.json` 与 `interaction-design-vN.md`。Decision、Open Question、Solution / Flow Conflict 会阻止 Ready。

完整规则见 `docs/interaction-design.md`，Contract 位于 `skills/interaction-design/skill.yaml`，专业方法位于 `skills/interaction-design/SKILL.md`。

## Solution Design

```text
ID: solution-design
名称：方案设计
版本：0.1.0
模式：Solution
```

用于把已确认 Requirement Analysis 与已确认 Business Flow 转化为结构化产品能力方案。它直接消费问题、场景、边界与流程，不重新分析需求，也不生成交互、原型、PRD、API 或技术架构。

Solution Model 是 Source of Truth，包含 Capability、Manual / Automatic、Input / Behavior / Output、Rules、States、Data Objects、Exception & Recovery、Product Surfaces、Decision Candidates、Open Questions、Flow Conflicts 与来源追踪。Markdown 由确定性 Renderer 生成。

正式候选必须依次经过：

```text
solution_coverage_check
→ solution_overdesign_check
→ solution_design_submit
→ WaitingConfirmation
→ solution_design_write
→ workspace_validate
```

前置事实未全部确认时只允许 Draft Solution Exploration。产品经理补充或拒绝时只更新受影响部分；明确确认后才成对写入递增版本 `solution-design-vN.json` 与 `solution-design-vN.md`。确认后不会自动启动 Interaction Design、Prototype 或 PRD。

完整规则见 `docs/solution-design.md`，Contract 位于 `skills/solution-design/skill.yaml`，专业方法位于 `skills/solution-design/SKILL.md`。

## Business Flow

```text
ID: business-flow
名称：业务流程
版本：0.1.0
模式：Flow
```

用于把已确认 Requirement Analysis 转为有入口、主流程、判断分支、异常、退出、恢复与终态的结构化业务流程。默认前置条件是正式 Analysis 中 `Analysis Status = confirmed`；未满足时 Runtime 返回 `Prerequisite Not Ready`。用户明确要求 draft 探索时只生成 `DRAFT`，不进入正式确认。

Flow Model 是 Source of Truth，`business-flow-vN.html` 由确定性 Renderer 生成。Ready Gate 检查图结构与显式语义闭环，用户确认后才成对写入递增版本的 JSON Model 和 HTML。

完整规则见 `docs/business-flow.md`，Contract 位于 `skills/business-flow/skill.yaml`，专业方法位于 `skills/business-flow/SKILL.md`。

## Requirement Analysis

```text
ID: requirement-analysis
名称：需求分析
版本：0.4.0
模式：Start / Analysis
```

用于新需求、目标或问题定义模糊、场景/主流程/阻碍不清楚，以及产品经理要求重新梳理已有需求的任务。它负责问题定义、角色、场景、当前主流程、阻碍、根因、边界与未知项，不负责继续启动方案、流程、原型或 PRD。

### Router 边界

- 模糊诉求、问题尚未定义、效率/体验问题需要还原、重新梳理需求：`requirement-analysis`。
- 已有 Requirement 上明确的新增、修改、删除、替换或同步：`requirement-change`。
- 已有 PRD 不会让 Analysis 自动接受其中的功能方案；必须区分 Problem 与 Existing Solution。

### Contract

机器 Contract 位于 `skills/requirement-analysis/skill.yaml`，专业方法位于 `skills/requirement-analysis/SKILL.md`。首次输出 Dynamic Mainline Blueprint（固定 Core + Requirement-specific Modules），确认后每轮只输出 Mainline / Working Delta：

```text
Problem Definition / Goal / Actors / Scenario Map
Current Main Flow / Blockers / Root Causes / Boundaries
FACT / ASSUMPTION / DECISION / OPEN_QUESTION
Out of Scope / Analysis Status
Mainline Schema / Module Data / Working Context
```

关键场景至少包含 Actor、Trigger、Current Flow、Blocker 与 Expected Outcome。Source Materials 优先；模型推断只能作为 ASSUMPTION，不能伪装成 FACT 或正式 Decision。

### Ready 与确认

`analysis_turn_submit` 确定性合并 Delta，并检查问题定义、主要角色、至少一个场景、当前主流程、范围、Blocking Open Issue 和已确认 Schema。通过后只能进入 `ReadyForConfirmation`，Run 状态为 `WaitingConfirmation`。

用户补充或拒绝时回到 Analysis。只有用户明确表达确认，Runtime 才执行：

```text
requirement_analysis_write
→ workspace_validate
→ Confirmed
```

正式 Artifact 为 `analysis/requirement-analysis.md`。确认前不写入，确认后不会自动进入其他 Skill。

## Requirement Change

```text
ID: requirement-change
名称：需求变更
版本：0.1.0
模式：Delta
```

用于处理已有 Requirement 上的增量修改。它负责理解变化、语义影响判断、修改范围收敛与修改建议，不负责文件定位、Diff、版本、写入、Approval 或 Run 状态。

### Router

当前 Router 是可测试的轻量规则：已有 Requirement 中的修改、新增、删除、补充、替换和同步类请求选择 `requirement-change`。读取、解释和总结类问答不选择它。

只包含“这个规则调整一下”类指代且没有具体新内容的请求，会产生 `ClarificationRequired`，不扩大 Context。

### Change Result

每个 Skill Run 保存：

```text
Change Summary
Impact Assessment
Affected Artifacts
Unaffected Artifacts
Open Questions
Decisions Affected
Files Read
Candidate Changes
Final Changes
Validation Result
```

Run 同时保存 Skill ID、Skill Version、真实 Tool Calls、已读 Artifact 与已写 Artifact。

### 交互结果

- `Assessed`：影响已判断；如有候选修改，通过 Diff 等待用户确认。
- `ClarificationRequired`：变化对象或新规则不足以确定。
- `DecisionConflict`：新要求与已有 Decision 冲突，不静默覆盖。

确认候选修改后，Runtime 继续使用已有 `artifact_next_version → artifact_write → workspace_validate` 闭环；取消时不调用 `artifact_write`。
