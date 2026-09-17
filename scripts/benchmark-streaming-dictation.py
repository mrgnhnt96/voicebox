#!/usr/bin/env python3
"""Replay a non-sensitive mono PCM fixture through batch and streaming inference.

Run from the repository root with backend/venv/bin/python. No model downloads,
user capture writes, or transcript logging. See docs/plans/STREAMING_BENCHMARK.md.
"""

import argparse
import asyncio
import contextlib
import hashlib
import importlib.metadata
import json
import os
import platform
import re
import resource
import struct
import sys
import tempfile
import time
import wave
from pathlib import Path
from types import SimpleNamespace

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def word_error_rate(reference, hypothesis):
    expected = re.findall(r"\w+", reference.lower())
    actual = re.findall(r"\w+", hypothesis.lower())
    previous = list(range(len(actual) + 1))
    for i, token in enumerate(expected, 1):
        current = [i]
        for j, candidate in enumerate(actual, 1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[j] + 1,
                    previous[j - 1] + (token != candidate),
                )
            )
        previous = current
    return previous[-1] / max(len(expected), 1)


async def benchmark(args):
    from backend import config
    from backend.services.capture_stream import StreamingCapture
    from backend.services.refinement import RefinementFlags, refine_transcript
    from backend.services.transcribe import get_whisper_model

    service_path = (
        Path(__file__).resolve().parents[1] / "backend/services/capture_stream.py"
    )
    service_sha256 = hashlib.sha256(service_path.read_bytes()).hexdigest()
    with wave.open(str(args.audio), "rb") as audio:
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2:
            raise ValueError("Fixture must be mono 16-bit PCM WAV")
        rate = audio.getframerate()
        pcm = audio.readframes(audio.getnframes())
    reference = args.reference.read_text().strip()
    duration = len(pcm) / (rate * 2)
    rows = []
    with tempfile.TemporaryDirectory(prefix="voicebox-benchmark-") as directory:
        config.set_data_dir(directory)
        for index in range(args.runs):
            stt = get_whisper_model()
            started = time.perf_counter()
            raw = await stt.transcribe(
                str(args.audio), language="en", model_size=args.stt_model
            )
            recognized = time.perf_counter()
            refined, _ = await refine_transcript(
                raw,
                RefinementFlags(),
                model_size=args.llm_model,
                use_personal_model=False,
            )
            ended = time.perf_counter()
            row = {
                "run": index,
                "batch": {
                    "stt_seconds": recognized - started,
                    "refine_seconds": ended - recognized,
                    "stop_to_output_seconds": ended - started,
                    "raw_wer": word_error_rate(reference, raw),
                    "refined_wer": word_error_rate(reference, refined),
                },
            }
            events = []

            async def send(event, events=events):
                events.append((time.perf_counter(), event))

            settings = SimpleNamespace(
                language="en",
                stt_model=args.stt_model,
                auto_refine=True,
                llm_model=args.llm_model,
                smart_cleanup=True,
                self_correction=True,
                preserve_technical=True,
                allow_auto_paste=False,
            )
            session = StreamingCapture(
                {
                    "type": "start",
                    "protocol_version": 1,
                    "sample_rate": rate,
                    "channels": 1,
                    "encoding": "pcm_s16le",
                },
                settings,
                send,
            )
            started = time.perf_counter()
            task = asyncio.create_task(session.run())
            frame_samples = rate // 10
            max_backlog = 0
            try:
                for sequence, offset in enumerate(
                    range(0, len(pcm), frame_samples * 2)
                ):
                    frame = pcm[offset : offset + frame_samples * 2]
                    # Deliver each frame when its last sample would have arrived.
                    deadline = started + (offset + len(frame)) / (rate * 2)
                    await asyncio.sleep(max(0, deadline - time.perf_counter()))
                    session.append(struct.pack("<II", sequence, offset // 2) + frame)
                    max_backlog = max(max_backlog, len(session.pending) / (rate * 2))
                stopped = time.perf_counter()
                session.finish()
                await asyncio.wait_for(task, timeout=120)
                ended = time.perf_counter()

                def first(kind, accepted=False, started=started, events=events):
                    return next(
                        (
                            timestamp - started
                            for timestamp, event in events
                            if event["type"] == kind
                            and (not accepted or event.get("accepted_text"))
                        ),
                        None,
                    )

                row["stream"] = {
                    "stop_to_output_seconds": ended - stopped,
                    "first_partial_seconds": first("transcript"),
                    "first_accepted_seconds": first("transcript", True),
                    "first_refined_seconds": first("refined"),
                    "events_before_stop": sum(
                        timestamp < stopped for timestamp, _ in events
                    ),
                    "raw_wer": word_error_rate(reference, session.raw),
                    "refined_wer": word_error_rate(reference, session.refined),
                    "raw_matches_batch": session.raw == raw,
                    "raw_vs_batch_wer": word_error_rate(raw, session.raw),
                    "refined_matches_batch": session.refined == refined,
                    "refined_vs_batch_wer": word_error_rate(refined, session.refined),
                    "max_pending_audio_seconds": max_backlog,
                    "refinement_error": bool(session.refinement_error),
                    "degraded_reason": getattr(session, "degraded_reason", None),
                }
                rows.append(row)
            finally:
                session.abort = True
                session.wake.set()
                try:
                    with contextlib.suppress(asyncio.CancelledError):
                        await task
                finally:
                    session.close()
    result = {
        "audio_sha256": hashlib.sha256(args.audio.read_bytes()).hexdigest(),
        "service_sha256_at_start": service_sha256,
        "packages": {
            name: importlib.metadata.version(name)
            for name in ("mlx", "mlx-audio", "mlx-lm")
        },
        "duration_seconds": duration,
        "platform": platform.platform(),
        "stt_model": args.stt_model,
        "llm_model": args.llm_model,
        "peak_rss_platform_units": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        "notes": "First batch includes cold model load; streaming runs after warm batch. No paste/UI measured.",
        "runs": rows,
    }
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", type=Path)
    parser.add_argument("reference", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--stt-model", default="turbo")
    parser.add_argument("--llm-model", default="0.6B")
    asyncio.run(benchmark(parser.parse_args()))
