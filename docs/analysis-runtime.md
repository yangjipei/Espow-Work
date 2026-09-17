# Requirement Analysis Conversation Runtime

ESPow Work 的需求分析阶段采用“对话收敛”而不是通用多 Step Agent 的工作模式。

## 四层数据

1. **Conversation Transcript**：完整消息、Tool、Script 事件，仅用于 UI、审计和恢复，不整段回放给模型。
2. **Analysis State**：Problem、Scenarios、Goals、Flow、Rules、Scope、Impact、Decisions、Open Questions、Readiness 的结构化工作记忆。
3. **Working State Projection**：由本地确定性代码从完整 State 投影，只携带本轮需要的确认事实、当前主题、阻塞问题和 Readiness。
4. **Analysis Artifact**：只有 Readiness 达标且产品经理确认后才生成并写入 Workspace。

## Script First

全局原则：`Rule First → Script First → Tool Second → Model Last`。

需求分析中，模型只负责自然语言理解、需求推理、场景发现、复杂影响判断和用户回复。以下动作由本地 Script 完成，Token 为 0：

- Analysis State Patch merge
- Question resolve
- 结构化冲突检测
- Readiness 计算
- Working State Projection
- ID / Schema / 状态处理

`electron/runtime/executionPolicy.ts` 是确定性 Script Registry 与 Requirement Analysis Runtime Plan 的代码级约束。

## 单轮执行

普通 Turn：

```text
User Message
→ Model（语义分析，通常 1 Call）
→ analysis_turn_submit（terminal tool）
→ Scripts：merge / question / conflict / readiness / projection
→ 直接返回 assistantReply
```

如果需要 Source/Artifact，允许最小读取工具，但 Requirement Analysis 的 Tool 面被 Runtime 强制限制为：

- `artifact_find`
- `artifact_read`
- `analysis_turn_submit`

`analysis_turn_submit` 为 terminal tool，Rust Runtime 收到后直接结束 Turn，不再为了“总结工具结果”额外调用一次模型。

## Readiness

集合型槽位同时保存 collection metadata。用户明确陈述或 Source 直接支持的集合可以进入 confirmed；模型推断保持 inferred。Readiness Gate 不把 inferred 的主流程/范围当成已确认事实。

## 可观测性

聊天区实时展示 Model / Tool / Script / State 动作；完成后本次会话中的执行动作仍显示在对应 Assistant 消息下。Run Detail 持久化 Runtime Event，Token 页面展示模型调用、Script Run、确定性执行率、Prompt 组成和 Analysis Turn Input Growth。
