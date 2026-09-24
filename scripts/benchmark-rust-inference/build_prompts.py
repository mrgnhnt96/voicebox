"""Build the exact cleanup prompts production sends, for recent real dictations.

usage: build_prompts.py <repo_root> <scratch_data_dir> <n> <out.json>
<scratch_data_dir> is a COPY of the Voicebox data dir (voicebox.db, writing-style.json,
correction-learning.json). It runs refine_transcript with a capturing backend, so the
system prompt, few-shot examples, personal examples and notes match the user's settings.
Each entry holds the generate() arguments and the chat-templated prompt text (Qwen3,
enable_thinking=False) that both MLX and llama.cpp are fed.
"""
import asyncio, json, os, sqlite3, sys

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
repo, data_dir, n, out = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
sys.path.insert(0, repo)

from backend import config  # noqa: E402

config.set_data_dir(data_dir)
from backend.database import session  # noqa: E402

session.init_db()
from backend.services import refinement, settings  # noqa: E402
from backend.backends.qwen_llm_backend import _build_messages  # noqa: E402
from transformers import AutoTokenizer  # noqa: E402


class Capture:
    model_size = "4B"
    supports_adapters = False

    def __init__(self):
        self.calls = []

    async def generate(self, **kw):
        self.calls.append(kw)
        return kw["prompt"]


with session.SessionLocal() as db:
    s = settings.get_capture_settings(db)
    flags = refinement.RefinementFlags(s.smart_cleanup, s.self_correction, s.preserve_technical, s.punctuation_style)
    print("settings:", s.stt_model, s.llm_model, flags, file=sys.stderr)

con = sqlite3.connect(f"file:{data_dir}/voicebox.db?mode=ro", uri=True)
rows = con.execute(
    "select transcript_raw from captures where length(transcript_raw) > 0 order by created_at desc limit ?", (n * 3,)
).fetchall()

tok = AutoTokenizer.from_pretrained("mlx-community/Qwen3-4B-4bit")
entries = []
for (raw,) in rows:
    cap = Capture()
    asyncio.run(refinement.refine_transcript(raw, flags, "4B", backend_override=cap))
    if not cap.calls:  # resolved by a deterministic edit; no model call
        continue
    kw = cap.calls[0]
    messages = _build_messages(kw["prompt"], kw["system"], kw["examples"])
    text = tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True, enable_thinking=False)
    ids = tok.encode(text, add_special_tokens=False)
    entries.append({"transcript": raw, "prompt": kw["prompt"], "system": kw["system"], "examples": kw["examples"],
                    "chat": text, "n_tokens": len(ids)})
    if len(entries) == n:
        break

json.dump({"flags": flags.to_dict(), "entries": entries}, open(out, "w"), indent=1)
pre = os.path.commonprefix([e["chat"] for e in entries])
print(f"{len(entries)} prompts; tokens {[e['n_tokens'] for e in entries]}; shared prefix {len(tok.encode(pre))} tokens",
      file=sys.stderr)
