use std::path::Path;

use playwright_rs::protocol::{BrowserContext, BrowserContextOptions, Playwright, Viewport};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiLearningStartParams {
    pub url: String,
    pub profile_dir: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiLearningCaptureParams {
    pub script: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiLearningScreenshotParams {
    pub path: String,
    pub sanitize_css: String,
}

struct UiLearningSession {
    // Playwright must outlive the browser context/connection it owns.
    _playwright: Playwright,
    context: BrowserContext,
}

#[derive(Default)]
pub struct UiLearningManager {
    session: Option<UiLearningSession>,
}

impl UiLearningManager {
    pub fn is_active(&self) -> bool {
        self.session
            .as_ref()
            .map(|session| session.context.pages().iter().any(|page| !page.is_closed()))
            .unwrap_or(false)
    }

    pub async fn start(&mut self, params: UiLearningStartParams) -> Result<Value, String> {
        if !params.url.starts_with("http://") && !params.url.starts_with("https://") {
            return Err("UI learning only supports http/https URLs".into());
        }
        let _ = self.stop().await;
        tokio::fs::create_dir_all(&params.profile_dir)
            .await
            .map_err(|error| format!("Failed to create UI learning profile: {error}"))?;

        let playwright = Playwright::launch()
            .await
            .map_err(|error| format!("Failed to initialize Rust Playwright: {error}"))?;
        let chromium = playwright.chromium();
        let mut last_error = None;
        let mut context = None;

        // Prefer the user's locally installed browser so ESPow does not need a browser
        // download on every machine. The profile is dedicated to ESPow UI learning only.
        for channel in ["chrome", "msedge"] {
            let options = BrowserContextOptions::builder()
                .channel(channel.to_string())
                .headless(false)
                .viewport(Viewport { width: 1440, height: 900 })
                .accept_downloads(false)
                .args(vec!["--start-maximized".to_string()])
                .build();
            match chromium
                .launch_persistent_context_with_options(params.profile_dir.clone(), options)
                .await
            {
                Ok(value) => {
                    context = Some(value);
                    break;
                }
                Err(error) => last_error = Some(error.to_string()),
            }
        }

        let context = context.ok_or_else(|| {
            format!(
                "No usable local Chrome/Edge was found for Rust Playwright{}",
                last_error
                    .map(|value| format!(": {value}"))
                    .unwrap_or_default()
            )
        })?;

        let page = match context
            .pages()
            .into_iter()
            .filter(|page| !page.is_closed())
            .last()
        {
            Some(page) => page,
            None => context
                .new_page()
                .await
                .map_err(|error| format!("Failed to create UI learning page: {error}"))?,
        };

        if page.url() != params.url {
            page.goto(&params.url, None)
                .await
                .map_err(|error| format!("Failed to open UI learning URL: {error}"))?;
        }
        page.bring_to_front().await.ok();

        self.session = Some(UiLearningSession {
            _playwright: playwright,
            context,
        });
        Ok(json!({ "active": true, "url": page.url(), "engine": "rust-playwright" }))
    }

    pub async fn focus(&mut self) -> Result<Value, String> {
        let page = self.latest_page()?;
        page.bring_to_front()
            .await
            .map_err(|error| format!("Failed to focus UI learning browser: {error}"))?;
        Ok(json!({ "active": true, "url": page.url() }))
    }

    pub async fn capture(&mut self, params: UiLearningCaptureParams) -> Result<Value, String> {
        let page = self.latest_page()?;
        let url = page.url();
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Ok(json!({ "active": true, "capture": Value::Null }));
        }
        let capture: Value = page
            .evaluate(&params.script, None::<&()>)
            .await
            .map_err(|error| format!("Failed to capture UI structure: {error}"))?;
        Ok(json!({ "active": true, "capture": capture }))
    }

    pub async fn screenshot(&mut self, params: UiLearningScreenshotParams) -> Result<Value, String> {
        let page = self.latest_page()?;
        let path = Path::new(&params.path);
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| format!("Failed to create screenshot directory: {error}"))?;
        }

        let css_json = serde_json::to_string(&params.sanitize_css)
            .map_err(|error| format!("Failed to encode sanitize CSS: {error}"))?;
        let inject = format!(
            "(() => {{ const old=document.getElementById('__espow_ui_sanitize'); if(old) old.remove(); const s=document.createElement('style'); s.id='__espow_ui_sanitize'; s.textContent={css_json}; document.documentElement.appendChild(s); }})()"
        );
        page.evaluate_expression(&inject)
            .await
            .map_err(|error| format!("Failed to sanitize UI screenshot: {error}"))?;

        let shot = page.screenshot_to_file(path, None).await;
        let _ = page
            .evaluate_expression("(() => document.getElementById('__espow_ui_sanitize')?.remove())()")
            .await;
        shot.map_err(|error| format!("Failed to save UI screenshot: {error}"))?;
        Ok(json!({ "ok": true, "path": params.path }))
    }

    pub async fn stop(&mut self) -> Result<Value, String> {
        if let Some(session) = self.session.take() {
            session
                .context
                .close()
                .await
                .map_err(|error| format!("Failed to close UI learning browser: {error}"))?;
        }
        Ok(json!({ "active": false }))
    }

    pub fn status(&self) -> Value {
        let active = self.is_active();
        let url = self
            .session
            .as_ref()
            .and_then(|session| {
                session
                    .context
                    .pages()
                    .into_iter()
                    .filter(|page| !page.is_closed())
                    .last()
                    .map(|page| page.url())
            });
        json!({ "active": active, "url": url })
    }

    fn latest_page(&self) -> Result<playwright_rs::protocol::Page, String> {
        let session = self
            .session
            .as_ref()
            .ok_or_else(|| "UI learning browser is not active".to_string())?;
        session
            .context
            .pages()
            .into_iter()
            .filter(|page| !page.is_closed())
            .last()
            .ok_or_else(|| "UI learning browser has been closed".to_string())
    }
}
