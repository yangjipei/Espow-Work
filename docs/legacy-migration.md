# Legacy Product Manager Assistant Migration

本文件用于分析旧 Product Manager Assistant。

旧项目是 Reference Implementation，不是新 Runtime 目标架构。

---

# 1. 核心原则

不得直接：

```text
旧 Skill     → 新 Skill
旧 Script    → 新 Tool
旧 Rule      → 新 Prompt
旧 Workspace → 新 Workspace
```

正确流程：

```text
旧能力
↓
理解目的
↓
拆解职责
↓
重新归类
↓
重新定义 Contract
↓
按新 Runtime 架构实现
```

---

# 2. 分类维度

每项旧能力至少判断属于：

```text
Domain
Runtime
Runtime Policy
Skill
Tool
Service
Validator / Gate
Workspace
UI
Legacy Only
```

---

# 3. Legacy Skill

旧 Skill 主要提取：

- Purpose
- Analysis Focus
- 专业判断原则
- 输入需求
- 输出目标
- 边界
- Non-goals

以下内容原则上迁出 Skill：

- Routing
- Session
- Thread
- 文件路径
- Workspace 写入
- Tool 执行
- Gate 执行
- Artifact 版本
- Run 状态
- Interaction 生命周期

---

# 4. Legacy Script

旧 Python Script 只作为：

- 能力参考
- 已验证逻辑参考
- 业务规则参考

不要直接复制。

先判断它应该成为：

- Tool
- Service
- Validator
- Domain Logic
- Legacy Only

然后重新定义：

- Input
- Output
- Error
- Permission
- Test
- Workspace Boundary

---

# 5. Legacy Rules

旧 Rules 需要重新分类。

可能进入：

### Runtime Policy

例如：

- Context
- Approval
- Interaction
- Routing
- Write Policy

### Domain

例如：

- FACT
- ASSUMPTION
- DECISION
- OPEN_QUESTION

### Skill

例如：

- 专业分析方法
- 业务判断框架

### Tool / Validator

例如：

- 可以程序化的格式校验
- Ready 检查
- Grounding 机械检查

不要把所有旧 Rules 原样继续作为 Prompt。

---

# 6. Workspace Template

旧 Workspace Template 不能直接视为新模板。

需要重新评估：

- 哪些是长期事实
- 哪些只是 Codex 运行中间态
- 哪些应该进入 SQLite
- 哪些应该留在 Workspace
- 哪些可以删除
- 哪些应该转成 Domain 对象

---

# 7. 拆解输出

Legacy 能力拆解至少形成一张映射表：

| Legacy 能力 | 原作用 | 新归属 | 是否保留 | 新实现建议 |
|---|---|---|---|---|

未经拆解，不直接迁移。
