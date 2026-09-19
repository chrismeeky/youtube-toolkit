#!/usr/bin/env python3
"""Measure the niche classifier against channels a human has labelled.

Why this exists
---------------
Every rule in niche_for() was tuned by looking at one channel at a time: a floor raised
because a cooking channel fell under it, a temperature lowered because UFC came out half
Anime. That is how the obvious errors get fixed and how the quiet ones get introduced,
because nothing in the repo could answer "did that change help overall?". This can.

It does not judge the answers itself. It puts the classifier's prediction next to the
channel's own text, a person decides what the channel actually is, and everything after
that is counting.

Two steps
---------
    python3 niche_eval.py sample --n 150 --out set.csv
        Pulls channels from the index, classifies each one, and writes a worksheet with a
        blank true_niche column. Fill that column in — correcting the prediction where it
        is wrong, copying it where it is right.

    python3 niche_eval.py score --in set.csv
        Reads the filled worksheet and reports accuracy, which labels swallow channels
        that are not theirs, the confusions that happen most, and what the mistakes cost
        in RPM.

    python3 niche_eval.py labels
        The taxonomy, for filling in the worksheet.

Building a set that is worth having
-----------------------------------
A uniform sample of 8,500 channels is mostly easy cases, and an accuracy figure built from
it moves by a fraction of a point however badly the hard families do. Sample the families
that are actually confusable, as several passes into the same file:

    python3 niche_eval.py sample --n 40 --match bodycam --out bodycam.csv
    python3 niche_eval.py sample --n 40 --match "police" --out police.csv
    python3 niche_eval.py sample --n 60 --out general.csv

Cost: the 101 niche descriptions are embedded once per run (a fraction of a cent). Channel
vectors are read from the index, never recomputed, so scoring the same set again is free.
"""

import argparse
import csv
import json
import os
import random
import re
import sys
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.join(os.path.dirname(HERE), "transcript_service")
ENV_FILE = os.environ.get("ENV_FILE",
                          os.path.expanduser("~/Desktop/youtube automation/.env"))


def load_env(path):
    """The service reads its configuration at import time, so this has to run first.

    Only the three keys the classifier needs are taken. The file holds a dozen others for
    unrelated projects and this process has no business holding them.
    """
    wanted = ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OPENAI_API_KEY")
    if not os.path.exists(path):
        sys.exit("No .env at %s — set ENV_FILE=/path/to/.env" % path)
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            if k in wanted and not os.environ.get(k):
                os.environ[k] = v.strip()
    missing = [k for k in wanted if not os.environ.get(k)]
    if missing:
        sys.exit("Missing in %s: %s" % (path, ", ".join(missing)))


load_env(ENV_FILE)
sys.path.insert(0, SERVICE)
import app  # noqa: E402  — after load_env, deliberately: app reads env at import


RPM_BY_NICHE = {name: rpm for name, rpm, _ in app.NICHES}
NICHE_NAMES = set(RPM_BY_NICHE)


def supabase(query):
    url = app.SUPABASE_URL.rstrip("/") + query
    req = urllib.request.Request(url, headers={
        "apikey": app.SUPABASE_KEY,
        "Authorization": "Bearer " + app.SUPABASE_KEY})
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read().decode("utf-8", "replace"))


def fetch_candidates(limit, match, min_subs):
    """Channels that can be classified at all: the ones carrying a stored vector.

    embed_source comes back too. It is the text the vector was actually built from, which
    is what a person needs in order to say what the channel is — the description on the
    page today may not be the description that was embedded.
    """
    q = ("/rest/v1/channels?select=handle,title,subscribers,embed_source,embed_basis"
         "&embedding=not.is.null&handle=not.is.null"
         "&order=subscribers.desc.nullslast&limit=" + str(int(limit)))
    if min_subs:
        q += "&subscribers=gte." + str(int(min_subs))
    if match:
        q += "&embed_source=ilike." + urllib.parse.quote("*" + match + "*")
    return supabase(q)


def fetch_vectors(handles):
    """Stored vectors for named channels, in batches PostgREST will accept in a URL."""
    out = {}
    for i in range(0, len(handles), 40):
        chunk = [h for h in handles[i:i + 40] if h]
        if not chunk:
            continue
        quoted = ",".join('"%s"' % h.replace('"', "") for h in chunk)
        rows = supabase("/rest/v1/channels?select=handle,embedding&handle=in.(" +
                        urllib.parse.quote(quoted) + ")")
        for r in rows:
            vec = r.get("embedding")
            if isinstance(vec, str):
                try:
                    vec = json.loads(vec)
                except ValueError:
                    vec = None
            if isinstance(vec, list):
                out[(r.get("handle") or "").lower()] = vec
    return out


def classify(vector):
    """niche_for as the service calls it, with its refusal preserved rather than smoothed.

    A refusal is a real outcome — the classifier declining to guess — and counting it as a
    wrong answer would hide the case this whole exercise is about.
    """
    got = app.niche_for(vector)
    if not got:
        return {"niche": None, "also": [], "confidence": 0.0, "z": 0.0, "rpm": None}
    return {
        "niche": got.get("niche"),
        "also": got.get("also") or [],
        "confidence": got.get("confidence"),
        "z": got.get("z"),
        "rpm": got.get("rpm"),
    }


def tidy(text, width):
    """One line, because a worksheet is read in a spreadsheet cell."""
    return re.sub(r"\s+", " ", (text or "")).strip()[:width]


def cmd_sample(args):
    pool = fetch_candidates(args.pool, args.match, args.min_subs)
    if not pool:
        sys.exit("No channels matched. Try a smaller --min-subs or a different --match.")

    # Deterministic: the same seed picks the same channels, so a worksheet can be rebuilt
    # after an interruption without relabelling different rows.
    rng = random.Random(args.seed)
    picked = pool if len(pool) <= args.n else rng.sample(pool, args.n)
    picked.sort(key=lambda r: -(r.get("subscribers") or 0))

    vectors = fetch_vectors([r.get("handle") for r in picked])
    if not app.niche_vectors():
        sys.exit("Could not embed the niche list — check OPENAI_API_KEY.")

    rows = []
    for r in picked:
        handle = (r.get("handle") or "").lower()
        vec = vectors.get(handle)
        if not vec:
            continue
        got = classify(vec)
        rows.append({
            "handle": r.get("handle"),
            "title": tidy(r.get("title"), 80),
            "subscribers": r.get("subscribers") or "",
            "predicted": got["niche"] or "(none)",
            "runner_up": (got["also"] or [""])[0],
            "confidence": got["confidence"],
            "z": got["z"],
            "rpm": got["rpm"] if got["rpm"] is not None else "",
            "embed_basis": r.get("embed_basis") or "",
            "evidence": tidy(r.get("embed_source"), 400),
            "true_niche": "",
            "notes": "",
        })

    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

    print("wrote %d rows to %s" % (len(rows), args.out))
    print()
    print("Fill in true_niche for each row: correct the prediction where it is wrong, copy")
    print("it where it is right. Leave a row blank to exclude it (an unclear channel is")
    print("better left out than guessed at). `niche_eval.py labels` lists the valid names,")
    print("and 'none' is a valid answer for a channel no label fits.")


def cmd_score(args):
    with open(args.infile, newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))

    labelled, unknown, blank = [], [], 0
    for r in rows:
        want = (r.get("true_niche") or "").strip()
        if not want:
            blank += 1
            continue
        if want.lower() != "none" and want not in NICHE_NAMES:
            unknown.append((r.get("handle"), want))
            continue
        labelled.append(r)

    if unknown:
        print("Not names in the taxonomy — fix these spellings, they are not being counted:")
        for handle, want in unknown[:15]:
            print("  %-28s %s" % (handle, want))
        print()
    if not labelled:
        sys.exit("Nothing labelled yet. Fill in the true_niche column first.")

    vectors = fetch_vectors([r.get("handle") for r in labelled])
    if not app.niche_vectors():
        sys.exit("Could not embed the niche list — check OPENAI_API_KEY.")

    total = hit1 = hit2 = refused = missing = 0
    rpm_error = []
    confusion = {}
    predicted_count, true_count, correct_by_label = {}, {}, {}

    for r in labelled:
        vec = vectors.get((r.get("handle") or "").lower())
        if not vec:
            missing += 1
            continue
        want = r["true_niche"].strip()
        got = classify(vec)
        pred = got["niche"]
        total += 1

        true_count[want] = true_count.get(want, 0) + 1
        predicted_count[pred or "(none)"] = predicted_count.get(pred or "(none)", 0) + 1

        if pred is None:
            refused += 1
        if want.lower() == "none":
            # The right answer is a refusal, so a refusal is the hit.
            if pred is None:
                hit1 += 1
                hit2 += 1
                correct_by_label[want] = correct_by_label.get(want, 0) + 1
            else:
                confusion[("none", pred)] = confusion.get(("none", pred), 0) + 1
            continue

        if pred == want:
            hit1 += 1
            hit2 += 1
            correct_by_label[want] = correct_by_label.get(want, 0) + 1
        else:
            if want in (got["also"] or []):
                hit2 += 1
            confusion[(want, pred or "(none)")] = confusion.get((want, pred or "(none)"), 0) + 1
            # What the mistake costs where the user actually sees it: the earnings estimate.
            if pred in RPM_BY_NICHE and want in RPM_BY_NICHE:
                rpm_error.append(abs(RPM_BY_NICHE[pred] - RPM_BY_NICHE[want]))

    out = []
    out.append("scored %d channels  (%d unlabelled, %d unknown label, %d without a stored vector)"
               % (total, blank, len(unknown), missing))
    out.append("")
    out.append("top-1 accuracy   %5.1f%%   (%d/%d)" % (100.0 * hit1 / total, hit1, total))
    out.append("top-2 accuracy   %5.1f%%   (the truth was the prediction or its runner-up)"
               % (100.0 * hit2 / total))
    out.append("refused          %5.1f%%   (classifier declined to name a niche)"
               % (100.0 * refused / total))
    if rpm_error:
        out.append("mean RPM error   $%.2f   across the %d misses that had one"
                   % (sum(rpm_error) / len(rpm_error), len(rpm_error)))
    out.append("")

    # Which labels take more than they are owed. This is the number that exposes a taxonomy
    # gap: a label with no channels of its own but plenty predicted is absorbing a family
    # that has nowhere else to go.
    out.append("LABELS THAT OVER-ATTRACT   (predicted more often than they are true)")
    out.append("  %-34s %8s %8s %9s" % ("label", "predicted", "true", "correct"))
    rows_att = []
    for label, pcount in predicted_count.items():
        tcount = true_count.get(label, 0)
        if pcount > tcount:
            rows_att.append((pcount - tcount, label, pcount, tcount,
                             correct_by_label.get(label, 0)))
    for _, label, pcount, tcount, corr in sorted(rows_att, reverse=True)[:12]:
        out.append("  %-34s %8d %8d %9d" % (label[:34], pcount, tcount, corr))
    if not rows_att:
        out.append("  (none)")
    out.append("")

    out.append("MOST COMMON CONFUSIONS   (true -> predicted)")
    for (want, pred), n in sorted(confusion.items(), key=lambda kv: -kv[1])[:15]:
        out.append("  %3dx  %-30s -> %s" % (n, want[:30], pred))
    if not confusion:
        out.append("  (none)")

    report = "\n".join(out)
    print(report)
    if args.report:
        with open(args.report, "w", encoding="utf-8") as fh:
            fh.write(report + "\n")
        print("\nwritten to %s" % args.report)


def cmd_labels(_args):
    for name, rpm, desc in app.NICHES:
        print("%-34s $%-6.1f %s" % (name, rpm, desc))
    print("\n%d labels. 'none' is also a valid answer in the worksheet." % len(app.NICHES))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("sample", help="write a worksheet to label")
    s.add_argument("--n", type=int, default=100, help="channels in the worksheet")
    s.add_argument("--pool", type=int, default=1500,
                   help="rows to draw from before sampling")
    s.add_argument("--match", default="",
                   help="only channels whose embedded text contains this, e.g. bodycam")
    s.add_argument("--min-subs", type=int, default=1000)
    s.add_argument("--seed", type=int, default=7)
    s.add_argument("--out", default="niche_set.csv")
    s.set_defaults(func=cmd_sample)

    c = sub.add_parser("score", help="report accuracy over a filled worksheet")
    c.add_argument("--in", dest="infile", default="niche_set.csv")
    c.add_argument("--report", default="", help="also write the report here")
    c.set_defaults(func=cmd_score)

    l = sub.add_parser("labels", help="print the taxonomy")
    l.set_defaults(func=cmd_labels)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
