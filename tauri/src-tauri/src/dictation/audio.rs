//! Pure audio helpers for native dictation: downmix, framing, device and
//! sample-rate choice, WAV encoding and per-take metrics.

use std::time::Duration;

/// Frame length streamed to the server.
pub const FRAME_DURATION: Duration = Duration::from_millis(100);
/// The server accepts 16–48 kHz.
pub const MIN_SAMPLE_RATE: u32 = 16_000;
pub const MAX_SAMPLE_RATE: u32 = 48_000;
/// Prefix that marks a saved `input_device_id` as a native device, so it is
/// never mistaken for a WebKit media device id (and vice versa).
pub const NATIVE_DEVICE_PREFIX: &str = "native:";

/// Convert a float sample in [-1, 1] to s16, clamping out-of-range input.
pub fn f32_to_i16(sample: f32) -> i16 {
    if sample.is_nan() {
        return 0;
    }
    (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16
}

/// Average interleaved channels into mono s16, calling `emit` per frame.
/// Runs on the realtime audio thread: no allocation.
#[inline]
pub fn downmix<T>(data: &[T], channels: usize, mut emit: impl FnMut(i16))
where
    T: cpal::Sample,
    f32: cpal::FromSample<T>,
{
    let channels = channels.max(1);
    for frame in data.chunks_exact(channels) {
        let mut sum = 0.0f32;
        for &sample in frame {
            sum += sample.to_sample::<f32>();
        }
        emit(f32_to_i16(sum / channels as f32));
    }
}

/// Groups mono samples into fixed-size frames.
pub struct Framer {
    frame_samples: usize,
    buffer: Vec<i16>,
}

impl Framer {
    pub fn new(sample_rate: u32) -> Self {
        let frame_samples =
            ((sample_rate as u128 * FRAME_DURATION.as_millis()) / 1000).max(1) as usize;
        Self {
            frame_samples,
            buffer: Vec::with_capacity(frame_samples),
        }
    }

    /// Append samples; returns every complete frame.
    pub fn push(&mut self, samples: &[i16]) -> Vec<Vec<i16>> {
        let mut frames = Vec::new();
        let mut rest = samples;
        while !rest.is_empty() {
            let take = (self.frame_samples - self.buffer.len()).min(rest.len());
            self.buffer.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
            if self.buffer.len() == self.frame_samples {
                frames.push(std::mem::replace(
                    &mut self.buffer,
                    Vec::with_capacity(self.frame_samples),
                ));
            }
        }
        frames
    }

    /// The final partial frame, if any.
    pub fn flush(&mut self) -> Option<Vec<i16>> {
        if self.buffer.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.buffer))
        }
    }
}

pub fn native_device_id(name: &str) -> String {
    format!("{NATIVE_DEVICE_PREFIX}{name}")
}

/// Index of the saved device among `names`, or `None` for the system
/// default (nothing saved, a non-native id, or the device is gone).
pub fn pick_device(names: &[String], saved_id: Option<&str>) -> Option<usize> {
    let wanted = saved_id?.strip_prefix(NATIVE_DEVICE_PREFIX)?;
    names.iter().position(|name| name == wanted)
}

/// Pick a capture rate the server accepts. Prefer the device default; else
/// the closest rate inside a supported `(min, max)` range.
pub fn choose_sample_rate(default_rate: u32, supported: &[(u32, u32)]) -> Option<u32> {
    if (MIN_SAMPLE_RATE..=MAX_SAMPLE_RATE).contains(&default_rate) {
        return Some(default_rate);
    }
    // Closest accepted rate to the default within any supported range.
    supported
        .iter()
        .filter_map(|&(min, max)| {
            let low = min.max(MIN_SAMPLE_RATE);
            let high = max.min(MAX_SAMPLE_RATE);
            (low <= high).then(|| default_rate.clamp(low, high))
        })
        .min_by_key(|&rate| rate.abs_diff(default_rate))
}

/// Mono s16 WAV bytes for the batch fallback upload.
pub fn encode_wav(pcm: &[i16], sample_rate: u32) -> Result<Vec<u8>, String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cursor = std::io::Cursor::new(Vec::with_capacity(44 + pcm.len() * 2));
    {
        let mut writer = hound::WavWriter::new(&mut cursor, spec).map_err(|e| e.to_string())?;
        let mut samples = writer.get_i16_writer(pcm.len() as u32);
        for &sample in pcm {
            samples.write_sample(sample);
        }
        samples.flush().map_err(|e| e.to_string())?;
        writer.finalize().map_err(|e| e.to_string())?;
    }
    Ok(cursor.into_inner())
}

/// Timing evidence for one take, logged when it ends.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TakeMetrics {
    /// Key-down to the input stream running.
    pub stream_open: Option<Duration>,
    /// Key-down to the first non-zero sample from the device.
    pub first_sound: Option<Duration>,
    /// Leading zero samples before the first non-zero one.
    pub leading_zero_samples: u64,
    pub samples: u64,
    pub sample_rate: u32,
    /// Key-down to key-up.
    pub wall: Duration,
    /// Samples the ring buffer had to drop (should always be zero).
    pub dropped_samples: u64,
}

impl TakeMetrics {
    pub fn audio_seconds(&self) -> f64 {
        if self.sample_rate == 0 {
            0.0
        } else {
            self.samples as f64 / self.sample_rate as f64
        }
    }

    /// Audio length over wall-clock length; about 1 for a healthy capture
    /// (a little under 1 because the device opens after key-down).
    pub fn audio_wall_ratio(&self) -> f64 {
        let wall = self.wall.as_secs_f64();
        if wall <= 0.0 {
            0.0
        } else {
            self.audio_seconds() / wall
        }
    }

    pub fn summary(&self) -> String {
        fn ms(d: Option<Duration>) -> String {
            d.map(|d| format!("{:.0}ms", d.as_secs_f64() * 1000.0))
                .unwrap_or_else(|| "n/a".into())
        }
        format!(
            "keydown→stream {} keydown→first-sound {} leading-zeros {:.0}ms audio {:.2}s wall {:.2}s ratio {:.3} rate {}Hz dropped {}",
            ms(self.stream_open),
            ms(self.first_sound),
            if self.sample_rate == 0 {
                0.0
            } else {
                self.leading_zero_samples as f64 * 1000.0 / self.sample_rate as f64
            },
            self.audio_seconds(),
            self.wall.as_secs_f64(),
            self.audio_wall_ratio(),
            self.sample_rate,
            self.dropped_samples,
        )
    }
}

/// Below this, a microphone picks up hum (fans, air conditioning, mains)
/// rather than words. A fan on the user's microphone hummed at 120–140 Hz, as
/// loud as their voice. On 27 of their takes, cutting it left Whisper's
/// transcripts and the voice detector's results essentially unchanged.
pub const LOW_CUT_HZ: f64 = 200.0;

/// An 8th-order Butterworth high-pass at [`LOW_CUT_HZ`], as four biquads.
/// Steep enough to take a hum at 130 Hz down ~30 dB.
pub struct LowCut {
    stages: [Biquad; 4],
}

impl LowCut {
    pub fn new(sample_rate: u32) -> Self {
        // The Q of each pole pair of an 8th-order Butterworth.
        let q = |k: f64| 1.0 / (2.0 * ((2.0 * k - 1.0) * std::f64::consts::PI / 16.0).cos());
        Self {
            stages: [1.0, 2.0, 3.0, 4.0].map(|k| Biquad::high_pass(sample_rate, LOW_CUT_HZ, q(k))),
        }
    }

    /// Filter samples in place.
    pub fn process(&mut self, samples: &mut [i16]) {
        for sample in samples {
            let mut value = *sample as f64;
            for stage in &mut self.stages {
                value = stage.process(value);
            }
            *sample = value.round().clamp(i16::MIN as f64, i16::MAX as f64) as i16;
        }
    }
}

/// One second-order section (direct form I).
struct Biquad {
    b: [f64; 3],
    a: [f64; 2],
    x: [f64; 2],
    y: [f64; 2],
}

impl Biquad {
    /// The Audio EQ Cookbook high-pass.
    fn high_pass(sample_rate: u32, cutoff: f64, q: f64) -> Self {
        let w0 = 2.0 * std::f64::consts::PI * cutoff / sample_rate as f64;
        let alpha = w0.sin() / (2.0 * q);
        let cos = w0.cos();
        let a0 = 1.0 + alpha;
        Self {
            b: [
                (1.0 + cos) / 2.0 / a0,
                -(1.0 + cos) / a0,
                (1.0 + cos) / 2.0 / a0,
            ],
            a: [-2.0 * cos / a0, (1.0 - alpha) / a0],
            x: [0.0; 2],
            y: [0.0; 2],
        }
    }

    fn process(&mut self, x: f64) -> f64 {
        let y = self.b[0] * x + self.b[1] * self.x[0] + self.b[2] * self.x[1]
            - self.a[0] * self.y[0]
            - self.a[1] * self.y[1];
        self.x = [x, self.x[0]];
        self.y = [y, self.y[0]];
        y
    }
}

/// How often the recording HUD gets a new input level.
pub const LEVEL_INTERVAL: Duration = Duration::from_millis(50);
/// Reported for digital silence, which would otherwise be -inf dBFS.
pub const LEVEL_FLOOR_DBFS: f32 = -100.0;

/// Measures input loudness as RMS dBFS over fixed windows.
pub struct LevelMeter {
    window: usize,
    count: usize,
    sum_squares: f64,
}

impl LevelMeter {
    pub fn new(sample_rate: u32) -> Self {
        let window = ((sample_rate as u128 * LEVEL_INTERVAL.as_millis()) / 1000).max(1) as usize;
        Self {
            window,
            count: 0,
            sum_squares: 0.0,
        }
    }

    /// Add samples, calling `emit` with the level of each completed window.
    pub fn push(&mut self, samples: &[i16], mut emit: impl FnMut(f32)) {
        for &sample in samples {
            let value = sample as f64 / 32768.0;
            self.sum_squares += value * value;
            self.count += 1;
            if self.count == self.window {
                emit(dbfs(self.sum_squares / self.count as f64));
                self.count = 0;
                self.sum_squares = 0.0;
            }
        }
    }
}

/// Mean square of full-scale-normalized samples, in dBFS.
fn dbfs(mean_square: f64) -> f32 {
    if mean_square <= 0.0 {
        return LEVEL_FLOOR_DBFS;
    }
    ((10.0 * mean_square.log10()) as f32).max(LEVEL_FLOOR_DBFS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn levels(sample_rate: u32, samples: &[i16]) -> Vec<f32> {
        let mut meter = LevelMeter::new(sample_rate);
        let mut out = Vec::new();
        meter.push(samples, |db| out.push(db));
        out
    }

    #[test]
    fn level_meter_reports_one_level_per_50ms() {
        // 48 kHz: 2400 samples per window; the remainder carries over.
        let mut meter = LevelMeter::new(48_000);
        let mut out = Vec::new();
        meter.push(&vec![1000; 5000], |db| out.push(db));
        assert_eq!(out.len(), 2);
        meter.push(&vec![1000; 2200], |db| out.push(db));
        assert_eq!(out.len(), 3);
    }

    #[test]
    fn level_meter_measures_rms_dbfs() {
        let silence = levels(16_000, &vec![0; 800]);
        assert_eq!(silence, vec![LEVEL_FLOOR_DBFS]);

        let full: Vec<i16> = (0..800)
            .map(|i| if i % 2 == 0 { 32767 } else { -32768 })
            .collect();
        assert!(levels(16_000, &full)[0].abs() < 0.01);

        let half: Vec<i16> = (0..800)
            .map(|i| if i % 2 == 0 { 16384 } else { -16384 })
            .collect();
        assert!((levels(16_000, &half)[0] + 6.02).abs() < 0.05);
    }

    fn tone_gain_db(sample_rate: u32, hz: f64) -> f64 {
        let tone: Vec<i16> = (0..sample_rate)
            .map(|i| {
                (10_000.0 * (2.0 * std::f64::consts::PI * hz * i as f64 / sample_rate as f64).sin())
                    as i16
            })
            .collect();
        let mut filtered = tone.clone();
        LowCut::new(sample_rate).process(&mut filtered);
        // Skip the first 100 ms while the filter settles.
        let rms = |s: &[i16]| {
            let tail = &s[s.len() / 10..];
            (tail.iter().map(|&v| (v as f64).powi(2)).sum::<f64>() / tail.len() as f64).sqrt()
        };
        20.0 * (rms(&filtered) / rms(&tone)).log10()
    }

    #[test]
    fn low_cut_removes_hum_and_keeps_the_voice() {
        for rate in [16_000, 44_100, 48_000] {
            assert!(tone_gain_db(rate, 130.0) < -25.0, "hum at {rate} Hz");
            assert!(tone_gain_db(rate, 60.0) < -60.0, "mains at {rate} Hz");
            assert!(tone_gain_db(rate, 400.0).abs() < 0.5, "voice at {rate} Hz");
            assert!(
                tone_gain_db(rate, 2_000.0).abs() < 0.5,
                "voice at {rate} Hz"
            );
        }
    }

    #[test]
    fn low_cut_keeps_digital_silence_silent() {
        // Leading zeros mark how long the device took to start.
        let mut silence = vec![0i16; 4800];
        LowCut::new(48_000).process(&mut silence);
        assert!(silence.iter().all(|&s| s == 0));
    }

    #[test]
    fn float_samples_convert_and_clamp() {
        assert_eq!(f32_to_i16(0.0), 0);
        assert_eq!(f32_to_i16(1.0), i16::MAX);
        assert_eq!(f32_to_i16(-1.0), -i16::MAX);
        assert_eq!(f32_to_i16(2.0), i16::MAX);
        assert_eq!(f32_to_i16(-2.0), -i16::MAX);
        assert_eq!(f32_to_i16(f32::NAN), 0);
    }

    #[test]
    fn downmix_averages_channels() {
        let mut out = Vec::new();
        downmix(&[1.0f32, 0.0, -1.0, -1.0], 2, |s| out.push(s));
        assert_eq!(out, vec![f32_to_i16(0.5), -i16::MAX]);
        let mut mono = Vec::new();
        downmix(&[0.5f32, -0.5], 1, |s| mono.push(s));
        assert_eq!(mono, vec![f32_to_i16(0.5), f32_to_i16(-0.5)]);
        let mut ints = Vec::new();
        downmix(&[i16::MAX, 0i16], 2, |s| ints.push(s));
        assert!((ints[0] - i16::MAX / 2).abs() <= 1);
    }

    #[test]
    fn framer_emits_100ms_frames_and_flushes_the_tail() {
        let mut framer = Framer::new(16_000);
        assert!(framer.push(&[1; 1000]).is_empty());
        let frames = framer.push(&[2; 2500]);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].len(), 1600);
        assert_eq!(frames[0][999], 1);
        assert_eq!(frames[0][1000], 2);
        assert_eq!(framer.flush(), Some(vec![2; 300]));
        assert_eq!(framer.flush(), None);
    }

    #[test]
    fn saved_native_device_is_found_and_anything_else_means_default() {
        let names = vec!["MacBook Pro Microphone".to_string(), "AirPods".to_string()];
        assert_eq!(
            pick_device(&names, Some(&native_device_id("AirPods"))),
            Some(1)
        );
        assert_eq!(pick_device(&names, None), None);
        assert_eq!(
            pick_device(&names, Some(&native_device_id("Unplugged"))),
            None
        );
        // A legacy WebKit media device id.
        assert_eq!(pick_device(&names, Some("3f9a0c1d")), None);
        assert_eq!(pick_device(&names, Some("AirPods")), None);
    }

    #[test]
    fn sample_rate_prefers_default_within_server_limits() {
        assert_eq!(choose_sample_rate(48_000, &[]), Some(48_000));
        assert_eq!(choose_sample_rate(16_000, &[]), Some(16_000));
        assert_eq!(choose_sample_rate(44_100, &[]), Some(44_100));
        // 96 kHz default: use a supported rate the server accepts.
        assert_eq!(
            choose_sample_rate(96_000, &[(96_000, 96_000), (8_000, 48_000)]),
            Some(48_000)
        );
        assert_eq!(choose_sample_rate(8_000, &[(8_000, 8_000)]), None);
        assert_eq!(choose_sample_rate(8_000, &[(8_000, 22_050)]), Some(16_000));
    }

    #[test]
    fn wav_roundtrips() {
        let bytes = encode_wav(&[0, 1, -1, i16::MAX], 16_000).unwrap();
        let mut reader = hound::WavReader::new(std::io::Cursor::new(bytes)).unwrap();
        assert_eq!(reader.spec().sample_rate, 16_000);
        assert_eq!(reader.spec().channels, 1);
        let samples: Vec<i16> = reader.samples::<i16>().map(Result::unwrap).collect();
        assert_eq!(samples, vec![0, 1, -1, i16::MAX]);
    }

    #[test]
    fn audio_wall_ratio() {
        let metrics = TakeMetrics {
            samples: 48_000,
            sample_rate: 48_000,
            wall: Duration::from_secs(2),
            ..Default::default()
        };
        assert!((metrics.audio_wall_ratio() - 0.5).abs() < 1e-9);
        assert_eq!(TakeMetrics::default().audio_wall_ratio(), 0.0);
        assert!(metrics.summary().contains("ratio 0.500"));
    }
}
