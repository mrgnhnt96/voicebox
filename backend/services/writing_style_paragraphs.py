"""Calibration paragraphs: things a person might really say out loud.

Each is written the way speech-to-text hands dictation over, with the
problems that come from speaking faster than you think: a false start, a
repeated word, a clause said out of order, a self-correction and a run-on.
The user rewrites each into what they would actually send, so calibration
teaches restructuring and punctuation together. A run draws one paragraph
from each situation so the rewrites cover different kinds of writing.
"""

from typing import NamedTuple


class Paragraph(NamedTuple):
    id: str
    situation: str
    said: str


SITUATIONS = ("chat", "update", "question", "steps", "explanation")

PARAGRAPHS = (
    Paragraph(
        "said-chat-dinner",
        "chat",
        "yeah that works for me, I can, I can probably get there around seven but it kind of depends on traffic, "
        "if it's bad I'll text you. oh and do you want me to, should I grab anything on the way",
    ),
    Paragraph(
        "said-chat-weekend",
        "chat",
        "honestly I'm pretty wiped from this week so I think I'm gonna, I'm just gonna stay in on Friday. Saturday "
        "could work though, Saturday afternoon, no actually Saturday evening is better, let me know what you're thinking",
    ),
    Paragraph(
        "said-chat-thanks",
        "chat",
        "thanks for sending that over, I looked through the, I looked through it and it all makes sense. I'll get "
        "back to you tomorrow with a couple, just a couple small changes, no rush on your end",
    ),
    Paragraph(
        "said-update-release",
        "update",
        "okay quick update on the release, so the fix for the, the login bug is merged. we're still waiting on QA "
        "but it's looking, it looks good so far and if nothing comes up we should ship Thursday, well Thursday "
        "morning probably",
    ),
    Paragraph(
        "said-update-meeting",
        "update",
        "so I talked to the design team this morning and they, they like the new layout. the header though, they "
        "want to try a darker header. I'll send over the, the updated mockups by end of day",
    ),
    Paragraph(
        "said-update-blocked",
        "update",
        "heads up I'm blocked on the payments work, the sandbox keys expired so I can't test, I can't test "
        "anything right now. I already asked finance for new ones, and in the meantime I'm picking up the, the "
        "settings page",
    ),
    Paragraph(
        "said-question-deadline",
        "question",
        "hey do you know when the report is, when it's due? I thought it was Friday but somebody said Wednesday "
        "in standup, or was it Tuesday, no Wednesday, I just want to make sure I'm not behind",
    ),
    Paragraph(
        "said-question-tools",
        "question",
        "what are you using for notes these days? I've been trying, I've tried a few apps and none of them really "
        "stick. is there, like is there one you'd actually recommend",
    ),
    Paragraph(
        "said-question-budget",
        "question",
        "can we go over the, before the meeting can we go over the budget? the travel numbers, I'm not sure the "
        "travel numbers are right, they seem really high compared to last quarter. does Tuesday afternoon work",
    ),
    Paragraph(
        "said-steps-setup",
        "steps",
        "so first pull the latest changes, then run the install script, oh wait before that make sure you're on "
        "the main branch, then run the install script and once it finishes start the server and open the app",
    ),
    Paragraph(
        "said-steps-return",
        "steps",
        "to return it you just, you log into your account, go to your orders and pick the item and then choose "
        "a reason, and then you print the, print the label and drop it off at any pickup point",
    ),
    Paragraph(
        "said-steps-recipe",
        "steps",
        "start by heating the oil in a, in a big pan, then add the onions and cook them until they're soft, like "
        "five minutes, then the garlic and the tomatoes go in, and let it simmer for, for about twenty minutes",
    ),
    Paragraph(
        "said-explanation-cache",
        "explanation",
        "the page is slow because it loads, it's loading everything at once and most of that data isn't even "
        "shown. so the fix is, what we should do is load the first screen and then fetch the rest in the "
        "background, that should cut the wait roughly in half",
    ),
    Paragraph(
        "said-explanation-move",
        "explanation",
        "so we decided to move the launch to next month, and the main reason is the, it's the pricing change. we "
        "don't want to announce it and then change it again, and also it gives support more time to, to prepare",
    ),
    Paragraph(
        "said-explanation-habit",
        "explanation",
        "I started walking every morning a few, maybe three weeks ago and at first it was really hard to get out "
        "of bed but now I actually, I look forward to it, it's the only time I'm not looking at a screen",
    ),
)

BY_ID = {paragraph.id: paragraph for paragraph in PARAGRAPHS}
