"""The cleanup's text is offered to a listener while it is generated."""

import sys
import threading
import types

import pytest

from backend.backends import qwen_llm_backend
from backend.backends.qwen_llm_backend import MLXQwenLLMBackend


class FakeTokenizer:
    def apply_chat_template(self, messages, **_):
        return messages[-1]["content"]

    def encode(self, text, add_special_tokens=False):
        return [ord(c) for c in text]


def install_fake_mlx(monkeypatch, pieces):
    def stream_generate(model, tokenizer, prompt, **_):
        for index, piece in enumerate(pieces):
            yield types.SimpleNamespace(text=piece, token=index)

    mlx_lm = types.ModuleType("mlx_lm")
    mlx_lm.stream_generate = stream_generate
    sample_utils = types.ModuleType("mlx_lm.sample_utils")
    sample_utils.make_sampler = lambda **_: None
    monkeypatch.setitem(sys.modules, "mlx_lm", mlx_lm)
    monkeypatch.setitem(sys.modules, "mlx_lm.sample_utils", sample_utils)


def backend_with_fakes(monkeypatch, pieces):
    install_fake_mlx(monkeypatch, pieces)
    backend = MLXQwenLLMBackend("0.6B")
    backend.model = object()
    backend.tokenizer = FakeTokenizer()
    backend._current_model_size = "0.6B"
    monkeypatch.setattr(backend, "_reusable_cache", lambda tokens: None)
    return backend


@pytest.mark.asyncio
async def test_listener_sees_the_text_so_far_after_each_token(monkeypatch):
    backend = backend_with_fakes(monkeypatch, ["Hello", " there", "."])
    seen = []
    threads = set()

    def listener(text):
        seen.append(text)
        threads.add(threading.get_ident())

    token = qwen_llm_backend.generation_listener.set(listener)
    try:
        result = await backend.generate("hello there", model_size="0.6B")
    finally:
        qwen_llm_backend.generation_listener.reset(token)
    assert result == "Hello there."
    assert seen == ["Hello", "Hello there", "Hello there."]
    # Called on the MLX worker, not the event loop.
    assert threading.get_ident() not in threads


@pytest.mark.asyncio
async def test_without_a_listener_generation_is_unchanged(monkeypatch):
    backend = backend_with_fakes(monkeypatch, ["Hi", "."])
    assert await backend.generate("hi", model_size="0.6B") == "Hi."


@pytest.mark.asyncio
async def test_a_failing_listener_never_breaks_generation(monkeypatch):
    backend = backend_with_fakes(monkeypatch, ["Hi", "."])

    def listener(_):
        raise RuntimeError("socket gone")

    token = qwen_llm_backend.generation_listener.set(listener)
    try:
        assert await backend.generate("hi", model_size="0.6B") == "Hi."
    finally:
        qwen_llm_backend.generation_listener.reset(token)


@pytest.mark.asyncio
async def test_a_set_stop_flag_ends_generation_between_tokens(monkeypatch):
    backend = backend_with_fakes(monkeypatch, ["One", " two", " three", " four"])
    stop = threading.Event()

    def listener(text):
        if text == "One two":
            stop.set()

    tokens = qwen_llm_backend.generation_listener.set(listener), qwen_llm_backend.generation_stop.set(stop)
    try:
        result = await backend.generate("one two three four", model_size="0.6B")
    finally:
        qwen_llm_backend.generation_listener.reset(tokens[0])
        qwen_llm_backend.generation_stop.reset(tokens[1])
    assert result == "One two"
    # The prompt cache still describes exactly what the model saw.
    assert backend._cached_tokens == [*[ord(c) for c in "one two three four"], 0, 1]
