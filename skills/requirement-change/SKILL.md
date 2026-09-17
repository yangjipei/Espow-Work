# 需求变更

## Purpose

处理已有 Requirement 上的变化，并在保持已有业务事实一致的基础上完成最小必要修改。

## Analysis Focus

1. 变化对象是什么。
2. 原规则是什么。
3. 新规则是什么。
4. 变化属于新增、修改、删除还是替换。
5. 哪些场景受影响。
6. 哪些 Artifact 可能需要修改，哪些经检查后无需修改。
7. 是否影响已有 Decision。
8. 是否产生新 Open Issue，或存在事实缺失。

## Method

1. 先理解变化。
2. 再判断语义影响。
3. 只读取直接相关的 Requirement Context 与 Artifact。
4. 收敛最小修改范围。
5. 最后提出候选修改，并说明无需修改的已检查 Artifact。

## Principles

- 以真实 Workspace 事实和已读 Artifact 为依据。
- 最小影响、最小读取、最小修改。
- 用户已明确提供的变化不重复询问。
- 无法确定变化对象、新规则或场景时，返回 `ClarificationRequired`。
- 与已有 Decision 冲突时，返回 `DecisionConflict`，不静默覆盖。
- 用户事实可作为 FACT Candidate；模型推断不得伪装成 FACT 或正式 Decision。
- 已确认 Business Flow 受影响时，以最新 `business-flow-vN.json` Flow Model 为 Source of Truth，提交最小节点/连线候选并由 Renderer 生成配对 HTML；不得直接修改 Rendered HTML。
- 已确认 Solution Design 受影响时，以最新 `solution-design-vN.json` Solution Model 为 Source of Truth，通过引用定位受影响 Capability / Rule / State / Data，并只提交最小结构化变化；不得直接修改 Rendered Markdown。
- 已确认 Interaction Design 受影响时，以最新 `interaction-design-vN.json` Interaction Model 为 Source of Truth，通过 Capability / Flow / Scenario 引用定位受影响的 Rule、Component、State、Transition、Feedback 或 User Path；不得重新生成全部页面，也不得直接修改 Rendered Markdown。
- 已确认 Prototype 受影响时，先判断变化是否仅为表现调整。表现调整交给 `prototype` 基于当前有效 HTML 做局部 Delta；入口、Action、State、Feedback 或 Transition 规则变化必须先标记 Interaction Impact，能力取消或新增必须继续标记 Solution Impact，不能只改 HTML。
- 已确认 PRD 受影响时，以最新 `product-spec-vN.json` 为 Source of Truth，通过 Rule / Capability / State / Field 与来源引用定位受影响章节；使用 Product Spec Tool 形成最小 Candidate Delta，不得重写无关章节或覆盖旧版 PRD。

## Non-goals

- 不重跑完整需求分析或产品生命周期。
- 不默认重写整份 Artifact。
- 不自行创造缺失业务事实。
- 不为了完整而扩大修改范围。
- 不负责文件扫描、路径、版本号、Diff、写入、Approval、Run 或 Session。
