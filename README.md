# ESPow Work｜易思智作

> 让 AI 从“会思考”走向“能完成工作”。

ESPow Work 是面向专业工作的本地 Agentic Workspace。当前第一阶段聚焦 **产品经理工作场景**，首个产品形态为 **Mac Desktop App**。

ESPow 已拥有自己的 Agent Runtime：Desktop 使用 Electron / React / TypeScript，Agent 执行核心使用独立的 **Rust Runtime**。DeepSeek / OpenAI 只作为可替换 Model Provider，不拥有 Thread、Memory 或产品生命周期。

## 当前架构

```text
React Renderer
      ↓ Typed IPC
Electron Main
      ├─ Workspace / Requirement / Thread
      ├─ Lifecycle / Skill / Context / Memory
      ├─ SQLite Persistence
      └─ Deterministic Tools
             ↕ localhost Tool Bridge
      ↓ stdio JSON protocol
ESPow Rust Runtime
      ├─ Single-Agent Loop
      ├─ Streaming / Cancel
      ├─ Tool Calling
      └─ Model Adapter
             ↓
      OpenAI / DeepSeek
```

核心所有权：

```text
ESPow owns:
Workspace / Requirement / Artifact
Thread / Turn / Run / Event
Context / Memory / Lifecycle / Skills / Tools

Model Provider owns:
Inference only
```

## Product Manager Lifecycle

ESPow 当前采用单 Agent、串行生命周期，不建设 Multi-Agent：

```text
需求分析
→ 业务流程
→ 方案设计
→ 交互设计
→ HTML 原型
→ PRD
→ 需求评审
→ READY
```

Skill 是能力，不是独立 Agent。Lifecycle 由确定性程序控制；确定性工作优先 Tool；语义理解与生成交给模型。

## Context / Memory

ESPow 不把完整历史或整个 Workspace 每轮塞给模型。Context Builder 使用：

```text
Requirement Snapshot
+ Related Decisions / Open Issues
+ Relevant Memory
+ Artifact metadata
+ Thread Summary
+ Recent Messages
+ Active Skill
+ Runtime Policies
+ Current Task
```

Thread 历史超过预算后生成 compact summary；Requirement 正式事实仍以 Workspace Artifact 为 Source of Truth。长期记忆仅按需检索，不默认全量注入。

## Runtime State

SQLite 保存产品与执行状态：

```text
Thread
└─ Turn
   └─ Run
      └─ Event
```

App 重启后，未完成 Run 会确定性标记为中断失败；后续消息使用 ESPow 自己保存的 Thread / Context / Memory 继续，不依赖 Provider Session。

## 开发

需要 Node.js 与 Rust toolchain。

```bash
npm install
npm run runtime:build
npm run dev
```

测试：

```bash
npm run runtime:test
npm test
```

`npm run dev` / `npm run build` 会先构建 `espow-runtime`。

当前不处理 macOS 签名、公证、DMG 或 Universal Binary，这些属于后续 Distribution 阶段。

## 项目结构

```text
ESPow-Work/
├── AGENTS.md
├── README.md
├── electron/              # Electron Main / Preload / Product services
├── espow-runtime/         # Rust Agent Runtime
├── src/                   # React UI + shared contracts
├── skills/                # Built-in Product Manager Skills
├── docs/
└── references/
```

开发 Agent 每次任务先读取 `AGENTS.md`，其他文档按需读取。

> Token First. Workspace First. ESPow owns the Harness.

## Lifecycle Stage State

本版本将 Analysis State 能力提升为全生命周期 Stage State Engine：需求分析、业务流程、方案设计、交互设计、原型、PRD、需求评审分别拥有独立槽位与退出条件，并共享一层 Shared Requirement State。详见 `docs/lifecycle-stage-state.md`。
