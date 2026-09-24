"""Provisional cleaned text offered after release (docs/plans/STREAMING_INSERTION.md)."""

import asyncio
import struct
from unittest.mock import AsyncMock

import numpy as np
import pytest

from backend import config
from backend.models import CaptureSettingsResponse
from backend.services import capture_stream


def make_session(tmp_path, monkeypatch, provisional=True, **settings):
    monkeypatch.setattr(config, "_data_dir", tmp_path)
    events = []

    async def send(event):
        events.append(event)

    start = dict(type="start", protocol_version=1, sample_rate=16000, channels=1, encoding="pcm_s16le")
    if provisional:
        start["provisional"] = True
    session = capture_stream.StreamingCapture(
        start, CaptureSettingsResponse(**{"auto_refine": True, "allow_auto_paste": True, **settings}), send
    )
    from backend.services import correction_learning

    monkeypatch.setattr(correction_learning, "apply_learned_corrections", lambda text, _: text)
    return session, events


def append(session, seconds, amplitude=1000):
    pcm = np.full(round(seconds * session.rate), amplitude, dtype="<i2").tobytes()
    for offset in range(0, len(pcm), 32000):
        session.append(struct.pack("<II", session.sequence, session.samples) + pcm[offset : offset + 32000])


def streaming_refine(outputs):
    """A refine_transcript fake that generates each output piece by piece on another thread."""
    from backend.backends import qwen_llm_backend

    outputs = list(outputs)

    async def refine(prompt, flags, model_size=None):
        pieces = outputs.pop(0)
        listener = qwen_llm_backend.generation_listener.get()

        def generate():
            text = ""
            for piece in pieces:
                text += piece
                if listener is not None:
                    listener(text)
            return text

        return (await asyncio.to_thread(generate)).strip(), "4B"

    return refine


def provisional(events):
    return [event["text"] for event in events if event["type"] == "provisional"]


@pytest.mark.parametrize(
    ("text", "holdback", "expected"),
    [
        ("Hello there my friend.", 1, "Hello there my"),
        ("Hello there, my friend", 1, "Hello there, my"),
        ("Hello there, my", 1, "Hello there"),
        ("Hi", 1, ""),
        ("", 1, ""),
        ("One. Two three", 2, "One"),
        ("Done.", 0, "Done"),
        ("It costs $5 (maybe)", 0, "It costs $5 (maybe"),
        ("First line\nsecond", 1, "First line"),
    ],
)
def test_stable_prefix_holds_back_words_that_can_still_change(text, holdback, expected):
    assert capture_stream.stable_prefix(text, holdback) == expected


@pytest.mark.asyncio
async def test_final_phrase_cleanup_streams_prefixes_of_the_final_text(tmp_path, monkeypatch):
    session, events = make_session(tmp_path, monkeypatch)
    monkeypatch.setattr(
        capture_stream, "refine_transcript", streaming_refine([["Hello", " there", ",", " my", " friend", "."]])
    )
    session.recognize = AsyncMock(return_value="hello there my friend")
    append(session, 2)
    session.finish()
    await session.run()
    assert session.refined == "Hello there, my friend."
    shown = provisional(events)
    assert shown, "no provisional text was offered"
    assert all(session.refined.startswith(text) for text in shown)
    # Growing, never repeated.
    assert shown == sorted(set(shown), key=len)
    assert shown[-1] == "Hello there, my"
    session.close()


@pytest.mark.asyncio
async def test_no_provisional_text_unless_the_client_asks(tmp_path, monkeypatch):
    session, events = make_session(tmp_path, monkeypatch, provisional=False)
    monkeypatch.setattr(capture_stream, "refine_transcript", streaming_refine([["Hello", " there", " friend", "."]]))
    session.recognize = AsyncMock(return_value="hello there friend")
    append(session, 2)
    session.finish()
    await session.run()
    assert session.refined == "Hello there friend."
    assert not provisional(events)
    session.close()


@pytest.mark.asyncio
async def test_no_provisional_text_when_nothing_will_be_pasted(tmp_path, monkeypatch):
    session, events = make_session(tmp_path, monkeypatch, allow_auto_paste=False)
    monkeypatch.setattr(capture_stream, "refine_transcript", streaming_refine([["Hello", " there", " friend", "."]]))
    session.recognize = AsyncMock(return_value="hello there friend")
    append(session, 2)
    session.finish()
    await session.run()
    assert not provisional(events)
    session.close()


@pytest.mark.asyncio
async def test_phrases_cleaned_while_speaking_are_offered_at_release(tmp_path, monkeypatch):
    session, events = make_session(tmp_path, monkeypatch)
    monkeypatch.setattr(
        capture_stream,
        "refine_transcript",
        streaming_refine([["The", " first", " part", "."], ["and", " the", " rest", "."]]),
    )
    heard = []

    async def recognize(pcm):
        heard.append(len(events))
        if len(heard) == 2:
            # Offering the earlier text must not hold up recognizing the rest.
            assert not provisional(events)
            await asyncio.sleep(0.01)
        return ["the first part", "and the rest"][len(heard) - 1]

    session.recognize = recognize
    worker = asyncio.create_task(session.run())
    append(session, 2)
    append(session, 1, amplitude=0)
    while not session.refined:
        await asyncio.sleep(0.01)
    # Nothing is offered while the key is held.
    assert not provisional(events)
    append(session, 1)
    session.finish()
    await worker
    assert session.refined == "The first part and the rest."
    shown = provisional(events)
    assert shown[0] == "The first part"
    # Offered while the last phrase was being recognized.
    first = next(i for i, e in enumerate(events) if e["type"] == "provisional")
    last_transcript = max(i for i, e in enumerate(events) if e["type"] == "transcript")
    assert first < last_transcript
    assert all(session.refined.startswith(text) for text in shown)
    session.close()


@pytest.mark.asyncio
async def test_rejected_cleanup_delivers_exactly_what_it_would_without_provisional(tmp_path, monkeypatch):
    finals = []
    for asked in (True, False):
        directory = tmp_path / str(asked)
        directory.mkdir()
        session, events = make_session(directory, monkeypatch, provisional=asked)
        monkeypatch.setattr(
            capture_stream,
            "refine_transcript",
            streaming_refine([["Send", " the", " update", " to", " the", " team", "."]]),
        )
        session.recognize = AsyncMock(return_value="Do not send the update to the team")
        append(session, 2)
        session.finish()
        await session.run()
        finals.append(session.refined)
        if asked:
            # The provisional text was wrong; the client must revise it.
            assert provisional(events)
            assert not session.refined.startswith(provisional(events)[-1])
        session.close()
    assert finals[0] == finals[1] == "Do not send the update to the team."


@pytest.mark.asyncio
async def test_degraded_sessions_offer_nothing(tmp_path, monkeypatch):
    session, events = make_session(tmp_path, monkeypatch)
    monkeypatch.setattr(capture_stream, "refine_transcript", streaming_refine([["Accurate", " final", " text", "."]]))
    session.recognize = AsyncMock(return_value="provisional repeated word")
    stt = type("STT", (), {"transcribe": AsyncMock(return_value="accurate final text")})()
    monkeypatch.setattr(capture_stream, "get_whisper_model", lambda: stt)
    append(session, 21)
    session.finish()
    await session.run()
    assert session.degraded_reason
    assert not provisional(events)
    session.close()
