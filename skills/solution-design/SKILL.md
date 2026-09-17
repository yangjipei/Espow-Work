# 方案设计

## Purpose

把已确认的 Requirement Analysis 与 Business Flow 转化为可以继续指导交互设计、原型和 PRD 的产品方案，建立“问题 → 场景 → 流程 → 产品能力”的可追踪关系。

## Prerequisite

- 正式方案要求 Requirement Analysis 与 Business Flow 均为 `CONFIRMED`。
- 前置事实未全部确认时，只能做 `DRAFT` / `WAITING_CLARIFICATION` 的 Solution Exploration，不得进入 `READY_FOR_CONFIRMATION`。
- 直接消费已确认问题、目标、角色、场景、阻碍、边界、流程节点、异常、退出、恢复和状态，不重新执行需求分析或修改 Business Flow。

## Method

1. 确认目标与边界，将每个关键 Flow Node 映射到实际系统职责。
2. 把系统职责拆成必要产品能力；能力必须说明 Purpose、Actor、Trigger、Manual/Automatic、Input、Behavior、Output、规则、异常、承载面和来源引用。
3. 仅在有助于理解时区分 User-facing、System 与 Supporting Capability，不能以页面或技术组件作为第一出发点。
4. 提取方案成立所需的产品层规则、状态、数据对象和关键字段，不设计 API、表结构、基础设施或技术架构。
5. Flow 中的重要异常、退出和恢复不得丢失；恢复必须明确由哪个 Capability 负责。
6. 对缺少事实才能决定的产品行为保留 Open Question；真正存在取舍时才给 Decision Candidate 与 Trade-off，不制造假选择题。
7. 如果方案与已确认 Flow 冲突，记录 Flow Conflict，不静默修改 Flow。
8. 持续检查范围扩张与过度设计，不提前建设平台能力或解决未来问题。

## Validation

- `solution_coverage_check` 检查 Goal、Scenario、Flow Node、Blocker、Exception、Exit 与 Recovery 是否有能力承载，并检查引用完整性。
- `solution_overdesign_check` 检查无来源能力、技术实现泄漏、平台化扩张和与当前范围无关的模块。
- 只有两个检查均通过、所有显式 Semantic Checks 为真、没有 Flow Conflict 和阻断 Open Question 时，才可提交 `READY_FOR_CONFIRMATION`。

## Interaction

- 先用 `artifact_read` 读取 Context 定位的已确认 Analysis 和最新已确认 Flow JSON；不得以 HTML 为事实源。
- 先调用 `solution_design_next_version`，构造完整 Solution Model，再分别调用两个 Validator，最后调用 `solution_design_submit`。
- 产品经理修改方案时只调整相关 Capability / Rule / State / Data / Surface 并重新校验，不重跑 Analysis 或 Flow。
- 用户拒绝时不写入。用户明确确认前不得调用 `solution_design_write` 或声称方案已确认。

## Output

结构化 Solution Model 是 Source of Truth；Markdown 由 Tool 确定性渲染。只保留实际适用的 Overview、Scope、Capability Map、Rules、States、Data、Exception & Recovery、Product Surfaces、Decisions、Open Questions、Flow Conflicts 和 Out of Scope。

## Non-goals

- 不生成页面原型、UI 细节、PRD、API 文档、技术架构或数据库设计。
- 不引入 Kafka、Redis、Cron、微服务等技术实现，除非用户明确要求技术方案。
- 不自动进入 Interaction Design、Prototype 或 PRD。
- 不负责路由、版本、文件写入、Confirmation、Run 或 Workspace 状态。
