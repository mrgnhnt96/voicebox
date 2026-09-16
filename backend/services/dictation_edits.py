"""Conservative spoken formatting for complete, explicit dictation commands.

Return None for ambiguous/unsupported wording so normal refinement still runs.
Only standalone commands are recognized; quoted/reported speech is preserved.
"""

import re

# A command must start the transcript or follow sentence punctuation/a line break.
_BOUNDARY = r"(?:^|(?<=[.!?\n])\s+)"
_LINE = r"(?:add (?:a )?|insert (?:a )?)?new (?:line|paragraph)"
_LIST = r"(?:create|make|add) (?:a )?(?:(?:bullet|bulleted) )?list of"
_START = re.compile(
    _BOUNDARY
    + rf"(?P<line>{_LINE})(?:\s+and\s+then)?\s+(?P<list>{_LIST})\s+"
    + "|"
    + _BOUNDARY
    + rf"(?P<list_only>{_LIST})\s+",
    re.IGNORECASE,
)
_CANCEL = re.compile(
    r"(?:and\s+)?(?:actually\s*,?\s*(?:no\s*,?\s*)?|no\s*,?\s*)?"
    r"(?:remove|delete)\s+(?:that|the)\s+list[.!]?\s*$",
    re.IGNORECASE,
)
_LAST_ITEM = re.compile(
    r"(?:and\s+)?(?:actually\s*,?\s*(?:no\s*,?\s*)?)?"
    r"(?:remove|delete)\s+the\s+last\s+item[.!]?\s*$",
    re.IGNORECASE,
)
_LINE_COMMAND = re.compile(_BOUNDARY + rf"(?P<command>{_LINE})\s*[.,]?\s+", re.IGNORECASE)


def _capitalized(text: str) -> str:
    return text[:1].upper() + text[1:]


def apply_dictation_edits(text: str, *, formatting: bool, corrections: bool) -> str | None:
    """Apply standalone list/line commands with clear, local edit targets.

    List items must be comma-separated. Only a final list, optionally followed
    by an explicit cancellation or last-item removal, is parsed. A mention of
    a list inside prose, quotes, or more complex edits is left to refinement.
    """
    if not formatting:
        return None
    # Quotation marks could make a command literal. Apostrophes in contractions
    # are fine, but quoted commands should never delete or restructure prose.
    if any(mark in text for mark in ('"', "\u201c", "\u201d", "\u2018")) or re.search(r"(?<!\w)['\u2019](?=\w)", text):
        return None

    matches = list(_START.finditer(text))
    if matches:
        if len(matches) != 1:
            return None
        match = matches[0]
        prefix = text[: match.start()].rstrip()
        tail = text[match.end() :].strip()
        # Keep parsing deliberately bounded: no sentence punctuation in items.
        parts = re.split(r"[.!?]\s+", tail, maxsplit=1)
        items_text = parts[0].rstrip(".!?").strip()
        revision = parts[1].strip() if len(parts) == 2 else ""
        cancel = bool(revision and _CANCEL.fullmatch(revision))
        remove_last = bool(revision and _LAST_ITEM.fullmatch(revision))
        if revision and not ((cancel or remove_last) and corrections):
            return None
        if any(char in items_text for char in ".!?\n"):
            return None
        items = [item.strip() for item in items_text.split(",")]
        if len(items) < 2 or any(not item for item in items):
            return None
        # Oxford comma or a final "B and C" are the supported list separators.
        last = re.sub(r"^and\s+", "", items.pop(), flags=re.IGNORECASE)
        items.extend(re.split(r"\s+and\s+", last, maxsplit=1, flags=re.IGNORECASE))
        if any(not item for item in items):
            return None
        if cancel:
            # Empty refinement results are not supported by captures; don't
            # manufacture a replacement when the entire take was retracted.
            return prefix or None
        if remove_last:
            items.pop()
        lines = "\n".join(f"- {_capitalized(item)}" for item in items)
        separator = "\n\n" if match.group("line") and "paragraph" in match.group("line").lower() else "\n"
        return prefix + separator + lines if prefix else lines

    # Standalone line commands only; don't reinterpret "explain new line".
    if not _LINE_COMMAND.search(text):
        return None
    return _LINE_COMMAND.sub(
        lambda match: "\n\n" if "paragraph" in match.group("command").lower() else "\n",
        text,
    ).strip()
