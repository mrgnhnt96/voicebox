"""Detached GUI log pipes must not abort model operations."""

import errno
import io
import os

import pytest

from backend.utils.safe_output import SafeOutput


def test_pipe_can_break_after_successful_startup():
    read_fd, write_fd = os.pipe()
    stream = os.fdopen(write_fd, "w", buffering=1)
    output = SafeOutput(stream)
    try:
        print("startup", file=output, flush=True)
        assert os.read(read_fd, 100) == b"startup\n"
        os.close(read_fd)
        # Both ordinary model prints and tqdm-style writes/flushes remain safe.
        print("model loaded", file=output, flush=True)
        output.write("download progress\r")
        output.flush()
        os.write(write_fd, b"native library output\n")
    finally:
        stream.close()


def test_buffered_flush_handles_a_disconnected_reader():
    read_fd, write_fd = os.pipe()
    stream = os.fdopen(write_fd, "w")
    output = SafeOutput(stream)
    try:
        output.write("buffered progress")
        os.close(read_fd)
        output.flush()
        output.flush()
    finally:
        stream.close()


def test_unrelated_io_errors_are_not_hidden():
    class FullDisk(io.StringIO):
        def write(self, value):
            raise OSError(errno.ENOSPC, "No space left on device")

    with pytest.raises(OSError, match="No space left"):
        SafeOutput(FullDisk()).write("test")


def test_download_progress_and_logging_survive_lost_reader(monkeypatch):
    import logging
    import sys

    from tqdm import tqdm

    from backend.utils.safe_output import protect_standard_streams

    read_fd, write_fd = os.pipe()
    stream = os.fdopen(write_fd, "w", buffering=1)
    monkeypatch.setattr(sys, "stdout", sys.stdout)
    monkeypatch.setattr(sys, "stderr", stream)
    protect_standard_streams()
    handler = logging.StreamHandler(sys.stderr)
    try:
        os.close(read_fd)
        with tqdm(total=2, file=sys.stderr, disable=False) as progress:
            progress.update(2)
        handler.emit(logging.LogRecord("test", logging.INFO, "", 0, "model ready", (), None))
        sys.stderr.flush()
    finally:
        handler.close()
        stream.close()
