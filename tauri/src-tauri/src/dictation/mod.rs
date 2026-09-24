//! Native dictation: microphone capture and streaming, owned by Rust.
//!
//! On chord start the hotkey monitor calls [`start`]: the microphone opens on
//! its own thread and the `/captures/stream` socket connects in parallel,
//! with audio buffered until the server is ready. Chord end calls [`stop`],
//! which flushes the last frame and sends `finish`. The final capture is
//! pasted through `paste_final_text` into the target focused at chord start.
//! The dictate webview only renders the pill from `dictation:state` events.

pub mod audio;
pub mod capture;
pub mod client;
pub mod delivery;
pub mod http;
pub mod protocol;
pub mod stream;
pub mod take;
pub mod transport;

use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc as std_mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::focus_capture::FocusSnapshot;
use crate::DICTATE_WINDOW_LABEL;
use capture::{CaptureHooks, NativeInputDevice};
use client::StreamClient;
use stream::{AudioMsg, Recovery, Timeouts};
use take::{PillEvent, TakeEnv};

pub const DEFAULT_SERVER_URL: &str = "http://127.0.0.1:17493";
/// Audio held while the socket connects: one minute at 48 kHz, matching the
/// server's own pending-audio bound. Beyond it the take uses the batch path.
const MAX_PENDING_BYTES: usize = 48_000 * 2 * 60;
const LEARNING_PAUSE_INTERVAL: Duration = Duration::from_secs(30);

/// Where and how to capture. Pushed by the dictate webview, which owns the
/// server URL and capture settings.
#[derive(Debug, Clone)]
struct Config {
    server_url: String,
    /// The webview's origin, sent only to a non-loopback server.
    origin: Option<String>,
    input_device_id: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            server_url: DEFAULT_SERVER_URL.to_string(),
            origin: None,
            input_device_id: None,
        }
    }
}

struct ActiveTake {
    id: u64,
    stop: std_mpsc::Sender<()>,
    focus: Arc<Mutex<Option<FocusSnapshot>>>,
    /// Key-up time, for the release-to-final log.
    released: Arc<OnceLock<Instant>>,
}

#[derive(Default)]
pub struct DictationState {
    config: Mutex<Config>,
    /// Where the chosen microphone is remembered between launches.
    device_file: OnceLock<std::path::PathBuf>,
    active: Mutex<Option<ActiveTake>>,
    next_take: AtomicU64,
    http: OnceLock<reqwest::Client>,
}

impl DictationState {
    fn http(&self) -> reqwest::Client {
        self.http.get_or_init(http::client).clone()
    }
}

/// Begin a take at chord start. `keydown` is the chord's event time, used for
/// latency logging. Returns the take id, or `None` if one is already recording.
pub fn start(app: &AppHandle, keydown: Instant) -> Option<u64> {
    let state = app.state::<DictationState>();
    let mut active = state.active.lock().ok()?;
    if active.is_some() {
        return None;
    }
    let config = state.config.lock().map(|c| c.clone()).unwrap_or_default();
    let take_id = state.next_take.fetch_add(1, Ordering::Relaxed) + 1;
    let focus: Arc<Mutex<Option<FocusSnapshot>>> = Arc::new(Mutex::new(None));
    let env = AppEnv {
        app: app.clone(),
        take_id,
        server_url: config.server_url.clone(),
        http: state.http(),
        focus: focus.clone(),
    };
    env.emit(PillEvent::Preparing);

    // The microphone first: nothing else may delay the first sample.
    let (audio_tx, audio_rx) = tokio::sync::mpsc::unbounded_channel::<AudioMsg>();
    let recording = Arc::new(AtomicBool::new(true));
    let hooks = {
        let heard_env = env.clone();
        let stopped_env = env.clone();
        let error_env = env.clone();
        let stopped_flag = recording.clone();
        let error_flag = recording.clone();
        CaptureHooks {
            on_heard: Box::new(move || heard_env.emit(PillEvent::Recording)),
            on_stopped: Box::new(move |duration| {
                stopped_flag.store(false, Ordering::Relaxed);
                stopped_env.emit(PillEvent::Transcribing {
                    elapsed_ms: duration.as_millis() as u64,
                });
            }),
            on_error: Box::new(move |message| {
                error_flag.store(false, Ordering::Relaxed);
                error_env.emit(PillEvent::error(message));
            }),
        }
    };
    let capture = capture::spawn(config.input_device_id.clone(), keydown, audio_tx, hooks);
    let stop = capture.stopper();
    let done = capture.done;

    let (out_tx, in_rx) = transport::spawn(&config.server_url, config.origin.clone());
    let released: Arc<OnceLock<Instant>> = Arc::new(OnceLock::new());
    let released_for_task = released.clone();

    let learning_env = env.clone();
    let learning_flag = recording.clone();
    tauri::async_runtime::spawn(async move {
        while learning_flag.load(Ordering::Relaxed) {
            http::pause_learning(&learning_env.http, &learning_env.server_url).await;
            tokio::time::sleep(LEARNING_PAUSE_INTERVAL).await;
        }
    });

    tauri::async_runtime::spawn(async move {
        let outcome = stream::drive(
            StreamClient::new(MAX_PENDING_BYTES),
            out_tx,
            in_rx,
            audio_rx,
            Timeouts::default(),
        )
        .await;
        let since_release = |at: &OnceLock<Instant>| {
            at.get()
                .map(|t| format!("{:.0}ms", t.elapsed().as_secs_f64() * 1000.0))
                .unwrap_or_else(|| "n/a".into())
        };
        eprintln!(
            "[dictation] take {take_id}: {} release→outcome {}",
            outcome_label(&outcome),
            since_release(&released_for_task)
        );
        let recorded = async move { done.await.ok().flatten() };
        take::settle(&env, outcome, recorded).await;
        eprintln!(
            "[dictation] take {take_id}: release→delivered {}",
            since_release(&released_for_task)
        );
        recording.store(false, Ordering::Relaxed);
    });

    *active = Some(ActiveTake {
        id: take_id,
        stop,
        focus,
        released,
    });
    Some(take_id)
}

/// Record the paste target for a take (captured right after [`start`], so
/// the microphone never waits on Accessibility calls).
pub fn set_focus(app: &AppHandle, take_id: u64, focus: Option<FocusSnapshot>) {
    let state = app.state::<DictationState>();
    let Ok(active) = state.active.lock() else {
        return;
    };
    if let Some(take) = active.as_ref().filter(|t| t.id == take_id) {
        if let Ok(mut slot) = take.focus.lock() {
            *slot = focus;
        }
    }
}

/// End the recording take at chord end. Finalization continues in the
/// background, so a new take can start immediately.
pub fn stop(app: &AppHandle) {
    let state = app.state::<DictationState>();
    let taken = state.active.lock().ok().and_then(|mut a| a.take());
    if let Some(take) = taken {
        let _ = take.released.set(Instant::now());
        let _ = take.stop.send(());
    }
}

fn outcome_label(outcome: &client::Outcome) -> String {
    match outcome {
        client::Outcome::Final(_) => "final".into(),
        client::Outcome::FailedBeforeFinish(reason) => format!("stream failed ({reason}); batch"),
        client::Outcome::FailedAfterFinish { .. } => {
            "connection lost after finish; recovering".into()
        }
        client::Outcome::Cancelled => "cancelled".into(),
    }
}

#[derive(Clone)]
struct AppEnv {
    app: AppHandle,
    take_id: u64,
    server_url: String,
    http: reqwest::Client,
    focus: Arc<Mutex<Option<FocusSnapshot>>>,
}

impl TakeEnv for AppEnv {
    fn emit(&self, event: PillEvent) {
        let mut payload = serde_json::to_value(&event).unwrap_or(Value::Null);
        if let Value::Object(ref mut map) = payload {
            map.insert("take".into(), Value::from(self.take_id));
        }
        let _ = self
            .app
            .emit_to(DICTATE_WINDOW_LABEL, "dictation:state", payload);
    }

    fn capture_created(&self, capture: &Value) {
        let _ = self
            .app
            .emit("capture:created", serde_json::json!({ "capture": capture }));
    }

    fn capture_updated(&self, capture_id: &str) {
        let _ = self
            .app
            .emit("capture:updated", serde_json::json!({ "id": capture_id }));
    }

    fn accessibility_missing(&self) {
        let _ = self.app.emit("system:accessibility-missing", ());
    }

    fn paste(&self, text: String) -> impl Future<Output = Result<bool, String>> + Send {
        let app = self.app.clone();
        let focus = self.focus.lock().ok().and_then(|f| f.clone());
        async move {
            match focus {
                Some(focus) => crate::paste_final_text(app, text, focus).await,
                None => Err(delivery::NO_FOCUS_MESSAGE.to_string()),
            }
        }
    }

    fn fetch_result(&self, session_id: String) -> impl Future<Output = Recovery> + Send {
        let http = self.http.clone();
        let server_url = self.server_url.clone();
        async move { http::fetch_result(&http, &server_url, &session_id).await }
    }

    fn upload(&self, wav: Vec<u8>) -> impl Future<Output = Result<Value, String>> + Send {
        let http = self.http.clone();
        let server_url = self.server_url.clone();
        async move { http::upload(&http, &server_url, wav).await }
    }

    fn refine(&self, capture_id: String) -> impl Future<Output = Result<Value, String>> + Send {
        let http = self.http.clone();
        let server_url = self.server_url.clone();
        async move { http::refine(&http, &server_url, &capture_id).await }
    }
}

// ========================================================================
// Commands
// ========================================================================

/// Push the server URL, webview origin and saved microphone to Rust.
#[tauri::command]
pub fn dictation_configure(
    state: tauri::State<'_, DictationState>,
    server_url: Option<String>,
    origin: Option<String>,
    input_device_id: Option<String>,
    device_known: Option<bool>,
) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.server_url = server_url
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_SERVER_URL.to_string());
    config.origin = origin.filter(|o| !o.is_empty() && o != "null");
    let known = device_known.unwrap_or(true);
    let device = next_device(
        config.input_device_id.clone(),
        known,
        input_device_id.filter(|id| !id.is_empty()),
    );
    if known && device != config.input_device_id {
        if let Some(path) = state.device_file.get() {
            save_device(path, device.as_deref());
        }
    }
    config.input_device_id = device;
    Ok(())
}

/// Remember the chosen microphone across launches. The webview only learns
/// the setting once the server is up (~30 s after launch); without this the
/// first take after launch used the macOS default input instead.
pub fn restore(app: &AppHandle) {
    let Ok(dir) = app.path().app_config_dir() else { return };
    let path = dir.join("dictation-device.txt");
    let state = app.state::<DictationState>();
    if let Ok(mut config) = state.config.lock() {
        config.input_device_id = load_device(&path);
    }
    let _ = state.device_file.set(path);
}

fn load_device(path: &std::path::Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
}

fn save_device(path: &std::path::Path, id: Option<&str>) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(e) = std::fs::write(path, id.unwrap_or("")) {
        eprintln!("[dictation] could not remember the microphone: {e}");
    }
}

/// The microphone to use after a configure call. Settings that haven't loaded
/// yet say nothing about the device, so the saved choice stands.
fn next_device(current: Option<String>, known: bool, sent: Option<String>) -> Option<String> {
    if known {
        sent
    } else {
        current
    }
}

/// Stop the current take (the pill's stop button).
#[tauri::command]
pub fn dictation_stop(app: AppHandle) {
    stop(&app);
}

/// Native microphones, with ids suitable for `input_device_id`.
#[tauri::command]
pub async fn list_input_devices() -> Result<Vec<NativeInputDevice>, String> {
    tauri::async_runtime::spawn_blocking(capture::list_input_devices)
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod saved_device_tests {
    use super::*;

    #[test]
    fn a_saved_microphone_is_restored_at_launch() {
        let dir = tempfile_dir();
        let path = dir.join("dictation-device.txt");
        save_device(&path, Some("native:MacBook Pro Microphone"));
        assert_eq!(load_device(&path), Some("native:MacBook Pro Microphone".to_string()));
    }

    #[test]
    fn the_system_default_is_saved_as_no_device() {
        let dir = tempfile_dir();
        let path = dir.join("dictation-device.txt");
        save_device(&path, Some("native:AirPods"));
        save_device(&path, None);
        assert_eq!(load_device(&path), None);
    }

    #[test]
    fn a_missing_file_means_the_system_default() {
        let dir = tempfile_dir();
        assert_eq!(load_device(&dir.join("missing.txt")), None);
    }

    #[test]
    fn settings_that_have_not_loaded_keep_the_saved_microphone() {
        let saved = Some("native:MacBook Pro Microphone".to_string());
        assert_eq!(next_device(saved.clone(), false, None), saved);
        assert_eq!(next_device(saved.clone(), true, None), None);
        assert_eq!(
            next_device(saved, true, Some("native:AirPods".to_string())),
            Some("native:AirPods".to_string())
        );
    }

    fn tempfile_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "voicebox-device-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
