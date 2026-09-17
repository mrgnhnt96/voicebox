"""Console output that survives the desktop application's log reader exiting."""

import errno
import os
import threading


class SafeOutput:
    """Keep model prints and progress bars from failing on a detached log pipe."""

    def __init__(self, stream):
        self._stream = stream
        self._lock = threading.RLock()

    def __getattr__(self, name):
        return getattr(self._stream, name)

    def _call(self, method, *args):
        with self._lock:
            try:
                return getattr(self._stream, method)(*args)
            except OSError as error:
                if error.errno != errno.EPIPE:
                    raise
                # Redirect the original descriptor as well: libraries may retain
                # the stream or write directly from native code. No remote/socket
                # errors are caught here; this wrapper only owns console streams.
                with open(os.devnull, "w") as sink:
                    os.dup2(sink.fileno(), self._stream.fileno())
                return getattr(self._stream, method)(*args)

    def write(self, text):
        return self._call("write", text)

    def flush(self):
        return self._call("flush")


def protect_standard_streams():
    """Install before importing logging and model libraries that cache streams."""
    import sys

    for name in ("stdout", "stderr"):
        stream = getattr(sys, name)
        if stream is None or stream.closed:
            stream = open(os.devnull, "w")  # noqa: SIM115 - owned by sys for the process lifetime
        if not isinstance(stream, SafeOutput):
            setattr(sys, name, SafeOutput(stream))
