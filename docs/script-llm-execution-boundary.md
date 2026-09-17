# Script / LLM 全局执行边界

ESPow Work 采用：

```text
Script-First，LLM-On-Demand
```

Runtime 控制 LLM。任何进入 Model Gateway 的执行必须先经过 `shouldUseLLM`，并携带 `caller`、`action`、`stage`、`slot`、`reason`、`contextSources`、`maxCalls` 与 `contextBudget`。

## 真实模型入口审计

| 入口 | 调用链 | 分类 | 调整 |
| --- | --- | --- | --- |
| Thread 用户消息 | Renderer → IPC → `AgentTaskService.startChat` → `RuntimeService.run` → stdio `run.start` → Rust `run_agent` → `stream_step` → `/chat/completions` | 允许 LLM，但必须先 Gate | 已在 Context 构建和 Runtime 启动前 Gate；Rust 再执行 Call Budget 硬限制 |
| 首次分析前补充需求 | Renderer → Typed IPC → `PersistenceService.appendUserMessage` | 必须 Script | 只保存本地 Message 并更新 Thread 时间，不创建 Turn / Run；用户点击“开始分析当前需求”后才进入模型链路 |
| 设置页连接测试 | Renderer → IPC → `ModelService.testConnection` → `ModelProvider.streamChat` → `/chat/completions` | 显式 Provider 诊断 | 已先 Gate，固定最多 1 Call、最小提示 |
| 明确槽位输入 | 原路径会进入上述 Thread 模型链路 | 错误调用 LLM | 已改为 `parse → validate → analysis_turn_submit → readiness/conflict/stale/projection → persist`，0 Call |
| 明确状态/阶段/目标查询 | 原路径会由模型组织答案 | 错误调用 LLM | 已由确定性消息路由直接读取 Requirement Projection，0 Call |
| Artifact 确认/拒绝 | `AgentTaskService` → 确定性 Tool / Persistence | 必须 Script | 保持不进入 Runtime / Model Gateway |
| Lifecycle 前置门禁 | `LifecycleEngine` → 确定性回复 | 必须 Script | 保持 0 Call，且不再要求模型配置 |
| Requirement 创建、打开、重命名、删除 | Typed IPC → Requirement / Workspace Service | 必须 Script | 现状已是 0 Call |

仓库中只有两个最终 Provider HTTP 出口：`electron/modelProvider.ts`（连接测试）和 `espow-runtime/src/model/mod.rs`（正式 Agent Run）。业务执行不存在第三个绕行入口。

## 边界表

| Script / Runtime（0 Token） | LLM（按需） |
| --- | --- |
| Workspace / Requirement CRUD、恢复、路径与文件操作 | 模糊自然语言理解 |
| Lifecycle 初始化、切换、状态与顺序 | 需求语义分析、遗漏与冲突发现 |
| 明确槽位读写、版本、dirty / affected / stale | 无法由规则判断的影响决策 |
| Completeness / Readiness / Open Issue 关闭 | 方案与复杂 Artifact 生成 |
| Projection、Schema、Diff、Token 与 Trace | Requirement Review |
| UI 初始化、页面与 Tab 切换、固定文案 | 用户明确要求的语义评审 |

## 通用 Slot Router

`src/slotRegistry.ts` 是七个生命周期 Stage 的统一槽位定义，包含 `stageId / slotId / aliases / editable / required / dependencies / executionPolicy`。对话标题输入和 UI 明确槽位编辑共用 `electron/runtime/slotRouter.ts`；路由结果记录 `stage / slot / action / executionMode / reason / source`。

明确编辑区直接传递 `stageId + slotId`，显式标题仅在 Registry 唯一命中时直写。两者均为 `SCRIPT`、0 Call；无法唯一命中的自然语言才进入 LLM Gate。槽位更新确定性重算 Readiness、关闭同 topic 问题、更新 Projection 所依赖的 Stage State，并把下游标为 `stale`（即 AFFECTED），不自动生成下游内容。

## Call Budget

- 确定性动作、明确槽位更新：`maxCalls = 0`。
- 模糊输入理解、Requirement Analysis 单轮：`maxCalls = 1`。
- 多 Tool 的 Delta 影响判断、阶段 Artifact 生成与 Review：`maxCalls = 4`；增加预算的原因由 Gate 固定记录。
- Rust Harness 在每次 `stream_step` 前检查 `maxModelCalls`。达到预算仍未结束时以 `model-call-budget-exceeded` 失败关闭，不能静默追加调用。

## 动态 Context 与输入监控

执行策略集中定义 `maxCalls / maxInputTokens / maxOutputTokens / contextLevel`。Context Resolver 按 `Core → Slice → Extended → Full` 装配必要信息；最终 Provider Request 再执行统一硬输入预算。当前用户输入、Mainline / Working、Skill 与当前 Stage State 不静默截断；超预算先移除低优先级 History / Artifact metadata，必要上下文本身仍超限时明确返回 `CONTEXT_BUDGET_EXCEEDED`。Rust Runtime 在每次模型调用前再次校验输入上限，防止 Tool Follow-up 令请求重新膨胀。

Rust Runtime 在 Tool 完成后读取 Follow-up Gate 决策。只有 `NEW_INFORMATION / CONFLICT_FOUND / EXECUTION_FAILED / REPLAN_REQUIRED / MISSING_CONTEXT` 才允许继续推理；确定性提交、写入和状态更新以 `NO_FOLLOWUP` 直接结束。

## 明确槽位路由

当前确定性支持 Registry 中七个阶段的全部槽位及别名。只有完整的 `标签：内容` 输入才命中；未知标签、歧义标签、空内容和模糊描述不会误写槽位，转入一次语义理解或相应 Skill。

槽位更新只修改 Analysis State，经现有 Script 计算完整度、冲突、Working Projection 和下游 stale；不会自动重跑后续阶段，也不会自动写正式 Artifact。

## 诊断

每个正式模型 Run 在 Event Store 记录 `model_gate_evaluated`。每次模型 Token 记录以 Gate `reason` 作为执行原因，并保留 Step、Context/Tool/History 字符规模、输入输出 Token。Script 继续记录 `script_started` / `script_completed`、耗时及 `tokenCost = 0`。
