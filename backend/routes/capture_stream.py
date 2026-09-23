"""Session WebSocket transport for streaming dictation."""

import asyncio
import contextlib
import json
import logging
import time
from collections import OrderedDict

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from ..database import session as database_session
from ..services.capture_stream import StreamingCapture
from ..services.settings import get_capture_settings
from ..utils.origins import is_allowed_websocket_origin

router = APIRouter()
logger = logging.getLogger(__name__)
_active_sessions: set[str] = set()
MAX_SESSIONS = 2
IDLE_TIMEOUT = 30
_results: OrderedDict[str, tuple[float, dict]] = OrderedDict()
_running: set[str] = set()


@router.get("/captures/stream/{session_id}/result")
async def streaming_result(session_id: str):
    now = time.monotonic()
    for key, (created, _) in list(_results.items()):
        if now - created > 600:
            del _results[key]
    if session_id in _results:
        return _results[session_id][1]
    if session_id in _running:
        return JSONResponse(status_code=202, content={"type": "pending"})
    raise HTTPException(status_code=404, detail="Streaming result unavailable; inspect Captures before retrying")


@router.websocket("/captures/stream")
async def stream_capture(websocket: WebSocket):
    if not is_allowed_websocket_origin(websocket) or len(_active_sessions) >= MAX_SESSIONS:
        await websocket.close(code=1008)
        return
    token = str(id(websocket))
    _active_sessions.add(token)
    session = None
    worker = None
    receiver = None
    foreground = False
    try:
        await websocket.accept()
        text = await asyncio.wait_for(websocket.receive_text(), timeout=10)
        if len(text) > 4096:
            raise ValueError("Start message too large")
        start = json.loads(text)
        if not isinstance(start, dict):
            raise ValueError("Expected a start object")
        with database_session.SessionLocal() as db:
            settings = get_capture_settings(db)
        session = StreamingCapture(start, settings, websocket.send_json)
        _running.add(session.id)
        from ..services.model_improvement.manager import begin_foreground

        foreground = True
        await asyncio.to_thread(begin_foreground)
        await websocket.send_json(
            dict(
                type="ready",
                session_id=session.id,
                auto_refine=settings.auto_refine,
                allow_auto_paste=settings.allow_auto_paste,
            )
        )
        worker = asyncio.create_task(session.run())
        while True:
            receiver = asyncio.create_task(websocket.receive())
            done, _ = await asyncio.wait({receiver, worker}, timeout=IDLE_TIMEOUT, return_when=asyncio.FIRST_COMPLETED)
            if not done:
                raise ValueError("Streaming session timed out waiting for audio")
            if worker in done:
                await asyncio.shield(worker)
                raise RuntimeError("Recognition ended before finish")
            message = receiver.result()
            receiver = None
            if message["type"] == "websocket.disconnect":
                raise WebSocketDisconnect()
            if message.get("bytes") is not None:
                session.append(message["bytes"])
                continue
            text = message.get("text") or "{}"
            if len(text) > 4096:
                raise ValueError("Command too large")
            command = json.loads(text)
            if not isinstance(command, dict):
                raise ValueError("Expected a command object")
            if command.get("type") == "cancel":
                return
            if command.get("type") != "finish":
                raise ValueError("Expected finish or cancel")
            if not session.samples:
                raise ValueError("Cannot finish empty audio")

            async def send_finalizing(event):
                # Finish is a commit request. Complete and retain the result if
                # the connection drops while the last inference is running.
                with contextlib.suppress(Exception):
                    await websocket.send_json(event)

            session.send = send_finalizing
            session.finish()
            await asyncio.shield(worker)
            with database_session.SessionLocal() as db:
                capture = session.persist(db)
            result = dict(
                type="final",
                session_id=session.id,
                revision=session.revision + 1,
                covered_samples=session.samples,
                capture=capture.model_dump(mode="json"),
                refinement_complete=True,
                refinement_error=session.refinement_error,
                degraded_reason=session.degraded_reason,
            )
            logger.info("Dictation stream finished: %s", session.timing_summary())
            _results[session.id] = (time.monotonic(), result)
            while len(_results) > 32:
                _results.popitem(last=False)
            await send_finalizing(result)
            return
    except WebSocketDisconnect:
        pass
    except Exception as error:
        logger.warning(
            "Streaming capture failed: %s (%s)", error, session.timing_summary() if session else "before start"
        )
        error_event = dict(type="error", message=str(error), session_id=session.id if session else None)
        if session and session.finished:
            _results[session.id] = (time.monotonic(), error_event)
            while len(_results) > 32:
                _results.popitem(last=False)
        with contextlib.suppress(Exception):
            await websocket.send_json(error_event)
    finally:
        if receiver:
            receiver.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await receiver
        if session:
            # Native inference cannot safely be interrupted by cancelling its
            # awaiting coroutine: wait before releasing temporary audio files.
            session.abort = True
            session.finish()
            if worker:
                with contextlib.suppress(Exception):
                    await asyncio.shield(worker)
            session.close()
            _running.discard(session.id)
        if foreground:
            from ..services.model_improvement.manager import end_foreground

            end_foreground()
        _active_sessions.discard(token)
        with contextlib.suppress(Exception):
            await websocket.close()
