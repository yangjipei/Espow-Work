# ESPow Prototype

`prototype @ 0.1.0` 把 Interaction Design 表现为本地可直接打开、核心路径可操作、可版本化和可确认的 HTML 产品原型。本阶段不生成 PRD 或生产前端代码。

## Artifact 与状态

正式 Artifact 保存在 `prototype/<page-name>-vN.html`。状态保持 `DRAFT → WAITING_CLARIFICATION → READY_FOR_CONFIRMATION → CONFIRMED`。Candidate HTML、Metadata、Diff 与 Validation 保存在 Run；确认前不写入 Workspace。正式 Prototype 默认要求最新 Interaction Design 为 `CONFIRMED`，否则只能做 Draft Exploration。

## Existing UI First

生成前先定位当前有效 Prototype。存在时读取其 Navigation、Layout、Components、CSS Convention 与 Existing Interaction，只修改受影响部分；没有时根据 Interaction Model、Product Surface 与默认浅色专业工作台 Baseline 创建 V1。参考中的额外能力不能自动进入当前需求。

版本必须调用 `artifact_next_version` 从真实文件计算。新页面以建议的 `prototype/<name>-v1.html` 请求 Tool 计算；已有页面以 Artifact ID 计算下一版。默认创建新版本并保留旧文件。

## Candidate 与验证

```text
artifact_find / artifact_read
→ artifact_next_version
→ HTML + Prototype Metadata Candidate
→ prototype_ready
→ prototype_submit
→ ESPow iframe Preview / Diff
→ 产品经理确认
→ prototype_write
→ workspace_validate
```

确定性 Validator 检查 Doctype / HTML / Head / Title / Body、主容器、Artifact Trace Meta、DOM ID 唯一性、关键 DOM、交互绑定、远程核心依赖、内联 JS 语法、目标版本、Existing Prototype 与来源状态。正式 HTML 通过 `espow:prototype-id / prototype-version / source-interaction / source-capabilities / source-flows` Meta 保留 Artifact 级追踪。语义检查明确判断 Interaction、主路径、关键状态、反馈、认知负担和未确认功能；只输出 Ready 或具体 Issues，不输出审美分数。

表现调整直接作为 Prototype Delta，并记录 Added / Changed / Removed Components、Interaction Changes 与 State Changes。若反馈改变已确认入口、交互规则、反馈形态或产品能力，则记录 `Interaction Conflict` 或上游影响，不静默修改 HTML。

HTML 使用业务可理解的 Mock Data，核心操作必须可点击并有反馈；不要求连接真实业务接口。确认后不会自动进入 PRD。
