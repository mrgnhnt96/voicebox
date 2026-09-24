//! Settling a take once its stream has an [`Outcome`]: deliver the final
//! capture, recover it after a dropped connection, or fall back to a batch
//! upload when the server never received `finish`.
//!
//! Side effects go through [`TakeEnv`] so every branch is tested with fakes.

use std::future::Future;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use super::audio;
use super::client::Outcome;
use super::delivery::{self, Delivery};
use super::stream::{self, Recovery};

/// Shortest take worth transcribing.
pub const MIN_RECORDING: Duration = Duration::from_millis(500);
pub const ERROR_VISIBLE_MS: u64 = 6000;
pub const BRIEF_NOTICE_MS: u64 = 2000;

/// Pill state sent to the dictate webview.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum PillEvent {
    Preparing,
    /// The microphone is delivering sound.
    Recording,
    Transcribing { elapsed_ms: u64 },
    Refining,
    Done,
    Error { message: String, visible_ms: u64 },
}

impl PillEvent {
    pub fn error(message: impl Into<String>) -> Self {
        let message = message.into();
        let visible_ms = if message == delivery::SHORT_RECORDING_MESSAGE {
            BRIEF_NOTICE_MS
        } else {
            ERROR_VISIBLE_MS
        };
        Self::Error {
            message,
            visible_ms,
        }
    }
}

/// The complete recording, kept for the batch fallback.
#[derive(Debug, Clone, PartialEq)]
pub struct Recorded {
    pub pcm: Vec<i16>,
    pub sample_rate: u32,
}

impl Recorded {
    pub fn duration(&self) -> Duration {
        if self.sample_rate == 0 {
            return Duration::ZERO;
        }
        Duration::from_secs_f64(self.pcm.len() as f64 / self.sample_rate as f64)
    }
}

pub trait TakeEnv {
    fn emit(&self, event: PillEvent);
    fn capture_created(&self, capture: &Value);
    fn capture_updated(&self, capture_id: &str);
    fn accessibility_missing(&self);
    /// Paste into the target focused at chord start.
    fn paste(&self, text: String) -> impl Future<Output = Result<bool, String>> + Send;
    fn fetch_result(&self, session_id: String) -> impl Future<Output = Recovery> + Send;
    /// `POST /captures` with a WAV file; returns the create response.
    fn upload(&self, wav: Vec<u8>) -> impl Future<Output = Result<Value, String>> + Send;
    /// `POST /captures/{id}/refine`; returns the refined capture.
    fn refine(&self, capture_id: String) -> impl Future<Output = Result<Value, String>> + Send;
    fn recovery_delay(&self) -> Duration {
        stream::RECOVERY_DELAY
    }
}

/// Finish a take. `recorded` resolves once recording has stopped, with the
/// complete audio (`None` if the microphone failed or the take was dropped).
pub async fn settle<E, R>(env: &E, outcome: Outcome, recorded: R)
where
    E: TakeEnv,
    R: Future<Output = Option<Recorded>>,
{
    match outcome {
        Outcome::Final(event) => deliver_final(env, &event).await,
        Outcome::FailedAfterFinish {
            terminal_error: Some(message),
            ..
        } => env.emit(PillEvent::error(message)),
        Outcome::FailedAfterFinish {
            session_id,
            terminal_error: None,
        } => {
            // The server may already have saved this capture: never upload
            // it again, only ask for the result.
            let delay = env.recovery_delay();
            let fetch = || env.fetch_result(session_id.clone());
            match stream::recover(fetch, stream::RECOVERY_ATTEMPTS, delay).await {
                Ok(event) => deliver_final(env, &event).await,
                Err(message) => env.emit(PillEvent::error(message)),
            }
        }
        Outcome::FailedBeforeFinish(reason) => {
            let Some(recorded) = recorded.await else {
                return;
            };
            if recorded.duration() < MIN_RECORDING {
                env.emit(PillEvent::error(delivery::SHORT_RECORDING_MESSAGE));
                return;
            }
            eprintln!("[dictation] streaming unavailable ({reason}); transcribing the complete recording");
            batch(env, recorded).await;
        }
        Outcome::Cancelled => {
            if let Some(recorded) = recorded.await {
                if recorded.duration() < MIN_RECORDING {
                    env.emit(PillEvent::error(delivery::SHORT_RECORDING_MESSAGE));
                }
            }
        }
    }
}

async fn deliver_final<E: TakeEnv>(env: &E, event: &Value) {
    if let Some(capture) = event.get("capture") {
        env.capture_created(capture);
    }
    deliver(env, delivery::plan_final(event)).await;
}

async fn deliver<E: TakeEnv>(env: &E, plan: Delivery) {
    match plan {
        Delivery::Paste(text) => match delivery::paste_failure(env.paste(text).await) {
            None => env.emit(PillEvent::Done),
            Some((message, accessibility)) => {
                if accessibility {
                    env.accessibility_missing();
                }
                env.emit(PillEvent::error(message));
            }
        },
        Delivery::Nothing => env.emit(PillEvent::Done),
        Delivery::Error(message) => env.emit(PillEvent::error(message)),
    }
}

async fn batch<E: TakeEnv>(env: &E, recorded: Recorded) {
    let wav = match audio::encode_wav(&recorded.pcm, recorded.sample_rate) {
        Ok(wav) => wav,
        Err(message) => return env.emit(PillEvent::error(message)),
    };
    let capture = match env.upload(wav).await {
        Ok(capture) => capture,
        Err(message) => return env.emit(PillEvent::error(delivery::upload_failure(&message))),
    };
    env.capture_created(&capture);
    let allow_auto_paste = capture
        .get("allow_auto_paste")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let auto_refine = capture
        .get("auto_refine")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let Some(id) = capture.get("id").and_then(Value::as_str).map(str::to_string) else {
        return env.emit(PillEvent::error("Upload returned no capture"));
    };
    if !auto_refine {
        return deliver(env, delivery::plan(&capture, allow_auto_paste, None)).await;
    }
    env.emit(PillEvent::Refining);
    match env.refine(id.clone()).await {
        Ok(refined) => {
            env.capture_updated(&id);
            deliver(env, delivery::plan(&refined, allow_auto_paste, None)).await;
        }
        Err(message) if message.is_empty() => env.emit(PillEvent::error("Refinement failed")),
        Err(message) => env.emit(PillEvent::error(message)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeEnv {
        events: Mutex<Vec<PillEvent>>,
        created: Mutex<Vec<Value>>,
        updated: Mutex<Vec<String>>,
        pasted: Mutex<Vec<String>>,
        accessibility: Mutex<u32>,
        paste_result: Mutex<Option<Result<bool, String>>>,
        recoveries: Mutex<VecDeque<Recovery>>,
        fetches: Mutex<u32>,
        uploads: Mutex<Vec<Vec<u8>>>,
        upload_result: Mutex<Option<Result<Value, String>>>,
        refine_result: Mutex<Option<Result<Value, String>>>,
    }

    impl TakeEnv for FakeEnv {
        fn emit(&self, event: PillEvent) {
            self.events.lock().unwrap().push(event);
        }
        fn capture_created(&self, capture: &Value) {
            self.created.lock().unwrap().push(capture.clone());
        }
        fn capture_updated(&self, capture_id: &str) {
            self.updated.lock().unwrap().push(capture_id.to_string());
        }
        fn accessibility_missing(&self) {
            *self.accessibility.lock().unwrap() += 1;
        }
        fn paste(&self, text: String) -> impl Future<Output = Result<bool, String>> + Send {
            self.pasted.lock().unwrap().push(text);
            let result = self.paste_result.lock().unwrap().clone().unwrap_or(Ok(true));
            async move { result }
        }
        fn fetch_result(&self, _session_id: String) -> impl Future<Output = Recovery> + Send {
            *self.fetches.lock().unwrap() += 1;
            let next = self
                .recoveries
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Recovery::Pending);
            async move { next }
        }
        fn upload(&self, wav: Vec<u8>) -> impl Future<Output = Result<Value, String>> + Send {
            self.uploads.lock().unwrap().push(wav);
            let result = self
                .upload_result
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_else(|| Err("no upload configured".into()));
            async move { result }
        }
        fn refine(&self, _capture_id: String) -> impl Future<Output = Result<Value, String>> + Send {
            let result = self
                .refine_result
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_else(|| Err("no refine configured".into()));
            async move { result }
        }
        fn recovery_delay(&self) -> Duration {
            Duration::ZERO
        }
    }

    impl FakeEnv {
        fn events(&self) -> Vec<PillEvent> {
            self.events.lock().unwrap().clone()
        }
        fn pasted(&self) -> Vec<String> {
            self.pasted.lock().unwrap().clone()
        }
    }

    fn final_event(text: &str) -> Value {
        json!({
            "type": "final",
            "refinement_complete": true,
            "refinement_error": null,
            "capture": {"id": "s1", "transcript_raw": text, "transcript_refined": text, "allow_auto_paste": true}
        })
    }

    fn recorded(seconds: f64) -> Recorded {
        Recorded {
            pcm: vec![1; (16_000.0 * seconds) as usize],
            sample_rate: 16_000,
        }
    }

    #[tokio::test]
    async fn final_capture_is_announced_and_pasted() {
        let env = FakeEnv::default();
        settle(&env, Outcome::Final(final_event("Hello.")), async { None }).await;
        assert_eq!(env.pasted(), vec!["Hello."]);
        assert_eq!(env.created.lock().unwrap()[0]["id"], "s1");
        assert_eq!(env.events(), vec![PillEvent::Done]);
        assert!(env.uploads.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn empty_final_output_finishes_without_pasting() {
        let env = FakeEnv::default();
        settle(&env, Outcome::Final(final_event("")), async { None }).await;
        assert!(env.pasted().is_empty());
        assert_eq!(env.events(), vec![PillEvent::Done]);
    }

    #[tokio::test]
    async fn accessibility_paste_failure_is_reported() {
        let env = FakeEnv::default();
        *env.paste_result.lock().unwrap() = Some(Err("Accessibility permission required".into()));
        settle(&env, Outcome::Final(final_event("Hi.")), async { None }).await;
        assert_eq!(*env.accessibility.lock().unwrap(), 1);
        assert_eq!(
            env.events(),
            vec![PillEvent::error("Text saved in Captures. Accessibility permission required")]
        );
    }

    #[tokio::test]
    async fn dropped_connection_after_finish_recovers_without_uploading() {
        let env = FakeEnv::default();
        env.recoveries.lock().unwrap().extend([
            Recovery::Pending,
            Recovery::Final(final_event("Recovered.")),
        ]);
        settle(
            &env,
            Outcome::FailedAfterFinish {
                session_id: "s1".into(),
                terminal_error: None,
            },
            async { Some(recorded(2.0)) },
        )
        .await;
        assert_eq!(*env.fetches.lock().unwrap(), 2);
        assert_eq!(env.pasted(), vec!["Recovered."]);
        assert!(env.uploads.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn terminal_error_after_finish_is_shown_without_recovery_or_upload() {
        let env = FakeEnv::default();
        settle(
            &env,
            Outcome::FailedAfterFinish {
                session_id: "s1".into(),
                terminal_error: Some("Recognition failed".into()),
            },
            async { Some(recorded(2.0)) },
        )
        .await;
        assert_eq!(*env.fetches.lock().unwrap(), 0);
        assert!(env.uploads.lock().unwrap().is_empty());
        assert_eq!(env.events(), vec![PillEvent::error("Recognition failed")]);
    }

    #[tokio::test]
    async fn unrecoverable_session_tells_the_user_to_check_captures() {
        let env = FakeEnv::default();
        settle(
            &env,
            Outcome::FailedAfterFinish {
                session_id: "s1".into(),
                terminal_error: None,
            },
            async { None },
        )
        .await;
        assert_eq!(
            env.events(),
            vec![PillEvent::error(stream::INTERRUPTED_MESSAGE)]
        );
        assert!(env.uploads.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn failure_before_finish_uploads_the_complete_recording() {
        let env = FakeEnv::default();
        *env.upload_result.lock().unwrap() = Some(Ok(json!({
            "id": "c1", "transcript_raw": "hello", "transcript_refined": null,
            "auto_refine": false, "allow_auto_paste": true
        })));
        settle(
            &env,
            Outcome::FailedBeforeFinish("closed".into()),
            async { Some(recorded(1.0)) },
        )
        .await;
        let uploads = env.uploads.lock().unwrap().clone();
        assert_eq!(uploads.len(), 1);
        let reader = hound::WavReader::new(std::io::Cursor::new(&uploads[0])).unwrap();
        assert_eq!(reader.len(), 16_000);
        assert_eq!(env.created.lock().unwrap()[0]["id"], "c1");
        assert_eq!(env.pasted(), vec!["hello"]);
        assert_eq!(env.events(), vec![PillEvent::Done]);
    }

    #[tokio::test]
    async fn batch_fallback_refines_when_the_server_asks() {
        let env = FakeEnv::default();
        *env.upload_result.lock().unwrap() = Some(Ok(json!({
            "id": "c1", "transcript_raw": "hello", "transcript_refined": null,
            "auto_refine": true, "allow_auto_paste": true
        })));
        *env.refine_result.lock().unwrap() = Some(Ok(json!({
            "id": "c1", "transcript_raw": "hello", "transcript_refined": "Hello."
        })));
        settle(
            &env,
            Outcome::FailedBeforeFinish("closed".into()),
            async { Some(recorded(1.0)) },
        )
        .await;
        assert_eq!(env.events(), vec![PillEvent::Refining, PillEvent::Done]);
        assert_eq!(*env.updated.lock().unwrap(), vec!["c1".to_string()]);
        assert_eq!(env.pasted(), vec!["Hello."]);
    }

    #[tokio::test]
    async fn batch_upload_errors_are_translated() {
        let env = FakeEnv::default();
        *env.upload_result.lock().unwrap() = Some(Err("Could not decode audio".into()));
        settle(
            &env,
            Outcome::FailedBeforeFinish("closed".into()),
            async { Some(recorded(1.0)) },
        )
        .await;
        assert_eq!(
            env.events(),
            vec![PillEvent::error(delivery::SHORT_RECORDING_MESSAGE)]
        );
    }

    #[tokio::test]
    async fn short_take_is_canceled_with_a_brief_notice() {
        let env = FakeEnv::default();
        settle(&env, Outcome::Cancelled, async { Some(recorded(0.2)) }).await;
        settle(
            &env,
            Outcome::FailedBeforeFinish("closed".into()),
            async { Some(recorded(0.2)) },
        )
        .await;
        assert!(env.uploads.lock().unwrap().is_empty());
        let brief = PillEvent::Error {
            message: delivery::SHORT_RECORDING_MESSAGE.into(),
            visible_ms: BRIEF_NOTICE_MS,
        };
        assert_eq!(env.events(), vec![brief.clone(), brief]);
    }

    #[tokio::test]
    async fn cancelled_take_without_audio_stays_silent() {
        let env = FakeEnv::default();
        settle(&env, Outcome::Cancelled, async { None }).await;
        settle(&env, Outcome::FailedBeforeFinish("x".into()), async { None }).await;
        assert!(env.events().is_empty());
    }

    #[test]
    fn pill_events_serialize_for_the_webview() {
        assert_eq!(
            serde_json::to_value(PillEvent::Transcribing { elapsed_ms: 1200 }).unwrap(),
            json!({"state": "transcribing", "elapsed_ms": 1200})
        );
        assert_eq!(
            serde_json::to_value(PillEvent::error("boom")).unwrap(),
            json!({"state": "error", "message": "boom", "visible_ms": ERROR_VISIBLE_MS})
        );
    }
}
