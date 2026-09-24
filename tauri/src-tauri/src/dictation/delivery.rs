//! What to do with a finished capture: paste it, stop quietly, or show an
//! error. Mirrors the webview's former `deliverText` rules.

use serde_json::Value;

pub const SAVED_PREFIX: &str = "Text saved in Captures.";
pub const SHORT_RECORDING_MESSAGE: &str = "Recording too short, canceled";
pub const NO_FOCUS_MESSAGE: &str =
    "Could not identify the paste target. Check Accessibility permission.";
pub const TARGET_UNAVAILABLE_MESSAGE: &str =
    "Paste target unavailable. Copy the text from Captures.";

#[derive(Debug, Clone, PartialEq)]
pub enum Delivery {
    Paste(String),
    /// Nothing to paste (auto-paste off, or empty output). Not an error.
    Nothing,
    Error(String),
}

/// Decide delivery for a saved capture. `allow_auto_paste` is the value
/// snapshotted when the capture was created.
pub fn plan(capture: &Value, allow_auto_paste: bool, refinement_error: Option<&str>) -> Delivery {
    if let Some(error) = refinement_error.filter(|e| !e.is_empty()) {
        return Delivery::Error(format!("{SAVED_PREFIX} {error}"));
    }
    // Refined output wins even when empty: empty means "nothing to say".
    let text = capture
        .get("transcript_refined")
        .and_then(Value::as_str)
        .or_else(|| capture.get("transcript_raw").and_then(Value::as_str))
        .unwrap_or("");
    if !allow_auto_paste || text.trim().is_empty() {
        return Delivery::Nothing;
    }
    Delivery::Paste(text.to_string())
}

/// Delivery plan for a streaming `final` event.
pub fn plan_final(event: &Value) -> Delivery {
    let capture = event.get("capture").unwrap_or(&Value::Null);
    let allow_auto_paste = capture
        .get("allow_auto_paste")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    plan(
        capture,
        allow_auto_paste,
        event.get("refinement_error").and_then(Value::as_str),
    )
}

/// Error for the pill after a paste attempt; `None` when the paste landed.
/// The flag says whether the failure was the Accessibility permission.
pub fn paste_failure(result: Result<bool, String>) -> Option<(String, bool)> {
    match result {
        Ok(true) => None,
        Ok(false) => Some((format!("{SAVED_PREFIX} {TARGET_UNAVAILABLE_MESSAGE}"), false)),
        Err(message) => {
            let accessibility = message.to_lowercase().contains("accessibility");
            Some((format!("{SAVED_PREFIX} {message}"), accessibility))
        }
    }
}

/// A batch-upload error, translated to what the pill should say.
pub fn upload_failure(message: &str) -> String {
    let lower = message.to_lowercase();
    if lower.contains("could not decode") || lower.contains("empty or corrupt") {
        SHORT_RECORDING_MESSAGE.to_string()
    } else if message.is_empty() {
        "Upload failed".to_string()
    } else {
        message.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn refined_text_is_pasted() {
        let capture = json!({"transcript_raw": "hello", "transcript_refined": "Hello."});
        assert_eq!(plan(&capture, true, None), Delivery::Paste("Hello.".into()));
    }

    #[test]
    fn raw_text_is_used_without_refinement() {
        let capture = json!({"transcript_raw": "hello", "transcript_refined": null});
        assert_eq!(plan(&capture, true, None), Delivery::Paste("hello".into()));
    }

    #[test]
    fn empty_refined_output_is_meaningful_and_never_falls_back_to_raw() {
        let capture = json!({"transcript_raw": "um", "transcript_refined": ""});
        assert_eq!(plan(&capture, true, None), Delivery::Nothing);
    }

    #[test]
    fn whitespace_or_disabled_auto_paste_pastes_nothing() {
        let capture = json!({"transcript_raw": "  ", "transcript_refined": null});
        assert_eq!(plan(&capture, true, None), Delivery::Nothing);
        let capture = json!({"transcript_raw": "hello", "transcript_refined": null});
        assert_eq!(plan(&capture, false, None), Delivery::Nothing);
    }

    #[test]
    fn refinement_error_is_shown_and_not_pasted() {
        let capture = json!({"transcript_raw": "hello", "transcript_refined": null});
        assert_eq!(
            plan(&capture, true, Some("LLM failed")),
            Delivery::Error("Text saved in Captures. LLM failed".into())
        );
        // An empty error string is no error.
        assert_eq!(plan(&capture, true, Some("")), Delivery::Paste("hello".into()));
    }

    #[test]
    fn final_event_uses_the_captures_own_auto_paste_snapshot() {
        let event = json!({
            "type": "final",
            "capture": {"transcript_raw": "hi", "transcript_refined": "Hi.", "allow_auto_paste": false},
            "refinement_error": null
        });
        assert_eq!(plan_final(&event), Delivery::Nothing);
        let event = json!({
            "type": "final",
            "capture": {"transcript_raw": "hi", "transcript_refined": "Hi.", "allow_auto_paste": true},
            "refinement_error": "boom"
        });
        assert_eq!(
            plan_final(&event),
            Delivery::Error("Text saved in Captures. boom".into())
        );
        // Missing flag: default to allowing paste, as the webview did.
        let event = json!({"capture": {"transcript_raw": "hi"}});
        assert_eq!(plan_final(&event), Delivery::Paste("hi".into()));
    }

    #[test]
    fn paste_failures_become_saved_in_captures_messages() {
        assert_eq!(paste_failure(Ok(true)), None);
        assert_eq!(
            paste_failure(Ok(false)),
            Some((format!("{SAVED_PREFIX} {TARGET_UNAVAILABLE_MESSAGE}"), false))
        );
        let (message, accessibility) =
            paste_failure(Err("Accessibility permission required".into())).unwrap();
        assert_eq!(message, "Text saved in Captures. Accessibility permission required");
        assert!(accessibility);
    }

    #[test]
    fn undecodable_uploads_read_as_too_short() {
        assert_eq!(upload_failure("Could not decode audio"), SHORT_RECORDING_MESSAGE);
        assert_eq!(upload_failure("File is empty or corrupt"), SHORT_RECORDING_MESSAGE);
        assert_eq!(upload_failure("Model not loaded"), "Model not loaded");
        assert_eq!(upload_failure(""), "Upload failed");
    }
}
