use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcRequest {
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcError {
    pub code: RuntimeErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeErrorCode {
    ProtocolError,
    MethodNotFound,
    RunConflict,
}

pub fn success_response(id: String, result: Value) -> RpcResponse {
    RpcResponse {
        id: Some(id),
        result: Some(result),
        error: None,
    }
}

pub fn error_response(id: Option<String>, code: RuntimeErrorCode, message: String) -> RpcResponse {
    RpcResponse {
        id,
        result: None,
        error: Some(RpcError { code, message }),
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStartParams {
    pub run_id: String,
    pub thread_id: String,
    pub turn_id: String,
    #[serde(rename = "cwd")]
    pub _cwd: String,
    pub input: String,
    #[serde(default)]
    pub context_parts: Vec<ContextPart>,
    #[serde(default = "default_call_reason")]
    pub call_reason: String,
    pub system_prompt: String,
    pub model: RuntimeModelConfig,
    #[serde(default)]
    pub tools: Vec<ToolSpec>,
    pub tool_bridge: ToolBridgeConfig,
    #[serde(default = "default_max_steps")]
    pub max_steps: usize,
    #[serde(default = "default_max_model_calls")]
    pub max_model_calls: usize,
    #[serde(default = "default_max_input_tokens")]
    pub max_input_tokens: usize,
    #[serde(default = "default_max_output_tokens")]
    pub max_output_tokens: usize,
    #[serde(default)]
    pub terminal_tool: Option<String>,
}

fn default_call_reason() -> String {
    "other".into()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextPart {
    pub source: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenBreakdownItem {
    pub source: String,
    pub tokens: usize,
    pub percentage: f64,
}

fn default_max_steps() -> usize {
    12
}

fn default_max_model_calls() -> usize {
    1
}
fn default_max_input_tokens() -> usize {
    24_000
}
fn default_max_output_tokens() -> usize {
    1_200
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCancelParams {
    pub run_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeModelConfig {
    pub provider: String,
    pub api_key: String,
    pub model: String,
    pub base_url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolBridgeConfig {
    pub url: String,
    pub token: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RuntimeEventData {
    RunStarted,
    ModelStarted {
        step: usize,
        call_id: String,
        call_reason: String,
    },
    MessageDelta {
        delta: String,
    },
    MessageCompleted {
        content: String,
    },
    ToolStarted {
        step: usize,
        tool_name: String,
        call_id: String,
    },
    ToolCompleted {
        step: usize,
        tool_name: String,
        call_id: String,
    },
    FollowupDecision {
        step: usize,
        tool_name: String,
        required: bool,
        reason: String,
    },
    ModelUsage {
        step: usize,
        call_id: String,
        call_reason: String,
        duration_ms: u64,
        input_tokens: u64,
        output_tokens: u64,
        total_tokens: u64,
        execution_content: String,
        message_count: usize,
        tool_count: usize,
        system_prompt_chars: usize,
        context_package_chars: usize,
        tool_schema_chars: usize,
        assistant_history_chars: usize,
        tool_result_chars: usize,
        estimated_input_tokens: usize,
        history_tokens: usize,
        input_breakdown: Vec<TokenBreakdownItem>,
    },
    RunCompleted,
    RunFailed {
        error: String,
        code: String,
    },
    RunCancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEventEnvelope {
    pub event_id: String,
    pub run_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub created_at: String,
    #[serde(flatten)]
    pub data: RuntimeEventData,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ping_request() {
        let request: RpcRequest =
            serde_json::from_str(r#"{"id":"1","method":"runtime.ping","params":{}}"#)
                .expect("valid request");
        assert_eq!(request.id, "1");
        assert_eq!(request.method, "runtime.ping");
    }

    #[test]
    fn serializes_success_response() {
        let response = success_response("1".into(), serde_json::json!({"ok": true}));
        let value = serde_json::to_value(response).expect("serializable response");
        assert_eq!(value["id"], "1");
        assert_eq!(value["result"]["ok"], true);
        assert!(value.get("error").is_none());
    }

    #[test]
    fn serializes_runtime_event_as_wire_contract() {
        let event = RuntimeEventEnvelope {
            event_id: "event-1".into(),
            run_id: "run-1".into(),
            thread_id: "thread-1".into(),
            turn_id: "turn-1".into(),
            created_at: "1".into(),
            data: RuntimeEventData::ModelUsage {
                step: 1,
                call_id: "call-1".into(),
                call_reason: "analysis".into(),
                duration_ms: 125,
                input_tokens: 10,
                output_tokens: 4,
                total_tokens: 14,
                execution_content: "Agent Step 1".into(),
                message_count: 2,
                tool_count: 1,
                system_prompt_chars: 20,
                context_package_chars: 30,
                tool_schema_chars: 40,
                assistant_history_chars: 0,
                tool_result_chars: 0,
                estimated_input_tokens: 11,
                history_tokens: 2,
                input_breakdown: vec![TokenBreakdownItem {
                    source: "system".into(),
                    tokens: 3,
                    percentage: 27.3,
                }],
            },
        };
        let value = serde_json::to_value(event).expect("serializable event");
        assert_eq!(value["type"], "model_usage");
        assert_eq!(value["historyTokens"], 2);
        assert_eq!(value["inputTokens"], 10);
        assert_eq!(value["runId"], "run-1");
        assert_eq!(value["callId"], "call-1");
        assert_eq!(value["callReason"], "analysis");
    }
}
