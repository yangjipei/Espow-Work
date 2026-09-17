# Product Manager Assistant

这是产品经理工作空间。文件系统使用稳定的英文路径，界面、标题和文档内容使用中文。一个需求 = 一个 Requirement Workspace；一个需求可包含多个对话，但共享同一套需求事实、决策与产物。

```text
Product Manager Assistant/
├── dashboard/        # 工作台（派生视图）
├── requirements/     # 需求工作区
└── .agents/          # Agent 能力与规则
```

- `dashboard/`：中文界面中的“工作台”，只聚合需求状态，不保存新的产品事实。
- `requirements/`：中文界面中的“需求”，保存真实 Requirement Workspace。
- `.agents/`：内部能力层，包含 Skills 与 Rules；用户界面默认不暴露。
- `requirements/_template/`：新需求唯一模板来源。

Requirement Workspace 的稳定路径映射见 [WORKSPACE-UI.md](./WORKSPACE-UI.md)。

重要信息状态：`FACT / ASSUMPTION / DECISION / OPEN_QUESTION`。

## 工作空间命令

```bash
# 检查路径、状态、产物索引和引用完整性
python3 scripts/validate_workspace.py

# 创建新需求
python3 scripts/new_requirement.py "需求名称"

# 重新生成中文工作台
python3 scripts/build_dashboard.py
```

这些脚本只依赖 Python 标准库。校验脚本默认只读；新建需求和工作台生成脚本不会覆盖已存在的需求目录。
