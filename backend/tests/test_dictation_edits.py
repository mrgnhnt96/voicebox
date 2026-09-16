"""Spoken formatting regressions, including literal commands and opt-outs."""

import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from backend.services.dictation_edits import apply_dictation_edits
from backend.services.refinement import RefinementFlags, refine_transcript

CASES = json.loads((Path(__file__).parent / "fixtures/dictation_edits.json").read_text())


@pytest.mark.parametrize("case", CASES[:2], ids=lambda case: case["name"])
def test_user_list_examples(case):
    assert apply_dictation_edits(case["raw"], formatting=True, corrections=True) == case["expected"]


@pytest.mark.parametrize(
    "raw",
    [
        CASES[2]["raw"],
        CASES[3]["raw"],
        "Please tell Sam to create a list of apples, pears, and oranges.",
        'She said "Create a list of apples, pears, and oranges."',
        "Create a list of research and development.",
        "Create a list of version 1.2, version 2.3, and version 3.4.",
        "Create a list of A, B, and C. Send it tomorrow.",
    ],
)
def test_ambiguous_or_literal_content_uses_normal_refinement(raw):
    assert apply_dictation_edits(raw, formatting=True, corrections=True) is None


def test_disabled_formatting_preserves_spoken_commands():
    assert apply_dictation_edits(CASES[1]["raw"], formatting=False, corrections=True) is None


def test_disabled_corrections_does_not_apply_retraction():
    assert apply_dictation_edits(CASES[0]["raw"], formatting=True, corrections=False) is None


def test_last_item_removal_preserves_other_items():
    assert (
        apply_dictation_edits(
            "Shopping. Create a list of apples, pears, and oranges. Actually, remove the last item.",
            formatting=True,
            corrections=True,
        )
        == "Shopping.\n- Apples\n- Pears"
    )


def test_paragraph_and_newline():
    assert (
        apply_dictation_edits(
            "Hello. New paragraph The review is ready. New line Please read it.", formatting=True, corrections=True
        )
        == "Hello.\n\nThe review is ready.\nPlease read it."
    )


@pytest.mark.asyncio
async def test_structural_edits_do_not_get_rewritten_by_model(monkeypatch):
    backend = type("Backend", (), {"model_size": "0.6B", "generate": AsyncMock()})()
    monkeypatch.setattr("backend.services.refinement.llm_service.get_llm_model", lambda: backend)
    for case in CASES[:2]:
        actual, model = await refine_transcript(case["raw"], RefinementFlags())
        assert actual == case["expected"]
        assert model == "0.6B"
    backend.generate.assert_not_awaited()


@pytest.mark.asyncio
async def test_ordinary_dictation_still_uses_refinement(monkeypatch):
    backend = type("Backend", (), {"model_size": "0.6B", "generate": AsyncMock(return_value="Cleaned prose.")})()
    monkeypatch.setattr("backend.services.refinement.llm_service.get_llm_model", lambda: backend)
    assert await refine_transcript("um prose", RefinementFlags()) == ("Cleaned prose.", "0.6B")
    backend.generate.assert_awaited_once()
