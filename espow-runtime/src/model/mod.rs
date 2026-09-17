use std::collections::BTreeMap;

use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use crate::protocol::{RuntimeModelConfig, ToolSpec};

#[derive(Debug, Error)]
pub enum ModelError {
    #[error("provider authentication failed: {0}")]
    Authentication(String),
    #[error("provider rate limit or quota error: {0}")]
    RateLimit(String),
    #[error("provider model/config error: {0}")]
    Config(String),
    #[error("provider network error: {0}")]
    Network(String),
    #[error("provider request timed out: {0}")]
    Timeout(String),
    #[error("provider error: {0}")]
    Provider(String),
    #[error("provider stream error: {0}")]
    Stream(String),
    #[error("request cancelled")]
    Cancelled,
}

impl ModelError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Authentication(_) => "MODEL_AUTH_FAILED",
            Self::RateLimit(_) => "MODEL_RATE_LIMITED",
            Self::Config(_) => "MODEL_CONFIG_INVALID",
            Self::Network(_) => "MODEL_REQUEST_FAILED",
            Self::Timeout(_) => "MODEL_TIMEOUT",
            Self::Provider(_) => "MODEL_REQUEST_FAILED",
            Self::Stream(_) => "MODEL_STREAM_FAILED",
            Self::Cancelled => "RUN_CANCELLED",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<AssistantToolCall>>,
}

impl ChatMessage {
    pub fn text(role: &str, content: impl Into<String>) -> Self {
        Self {
            role: role.into(),
            content: Some(content.into()),
            tool_call_id: None,
            tool_calls: None,
        }
    }
    pub fn tool(call_id: String, content: String) -> Self {
        Self {
            role: "tool".into(),
            content: Some(content),
            tool_call_id: Some(call_id),
            tool_calls: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssistantToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub function: AssistantFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssistantFunction {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Default)]
pub struct ModelUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Debug, Clone)]
pub struct ModelStepResult {
    pub content: String,
    pub tool_calls: Vec<AssistantToolCall>,
    pub usage: Option<ModelUsage>,
}

#[derive(Debug, Deserialize)]
struct StreamChunk {
    #[serde(default)]
    choices: Vec<Choice>,
    usage: Option<UsageWire>,
    error: Option<ProviderErrorWire>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    #[serde(default)]
    delta: Delta,
}

#[derive(Debug, Default, Deserialize)]
struct Delta {
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<ToolCallDelta>,
}

#[derive(Debug, Deserialize)]
struct ToolCallDelta {
    index: usize,
    id: Option<String>,
    function: Option<FunctionDelta>,
}

#[derive(Debug, Deserialize)]
struct FunctionDelta {
    name: Option<String>,
    arguments: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UsageWire {
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
    total_tokens: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct ProviderErrorWire {
    message: Option<String>,
}

#[derive(Default)]
struct ToolAccumulator {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Default)]
struct SseDecoder {
    buffer: Vec<u8>,
}

impl SseDecoder {
    fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, ModelError> {
        self.buffer.extend_from_slice(chunk);
        let mut events = Vec::new();
        while let Some((index, delimiter_len)) = find_sse_delimiter(&self.buffer) {
            let block = self.buffer[..index].to_vec();
            self.buffer.drain(..index + delimiter_len);
            if let Some(data) = decode_sse_block(&block)? {
                events.push(data);
            }
        }
        Ok(events)
    }

    fn finish(&mut self) -> Result<Vec<String>, ModelError> {
        if self.buffer.is_empty() {
            return Ok(Vec::new());
        }
        let block = std::mem::take(&mut self.buffer);
        Ok(decode_sse_block(&block)?.into_iter().collect())
    }
}

fn find_sse_delimiter(buffer: &[u8]) -> Option<(usize, usize)> {
    for index in 0..buffer.len() {
        if buffer[index..].starts_with(b"\r\n\r\n") {
            return Some((index, 4));
        }
        if buffer[index..].starts_with(b"\n\n") {
            return Some((index, 2));
        }
    }
    None
}

fn decode_sse_block(block: &[u8]) -> Result<Option<String>, ModelError> {
    let text = std::str::from_utf8(block)
        .map_err(|error| ModelError::Stream(format!("invalid SSE UTF-8: {error}")))?;
    let data = text
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim_start)
        .collect::<Vec<_>>()
        .join("\n");
    Ok((!data.is_empty()).then_some(data))
}

fn truncate_utf8(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

pub(crate) fn tool_definitions(tools: &[ToolSpec]) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| {
            json!({
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters
                }
            })
        })
        .collect()
}

fn request_body(
    config: &RuntimeModelConfig,
    messages: &[ChatMessage],
    tools: &[ToolSpec],
    max_output_tokens: usize,
    forced_tool: Option<&str>,
) -> Value {
    let tool_values = tool_definitions(tools);
    let mut body = json!({
        "model": config.model,
        "messages": messages,
        "stream": true,
        "stream_options": { "include_usage": true }
    });
    if config.provider == "deepseek" {
        body["thinking"] = json!({ "type": "disabled" });
    } else {
        body["max_tokens"] = json!(max_output_tokens);
    }
    if !tool_values.is_empty() {
        body["tools"] = Value::Array(tool_values);
        body["tool_choice"] = forced_tool.map_or_else(
            || Value::String("auto".into()),
            |name| json!({ "type": "function", "function": { "name": name } }),
        );
    }
    body
}

pub struct OpenAiCompatibleProvider {
    client: Client,
}

impl OpenAiCompatibleProvider {
    pub fn new() -> Result<Self, ModelError> {
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(180))
            .build()
            .map_err(|error| ModelError::Network(error.to_string()))?;
        Ok(Self { client })
    }

    pub async fn stream_step<F>(
        &self,
        config: &RuntimeModelConfig,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
        max_output_tokens: usize,
        forced_tool: Option<&str>,
        cancellation: &CancellationToken,
        mut on_delta: F,
    ) -> Result<ModelStepResult, ModelError>
    where
        F: FnMut(String),
    {
        if !matches!(config.provider.as_str(), "openai" | "deepseek") {
            return Err(ModelError::Config(format!(
                "unsupported provider: {}",
                config.provider
            )));
        }
        let base = config.base_url.trim().trim_end_matches('/');
        if base.is_empty() || reqwest::Url::parse(base).is_err() {
            return Err(ModelError::Config("Base URL is invalid".into()));
        }
        if config.api_key.trim().is_empty() {
            return Err(ModelError::Authentication("API Key is empty".into()));
        }
        if config.model.trim().is_empty() {
            return Err(ModelError::Config("model is empty".into()));
        }
        let endpoint = format!("{base}/chat/completions");
        let body = request_body(config, messages, tools, max_output_tokens, forced_tool);
        let request = self
            .client
            .post(endpoint)
            .bearer_auth(&config.api_key)
            .json(&body)
            .send();
        let response = tokio::select! {
            _ = cancellation.cancelled() => return Err(ModelError::Cancelled),
            value = request => value.map_err(|error| {
                if error.is_timeout() { ModelError::Timeout(error.to_string()) }
                else { ModelError::Network(error.to_string()) }
            })?,
        };
        if !response.status().is_success() {
            let status = response.status();
            let detail = response.text().await.unwrap_or_default();
            let message = truncate_utf8(&detail, 800).to_string();
            return Err(match status.as_u16() {
                401 | 403 => ModelError::Authentication(message),
                400 | 404 | 422 => ModelError::Config(message),
                408 | 504 => ModelError::Timeout(message),
                429 => ModelError::RateLimit(message),
                500..=599 => ModelError::Provider(format!("HTTP {}: {}", status.as_u16(), message)),
                _ => ModelError::Provider(format!("HTTP {}: {}", status.as_u16(), message)),
            });
        }

        let mut stream = response.bytes_stream();
        let mut decoder = SseDecoder::default();
        let mut content = String::new();
        let mut tools_by_index: BTreeMap<usize, ToolAccumulator> = BTreeMap::new();
        let mut usage: Option<ModelUsage> = None;
        let mut done = false;

        while !done {
            let chunk = tokio::select! {
                _ = cancellation.cancelled() => return Err(ModelError::Cancelled),
                value = stream.next() => value,
            };
            let Some(chunk) = chunk else {
                break;
            };
            let bytes = chunk.map_err(|error| ModelError::Stream(error.to_string()))?;
            for data in decoder.push(&bytes)? {
                let data = data.trim();
                if data == "[DONE]" {
                    done = true;
                    break;
                }
                if data.is_empty() {
                    continue;
                }
                let parsed: StreamChunk = serde_json::from_str(data)
                    .map_err(|error| ModelError::Stream(format!("invalid SSE JSON: {error}")))?;
                if let Some(error) = parsed.error {
                    return Err(ModelError::Stream(
                        error.message.unwrap_or_else(|| "provider error".into()),
                    ));
                }
                if let Some(value) = parsed.usage {
                    let input = value.prompt_tokens.unwrap_or(0);
                    let output = value.completion_tokens.unwrap_or(0);
                    usage = Some(ModelUsage {
                        input_tokens: input,
                        output_tokens: output,
                        total_tokens: value.total_tokens.unwrap_or(input + output),
                    });
                }
                for choice in parsed.choices {
                    if let Some(delta) = choice.delta.content {
                        content.push_str(&delta);
                        on_delta(delta);
                    }
                    for tool_delta in choice.delta.tool_calls {
                        let entry = tools_by_index.entry(tool_delta.index).or_default();
                        if let Some(id) = tool_delta.id {
                            entry.id.push_str(&id);
                        }
                        if let Some(function) = tool_delta.function {
                            if let Some(name) = function.name {
                                entry.name.push_str(&name);
                            }
                            if let Some(arguments) = function.arguments {
                                entry.arguments.push_str(&arguments);
                            }
                        }
                    }
                }
            }
        }
        if !done {
            for data in decoder.finish()? {
                let data = data.trim();
                if data == "[DONE]" {
                    done = true;
                    break;
                }
                if data.is_empty() {
                    continue;
                }
                let parsed: StreamChunk = serde_json::from_str(data)
                    .map_err(|error| ModelError::Stream(format!("invalid SSE JSON: {error}")))?;
                if let Some(error) = parsed.error {
                    return Err(ModelError::Stream(
                        error.message.unwrap_or_else(|| "provider error".into()),
                    ));
                }
                if let Some(value) = parsed.usage {
                    let input = value.prompt_tokens.unwrap_or(0);
                    let output = value.completion_tokens.unwrap_or(0);
                    usage = Some(ModelUsage {
                        input_tokens: input,
                        output_tokens: output,
                        total_tokens: value.total_tokens.unwrap_or(input + output),
                    });
                }
                for choice in parsed.choices {
                    if let Some(delta) = choice.delta.content {
                        content.push_str(&delta);
                        on_delta(delta);
                    }
                    for tool_delta in choice.delta.tool_calls {
                        let entry = tools_by_index.entry(tool_delta.index).or_default();
                        if let Some(id) = tool_delta.id {
                            entry.id.push_str(&id);
                        }
                        if let Some(function) = tool_delta.function {
                            if let Some(name) = function.name {
                                entry.name.push_str(&name);
                            }
                            if let Some(arguments) = function.arguments {
                                entry.arguments.push_str(&arguments);
                            }
                        }
                    }
                }
            }
        }
        if !done && content.is_empty() && tools_by_index.is_empty() {
            return Err(ModelError::Stream(
                "stream ended before a response was produced".into(),
            ));
        }
        let tool_calls = tools_by_index
            .into_values()
            .map(|item| AssistantToolCall {
                id: if item.id.is_empty() {
                    uuid::Uuid::new_v4().to_string()
                } else {
                    item.id
                },
                kind: "function".into(),
                function: AssistantFunction {
                    name: item.name,
                    arguments: item.arguments,
                },
            })
            .collect();
        Ok(ModelStepResult {
            content,
            tool_calls,
            usage,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model_config(provider: &str) -> RuntimeModelConfig {
        RuntimeModelConfig {
            provider: provider.into(),
            api_key: "test-key".into(),
            model: "test-model".into(),
            base_url: "https://example.com".into(),
        }
    }

    #[test]
    fn deepseek_request_disables_thinking_without_output_limit() {
        let body = request_body(&model_config("deepseek"), &[], &[], 1_200, None);
        assert_eq!(body["thinking"]["type"], "disabled");
        assert!(body.get("max_tokens").is_none());
    }

    #[test]
    fn openai_request_keeps_output_limit() {
        let body = request_body(&model_config("openai"), &[], &[], 1_200, None);
        assert_eq!(body["max_tokens"], 1_200);
        assert!(body.get("thinking").is_none());
    }

    #[test]
    fn request_can_force_a_terminal_tool() {
        let tool = ToolSpec {
            name: "analysis_turn_submit".into(),
            description: "submit".into(),
            parameters: json!({ "type": "object" }),
        };
        let body = request_body(
            &model_config("deepseek"),
            &[],
            &[tool],
            1_200,
            Some("analysis_turn_submit"),
        );
        assert_eq!(body["tool_choice"]["type"], "function");
        assert_eq!(
            body["tool_choice"]["function"]["name"],
            "analysis_turn_submit"
        );
    }

    #[test]
    fn sse_decoder_preserves_utf8_split_across_network_chunks() {
        let wire = "data: {\"choices\":[{\"delta\":{\"content\":\"中文\"}}]}\n\n".as_bytes();
        let split = wire
            .iter()
            .position(|byte| *byte >= 0x80)
            .expect("Chinese UTF-8 bytes")
            + 1;
        let mut decoder = SseDecoder::default();
        assert!(decoder
            .push(&wire[..split])
            .expect("first chunk")
            .is_empty());
        let events = decoder.push(&wire[split..]).expect("second chunk");
        assert_eq!(
            events,
            vec!["{\"choices\":[{\"delta\":{\"content\":\"中文\"}}]}"]
        );
    }

    #[test]
    fn sse_decoder_flushes_final_event_without_blank_line() {
        let mut decoder = SseDecoder::default();
        assert!(decoder
            .push("data: 最终内容".as_bytes())
            .expect("chunk")
            .is_empty());
        assert_eq!(decoder.finish().expect("finish"), vec!["最终内容"]);
    }

    #[test]
    fn utf8_truncation_never_splits_a_character() {
        let value = "错误".repeat(500);
        let truncated = truncate_utf8(&value, 800);
        assert!(truncated.len() <= 800);
        assert!(value.starts_with(truncated));
        assert!(!truncated.contains('\u{fffd}'));
    }
}
