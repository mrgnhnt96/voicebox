"""Calibration paragraphs, written the way Standard refinement punctuates dictation.

Each one is spoken-style content with the habits people most often change:
sentence breaks between related thoughts, commas after opening words and
before conjunctions, capitalized sentence starts and a closing period. A run
draws one paragraph from each situation so the edits cover different kinds
of writing.
"""

from typing import NamedTuple


class Paragraph(NamedTuple):
    id: str
    situation: str
    text: str


SITUATIONS = ("chat", "update", "question", "steps", "explanation")

PARAGRAPHS = (
    Paragraph(
        "chat-dinner",
        "chat",
        "Yeah, that works for me. I can probably get there around seven, but it depends on traffic. If it's "
        "bad, I'll text you. Do you want me to grab anything on the way?",
    ),
    Paragraph(
        "chat-weekend",
        "chat",
        "Honestly, I'm pretty wiped from this week. So I think I'm going to stay in on Friday, and just rest. "
        "But Saturday could work. Let me know what you're thinking.",
    ),
    Paragraph(
        "chat-thanks",
        "chat",
        "Thanks, I got the file. I looked through it, and it all makes sense. I'll get back to you tomorrow "
        "with a couple of small changes. No rush on your end.",
    ),
    Paragraph(
        "update-release",
        "update",
        "Okay, quick update on the release. The fix for the login bug is merged. We're still waiting on QA, "
        "but it looks good so far. If nothing comes up, we should ship on Thursday.",
    ),
    Paragraph(
        "update-meeting",
        "update",
        "So, I talked to the design team this morning. They like the new layout, but they want to try a "
        "darker header. I'll send over the updated mockups by end of day.",
    ),
    Paragraph(
        "update-blocked",
        "update",
        "Heads up, I'm blocked on the payments work. The sandbox keys expired, and I can't test anything. I "
        "already asked finance for new ones. In the meantime, I'm picking up the settings page.",
    ),
    Paragraph(
        "question-deadline",
        "question",
        "Hey, do you know when the report is due? I thought it was Friday, but someone mentioned Wednesday in "
        "standup. I just want to make sure I'm not behind.",
    ),
    Paragraph(
        "question-tools",
        "question",
        "Actually, what are you using for notes these days? I've been trying a few apps, but none of them "
        "really stick. Is there one you'd actually recommend?",
    ),
    Paragraph(
        "question-budget",
        "question",
        "Also, can we go over the budget before the meeting? I'm not sure the travel numbers are right, and "
        "they seem high compared to last quarter. Does Tuesday afternoon work for you?",
    ),
    Paragraph(
        "steps-setup",
        "steps",
        "First, pull the latest changes. Then run the install script, and wait for it to finish. Start the "
        "server and open the app. If it asks for a key, use the one from the shared vault.",
    ),
    Paragraph(
        "steps-return",
        "steps",
        "Okay, to return it, log into your account. Go to your orders and pick the item. Then choose a "
        "reason, and print the label. After that, just drop it off at any pickup point.",
    ),
    Paragraph(
        "steps-recipe",
        "steps",
        "So, start by heating the oil in a big pan. Add the onions, and cook them until they're soft. Then "
        "stir in the garlic and the tomatoes. Let it simmer for about twenty minutes.",
    ),
    Paragraph(
        "explanation-cache",
        "explanation",
        "Basically, the page is slow because it loads everything at once. Most of that data isn't even shown. "
        "So the fix is to load the first screen, and fetch the rest in the background. That should cut the "
        "wait roughly in half.",
    ),
    Paragraph(
        "explanation-move",
        "explanation",
        "Yeah, we decided to move the launch to next month. The main reason is the pricing change. We don't "
        "want to announce it, and then change it again. It also gives support more time to prepare.",
    ),
    Paragraph(
        "explanation-habit",
        "explanation",
        "Honestly, I started walking every morning a few weeks ago. It was hard to get out of bed at first, "
        "but now I actually look forward to it. It's the only time I'm not looking at a screen.",
    ),
)

BY_ID = {paragraph.id: paragraph for paragraph in PARAGRAPHS}
