# Lifecycle Stage State Engine

## 1. 目标

ESPow Work 不再把“槽位”绑定到 Requirement Analysis。槽位属于整个需求生命周期，每个阶段都有独立的 Stage State、Slot Schema 和 Readiness。

```text
Requirement Workspace
├─ Shared Requirement State
├─ Requirement Analysis Stage State
├─ Business Flow Stage State
├─ Solution Design Stage State
├─ Interaction Design Stage State
├─ Prototype Stage State
├─ Product Spec Stage State
└─ Requirement Review Stage State
```

`Analysis State` 继续保留，但它是 Requirement Analysis 的专业状态模型；Runtime 会确定性投影为通用 `requirement-analysis` Stage State。

## 2. 通用 Stage State 外壳

每个阶段统一包含：

```text
slots
readiness
decisions
openQuestions
conflicts
artifactRefs
upstreamVersions
status
staleReason
```

不同阶段只共享外壳，不共享 Slot Schema。

## 3. 各阶段 Slot Schema

- Requirement Analysis：problem / scenarios / goals / mainFlow / rules / scope / impacts
- Business Flow：actors / entry / mainFlow / decisionNodes / branches / exits / failurePaths / systemBoundaries
- Solution Design：capabilities / scope / rules / states / dataObjects / recoveries / productSurfaces / traceability
- Interaction Design：surfaces / pages / components / actions / states / transitions / feedback / permissions / exceptions / userPaths
- Prototype：pages / components / layout / interactions / dataBindings / states / responsive / uiBaseline
- Product Spec：functionalRequirements / businessRules / fields / stateMachine / permissions / exceptions / compatibility / dependencies / acceptanceCriteria
- Requirement Review：blockers / ambiguities / missingRules / technicalDependencies / dataGaps / exceptionGaps / acceptanceGaps / recommendedActions

## 4. Shared Requirement State

跨阶段稳定事实放入 Shared Requirement State，例如：

- 需求名称 / 当前目标
- Actors
- Systems
- In Scope / Out of Scope
- Constraints
- Global Decisions

Stage State 不应复制整段生命周期历史，只引用 Shared State 和必要的上游摘要。

## 5. Context

生命周期阶段 Context 优先级：

```text
Current Task
+ Shared Requirement State Projection
+ Current Stage Working Projection
+ Upstream Stage Summaries
+ Recent Conversation
+ Necessary Artifact metadata/content on demand
```

不再把所有上游 Artifact 全文当作每轮工作记忆。

## 6. Readiness

每个阶段独立计算退出条件。例如：

- Analysis：Problem / Scenario / Main Flow / Rules / Scope
- Business Flow：Actors / Entry / Main Flow / Branches / Exits / Failure / Boundary
- Product Spec：Functions / Rules / Fields / States / Exceptions / Acceptance

阶段确认只依据当前 Stage Readiness，不使用一个全局 `ready=true`。

## 7. Delta / Stale Propagation

上游 Stage State 发生实质变化时，Runtime 只把已有下游阶段标记为 `stale`：

```text
Business Flow changed
→ Solution / Interaction / Prototype / PRD / Review (if they already exist) = stale
```

不会自动重跑完整生命周期。后续由 Delta 流程判断哪些阶段需要真正修改。

## 8. Script-First

Stage State 的同步、Readiness、Projection、下游 stale 传播均为确定性 Runtime 能力，Token 成本为 0。

```text
Rule First → Script First → Tool Second → Model Last
```
