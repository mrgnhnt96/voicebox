"""The cleanup model reuses one streaming detokenizer instead of rebuilding it."""

from backend.backends.qwen_llm_backend import _reuse_detokenizer


class FakeDetokenizer:
    built = 0

    def __init__(self, wrapper):
        FakeDetokenizer.built += 1
        self.text = ""

    def reset(self):
        self.text = ""


class FakeWrapper:
    def __init__(self):
        self._detokenizer_class = FakeDetokenizer

    @property
    def detokenizer(self):
        return self._detokenizer_class(self)


def test_one_detokenizer_is_built_and_reset_for_every_generation():
    FakeDetokenizer.built = 0
    wrapper = FakeWrapper()
    _reuse_detokenizer(wrapper)
    first = wrapper.detokenizer
    first.text = "left over from the previous cleanup"
    second = wrapper.detokenizer
    assert second is first
    assert second.text == ""
    assert FakeDetokenizer.built == 1
