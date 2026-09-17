# 业务流程

## Purpose

把已经确认的问题、角色、场景、阻碍和业务边界，转化为清晰、可验证、可继续用于方案与 PRD 的业务流程。

## Prerequisite

- 正式流程默认只基于 `status = confirmed` 的 Requirement Analysis。
- 未确认时不得假装业务事实完整，也不得提交 `READY_FOR_CONFIRMATION`。
- 用户明确要求基于 draft 探索时，只能生成 `DRAFT`，并明确它不能作为正式流程结论。

## Method

1. 先定义本次流程的目标与边界，不扩张为完整业务生命周期。
2. 复用 Analysis 中已确认的 Problem、Actors、Scenario、Current Flow、Blocker、Boundary、FACT、DECISION、OPEN_QUESTION 与 Out of Scope，不重新做需求分析。
3. 先构造从入口到结束的主流程，再补真正改变业务处理的判断、分支、异常、提前退出和恢复/回流。
4. 判断节点必须表达明确业务条件，并覆盖所有合理出口；不得使用“是否正常”“是否继续”这类空判断。
5. 异步链路必须检查结果回流、缺失补偿与最终闭环；未知的次数、上限或失败口径必须保留为 Open Question。
6. 只保留会影响产品行为和业务路径的关键状态，不把流程写成 API 或基础设施调用图。
7. 节点通过 `sourceScenarioIds` / `sourceDecisionIds` 追踪来源；不得凭空创建业务角色或规则。

## Flow Model

结构化结果必须包含：Flow identity、name、scope、status、actors、nodes、edges、entry、exits、openQuestions、semanticChecks 与 Analysis 来源。

节点类型只使用：`start`、`action`、`decision`、`system`、`wait`、`end`。边类型只使用：`main`、`branch`、`exception`、`recovery`。

## Interaction

- 关键路径事实不足时，提出直接关联具体节点和业务结果的少量问题，并提交 `WAITING_CLARIFICATION`。
- 信息足够时先调用 `business_flow_ready`，通过后调用 `business_flow_submit` 并进入 `READY_FOR_CONFIRMATION`。
- 用户调整流程时只更新相关节点/边并重新校验，不重跑 Requirement Analysis。
- 用户明确确认前不得调用 `business_flow_write`，不得声称流程已确认。

## Output

Runtime 以 Flow Model 为 Source of Truth，并由确定性 Renderer 生成浅色专业 HTML。主流程常显，阶段按真实流程组织，异常、退出、规则与追踪信息可折叠，并提供全部展开/收起。

## Non-goals

- 不重新执行 Requirement Analysis。
- 不进入 Solution Design、Interaction Design、Prototype、PRD 或 Review。
- 不设计 Kafka、锁、定时任务等技术实现。
- 不展开所有 API Error Code。
- 不负责路由、版本号、文件写入、Confirmation、Run 或 Workspace 状态。
