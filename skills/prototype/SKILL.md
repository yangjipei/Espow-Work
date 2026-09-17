# 页面原型

## Purpose

把 Interaction Design 已经决定的页面、区域、组件、入口、Action、State、Feedback 与 Transition 表现为本地可直接打开、核心交互真实可操作的 HTML Prototype。

## Prerequisite

- 正式 Prototype 默认要求最新 Interaction Design 为 `CONFIRMED`。
- Interaction 尚未确认时，只能生成 `DRAFT` / `WAITING_CLARIFICATION`，不得进入正式确认或写入 Workspace。
- 优先消费 Context Manager 提供的 Interaction、必要 Solution、Existing Prototype / UI Baseline，不重复加载全部上游历史。

## Existing UI First

1. 先用 `artifact_find` 判断当前功能是否已有 Prototype，并只读取当前有效版本。
2. 有现有页面时以它为结构与视觉基线，使用 `delta` 模式，只修改受影响的组件、交互和状态；不得重做整个产品。
3. 没有现有页面时，根据 Interaction Model、产品载体与 UI Baseline 创建 V1，不因缺少 Reference 停止。
4. 参考资料只提供结构、层级、组件形式、导航、操作位置与风格，不得把参考中的额外功能带入当前 Requirement。

## Method

1. 读取最新 Interaction JSON；按需读取最新 Solution JSON、Existing Prototype 与明确的 UI Reference。
2. 调用 `artifact_next_version`，由 Tool 返回目标 HTML 路径和版本；不得自行猜版本。
3. 生成完整、自包含的 HTML / CSS / JS Candidate。核心内容不能依赖外部服务、字体、脚本或样式才能展示。
4. 使用业务可理解的 Mock Data，优先跑通 Main User Path；只实现 Interaction 定义的必要错误、空态和边缘状态。
5. 交互中出现的新增、编辑、展开、收起、筛选、Tab、Modal、Drawer、确认、取消、返回和状态切换必须具有真实行为和反馈。
6. 尊重 `primary / secondary / supporting` 信息层级；专业工作台默认浅色、清晰、克制、高可读，不做营销页式设计。
7. 已有 Prototype Delta 必须说明 Added / Changed / Removed Components、Interaction Changes 与 State Changes。
8. 如果用户要求改变已确认交互规则，记录 `interactionConflicts` 并进入 `WAITING_CLARIFICATION`，不要静默修改 HTML。

## HTML Contract

- 完整 HTML 必须包含 `<!doctype html>`、`html`、`head`、`body`、`title` 和主内容容器。
- `head` 必须包含 `espow:prototype-id`、`espow:prototype-version`、`espow:source-interaction`、`espow:source-capabilities`、`espow:source-flows` meta，确保正式 HTML 自身保留 Artifact 级追踪。
- 页面关键元素使用稳定且唯一的 `id`；`requiredDomIds` 列出必须存在的关键 DOM，`interactiveDomIds` 列出必须有真实行为的关键控件。
- 关键控件应使用原生可操作元素，或显式提供键盘/点击行为；脚本启动不得存在语法错误。
- 核心样式与脚本内联；禁止以远程资源作为核心展示依赖。

## Validation & Confirmation

- 先调用 `prototype_ready` 检查 HTML 结构、DOM、交互绑定、本地资源、脚本语法、版本路径与来源；再调用 `prototype_submit` 保存 Candidate。
- 模型语义检查只给 `Ready` 或具体 Issues，不输出审美分数。
- `READY_FOR_CONFIRMATION` Candidate 先在 ESPow 中预览；用户反馈作为 Prototype Delta，只改受影响部分并生成下一版 Candidate。
- 用户明确“可以 / 定稿 / 确认 / 这个版本 OK”后，才由 Runtime 调用 `prototype_write`，随后执行 `workspace_validate`。

## Non-goals

- 不重新决定重大交互，不重新做 Requirement Analysis、Business Flow 或 Solution Design。
- 不生成 PRD、Figma、截图转代码平台、Design System、React 生产工程或真实业务接口。
- 不覆盖历史 Prototype，不负责路径、版本、写入、Approval、Run 或 Workspace 状态。
