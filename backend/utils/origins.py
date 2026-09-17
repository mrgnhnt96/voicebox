"""Origin policy shared by HTTP CORS and desktop streaming connections."""

import ipaddress
import os

from starlette.websockets import WebSocket


def allowed_origins() -> list[str]:
    """Return explicit frontend origins, including configured remote deployments."""
    defaults = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:17493",
        "http://127.0.0.1:17493",
        "tauri://localhost",
        "https://tauri.localhost",
        "http://tauri.localhost",
    ]
    configured = os.environ.get("VOICEBOX_CORS_ORIGINS", "")
    return defaults + [origin.strip() for origin in configured.split(",") if origin.strip()]


def is_allowed_websocket_origin(websocket: WebSocket) -> bool:
    """Validate browser origins; permit originless native clients only on loopback.

    HTTP CORS middleware does not enforce WebSocket handshakes. Do not derive
    trusted origins from the client-controlled Host or forwarded headers.
    """
    origin = websocket.headers.get("origin")
    if origin is not None:
        return origin != "null" and origin in allowed_origins()
    if websocket.client is None:
        return False
    try:
        address = ipaddress.ip_address(websocket.client.host)
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    return address.is_loopback
