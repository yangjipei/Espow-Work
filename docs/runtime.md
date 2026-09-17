# ESPow Runtime Rules

本文件描述 Skill、Tool、Validator、Planning 和 Runtime Policy。

涉及 Agent 执行逻辑时读取。

---

# 1. Skill

Skill 是：

> 专业工作能力。

负责：

> 告诉模型专业问题应该怎么思考。

Skill 不是独立 Agent。

Skill 不拥有：

- 独立长期 Memory
- 独立 Runtime
- 独立 Session
- 独立 Agent Loop
- 独立 Workspace 写权限

默认：

```text
一个 Task
+
一个主 Skill
+
必要 Tools
```

---

# 2. Skill 三层模型

未来支持：

```text
Workspace Skill
      ↓
User Skill
      ↓
Built-in Skill
```

优先级：

```text
Workspace > User > Built-in
```

Built-in Skill：

- ESPow 官方能力
- 随 App 发布

User Skill：

- 用户个人扩展能力
- V0.1 不要求实现 Skill Market

Workspace Skill：

- 当前项目 / 团队专用能力
- 可承载公司规范、项目规则、专属模板

---

# 3. Skill Contract

旧 Skill 不直接迁移。

新 Skill 应重点保留：

- Purpose
- Analysis Focus
- 专业判断原则
- 必要输入
- 预期输出
- 关键边界
- Non-goals

原则上不由 Skill 管：

- Skill 路由
- 文件路径
- Workspace 写入
- Session / Thread
- Tool 执行
- Gate 执行
- Artifact 版本
- Run 状态

后续可以采用：

```text
skills/
└── requirement-analysis/
    ├── skill.yaml
    └── SKILL.md
```

其中：

```text
skill.yaml
→ 机器可读 Contract

SKILL.md
→ 专业方法
```

---

# 4. Tool

Tool 是：

> Runtime 可以调用的执行能力总称。

Tool 可以由：

- Python Script
- Node / TypeScript Service
- File System API
- Git Command
- Shell Command
- MCP Tool
- Search Tool
- External API

实现。

Agent 不需要关心 Tool 的底层语言。

只关心：

- 能做什么
- 输入是什么
- 输出是什么
- 权限是什么
- 是否执行成功

---

# 5. Tool Contract

所有正式 Tool 至少应明确：

```text
id
name
description
input
output
permission
error
```

涉及写文件、Shell、删除、覆盖等动作时，应明确 Approval 要求。

Tool 失败不得伪造成功。

---

# 6. 确定性工作

确定性工作优先程序化。

例如：

- Workspace 初始化
- Schema 校验
- Artifact 索引
- 文件定位
- 版本号递增
- Diff / Patch
- 状态计算
- 格式 / 结构校验
- 数据转换
- 文件生成
- Grounding 机械校验
- Traceability 机械校验
- 确定性依赖检查

不得把“让模型临时写脚本”当作正式 Runtime 能力。

---

# 7. Validator / Gate

Validator / Gate 是：

> Tool 的校验角色。

例如：

```text
validate_workspace
validate_prd
check_grounding
check_traceability
```

它们本身可以是普通 Tool。

当用于判断结果是否允许继续时，承担 Gate 角色。

例如：

```text
Analysis Ready
Flow Ready
PRD Ready
Development Ready
```

能程序化的校验优先 Tool。

需要语义判断的评审可以使用模型。

---

# 8. Model 与 Tool 边界

模型适合：

- 理解需求
- 语义分析
- 场景发现
- 问题定义
- 方案推理
- 语义影响分析
- 内容组织
- PRD 撰写
- 语义评审
- 选择 Skill
- 选择 Tool

Tool 适合：

- 确定性计算
- 文件读写
- 格式转换
- 索引维护
- 版本计算
- Schema 校验
- 规则校验
- Diff
- 状态更新
- 确定性依赖检查

例如影响分析：

```text
模型
→ 判断业务变化可能影响哪些场景

Tool
→ 检查哪些 Artifact / 引用 / 版本实际关联
```

---

# 9. Planning

复杂 / 模糊 / 多步骤任务：

> Planning。

已知 / 固定 / 可重复任务：

> Deterministic Workflow。

不要所有任务都机械生成 Plan。

---

# 10. Runtime Policy

Runtime Policy 包括：

- Context 策略
- Skill 选择策略
- Tool 权限
- Approval
- Interaction
- Start / Delta 判断
- Planning 使用策略
- Run 生命周期
- Workspace 写入约束
- Artifact 修改约束
- 高风险动作约束

这些规则不应散落到每个 Skill Prompt 中。

模型执行额外遵循全局 `Script-First，LLM-On-Demand` Gate：确定性 Action 的模型预算固定为 0；语义 Action 必须记录调用原因、最小上下文来源与 Call Budget。完整审计和边界见 `docs/script-llm-execution-boundary.md`。

---

# 11. Token First

默认上下文：

```text
当前任务
+
Requirement 核心状态
+
直接相关 Artifact
+
一个主 Skill
+
必要 Runtime Policy
```

---

# 12. 已实现 Skill：Requirement Change

V0.1 已接入首个内置专业 Skill：

```text
requirement-change @ 0.1.0
中文名：需求变更
mode: delta
```

Runtime 在已有 Requirement 中遇到修改、新增、删除、补充、替换或同步类任务时，选择该 Skill。普通 Artifact 问答不强制进入 Skill。

执行顺序是：

```text
选择 Skill
→ workspace_read
→ 按需 artifact_find / artifact_read
→ 语义影响判断
→ change_result_submit
→ 必要时 artifact_diff
→ WaitingConfirmation
→ 用户确认后写入与校验
```

`change_result_submit` 只校验并记录结构化语义结果，不修改 Workspace。候选内容仍由 `artifact_diff` 生成，写入仍受 Approval 约束。

模糊变更会直接产生 `ClarificationRequired` Change Result，不读取无关 Artifact，也不调用模型推测缺失事实。

完整 Contract 见 `skills/requirement-change/skill.yaml`，专业方法见 `skills/requirement-change/SKILL.md`。

不要默认加载全部 Workspace 或全部聊天历史。

---

# 13. 已实现 Skill：Requirement Analysis

V0.1 第二个内置专业 Skill：

```text
requirement-analysis @ 0.4.0
中文名：需求分析
mode: start / analysis
```

Router 在新需求、问题定义模糊、场景/主流程/阻碍不清楚或显式重新梳理需求时选择它；已有 Requirement 上的明确 Delta 继续选择 `requirement-change`，不重跑需求分析。

首次进入先定义 Dynamic Mainline Schema：

```text
识别 Requirement Type
→ 选择固定 Core + 必要标准 Module
→ 生成 proposed Blueprint
→ 用户整体确认
→ confirmed 后进入常规分析
```

专业分析围绕真实场景展开：

```text
发现并定义问题
→ 识别角色与场景
→ 还原当前主流程
→ 识别 Blocker 与 Root Cause
→ 补充必要边界
→ 区分 FACT / ASSUMPTION / DECISION / OPEN_QUESTION
→ 与产品经理收敛
```

Mainline 是 Requirement 级唯一当前事实模型，不保存旧值变化历史。Requirement-specific 数据写入 `/modules/<module-name>`，每个字段标记 confirmed / inferred / open；Working Context 只保存当前话题、问题和选项。

每次分析必须且只能调用一次 terminal tool `analysis_turn_submit`，只提交 `schemaDelta`、Mainline patches、问题变化和 `workingDelta`。Runtime 确定性执行 merge、ID、冲突、Readiness、Working 清理与持久化。信息不足时状态保持 `Analyzing` 并提出会影响结论的少量问题；完整时进入：

```text
ReadyForConfirmation
Run = WaitingConfirmation
```

Ready 不等于完成。只有产品经理在同一 Thread 明确确认后，Runtime 才执行确定性链路：

```text
requirement_analysis_write
→ workspace_validate
→ analysis_status = Confirmed
→ Run = Completed
```

用户补充新场景或拒绝结论时，旧候选终止并重新进入 Analysis。正式 Artifact 为 `analysis/requirement-analysis.md`；确认前不落盘，候选形成后如正式文件被外部修改则拒绝陈旧写入。

Requirement Analysis 完成后不得自动触发 Business Flow、Solution Design、Prototype、PRD 或 Review。

历史 Requirement 使用 Migration on Access。Mainline 缺失不是错误；仅在用户继续 Requirement Analysis 时，按 Analysis Stage State、最新 Analysis Artifact、下游 Artifact、Source Input、Conversation 的顺序恢复当前态，结果固定为 proposed。Conversation 只允许作为最后一次性兜底；调用标记为 `mainline_bootstrap`，不会批量迁移，也不会增加额外模型调用。

---

# 14. Context Manager（已实现）

Runtime 在每次 Task 开始前通过 ESPow Context Manager 生成统一 `ContextPackage`，再由 Runtime 层转换为 Harness 输入。默认 L1；简单状态问答降为 L0；跨 Artifact 一致性与整体评审升为 L2。

Context Manager 只装配最小充分的 Requirement Snapshot、相关 Decision / Open Issue、直接相关 Artifact 元数据、一个主 Skill、必要 Policy 与受限 Thread History。Artifact 正文仍由 Agent 执行期先 `artifact_find`、再按需 `artifact_read`；Markdown 支持按章节读取。

Requirement Change 现在接收基础 L1 Context，不再要求先全量 `workspace_read`。它仍可在执行过程中按需补充读取，并继续通过 `change_result_submit`、`artifact_diff` 与 Approval 链路完成 Delta。

Run 只记录 Context Level、来源、实际读取 Artifact、Decision、Open Issue、Skill 和 Policy 元数据，不保存完整 Prompt。完整规则见 `docs/context.md`。

---

# 15. V0.1 ESPow Tools（已实现）

Runtime 当前注册以下 36 个 ESPow Tool：

```text
workspace_read          read
artifact_find           read
artifact_read           read
change_result_submit    read / structured result
requirement_analysis_ready   read / validator
requirement_analysis_submit  read
requirement_analysis_write   write + confirmation
business_flow_next_version   read / version resolver
business_flow_ready          read / validator
business_flow_submit         read / structured result + renderer
business_flow_write          write + confirmation
solution_design_next_version read / version resolver
solution_coverage_check      read / validator
solution_overdesign_check    read / validator
solution_design_submit       read / structured result + renderer
solution_design_write        write + confirmation
interaction_design_next_version read / version resolver
interaction_design_ready        read / validator
interaction_design_submit       read / structured result + renderer
interaction_design_write        write + confirmation
prototype_ready                 read / validator
prototype_submit                read / candidate + diff
prototype_write                 write + confirmation
product_spec_next_version       read / version resolver
product_spec_ready              read / validator
product_spec_submit             read / structured result + renderer
product_spec_write              write + confirmation
requirement_review_next_version read / dependency + version resolver
requirement_review_ready        read / validator
requirement_review_submit       read / structured result + renderer
requirement_review_status       read / stale validator
requirement_review_write        write + confirmation
artifact_next_version   read
artifact_diff           read
artifact_write          write + approval
workspace_validate      read / validator
```

统一 Contract 包含 `id`、`name`、`description`、输入/输出 Schema、权限、风险等级、是否需要 Approval 与错误码。Contract 属于 ESPow Domain；Harness Adapter 只把名称、说明和输入 Schema 转换为模型可见 Tool。

Harness 子进程通过仅监听 `127.0.0.1`、带随机进程令牌的 Tool Bridge 调用 Electron Main 中的 ESPow Tool Service。本地绝对路径、SQLite、IPC 与密钥均不进入模型上下文。Harness 自带 Shell、通用文件、Web、Skill、Subagent 和 Workflow Tool 仍保持禁用。

Tool Call 的名称、起止时间、状态与错误会持久化到 Run，Desktop 只展示真实调用记录。

---

# 16. Write Approval（已实现）

```text
artifact_diff
→ 持久化候选内容、真实 Diff 与 Approval Request
→ Harness 当前轮结束
→ Run = WaitingConfirmation
→ Desktop 显示 Diff
```

用户取消时，Approval 标记为 `Denied`，Run 进入 `Cancelled`，`artifact_write` 不执行。

用户确认时，Approval 标记为 `Approved`，Runtime 使用同一 Tool Service 顺序执行：

```text
artifact_next_version
→ artifact_write
→ workspace_validate
```

`artifact_write` 在没有与当前 Run、Requirement 匹配的已授权 Approval 时只返回 `approval-required`，不会写文件。官方 TypeScript SDK 当前不支持运行中 server→client 请求，因此 V0.1 在 Harness 当前轮结束后由 ESPow Runtime 恢复确定性写入链路；这不是 UI-only 确认，也不允许模型绕过 Approval。

---

# 17. 已实现 Skill：Business Flow

```text
business-flow @ 0.1.0
中文名：业务流程
mode: flow
```

Runtime 只在显式业务流程任务或待确认流程的局部调整中选择它。正式流程要求已确认 Requirement Analysis；不满足时确定性返回 `Prerequisite Not Ready`，明确 draft 探索除外。

执行链路：

```text
读取 Confirmed Requirement Analysis
→ business_flow_next_version
→ 构造 Flow Model
→ business_flow_ready
→ business_flow_submit + HTML Preview
→ WaitingConfirmation
→ business_flow_write
→ workspace_validate（Model + HTML）
→ CONFIRMED
```

Flow Model 与 Renderer、状态、Diff 和版本规则见 `docs/business-flow.md`。确认后不会自动进入 Solution、Prototype 或 PRD。

---

# 18. 已实现 Skill：Solution Design

```text
solution-design @ 0.1.0
中文名：方案设计
mode: solution
```

Runtime 只在明确的产品方案设计任务或待确认 Solution 的局部调整中选择它。正式方案要求已确认 Requirement Analysis 与最新已确认 Business Flow；前置不满足时只允许用户明确要求的 Draft Solution Exploration。

执行链路：

```text
读取 Confirmed Analysis + latest confirmed Flow JSON
→ solution_design_next_version
→ 构造 Capability Model
→ solution_coverage_check
→ solution_overdesign_check
→ solution_design_submit + Markdown Preview
→ WaitingConfirmation
→ solution_design_write
→ workspace_validate（Model + Markdown）
→ CONFIRMED
```

完整 Contract 见 `docs/solution-design.md`。确认后不会自动进入 Interaction Design、Prototype 或 PRD。

---

# 19. 已实现 Skill：Interaction Design

```text
interaction-design @ 0.1.0
中文名：交互设计
mode: interaction
```

正式交互要求已确认 Analysis、Flow 与 Solution；Solution 未确认时只允许显式 Draft Exploration。Runtime 读取三个上游结构化事实和必要 Existing UI Reference，生成 Interaction Model，经 `interaction_design_ready` 后等待产品经理确认，再成对写入版本化 JSON / Markdown。确认后不会自动生成 Prototype、HTML、React 或图片。完整规则见 `docs/interaction-design.md`。

---

# 20. 已实现 Skill：Prototype

```text
prototype @ 0.1.0
中文名：页面原型
mode: prototype
```

正式 Prototype 要求最新 Interaction Design 已确认；未确认时只允许 Draft Exploration。Runtime 默认使用 L1，先判断 Existing Prototype，按需读取 Interaction、必要 Solution 与 UI Reference，通过 `artifact_next_version` 计算真实目标版本，再生成自包含 HTML Candidate。

执行链路：

```text
artifact_find / artifact_read
→ artifact_next_version
→ prototype_ready
→ prototype_submit + HTML Preview + Diff
→ WaitingConfirmation
→ prototype_write
→ workspace_validate
→ CONFIRMED
```

Validator 检查 HTML 结构、关键 DOM、交互绑定、远程核心依赖、JS 语法、版本与来源，并结合显式语义检查给出 Ready / Issues。用户反馈作为最小 Prototype Delta；改变已确认交互时返回 Interaction Conflict。确认后不会自动进入 PRD。完整规则见 `docs/prototype.md`。

---

# 21. 已实现 Skill：Product Spec

```text
product-spec @ 0.1.0
中文名：产品需求文档 / PRD
mode: product-spec
```

正式 Product Spec 要求已确认 Analysis、Flow、Solution；页面型 Requirement 还要求已确认 Interaction，Prototype 可选。Runtime 默认使用 L2，但只装配上游元数据并由 Agent 按章节逐步读取正文。

执行链路：

```text
product_spec_next_version
→ product_spec_ready
→ product_spec_submit + Markdown Preview
→ WaitingConfirmation
→ product_spec_write
→ workspace_validate（Model + Markdown）
→ CONFIRMED
```

Validator 检查 Capability、稳定 Rule ID、状态进出、字段来源、异常结果、Open Issue、Upstream / Prototype Conflict、Traceability、Acceptance Criteria 与 Delta 基线。阻断未知或冲突不会被自动填补；Ready 不等于 Confirmed。完整规则见 `docs/product-spec.md`。

---

# 22. 已实现 Skill：Requirement Review

```text
requirement-review @ 0.1.0
中文名：需求评审
mode: review
```

正式 Review 以已确认 Product Spec 为最低前置，使用 L2 最小充分 Context，从实现准备度、测试可判定性与业务闭环检查当前有效 Analysis、Flow、Solution、适用的 Interaction / Prototype、PRD、Decision 与 Open Issue。语义问题由 Skill 判断；依赖、Schema、严重度结论、版本与新鲜度由 Tool 确定性校验。

Review 不自动修改 Artifact 或回退 Requirement Stage。结果使用 `READY / READY_WITH_WARNINGS / NOT_READY`，每个 Issue 使用 `BLOCKER / WARNING / INFO` 并携带 Evidence 与 Recommended Stage。正式 Review 写入版本化 JSON / Markdown；依赖哈希或版本变化后状态为 `STALE`。完整规则见 `docs/requirement-review.md`。

---

# 23. Runtime Resolution Pipeline

每个 User Turn 先经过确定性路由；能够直接执行的查询、槽位更新、确认与持久化不进入模型。需要语义判断时使用以下链路：

```text
Turn Router
→ Context Resolver (Core / Slice / Extended / Full)
→ Skill Resolver (Capsule，必要时 Full)
→ Tool Resolver (动态能力，无法可靠判断时回退 Stage Tool Set)
→ LLM Reasoner
→ Runtime Executor
→ Follow-up Gate
```

Tool 成功不等于需要再次调用模型。文件读取、搜索、冲突和校验结果等新信息允许 Follow-up；结构化提交、写入、状态更新和持久化由 Runtime 直接完成。Follow-up 必须记录 `NO_FOLLOWUP / NEW_INFORMATION / CONFLICT_FOUND / EXECUTION_FAILED / REPLAN_REQUIRED / MISSING_CONTEXT` Reason Code。

Skill 默认注入 Runtime Capsule，只保留 Role、Stage Goal、Decision Rules、Exit Criteria、Allowed Actions 与 Critical Constraints。完整 Skill 保留为冲突、未知场景、阶段切换或明确完整分析时的回退来源。
