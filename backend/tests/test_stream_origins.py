"""Browser WebSockets must not bypass the API's explicit frontend origins."""

import pytest
from starlette.websockets import WebSocket

from backend.utils.origins import allowed_origins, is_allowed_websocket_origin


def socket(origin=None, client="127.0.0.1", host="localhost:17493"):
    headers = [(b"host", host.encode())]
    if origin is not None:
        headers.append((b"origin", origin.encode()))
    return WebSocket({"type": "websocket", "headers": headers, "client": (client, 1234)}, None, None)


@pytest.mark.parametrize("origin", ["tauri://localhost", "https://tauri.localhost", "http://localhost:5173"])
def test_allowed_desktop_origins(origin):
    assert is_allowed_websocket_origin(socket(origin))


@pytest.mark.parametrize("origin", ["null", "https://evil.example", "http://localhost:5173.evil.example", ""])
def test_rejects_untrusted_browser_even_on_loopback(origin):
    assert not is_allowed_websocket_origin(socket(origin))


def test_client_host_header_does_not_grant_origin():
    assert not is_allowed_websocket_origin(socket("https://evil.example", host="evil.example"))


@pytest.mark.parametrize("client", ["127.0.0.1", "::1", "::ffff:127.0.0.1"])
def test_originless_native_loopback(client):
    assert is_allowed_websocket_origin(socket(client=client))


@pytest.mark.parametrize("client", ["192.168.1.2", "203.0.113.1", "localhost", "::ffff:192.168.1.2"])
def test_originless_remote_rejected(client):
    assert not is_allowed_websocket_origin(socket(client=client))


def test_configured_remote_origin(monkeypatch):
    monkeypatch.setenv("VOICEBOX_CORS_ORIGINS", " https://voicebox.example, ")
    assert "https://voicebox.example" in allowed_origins()
    assert is_allowed_websocket_origin(socket("https://voicebox.example", client="192.168.1.2"))
