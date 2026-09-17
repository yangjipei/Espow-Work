use std::sync::Arc;

use serde::Serialize;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::Mutex,
};

pub struct StdioTransport {
    reader: Mutex<tokio::io::Lines<BufReader<tokio::io::Stdin>>>,
    writer: Mutex<tokio::io::Stdout>,
}

impl StdioTransport {
    pub fn new() -> Self {
        Self {
            reader: Mutex::new(BufReader::new(tokio::io::stdin()).lines()),
            writer: Mutex::new(tokio::io::stdout()),
        }
    }

    pub async fn next_line(&self) -> Option<String> {
        self.reader
            .lock()
            .await
            .next_line()
            .await
            .unwrap_or_default()
    }

    pub async fn write_value<T: Serialize>(&self, value: &T) {
        let serialized = match serde_json::to_string(value) {
            Ok(value) => value,
            Err(_) => return,
        };
        let mut writer = self.writer.lock().await;
        if writer.write_all(serialized.as_bytes()).await.is_ok() {
            let _ = writer.write_all(b"\n").await;
            let _ = writer.flush().await;
        }
    }
}

pub type SharedTransport = Arc<StdioTransport>;
