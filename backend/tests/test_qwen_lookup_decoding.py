"""Cleanup output checked several tokens per model call (prompt lookup decoding)."""

import mlx.core as mx
import pytest

from backend.backends import qwen_llm_backend
from backend.backends.qwen_llm_backend import MLXQwenLLMBackend, propose_draft

VOCAB = 64
EOS = 63


def test_the_previous_output_is_proposed_from_its_start():
    assert propose_draft([], [[5, 6, 7], [1, 2]], 2, {}) == [5, 6]


def test_a_proposal_continues_where_the_latest_tokens_appear():
    assert propose_draft([9, 5, 6], [[5, 6, 7, 8], [1, 2]], 4, {}) == [7, 8]
    # Found in the prompt when the previous output doesn't have it.
    assert propose_draft([1], [[5, 6], [1, 2, 3]], 4, {}) == [2, 3]
    assert propose_draft([42], [[5, 6], [1, 2]], 4, {}) == []


def test_repeated_words_do_not_send_the_proposal_backwards():
    source = [1, 2, 3, 1, 2, 4]
    cursor = {}
    assert propose_draft([1, 2], [source], 1, cursor) == [3]
    assert propose_draft([1, 2, 3, 1, 2], [source], 1, cursor) == [4]


class Cache:
    """A trimmable stand-in for the KV cache: it holds the tokens fed."""

    def __init__(self):
        self.tokens = []

    @property
    def state(self):
        return mx.array(0)

    def is_trimmable(self):
        return True

    def trim(self, count):
        del self.tokens[len(self.tokens) - count :]
        return count


class Model:
    """Deterministically continues ``prompt`` with ``target``, then EOS."""

    def __init__(self, prompt, target):
        self.sequence = [*prompt, *target, EOS]
        self.calls = 0

    def __call__(self, inputs, cache):
        self.calls += 1
        cache = cache[0]
        rows = []
        for token in inputs[0].tolist():
            cache.tokens.append(token)
            position = len(cache.tokens)
            right = cache.tokens == self.sequence[:position]
            following = self.sequence[position] if right and position < len(self.sequence) else 0
            rows.append(mx.eye(VOCAB)[following] * 10)
        return mx.stack(rows)[None]


class Detokenizer:
    def reset(self):
        self.tokens = []

    def add_token(self, token):
        self.tokens.append(token)

    def finalize(self):
        pass

    @property
    def text(self):
        return " ".join(str(t) for t in self.tokens)


class Tokenizer:
    eos_token_ids = [EOS]
    detokenizer = Detokenizer()

    def encode(self, text, add_special_tokens=False):
        return [int(t) for t in text.split()]


def run(prompt, target, hint, draft_tokens, monkeypatch):
    monkeypatch.setattr(qwen_llm_backend, "LOOKUP_DRAFT_TOKENS", draft_tokens)
    backend = MLXQwenLLMBackend("4B")
    backend.model = Model(prompt, target)
    backend.tokenizer = Tokenizer()
    cache = [Cache()]
    text = backend._generate_lookup(prompt, 0, cache, None, 100, hint, " ".join(map(str, prompt[-3:])), 0.0)
    return text, backend, cache[0]


@pytest.mark.parametrize(
    "hint",
    [
        "11 12 13 14",  # the previous output, still right
        "11 12 30 31 14 15",  # right, then wrong, then right again
        "40 41 42",  # entirely wrong
        "",
    ],
)
def test_output_and_cache_are_what_plain_decoding_gives(hint, monkeypatch):
    prompt = [1, 2, 3, 14, 15]
    target = [11, 12, 13, 14, 15, 16]
    text, backend, cache = run(prompt, target, hint, 8, monkeypatch)
    assert text == "11 12 13 14 15 16"
    # The cache holds exactly what the model saw, and the backend knows it.
    assert cache.tokens == backend._cached_tokens == [*prompt, *target]


def test_a_right_proposal_needs_far_fewer_model_calls(monkeypatch):
    prompt = [1, 2, 3]
    target = list(range(10, 30))
    _, with_hint, _ = run(prompt, target, " ".join(map(str, target)), 24, monkeypatch)
    _, without, _ = run(prompt, target, "", 24, monkeypatch)
    assert with_hint.model.calls <= 3
    assert without.model.calls >= len(target)
