//! whisper.cpp (Metal) through whisper-rs, in process: load once, transcribe each fixture N times.
//!
//! usage: wrbench <ggml-model.bin> <runs> <wav16k>...   -> JSON lines on stdout
//! env:   WR_FLASH=1        flash attention (whisper-rs default is off)
//!        WR_NO_TS=1        no timestamp tokens (mlx-audio decodes with timestamps)
//!        WR_AUDIO_CTX=n    shrink the encoder window (0 = full 30 s, the default;
//!                          -1 = fit each clip: 50 frames per second of audio + 64)
//!        WR_THREADS=n      CPU threads (default 4)
use std::time::Instant;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

extern "C" {
    fn proc_pid_rusage(pid: libc::c_int, flavor: libc::c_int, buffer: *mut u64) -> libc::c_int;
}

/// (phys_footprint, lifetime_max_phys_footprint, resident_size) in MB, from rusage_info_v4.
/// Footprint leaves out clean file-backed pages, so mmap'd GGUF/ggml weights show only in resident.
fn footprint_mb() -> (f64, f64, f64) {
    let mut buf = [0u64; 64];
    unsafe { proc_pid_rusage(libc::getpid(), 4, buf.as_mut_ptr()) };
    (buf[9] as f64 / 1048576.0, buf[30] as f64 / 1048576.0, buf[8] as f64 / 1048576.0)
}

fn env_flag(k: &str) -> bool {
    std::env::var(k).map(|v| v == "1").unwrap_or(false)
}

fn read_wav(path: &str) -> Vec<f32> {
    let mut r = hound::WavReader::open(path).expect("wav");
    let spec = r.spec();
    assert_eq!(spec.sample_rate, 16000, "{path}: fixtures must be 16 kHz");
    assert_eq!(spec.channels, 1, "{path}: fixtures must be mono");
    r.samples::<i16>().map(|s| s.unwrap() as f32 / 32768.0).collect()
}

fn emit(v: serde_json::Value) {
    println!("{v}");
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (model, runs, wavs) = (&args[1], args[2].parse::<usize>().unwrap(), &args[3..]);
    let flash = env_flag("WR_FLASH");
    let no_ts = env_flag("WR_NO_TS");
    let audio_ctx: i32 = std::env::var("WR_AUDIO_CTX").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
    let threads: i32 = std::env::var("WR_THREADS").ok().and_then(|v| v.parse().ok()).unwrap_or(4);
    let variant = format!(
        "{}{}{}{}",
        std::path::Path::new(model).file_stem().unwrap().to_string_lossy(),
        if flash { "+fa" } else { "" },
        if no_ts { "+nots" } else { "" },
        if audio_ctx != 0 { format!("+actx{audio_ctx}") } else { String::new() }
    );

    let t = Instant::now();
    let mut cp = WhisperContextParameters::default();
    cp.flash_attn(flash);
    let ctx = WhisperContext::new_with_params(model, cp).expect("load");
    let mut state = ctx.create_state().expect("state");
    let load_s = t.elapsed().as_secs_f64();
    let (fp, peak, rss) = footprint_mb();
    emit(serde_json::json!({"event": "load", "engine": "whisper-rs", "variant": variant,
        "load_s": load_s, "footprint_mb": fp, "peak_footprint_mb": peak, "resident_mb": rss}));

    for wav in wavs {
        let audio = read_wav(wav);
        let stem = std::path::Path::new(wav).file_stem().unwrap().to_string_lossy().to_string();
        for run in 0..runs {
            let s = Instant::now();
            let mut p = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
            p.set_language(Some("en"));
            p.set_n_threads(threads);
            p.set_no_timestamps(no_ts);
            p.set_print_progress(false);
            p.set_print_realtime(false);
            p.set_print_special(false);
            p.set_print_timestamps(false);
            if audio_ctx > 0 {
                p.set_audio_ctx(audio_ctx);
            } else if audio_ctx < 0 {
                p.set_audio_ctx((audio.len() as i32 * 50 / 16000 + 64).min(1500));
            }
            state.full(p, &audio).expect("full");
            let mut text = String::new();
            for seg in state.as_iter() {
                text.push_str(&seg.to_str_lossy().unwrap());
            }
            emit(serde_json::json!({"event": "transcribe", "engine": "whisper-rs", "variant": variant,
                "fixture": stem, "run": run, "wall_s": s.elapsed().as_secs_f64(), "text": text.trim()}));
        }
    }
    let (fp, peak, rss) = footprint_mb();
    emit(serde_json::json!({"event": "done", "variant": variant, "footprint_mb": fp, "peak_footprint_mb": peak, "resident_mb": rss}));
}
