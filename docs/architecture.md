# ESPow Work Architecture

本文件描述当前 ESPow Work 的长期架构边界。

## 1. 总体架构

```text
ESPow Desktop UI
        ↓
Electron Main / ESPow Domain
        ↓ stdio newline-delimited JSON
ESPow Rust Runtime
        ↓
Single-Agent Loop / Model Adapter
        ↕ localhost Tool Bridge
ESPow Deterministic Tools
        ↓
Local Workspace
```

ESPow 不依赖第三方 Agent Harness。Provider 只负责模型推理。

## 2. 产品层所有权

Electron Main / ESPow Domain 负责：

- Workspace / Requirement
- Thread / Message
- Turn / Run / Event persistence
- Artifact / Decision / Open Issue
- Lifecycle Engine
- Skill Registry
- Context Builder
- Requirement Snapshot
- Thread Summary / Memory Retrieval
- Approval / Confirmation
- Token Usage
- Deterministic Tools

正式 Requirement 事实仍以 Workspace Artifact 为 Source of Truth。

## 3. Rust Runtime

`espow-runtime/` 是 ESPow 自有 Agent Harness，负责：

- Runtime process lifecycle
- `run.start` / `run.cancel`
- OpenAI-compatible model streaming
- Single-Agent Tool Loop
- Tool allowlist enforcement
- Runtime events
- Provider error normalization
- Cancellation / max-step、Call guard
- Follow-up Gate：仅在 Tool 产生新未知信息、冲突或失败时再次推理

Runtime 不拥有 Workspace 业务事实，不直接读取 ESPow SQLite。

## 4. Desktop ↔ Runtime Protocol

Electron 通过 stdio 与 Rust Runtime 通信：

```text
stdin  : JSON request, one object per line
stdout : JSON response/event, one object per line
stderr : runtime log only
```

当前 RPC：

```text
runtime.initialize
runtime.ping
run.start
run.cancel
runtime.shutdown
```

典型事件：

```text
run_started
model_started
message_delta
message_completed
tool_started
tool_completed
model_usage
run_completed
run_cancelled
run_failed
```

Renderer 不直接感知 Rust 协议；`AgentTaskService` 继续消费标准化 `RuntimeEvent`。

## 5. Thread / Turn / Run / Event

```text
Workspace
└─ Requirement
   └─ Thread
      └─ Turn
         └─ Run
            └─ Event
```

- Thread：产品层对话边界。
- Turn：一次用户输入对应的产品交互单元。
- Run：一次 Agent 执行。
- Event：Run 内可诊断事件。

Model Provider 没有 ESPow Session 身份。App / Runtime 重启不会要求恢复 Provider Session。

流式 `message_delta` 只用于 UI，不逐 chunk 持久化；Run / Model / Tool / Usage / 最终消息 / 终态等高价值事件才进入 Event Store。

## 6. Context / Memory

Context Builder 负责每轮选择“模型真正需要看到什么”，而不是重放完整历史。

```text
Current Task
+ Requirement Snapshot
+ relevant Decision / Open Issue
+ relevant Memory
+ Artifact metadata
+ Thread Summary
+ recent messages
+ Active Skill
+ Runtime Policies
```

Workspace 文件正文按需由 Tool 读取。

Requirement Analysis 使用 Mainline 专用路径：

```text
Dynamic Schema + Canonical Mainline + Working Context + Current User Input
```

该路径默认不注入 Conversation History，也不同时注入其通用 Stage Slot 派生投影。模型只输出 Mainline Delta，Runtime 负责 merge、状态、冲突、Open Issue、Working 清理和持久化。

Memory 分层：

- Working Memory：当前 Run 内消息 / Tool 结果，由 Runtime 临时持有。
- Thread Memory：最近消息 + compact summary。
- Requirement Memory：Workspace Snapshot、Artifact、Decision、Open Issue 与需求级显式记忆。
- Long-term Memory：跨需求显式长期记忆，检索后按需注入。

## 7. Lifecycle / Skill / Tool

当前采用 Single-Agent Lifecycle Architecture，不实现 Multi-Agent。

```text
需求分析 → 业务流程 → 方案设计 → 交互设计 → 原型 → PRD → Review → READY
```

- Lifecycle：确定性阶段与前置条件。
- Skill：专业推理方法 + allowed tools。
- Tool：确定性执行。
- Agent：唯一执行者。

不得把 Skill 做成独立 Agent，也不得让模型自由跳过 Lifecycle Gate。

## 8. Tool Bridge

现有 TypeScript Tool 体系继续作为产品层确定性能力。Rust Runtime 只调用 Skill 允许的 Tool，并通过本机 `127.0.0.1` 临时 Tool Bridge 执行。

Bridge 使用随机 bearer token，只绑定当前 active Run；Rust 侧再次根据 `tools` allowlist 拒绝未授权 Tool。

后续如有价值可把 Tool RPC 合并进双向 stdio protocol，但当前不为“纯粹架构美观”重写成熟 Tool Service。

## 9. Model Provider

V0.1 支持 OpenAI / DeepSeek BYOK，均经 Runtime 的 OpenAI-compatible adapter 调用。

Provider 不负责：

- Thread
- Memory
- Lifecycle
- Compaction
- Workspace
- Artifact state

## 10. 非目标

当前不建设：

- Multi-Agent / Subagent
- Vector DB（无明确需要前）
- Redis / Worker Cluster
- Cloud Workspace
- macOS Distribution / Notarization

## 11. Lifecycle Stage State Engine

生命周期工作记忆不再只由 Requirement Analysis 的 Analysis State 承担。

```text
Shared Requirement State
        ↓
Current Stage State (stage-specific slots/readiness)
        ↓
Working Projection
        ↓
LLM / deterministic tools
```

七个正式阶段分别拥有独立 Slot Schema 与 Readiness。`Analysis Mainline` 是 Requirement Analysis 的唯一专业 Canonical State，会确定性投影为通用 `requirement-analysis` Stage State；派生 Stage State 不作为第二份模型记忆注入。

上游阶段更新时，把下游 Stage State 初始化并标记为 `stale`（AFFECTED），不自动重跑生命周期。详见 `docs/lifecycle-stage-state.md`。
