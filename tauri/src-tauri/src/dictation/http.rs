//! HTTP calls the native take needs: result recovery, the batch fallback
//! upload and its refinement, and the learning pause.

use std::time::Duration;

use serde_json::Value;

use super::stream::{classify_recovery, Recovery};

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .tcp_nodelay(true)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

fn base(server_url: &str) -> &str {
    server_url.trim_end_matches('/')
}

/// `GET /captures/stream/{id}/result`.
pub async fn fetch_result(http: &reqwest::Client, server_url: &str, session_id: &str) -> Recovery {
    let url = format!("{}/captures/stream/{session_id}/result", base(server_url));
    let response = match http.get(url).timeout(Duration::from_secs(5)).send().await {
        Ok(response) => response,
        Err(_) => return Recovery::Pending,
    };
    let status = response.status().as_u16();
    let body = response.json::<Value>().await.ok();
    classify_recovery(Some(status), body.as_ref(), session_id)
}

/// The server's `detail` (string or validation list) or the HTTP status.
fn error_detail(status: reqwest::StatusCode, body: Option<Value>) -> String {
    match body.as_ref().and_then(|b| b.get("detail")) {
        Some(Value::String(detail)) => detail.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.get("msg").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("; "),
        _ => format!("HTTP error! status: {}", status.as_u16()),
    }
}

async fn json_or_error(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    if status.is_success() {
        response.json::<Value>().await.map_err(|e| e.to_string())
    } else {
        Err(error_detail(status, response.json::<Value>().await.ok()))
    }
}

/// `POST /captures` with the complete recording.
pub async fn upload(
    http: &reqwest::Client,
    server_url: &str,
    wav: Vec<u8>,
) -> Result<Value, String> {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    let file = reqwest::multipart::Part::bytes(wav)
        .file_name(format!("dictation-{millis}.wav"))
        .mime_str("audio/wav")
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .part("file", file)
        .text("source", "dictation");
    let response = http
        .post(format!("{}/captures", base(server_url)))
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_error(response).await
}

/// `POST /captures/{id}/refine` with an empty body (server-side settings).
pub async fn refine(
    http: &reqwest::Client,
    server_url: &str,
    capture_id: &str,
) -> Result<Value, String> {
    let response = http
        .post(format!("{}/captures/{capture_id}/refine", base(server_url)))
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    json_or_error(response).await
}

/// Tell background model learning to yield while the user records.
pub async fn pause_learning(http: &reqwest::Client, server_url: &str) {
    let _ = http
        .post(format!("{}/capture/learning/activity", base(server_url)))
        .timeout(Duration::from_secs(5))
        .send()
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Opt-in: the batch fallback's upload and refine against a real server
    /// (see `transport::tests::real_server_smoke`; it saves a capture).
    #[tokio::test]
    #[ignore]
    async fn real_server_batch_smoke() {
        let server = std::env::var("VOICEBOX_SMOKE_SERVER").expect("VOICEBOX_SMOKE_SERVER");
        let wav = std::fs::read(std::env::var("VOICEBOX_SMOKE_WAV").expect("VOICEBOX_SMOKE_WAV"))
            .unwrap();
        let http = client();
        let capture = upload(&http, &server, wav).await.unwrap();
        eprintln!(
            "[smoke] batch raw: {} auto_refine {} allow_auto_paste {}",
            capture["transcript_raw"], capture["auto_refine"], capture["allow_auto_paste"]
        );
        let id = capture["id"].as_str().unwrap();
        let refined = refine(&http, &server, id).await.unwrap();
        eprintln!("[smoke] batch refined: {}", refined["transcript_refined"]);
        assert_eq!(refined["id"], capture["id"]);
        let missing = fetch_result(&http, &server, "no-such-session").await;
        assert_eq!(missing, Recovery::Pending);
        let rejected = upload(&http, &server, b"not audio".to_vec())
            .await
            .unwrap_err();
        eprintln!("[smoke] bad upload: {rejected}");
    }

    #[test]
    fn error_detail_prefers_server_detail() {
        let status = reqwest::StatusCode::BAD_REQUEST;
        assert_eq!(
            error_detail(
                status,
                Some(serde_json::json!({"detail": "Could not decode audio"}))
            ),
            "Could not decode audio"
        );
        assert_eq!(
            error_detail(
                status,
                Some(serde_json::json!({"detail": [{"msg": "field required"}]}))
            ),
            "field required"
        );
        assert_eq!(error_detail(status, None), "HTTP error! status: 400");
    }
}
