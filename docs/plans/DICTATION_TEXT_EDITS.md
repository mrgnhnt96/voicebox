# Spoken text edits

Smart cleanup now recognizes a conservative set of explicit English formatting commands before model refinement:

- At a sentence boundary, `add a new line and then create a list of item A, item B, and item C` creates three Markdown bullets.
- A trailing `actually no, remove that list` retracts the list and its formatting cue, retaining preceding prose.
- `remove the last item` removes only the final item.
- Standalone `new line` and `new paragraph` commands create line/paragraph breaks.

Requires automatic refinement and Smart cleanup. Retractions also require Remove self-corrections. Existing settings are used; no model download or settings migration is needed.

Recognized structural edits bypass the generative rewrite so the small model cannot restore removed text or flatten the list. This means surrounding prose is retained as transcribed, without additional filler/grammar cleanup in these takes. Other transcripts still use the existing model refinement. This is a bounded formatting feature, not a general voice editor: only one final comma-separated list, optionally followed by a supported correction, is parsed. Quoted commands, ambiguous item boundaries, additional sentences after a list, and unknown revisions fall back to existing refinement. An entirely canceled take without preceding prose also falls back because empty refined text is not supported by the capture delivery path.

## Verification

- Actual local Qwen3 0.6B baseline retained both examples' spoken formatting instructions.
- A prompt-only experiment produced unrelated example text or removed the wrong sentence; it was discarded.
- The final production refinement service returns the expected opening sentence for the canceled list and the opening sentence plus three bullets for the retained list. Terminal punctuation is retained.
- Ordinary and reported commands continue through the unchanged model path. Exact wording is still model-dependent (the live probe added a comma / the word `to`); this change does not resolve those existing small-model limitations.
- Regression tests cover the user's examples, literal/reported commands, ambiguous lists, settings opt-outs, last-item removal, paragraphs, bypassing generative rewriting for resolved edits, and continued model refinement for ordinary speech.
- Focused backend suite: 38 tests passed. Frontend TypeScript checks passed.
