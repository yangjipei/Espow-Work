# Requirement Workspace 模板

这是新需求的唯一模板来源。复制整个 `_template/` 并以清晰的需求名称重命名，新目录放在 `requirements/` 下。

物理路径使用英文，中文名称用于界面和文档标题。目录映射见工作空间根目录的 `WORKSPACE-UI.md`。

只创建当前需求实际需要的产物；不要为了填满模板而生成空文档。`source/` 保存未改写的原始资料，其他目录保存分析和产品成果。

推荐从工作空间根目录运行 `python3 scripts/new_requirement.py "需求名称"`，由脚本完成复制、名称校验以及 `state.yaml` 初始化。
