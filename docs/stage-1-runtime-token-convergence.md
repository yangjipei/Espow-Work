# 阶段一：Runtime 与 Token 收敛改造

> 目标：不改变 ESPow Work 既有产品生命周期和阶段目标，在普通需求讨论中减少无意义模型调用，并为 Provider 输入建立硬边界。

## 本阶段完成

### 1. 普通自由文本不再默认前置 Intent LLM

Turn Router 现在分为：

```text
明确槽位 / 状态查询 / 明确控制命令
→ Script

短且控制语义有歧义
→ Intent Recognition（仅 fallback）

普通自由文本
→ 当前 Stage / Skill 主 Agent
```

因此普通“补充需求、继续分析、讨论方案”的一轮不再天然产生 `Intent Recognition + 主 Agent` 两次模型调用。

### 2. Provider 输入硬预算

LLM Policy 新增 `maxInputTokens`：

- Normalize / 歧义控制：6,000
- L1 Reason / Analysis / Delta：16,000
- L2 Generate / Review：24,000

预算计算同时考虑：

```text
System Prompt
+ Tool Schema
+ Context Parts
+ 协议预留
```

必要上下文：

```text
Current User Input
Mainline
Working Context
Skill
Current Stage State / Runtime Policy
```

必要上下文禁止静默截断。预算不足时优先丢弃：

```text
History
Artifact metadata
其他低优先级 Context
```

每次预算结果写入 `context_budget_applied` Runtime Event。

Rust Runtime 在每次 Provider Call 前再次检查 `maxInputTokens`，包括 Tool Follow-up 后的请求，避免第一轮合规、后续调用重新膨胀。

### 3. Prompt 去重复

删除 Context 中与全局 System Prompt 重复的：

- Product Manager Role 描述
- 默认中文输出规则

原先每个 Stage 在 ContextManager 中的大段重复执行说明收敛为短 `Stage Execution Contract`；专业分析方法继续由 Skill Capsule 负责。

## 不在阶段一修改

本阶段不修改：

- 生命周期 Stage / Gate 语义
- Mainline 数据模型
- Artifact Approval / Write 流程
- Run Cancel / Approval 状态机
- Workspace + Requirement 复合隔离
- Runtime Interrupted / Recovery

这些属于后续阶段，避免一次改造跨越过多边界。

## 验收重点

1. 普通自由文本路由为 `agent`，不会先进入 Intent Recognition。
2. 明确 Script Path 仍保持 0 Token。
3. 短歧义控制语句仍可使用 Intent Recognition fallback。
4. Requirement Analysis 仍使用 Mainline / Working，并保持 `analysis_turn_submit` terminal contract。
5. Provider 输入超过预算时不会静默丢失必要上下文。
6. Rust Runtime 每次模型调用前都执行硬预算检查。
