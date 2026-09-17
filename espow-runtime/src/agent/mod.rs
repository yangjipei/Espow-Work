use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::Instant;

use reqwest::Client;
use serde_json::{json, Value};
use thiserror::Error;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    model::{tool_definitions, ChatMessage, ModelError, OpenAiCompatibleProvider},
    protocol::{RunStartParams, RuntimeEventData, RuntimeEventEnvelope, TokenBreakdownItem},
    transport::SharedTransport,
};

#[derive(Debug, Error)]
pub enum AgentError {
    #[error(transparent)]
    Model(#[from] ModelError),
    #[error("tool {0} failed: {1}")]
    Tool(String, String),
    #[error("agent exceeded maximum steps ({0})")]
    MaxSteps(usize),
    #[error("agent exceeded model call budget ({0})")]
    MaxModelCalls(usize),
    #[error("provider input exceeds hard token budget: estimated {estimated}, limit {limit}")]
    InputBudgetExceeded { estimated: usize, limit: usize },
    #[error("required terminal tool was not called: {0}")]
    MissingTerminalTool(String),
}

fn now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

async fn emit(transport: &SharedTransport, params: &RunStartParams, data: RuntimeEventData) {
    transport
        .write_value(&json!({
            "event": RuntimeEventEnvelope {
                event_id: Uuid::new_v4().to_string(),
                run_id: params.run_id.clone(),
                thread_id: params.thread_id.clone(),
                turn_id: params.turn_id.clone(),
                created_at: now(),
                data,
            }
        }))
        .await;
}

async fn fail_tool(
    transport: &SharedTransport,
    params: &RunStartParams,
    name: &str,
    code: &str,
    message: String,
) -> AgentError {
    emit(
        transport,
        params,
        RuntimeEventData::RunFailed {
            error: message.clone(),
            code: code.into(),
        },
    )
    .await;
    AgentError::Tool(name.to_string(), message)
}

fn tool_error_content(body: &Value) -> String {
    serde_json::to_string(&json!({
        "ok": false,
        "error": {
            "code": body.pointer("/error/code").and_then(Value::as_str).unwrap_or("TOOL_FAILED"),
            "message": body.pointer("/error/message").and_then(Value::as_str).unwrap_or("tool failed")
        }
    }))
    .unwrap_or_else(|_| r#"{"ok":false,"error":{"code":"TOOL_FAILED","message":"tool failed"}}"#.into())
}

fn invalid_tool_arguments_content(error: &serde_json::Error) -> String {
    serde_json::to_string(&json!({
        "ok": false,
        "error": {
            "code": "INVALID_ARGUMENTS_JSON",
            "message": format!(
                "Tool arguments are not valid JSON: {error}. Retry the same tool with one valid JSON object. All object keys must be double-quoted strings; do not use Markdown."
            )
        }
    }))
    .unwrap_or_else(|_| r#"{"ok":false,"error":{"code":"INVALID_ARGUMENTS_JSON","message":"Tool arguments are not valid JSON. Retry with one valid JSON object."}}"#.into())
}

fn compact_failed_tool_arguments(messages: &mut [ChatMessage], call_id: &str) {
    if let Some(history_call) = messages
        .iter_mut()
        .rev()
        .filter_map(|message| message.tool_calls.as_mut())
        .flatten()
        .find(|call| call.id == call_id)
    {
        history_call.function.arguments = "{}".into();
    }
}

fn tool_failure_is_recoverable(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::BAD_REQUEST
}

fn terminal_tool_message(output: &Value) -> Option<String> {
    if output.get("__espowTerminal").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    output
        .get("assistantReply")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn followup_decision(output: &Value) -> (bool, String) {
    let directive = output.get("__espowFollowup");
    let required = directive
        .and_then(|value| value.get("required"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let reason = directive
        .and_then(|value| value.get("reason"))
        .and_then(Value::as_str)
        .unwrap_or("NEW_INFORMATION")
        .to_string();
    (required, reason)
}

fn prompt_metrics(
    params: &RunStartParams,
    messages: &[ChatMessage],
) -> (usize, usize, usize, usize, usize, usize, usize) {
    let message_count = messages.len();
    let tool_count = params.tools.len();
    let system_prompt_chars = params.system_prompt.chars().count();
    let context_package_chars = params.input.chars().count();
    let tool_schema_chars = serialized_tool_definitions(&params.tools).chars().count();
    let assistant_history_chars = messages
        .iter()
        .filter(|message| message.role == "assistant")
        .map(|message| {
            message
                .content
                .as_deref()
                .unwrap_or_default()
                .chars()
                .count()
                + message
                    .tool_calls
                    .as_ref()
                    .map(|calls| {
                        calls
                            .iter()
                            .map(|call| {
                                call.function.arguments.chars().count()
                                    + call.function.name.chars().count()
                            })
                            .sum::<usize>()
                    })
                    .unwrap_or(0)
        })
        .sum();
    let tool_result_chars = messages
        .iter()
        .filter(|message| message.role == "tool")
        .map(|message| {
            message
                .content
                .as_deref()
                .unwrap_or_default()
                .chars()
                .count()
        })
        .sum();
    (
        message_count,
        tool_count,
        system_prompt_chars,
        context_package_chars,
        tool_schema_chars,
        assistant_history_chars,
        tool_result_chars,
    )
}

fn estimate_input_tokens(messages: &[ChatMessage], tools: &[crate::protocol::ToolSpec]) -> usize {
    let message_json = serde_json::to_string(messages).unwrap_or_default();
    let tool_json = serialized_tool_definitions(tools);
    message_json
        .chars()
        .chain(tool_json.chars())
        .map(|character| if character.is_ascii() { 0.25 } else { 1.0 })
        .sum::<f64>()
        .ceil()
        .max(1.0) as usize
}

fn serialized_tool_definitions(tools: &[crate::protocol::ToolSpec]) -> String {
    let definitions = tool_definitions(tools);
    if definitions.is_empty() {
        String::new()
    } else {
        serde_json::to_string(&definitions).unwrap_or_default()
    }
}

fn token_weight(value: &str) -> f64 {
    value
        .chars()
        .map(|character| if character.is_ascii() { 0.25 } else { 1.0 })
        .sum()
}

fn input_breakdown(
    params: &RunStartParams,
    messages: &[ChatMessage],
) -> (usize, Vec<TokenBreakdownItem>) {
    let total = estimate_input_tokens(messages, &params.tools);
    let mut weights: BTreeMap<String, f64> = BTreeMap::new();
    weights.insert("system".into(), token_weight(&params.system_prompt));
    weights.insert(
        "tools".into(),
        token_weight(&serialized_tool_definitions(&params.tools)),
    );
    let tagged_input = params
        .context_parts
        .iter()
        .map(|part| part.content.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    if tagged_input == params.input {
        for part in &params.context_parts {
            let source = match part.source.as_str() {
                "skill" | "workspace" | "stage_slot" | "mainline" | "working" | "artifact"
                | "history" | "user" | "other" => part.source.as_str(),
                _ => "other",
            };
            *weights.entry(source.into()).or_default() += token_weight(&part.content);
        }
    } else {
        *weights.entry("other".into()).or_default() += token_weight(&params.input);
    }
    if messages.len() > 2 {
        *weights.entry("history".into()).or_default() +=
            token_weight(&serde_json::to_string(&messages[2..]).unwrap_or_default());
    }
    let categorized: f64 = weights.values().sum();
    let total_weight = token_weight(&serde_json::to_string(messages).unwrap_or_default())
        + token_weight(&serialized_tool_definitions(&params.tools));
    *weights.entry("other".into()).or_default() += (total_weight - categorized).max(0.0);
    let order = [
        "system",
        "tools",
        "skill",
        "workspace",
        "stage_slot",
        "mainline",
        "working",
        "artifact",
        "history",
        "user",
        "other",
    ];
    let breakdown = order
        .iter()
        .map(|source| {
            let weight = *weights.get(*source).unwrap_or(&0.0);
            Some(TokenBreakdownItem {
                source: (*source).into(),
                tokens: weight.ceil() as usize,
                percentage: if total_weight > 0.0 {
                    weight / total_weight * 100.0
                } else {
                    0.0
                },
            })
        })
        .flatten()
        .collect();
    (total, breakdown)
}

pub async fn run_agent(
    params: RunStartParams,
    cancellation: CancellationToken,
    transport: SharedTransport,
) -> Result<(), AgentError> {
    emit(&transport, &params, RuntimeEventData::RunStarted).await;
    let provider = match OpenAiCompatibleProvider::new() {
        Ok(provider) => provider,
        Err(error) => {
            emit(
                &transport,
                &params,
                RuntimeEventData::RunFailed {
                    error: error.to_string(),
                    code: error.code().into(),
                },
            )
            .await;
            return Err(error.into());
        }
    };
    let tool_client = Client::new();
    let allowed_tools: HashSet<String> =
        params.tools.iter().map(|tool| tool.name.clone()).collect();
    let mut messages = vec![
        ChatMessage::text("system", params.system_prompt.clone()),
        ChatMessage::text("user", params.input.clone()),
    ];
    let max_steps = params.max_steps.clamp(1, 32);
    let mut repeated_calls: HashMap<String, usize> = HashMap::new();
    let mut force_terminal_tool = false;

    if let Some(terminal_tool) = params.terminal_tool.as_deref() {
        if !allowed_tools.contains(terminal_tool) {
            let error = AgentError::MissingTerminalTool(terminal_tool.to_string());
            emit(
                &transport,
                &params,
                RuntimeEventData::RunFailed {
                    error: error.to_string(),
                    code: "terminal-tool-not-allowed".into(),
                },
            )
            .await;
            return Err(error);
        }
    }

    for step in 1..=max_steps {
        if step > params.max_model_calls {
            let error = AgentError::MaxModelCalls(params.max_model_calls);
            emit(
                &transport,
                &params,
                RuntimeEventData::RunFailed {
                    error: error.to_string(),
                    code: "model-call-budget-exceeded".into(),
                },
            )
            .await;
            return Err(error);
        }
        if cancellation.is_cancelled() {
            emit(&transport, &params, RuntimeEventData::RunCancelled).await;
            return Err(ModelError::Cancelled.into());
        }

        let estimated_before_call = estimate_input_tokens(&messages, &params.tools);
        if estimated_before_call > params.max_input_tokens {
            let error = AgentError::InputBudgetExceeded {
                estimated: estimated_before_call,
                limit: params.max_input_tokens,
            };
            emit(
                &transport,
                &params,
                RuntimeEventData::RunFailed {
                    error: error.to_string(),
                    code: "input-budget-exceeded".into(),
                },
            )
            .await;
            return Err(error);
        }

        let call_id = Uuid::new_v4().to_string();
        let call_reason = if step == 1 {
            params.call_reason.clone()
        } else {
            "tool_followup".into()
        };
        let call_started = Instant::now();
        emit(
            &transport,
            &params,
            RuntimeEventData::ModelStarted {
                step,
                call_id: call_id.clone(),
                call_reason: call_reason.clone(),
            },
        )
        .await;
        let (delta_tx, mut delta_rx) = mpsc::unbounded_channel::<String>();
        let delta_transport = transport.clone();
        let delta_params = params.clone();
        let forwarder = tokio::spawn(async move {
            while let Some(delta) = delta_rx.recv().await {
                emit(
                    &delta_transport,
                    &delta_params,
                    RuntimeEventData::MessageDelta { delta },
                )
                .await;
            }
        });
        let result = provider
            .stream_step(
                &params.model,
                &messages,
                &params.tools,
                params.max_output_tokens,
                force_terminal_tool
                    .then(|| params.terminal_tool.as_deref())
                    .flatten(),
                &cancellation,
                move |delta| {
                    let _ = delta_tx.send(delta);
                },
            )
            .await;
        let _ = forwarder.await;

        let result = match result {
            Ok(result) => result,
            Err(ModelError::Cancelled) => {
                emit(&transport, &params, RuntimeEventData::RunCancelled).await;
                return Err(ModelError::Cancelled.into());
            }
            Err(error) => {
                emit(
                    &transport,
                    &params,
                    RuntimeEventData::RunFailed {
                        error: error.to_string(),
                        code: error.code().into(),
                    },
                )
                .await;
                return Err(error.into());
            }
        };

        if let Some(usage) = result.usage {
            let (estimated_input_tokens, input_breakdown) = input_breakdown(&params, &messages);
            let history_tokens = input_breakdown
                .iter()
                .find(|item| item.source == "history")
                .map(|item| item.tokens)
                .unwrap_or(0);
            let (
                message_count,
                tool_count,
                system_prompt_chars,
                context_package_chars,
                tool_schema_chars,
                assistant_history_chars,
                tool_result_chars,
            ) = prompt_metrics(&params, &messages);
            emit(
                &transport,
                &params,
                RuntimeEventData::ModelUsage {
                    step,
                    call_id,
                    call_reason,
                    duration_ms: call_started.elapsed().as_millis() as u64,
                    input_tokens: usage.input_tokens,
                    output_tokens: usage.output_tokens,
                    total_tokens: usage.total_tokens,
                    execution_content: format!("Agent Step {step}"),
                    message_count,
                    tool_count,
                    system_prompt_chars,
                    context_package_chars,
                    tool_schema_chars,
                    assistant_history_chars,
                    tool_result_chars,
                    estimated_input_tokens,
                    history_tokens,
                    input_breakdown,
                },
            )
            .await;
        }

        if result.tool_calls.is_empty() {
            if result.content.trim().is_empty() {
                let error =
                    AgentError::Model(ModelError::Stream("model returned no content".into()));
                emit(
                    &transport,
                    &params,
                    RuntimeEventData::RunFailed {
                        error: error.to_string(),
                        code: "MODEL_EMPTY_RESPONSE".into(),
                    },
                )
                .await;
                return Err(error);
            }
            if let Some(terminal_tool) = params.terminal_tool.as_deref() {
                if step >= params.max_model_calls || step >= max_steps {
                    let error = AgentError::MissingTerminalTool(terminal_tool.to_string());
                    emit(
                        &transport,
                        &params,
                        RuntimeEventData::RunFailed {
                            error: error.to_string(),
                            code: "terminal-tool-missing".into(),
                        },
                    )
                    .await;
                    return Err(error);
                }
                messages.push(ChatMessage::text("assistant", result.content));
                messages.push(ChatMessage::text(
                    "user",
                    format!("Do not return another plain-text response. Submit the structured result now by calling the required terminal tool `{terminal_tool}`."),
                ));
                force_terminal_tool = true;
                continue;
            }
            emit(
                &transport,
                &params,
                RuntimeEventData::MessageCompleted {
                    content: result.content,
                },
            )
            .await;
            emit(&transport, &params, RuntimeEventData::RunCompleted).await;
            return Ok(());
        }

        let assistant_content = result.content.clone();
        messages.push(ChatMessage {
            role: "assistant".into(),
            content: if result.content.is_empty() {
                None
            } else {
                Some(result.content)
            },
            tool_call_id: None,
            tool_calls: Some(result.tool_calls.clone()),
        });

        let mut requires_followup = false;
        for call in result.tool_calls {
            let tool_name = call.function.name.clone();
            if !allowed_tools.contains(&tool_name) {
                return Err(fail_tool(
                    &transport,
                    &params,
                    &tool_name,
                    "tool-not-allowed",
                    format!("tool is not allowed in the active ESPow Skill: {tool_name}"),
                )
                .await);
            }
            emit(
                &transport,
                &params,
                RuntimeEventData::ToolStarted {
                    step,
                    tool_name: tool_name.clone(),
                    call_id: call.id.clone(),
                },
            )
            .await;

            let args: Value = if call.function.arguments.trim().is_empty() {
                json!({})
            } else {
                match serde_json::from_str(&call.function.arguments) {
                    Ok(value) => value,
                    Err(error) => {
                        requires_followup = true;
                        emit(
                            &transport,
                            &params,
                            RuntimeEventData::FollowupDecision {
                                step,
                                tool_name: tool_name.clone(),
                                required: true,
                                reason: "REPLAN_REQUIRED".into(),
                            },
                        )
                        .await;
                        compact_failed_tool_arguments(&mut messages, &call.id);
                        messages.push(ChatMessage::tool(
                            call.id,
                            invalid_tool_arguments_content(&error),
                        ));
                        if params.terminal_tool.as_deref() == Some(tool_name.as_str()) {
                            force_terminal_tool = true;
                        }
                        continue;
                    }
                }
            };

            let signature = format!(
                "{}:{}",
                tool_name,
                serde_json::to_string(&args).unwrap_or_default()
            );
            let repeat_count = repeated_calls.entry(signature).or_insert(0);
            *repeat_count += 1;
            if *repeat_count > 2 {
                requires_followup = true;
                emit(
                    &transport,
                    &params,
                    RuntimeEventData::FollowupDecision {
                        step,
                        tool_name: tool_name.clone(),
                        required: true,
                        reason: "REPLAN_REQUIRED".into(),
                    },
                )
                .await;
                messages.push(ChatMessage::tool(
                    call.id.clone(),
                    serde_json::to_string(&json!({
                        "ok": false,
                        "error": {
                            "code": "REPEATED_TOOL_CALL",
                            "message": "Same tool with the same arguments was already attempted twice. Reuse the existing result or choose a different action."
                        }
                    }))
                    .unwrap_or_default(),
                ));
                emit(
                    &transport,
                    &params,
                    RuntimeEventData::ToolCompleted {
                        step,
                        tool_name,
                        call_id: call.id,
                    },
                )
                .await;
                continue;
            }

            let request = tool_client
                .post(&params.tool_bridge.url)
                .bearer_auth(&params.tool_bridge.token)
                .json(&json!({ "callId": call.id, "name": tool_name, "args": args }))
                .send();

            let response = tokio::select! {
                _ = cancellation.cancelled() => {
                    emit(&transport, &params, RuntimeEventData::RunCancelled).await;
                    return Err(ModelError::Cancelled.into());
                }
                value = request => match value {
                    Ok(response) => response,
                    Err(error) => {
                        return Err(fail_tool(&transport, &params, &tool_name, "tool-network", error.to_string()).await);
                    }
                },
            };

            let status = response.status();
            let body: Value = tokio::select! {
                _ = cancellation.cancelled() => {
                    emit(&transport, &params, RuntimeEventData::RunCancelled).await;
                    return Err(ModelError::Cancelled.into());
                }
                value = response.json() => match value {
                    Ok(body) => body,
                    Err(error) => {
                        return Err(fail_tool(&transport, &params, &tool_name, "tool-invalid-response", error.to_string()).await);
                    }
                }
            };
            if !status.is_success() || body.get("ok").and_then(Value::as_bool) != Some(true) {
                let message = body
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("tool failed")
                    .to_string();
                if tool_failure_is_recoverable(status) {
                    requires_followup = true;
                    let reason = body
                        .pointer("/error/code")
                        .and_then(Value::as_str)
                        .filter(|code| code.contains("CONFLICT") || *code == "SOURCE_CHANGED")
                        .map_or("EXECUTION_FAILED", |_| "CONFLICT_FOUND");
                    emit(
                        &transport,
                        &params,
                        RuntimeEventData::FollowupDecision {
                            step,
                            tool_name: tool_name.clone(),
                            required: true,
                            reason: reason.into(),
                        },
                    )
                    .await;
                    compact_failed_tool_arguments(&mut messages, &call.id);
                    messages.push(ChatMessage::tool(call.id, tool_error_content(&body)));
                    continue;
                }
                return Err(
                    fail_tool(&transport, &params, &tool_name, "tool-failed", message).await,
                );
            }

            let output = body.get("output").cloned().unwrap_or(Value::Null);
            emit(
                &transport,
                &params,
                RuntimeEventData::ToolCompleted {
                    step,
                    tool_name: tool_name.clone(),
                    call_id: call.id.clone(),
                },
            )
            .await;
            let (required, reason) = followup_decision(&output);
            emit(
                &transport,
                &params,
                RuntimeEventData::FollowupDecision {
                    step,
                    tool_name: tool_name.clone(),
                    required,
                    reason,
                },
            )
            .await;
            let is_required_terminal = params
                .terminal_tool
                .as_deref()
                .map_or(true, |name| name == tool_name);
            if is_required_terminal {
                if let Some(message) = terminal_tool_message(&output) {
                    emit(
                        &transport,
                        &params,
                        RuntimeEventData::MessageCompleted { content: message },
                    )
                    .await;
                    emit(&transport, &params, RuntimeEventData::RunCompleted).await;
                    return Ok(());
                }
            }
            if required {
                requires_followup = true;
            }
            messages.push(ChatMessage::tool(
                call.id.clone(),
                serde_json::to_string(&output).unwrap_or_else(|_| "null".into()),
            ));
        }
        if !requires_followup {
            let content = if assistant_content.trim().is_empty() {
                "操作已由 Runtime 执行完成。".to_string()
            } else {
                assistant_content
            };
            emit(
                &transport,
                &params,
                RuntimeEventData::MessageCompleted { content },
            )
            .await;
            emit(&transport, &params, RuntimeEventData::RunCompleted).await;
            return Ok(());
        }
    }

    let error = params
        .terminal_tool
        .clone()
        .map(AgentError::MissingTerminalTool)
        .unwrap_or(AgentError::MaxSteps(max_steps));
    emit(
        &transport,
        &params,
        RuntimeEventData::RunFailed {
            error: error.to_string(),
            code: if params.terminal_tool.is_some() {
                "terminal-tool-missing".into()
            } else {
                "max-steps".into()
            },
        },
    )
    .await;
    Err(error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_validation_error_is_serialized_for_model_retry() {
        let content = tool_error_content(&json!({
            "ok": false,
            "error": { "code": "INVALID_INPUT", "message": "semanticReady 必须是布尔值。" }
        }));
        let value: Value = serde_json::from_str(&content).expect("valid tool result");
        assert_eq!(value["ok"], false);
        assert_eq!(value["error"]["code"], "INVALID_INPUT");
        assert_eq!(value["error"]["message"], "semanticReady 必须是布尔值。");
    }

    #[test]
    fn malformed_tool_arguments_are_serialized_for_model_retry() {
        let error =
            serde_json::from_str::<Value>(r#"{{"answer":"x"}}"#).expect_err("invalid object key");
        let content = invalid_tool_arguments_content(&error);
        let value: Value = serde_json::from_str(&content).expect("valid tool result");
        assert_eq!(value["ok"], false);
        assert_eq!(value["error"]["code"], "INVALID_ARGUMENTS_JSON");
        assert!(value["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("valid JSON")));
    }

    #[test]
    fn failed_tool_arguments_are_compacted_before_retry() {
        let mut messages = vec![ChatMessage {
            role: "assistant".into(),
            content: None,
            tool_call_id: None,
            tool_calls: Some(vec![crate::model::AssistantToolCall {
                id: "call-1".into(),
                kind: "function".into(),
                function: crate::model::AssistantFunction {
                    name: "analysis_turn_submit".into(),
                    arguments: "x".repeat(8_000),
                },
            }]),
        }];

        compact_failed_tool_arguments(&mut messages, "call-1");

        assert_eq!(
            messages[0].tool_calls.as_ref().unwrap()[0]
                .function
                .arguments,
            "{}"
        );
    }

    #[test]
    fn only_tool_validation_failures_are_recoverable() {
        assert!(tool_failure_is_recoverable(
            reqwest::StatusCode::BAD_REQUEST
        ));
        assert!(!tool_failure_is_recoverable(
            reqwest::StatusCode::UNAUTHORIZED
        ));
        assert!(!tool_failure_is_recoverable(reqwest::StatusCode::CONFLICT));
        assert!(!tool_failure_is_recoverable(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR
        ));
    }

    #[test]
    fn terminal_tool_output_returns_user_reply() {
        let output = json!({"__espowTerminal": true, "assistantReply": "继续确认两个问题。"});
        assert_eq!(
            terminal_tool_message(&output).as_deref(),
            Some("继续确认两个问题。")
        );
        assert_eq!(terminal_tool_message(&json!({"assistantReply": "x"})), None);
    }

    #[test]
    fn followup_gate_defaults_to_compatibility_and_honors_runtime_decision() {
        assert_eq!(
            followup_decision(&json!({})),
            (true, "NEW_INFORMATION".into())
        );
        assert_eq!(
            followup_decision(
                &json!({"__espowFollowup":{"required":false,"reason":"NO_FOLLOWUP"}})
            ),
            (false, "NO_FOLLOWUP".into())
        );
    }

    #[test]
    fn breakdown_uses_tagged_final_context_and_runtime_history() {
        let params = RunStartParams {
            run_id: "run-1".into(),
            thread_id: "thread-1".into(),
            turn_id: "turn-1".into(),
            _cwd: "/tmp".into(),
            input: "workspace\n\nuser".into(),
            context_parts: vec![
                crate::protocol::ContextPart {
                    source: "workspace".into(),
                    content: "workspace".into(),
                },
                crate::protocol::ContextPart {
                    source: "user".into(),
                    content: "user".into(),
                },
            ],
            call_reason: "analysis".into(),
            system_prompt: "system".into(),
            model: crate::protocol::RuntimeModelConfig {
                provider: "openai".into(),
                api_key: "test".into(),
                model: "test".into(),
                base_url: "https://example.com".into(),
            },
            tools: vec![],
            tool_bridge: crate::protocol::ToolBridgeConfig {
                url: "http://127.0.0.1".into(),
                token: "test".into(),
            },
            max_steps: 2,
            max_model_calls: 2,
            max_input_tokens: 24_000,
            max_output_tokens: 100,
            terminal_tool: None,
        };
        let messages = vec![
            ChatMessage::text("system", "system"),
            ChatMessage::text("user", params.input.clone()),
            ChatMessage::text("assistant", "follow-up"),
        ];
        let (estimated, breakdown) = input_breakdown(&params, &messages);
        assert!(estimated > 0);
        assert_eq!(breakdown.len(), 11);
        assert!(breakdown.iter().any(|item| item.source == "workspace"));
        assert!(breakdown.iter().any(|item| item.source == "user"));
        assert!(breakdown
            .iter()
            .any(|item| item.source == "history" && item.tokens > 0));
        assert!(breakdown
            .iter()
            .any(|item| item.source == "tools" && item.tokens == 0));
    }
}
