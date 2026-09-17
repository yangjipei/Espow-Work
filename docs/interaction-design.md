# Interaction Design

`interaction-design @ 0.1.0` 把已确认的 Requirement Analysis、Business Flow 与 Solution Design 转化为页面、组件、操作、状态、反馈和恢复规则。本阶段不生成 Prototype。

## 前置与状态

正式候选要求三个上游均为 `CONFIRMED`。Solution 尚未确认时，用户可明确要求 Draft Interaction Exploration，但结果只能是 `DRAFT` 或 `WAITING_CLARIFICATION`。

```text
DRAFT / WAITING_CLARIFICATION
→ interaction_design_ready
→ READY_FOR_CONFIRMATION
→ 产品经理确认
→ CONFIRMED
```

Decision Candidate、阻断 Open Question、Solution Conflict 或 Flow Conflict 存在时，不能进入 `READY_FOR_CONFIRMATION`。

## Interaction Model

结构化 JSON 是 Source of Truth，包含：

- Product Surface、Page、Section、Component；
- Action、State、Transition、Feedback；
- Interaction Rule、Main User Path；
- Decision Candidate、Open Question、Solution / Flow Conflict；
- UI Reference 路径和语义检查；
- `sourceCapabilityIds`、`sourceFlowNodeIds`、`sourceScenarioIds` 追踪。

Markdown 由确定性 Renderer 生成，不包含 HTML、React 或视觉像素规范。

## Tool 闭环

```text
artifact_read（确认 Analysis + latest Flow JSON + latest Solution JSON）
→ interaction_design_next_version
→ interaction_design_ready
→ interaction_design_submit
→ WaitingConfirmation
→ interaction_design_write
→ workspace_validate（JSON + Markdown）
```

正式 Artifact 使用递增版本：

```text
interaction/interaction-design-vN.json
interaction/interaction-design-vN.md
```

确认前候选只保存在 Run。确认时重新检查版本指纹，拒绝覆盖候选形成后被修改的 Artifact。

## Ready Validator

确定性检查包括：Capability 有承载位置、Page 有入口、Component 可定位、Action 有入口与结果、Disabled 有原因、引用存在、Error Transition 有 Recovery、关键 User Path 存在。模型同时显式判断主场景闭环、死路、错误反馈、恢复、跨页面上下文和认知负担。

## Requirement Change

交互 Delta 以最新 JSON Model 为规范源，通过来源 ID 只修改受影响 Rule、Component、State、Transition、Feedback 或 User Path，并生成新版本；不得重做全部页面或直接改 Rendered Markdown。
