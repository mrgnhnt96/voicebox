//! Sans-IO client for one `/captures/stream` take.
//!
//! Feed it socket and audio events; it returns what to send and, once
//! settled, the take's [`Outcome`]. Holding no socket keeps every rule here
//! (buffer until `ready`, contiguous sequence/offsets, finish once, what a
//! failure means) unit-testable.

use serde_json::Value;

use super::protocol::{self, ServerEvent};

/// Something the transport must send.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Text(String),
    Binary(Vec<u8>),
}

/// How a take's stream ended.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    /// A validated `final` event.
    Final(Value),
    /// The server never received `finish`: nothing was persisted, so the
    /// complete recording can be transcribed through the batch endpoint.
    FailedBeforeFinish(String),
    /// `finish` was sent. Never batch-upload now (the capture may already be
    /// saved). With `terminal_error` the server reported the failure;
    /// otherwise recover through `GET /captures/stream/{id}/result`.
    FailedAfterFinish {
        session_id: String,
        terminal_error: Option<String>,
    },
    /// The take was abandoned (too short, microphone failure, shutdown).
    Cancelled,
}

pub struct StreamClient {
    sample_rate: Option<u32>,
    opened: bool,
    start_sent: bool,
    ready: bool,
    session_id: Option<String>,
    sequence: u32,
    sample_offset: u32,
    pending: Vec<Vec<u8>>,
    pending_bytes: usize,
    max_pending_bytes: usize,
    finish_requested: bool,
    finish_sent: bool,
    outcome: Option<Outcome>,
}

impl StreamClient {
    /// `max_pending_bytes` bounds audio held while waiting for `ready`.
    pub fn new(max_pending_bytes: usize) -> Self {
        Self {
            sample_rate: None,
            opened: false,
            start_sent: false,
            ready: false,
            session_id: None,
            sequence: 0,
            sample_offset: 0,
            pending: Vec::new(),
            pending_bytes: 0,
            max_pending_bytes,
            finish_requested: false,
            finish_sent: false,
            outcome: None,
        }
    }

    pub fn is_ready(&self) -> bool {
        self.ready
    }

    pub fn finish_sent(&self) -> bool {
        self.finish_sent
    }

    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    pub fn outcome(&self) -> Option<&Outcome> {
        self.outcome.as_ref()
    }

    /// The capture's sample rate is known (the device is open).
    pub fn set_format(&mut self, sample_rate: u32) -> Vec<Action> {
        if self.sample_rate.is_none() {
            self.sample_rate = Some(sample_rate);
        }
        self.maybe_start()
    }

    /// The socket connected.
    pub fn on_open(&mut self) -> Vec<Action> {
        self.opened = true;
        self.maybe_start()
    }

    fn maybe_start(&mut self) -> Vec<Action> {
        match (self.outcome.is_none(), self.opened, self.start_sent, self.sample_rate) {
            (true, true, false, Some(rate)) => {
                self.start_sent = true;
                vec![Action::Text(protocol::start_message(rate))]
            }
            _ => Vec::new(),
        }
    }

    /// One mono PCM frame from the microphone.
    pub fn push_audio(&mut self, pcm: &[i16]) -> Vec<Action> {
        if self.outcome.is_some() || self.finish_requested {
            return Vec::new();
        }
        let mut actions = Vec::new();
        for chunk in pcm.chunks(protocol::MAX_SAMPLES_PER_MESSAGE) {
            let frame = protocol::encode_frame(self.sequence, self.sample_offset, chunk);
            self.sequence = self.sequence.wrapping_add(1);
            self.sample_offset = self.sample_offset.wrapping_add(chunk.len() as u32);
            if self.ready {
                actions.push(Action::Binary(frame));
            } else {
                self.pending_bytes += frame.len();
                self.pending.push(frame);
                if self.pending_bytes > self.max_pending_bytes {
                    self.fail("Server did not accept audio in time");
                    return Vec::new();
                }
            }
        }
        actions
    }

    /// The hotkey was released and the last frame pushed.
    pub fn request_finish(&mut self) -> Vec<Action> {
        if self.outcome.is_some() || self.finish_requested {
            return Vec::new();
        }
        self.finish_requested = true;
        if self.ready {
            self.finish_sent = true;
            vec![Action::Text(protocol::finish_message())]
        } else {
            Vec::new()
        }
    }

    /// A text message from the server.
    pub fn on_text(&mut self, text: &str) -> Vec<Action> {
        if self.outcome.is_some() {
            return Vec::new();
        }
        match protocol::parse_server_event(text) {
            ServerEvent::Ready { session_id } if !self.ready => {
                self.ready = true;
                self.session_id = Some(session_id);
                self.pending_bytes = 0;
                let mut actions: Vec<Action> =
                    self.pending.drain(..).map(Action::Binary).collect();
                if self.finish_requested {
                    self.finish_sent = true;
                    actions.push(Action::Text(protocol::finish_message()));
                }
                actions
            }
            ServerEvent::Final(event) => {
                if let Some(id) = self.session_id.as_deref() {
                    if self.finish_sent && protocol::is_valid_final(&event, id) {
                        self.outcome = Some(Outcome::Final(event));
                    }
                }
                Vec::new()
            }
            ServerEvent::Error(message) => {
                self.settle_failure(&message, true);
                Vec::new()
            }
            ServerEvent::Invalid => {
                self.fail("Invalid message from server");
                Vec::new()
            }
            ServerEvent::Ready { .. } | ServerEvent::Update => Vec::new(),
        }
    }

    /// The socket closed or errored.
    pub fn on_closed(&mut self) {
        self.fail("Streaming connection closed");
    }

    /// Give up (timeout, overload). Meaning depends on whether finish was sent.
    pub fn fail(&mut self, reason: &str) {
        self.settle_failure(reason, false);
    }

    fn settle_failure(&mut self, reason: &str, from_server: bool) {
        if self.outcome.is_some() {
            return;
        }
        self.pending.clear();
        self.pending_bytes = 0;
        self.outcome = Some(match (self.finish_sent, self.session_id.clone()) {
            (true, Some(session_id)) => Outcome::FailedAfterFinish {
                session_id,
                terminal_error: from_server.then(|| reason.to_string()),
            },
            _ => Outcome::FailedBeforeFinish(reason.to_string()),
        });
    }

    /// Abandon the take. Returns `cancel` when the server is listening.
    pub fn cancel(&mut self) -> Vec<Action> {
        if self.outcome.is_some() {
            return Vec::new();
        }
        self.outcome = Some(Outcome::Cancelled);
        self.pending.clear();
        self.pending_bytes = 0;
        if self.start_sent && !self.finish_sent {
            vec![Action::Text(protocol::cancel_message())]
        } else {
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dictation::protocol::HEADER_BYTES;

    fn texts(actions: &[Action]) -> Vec<Value> {
        actions
            .iter()
            .filter_map(|a| match a {
                Action::Text(t) => Some(serde_json::from_str(t).unwrap()),
                _ => None,
            })
            .collect()
    }

    fn frames(actions: &[Action]) -> Vec<Vec<u8>> {
        actions
            .iter()
            .filter_map(|a| match a {
                Action::Binary(b) => Some(b.clone()),
                _ => None,
            })
            .collect()
    }

    fn header(frame: &[u8]) -> (u32, u32) {
        (
            u32::from_le_bytes(frame[0..4].try_into().unwrap()),
            u32::from_le_bytes(frame[4..8].try_into().unwrap()),
        )
    }

    fn final_event(id: &str) -> String {
        serde_json::json!({
            "type": "final",
            "refinement_complete": true,
            "capture": {"id": id, "transcript_raw": "hello", "transcript_refined": "Hello."}
        })
        .to_string()
    }

    fn ready(client: &mut StreamClient) -> Vec<Action> {
        client.on_text(r#"{"type":"ready","session_id":"s1"}"#)
    }

    #[test]
    fn start_waits_for_both_socket_and_format() {
        let mut client = StreamClient::new(1 << 20);
        assert!(client.on_open().is_empty());
        let sent = client.set_format(16_000);
        assert_eq!(texts(&sent)[0]["sample_rate"], 16_000);

        let mut client = StreamClient::new(1 << 20);
        assert!(client.set_format(48_000).is_empty());
        assert_eq!(texts(&client.on_open())[0]["type"], "start");
    }

    #[test]
    fn buffers_audio_until_ready_then_flushes_in_order() {
        let mut client = StreamClient::new(1 << 20);
        client.set_format(48_000);
        // Audio arrives while the socket is still connecting.
        assert!(client.push_audio(&[1, -2]).is_empty());
        client.on_open();
        assert!(client.push_audio(&[3]).is_empty());
        let flushed = frames(&ready(&mut client));
        assert_eq!(flushed.len(), 2);
        assert_eq!(header(&flushed[0]), (0, 0));
        assert_eq!(&flushed[0][HEADER_BYTES..], &[1, 0, 0xFE, 0xFF]);
        assert_eq!(header(&flushed[1]), (1, 2));
        // Once ready, audio goes straight out with contiguous numbering.
        let live = frames(&client.push_audio(&[4, 5]));
        assert_eq!(header(&live[0]), (2, 3));
    }

    #[test]
    fn oversized_frames_are_split_within_the_message_limit() {
        let mut client = StreamClient::new(1 << 20);
        client.set_format(48_000);
        client.on_open();
        ready(&mut client);
        let pcm = vec![7i16; protocol::MAX_SAMPLES_PER_MESSAGE + 10];
        let sent = frames(&client.push_audio(&pcm));
        assert_eq!(sent.len(), 2);
        assert!(sent.iter().all(|f| f.len() <= protocol::MAX_MESSAGE_BYTES));
        assert_eq!(
            header(&sent[1]),
            (1, protocol::MAX_SAMPLES_PER_MESSAGE as u32)
        );
    }

    #[test]
    fn finish_before_ready_is_sent_after_the_buffered_audio() {
        let mut client = StreamClient::new(1 << 20);
        client.set_format(48_000);
        client.on_open();
        client.push_audio(&[1]);
        assert!(client.request_finish().is_empty());
        assert!(!client.finish_sent());
        let sent = ready(&mut client);
        assert!(matches!(sent[0], Action::Binary(_)));
        assert_eq!(texts(&sent), vec![serde_json::json!({"type": "finish"})]);
        assert!(client.finish_sent());
    }

    #[test]
    fn finish_is_sent_once() {
        let mut client = StreamClient::new(1 << 20);
        client.set_format(48_000);
        client.on_open();
        ready(&mut client);
        assert_eq!(texts(&client.request_finish()).len(), 1);
        assert!(client.request_finish().is_empty());
        // Audio after finish is ignored.
        assert!(client.push_audio(&[1]).is_empty());
    }

    #[test]
    fn valid_final_settles_the_take() {
        let mut client = StreamClient::new(1 << 20);
        client.set_format(48_000);
        client.on_open();
        ready(&mut client);
        client.request_finish();
        client.on_text(&final_event("other-session"));
        assert_eq!(client.outcome(), None);
        client.on_text(&final_event("s1"));
        match client.outcome() {
            Some(Outcome::Final(v)) => assert_eq!(v["capture"]["id"], "s1"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn close_before_finish_allows_batch_fallback() {
        let mut client = StreamClient::new(1 << 20);
        client.set_format(48_000);
        client.on_open();
        ready(&mut client);
        client.on_closed();
        assert!(matches!(
            client.outcome(),
            Some(Outcome::FailedBeforeFinish(_))
        ));
    }

    #[test]
    fn close_after_finish_requires_recovery_not_batch() {
        let mut client = StreamClient::new(1 << 20);
        client.set_format(48_000);
        client.on_open();
        ready(&mut client);
        client.request_finish();
        client.on_closed();
        assert_eq!(
            client.outcome(),
            Some(&Outcome::FailedAfterFinish {
                session_id: "s1".into(),
                terminal_error: None
            })
        );
    }

    #[test]
    fn server_error_after_finish_is_terminal() {
        let mut client = StreamClient::new(1 << 20);
        client.set_format(48_000);
        client.on_open();
        ready(&mut client);
        client.request_finish();
        client.on_text(r#"{"type":"error","message":"Recognition failed"}"#);
        assert_eq!(
            client.outcome(),
            Some(&Outcome::FailedAfterFinish {
                session_id: "s1".into(),
                terminal_error: Some("Recognition failed".into())
            })
        );
    }

    #[test]
    fn server_error_before_finish_falls_back() {
        let mut client = StreamClient::new(1 << 20);
        client.set_format(48_000);
        client.on_open();
        ready(&mut client);
        client.on_text(r#"{"type":"error","message":"overloaded"}"#);
        assert!(matches!(
            client.outcome(),
            Some(Outcome::FailedBeforeFinish(_))
        ));
    }

    #[test]
    fn exceeding_the_pending_bound_falls_back_instead_of_dropping_audio() {
        let mut client = StreamClient::new(64);
        client.set_format(48_000);
        client.push_audio(&[0; 20]);
        assert_eq!(client.outcome(), None);
        client.push_audio(&[0; 20]);
        assert!(matches!(
            client.outcome(),
            Some(Outcome::FailedBeforeFinish(_))
        ));
    }

    #[test]
    fn finish_requested_while_connecting_then_close_still_falls_back() {
        let mut client = StreamClient::new(1 << 20);
        client.set_format(48_000);
        client.push_audio(&[1]);
        client.request_finish();
        client.on_closed();
        assert!(matches!(
            client.outcome(),
            Some(Outcome::FailedBeforeFinish(_))
        ));
    }

    #[test]
    fn cancel_tells_a_listening_server_and_settles() {
        let mut client = StreamClient::new(1 << 20);
        client.set_format(48_000);
        client.on_open();
        ready(&mut client);
        assert_eq!(texts(&client.cancel())[0]["type"], "cancel");
        assert_eq!(client.outcome(), Some(&Outcome::Cancelled));
        // A settled take ignores later events.
        client.on_closed();
        assert_eq!(client.outcome(), Some(&Outcome::Cancelled));
    }

    #[test]
    fn fail_after_finish_needs_recovery() {
        let mut client = StreamClient::new(1 << 20);
        client.set_format(48_000);
        client.on_open();
        ready(&mut client);
        client.request_finish();
        client.fail("timed out");
        assert!(matches!(
            client.outcome(),
            Some(Outcome::FailedAfterFinish {
                terminal_error: None,
                ..
            })
        ));
    }
}
