"""Voicebox runs on Apple Silicon only and says so clearly anywhere else."""

from unittest.mock import patch

import pytest

from backend.utils import platform_detect


@pytest.mark.parametrize(("system", "machine"), [("Darwin", "x86_64"), ("Linux", "aarch64")])
def test_other_platforms_are_refused(system, machine):
    with (
        patch.object(platform_detect.platform, "system", return_value=system),
        patch.object(platform_detect.platform, "machine", return_value=machine),
        pytest.raises(RuntimeError, match="requires an Apple Silicon Mac"),
    ):
        platform_detect.require_apple_silicon()


def test_apple_silicon_with_mlx_is_accepted():
    pytest.importorskip("mlx.core")
    with (
        patch.object(platform_detect.platform, "system", return_value="Darwin"),
        patch.object(platform_detect.platform, "machine", return_value="arm64"),
    ):
        platform_detect.require_apple_silicon()
