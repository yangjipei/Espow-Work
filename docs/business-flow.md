# Business Flow Domain

本文描述 `business-flow @ 0.1.0` 的结构化模型、校验、渲染、确认与版本边界。

## 定位与前置条件

Business Flow 把已确认 Requirement Analysis 中的问题、角色、场景、当前流程、Blocker、Boundary、FACT、DECISION、OPEN_QUESTION 与 Out of Scope 转成业务流程，不重新执行 Requirement Analysis，也不进入 Solution Design。

正式流程要求 `Requirement Analysis = confirmed`。没有已确认分析时，Runtime 返回 `Prerequisite Not Ready`。用户明确要求基于当前分析探索时，可以生成 `DRAFT`，但不能进入正式确认或写入。

## Flow Model

Flow Model 是 Source of Truth，HTML 是确定性 Rendered Artifact。模型至少包含：

```text
Flow
├── id / name / scope / status
├── actors
├── nodes: start | action | decision | system | wait | end
├── edges: main | branch | exception | recovery
├── entry / exits
├── openQuestions / semanticChecks
└── sourceAnalysisPath / sourceAnalysisStatus
```

节点可记录 `stateChange`、`sourceScenarioIds` 与 `sourceDecisionIds`，供后续 Change / Review 判断影响。

## 状态与 Gate

状态区分 `DRAFT / WAITING_CLARIFICATION / READY_FOR_CONFIRMATION / CONFIRMED`。

`business_flow_ready` 确定性检查入口、结束、主流程连通、Decision 完整出口、引用有效性和孤立节点；语义检查显式覆盖主场景、Blocker、关键退出、异步恢复和闭环。存在阻断 Open Question 或 draft Analysis 时不能进入 `READY_FOR_CONFIRMATION`。

Ready 只表示可以展示给产品经理确认。用户修改时旧候选取消，基于同一 Analysis 和已有 Flow 做最小调整；用户明确确认后才写正式 Artifact。

## Artifact 与版本

每个确认版本成对生成：

```text
flows/business-flow-v1.json  # Source of Truth
flows/business-flow-v1.html  # Rendered Artifact
flows/business-flow-v2.json
flows/business-flow-v2.html
```

版本号由 `business_flow_next_version` 根据真实文件计算，不覆盖历史版本。候选形成后若已有 Flow 文件变化，确认写入会以 `SOURCE_CHANGED` 失败并要求重新生成。

HTML 使用浅色专业布局，主流程始终可见；阶段、分支、异常、退出、恢复和追踪信息按需组织，支持全部展开和全部收起。

## Flow Delta

结构化 Diff 记录 Added / Removed / Changed Nodes 和 Edges。Requirement Change 判断流程受影响时，必须读取最新 JSON Model，使用 Business Flow Tool 生成新的 Model/HTML 配对候选，不直接修改 HTML，也不重新生成整套 Requirement Analysis。

## Run 可观察性

Run 保存 Skill/version、输入前置、Context Level、Actor、Flow Scope、Open Questions、Validator、结构化 Diff、候选预览、Artifact 路径、真实 Tool Calls、已读文件和已写文件；不保存模型私有推理过程。
