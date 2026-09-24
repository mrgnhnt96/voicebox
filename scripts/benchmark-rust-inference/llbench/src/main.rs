//! llama.cpp (Metal) through llama-cpp-2, in process: the cleanup call as an app would make it.
//!
//! usage: llbench <model.gguf> <prompts.json> <passes>   -> JSON lines on stdout
//! Keeps one context and the token list it holds; each call trims the KV cache to the
//! prefix shared with the new prompt (like MLXQwenLLMBackend._reusable_cache), decodes
//! only the new suffix, then samples greedily (temperature 0) until end of generation.
use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;
use llama_cpp_2::token::LlamaToken;
use std::num::NonZeroU32;
use std::time::Instant;

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

#[cfg(feature = "with-whisper")]
fn touch_whisper() -> bool {
    // Referenced so the linker keeps whisper.cpp (and its ggml copy) in the binary.
    whisper_rs::WhisperContextParameters::default().use_gpu
}
#[cfg(not(feature = "with-whisper"))]
fn touch_whisper() -> bool {
    false
}

const BATCH: usize = 512;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (model_path, prompts, passes) = (&args[1], &args[2], args[3].parse::<usize>().unwrap());
    let doc: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(prompts).unwrap()).unwrap();
    let entries = doc["entries"].as_array().unwrap();
    let variant = format!(
        "llama-cpp-2 {}",
        std::path::Path::new(model_path).file_stem().unwrap().to_string_lossy()
    );

    let t = Instant::now();
    let backend = LlamaBackend::init().unwrap();
    let model =
        LlamaModel::load_from_file(&backend, model_path, &LlamaModelParams::default().with_n_gpu_layers(999)).unwrap();
    let cp = LlamaContextParams::default()
        .with_n_ctx(NonZeroU32::new(4096))
        .with_n_batch(BATCH as u32)
        .with_flash_attention_policy(llama_cpp_sys_2::LLAMA_FLASH_ATTN_TYPE_ENABLED);
    let mut ctx = model.new_context(&backend, cp).unwrap();
    let (fp, peak, rss) = footprint_mb();
    println!(
        "{}",
        serde_json::json!({"event": "load", "engine": "llama-cpp-2", "variant": variant,
        "load_s": t.elapsed().as_secs_f64(), "footprint_mb": fp, "peak_footprint_mb": peak, "resident_mb": rss,
        "whisper_linked": touch_whisper()})
    );

    let mut cached: Vec<LlamaToken> = Vec::new();
    let mut batch = LlamaBatch::new(BATCH, 1);
    let mut call = 0;
    for pass in 0..passes {
        for (i, e) in entries.iter().enumerate() {
            let s = Instant::now();
            let tokens = model.str_to_token(e["chat"].as_str().unwrap(), AddBos::Never).unwrap();
            let limit = cached.len().min(tokens.len() - 1);
            let shared = (0..limit).take_while(|&k| cached[k] == tokens[k]).count();
            ctx.clear_kv_cache_seq(Some(0), Some(shared as u32), None).unwrap();
            cached.truncate(shared);

            // Prefill the uncached suffix.
            let mut pos = shared;
            while pos < tokens.len() {
                batch.clear();
                let end = (pos + BATCH).min(tokens.len());
                for k in pos..end {
                    batch.add(tokens[k], k as i32, &[0], k == tokens.len() - 1).unwrap();
                }
                ctx.decode(&mut batch).unwrap();
                pos = end;
            }
            cached.extend_from_slice(&tokens[shared..]);
            // llama_decode only queues Metal work; the wait happens when logits are read,
            // so this is submit time, not compute time. first_token_s below is the honest TTFT.
            let prefill_s = s.elapsed().as_secs_f64();

            // Greedy generation.
            let mut sampler = LlamaSampler::greedy();
            let mut decoder = encoding_rs::UTF_8.new_decoder();
            let mut text = String::new();
            let mut generated = 0;
            let mut last_idx = batch.n_tokens() - 1;
            let mut n_pos = tokens.len() as i32;
            let mut first_token_s = 0.0;
            loop {
                let tok = sampler.sample(&ctx, last_idx);
                sampler.accept(tok);
                generated += 1;
                if generated == 1 {
                    first_token_s = s.elapsed().as_secs_f64();
                }
                if model.is_eog_token(tok) || generated >= 256 {
                    break;
                }
                text.push_str(&model.token_to_piece(tok, &mut decoder, false, None).unwrap());
                batch.clear();
                batch.add(tok, n_pos, &[0], true).unwrap();
                ctx.decode(&mut batch).unwrap();
                cached.push(tok);
                n_pos += 1;
                last_idx = 0;
            }
            let wall = s.elapsed().as_secs_f64();
            println!(
                "{}",
                serde_json::json!({"event": "generate", "engine": "llama-cpp-2", "variant": variant,
                "pass": pass, "call": call, "entry": i, "wall_s": wall, "prefill_submit_s": prefill_s, "first_token_s": first_token_s,
                "prompt_tokens": tokens.len(), "reused_tokens": shared, "generated": generated,
                "text": text.trim()})
            );
            call += 1;
        }
    }
    let (fp, peak, rss) = footprint_mb();
    println!(
        "{}",
        serde_json::json!({"event": "done", "variant": variant, "footprint_mb": fp, "peak_footprint_mb": peak, "resident_mb": rss})
    );
}
