//! Native microphone capture with cpal.
//!
//! One thread per take owns the input stream. The audio callback only
//! downmixes into a lock-free SPSC ring (`rtrb`) and never blocks or
//! allocates; the capture thread drains the ring every few milliseconds,
//! cuts ~100 ms frames for the streaming socket, and keeps the complete
//! recording for the batch fallback.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample, StreamConfig};
use serde::Serialize;
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

use super::audio::{self, Framer, LevelMeter, LowCut, TakeMetrics};
use super::stream::AudioMsg;
use super::take::{Recorded, MIN_RECORDING};

/// How often the capture thread drains the ring.
const DRAIN_INTERVAL: Duration = Duration::from_millis(10);
/// Ring capacity; the thread drains every 10 ms, so this never fills.
const RING_SECONDS: usize = 10;
/// Show "recording" even if the device only ever delivers digital silence.
const HEARD_FALLBACK: Duration = Duration::from_millis(1500);
/// Complete-recording copy kept for the batch fallback.
const MAX_FALLBACK_SECONDS: usize = 600;

#[derive(Debug, Clone, Serialize)]
pub struct NativeInputDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

pub fn list_input_devices() -> Result<Vec<NativeInputDevice>, String> {
    let host = cpal::default_host();
    let default_name = host.default_input_device().and_then(|d| d.name().ok());
    let devices = host
        .input_devices()
        .map_err(|e| format!("Failed to enumerate input devices: {e}"))?;
    let mut result: Vec<NativeInputDevice> = Vec::new();
    for device in devices {
        let Ok(name) = device.name() else { continue };
        if result.iter().any(|d| d.name == name) {
            continue;
        }
        result.push(NativeInputDevice {
            id: audio::native_device_id(&name),
            is_default: default_name.as_deref() == Some(name.as_str()),
            name,
        });
    }
    Ok(result)
}

/// Callbacks from the capture thread.
pub struct CaptureHooks {
    /// The microphone delivered sound (or the fallback delay passed).
    pub on_heard: Box<dyn FnOnce() + Send>,
    /// Input loudness in dBFS, every [`audio::LEVEL_INTERVAL`].
    pub on_level: Box<dyn FnMut(f32) + Send>,
    /// Recording stopped with a take long enough to transcribe.
    pub on_stopped: Box<dyn FnOnce(Duration) + Send>,
    /// The device could not be opened.
    pub on_error: Box<dyn FnOnce(String) + Send>,
}

pub struct CaptureHandle {
    stop: std_mpsc::Sender<()>,
    pub done: oneshot::Receiver<Option<Recorded>>,
}

impl CaptureHandle {
    pub fn stopper(&self) -> std_mpsc::Sender<()> {
        self.stop.clone()
    }
}

/// Open the device and start capturing right away.
pub fn spawn(
    device_id: Option<String>,
    keydown: Instant,
    audio_tx: UnboundedSender<AudioMsg>,
    hooks: CaptureHooks,
) -> CaptureHandle {
    let (stop_tx, stop_rx) = std_mpsc::channel();
    let (done_tx, done_rx) = oneshot::channel();
    let spawned = thread::Builder::new()
        .name("voicebox-dictation-capture".into())
        .spawn(move || {
            let recorded = run(device_id, keydown, audio_tx, stop_rx, hooks);
            let _ = done_tx.send(recorded);
        });
    if let Err(e) = spawned {
        eprintln!("[dictation] failed to spawn capture thread: {e}");
    }
    CaptureHandle {
        stop: stop_tx,
        done: done_rx,
    }
}

/// State shared with the realtime callback. Atomics only.
#[derive(Default)]
struct Shared {
    first_sound_nanos: AtomicU64,
    heard: AtomicBool,
    dropped: AtomicU64,
    failed: AtomicBool,
}

fn run(
    device_id: Option<String>,
    keydown: Instant,
    audio_tx: UnboundedSender<AudioMsg>,
    stop_rx: std_mpsc::Receiver<()>,
    hooks: CaptureHooks,
) -> Option<Recorded> {
    let CaptureHooks {
        on_heard,
        mut on_level,
        on_stopped,
        on_error,
    } = hooks;
    let shared = Arc::new(Shared::default());
    let opened = open(device_id.as_deref(), keydown, shared.clone());
    let (stream, mut consumer, sample_rate) = match opened {
        Ok(opened) => opened,
        Err(message) => {
            eprintln!("[dictation] microphone unavailable: {message}");
            let _ = audio_tx.send(AudioMsg::Cancel);
            on_error(format!("Microphone unavailable: {message}"));
            return None;
        }
    };
    let _ = audio_tx.send(AudioMsg::Format(sample_rate));
    if let Err(e) = stream.play() {
        let _ = stream.pause();
        let _ = audio_tx.send(AudioMsg::Cancel);
        on_error(format!("Microphone unavailable: {e}"));
        return None;
    }
    let mut metrics = TakeMetrics {
        stream_open: Some(keydown.elapsed()),
        sample_rate,
        ..Default::default()
    };
    let playing_since = Instant::now();
    let mut framer = Framer::new(sample_rate);
    let mut meter = LevelMeter::new(sample_rate);
    let mut low_cut = LowCut::new(sample_rate);
    let max_fallback = sample_rate as usize * MAX_FALLBACK_SECONDS;
    let mut recording: Vec<i16> = Vec::with_capacity(sample_rate as usize * 30);
    let mut scratch: Vec<i16> = Vec::with_capacity(sample_rate as usize);
    let mut on_heard = Some(on_heard);
    let mut leading_zeros: Option<u64> = None;

    let mut drain = |consumer: &mut rtrb::Consumer<i16>,
                     framer: &mut Framer,
                     recording: &mut Vec<i16>,
                     leading_zeros: &mut Option<u64>| {
        scratch.clear();
        while let Ok(sample) = consumer.pop() {
            scratch.push(sample);
        }
        if scratch.is_empty() {
            return;
        }
        if leading_zeros.is_none() {
            if let Some(index) = scratch.iter().position(|&s| s != 0) {
                *leading_zeros = Some(recording.len() as u64 + index as u64);
            }
        }
        // Everything downstream (server, fallback upload, HUD level) gets the
        // audio without hum below the voice.
        low_cut.process(&mut scratch);
        let room = max_fallback.saturating_sub(recording.len());
        recording.extend_from_slice(&scratch[..scratch.len().min(room)]);
        for frame in framer.push(&scratch) {
            let _ = audio_tx.send(AudioMsg::Frame(frame));
        }
        // After the frames: the HUD's level events must never delay audio
        // on its way to the server.
        meter.push(&scratch, &mut on_level);
    };

    loop {
        match stop_rx.recv_timeout(DRAIN_INTERVAL) {
            Ok(()) | Err(std_mpsc::RecvTimeoutError::Disconnected) => break,
            Err(std_mpsc::RecvTimeoutError::Timeout) => {}
        }
        drain(
            &mut consumer,
            &mut framer,
            &mut recording,
            &mut leading_zeros,
        );
        if on_heard.is_some()
            && (shared.heard.load(Ordering::Relaxed) || playing_since.elapsed() >= HEARD_FALLBACK)
        {
            if let Some(hook) = on_heard.take() {
                hook();
            }
        }
        if shared.failed.load(Ordering::Relaxed) {
            eprintln!("[dictation] input stream failed; ending the take");
            break;
        }
    }

    metrics.wall = keydown.elapsed();
    // Stop the device explicitly: for a chosen (non-default) microphone,
    // cpal 0.15's disconnect listener keeps the stream alive, so dropping it
    // alone left the microphone running after every take. Pausing stops the
    // audio unit, and every callback has returned by then, so the final drain
    // sees all audio.
    let _ = stream.pause();
    drop(stream);
    drain(
        &mut consumer,
        &mut framer,
        &mut recording,
        &mut leading_zeros,
    );
    if let Some(tail) = framer.flush() {
        let _ = audio_tx.send(AudioMsg::Frame(tail));
    }

    metrics.samples = recording.len() as u64;
    metrics.leading_zero_samples = leading_zeros.unwrap_or(metrics.samples);
    metrics.dropped_samples = shared.dropped.load(Ordering::Relaxed);
    let first_sound = shared.first_sound_nanos.load(Ordering::Relaxed);
    if shared.heard.load(Ordering::Relaxed) {
        metrics.first_sound = Some(Duration::from_nanos(first_sound));
    }
    eprintln!("[dictation] take captured: {}", metrics.summary());

    let recorded = Recorded {
        pcm: recording,
        sample_rate,
    };
    let duration = recorded.duration();
    if duration < MIN_RECORDING {
        let _ = audio_tx.send(AudioMsg::Cancel);
    } else {
        on_stopped(duration);
        let _ = audio_tx.send(AudioMsg::End);
    }
    Some(recorded)
}

type Opened = (cpal::Stream, rtrb::Consumer<i16>, u32);

fn open(device_id: Option<&str>, keydown: Instant, shared: Arc<Shared>) -> Result<Opened, String> {
    let host = cpal::default_host();
    let device = select_device(&host, device_id)?;
    let default_config = device
        .default_input_config()
        .map_err(|e| format!("no input configuration ({e})"))?;
    let ranges: Vec<(u32, u32)> = device
        .supported_input_configs()
        .map(|configs| {
            configs
                .filter(|c| c.sample_format() == default_config.sample_format())
                .map(|c| (c.min_sample_rate().0, c.max_sample_rate().0))
                .collect()
        })
        .unwrap_or_default();
    let sample_rate = audio::choose_sample_rate(default_config.sample_rate().0, &ranges)
        .ok_or_else(|| {
            format!(
                "unsupported sample rate {} Hz",
                default_config.sample_rate().0
            )
        })?;
    let config = StreamConfig {
        channels: default_config.channels(),
        sample_rate: cpal::SampleRate(sample_rate),
        buffer_size: cpal::BufferSize::Default,
    };
    let (producer, consumer) = rtrb::RingBuffer::<i16>::new(sample_rate as usize * RING_SECONDS);
    let stream = match default_config.sample_format() {
        SampleFormat::F32 => build::<f32>(&device, &config, producer, keydown, shared),
        SampleFormat::I16 => build::<i16>(&device, &config, producer, keydown, shared),
        SampleFormat::I32 => build::<i32>(&device, &config, producer, keydown, shared),
        SampleFormat::U16 => build::<u16>(&device, &config, producer, keydown, shared),
        other => return Err(format!("unsupported sample format {other:?}")),
    }?;
    Ok((stream, consumer, sample_rate))
}

fn select_device(host: &cpal::Host, device_id: Option<&str>) -> Result<cpal::Device, String> {
    let saved_native = device_id.is_some_and(|id| id.starts_with(audio::NATIVE_DEVICE_PREFIX));
    if saved_native {
        if let Ok(devices) = host.input_devices() {
            let devices: Vec<cpal::Device> = devices.collect();
            let names: Vec<String> = devices
                .iter()
                .map(|d| d.name().unwrap_or_default())
                .collect();
            if let Some(index) = audio::pick_device(&names, device_id) {
                return Ok(devices.into_iter().nth(index).expect("index from names"));
            }
        }
        eprintln!(
            "[dictation] saved microphone {:?} not found; using the system default",
            device_id
        );
    }
    host.default_input_device()
        .ok_or_else(|| "no input device".to_string())
}

fn build<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    mut producer: rtrb::Producer<i16>,
    keydown: Instant,
    shared: Arc<Shared>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = config.channels.max(1) as usize;
    let error_shared = shared.clone();
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                // Realtime thread: no locks, no allocation, no I/O.
                let mut heard = shared.heard.load(Ordering::Relaxed);
                audio::downmix(data, channels, |value| {
                    if !heard && value != 0 {
                        heard = true;
                        shared
                            .first_sound_nanos
                            .store(keydown.elapsed().as_nanos() as u64, Ordering::Relaxed);
                        shared.heard.store(true, Ordering::Relaxed);
                    }
                    if producer.push(value).is_err() {
                        shared.dropped.fetch_add(1, Ordering::Relaxed);
                    }
                });
            },
            move |err| {
                eprintln!("[dictation] input stream error: {err}");
                error_shared.failed.store(true, Ordering::Relaxed);
            },
            None,
        )
        .map_err(|e| format!("could not open the microphone ({e})"))
}
