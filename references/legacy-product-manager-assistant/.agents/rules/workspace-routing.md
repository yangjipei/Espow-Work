# Workspace Routing

Skill 决定“怎么工作”，Requirement Workspace 决定“成果放哪里”。

文件系统统一使用英文稳定路径，中文只作为用户界面和文档标题：

| 路径 | 中文名称 |
| --- | --- |
| `overview.md` | 需求概览 |
| `source/` | 原始资料 |
| `analysis/` | 问题与场景 |
| `solution/` | 产品方案 |
| `flows/` | 业务流程 |
| `prototype/` | 页面原型 |
| `prd/` | 产品文档 |
| `review/` | 评审与验收 |
| `changes/` | 决策与变更 |

原始资料归档到 `source/`；原型迭代使用递增版本号；当前有效事实以最新确认结果为准。不得为同一成果创建中英文两套目录。

新需求唯一模板来源是 `requirements/_template/`。`.agents/` 只保存能力与规则，不保存成果模板副本。`dashboard/` 只保存派生视图，不作为事实源。
