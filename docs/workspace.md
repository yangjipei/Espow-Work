# ESPow Workspace Rules

本文件描述 Requirement Workspace、Thread、Artifact、状态和持久化边界。

涉及 Workspace / Requirement / Artifact 时读取。

---

# 1. Workspace First

一个需求对应一个：

> Requirement Workspace

一个 Workspace 可以拥有多个 Thread。

```text
Requirement Workspace
├── Thread A
├── Thread B
├── Thread C
└── Thread D
```

Thread 有独立聊天历史。

但共享当前 Requirement 的正式状态。

---

# 2. 事实源

正式业务事实保存在 Workspace 中。

以下都不是长期事实源：

```text
Chat
Thread
Session
模型上下文
```

正式内容可能包括：

- Requirement Overview
- Decisions
- Open Issues
- Artifacts
- Analysis
- Solution
- Flow
- Prototype
- PRD
- Review
- Changes

---

# 3. Domain Semantics

旧体系中的以下语义需要保留并重新评估：

```text
FACT
ASSUMPTION
DECISION
OPEN_QUESTION
```

在完成新 Domain Model 设计前：

- 不直接删除
- 不直接照搬旧实现
- 不只当 Prompt 文本
- 不因 UI 未展示就认为不再需要

---

# 4. Workspace 与 SQLite

Workspace 保存正式业务内容，例如：

- Markdown
- HTML
- YAML / JSON
- 图片
- PDF
- Excel
- 其他附件

SQLite 保存 App 自身状态，例如：

- Thread
- Message
- Run
- Session Mapping
- 最近 Workspace
- UI State
- 本地索引

不要把正式 PRD、Flow、Prototype、Decision、Open Issue 全部迁入 SQLite。

Workspace 应保持：

- 用户可访问
- 用户可编辑
- 可进入 Git
- 可独立于 Chat 存续
- 可被其他工具读取

---

# 5. Start / Delta

Start：

- 创建新 Requirement
- 初始化 Workspace
- 建立基础状态
- 建立必要初始 Artifact

Delta：

- 已有 Requirement 上的增量修改

Delta 原则：

```text
识别变化
↓
判断影响
↓
读取最小必要 Context
↓
调用 Skill / Tool
↓
修改必要 Artifact
↓
验证
```

不得默认重跑完整生命周期。

---

# 6. Artifact Driven

ESPow 的最终价值是 Artifact，而不是聊天记录。

典型 Artifact：

- Requirement Analysis
- Business Flow
- Page Flow
- Prototype
- PRD
- Review Result
- Change Result
- Decision
- Open Issue

---

# 7. Artifact 修改

正式 Artifact 默认不能静默覆盖。

```text
候选修改
↓
Diff / Patch
↓
用户确认
↓
写入
↓
验证
```

HTML 原型、流程图等需要保留历史版本的文件：

> 使用递增版本号。

默认不覆盖旧版本。

---

# 8. Agent Run

每次正式 Task 应形成 Run。

至少记录：

```text
Run ID
Requirement
Thread
Task
Status
Skill
Tools
Read Files
Changed Files
Started At
Finished At
Error
```

基本状态：

```text
Pending
Running
WaitingConfirmation
Completed
Failed
Cancelled
```

Run 必须来自真实 Runtime Event。

Run 同时记录 Context Metadata：Context Level、Snapshot、实际读取的 Artifact、使用的 Decision / Open Issue、主 Skill 与来源列表。它用于追踪 Agent 为什么知道这些信息，不保存完整 Prompt 或 Artifact 正文。

---

# Requirement Snapshot

Requirement Snapshot 是 Workspace 正式事实的短结构化派生投影。它不是聊天摘要，也不能通过自身修改正式业务事实；发生冲突时始终以 Workspace 文件为准。

Snapshot 缓存在 Desktop SQLite，不写入 Requirement Workspace。Context Manager 在 Task 开始前重新扫描当前 Requirement，并通过确定性来源指纹判断 Missing / Stale：缺失或正式 Artifact、Decision、Open Issue、Stage 等发生变化时刷新，未变化时复用。普通问答不会造成重复写入。

详细字段、Context Level 与选择策略见 `docs/context.md`。

---

# 9. V0.1 Workspace 能力

V0.1 至少支持：

- 选择本地 Workspace
- 创建 Requirement
- 读取已有 Requirement
- 创建 Thread
- 读取 Requirement Context
- 产生 Artifact 修改
- Diff
- 用户确认
- 写入文件
- 重启后恢复 Thread / Run 等 App 状态

## Requirement Lifecycle

```text
ANALYSIS → BUSINESS_FLOW → SOLUTION → INTERACTION
→ PROTOTYPE（可选）→ PRODUCT_SPEC → REVIEW → READY
```

Stage 是 Workspace Scanner 根据当前正式 Artifact 的确认状态确定性计算的投影，不以 `state.yaml.lifecycle_stage` 作为当前事实源。每项展示统一状态、当前版本和更新时间；后台型 Requirement 可由已确认 Product Spec 明确将 Interaction / Prototype 标记为 `NOT_APPLICABLE`。

上游出现新版本后，下游显示 `NEEDS_RECHECK`。Requirement Review 绑定依赖路径、版本与 SHA-256；任一依赖内容或版本变化后显示 `STALE`，旧 READY 立即失效。Workbench 与 Requirement 侧栏同时展示等待确认、Open Issue、Blocker 和 Stale 等 Needs Attention。

“继续下一阶段”只为当前派生阶段启动一次对应 Skill，不连续运行多个阶段。自然语言 Delta 始终可直接进入 `requirement-change`，不受当前 Stage 限制。

Desktop 通过 Typed IPC 调用 Workspace Service 创建 Requirement。系统生成唯一的文件系统安全 ID，在当前 Workspace 的 `requirements/` 下原子提交独立目录，并初始化：

```text
state.yaml
overview.md
source/initial-request.txt  # 仅在用户填写原始需求描述时创建
```

`state.yaml` 保存 Requirement ID、名称、创建/更新时间与初始状态 `ACTIVE`；其中的初始 `lifecycle_stage` 仅用于旧 Workspace 兼容，不驱动当前 Stage。原始需求描述只作为 Source Input，不是已确认的 Problem Definition 或 Requirement Analysis。

创建成功后，SQLite 中同步创建默认 Thread“需求分析”并记录当前选择，Desktop 自动进入新 Requirement。初始化或默认 Thread 创建失败时回滚本次目录与数据库写入，不留下半初始化 Requirement。

首次 Requirement Analysis 启动前，用户在默认 Thread 中补充的需求内容只作为本地 Message 持久化，不创建 Turn、Run 或模型调用。补充内容可连续保存；只有用户点击“开始分析当前需求”后，Runtime 才将已有补充作为 Thread Context 启动 LLM 分析。失败或取消的 Run 不改变该边界。

---

# 10. Artifact Tool 写入边界（已实现）

所有 Artifact Tool 只接受当前 Run 的 Requirement identity 与 Requirement-relative path。路径在执行前会：

```text
拒绝绝对路径、~、空片段与 ..
→ resolve / realpath
→ 验证目标仍位于当前 Requirement Root
→ 拒绝符号链接造成的越界
```

V0.1 内容读取支持 Markdown、Text、HTML 与 JSON，单文件上限 5 MB。`workspace_read` 只返回 Requirement 概要、Artifact 元数据、Decision 与 Open Issue，不返回全部文件、Thread 或聊天历史。

已有正式 Artifact 的候选修改由 `artifact_diff` 产生真实结构化 Diff。默认确认流程调用 `artifact_next_version`，依据同目录真实文件和不区分大小写的 `Vn` 计算最大版本的下一版本，不填补历史缺口，也不覆盖已有目标。只有用户明确要求且 Diff 中声明 `overwrite` 时才允许原子替换原文件；写入前还会比较源文件与 Diff 时的 `before`，外部改动会触发 `SOURCE_CHANGED` 并要求重新生成 Diff。

`artifact_write` 使用同目录临时文件：

```text
独占创建临时文件
→ 写入并 fsync
→ 回读校验
→ rename 为目标新版本
```

写入后 `workspace_validate` 重新扫描 Workspace，确认目标可读、源 Artifact 保留、Requirement 基础结构可解析且 Artifact 索引包含新版本。校验失败时 Run 不得标记完成。

---

# 11. Requirement Analysis Artifact

Requirement Analysis 的分析中间态保存在 Run 的结构化 `analysis_result` 中，不把每次问答都写成 Workspace 文件。状态为：

```text
Analyzing
→ ReadyForConfirmation
→ Confirmed
```

`ReadyForConfirmation` 只表示内容通过最低结构检查和语义完整性判断；Run 进入 `WaitingConfirmation`，不等于完成。用户继续补充或拒绝结论时，旧候选终止，新的 Analysis Run 读取已有结构化结果后继续分析。

Requirement Analysis 的结构化中间态现为 Requirement 级 Canonical Mainline。它由固定 Core、按需求类型选择的 Module、字段状态、结构化 Open Issue 与短期 Working Context 组成；Conversation 只负责展示和审计。

Mainline Schema 状态为 `missing → proposed → confirmed`。新需求首次分析先确认 Blueprint；历史需求采用 Migration on Access，优先从现有 Analysis Stage State、最新 Analysis Artifact、下游 Artifact、Source Input 恢复，Conversation 仅作为最后一次性兜底。Bootstrap 始终进入 `proposed`，不会批量迁移或自动确认。

只有产品经理在同一 Thread 明确确认，Runtime 才执行受确认约束的 `requirement_analysis_write`，原子创建或更新：

```text
analysis/requirement-analysis.md
```

写入前比较候选形成时的正式 Artifact 内容哈希，避免覆盖外部变更；写入后必须执行 `workspace_validate`。正式 Artifact 标记为 `confirmed`。确认前的候选不是长期事实源，后续 Skill 默认优先使用已确认 Artifact。

---

# 12. Business Flow Artifact

正式 Business Flow 以配对版本保存在 Workspace：

```text
flows/business-flow-vN.json  # 结构化 Source of Truth
flows/business-flow-vN.html  # 确定性 Rendered Artifact
```

确认前 Flow Model 与 HTML Preview 只保存在 Run 的 `flow_result` 中。只有 `READY_FOR_CONFIRMATION` 且来源 Analysis 已确认的候选可以由产品经理确认；写入时同时校验候选基线、目标版本与两个文件，并保留全部历史版本。

HTML 不能反向成为业务事实源。已有流程 Delta 必须读取最新 JSON Model，产生结构化节点/连线 Diff 和新的配对版本。

---

# 13. Solution Design Artifact

正式 Solution Design 以配对版本保存在 Workspace：

```text
solution/solution-design-vN.json  # 结构化 Source of Truth
solution/solution-design-vN.md    # 确定性 Rendered Artifact
```

确认前 Solution Model 与 Markdown Preview 只保存在 Run 的 `solution_result` 中。只有 Analysis 与 Flow 均已确认、Coverage / Overdesign Gate 通过且状态为 `READY_FOR_CONFIRMATION` 的候选可以确认写入。已有方案 Delta 必须修改最新 JSON Model 的受影响部分，不得直接修改 Rendered Markdown。

---

# 14. Interaction Design Artifact

正式 Interaction Design 以配对版本保存在 Workspace：

```text
interaction/interaction-design-vN.json  # 结构化 Source of Truth
interaction/interaction-design-vN.md    # 确定性 Rendered Artifact
```

确认前 Interaction Model 与 Markdown Preview 只保存在 Run 的 `interaction_result` 中。只有 Analysis、Flow、Solution 均已确认、Ready Gate 通过且状态为 `READY_FOR_CONFIRMATION` 的候选可以确认写入。交互 Delta 必须以最新 JSON Model 定位并修改受影响元素，不得直接修改 Rendered Markdown，也不会自动生成 Prototype。

---

# 15. Prototype Artifact

正式页面原型以递增版本 HTML 保存在 `prototype/<page-name>-vN.html`。

确认前 HTML Candidate、Prototype Metadata、真实 Diff 与 Validation 只保存在 Run。`artifact_next_version` 根据真实文件计算 V1 或下一版本；`prototype_write` 只在用户明确确认后原子创建目标文件，默认不覆盖旧版。

Prototype Metadata 记录 Product Surface、Create / Delta、最新 Interaction 来源、必要 Capability / Flow 关联、Existing Prototype / UI Reference、结构化变更摘要与状态。HTML 是正式可执行 Artifact；聊天与 Run Candidate 不是长期事实源。

---

# 16. Product Spec Artifact

正式 Product Spec 以配对版本保存在 Workspace：

```text
prd/product-spec-vN.json  # 结构化 Source of Truth
prd/prd-vN.md            # 确定性 Rendered Artifact
```

确认前 Model 与 Markdown Candidate 只保存在 Run。正式 Candidate 要求 Analysis、Flow、Solution 已确认；页面型需求还要求 Interaction 已确认，纯后台需求可声明 Interaction / Prototype 为 N/A。Ready Gate 检查 Capability、Rule、State、Field Source、异常结果、Open Issue、Conflict、Traceability 与 Acceptance Criteria；通过只进入等待确认。

已有 PRD Delta 必须基于最新 `prd-vN.md` 与结构化 Model，只修改受影响章节并生成下一版本，不覆盖历史文件。产品经理明确确认后才成对写入，并通过 `workspace_validate` 校验。

---

# 17. Requirement Review Artifact

正式需求评审以配对版本保存在 Workspace：

```text
review/requirement-review-vN.json  # 结构化 Source of Truth
review/requirement-review-vN.md    # 确定性 Rendered Artifact
```

Review 记录结论、Issue、Evidence、Coverage、Recommended Stage，以及本次实际依赖的 Artifact 路径、版本与内容哈希。它不改写 Analysis、Flow、Solution、Interaction、Prototype、PRD、Decision、Open Issue 或 Requirement Stage。

Review 的 `READY` 只表示当前产品方案具备研发评估与开发条件，不表示已开发、已测试或已上线。任一依赖出现新版本或内容哈希变化后，Review 派生状态为 `STALE`，旧结论不可继续作为当前 Ready Gate；修复应由用户选择对应 Skill 做 Delta，随后重新 Review。
