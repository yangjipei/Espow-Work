# ESPow Context & Memory

## 1. 原则

模型上下文不是 Workspace 全量镜像，也不是完整聊天历史重放。

ESPow Context Manager 每轮只构造最小充分 Context：

```text
Requirement Snapshot
+ related Decisions / Open Issues
+ relevant Memory
+ selected Artifact metadata
+ Thread Summary
+ recent messages
+ one active Skill
+ Runtime Policies
+ current task
```

Artifact 正文默认不预载，由 Agent 通过 ESPow Tool 按需读取。

## 2. Thread Memory

ESPow 自己管理多轮上下文，不依赖 Provider Session。

当前策略：

- 最近最多 8 条 Message
- 最近消息合计约 6000 字符
- 更老消息压缩成 Thread Summary
- Summary 约 4000 字符上限
- 完整 Message 历史仍保存在 SQLite，不等于每轮模型 Context

App 重启后直接从 SQLite 重建上述 Context，不需要 resume 外部 Session。

Requirement Analysis 是例外：正常 Turn 的 `Thread Summary` 与 `recent messages` 均不进入模型上下文，History 固定为 0。该阶段使用：

```text
System Core + Skill + Analysis Mainline + Working Context + Current User Input + 必要 Artifact/Reference
```

仅在历史 Requirement 首次访问且没有更高优先级结构化来源时，Conversation 才可作为一次性 Bootstrap 输入；Mainline 进入 `proposed` 后立即退出默认上下文。

## 3. Requirement Memory

Requirement 的长期事实优先来自：

- Requirement Snapshot
- 正式 Artifact
- Confirmed Decision
- Active Open Issue
- 当前 Lifecycle State

这些信息属于 Workspace / ESPow，不属于模型。

## 4. Long-term Memory

`memory_items` 支持：

- `thread`
- `requirement`
- `global`

只有与当前 task 相关的少量 Memory 被检索进 Context。中文查询额外生成 2/3 字 n-gram，避免整句中文导致检索失效。

当前支持显式记忆指令：

```text
记住：...
长期记忆：...
需求记忆：...
本需求记住：...
线程记忆：...
```

V0.1 先使用 SQLite 结构化检索；没有明确收益前不引入 Vector DB。

## 5. Context Mode / Level

保留 L0 / L1 / L2 作为 Context 强度：

- L0：Snapshot 即可回答。
- L1：少量相关 Artifact metadata / History / Memory。
- L2：复杂阶段任务，加载更多相关元数据与结构化候选，但仍受限。

Context Level 决定“选择多少”，不代表读取整个 Workspace。

Runtime 同时记录 `core / slice / extended / full` Context Mode。默认从 Core 或相关 Slice 开始；语义范围更广时进入 Extended，明确需要完整上下文或 Resolver 判断信息不足时才进入 Full。

在最终 Provider Request 前执行统一硬输入预算：System Prompt 与动态 Tool Schema 先占用固定预算；当前用户输入、Mainline / Working、Skill 与当前 Stage State 属于必要上下文，禁止静默截断；预算不足时优先丢弃低优先级 History、Artifact metadata 与其他可恢复上下文。Runtime 继续记录实际 Token 与来源分解。

```text
Core → Relevant Slice → Extended Slice → Full Context
```

## 6. Source of Truth

优先级：

```text
Formal Workspace Artifact / confirmed state
> Requirement Snapshot
> Explicit Requirement / Global Memory
> Thread Summary
> Recent chat
```

Thread Summary 只用于连续性，不得覆盖正式业务事实。

## 7. Lifecycle Stage Projection

生命周期阶段优先注入：

```text
Shared Requirement State Projection
+ Current Stage Working Projection
+ Upstream Stage Summaries
```

每个阶段只携带自己的 Slot / Readiness 工作状态。上游完整 Artifact 正文仍按需读取，不作为每轮默认工作记忆。

Requirement Analysis 的通用 Stage State 是 UI / 生命周期派生投影，不与 Analysis Mainline 同时注入，避免同一事实重复表达。
