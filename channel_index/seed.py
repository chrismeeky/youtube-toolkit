#!/usr/bin/env python3
"""Seed the channel index — discover channels, enrich them, embed them, store them.

Runs on your own machine, deliberately. Two reasons: YouTube blocks datacenter IPs (measured
at 1 of 4 requests succeeding from Render against 4 of 4 residentially), and discovery here
is scraping, which belongs on a residential connection.

The split that makes this affordable:

    discovery    scraped from YouTube search pages, which carry browseId and the @handle
                 together — free, no quota, and the only step YouTube rate-limits
    enrichment   channels.list with up to 50 ids per call, ONE quota unit per call, so
                 10,000 units/day covers far more channels than you will ever seed
    embedding    text-embedding-3-small at 512 dimensions, about $0.02 per million tokens

The expensive API call is search.list at 100 units. It is never used: scraping does discovery
instead, which is why this fits in the free quota.

    python3 seed.py --queries "air crash investigation,aviation accident documentary"
    python3 seed.py --channels @carwow,@TopGear --cadence
    python3 seed.py --queries "true crime documentary" --limit 40 --dry-run
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
YT_API = "https://www.googleapis.com/youtube/v3"
OPENAI_EMBED = "https://api.openai.com/v1/embeddings"
EMBED_MODEL = "text-embedding-3-small"
EMBED_DIMS = 512          # must match vector(512) in the migration
SCRAPE_GAP = 1.5          # seconds between scrapes; the rate limiter is the real constraint


# ─── plumbing ────────────────────────────────────────────────────────────────

def load_env(path):
    """Read KEY=value from a .env without requiring python-dotenv."""
    if not path or not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def http(url, data=None, headers=None, method=None, timeout=60):
    body = json.dumps(data).encode() if data is not None else None
    hdrs = {"User-Agent": UA, "Accept-Language": "en"}
    if body:
        hdrs["Content-Type"] = "application/json"
    hdrs.update(headers or {})
    req = urllib.request.Request(url, data=body, headers=hdrs, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as res:
        raw = res.read()
    return raw.decode("utf-8", "replace")


def http_json(url, **kw):
    return json.loads(http(url, **kw))


# ─── discovery ───────────────────────────────────────────────────────────────

def discover(query):
    """Channels appearing in a YouTube search, as (channel_id, handle) pairs.

    The results page pairs browseId with canonicalBaseUrl, so one scrape yields both the id
    the API needs and the handle the extension shows — no per-channel page fetch.
    """
    url = "https://www.youtube.com/results?hl=en&search_query=" + urllib.parse.quote(query)
    html = http(url)
    pairs = re.findall(r'"browseId":"(UC[\w-]{20,24})","canonicalBaseUrl":"/(@[\w.-]+)"', html)
    seen, out = set(), []
    for cid, handle in pairs:
        if cid in seen:
            continue
        seen.add(cid)
        out.append((cid, handle))
    return out


def pending_sightings(url, service_key, limit):
    """Channels users have looked at that nobody has indexed yet.

    This is the flywheel. The service records a sighting whenever the extension asks about a
    channel, so the queue fills with the channels people actually research rather than the
    ones I thought to seed. Draining it grows the corpus along real demand — and the channels
    someone looked at are, by definition, in a niche someone cares about.

    Ordered by how often a channel has been seen: something twenty people opened is worth
    indexing before something one person glanced at.
    """
    query = (url.rstrip("/") + "/rest/v1/channel_sightings"
             "?select=id,handle,seen_count&fetched=is.false"
             "&order=seen_count.desc,last_seen.desc&limit=" + str(limit))
    req = urllib.request.Request(query, headers={
        "apikey": service_key, "Authorization": "Bearer " + service_key})
    with urllib.request.urlopen(req, timeout=30) as res:
        rows = json.loads(res.read().decode("utf-8", "replace"))
    return [(r["id"], r.get("handle") or "") for r in rows]


def mark_fetched(ids, url, service_key):
    """Clear the queue for what was just indexed, so the next drain moves on."""
    if not ids:
        return
    quoted = ",".join('"' + i + '"' for i in ids)
    endpoint = (url.rstrip("/") + "/rest/v1/channel_sightings?id=in.(" + quoted + ")")
    body = json.dumps({"fetched": True}).encode()
    req = urllib.request.Request(endpoint, data=body, method="PATCH", headers={
        "apikey": service_key, "Authorization": "Bearer " + service_key,
        "Content-Type": "application/json", "Prefer": "return=minimal"})
    urllib.request.urlopen(req, timeout=30).close()


JUNK_CLAUSE = re.compile(
    r"business inquir|contact|sponsor|collab|patreon|instagram|twitter|tiktok|discord|merch|"
    r"subscribe|@|https?:|www\.|\.com|\.net|\.org", re.I)
# Openings that describe a company rather than a subject.
BOILERPLATE = re.compile(r"^(welcome|this is|we are|i am|the official|official)\b|"
                         r"\bis (the|a|an) (leading|official|home|best|number)\b", re.I)
# A clause opening with one of these is a sentence about the channel, not a subject: "At ZOZA
# & Friends", "every story sparks joy", "Our channel is a safe". The subjects come later —
# "bedtime stories", "African folktales" — and those are what find neighbours.
FILLER_START = re.compile(r"^(at|our|we|you|your|it|this|that|these|those|every|all|and|but|"
                          r"or|so|then|here|there|i|my|from|with|for)\b", re.I)


def expand_from(channel):
    """A search query describing a channel, so its neighbours can be discovered.

    Indexing the channels people look at is not enough on its own. A viewed channel arrives
    alone, and a corpus of lone channels has nothing to compare against — Law&Crime was
    indexed from the queue and still matched nothing, because the index held no other true
    crime channel. Expanding turns each sighting into its niche.

    Descriptions are written in clauses and their punctuation marks them out, so an intact
    short clause is used rather than the opening sentence. Taking the opening produced
    "Law&Crime Network Law & Crime is the leading", which describes the company; the third
    clause of the same sentence is "high-profile criminal trials", which describes the work.
    """
    snip = channel.get("snippet") or {}
    title = (snip.get("title") or "").strip()
    desc = (snip.get("description") or "").strip()

    title_words = {w.lower() for w in re.sub(r"[^\w\s]", " ", title).split()}

    def usable(clause):
        if not clause or JUNK_CLAUSE.search(clause) or BOILERPLATE.search(clause):
            return False
        if FILLER_START.match(clause):
            return False
        words = [w.lower() for w in re.sub(r"[^\w\s]", " ", clause).split()]
        if not words:
            return False
        # Mostly the channel's own name: searching it finds the channel, not its niche.
        owned = sum(1 for w in words if w in title_words)
        return owned * 2 <= len(words)

    for clause in re.split(r"[,.;:|\n]+", desc):
        clause = clause.strip()
        if not usable(clause):
            continue
        words = clause.split()
        if 2 <= len(words) <= 6:
            return re.sub(r"\s+", " ", clause)[:80]

    # No clause of a usable length: take the opening of the best one there is. A single long
    # sentence with no commas is common, and its first words still name the subject.
    for clause in re.split(r"[,.;:|\n]+", desc):
        clause = clause.strip()
        if not usable(clause):
            continue
        words = clause.split()
        if len(words) > 6:
            return re.sub(r"\s+", " ", " ".join(words[:5]))[:80]

    # Nothing usable in the description: the name often states the niche outright.
    words = re.sub(r"[^\w\s]", " ", title).split()
    return " ".join(words[:4]) if len(words) >= 2 else ""


def resolve_handles(handles, api_key, quota):
    """@handle -> channel id. One unit each, so only used for explicitly named channels."""
    out = []
    for handle in handles:
        url = (f"{YT_API}/channels?part=id&forHandle={urllib.parse.quote(handle)}"
               f"&key={api_key}")
        try:
            data = http_json(url)
        except urllib.error.HTTPError as e:
            print(f"  ! {handle}: {e.code}", file=sys.stderr)
            continue
        quota["units"] += 1
        items = data.get("items") or []
        if items:
            out.append((items[0]["id"], handle))
    return out


# ─── enrichment ──────────────────────────────────────────────────────────────

def fetch_channels(ids, api_key, quota):
    """Up to 50 channels per call, one quota unit — the reason this is affordable."""
    out = {}
    for i in range(0, len(ids), 50):
        batch = ids[i:i + 50]
        url = (f"{YT_API}/channels?part=snippet,statistics,contentDetails"
               f"&id={','.join(batch)}&maxResults=50&key={api_key}")
        data = http_json(url)
        quota["units"] += 1
        for item in data.get("items") or []:
            out[item["id"]] = item
    return out


def fetch_uploads(playlist_id, api_key, quota, want=15):
    """Recent uploads, for cadence and for the video titles that go into the embedding.

    Worth the unit: a channel whose description is a business email — measured on Air Crash
    Investigation — has nothing else that says what it is about.
    """
    url = (f"{YT_API}/playlistItems?part=snippet&playlistId={playlist_id}"
           f"&maxResults={want}&key={api_key}")
    try:
        data = http_json(url)
    except urllib.error.HTTPError:
        return [], None
    quota["units"] += 1
    titles, newest, oldest = [], None, None
    for item in data.get("items") or []:
        snip = item.get("snippet") or {}
        title = (snip.get("title") or "").strip()
        if title and title.lower() not in ("private video", "deleted video"):
            titles.append(title)
        stamp = snip.get("publishedAt")
        if stamp:
            if newest is None or stamp > newest:
                newest = stamp
            if oldest is None or stamp < oldest:
                oldest = stamp
    return titles, newest, oldest


def uploads_per_month(count, oldest, newest):
    """Uploads per month across the sampled window.

    Derived from the sample's own span rather than the channel's lifetime: a channel that
    posted daily for a year and then stopped is not uploading thirty times a month now, and
    the recent window is what the question is about.
    """
    if not oldest or not newest or count < 2:
        return None
    from datetime import datetime
    fmt = "%Y-%m-%dT%H:%M:%SZ"
    try:
        a = datetime.strptime(oldest, fmt)
        b = datetime.strptime(newest, fmt)
    except ValueError:
        return None
    months = max((b - a).days / 30.0, 0.25)
    return round(count / months, 2)


# ─── embedding ───────────────────────────────────────────────────────────────

def embed_text(channel, video_titles):
    """What actually gets embedded.

    Title, description and recent video titles together. Descriptions alone are unreliable —
    plenty are a contact address — and titles alone chase whatever story the channel covered
    this week. Together they describe the channel.
    """
    snip = channel.get("snippet") or {}
    parts = [snip.get("title") or ""]
    desc = (snip.get("description") or "").strip()
    if desc:
        parts.append(desc[:800])
    if video_titles:
        parts.append(" · ".join(video_titles[:10]))
    return "\n".join(p for p in parts if p)[:2000]


def embed_batch(texts, api_key):
    data = {"model": EMBED_MODEL, "input": texts, "dimensions": EMBED_DIMS}
    res = http_json(OPENAI_EMBED, data=data,
                    headers={"Authorization": "Bearer " + api_key})
    return [row["embedding"] for row in sorted(res["data"], key=lambda r: r["index"])]


# ─── storage ─────────────────────────────────────────────────────────────────

def upsert(rows, url, service_key):
    endpoint = url.rstrip("/") + "/rest/v1/channels?on_conflict=id"
    http(endpoint, data=rows, method="POST", headers={
        "apikey": service_key,
        "Authorization": "Bearer " + service_key,
        "Prefer": "resolution=merge-duplicates,return=minimal",
    })


def to_row(cid, channel, video_titles, newest, oldest, vector):
    snip = channel.get("snippet") or {}
    stats = channel.get("statistics") or {}
    views = int(stats.get("viewCount") or 0)
    count = int(stats.get("videoCount") or 0)
    handle = (snip.get("customUrl") or "").strip()
    if handle and not handle.startswith("@"):
        handle = "@" + handle
    thumbs = snip.get("thumbnails") or {}
    # medium is 240px — large enough for a list avatar, small enough not to bloat the row.
    avatar = ((thumbs.get("medium") or thumbs.get("default") or {}).get("url")) or None
    return {
        "id": cid,
        "handle": handle or None,
        "avatar_url": avatar,
        "title": snip.get("title") or cid,
        "description": (snip.get("description") or "")[:2000] or None,
        "subscribers": int(stats.get("subscriberCount") or 0) or None,
        "total_views": views or None,
        "video_count": count or None,
        "country": snip.get("country"),
        "published_at": snip.get("publishedAt"),
        "avg_views": (views // count) if count else None,
        "last_upload_at": newest,
        "uploads_per_mo": uploads_per_month(len(video_titles), oldest, newest),
        "embedding": vector,
        "embed_source": embed_text(channel, video_titles)[:500],
    }


# ─── main ────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Seed the channel index.")
    ap.add_argument("--queries", help="comma-separated search queries to discover from")
    ap.add_argument("--channels", help="comma-separated @handles to seed directly")
    ap.add_argument("--drain", action="store_true",
                    help="index the channels users have actually looked at, most-seen first")
    ap.add_argument("--expand", action="store_true",
                    help="after indexing a channel, discover and index its neighbours too — "
                         "a lone channel has nothing to be similar to")
    ap.add_argument("--limit", type=int, default=100, help="max channels this run")
    ap.add_argument("--cadence", action="store_true",
                    help="also fetch recent uploads (1 unit/channel) for upload rate and "
                         "richer embeddings — recommended")
    ap.add_argument("--dry-run", action="store_true", help="discover and report, store nothing")
    ap.add_argument("--env", default=os.path.expanduser("~/Desktop/youtube automation/.env"))
    args = ap.parse_args()

    load_env(args.env)
    yt_key = os.environ.get("NEXT_PUBLIC_YOUTUBE_API_KEY") or os.environ.get("YOUTUBE_API_KEY")
    openai_key = os.environ.get("OPENAI_API_KEY")
    sb_url = os.environ.get("SUPABASE_URL")
    sb_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

    # Only demand what this particular run will actually use. A dry run that discovers from
    # search queries needs no key at all — that step is a scrape.
    needed = []
    if args.channels:
        needed.append(("YouTube API key", yt_key))
    if not args.dry_run:
        needed += [("YouTube API key", yt_key), ("OPENAI_API_KEY", openai_key),
                   ("SUPABASE_URL", sb_url), ("SUPABASE_SERVICE_ROLE_KEY", sb_key)]
    missing = sorted({n for n, v in needed if not v})
    if missing:
        print("Missing: " + ", ".join(missing), file=sys.stderr)
        print(f"Looked in {args.env} and the environment.", file=sys.stderr)
        return 1

    quota = {"units": 0}
    found = []

    if args.queries:
        for q in [q.strip() for q in args.queries.split(",") if q.strip()]:
            try:
                pairs = discover(q)
            except Exception as e:
                print(f"  ! search {q!r} failed: {e}", file=sys.stderr)
                continue
            print(f"  search {q!r}: {len(pairs)} channels")
            found.extend(pairs)
            time.sleep(SCRAPE_GAP)

    if args.channels:
        handles = [h.strip() for h in args.channels.split(",") if h.strip()]
        found.extend(resolve_handles(handles, yt_key, quota))

    drained = []
    if args.drain:
        if not (sb_url and sb_key):
            print("--drain needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY", file=sys.stderr)
            return 1
        drained = pending_sightings(sb_url, sb_key, args.limit)
        print(f"  queue: {len(drained)} channels users looked at but nobody indexed")
        found.extend(drained)

    # De-duplicate, preserving discovery order.
    seen, ids = set(), []
    for cid, _ in found:
        if cid not in seen:
            seen.add(cid)
            ids.append(cid)
    ids = ids[:args.limit]

    if not ids:
        print("Nothing discovered.")
        return 0
    print(f"\n{len(ids)} unique channels")

    if args.dry_run:
        shown = set()
        for cid, handle in found:
            if cid in shown or cid not in ids:
                continue
            shown.add(cid)
            print(f"   {cid}  {handle}")
        print(f"\nDry run — nothing fetched or stored. Would cost about "
              f"{(len(ids) + 49) // 50 + (len(ids) if args.cadence else 0)} quota units.")
        return 0

    channels = fetch_channels(ids, yt_key, quota)
    print(f"fetched {len(channels)} channel records  ({quota['units']} quota units so far)")

    if args.expand:
        extra = []
        for ch in list(channels.values()):
            query = expand_from(ch)
            if not query:
                continue
            try:
                pairs = discover(query)
            except Exception as e:
                print(f"  ! expand {query!r}: {e}", file=sys.stderr)
                continue
            fresh = [cid for cid, _ in pairs if cid not in channels]
            print(f"  expand {query!r}: {len(fresh)} new")
            extra.extend(fresh)
            time.sleep(SCRAPE_GAP)
        extra = [c for c in dict.fromkeys(extra)][:max(0, args.limit - len(channels))]
        if extra:
            channels.update(fetch_channels(extra, yt_key, quota))
            print(f"expanded to {len(channels)} channels  ({quota['units']} units)")

    rows, texts, meta = [], [], []
    for cid, ch in channels.items():
        titles, newest, oldest = [], None, None
        if args.cadence:
            uploads = ((ch.get("contentDetails") or {}).get("relatedPlaylists") or {}).get("uploads")
            if uploads:
                titles, newest, oldest = fetch_uploads(uploads, yt_key, quota)
        texts.append(embed_text(ch, titles))
        meta.append((cid, ch, titles, newest, oldest))

    print(f"embedding {len(texts)} channels ({EMBED_MODEL}, {EMBED_DIMS}d)…")
    vectors = []
    for i in range(0, len(texts), 96):
        vectors.extend(embed_batch(texts[i:i + 96], openai_key))

    for (cid, ch, titles, newest, oldest), vec in zip(meta, vectors):
        rows.append(to_row(cid, ch, titles, newest, oldest, vec))

    upsert(rows, sb_url, sb_key)
    # Only clear what actually made it in, so a channel that failed to fetch is offered again.
    if drained:
        stored = {r["id"] for r in rows}
        mark_fetched([cid for cid, _ in drained if cid in stored], sb_url, sb_key)
    print(f"\nstored {len(rows)} channels")
    print(f"quota used: {quota['units']} units of 10,000/day")
    return 0


if __name__ == "__main__":
    sys.exit(main())
