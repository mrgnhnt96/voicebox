"""Conservative vocabulary candidates and deterministic offline evaluation."""

import hashlib
import re
import statistics
import time
from collections import defaultdict
from dataclasses import dataclass
from difflib import SequenceMatcher

WORD = re.compile(r"\w+(?:['\u2019-]\w+)*", re.UNICODE)
MAX_RULES = 32
MAX_TEXT = 4000
# Independent, unchanged examples: candidates must preserve all of these.
KNOWN_GOOD = (
    "Tell me a joke about databases.",
    "What time is the meeting?",
    "Remind me to call Mom tomorrow.",
    "The meeting is at four pm on Tuesday.",
    "Run npm install and open index.tsx.",
    "Keep the API key out of the logs.",
    "I mean what I said.",
    "Actually, that is correct.",
    "The voice box is part of the larynx.",
    "Put the git hub on the workbench.",
    "Send the report to Morgan.",
    "Do not delete the database.",
    "The total is $15.50, not $50.",
    "We need three hundred records.",
    "Open the box and close the door.",
    "The file is in src/components.",
)


@dataclass(frozen=True)
class Example:
    id: str
    capture_id: str
    original: str
    expected: str
    language: str | None


def words(text):
    return [m.group() for m in WORD.finditer(text)]


def candidate(example):
    """Learn one short replacement with unchanged words on both sides.

    Context stays in the matching key so a correction never becomes a global
    single-word replacement. Insertions/deletions and multi-edit rewrites are
    intentionally not learned automatically.
    """
    old, new = words(example.original), words(example.expected)
    edits = [op for op in SequenceMatcher(None, old, new, autojunk=False).get_opcodes() if op[0] != "equal"]
    if len(edits) != 1:
        return None
    tag, a, b, c, d = edits[0]
    if tag != "replace" or not (1 <= b - a <= 3 and 1 <= d - c <= 3):
        return None
    if a == 0 or b == len(old):
        return None
    # Only contiguous word/space phrases; never learn edits to code punctuation.
    matches = list(WORD.finditer(example.original))
    phrase = example.original[matches[a - 1].start() : matches[b].end()]
    if not re.fullmatch(r"[\w'\u2019\- ]+", phrase):
        return None
    source = old[a - 1 : b + 1]
    replacement = new[c:d]
    old_term, new_term = " ".join(old[a:b]), " ".join(replacement)
    if any(char.isdigit() for char in old_term + new_term):
        return None
    if SequenceMatcher(None, old_term.casefold(), new_term.casefold()).ratio() < 0.6:
        return None
    key = (source, replacement, example.language)
    identity = hashlib.sha256(repr(key).encode()).hexdigest()[:16]
    return {"id": identity, "source": source, "replacement": replacement, "language": example.language}


def compile_rules(rules):
    return tuple(
        (
            rule,
            re.compile(r"(?<![\w'\u2019-])" + r"\s+".join(re.escape(w) for w in rule["source"]) + r"(?![\w'\u2019-])"),
        )
        for rule in rules
    )


def apply_rules(text, compiled, language=None):
    """Apply at most one rule per span, preserving context and punctuation."""
    edits = []
    for rule, pattern in compiled:
        if rule["language"] != language:
            continue
        for match in pattern.finditer(text):
            tokens = list(WORD.finditer(match.group()))
            start = match.start() + tokens[1].start()
            end = match.start() + tokens[-2].end()
            edits.append((start, end, " ".join(rule["replacement"])))
            if len(edits) > 128:
                return text
    # Overlapping candidates are ambiguous: leave those spans untouched.
    safe = [
        edit
        for edit in edits
        if not any(other != edit and edit[0] < other[1] and other[0] < edit[1] for other in edits)
    ]
    for start, end, replacement in sorted(set(safe), reverse=True):
        text = text[:start] + replacement + text[end:]
    return text


def loss(actual, expected):
    """Token edit distance, including punctuation and capitalization."""
    a, b = re.findall(r"\w+|[^\w\s]", actual), re.findall(r"\w+|[^\w\s]", expected)
    previous = list(range(len(b) + 1))
    for i, token in enumerate(a, 1):
        current = [i]
        for j, target in enumerate(b, 1):
            current.append(min(current[-1] + 1, previous[j] + 1, previous[j - 1] + (token != target)))
        previous = current
    return previous[-1]


def evaluate(examples, active, blocked=()):
    """Derive on two distinct takes; require improvement on an unseen third.

    The chronological final third is withheld from candidate generation.
    Duplicate utterances cannot supply independent training/validation evidence.
    """
    unique = {}
    for example in examples:
        unique[(example.language, example.original)] = example
    examples = list(unique.values())
    split = max(0, len(examples) * 2 // 3)
    training, heldout = examples[:split], examples[split:]
    groups = defaultdict(list)
    for example in training:
        rule = candidate(example)
        if rule and rule["id"] not in blocked:
            groups[rule["id"]].append((rule, example))
    proposed = []
    for group in groups.values():
        if len({example.capture_id for _, example in group}) < 2:
            continue
        rule = group[0][0]
        compiled = compile_rules([rule])
        if any(
            loss(apply_rules(e.original, compiled, e.language), e.expected) < loss(e.original, e.expected)
            for e in heldout
            if e.capture_id not in {example.capture_id for _, example in group}
        ):
            proposed.append(rule)
    # Require each addition to improve the held-out set and regress nowhere.
    selected = list(active)
    validation = [(e.original, e.expected, e.language) for e in examples]
    validation += [(e.expected, e.expected, e.language) for e in examples]
    languages = {e.language for e in examples} | {None}
    validation += [(text, text, language) for text in KNOWN_GOOD for language in languages]
    accepted = 0
    for rule in sorted(proposed, key=lambda r: r["id"]):
        if rule["id"] in {r["id"] for r in selected} or len(selected) >= MAX_RULES:
            continue
        before, after = compile_rules(selected), compile_rules([*selected, rule])
        if any(
            loss(apply_rules(text, after, lang), expected) > loss(apply_rules(text, before, lang), expected)
            for text, expected, lang in validation
        ):
            continue
        if not any(
            loss(apply_rules(e.original, after, e.language), e.expected)
            < loss(apply_rules(e.original, before, e.language), e.expected)
            for e in heldout
        ):
            continue
        selected.append(rule)
        accepted += 1
    compiled = compile_rules(selected)
    # Worst-size input, repeated timings: no GPU/model calls and a hard 5 ms gate.
    probe = (" ".join(e.original for e in examples) + " ".join(KNOWN_GOOD))[:MAX_TEXT]
    probe = (probe + " ") * (MAX_TEXT // max(1, len(probe)) + 1)
    timings = []
    for _ in range(25):
        start = time.perf_counter()
        for language in languages:
            apply_rules(probe[:MAX_TEXT], compiled, language)
        timings.append((time.perf_counter() - start) * 1000)
    latency = statistics.median(timings)
    passed = latency <= 5
    return (selected if passed else active), {
        "training_examples": len(training),
        "heldout_examples": len(heldout),
        "candidates": len(proposed),
        "accepted": accepted if passed else 0,
        "median_rule_ms": round(latency, 3),
        "latency_passed": passed,
    }
