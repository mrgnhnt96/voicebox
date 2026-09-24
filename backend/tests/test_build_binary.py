"""The server is packaged as a folder so launches skip unpacking to a temp dir."""

import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent.parent))

from build_binary import build_server


def _build_args():
    with (
        patch("build_binary.PyInstaller.__main__.run") as mock_run,
        patch("build_binary.is_apple_silicon", return_value=True),
        patch("build_binary.os.chdir"),
    ):
        build_server()
    return mock_run.call_args[0][0]


def test_server_is_built_as_a_folder():
    args = _build_args()

    assert "--onedir" in args
    assert "--onefile" not in args


def test_server_libraries_are_not_upx_compressed():
    # Compressed libraries would be unpacked on every launch, and UPX breaks
    # macOS code signatures.
    assert "--noupx" in _build_args()
