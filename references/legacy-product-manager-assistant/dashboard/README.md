# 工作台（`dashboard/`）

用于聚合产品经理当前需要处理的事项：我的需求、最近处理、待确认、待评审、待验收、最近变更。

工作台是 `requirements/*/state.yaml`、决策、待确认问题和评审结果的派生视图，不保存新的产品事实，也不要求人工维护多份重复清单。需要生成具体视图时，应从 Requirement Workspace 读取并覆盖生成。

运行 `python3 scripts/build_dashboard.py` 生成 `index.md`；运行 `python3 scripts/build_dashboard.py --check` 检查它是否需要更新。
