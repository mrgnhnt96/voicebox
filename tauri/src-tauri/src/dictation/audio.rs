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
pub fn downmix(data: &[f32], channels: usize, mut emit: impl FnMut(i16)) {
    let channels = channels.max(1);
    for frame in data.chunks_exact(channels) {
        let sum: f32 = frame.iter().sum();
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

#[cfg(test)]
mod tests {
    use super::*;

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
        downmix(&[1.0, 0.0, -1.0, -1.0], 2, |s| out.push(s));
        assert_eq!(out, vec![f32_to_i16(0.5), -i16::MAX]);
        let mut mono = Vec::new();
        downmix(&[0.5, -0.5], 1, |s| mono.push(s));
        assert_eq!(mono, vec![f32_to_i16(0.5), f32_to_i16(-0.5)]);
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
        assert_eq!(pick_device(&names, Some(&native_device_id("AirPods"))), Some(1));
        assert_eq!(pick_device(&names, None), None);
        assert_eq!(pick_device(&names, Some(&native_device_id("Unplugged"))), None);
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
