# Product Manager Assistant｜路径与中文界面映射

文件系统和文档链接使用英文稳定路径；用户界面、导航名称和文档标题使用中文。不得为同一成果同时创建中英文两套目录。

## 工作台

物理路径：`dashboard/`

- 我的需求
- 最近处理
- 待我确认
- 待评审
- 待验收
- 最近变更

## Requirement Workspace
一个需求 = 一个独立文件夹。多个对话共享同一个需求工作区。

需求根路径：`requirements/<requirement-name>/`

| 英文稳定路径 | 中文界面名称 | 内容 |
| --- | --- | --- |
| `overview.md` | 需求概览 | 需求摘要、范围、当前状态与入口 |
| `source/` | 原始资料 | 未改写的输入与 Source Evidence |
| `analysis/` | 问题与场景 | 现状、需求、场景与影响分析 |
| `solution/` | 产品方案 | 目标、成功标准与方案设计 |
| `flows/` | 业务流程 | 业务规则、流程与状态模型 |
| `prototype/` | 页面原型 | 信息架构、页面流程、原型与样式参考 |
| `prd/` | 产品文档 | PRD、补充文档与追踪信息 |
| `review/` | 评审与验收 | 需求评审、验收与效果评估 |
| `changes/` | 决策与变更 | 产品决策、变更记录与待确认问题 |

顶层机器状态或索引文件可按需存在，但不得成为第二套产品事实源。

用户不直接看到：Skills、Prompt、Interaction Contract、Quality Gate、内部 Routing。
