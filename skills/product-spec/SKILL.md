# 产品需求文档 / PRD

## Purpose

把已经确认的 Requirement Analysis、Business Flow、Solution Design，以及适用时的 Interaction Design 与 Prototype，规格化为研发、测试和产品可以直接使用的 Product Spec。

## Boundary

- PRD 负责收敛，不重新决定 Problem、Flow、Solution、Interaction 或 Prototype。
- 发现上游结论冲突时记录 `Upstream Conflict`；发现 PRD 与 Prototype 表现不一致时记录 `Consistency Issue`，不得静默改写任一方。
- Prototype 只支持页面位置、展示和交互事实。Mock Data 不得成为业务数值、枚举或字段规则。
- Product Contract 的字段、状态、输入输出、数据来源、依赖与错误处理合并在本 Skill，不另建 Skill。

## Prerequisite

- 正式 PRD 要求 Requirement Analysis、Business Flow、Solution Design 均为 `CONFIRMED`。
- 涉及页面交互时还要求 Interaction Design 为 `CONFIRMED`。
- 纯后台、自动任务、接口或无页面需求可声明 `interactionRequired = false`、`sourceInteractionStatus = not-applicable`，Prototype 为 N/A。
- 已有 Confirmed Prototype 时优先作为页面行为参考，但 Prototype 不是强制前置。

## Source Priority

1. 用户明确确认的 Decision / FACT
2. Confirmed Requirement Analysis
3. Confirmed Business Flow
4. Confirmed Solution Design
5. Confirmed Interaction Design
6. Confirmed Prototype
7. Source Material

低优先级来源不得覆盖高优先级事实。

## Method

1. 按章节需要逐步读取已确认上游，不一次性加载全部 Artifact。
2. 保持已确认目标与 In Scope / Out of Scope，按 Capability 组织 FR，而不是按页面重述整套产品。
3. 对重要 Capability 规格化 Purpose、Trigger、Precondition、User Action、System Behavior、Rule、State Change、Success、Failure、Exception、Page 与 Flow 来源。
4. 使用稳定 `BRxx` 标识关键业务规则；Rule 必须可执行，不写“合理处理”。
5. 状态只来自已确认来源，明确含义、进入、退出和后续行为。第三方状态映射可作为正式规则。
6. 字段明确含义、来源、必填、使用位置、格式、默认值、更新时间和空数据行为；不默认写成数据库 Schema。
7. 错误明确条件、系统行为、用户反馈、重试、落状态与后续影响。Retry / Timeout / Callback / Idempotency / Exit / Recovery 仅在适用时加入，未知次数、间隔或上限保留为阻断 Open Issue。
8. 页面规格只描述本需求新增、修改、删除、显示、隐藏、操作与结果。Existing Product Delta 不重述全部旧行为。
9. Acceptance Criteria 必须可判断通过或失败，并关联 Capability 与来源；不写“功能正常、交互流畅”。
10. 已有 PRD 时只修改受影响章节，形成新版本 Candidate，并在 `changedSections` 中记录范围。

## Ready

- 必须先调用 `product_spec_next_version`，再调用 `product_spec_ready` 和 `product_spec_submit`。
- 阻断 Open Issue、任何 Conflict、关键字段无来源、状态无进出条件、异常无结果、关键规则需研发猜测时保持 `WAITING_CLARIFICATION`，`prdReady = false`。
- Validator Pass 只进入 `READY_FOR_CONFIRMATION`。产品经理明确确认后才调用 `product_spec_write`，写入版本化 JSON Source of Truth 与 `prd-vN.md`。

## Non-goals

- 不实现 Requirement Review、Technical Design、Database Design、API Implementation、Test Case Generator 或 Development Agent。
- 不自动进入开发，不重做 Desktop，不生成虚假 UI。
- 不负责路由、Context 选择、版本计算、写入、Confirmation、Run 或 Workspace 状态。
