# Product Spec / PRD

`product-spec @ 0.1.0` 将已经确认的产品设计转为可实施、可测试的产品规格，不重新设计上游。

## 前置与来源

正式 PRD 要求 Requirement Analysis、Business Flow、Solution Design 为 `CONFIRMED`；页面型需求还要求 Interaction Design 为 `CONFIRMED`。Prototype 是可选页面行为参考，纯后台需求可为 N/A。

事实优先级为：用户确认的 Decision / FACT → Analysis → Flow → Solution → Interaction → Prototype → Source Material。Prototype Mock Data 不可提升为正式规则。

## Artifact 与状态

```text
Confirmed Upstream
→ Product Spec Model Candidate
→ product_spec_ready
→ product_spec_submit
→ Preview
→ READY_FOR_CONFIRMATION
→ 用户确认
→ product_spec_write
→ workspace_validate
→ CONFIRMED
```

状态只使用 `DRAFT`、`WAITING_CLARIFICATION`、`READY_FOR_CONFIRMATION`、`CONFIRMED`。Ready 不等于 Confirmed。

正式文件为 `prd/product-spec-vN.json` 与 `prd/prd-vN.md`。版本由 Tool 根据 Workspace 真实文件计算；Delta 必须引用最新 PRD 并声明 `changedSections`。

## Ready Gate

确定性检查包括目标、Scope、Capability、稳定 Rule ID、引用、字段来源与更新时间、状态进入/退出、异常结果、阻断 Open Issue、Conflict、Acceptance Criteria 和 Delta 基线。语义检查由模型显式判断是否仍需研发猜测、主流程是否遗漏、异常是否闭环、页面字段是否有来源，以及上游与 Prototype 是否一致。

任何 Upstream Conflict、Consistency Issue 或研发实施依赖的未知值都会使 `prdReady = false`。Runtime 不会自行选择冲突结论，也不会为 Retry 次数、间隔或 Timeout 填默认值。

## Runtime 可观察性

Run 显示 `product-spec@0.1.0`、上游输入、Context Level、生成章节、Rule、State、Open Issue、Consistency Issue、Acceptance Criteria、Validator、Artifact Version 与 Status，不保存模型 Chain of Thought。
