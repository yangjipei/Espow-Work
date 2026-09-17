# AGENTS.md

本文件定义 Codex / AI Coding Agent 在 **ESPow Work｜易思智作** 项目中的长期开发约束。

用户当前任务中的明确要求优先级高于本文件。

---

# 1. 核心原则

```text
Workspace First
Artifact Driven
Skill as Capability
Tool for Execution
Harness for Runtime
Token First
Delta First
Verify Before Write
Human Confirmation
```

额外要求：

- 优先最小读取、最小影响、最小修改。
- 不为简单任务启动复杂分析、Planning 或完整验证流程。
- 不默认扫描整个仓库、全部文档、全部 Workspace 或全部历史。
- 确定性工作优先通过程序 / Tool 完成。
- 用户未要求时，不顺手重构无关代码。

---

# 2. Task Classification

每个开发任务先按复杂度分类，再决定读取范围与验证方式。

## 2.1 Micro Patch

满足以下任一情况，默认视为 Micro Patch：

- CSS 尺寸、间距、颜色、圆角、布局微调
- 静态文案修改
- 图标、按钮、展示顺序等局部 UI 调整
- 用户已明确文件、组件或修改位置
- 单文件局部修改
- 不改变接口、类型、状态、数据结构或业务逻辑

Micro Patch 必须：

1. 只读取完成修改所需的目标文件局部。
2. 不读取 `docs/`。
3. 不读取 `requirements/`。
4. 不读取 Workspace 状态。
5. 不加载 Skill。
6. 不扫描整个仓库。
7. 不输出复杂 Plan。
8. 不执行完整生产构建。
9. 不执行与改动无关的 TypeScript / Rust 检查。
10. 修改后优先只检查 Diff 与局部语法。

除非用户明确要求，否则不得因为“保险”升级为完整验证。

## 2.2 Normal Change

适用于：

- 单模块功能修改
- React / TypeScript 业务逻辑调整
- 少量跨文件修改
- 已知问题修复
- 明确范围内的接口或状态调整

执行方式：

1. 阅读当前任务相关代码。
2. 按需读取直接相关文档。
3. 必要时输出简洁 Plan。
4. 只修改相关文件。
5. 执行与改动匹配的最小验证。

## 2.3 Architecture Change

适用于：

- Runtime / Harness / Provider Adapter
- Workspace / Requirement / Artifact 状态模型
- 数据库 Schema
- Electron Main 与 Rust Runtime 协议
- 新模块、新能力或较大范围重构
- 跨模块架构调整

执行方式：

1. 阅读本文件。
2. 阅读相关代码。
3. 按 Documentation Router 读取对应文档。
4. 必要时读取 Reference。
5. 输出简洁 Plan。
6. 执行修改。
7. 运行必要验证。
8. 仅在确有需要时执行完整 Build。

---

# 3. Token First / Context Budget

每轮只加载完成当前任务所需的最小充分信息。

优先上下文：

```text
当前任务
+
直接相关代码
+
必要状态
+
直接相关文档
+
必要 Skill / Policy
```

不要默认加载：

- 所有 Skills
- 所有历史 Thread
- 整个 Workspace
- 所有 Reference
- 所有历史 Run
- 全部 `docs/`
- 全仓库代码

如果已经知道目标文件或代码位置：

> 直接读取局部并修改，不重新搜索整个项目。

如果当前任务只是上一轮修改的局部延续：

> 优先复用已知目标，不重新进行项目级分析。

---

# 4. Validation Policy

验证必须与改动风险匹配。

| 修改类型 | 默认验证 |
| --- | --- |
| CSS | 查看 Diff / 局部语法，不 Build |
| 静态文案 | 查看 Diff，不 Build |
| HTML 局部调整 | 局部结构检查 |
| React JSX / TSX | 必要时 TypeScript 检查 |
| TypeScript 业务逻辑 | TypeScript 检查 |
| Electron Main | TypeScript 检查，必要时运行相关流程 |
| Rust Runtime | `cargo check` 或相关最小检查 |
| package / build 配置 | Build |
| 数据库 Schema / Migration | 对应 Migration / Schema 检查 |
| 发布前验证 | Full Build |

禁止：

- 为 CSS / 文案修改运行完整生产构建。
- 为单文件 UI 微调运行无关的全项目检查。
- 仅因为“保险”执行高成本验证。

只有以下情况默认允许 Full Build：

- 修改构建配置
- 修改打包 / 发布链路
- 大范围跨模块修改
- 用户明确要求
- 发布前验证

---

# 5. Planning Policy

复杂、模糊、多步骤任务：

> 使用 Planning。

已知、固定、可重复任务：

> 直接执行。

Micro Patch：

> 不创建复杂 Plan。

不要为了“Agentic”让所有任务都经过 Planner。

---

# 6. Source Code 与 Runtime Artifact 边界

本项目中的 Requirement Artifact 修改流程：

```text
Agent 形成候选修改
→ Tool 生成 Diff / Patch
→ 用户查看
→ 用户确认
→ Tool 写入
→ Validator
→ 更新 Run / Workspace 状态
```

该流程仅适用于：

> ESPow Work 产品运行时产生的 Requirement / Artifact。

不适用于 Codex 日常源代码编辑。

Codex 修改：

```text
src/
espow-runtime/
package.json
配置文件
工程代码
```

时，按照本文件的 Task Classification 与 Validation Policy 执行。

---

# 7. Architecture Boundary

当前基础技术方向：

```text
Electron / React / TypeScript
Rust / Tokio
Vite / Zustand
SQLite
TypeScript / Node deterministic Tools
OpenAI-compatible Model Providers
```

保持：

```text
ESPow Desktop UI
↓
Electron Main / ESPow Domain
↓ stdio JSON protocol
ESPow Rust Runtime
↓
Single-Agent Loop / Model Adapter
↕
ESPow Skill / Tool / Context / Memory
↓
Local Workspace
```

详细架构不要在每次任务中重复加载。

涉及架构变更时按需读取：

`docs/architecture.md`

---

# 8. Skill / Tool / Runtime / Workspace

保持边界：

```text
Skill
→ 怎么思考

Tool
→ 怎么执行

ESPow Runtime
→ 怎么编排和执行

Workspace
→ 怎么保存长期状态
```

原则：

- Skill 不是独立 Agent。
- 不为每个 Skill 创建独立 Runtime / Session / Memory。
- 默认一个 Task 使用一个主 Skill + 必要 Tools。
- 同样输入应稳定得到同样结果的事情，优先程序化。
- 不把“临时让模型写 Python”作为正式系统能力。

详细规则：

`docs/runtime.md`

---

# 9. Workspace / Delta

一个需求对应一个 Requirement Workspace。

一个 Workspace 可以有多个 Thread。

已有需求上的增量修改属于：

> Delta

Delta 不得默认重新执行完整产品生命周期。

优先：

> 最小读取、最小影响、最小修改。

涉及 Workspace / Requirement / Thread / Artifact / State 时读取：

`docs/workspace.md`

---

# 10. Documentation Router

仅在任务确实涉及对应领域时读取。

```text
架构 / Harness / Adapter
→ docs/architecture.md

Skill / Tool / Validator / Planning
→ docs/runtime.md

Workspace / Thread / Artifact / State
→ docs/workspace.md

Context Manager / Snapshot / Token First
→ docs/context.md

旧项目迁移 / Legacy Reference
→ docs/legacy-migration.md

编码 / Git / Electron / 日志 / 错误
→ docs/development.md
```

禁止每次任务扫描全部文档。

---

# 11. Desktop UI

核心界面参考：

`references/desktop-v3.html`

仅在涉及整体 Desktop UI 结构或需要视觉参考时读取。

保持产品结构：

```text
左侧
Workspace / Requirement / Thread

中间
Task / Chat / Plan / Run

右侧
Artifacts / Open Issues / Decisions / Context
```

普通 CSS / 文案微调不得因此自动读取该 Reference。

---

# 12. Minimal Code Context

代码修改前优先执行 `npm run context -- "<用户原始任务>"`。

- 先读 `PRIMARY`，不足时再读 `RELATED`；`TESTS` 仅在实现或验证阶段读取。
- UI / Style 小改不得默认扫描 Main、Runtime、Database，也不得默认全仓 `grep` / `find` / `tree`。
- 仅在 `CONTEXT_NOT_FOUND` 时对源码根目录做一次有限 `rg`；确认稳定链路后补充 `.agent/feature-map.json`。
- 依赖、构建产物、缓存、日志、临时数据库和下载产物始终排除。

---

# 13. Security / Git

不得提交：

```text
.DS_Store
__MACOSX
.env
API Key
node_modules
dist
build cache
用户 SQLite
本地模型配置
临时 Run 数据
```

必须保证：

- API Key 不提交 Git。
- API Key 不进入 Requirement Workspace。
- API Key 不进入普通日志。
- UI 默认掩码展示。

Git 提交说明使用中文。

允许 Conventional Commits 前缀，例如：

```text
feat:
fix:
refactor:
```

---

# 14. Final Execution Rule

执行优先级：

```text
用户明确要求
↓
Task Classification
↓
最小上下文读取
↓
最小修改
↓
匹配风险的最小验证
↓
简洁结果
```

最终目标：

> 不让简单任务进入重量级 Agent 流程。

> 不让验证成本大于修改本身。

> 复杂任务保持完整能力，小修改保持最小 Token 消耗。
