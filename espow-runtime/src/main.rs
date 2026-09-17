mod agent;
mod model;
mod protocol;
mod transport;
mod ui_learning;

use std::{collections::HashMap, sync::Arc};

use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use tracing::{error, info};

use crate::{
    agent::run_agent,
    protocol::{
        error_response, success_response, RpcRequest, RunCancelParams, RunStartParams,
        RuntimeErrorCode,
    },
    transport::StdioTransport,
    ui_learning::{UiLearningCaptureParams, UiLearningManager, UiLearningScreenshotParams, UiLearningStartParams},
};

const RUNTIME_VERSION: &str = env!("CARGO_PKG_VERSION");
const PROTOCOL_VERSION: &str = "1";

type ActiveRuns = Arc<Mutex<HashMap<String, CancellationToken>>>;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("espow_runtime=info".parse().expect("valid log level")),
        )
        .init();

    info!("ESPow Runtime starting");
    let transport = Arc::new(StdioTransport::new());
    let active_runs: ActiveRuns = Arc::new(Mutex::new(HashMap::new()));
    let mut ui_learning = UiLearningManager::default();

    while let Some(line) = transport.next_line().await {
        let request: RpcRequest = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                transport
                    .write_value(&error_response(
                        None,
                        RuntimeErrorCode::ProtocolError,
                        format!("Invalid JSON: {error}"),
                    ))
                    .await;
                continue;
            }
        };

        match request.method.as_str() {
            "runtime.initialize" => {
                transport
                    .write_value(&success_response(
                        request.id,
                        serde_json::json!({
                            "runtime": "espow-runtime",
                            "runtimeVersion": RUNTIME_VERSION,
                            "protocolVersion": PROTOCOL_VERSION
                        }),
                    ))
                    .await;
            }
            "runtime.ping" => {
                transport
                    .write_value(&success_response(
                        request.id,
                        serde_json::json!({ "ok": true }),
                    ))
                    .await;
            }
            "ui_learning.start" => {
                let params: UiLearningStartParams = match serde_json::from_value(request.params) {
                    Ok(value) => value,
                    Err(error) => {
                        transport.write_value(&error_response(Some(request.id), RuntimeErrorCode::ProtocolError, format!("Invalid ui_learning.start params: {error}"))).await;
                        continue;
                    }
                };
                match ui_learning.start(params).await {
                    Ok(result) => transport.write_value(&success_response(request.id, result)).await,
                    Err(error) => transport.write_value(&error_response(Some(request.id), RuntimeErrorCode::ProtocolError, error)).await,
                }
            }
            "ui_learning.focus" => {
                match ui_learning.focus().await {
                    Ok(result) => transport.write_value(&success_response(request.id, result)).await,
                    Err(error) => transport.write_value(&error_response(Some(request.id), RuntimeErrorCode::ProtocolError, error)).await,
                }
            }
            "ui_learning.capture" => {
                let params: UiLearningCaptureParams = match serde_json::from_value(request.params) {
                    Ok(value) => value,
                    Err(error) => {
                        transport.write_value(&error_response(Some(request.id), RuntimeErrorCode::ProtocolError, format!("Invalid ui_learning.capture params: {error}"))).await;
                        continue;
                    }
                };
                match ui_learning.capture(params).await {
                    Ok(result) => transport.write_value(&success_response(request.id, result)).await,
                    Err(error) => transport.write_value(&error_response(Some(request.id), RuntimeErrorCode::ProtocolError, error)).await,
                }
            }
            "ui_learning.screenshot" => {
                let params: UiLearningScreenshotParams = match serde_json::from_value(request.params) {
                    Ok(value) => value,
                    Err(error) => {
                        transport.write_value(&error_response(Some(request.id), RuntimeErrorCode::ProtocolError, format!("Invalid ui_learning.screenshot params: {error}"))).await;
                        continue;
                    }
                };
                match ui_learning.screenshot(params).await {
                    Ok(result) => transport.write_value(&success_response(request.id, result)).await,
                    Err(error) => transport.write_value(&error_response(Some(request.id), RuntimeErrorCode::ProtocolError, error)).await,
                }
            }
            "ui_learning.status" => {
                transport.write_value(&success_response(request.id, ui_learning.status())).await;
            }
            "ui_learning.stop" => {
                match ui_learning.stop().await {
                    Ok(result) => transport.write_value(&success_response(request.id, result)).await,
                    Err(error) => transport.write_value(&error_response(Some(request.id), RuntimeErrorCode::ProtocolError, error)).await,
                }
            }
            "run.start" => {
                let params: RunStartParams = match serde_json::from_value(request.params) {
                    Ok(value) => value,
                    Err(error) => {
                        transport
                            .write_value(&error_response(
                                Some(request.id),
                                RuntimeErrorCode::ProtocolError,
                                format!("Invalid run.start params: {error}"),
                            ))
                            .await;
                        continue;
                    }
                };
                let run_id = params.run_id.clone();
                let cancellation = CancellationToken::new();
                {
                    let mut runs = active_runs.lock().await;
                    if runs.contains_key(&run_id) {
                        transport
                            .write_value(&error_response(
                                Some(request.id),
                                RuntimeErrorCode::RunConflict,
                                "Run is already active".into(),
                            ))
                            .await;
                        continue;
                    }
                    runs.insert(run_id.clone(), cancellation.clone());
                }
                transport
                    .write_value(&success_response(
                        request.id,
                        serde_json::json!({ "accepted": true }),
                    ))
                    .await;
                let task_transport = transport.clone();
                let task_runs = active_runs.clone();
                tokio::spawn(async move {
                    if let Err(error) =
                        run_agent(params, cancellation, task_transport.clone()).await
                    {
                        error!(run_id = %run_id, detail = %error, "Agent run failed");
                    }
                    task_runs.lock().await.remove(&run_id);
                });
            }
            "run.cancel" => {
                let params: RunCancelParams = match serde_json::from_value(request.params) {
                    Ok(value) => value,
                    Err(error) => {
                        transport
                            .write_value(&error_response(
                                Some(request.id),
                                RuntimeErrorCode::ProtocolError,
                                format!("Invalid run.cancel params: {error}"),
                            ))
                            .await;
                        continue;
                    }
                };
                let token = active_runs.lock().await.get(&params.run_id).cloned();
                if let Some(token) = token.as_ref() {
                    token.cancel();
                }
                transport
                    .write_value(&success_response(
                        request.id,
                        serde_json::json!({ "cancelled": token.is_some() }),
                    ))
                    .await;
            }
            "runtime.shutdown" => {
                let _ = ui_learning.stop().await;
                let tokens: Vec<_> = active_runs.lock().await.values().cloned().collect();
                for token in tokens {
                    token.cancel();
                }
                transport
                    .write_value(&success_response(
                        request.id,
                        serde_json::json!({ "ok": true }),
                    ))
                    .await;
                break;
            }
            _ => {
                transport
                    .write_value(&error_response(
                        Some(request.id),
                        RuntimeErrorCode::MethodNotFound,
                        format!("Unknown method: {}", request.method),
                    ))
                    .await;
            }
        }
    }
    info!("ESPow Runtime stopped");
}
