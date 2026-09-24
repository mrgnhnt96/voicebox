//! `/captures/stream` protocol version 1 (docs/plans/STREAMING_DICTATION_PHASE_1.md).
//!
//! Pure encoding and decoding only, so the wire format is unit-tested without
//! a socket.

use serde_json::Value;

/// Bytes before the PCM payload: little-endian u32 sequence, then
/// little-endian u32 sample offset.
pub const HEADER_BYTES: usize = 8;
/// The whole binary message, header included, must not exceed this.
pub const MAX_MESSAGE_BYTES: usize = 65_536;
/// Largest PCM payload (in samples) that fits in one message.
pub const MAX_SAMPLES_PER_MESSAGE: usize = (MAX_MESSAGE_BYTES - HEADER_BYTES) / 2;

/// Encode one binary audio message.
pub fn encode_frame(sequence: u32, sample_offset: u32, pcm: &[i16]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(HEADER_BYTES + pcm.len() * 2);
    frame.extend_from_slice(&sequence.to_le_bytes());
    frame.extend_from_slice(&sample_offset.to_le_bytes());
    for sample in pcm {
        frame.extend_from_slice(&sample.to_le_bytes());
    }
    frame
}

/// The JSON start object sent right after the socket opens. `provisional`
/// asks for provisional cleaned text after release; older servers ignore it.
pub fn start_message(sample_rate: u32) -> String {
    serde_json::json!({
        "type": "start",
        "protocol_version": 1,
        "sample_rate": sample_rate,
        "channels": 1,
        "encoding": "pcm_s16le",
        "source": "dictation",
        "provisional": true,
    })
    .to_string()
}

pub fn finish_message() -> String {
    r#"{"type":"finish"}"#.to_string()
}

pub fn cancel_message() -> String {
    r#"{"type":"cancel"}"#.to_string()
}

/// A server message, reduced to what the client acts on.
#[derive(Debug, Clone, PartialEq)]
pub enum ServerEvent {
    Ready {
        session_id: String,
    },
    /// The raw `final` event; validate it with [`is_valid_final`].
    Final(Value),
    /// Cleaned text the server expects to keep, sent after `finish`.
    Provisional {
        session_id: Option<String>,
        text: String,
    },
    Error(String),
    /// `transcript` / `refined` updates and anything else informational.
    Update,
    /// Not JSON, or not an object.
    Invalid,
}

pub fn parse_server_event(text: &str) -> ServerEvent {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return ServerEvent::Invalid;
    };
    let Some(kind) = value.get("type").and_then(Value::as_str) else {
        return if value.is_object() {
            ServerEvent::Update
        } else {
            ServerEvent::Invalid
        };
    };
    match kind {
        "ready" => match value.get("session_id").and_then(Value::as_str) {
            Some(id) => ServerEvent::Ready {
                session_id: id.to_string(),
            },
            None => ServerEvent::Invalid,
        },
        "final" => ServerEvent::Final(value),
        "provisional" => match value.get("text").and_then(Value::as_str) {
            Some(text) => ServerEvent::Provisional {
                session_id: value
                    .get("session_id")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                text: text.to_string(),
            },
            None => ServerEvent::Update,
        },
        "error" => ServerEvent::Error(
            value
                .get("message")
                .and_then(Value::as_str)
                .filter(|m| !m.is_empty())
                .unwrap_or("Streaming finalization failed")
                .to_string(),
        ),
        _ => ServerEvent::Update,
    }
}

/// A `final` event is only trusted when it completes refinement for this
/// session and carries a transcript (possibly empty).
pub fn is_valid_final(event: &Value, session_id: &str) -> bool {
    event.get("type").and_then(Value::as_str) == Some("final")
        && event.get("refinement_complete") == Some(&Value::Bool(true))
        && event.pointer("/capture/id").and_then(Value::as_str) == Some(session_id)
        && event
            .pointer("/capture/transcript_raw")
            .map(Value::is_string)
            .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_has_little_endian_header_then_pcm() {
        let frame = encode_frame(1, 2, &[1, -2]);
        assert_eq!(frame, vec![1, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0xFE, 0xFF]);
    }

    #[test]
    fn largest_payload_fits_the_message_limit() {
        let pcm = vec![0i16; MAX_SAMPLES_PER_MESSAGE];
        assert_eq!(encode_frame(0, 0, &pcm).len(), MAX_MESSAGE_BYTES);
    }

    #[test]
    fn start_message_matches_protocol_v1() {
        let value: Value = serde_json::from_str(&start_message(48_000)).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "type": "start",
                "protocol_version": 1,
                "sample_rate": 48000,
                "channels": 1,
                "encoding": "pcm_s16le",
                "source": "dictation",
                "provisional": true,
            })
        );
    }

    #[test]
    fn parses_provisional_text() {
        assert_eq!(
            parse_server_event(r#"{"type":"provisional","session_id":"s1","text":"Hello there"}"#),
            ServerEvent::Provisional {
                session_id: Some("s1".into()),
                text: "Hello there".into()
            }
        );
        // Malformed provisional text is informational, never fatal.
        assert_eq!(
            parse_server_event(r#"{"type":"provisional"}"#),
            ServerEvent::Update
        );
    }

    #[test]
    fn parses_ready_error_and_updates() {
        assert_eq!(
            parse_server_event(r#"{"type":"ready","session_id":"s1","auto_refine":true}"#),
            ServerEvent::Ready {
                session_id: "s1".into()
            }
        );
        assert_eq!(
            parse_server_event(r#"{"type":"error","message":"boom"}"#),
            ServerEvent::Error("boom".into())
        );
        assert_eq!(
            parse_server_event(r#"{"type":"transcript","text":"hi"}"#),
            ServerEvent::Update
        );
        assert_eq!(parse_server_event("not json"), ServerEvent::Invalid);
        assert_eq!(
            parse_server_event(r#"{"type":"ready"}"#),
            ServerEvent::Invalid
        );
    }

    #[test]
    fn final_must_match_session_and_complete_refinement() {
        let good = serde_json::json!({
            "type": "final",
            "refinement_complete": true,
            "capture": {"id": "s1", "transcript_raw": ""}
        });
        assert!(is_valid_final(&good, "s1"));
        assert!(!is_valid_final(&good, "other"));
        let mut incomplete = good.clone();
        incomplete["refinement_complete"] = Value::Bool(false);
        assert!(!is_valid_final(&incomplete, "s1"));
        let mut no_text = good.clone();
        no_text["capture"]["transcript_raw"] = Value::Null;
        assert!(!is_valid_final(&no_text, "s1"));
    }
}
