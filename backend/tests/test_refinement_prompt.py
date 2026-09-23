"""Punctuation style in the refinement prompt and saved flags."""

from backend.services.refinement import (
    REFINEMENT_EXAMPLES,
    RefinementFlags,
    build_refinement_prompt,
    refinement_examples,
)


def test_standard_style_keeps_the_written_prose_prompt():
    prompt = build_refinement_prompt(RefinementFlags())
    assert "so the result reads like written prose" in prompt
    assert "like something a competent writer would type" in prompt
    assert "{punctuation}" not in prompt
    assert "{cleanup_punctuation}" not in prompt
    assert "casual" not in prompt.casefold()
    assert refinement_examples(RefinementFlags()) is REFINEMENT_EXAMPLES


def test_casual_style_asks_for_commas_and_drops_the_prose_wording():
    flags = RefinementFlags(punctuation_style="casual")
    prompt = build_refinement_prompt(flags)
    assert "Punctuation style: casual." in prompt
    assert "written prose" not in prompt
    assert "competent writer" not in prompt
    examples = refinement_examples(flags)
    assert examples[len(examples) - len(REFINEMENT_EXAMPLES) :] == REFINEMENT_EXAMPLES


def test_standard_style_is_left_out_of_saved_flags():
    assert RefinementFlags().to_dict() == {"smart_cleanup": True, "self_correction": True, "preserve_technical": True}
    casual = RefinementFlags(punctuation_style="casual").to_dict()
    assert casual["punctuation_style"] == "casual"
    assert RefinementFlags.from_dict(casual) == RefinementFlags(punctuation_style="casual")
    assert RefinementFlags.from_dict({"punctuation_style": "shouting"}).punctuation_style == "standard"


def test_whisper_final_period_is_not_shown_to_the_cleanup(monkeypatch):
    import asyncio

    from backend.services import personal_examples, refinement

    seen = {}

    class Backend:
        model_size = "4B"

        async def generate(self, **arguments):
            seen.update(arguments)
            return "Done"

    monkeypatch.setattr(personal_examples, "closest", lambda *_, **__: [("Yes.", "Yes")])
    asyncio.run(refinement.refine_transcript("Go home. Do chores.", RefinementFlags(), backend_override=Backend()))
    assert seen["prompt"] == "Go home. Do chores"
    assert ("Yes", "Yes") in seen["examples"]
