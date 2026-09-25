"""Bounded rolling-window dictation, using the existing file-based STT backend.

Recognition windows end on pauses where possible. Full audio is archived once;
only a bounded backlog and one inference window are kept in memory.

Only work the final result uses runs: phrases cut at pauses, then the rest at
finish. There are no provisional previews or speculative cleanups. No client
shows them and they were rarely reused.

Cleanup is sentence-aware (docs/plans/SENTENCE_AWARE_CLEANUP.md). A pause is
often the speaker thinking mid-sentence, so each phrase is added to the open
tail, the raw words since the last settled sentence, and the whole tail is
cleaned again. Every sentence of that cleanup but the last is settled: final,
never cleaned again. After release only the open tail is cleaned. A cleanup
still running at release that the rest of the speech would replace is stopped
between tokens rather than waited for.

A client that asks for it (``"provisional": true`` in start) also gets
``provisional`` events after release: the part of the final text that is
unlikely to change, while the last phrase is still being cleaned up. It is a
prediction, not a promise; ``final`` is the only authoritative text
(docs/plans/STREAMING_INSERTION.md).
"""

import asyncio
import contextlib
import json
import logging
import re
import struct
import threading
import time
import uuid
import wave

import numpy as np

from .. import config, models
from ..backends.qwen_llm_backend import generation_hint, generation_listener, generation_stop
from ..database import Capture
from .captures import _to_response
from .content_check import Verdict, check_refinement, summarize_reviews
from .phrase_seams import close_phrase, continue_phrase, join_phrases, open_phrase, strip_pause_mark
from .refinement import RefinementFlags, prepare_refinement, refine_transcript
from .sentence_tail import MAX_OPEN_WORDS, settle
from .speech_detect import SpeechDetector
from .transcribe import get_whisper_model
from .writing_style import apply_learned, apply_style, habits, is_ready

logger = logging.getLogger(__name__)
# Words held back while learned corrections are active: a rule replaces up to
# three words and needs the word after them as context.
CORRECTION_HOLDBACK = 4
MAX_FRAME_BYTES = 65536
MAX_SECONDS = 3600
# Whisper keeps at most ~224 prompt tokens; this stays comfortably inside it.
PHRASE_CONTEXT_CHARS = 600
_CORRECTION_CUE = re.compile(r"\b(actually|no wait|no actually|make that|I mean|scratch that)\b", re.I)


def join_overlap(prefix: str, tail: str) -> str:
    """Remove only matching boundary tokens from overlapping recognition windows."""
    left, right = prefix.split(), tail.split()

    def key(value: str) -> str:
        return re.sub(r"[^\w]", "", value).lower()

    for count in range(min(32, len(left), len(right)), 0, -1):
        if [key(w) for w in left[-count:]] == [key(w) for w in right[:count]]:
            return " ".join(left + right[count:])
    return " ".join(part for part in (prefix, tail) if part)


def _has_corrections() -> bool:
    from . import correction_learning

    return bool(correction_learning._compiled)


def stable_prefix(text: str, holdback: int) -> str:
    """The start of ``text`` minus its last ``holdback`` words and the punctuation before them.

    Those can still change: the model may be mid-word, and seam punctuation,
    learned habits and learned corrections all look at the following word.
    """
    words = list(re.finditer(r"\S+", text))
    if len(words) < holdback or (holdback and len(words) == holdback):
        return ""
    kept = text[: words[-holdback].start()] if holdback else text
    return re.sub(r"[^\w\s]+$", "", kept.rstrip()).rstrip()


def guard_phrase_refinement(raw: str, refined: str, flags: RefinementFlags) -> tuple[str, Verdict]:
    """Keep a phrase's cleanup unless the content check rejects it.

    Restructuring is allowed. A cleanup that may have added or left out
    content is kept and flagged for review; one that answered or obeyed the
    dictation, or changed a negation, number or technical term, falls back to
    the prepared transcript.
    """
    return check_refinement(raw, refined, flags)


class StreamingCapture:
    def __init__(self, start: dict, settings, send):
        if start.get("type") != "start" or start.get("protocol_version") != 1:
            raise ValueError("Expected protocol version 1 start message")
        self.rate = start.get("sample_rate")
        if not isinstance(self.rate, int) or not 16000 <= self.rate <= 48000:
            raise ValueError("sample_rate must be between 16000 and 48000")
        if start.get("channels") != 1 or start.get("encoding") != "pcm_s16le":
            raise ValueError("Audio must be mono pcm_s16le")
        # Protocol addition: the client can show provisional cleaned text.
        self.provisional = start.get("provisional") is True
        self.shown = ""
        self.source = start.get("source", "dictation")
        if not isinstance(self.source, str) or self.source not in {"dictation", "recording"}:
            raise ValueError("Invalid streaming capture source")
        self.settings = settings
        self.language = start.get("language", settings.language)
        if self.language is not None and (
            not isinstance(self.language, str) or not re.fullmatch(r"[A-Za-z-]{2,32}", self.language)
        ):
            raise ValueError("Invalid language")
        if self.language == "auto":
            self.language = None
        self.stt_model = start.get("stt_model") or settings.stt_model
        if not isinstance(self.stt_model, str) or self.stt_model not in {"base", "small", "medium", "large", "turbo"}:
            raise ValueError("Invalid STT model")
        from .model_improvement.manager import speech_model

        self.stt_model = speech_model(self.stt_model)
        self.id = str(uuid.uuid4())
        self.send = send
        self.path = config.get_captures_dir() / f"{self.id}.wav"
        self.archive = wave.open(str(self.path), "wb")  # noqa: SIM115 — session owns this until close()
        self.archive.setnchannels(1)
        self.archive.setsampwidth(2)
        self.archive.setframerate(self.rate)
        self.pending = bytearray()
        # Checked as audio arrives, so a phrase without a voice skips Whisper,
        # which would otherwise invent one ("Thank you.").
        self.speech = SpeechDetector(self.rate)
        self.cuts = []
        self.offset = 0
        self.samples = 0
        self.sequence = 0
        self.last_cut = 0
        self.revision = 0
        self.covered = 0
        # Whisper's own text, the context it continues each phrase from.
        self.heard = ""
        # What was said, without the endings Whisper gave phrases only because
        # the audio paused. Saved as the raw transcript and cleaned.
        self.raw = ""
        self.refined = ""
        # Settled text is final. The open tail is the raw words since; it is
        # cleaned again as phrases arrive.
        self.settled = ""
        # Whitespace after settled text that ends a sentence; None when it was
        # settled mid-sentence and joins the tail at a seam.
        self.settled_gap = None
        self.settled_reviews = []
        # What the latest settle replaced, so a spoken correction can reopen it.
        self.last_settle = None
        self.tail_raw = ""
        self.tail_cleaned = ""
        self.tail_dirty = False
        self.stop_cleanup = None
        self.release_tail_words = 0
        self.llm_model = None
        self.refinement_error = None
        self.needs_final_refinement = False
        # Whether the cleanup ended the latest phrase with a period. Pauses
        # strip it (open_phrase); finish restores it only if it was there.
        self.cleanup_closed = True
        self.reviews = []
        self.overlap = False
        self.degraded_reason = None
        self.backlogged = False
        self.peak_backlog = 0.0
        self.started_at = time.monotonic()
        self.finished_at = None
        # Model time spent after release, the part of the wait we control.
        self.after_release = {"recognize": 0.0, "refine": 0.0}
        self.abort = False
        self.finished = False
        self.persisted = False
        self.wake = asyncio.Event()
        self.flags = RefinementFlags(
            settings.smart_cleanup, settings.self_correction, settings.preserve_technical, settings.punctuation_style
        )

    async def emit(self, kind, **payload):
        self.revision += 1
        await self.send(
            dict(
                type=kind,
                session_id=self.id,
                revision=self.revision,
                covered_samples=self.covered,
                degraded_reason=self.degraded_reason,
                **payload,
            )
        )

    def append(self, frame: bytes):
        if len(frame) < 10 or len(frame) > MAX_FRAME_BYTES or (len(frame) - 8) % 2:
            raise ValueError("Invalid PCM frame size")
        sequence, offset = struct.unpack("<II", frame[:8])
        if sequence != self.sequence or offset != self.samples:
            raise ValueError("Audio frames must have contiguous sequence and sample offsets")
        pcm = frame[8:]
        count = len(pcm) // 2
        if self.samples + count > self.rate * MAX_SECONDS:
            raise ValueError("Streaming session exceeds one hour")
        self.archive.writeframesraw(pcm)
        self.speech.feed(np.frombuffer(pcm, dtype="<i2"))
        self.samples += count
        self.sequence += 1
        if self.backlogged:
            return
        if len(self.pending) + len(pcm) > self.rate * 2 * 60:
            # Recognition fell a minute behind. Keep archiving and transcribe
            # the whole recording at finish rather than failing the dictation.
            logger.warning(
                "Streaming recognition fell %.1fs behind; finishing with full-audio recognition",
                len(self.pending) / (self.rate * 2),
            )
            self.backlogged = True
            self.degraded_reason = "Recognition fell behind; final output uses full-audio recognition."
            self.pending.clear()
            self.cuts.clear()
            self.wake.set()
            return
        self.pending.extend(pcm)
        self.peak_backlog = max(self.peak_backlog, len(self.pending) / (self.rate * 2))
        # A phrase ends at 0.7 s without a voice. Loudness can't tell: a fan's
        # hum on one microphone is as loud as speech on another, and it never
        # let a pause register. Nothing is removed from the recognizer's audio.
        if self.samples - self.last_cut >= self.rate * 2 and self.speech.quiet() >= self.rate * 0.7:
            self.cuts.append(self.samples)
            self.last_cut = self.samples
        self.wake.set()

    def _spent(self, stage: str, started: float) -> None:
        if self.finished_at is not None:
            self.after_release[stage] += time.monotonic() - max(started, self.finished_at)

    async def recognize(self, pcm, start=None):
        # Earlier phrases give Whisper the sentence it is continuing, so a
        # phrase cut at a pause neither trails off with "..." nor restarts
        # with a capital letter.
        previous_text = self.heard[-PHRASE_CONTEXT_CHARS:]
        samples = np.frombuffer(pcm, dtype="<i2")
        start = self.offset if start is None else start
        if not len(samples) or not self.speech.heard(start, start + len(samples)):
            return ""
        started = time.monotonic()
        try:
            return (
                await get_whisper_model().transcribe_array(
                    samples,
                    self.rate,
                    self.language,
                    self.stt_model,
                    previous_text=previous_text,
                    check_speech=False,
                )
            ).strip()
        finally:
            self._spent("recognize", started)

    def close_dictation(self, text, closed=None, learned=None):
        closed = self.cleanup_closed if closed is None else closed
        closed = close_phrase(text) if closed else text
        # Phrases were styled one at a time; habits like a dropped final period
        # only apply once the whole dictation is joined.
        return (learned or apply_learned)(closed) if self.flags.punctuation_style == "learned" else closed

    def join(self, previous, phrase, raw_phrase, learned=None):
        if self.overlap:
            return join_overlap(previous, phrase)
        if self.flags.punctuation_style == "learned":
            # Join like Standard, then let the user's habits decide what each
            # sentence break becomes (comma, nothing, lowercase start...).
            return (learned or apply_learned)(join_phrases(previous, phrase, raw_phrase, "standard"))
        return join_phrases(previous, phrase, raw_phrase, self.flags.punctuation_style)

    def compose(self, settled, text, raw, learned=None):
        """``text``, cleaned from ``raw``, after the settled text."""
        if not settled.strip():
            return text
        if not text:
            return settled
        if self.settled_gap is not None:
            return settled + self.settled_gap + text
        return self.join(settled, text, raw, learned)

    # --- Provisional text ------------------------------------------------------

    def offers_provisional(self) -> bool:
        return (
            self.provisional
            and self.finished
            and self.settings.auto_refine
            and self.settings.allow_auto_paste
            and not self.overlap
            and not self.degraded_reason
            and not self.backlogged
            and not self.needs_final_refinement
            and not self.refinement_error
        )

    async def show(self, text: str, holdback: int) -> None:
        """Offer the client the part of ``text`` that should survive to the final."""
        if not self.offers_provisional():
            return
        stable = stable_prefix(text, holdback)
        if len(stable) > len(self.shown):
            self.shown = stable
            await self.emit("provisional", text=stable)

    async def show_cleaned_so_far(self) -> None:
        # Only settled text is final; the open sentence may still change.
        from .correction_learning import apply_learned_corrections

        settled = apply_learned_corrections(self.settled, self.language) if self.settled else ""
        await self.show(settled, CORRECTION_HOLDBACK if _has_corrections() else 0)

    def _projection(self, prompt: str):
        """What finish would deliver if the cleanup of ``prompt`` ended now and passed the check.

        Mirrors refine_transcript's post-processing, then ``accept`` and
        ``close_dictation``. Habits are read once, not per token.
        """
        from .correction_learning import apply_learned_corrections

        learned = (lambda text, h=habits(): apply_style(text, h)) if is_ready() else (lambda text: text)
        prefix = self.settled

        def project(partial: str) -> str:
            refined = partial.strip()
            if self.flags.punctuation_style == "learned":
                refined = learned(refined)
            text = apply_learned_corrections(self.compose(prefix, refined, prompt, learned), self.language)
            return self.close_dictation(text, refined.rstrip().endswith("."), learned)

        return project

    @contextlib.asynccontextmanager
    async def streaming_cleanup(self, prompt: str):
        """Offer provisional text while the cleanup of the final phrase generates."""
        if not self.offers_provisional():
            yield
            return
        loop = asyncio.get_running_loop()
        latest = [None]
        changed = asyncio.Event()
        done = [False]

        def update(partial):
            if not done[0]:
                latest[0] = partial
                changed.set()

        def listener(partial):  # MLX worker thread
            with contextlib.suppress(RuntimeError):
                loop.call_soon_threadsafe(update, partial)

        async def relay():
            # Built on the first token, while the model generates, so reading
            # the habits (~2 ms) never delays the cleanup itself.
            project = None
            while not done[0]:
                await changed.wait()
                changed.clear()
                if done[0] or latest[0] is None:
                    return
                project = project or self._projection(prompt)
                # Learned corrections may span a few words; hold them back too.
                await self.show(project(latest[0]), CORRECTION_HOLDBACK if _has_corrections() else 1)

        relay_task = asyncio.create_task(relay())
        token = generation_listener.set(listener)
        try:
            yield
        finally:
            generation_listener.reset(token)
            done[0] = True
            changed.set()
            # Only waits for a send already in progress; never cancels one.
            await relay_task

    async def accept(self, text, paused=False):
        """Add a recognized phrase; ``paused`` when its audio was cut at a pause."""
        earlier = self.heard
        self.heard = self.join(self.heard, text, text)
        if text:
            if not self.overlap:
                # The pause, not the speaker, ended the phrase before this one
                # and capitalized this one.
                phrase = continue_phrase(text, earlier) if earlier else text
                phrase = strip_pause_mark(phrase) if paused else phrase
                self.raw = f"{self.raw} {phrase}".strip()
                self.tail_raw = f"{self.tail_raw} {phrase}".strip()
            else:
                self.raw = join_overlap(self.raw, text)
                self.tail_raw = join_overlap(self.tail_raw, text)
            self.tail_dirty = True
        await self.emit("transcript", accepted_text=self.raw, provisional_text="", text=self.raw, final=False)
        if not self.settings.auto_refine:
            return
        try:
            # Explicit corrections operate on the entire raw session so a later
            # "scratch that" can revise a previously accepted phrase.
            _, correction = prepare_refinement(self.raw, self.flags)
            if correction is not None:
                self.refined = correction
                self.cleanup_closed = True
                self.llm_model = self.settings.llm_model
                # Resolved as a whole; later phrases continue after it.
                self.settled, self.settled_gap, self.last_settle = correction, None, None
                self.tail_raw, self.tail_cleaned, self.tail_dirty = "", "", False
            elif text:
                if self.flags.self_correction and self.last_settle and _CORRECTION_CUE.search(text):
                    self.reopen()
                await self.clean_tail()
            from .correction_learning import apply_learned_corrections

            self.refined = apply_learned_corrections(self.refined, self.language)
            await self.emit("refined", text=self.refined)
        except Exception as error:
            logger.exception("Streaming refinement failed")
            self.refinement_error = str(error)

    def reopen(self):
        """Put the latest settled text back in the open tail, for a correction of it."""
        settled, gap, raw, reviews = self.last_settle
        self.settled, self.settled_gap, self.settled_reviews = settled, gap, reviews
        self.tail_raw = f"{raw} {self.tail_raw}".strip()
        self.tail_cleaned = ""
        self.last_settle = None

    def settle(self, text, raw, gap):
        self.last_settle = (self.settled, self.settled_gap, raw, self.settled_reviews)
        self.settled = self.compose(self.settled, text, raw)
        self.settled_gap = gap
        self.settled_reviews = list(self.reviews)

    def speech_follows(self) -> bool:
        """Whether audio not yet recognized has a voice in it."""
        return self.samples > self.offset and self.speech.heard(self.offset, self.samples)

    async def clean_tail(self):
        """Clean the open tail and settle every finished sentence of the result."""
        prompt = self.tail_raw
        # Made while speaking, this cleanup may be replaced by the one after
        # release; finish() stops it then instead of waiting for it.
        stop = None if self.finished else threading.Event()
        self.stop_cleanup = stop
        if self.finished:
            self.release_tail_words = len(prompt.split())
        started = time.monotonic()
        # The last cleanup of this tail: most of the new one repeats it.
        tokens = generation_stop.set(stop), generation_hint.set(self.tail_cleaned)
        try:
            async with self.streaming_cleanup(prompt):
                refined, self.llm_model = await refine_transcript(
                    prompt, self.flags, model_size=self.settings.llm_model
                )
        finally:
            generation_stop.reset(tokens[0])
            generation_hint.reset(tokens[1])
            self.stop_cleanup = None
            self._spent("refine", started)
        if stop is not None and stop.is_set():
            return
        refined, verdict = guard_phrase_refinement(prompt, refined, self.flags)
        self.tail_dirty = False
        self.reviews = [*self.settled_reviews, *([verdict] if verdict.outcome != "ok" else [])]
        # A rejected cleanup falls back to the transcript, which is closed the
        # standard way.
        self.cleanup_closed = verdict.outcome == "reject" or refined.rstrip().endswith(".")
        if verdict.outcome == "reject" and self.flags.self_correction and _CORRECTION_CUE.search(prompt):
            self.needs_final_refinement = True
        finished = settle(prompt, refined) if verdict.outcome != "reject" and not self.overlap else None
        if finished:
            self.settle(finished.committed, finished.committed_raw, finished.gap)
            self.tail_raw, refined = finished.open_raw, finished.open_cleaned
        elif len(prompt.split()) > MAX_OPEN_WORDS and not self.finished:
            # No sentence ended in a long stretch: settle it where it is, so
            # the cleanup after release stays about one phrase long.
            self.settle(open_phrase(refined, prompt), prompt, None)
            self.tail_raw, refined = "", ""
        self.tail_cleaned = refined
        # The open sentence stays open while more may follow; finish closes it.
        shown = open_phrase(refined, self.tail_raw) if refined else ""
        self.refined = self.compose(self.settled, shown, self.tail_raw)

    async def finish_cleanup(self):
        """Deliver settled text and the cleaned tail, closed like a finished dictation."""
        from .correction_learning import apply_learned_corrections

        try:
            if self.tail_dirty and self.tail_raw:
                # A cleanup was stopped at release, and nothing was said after it.
                await self.clean_tail()
            if self.needs_final_refinement:
                await self.reconcile_refinement()
                return
            text = apply_learned_corrections(self.compose(self.settled, self.tail_cleaned, self.tail_raw), self.language)
        except Exception as error:
            logger.exception("Streaming refinement failed")
            self.refinement_error = str(error)
            return
        if (closed := self.close_dictation(text)) != self.refined:
            self.refined = closed
            await self.emit("refined", text=self.refined)

    async def run(self):
        while True:
            if self.abort:
                return
            if self.backlogged:
                if self.finished:
                    await self.reconcile_full_audio()
                    return
                self.wake.clear()
                await self.wake.wait()
                continue
            while self.cuts and self.cuts[0] <= self.offset:
                self.cuts.pop(0)
            available = len(self.pending) // 2
            cut = self.cuts[0] - self.offset if self.cuts else None
            forced = available >= self.rate * 20 and (cut is None or cut > self.rate * 20)
            if self.finished and (self.degraded_reason or forced):
                self.degraded_reason = (
                    "Continuous speech exceeded the safe phrase window; final output uses full-audio recognition."
                )
                await self.reconcile_full_audio()
                return
            size = self.rate * 20 if forced else cut
            paused = not forced and cut is not None
            offer = None
            if size is None and self.finished:
                size = available
                if size:
                    # Released: what was cleaned while speaking is offered
                    # while the last phrase is recognized, not before it.
                    offer = asyncio.create_task(self.show_cleaned_so_far())
            if size:
                pcm = bytes(self.pending[: size * 2])
                text = await self.recognize(pcm)
                if offer is not None:
                    await offer
                if self.abort:
                    return
                # Keep one second of context only for forced (unpaused) cuts.
                if forced:
                    self.degraded_reason = (
                        "Continuous speech exceeded the safe phrase window; final output uses full-audio recognition."
                    )
                advance = size - self.rate if forced else size
                del self.pending[: advance * 2]
                self.covered = max(self.covered, self.offset + size)
                self.offset += advance
                await self.accept(text, paused)
                self.overlap = forced
                continue
            if self.finished:
                if self.degraded_reason:
                    await self.reconcile_full_audio()
                elif self.needs_final_refinement:
                    await self.reconcile_refinement()
                elif self.settings.auto_refine:
                    await self.finish_cleanup()
                return
            self.wake.clear()
            await self.wake.wait()

    async def reconcile_full_audio(self):
        """Use the established batch path when a forced seam cannot be proven."""
        self.archive.close()
        if self.speech.heard(0, self.samples):
            self.raw = (
                await get_whisper_model().transcribe(str(self.path), self.language, self.stt_model, check_speech=False)
            ).strip()
        else:
            self.raw = ""
        if self.abort:
            return
        self.covered = self.samples
        await self.emit("transcript", accepted_text=self.raw, provisional_text="", text=self.raw, final=False)
        await self.reconcile_refinement()

    async def reconcile_refinement(self):
        """Resolve ambiguous spoken corrections with complete session context."""
        if self.settings.auto_refine:
            try:
                started = time.monotonic()
                refined, self.llm_model = await refine_transcript(
                    self.raw, self.flags, model_size=self.settings.llm_model
                )
                self._spent("refine", started)
                # The whole dictation was cleaned up again, so earlier phrase
                # verdicts no longer describe the result.
                self.refined, verdict = guard_phrase_refinement(self.raw, refined, self.flags)
                self.reviews = [verdict]
                from .correction_learning import apply_learned_corrections

                self.refined = apply_learned_corrections(self.refined, self.language)
                self.refinement_error = None
                await self.emit("refined", text=self.refined)
            except Exception as error:
                self.refinement_error = str(error)

    def finish(self):
        self.finished = True
        self.finished_at = time.monotonic()
        if self.stop_cleanup is not None and self.speech_follows():
            # The cleanup after release covers this tail and the rest.
            self.stop_cleanup.set()
        self.wake.set()

    def timing_summary(self) -> str:
        """One log line per dictation: enough to see where time went, no text."""
        now = time.monotonic()
        release = f"{now - self.finished_at:.2f}s" if self.finished_at else "not released"
        return (
            f"session={self.id} audio={self.samples / self.rate:.2f}s rate={self.rate} "
            f"wall={now - self.started_at:.2f}s release_to_final={release} "
            f"after_release_recognize={self.after_release['recognize']:.2f}s "
            f"after_release_refine={self.after_release['refine']:.2f}s "
            f"after_release_tail_words={self.release_tail_words} "
            f"peak_backlog={self.peak_backlog:.2f}s degraded={self.degraded_reason or 'no'} "
            f"refinement_error={'yes' if self.refinement_error else 'no'}"
        )

    def persist(self, db):
        self.archive.close()
        row = Capture(
            id=self.id,
            audio_path=config.to_storage_path(self.path),
            source=self.source,
            language=self.language,
            duration_ms=round(self.samples / self.rate * 1000),
            transcript_raw=self.raw,
            stt_model=self.stt_model,
            transcript_refined=self.refined if self.settings.auto_refine and not self.refinement_error else None,
            llm_model=self.llm_model,
            refinement_flags=json.dumps(self.flags.to_dict()) if self.settings.auto_refine else None,
            refinement_review=json.dumps(review) if self.settings.auto_refine and (review := summarize_reviews(self.reviews)) else None,
        )
        db.add(row)
        db.commit()
        self.persisted = True
        db.refresh(row)
        return models.CaptureCreateResponse(
            **_to_response(row).model_dump(),
            auto_refine=self.settings.auto_refine,
            allow_auto_paste=self.settings.allow_auto_paste,
        )

    def close(self):
        self.archive.close()
        if not self.persisted:
            with contextlib.suppress(OSError):
                self.path.unlink()
