"""Check service packaging against a built server, without starting inference."""

import os
from pathlib import Path

import pytest


def test_frozen_server_contains_service_modules():
    binary = os.environ.get("VOICEBOX_TEST_BINARY")
    if not binary:
        pytest.skip("Set VOICEBOX_TEST_BINARY to a built voicebox-server")

    from PyInstaller.archive.readers import CArchiveReader

    archive = CArchiveReader(binary).open_embedded_archive("PYZ.pyz")
    services = Path(__file__).resolve().parents[1] / "services"
    expected = set()
    for source in services.rglob("*.py"):
        parts = list(source.relative_to(services.parent.parent).with_suffix("").parts)
        if parts[-1] == "__init__":
            parts.pop()
        expected.add(".".join(parts))

    assert not (missing := expected - archive.toc.keys()), f"Unbundled services: {sorted(missing)}"
