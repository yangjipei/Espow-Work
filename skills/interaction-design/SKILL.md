# 交互设计

## Purpose

把已确认的 Requirement Analysis、Business Flow 与 Solution Design 转化为用户可以真正操作的页面结构、入口、路径、状态、反馈、异常与恢复规则，并形成可供 Prototype 消费的 Interaction Model。

## Prerequisite

- 正式交互设计默认要求 Requirement Analysis、Business Flow、Solution Design 均为 `CONFIRMED`。
- Solution 尚未确认时，只能做 `DRAFT` / `WAITING_CLARIFICATION` 的 Interaction Exploration，不得进入 `READY_FOR_CONFIRMATION`。
- 直接消费 Capability、Rule、State、Data、Product Surface、Exception、Recovery、Decision 与 Open Question，不重新执行 Solution Design。

## Method

1. 先确认能力所在 Product Surface，并优先复用已有页面、Prototype、UI Reference 与已确认 UI Baseline；不为每个 Capability 自动新建页面。
2. 为主要 Capability 明确入口、页面/区域/组件承载位置、主用户操作路径和操作结果。
3. 按真实需要选择 Inline、Popover、Modal、Drawer 或 Full Page，依据任务复杂度、信息量和上下文连续性，不依据视觉偏好。
4. 定义信息与操作优先级，避免列表、详情和操作区堆叠；只加入真实需要的搜索、筛选、排序、分页或批量操作。
5. 只设计真实存在的 Default、Loading、Success、Empty、Error、Disabled、Processing、Waiting、Completed 状态；Disabled 必须说明原因。
6. 对等待过程明确重复点击、关闭、继续其他操作和取消语义；区分取消操作、关闭 UI 与删除业务事实。
7. 异常反馈面向用户行为，并定义重试、返回、等待恢复、重新进入或人工处理路径；底层错误码不直接代替用户提示。
8. 检查 Back / Close / Cancel、跨页面连续性和 Cross-context Event。切换上下文时明确提醒位置、点击去向及当前工作状态是否保留。
9. 交互取舍确实存在且事实不足时生成 Decision Candidate；已有 Decision 直接使用，不重复询问。
10. 若交互需要已确认 Solution 未提供的能力或状态，记录 Solution Conflict；若与 Flow 冲突，记录 Flow Conflict，不静默修改上游。

## Interaction Model

结构化结果包含：surfaces、pages、components、actions、states、transitions、feedback、interactionRules、userPaths、decisions、openQuestions、solutionConflicts、flowConflicts、uiReferencePaths、semanticChecks 与三类上游来源。

提交 JSON 必须使用以下字段名：

- 顶层：`id`、`name`、`overview`、`status`、上述集合、`sourceAnalysisPath/Status`、`sourceFlowPath/Status`、`sourceSolutionPath/Status`、`confirmedAt`。
- Surface：`id/name/type/purpose/existing/sourceCapabilityIds`。
- Page：`id/name/surfaceId/purpose/sections/entryPoints/sourceCapabilityIds/sourceFlowNodeIds/sourceScenarioIds`。
- Component：`id/name/pageId/section/kind/purpose/informationPriority/sourceCapabilityIds/sourceFlowNodeIds/sourceScenarioIds`。
- Action：`id/name/componentId/priority/trigger/preconditions/result/feedbackIds/sourceCapabilityIds/sourceFlowNodeIds/sourceScenarioIds`。
- State：`id/name/componentId/kind/description/visibleInformation/availableActionIds/reason`。
- Transition：`id/fromStateId/toStateId/trigger/userActionId/systemFeedback/recovery`。
- Feedback：`id/trigger/type/message/behavior`；Rule：`id/trigger/condition/uiBehavior/userAction/systemFeedback/result/relatedCapabilityIds/relatedFlowNodeIds`。
- User Path：`id/name/steps/sourceCapabilityIds/sourceFlowNodeIds/sourceScenarioIds`；Decision 的 Option 使用 `name/benefit/cost/impact`。

`status` 只使用 `DRAFT`、`WAITING_CLARIFICATION`、`READY_FOR_CONFIRMATION`；`informationPriority` 使用 `primary/secondary/supporting`，Action `priority` 使用 `primary/secondary/high-risk`，State `kind` 使用 `default/loading/success/empty/error/disabled/processing/waiting/completed`。

交互元素通过 `sourceCapabilityIds`、`sourceFlowNodeIds`、`sourceScenarioIds` 追踪来源。Interaction Rule 至少表达 Trigger、Condition、UI Behavior、User Action、System Feedback、Result 与相关 Capability / Flow Node。

## Validation & Interaction

- 先用 `artifact_read` 读取已确认 Analysis、最新 confirmed Flow JSON 与最新 confirmed Solution JSON；如 Context 中存在 Prototype / UI Reference，再按需读取。
- 先调用 `interaction_design_next_version`，构造完整 Model，再调用 `interaction_design_ready`，最后调用 `interaction_design_submit`。
- 关键取舍未确认时提交 `WAITING_CLARIFICATION`；上游冲突存在时不得提交 `READY_FOR_CONFIRMATION`。
- 用户修改时只调整受影响 Rule、Component、State、Transition 或 Path 并重新校验，不重做全部交互。
- 用户明确确认前不得调用 `interaction_design_write` 或声称交互已确认。

## Output

Interaction Model 是 Source of Truth；Markdown 由 Tool 确定性渲染。只保留适用的 Overview、Product Surfaces、Information Architecture、Page / Section Structure、Main User Paths、Components、Actions、States、Feedback、Error & Recovery、Cross-context Interaction、Decisions 与 Open Questions。

## Non-goals

- 不生成 HTML、React Page、图片或最终 Prototype。
- 不做视觉设计，不展开 font-size、padding、border-radius、color、shadow。
- 不重新做 Requirement Analysis、Business Flow、Solution Design、PRD 或技术设计。
- 不负责路由、版本、文件写入、Confirmation、Run 或 Workspace 状态。
