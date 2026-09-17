# ESPow Development Rules

本文件描述 Electron、代码、Git、日志、错误和安全规则。

涉及工程实现时读取。

---

# 1. Electron 边界

Renderer 不直接暴露完整：

- Node API
- File System
- Shell
- Process
- Secret Config

采用：

```text
React Renderer
      ↓
Preload
      ↓
Typed IPC
      ↓
Electron Main / Local Services
```

Preload 只暴露必要能力。

---

# 2. 编码原则

优先：

- 简单
- 可读
- 可运行
- 可测试
- 边界清晰

避免：

- 过早抽象
- 过度设计
- 巨型 Service
- 巨型 Prompt
- 隐式魔法
- 不必要依赖
- 为未来假设提前实现大量空代码

---

# 3. TypeScript

默认严格 TypeScript。

避免随意使用：

```ts
any
```

核心类型建议包括：

- Requirement
- Workspace
- Thread
- Message
- Run
- Artifact
- Skill
- Tool
- Decision
- OpenIssue
- ModelConfig

---

# 4. Model Config

V0.1：

- OpenAI
- DeepSeek
- BYOK
- 普通本地配置
- 不要求 Keychain

必须：

- Key 不进 Git
- Key 不进 Workspace
- Key 不进普通日志
- UI 掩码展示

---

# 5. 错误处理

不要静默吞错。

模型调用失败：

> 显示明确错误。

Workspace 文件缺失：

> 指出缺失文件。

Artifact 写入失败：

> 不得标记 Completed。

Tool 执行失败：

> 不得伪造成功。

Validator 未通过：

> 不得自动标记最终完成。

---

# 6. 日志

禁止输出：

- API Key
- Secret
- Authorization Header
- 完整敏感配置

日志尽量结构化。

错误应关联：

- Run ID
- Thread ID
- Requirement ID

---

# 7. 数据保护

写操作前确认：

- 位于允许 Workspace
- 不修改系统目录
- 不跨 Workspace
- 不执行无关批量修改
- 不静默删除用户文件

删除、覆盖、高风险 Shell 必要时进入 Approval。

---

# 8. Git

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

提交说明使用中文。

允许：

```text
feat: 实现 Workspace 扫描
fix: 修复 Requirement 状态读取
refactor: 抽离 Runtime Adapter
docs: 补充 Runtime 架构说明
```

---

# 9. 开发执行

中大型任务：

1. 先读 `AGENTS.md`
2. 按需读对应 docs
3. 输出简洁 Plan
4. 直接实现
5. 实际运行验证

根据项目实际执行：

```text
npm install
npm run dev
npm run typecheck
npm run test
npm run build
```

Tool 根据实际实现执行对应测试。

---

# 10. 稳定资产

以下内容若当前任务只是参考，不要顺手重构：

- 已确认 HTML 原型
- Legacy Skills
- Legacy Rules
- Legacy Scripts
- Workspace Template
- Requirement Artifact

Legacy Reference 原则上只读。
