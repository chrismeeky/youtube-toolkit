#!/usr/bin/env python3
"""Label indexed channels with Claude, as training data for a learned niche classifier.

Why this exists
---------------
niche_for() compares a channel with a one-line description of each niche and keeps the
closest. It has never seen a single example of what a niche's channels actually look like,
which is how a police bodycam channel came out as "Challenges and stunts". A classifier
trained on real examples does not have that blind spot — but it needs thousands of labelled
channels, far more than anyone will label by hand. Claude labels them; a small model learns
from the labels; the human-labelled worksheets in eval_sets/ judge the result.

Those worksheets are deliberately kept out of everything here. If the test set were labelled
by the same model that labelled the training set, a high score would only mean the student
copies the teacher, mistakes included.

Three steps, because a batch runs asynchronously (usually under an hour, at most 24):

    python3 llm_label.py submit --n 500 --dry-run   # build the requests, estimate cost
    python3 llm_label.py submit --n 500             # send them as one Message Batch
    python3 llm_label.py status                     # poll
    python3 llm_label.py collect                    # write labels, report agreement

The batch id is written to llm_labels/state.json, so a closed terminal loses nothing.
"""

import argparse
import json
import os
import random
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.join(os.path.dirname(HERE), "transcript_service")
OUT_DIR = os.path.join(HERE, "llm_labels")
STATE = os.path.join(OUT_DIR, "state.json")
EVAL_DIR = os.path.join(HERE, "eval_sets")
ENV_FILE = os.environ.get("ENV_FILE",
                          os.path.expanduser("~/Desktop/youtube automation/.env"))

MODEL = "claude-opus-5"
# Classification is a routine judgement: low effort holds quality and keeps thinking short.
EFFORT = "low"
MAX_TOKENS = 4000
# Batch prices, per million tokens: half the list rate for this model.
PRICE_IN, PRICE_OUT = 2.50, 12.50


def load_env(path):
    """The service reads its configuration at import time, so this runs first.

    The Anthropic key lives in the web app's env file under its browser-facing name. It is
    copied to the name the SDK looks for, and never printed.
    """
    wanted = ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OPENAI_API_KEY",
              "ANTHROPIC_API_KEY", "NEXT_PUBLIC_ANTHROPIC_API_KEY")
    if not os.path.exists(path):
        sys.exit("No .env at %s — set ENV_FILE=/path/to/.env" % path)
    found = {}
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            if k in wanted and v.strip():
                found[k] = v.strip()
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OPENAI_API_KEY"):
        if k in found:
            os.environ.setdefault(k, found[k])
    key = found.get("ANTHROPIC_API_KEY") or found.get("NEXT_PUBLIC_ANTHROPIC_API_KEY")
    if key:
        os.environ.setdefault("ANTHROPIC_API_KEY", key)


load_env(ENV_FILE)
sys.path.insert(0, SERVICE)
import app  # noqa: E402  — after load_env: app reads env at import

import anthropic  # noqa: E402
from anthropic.types.message_create_params import MessageCreateParamsNonStreaming  # noqa: E402
from anthropic.types.messages.batch_create_params import Request  # noqa: E402

NICHE_NAMES = [name for name, _, _ in app.NICHES]


# ─── the index ───────────────────────────────────────────────────────────────

def supabase(query, rng=None):
    headers = {"apikey": app.SUPABASE_KEY, "Authorization": "Bearer " + app.SUPABASE_KEY}
    if rng:
        headers["Range"] = rng
    req = urllib.request.Request(app.SUPABASE_URL.rstrip("/") + query, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read().decode("utf-8", "replace"))


def all_handles():
    """Every classifiable channel, paged — PostgREST caps a single response."""
    out, page = [], 1000
    for start in range(0, 100000, page):
        rows = supabase("/rest/v1/channels?select=handle&embedding=not.is.null"
                        "&handle=not.is.null&order=id", "%d-%d" % (start, start + page - 1))
        out.extend(r["handle"] for r in rows if r.get("handle"))
        if len(rows) < page:
            break
    return out


def held_out():
    """Channels in the human-labelled worksheets. Never labelled here, never trained on."""
    import csv
    seen = set()
    if os.path.isdir(EVAL_DIR):
        for name in os.listdir(EVAL_DIR):
            if name.endswith(".csv") and ".before." not in name:
                with open(os.path.join(EVAL_DIR, name), newline="", encoding="utf-8") as fh:
                    seen.update((r.get("handle") or "").lower() for r in csv.DictReader(fh))
    return seen


def channel_rows(handles):
    out = []
    for i in range(0, len(handles), 40):
        quoted = ",".join('"%s"' % h.replace('"', "") for h in handles[i:i + 40])
        out.extend(supabase(
            "/rest/v1/channels?select=handle,title,subscribers,video_count,country,"
            "description,keywords,embed_source&handle=in.(" + urllib.parse.quote(quoted) + ")"))
    return out


# ─── the prompt ──────────────────────────────────────────────────────────────

def system_prompt():
    """Identical for every request, so it can be cached across the whole batch."""
    labels = "\n".join("- %s: %s" % (name, desc) for name, _, desc in app.NICHES)
    return (
        "You classify YouTube channels by subject, for a research tool that estimates what a "
        "channel earns from its niche.\n\n"
        "Pick the single niche below that best describes what the channel's videos are "
        "about. Judge by the video titles first — they show what the channel actually "
        "publishes — then the description and keywords, which are often boilerplate or "
        "out of date. A channel that posts police bodycam footage is about policing even "
        "if its description talks about law; a channel reviewing a video game called "
        "Bodycam is about gaming.\n\n"
        "Answer \"none\" when no niche fits reasonably well, or when the channel is too "
        "mixed or too thinly described to call. A wrong label does more harm than no label: "
        "these answers become training data.\n\n"
        "Confidence: \"high\" when the channel plainly belongs to the niche, \"medium\" when "
        "it fits but a second niche is close, \"low\" when it is a judgement call.\n\n"
        "Niches:\n" + labels
    )


def user_prompt(row):
    parts = ["Channel: %s (%s)" % (row.get("title") or "", row.get("handle") or "")]
    if row.get("subscribers"):
        parts.append("Subscribers: %s" % row["subscribers"])
    if row.get("country"):
        parts.append("Country: %s" % row["country"])
    # embed_source is title + description + recent video titles, as they were embedded.
    parts.append("Title, description and recent video titles:\n%s" % (row.get("embed_source") or ""))
    if row.get("description"):
        parts.append("Full description:\n%s" % row["description"])
    if row.get("keywords"):
        parts.append("Channel keywords: %s" % row["keywords"])
    return "\n\n".join(parts)


SCHEMA = {
    "type": "object",
    "properties": {
        "niche": {"type": "string", "enum": NICHE_NAMES + ["none"]},
        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
        "reason": {"type": "string"},
    },
    "required": ["niche", "confidence", "reason"],
    "additionalProperties": False,
}


def params_for(row, system):
    return MessageCreateParamsNonStreaming(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": user_prompt(row)}],
        output_config={"effort": EFFORT,
                       "format": {"type": "json_schema", "schema": SCHEMA}},
    )


# ─── state ───────────────────────────────────────────────────────────────────

def read_state():
    if not os.path.exists(STATE):
        return {}
    with open(STATE) as fh:
        return json.load(fh)


def write_state(state):
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(STATE, "w") as fh:
        json.dump(state, fh, indent=2)


# ─── commands ────────────────────────────────────────────────────────────────

def cmd_submit(args):
    state = read_state()
    if state.get("batch_id") and not state.get("collected") and not args.force:
        sys.exit("Batch %s is not collected yet. Run `collect`, or pass --force to start "
                 "another." % state["batch_id"])

    skip = held_out()
    labelled = set()
    if os.path.isdir(OUT_DIR):
        for name in os.listdir(OUT_DIR):
            if name.startswith("labels_") and name.endswith(".jsonl"):
                with open(os.path.join(OUT_DIR, name)) as fh:
                    labelled.update(json.loads(line)["handle"].lower() for line in fh if line.strip())

    pool = [h for h in all_handles() if h.lower() not in skip and h.lower() not in labelled]
    rng = random.Random(args.seed)
    picked = rng.sample(pool, min(args.n, len(pool)))
    rows = [r for r in channel_rows(picked) if (r.get("embed_source") or "").strip()]
    print("pool %d channels (%d held out as the human test set, %d already labelled); "
          "sending %d" % (len(pool), len(skip), len(labelled), len(rows)))

    system = system_prompt()
    client = anthropic.Anthropic()

    # A real count for one request, scaled — the system prompt is the same in all of them.
    sample = params_for(rows[0], system)
    counted = client.messages.count_tokens(
        model=MODEL, system=sample["system"], messages=sample["messages"]).input_tokens
    avg_user = sum(len(user_prompt(r)) for r in rows) / len(rows) / len(user_prompt(rows[0]) or "x")
    est_in = counted * len(rows) * max(avg_user, 1.0)
    est_out = 400 * len(rows)       # a short thinking pass at low effort plus the JSON
    print("estimated %.1fM input + %.2fM output tokens -> about $%.2f at batch rates "
          "(before caching, which only lowers it)"
          % (est_in / 1e6, est_out / 1e6, est_in / 1e6 * PRICE_IN + est_out / 1e6 * PRICE_OUT))

    if args.dry_run:
        print("\n--- system prompt (%d chars) ---\n%s\n\n--- first request ---\n%s"
              % (len(system), system[:600] + "\n...", user_prompt(rows[0])[:800]))
        return

    batch = client.messages.batches.create(requests=[
        Request(custom_id="c%04d" % i, params=params_for(r, system))
        for i, r in enumerate(rows)
    ])
    write_state({
        "batch_id": batch.id,
        "submitted_at": datetime.now(timezone.utc).isoformat(),
        "model": MODEL,
        "handles": {"c%04d" % i: r["handle"] for i, r in enumerate(rows)},
        "collected": False,
    })
    print("submitted batch %s (%d requests) — run `status`, then `collect`"
          % (batch.id, len(rows)))


def cmd_status(_args):
    state = read_state()
    if not state.get("batch_id"):
        sys.exit("No batch submitted yet.")
    batch = anthropic.Anthropic().messages.batches.retrieve(state["batch_id"])
    c = batch.request_counts
    print("%s  %s  — processing %d, succeeded %d, errored %d, canceled %d, expired %d"
          % (batch.id, batch.processing_status, c.processing, c.succeeded, c.errored,
             c.canceled, c.expired))


def cmd_collect(_args):
    state = read_state()
    if not state.get("batch_id"):
        sys.exit("No batch submitted yet.")
    client = anthropic.Anthropic()
    batch = client.messages.batches.retrieve(state["batch_id"])
    if batch.processing_status != "ended":
        sys.exit("Batch is still %s — try again later." % batch.processing_status)

    handles = state["handles"]
    out_path = os.path.join(OUT_DIR, "labels_%s.jsonl" % batch.id)
    counts = {"labelled": 0, "none": 0, "refused": 0, "errored": 0, "unparsed": 0}
    tokens = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0}
    rows = []

    # Results arrive in any order: always key by custom_id.
    for result in client.messages.batches.results(batch.id):
        handle = handles.get(result.custom_id)
        if result.result.type != "succeeded":
            counts["errored"] += 1
            continue
        msg = result.result.message
        u = msg.usage
        tokens["input"] += u.input_tokens or 0
        tokens["output"] += u.output_tokens or 0
        tokens["cache_read"] += getattr(u, "cache_read_input_tokens", 0) or 0
        tokens["cache_write"] += getattr(u, "cache_creation_input_tokens", 0) or 0
        # Fallback models cannot be used on the Batches API, so a refusal simply stays
        # unlabelled. It is counted rather than guessed at.
        if msg.stop_reason == "refusal":
            counts["refused"] += 1
            continue
        text = next((b.text for b in msg.content if b.type == "text"), "")
        try:
            data = json.loads(text)
        except ValueError:
            counts["unparsed"] += 1
            continue
        counts["none" if data["niche"] == "none" else "labelled"] += 1
        rows.append({"handle": handle, "niche": data["niche"],
                     "confidence": data["confidence"], "reason": data["reason"],
                     "model": state.get("model", MODEL), "batch": batch.id})

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(out_path, "w") as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")
    state["collected"] = True
    state["labels_file"] = os.path.basename(out_path)
    write_state(state)

    # Cost from what the API reported, not from the estimate. Cache reads and writes are
    # listed separately; their rates differ from plain input, so they are shown as tokens.
    cost = tokens["input"] / 1e6 * PRICE_IN + tokens["output"] / 1e6 * PRICE_OUT
    print("wrote %d rows to %s" % (len(rows), out_path))
    print("labelled %(labelled)d, none %(none)d, refused %(refused)d, errored %(errored)d, "
          "unparsed %(unparsed)d" % counts)
    print("tokens: %(input)d input, %(output)d output, %(cache_read)d cache read, "
          "%(cache_write)d cache write" % tokens)
    print("cost of uncached input + output at batch rates: $%.2f" % cost)

    report_agreement(rows)


def report_agreement(rows):
    """How often the current classifier already agrees with Claude.

    Not accuracy — Claude is not ground truth — but where the two disagree is where a
    learned classifier has something to learn, and the pattern of disagreement says which
    labels the current approach gets wrong most often.
    """
    labelled = [r for r in rows if r["niche"] != "none"]
    if not labelled or not app.niche_vectors():
        return
    vecs = {}
    handles = [r["handle"] for r in labelled]
    for i in range(0, len(handles), 40):
        quoted = ",".join('"%s"' % h for h in handles[i:i + 40])
        for row in supabase("/rest/v1/channels?select=handle,embedding&handle=in.(" +
                            urllib.parse.quote(quoted) + ")"):
            v = row["embedding"]
            vecs[row["handle"].lower()] = json.loads(v) if isinstance(v, str) else v

    agree = refused = 0
    confusion = {}
    for r in labelled:
        v = vecs.get(r["handle"].lower())
        got = app.niche_for(v) if v else None
        pred = (got or {}).get("niche")
        if pred is None:
            refused += 1
        elif pred == r["niche"]:
            agree += 1
        else:
            key = (r["niche"], pred)
            confusion[key] = confusion.get(key, 0) + 1

    n = len(labelled)
    print("\ncurrent classifier vs Claude, on %d channels Claude labelled:" % n)
    print("  agree %d (%.0f%%), disagree %d, current classifier refused %d"
          % (agree, 100.0 * agree / n, n - agree - refused, refused))
    print("  most common disagreements (Claude -> current classifier):")
    for (want, pred), k in sorted(confusion.items(), key=lambda kv: -kv[1])[:12]:
        print("    %3dx  %-32s -> %s" % (k, want[:32], pred))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("submit")
    s.add_argument("--n", type=int, default=500)
    s.add_argument("--seed", type=int, default=3)
    s.add_argument("--dry-run", action="store_true")
    s.add_argument("--force", action="store_true")
    s.set_defaults(func=cmd_submit)
    sub.add_parser("status").set_defaults(func=cmd_status)
    sub.add_parser("collect").set_defaults(func=cmd_collect)
    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
