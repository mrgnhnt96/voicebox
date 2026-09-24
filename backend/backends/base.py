"""
Shared utilities for the Whisper and LLM backend implementations.

Eliminates duplication of cache checking, device detection,
and model loading progress tracking.
"""

import logging
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, List, Optional, Tuple


from ..utils.progress import get_progress_manager
from ..utils.hf_progress import HFProgressTracker, create_hf_progress_callback
from ..utils.tasks import get_task_manager

logger = logging.getLogger(__name__)


def is_model_cached(
    hf_repo: str,
    *,
    weight_extensions: tuple[str, ...] = (".safetensors", ".bin"),
    required_files: Optional[list[str]] = None,
) -> bool:
    """
    Check if a HuggingFace model is fully cached locally.

    Args:
        hf_repo: HuggingFace repo ID (e.g. "openai/whisper-base")
        weight_extensions: File extensions that count as model weights.
        required_files: If set, check that these specific filenames exist
                        in snapshots instead of checking by extension.

    Returns:
        True if model is fully cached, False if missing or incomplete.
    """
    try:
        from huggingface_hub import constants as hf_constants

        repo_cache = Path(hf_constants.HF_HUB_CACHE) / ("models--" + hf_repo.replace("/", "--"))

        if not repo_cache.exists():
            return False

        # Incomplete blobs mean a download is still in progress
        blobs_dir = repo_cache / "blobs"
        if blobs_dir.exists() and any(blobs_dir.glob("*.incomplete")):
            logger.debug(f"Found .incomplete files for {hf_repo}")
            return False

        snapshots_dir = repo_cache / "snapshots"
        if not snapshots_dir.exists():
            return False

        if required_files:
            # Check that every required filename exists somewhere in snapshots
            for fname in required_files:
                if not any(snapshots_dir.rglob(fname)):
                    return False
            return True

        # Check that at least one weight file exists
        for ext in weight_extensions:
            if any(snapshots_dir.rglob(f"*{ext}")):
                return True

        logger.debug(f"No model weights found for {hf_repo}")
        return False

    except Exception as e:
        logger.warning(f"Error checking cache for {hf_repo}: {e}")
        return False


_ELLIPSIS_TOKEN_IDS: dict[tuple[str, int], Tuple[int, ...]] = {}


def ellipsis_token_ids(
    model_key: str,
    decode: Callable[[List[int]], str],
    vocab_size: int,
    decode_batch: Optional[Callable[[List[List[int]]], List[str]]] = None,
) -> Tuple[int, ...]:
    """Whisper token ids whose text contains an ellipsis ("..." or "…").

    Whisper writes an ellipsis wherever audio trails off into silence, so a
    dictation phrase cut at a pause would otherwise end with one.

    Computed once per process. Decoding Whisper's 50k tokens one call at a
    time takes ~0.45 s; ``decode_batch``, when given, decodes them all in one
    call (a fraction of that) and must agree with ``decode`` token by token.
    """
    key = (model_key, vocab_size)
    if key not in _ELLIPSIS_TOKEN_IDS:
        single_tokens = [[token] for token in range(vocab_size)]
        texts = decode_batch(single_tokens) if decode_batch else map(decode, single_tokens)
        _ELLIPSIS_TOKEN_IDS[key] = tuple(token for token, text in enumerate(texts) if ".." in text or "…" in text)
    return _ELLIPSIS_TOKEN_IDS[key]


@contextmanager
def model_load_progress(
    model_name: str,
    is_cached: bool,
    filter_non_downloads: Optional[bool] = None,
):
    """
    Context manager for model loading with HF download progress tracking.

    Handles the tqdm patching, progress_manager/task_manager lifecycle,
    and error reporting that every backend duplicates.

    Args:
        model_name: Progress tracking key (e.g. "whisper-base", "qwen3-0.6b").
        is_cached: Whether the model is already downloaded.
        filter_non_downloads: Whether to filter non-download tqdm bars.
                              Defaults to `is_cached`.

    Yields:
        The tracker context (already entered). The caller loads the model
        inside the `with` block. The tqdm patch is torn down on exit.

    Usage:
        with model_load_progress("whisper-base", is_cached) as ctx:
            self.model = SomeModel.from_pretrained(...)
    """
    if filter_non_downloads is None:
        filter_non_downloads = is_cached

    progress_manager = get_progress_manager()
    task_manager = get_task_manager()

    progress_callback = create_hf_progress_callback(model_name, progress_manager)
    tracker = HFProgressTracker(progress_callback, filter_non_downloads=filter_non_downloads)

    tracker_context = tracker.patch_download()
    tracker_context.__enter__()

    if not is_cached:
        task_manager.start_download(model_name)
        progress_manager.update_progress(
            model_name=model_name,
            current=0,
            total=0,
            filename="Connecting to HuggingFace...",
            status="downloading",
        )

    try:
        yield tracker_context
    except Exception as e:
        # Report error to both managers
        progress_manager.mark_error(model_name, str(e))
        task_manager.error_download(model_name, str(e))
        raise
    else:
        # Only mark complete if we were tracking a download
        if not is_cached:
            progress_manager.mark_complete(model_name)
            task_manager.complete_download(model_name)
    finally:
        tracker_context.__exit__(None, None, None)
