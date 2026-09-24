"""Finding Whisper's ellipsis tokens must be quick: it runs once per process,
during the startup warm-up, which the user waits for."""

from types import SimpleNamespace

import pytest

from backend.backends import base

VOCAB = ["a", "...", " b", "…", "..", ". .", "c"]


def decode(tokens):
    return "".join(VOCAB[t] for t in tokens)


@pytest.fixture(autouse=True)
def fresh_cache(monkeypatch):
    monkeypatch.setattr(base, "_ELLIPSIS_TOKEN_IDS", {})


def test_finds_tokens_containing_an_ellipsis():
    assert base.ellipsis_token_ids("m", decode, len(VOCAB)) == (1, 3, 4)


def test_decodes_the_vocabulary_in_one_batch_when_it_can():
    batches = []

    def decode_batch(sequences):
        batches.append(sequences)
        return [decode(tokens) for tokens in sequences]

    def one_at_a_time(tokens):
        raise AssertionError("decoded token by token")

    assert base.ellipsis_token_ids("m", one_at_a_time, len(VOCAB), decode_batch) == (1, 3, 4)
    assert batches == [[[t] for t in range(len(VOCAB))]]


def test_is_computed_once_per_model():
    calls = []

    def counting(tokens):
        calls.append(tokens)
        return decode(tokens)

    base.ellipsis_token_ids("m", counting, len(VOCAB))
    base.ellipsis_token_ids("m", counting, len(VOCAB))
    assert len(calls) == len(VOCAB)


def test_whisper_tokenizer_offers_a_batch_decoder_that_keeps_every_token():
    from backend.backends.mlx_backend import vocabulary_decoder

    decoded = []
    backend_tokenizer = SimpleNamespace(
        decode_batch=lambda sequences, skip_special_tokens=True: decoded.append(skip_special_tokens) or ["x"]
    )
    tokenizer = SimpleNamespace(hf_tokenizer=SimpleNamespace(backend_tokenizer=backend_tokenizer))

    assert vocabulary_decoder(tokenizer)([[0]]) == ["x"]
    # Special tokens are text too; per-token decode keeps them, so must this.
    assert decoded == [False]


def test_tokenizers_without_a_fast_backend_have_no_batch_decoder():
    from backend.backends.mlx_backend import vocabulary_decoder

    assert vocabulary_decoder(SimpleNamespace(decode=decode)) is None


def test_batch_and_per_token_decoding_agree_on_the_real_whisper_vocabulary():
    from backend.backends import WHISPER_HF_REPOS
    from backend.backends.mlx_backend import vocabulary_decoder

    if not base.is_model_cached(WHISPER_HF_REPOS["turbo"], weight_extensions=(".safetensors", ".npz", ".bin")):
        pytest.skip("Whisper turbo is not downloaded")
    from huggingface_hub import snapshot_download
    from mlx_audio.stt.models.whisper.whisper import HFTokenizerWrapper
    from transformers import WhisperTokenizerFast

    hf = WhisperTokenizerFast.from_pretrained(snapshot_download(WHISPER_HF_REPOS["turbo"], local_files_only=True))
    tokenizer = HFTokenizerWrapper(hf, multilingual=True, num_languages=100, language="en")
    per_token = base.ellipsis_token_ids("a", tokenizer.decode, tokenizer.eot)
    batched = base.ellipsis_token_ids("b", tokenizer.decode, tokenizer.eot, vocabulary_decoder(tokenizer))
    assert batched == per_token and per_token
