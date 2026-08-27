#!/usr/bin/env python3
"""Transcript service for the YouTube Toolkit extension — runs locally or hosted.

Same job as before: hand yt-dlp a video id, get back timestamped segments. What changed is
that it can now run on a public host, which brings three problems the localhost-only version
never had to answer.

  Abuse    A public yt-dlp endpoint is a free downloader for anyone who finds it, so a token
           is required whenever ACCESS_TOKEN is set.
  Blocking YouTube refuses caption requests from datacenter IPs far more often than from a
           home connection. YTDLP_COOKIES_B64 and YTDLP_PROXY exist for that.
  Cost     Free tiers are small. Results are cached, concurrent yt-dlp runs are capped, and
           per-IP rate limiting keeps one caller from eating the whole instance.

Config is all environment variables (see README.md). Serves:

    GET <prefix>/transcript?v=VIDEO_ID -> {"ok": true, "segments": [{"time","text"}, ...]}
    GET <prefix>/health                -> {"ok": true, "ytdlp": "...", "cookies": bool}

where <prefix> is "" locally, or "/k/<ACCESS_TOKEN>" when a token is configured.
"""

# This file sits inside the folder Chrome loads as an unpacked extension, and Chrome rejects
# any directory whose name begins with "_" — a stray __pycache__ makes the whole extension
# fail with "Could not load manifest", after which the profile silently keeps running the
# build it loaded last. Set before any local import can generate one.
import sys
sys.dont_write_bytecode = True

import base64
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from collections import OrderedDict, defaultdict, deque
from hmac import compare_digest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, quote


def _int(name, default):
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


# Hosts differ on how they name the port: Spaces defaults to 7860, Render and Koyeb inject
# $PORT, and the old local helper used YTC_HELPER_PORT. Accept all three.
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = _int("PORT", _int("YTC_HELPER_PORT", 7860))

ACCESS_TOKEN = os.environ.get("ACCESS_TOKEN", "").strip()
PROXY = os.environ.get("YTDLP_PROXY", "").strip()
# yt-dlp's own defaults track YouTube's changes, so pass nothing unless asked. See the
# README for the client overrides worth trying when a host starts getting blocked.
EXTRACTOR_ARGS = os.environ.get("YTDLP_EXTRACTOR_ARGS", "").strip()
SUB_LANGS = os.environ.get("YTDLP_SUB_LANGS", "en.*,en").strip()

MAX_CONCURRENCY = _int("MAX_CONCURRENCY", 2)

# ─── channel index ───────────────────────────────────────────────────────────

# Backs "Similar channels". The extension cannot query this itself: doing so would need the
# Supabase service key and an OpenAI key in an extension anyone can unpack.
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
OPENAI_KEY = os.environ.get("OPENAI_API_KEY", "")
EMBED_MODEL = "text-embedding-3-small"
EMBED_DIMS = 512                  # must match vector(512) in migration 0003
INDEX_READY = bool(SUPABASE_URL and SUPABASE_KEY)


def _post_json(url, payload, headers, timeout=30):
    body = json.dumps(payload).encode()
    hdrs = {"Content-Type": "application/json"}
    hdrs.update(headers)
    req = urllib.request.Request(url, data=body, headers=hdrs, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as res:
        raw = res.read()
    return json.loads(raw.decode("utf-8", "replace")) if raw else None


def _supabase(path, payload, timeout=30, prefer=None):
    headers = {"apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY}
    if prefer:
        headers["Prefer"] = prefer
    return _post_json(SUPABASE_URL + path, payload, headers, timeout)


def embed(text):
    """One embedding, for the channel being asked about.

    The query channel is usually already indexed, in which case its stored vector is used and
    this is never called. It matters for a channel nobody has crawled yet: the extension sends
    the text it can already see on the page, so an unknown channel still gets an answer.
    """
    if not OPENAI_KEY:
        return None
    data = {"model": EMBED_MODEL, "input": text[:2000], "dimensions": EMBED_DIMS}
    out = _post_json("https://api.openai.com/v1/embeddings", data,
                     {"Authorization": "Bearer " + OPENAI_KEY}, timeout=30)
    rows = (out or {}).get("data") or []
    return rows[0]["embedding"] if rows else None


def indexed_channel(handle):
    """Look up a channel by handle. Case-insensitively — the YouTube API returns customUrl
    lowercased, so what is stored rarely matches what appears in the address bar."""
    query = ("/rest/v1/channels?select=id,handle,title,embedding"
             "&handle=ilike." + urllib.parse.quote(handle) + "&limit=1")
    req = urllib.request.Request(
        SUPABASE_URL + query,
        headers={"apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY})
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            rows = json.loads(res.read().decode("utf-8", "replace"))
    except Exception:
        return None
    return rows[0] if rows else None


def similar_channels(handle, text, limit, min_subs, max_subs, min_similarity, channel_id=None):
    """Nearest channels by topic, with the source channel excluded.

    Ranking happens in Postgres via the match_channels RPC rather than here, so the rule
    lives in one place and the vector never crosses the network twice.
    """
    known = indexed_channel(handle) if handle else None
    vector = None
    # Exclusion must not hang on the lookup succeeding. When it comes back empty — the row was
    # written moments ago by ingest, or the lookup itself failed and was swallowed — the source
    # channel used to be free to rank against itself, which is how Eagle FC appeared in its own
    # list at 84%: page text embedded on one side, stored description on the other.
    exclude = None
    if known:
        exclude = known.get("id")
    elif channel_id:
        exclude = channel_id
        raw = known.get("embedding")
        # PostgREST returns a vector as its text form, "[0.1,0.2,...]".
        if isinstance(raw, str):
            try:
                vector = json.loads(raw)
            except ValueError:
                vector = None
        elif isinstance(raw, list):
            vector = raw
    if vector is None:
        if not text:
            return {"ok": False, "reason": "channel not indexed yet and no text supplied"}
        vector = embed(text)
    if vector is None:
        return {"ok": False, "reason": "could not embed this channel"}

    rows = _supabase("/rest/v1/rpc/match_channels", {
        "query_embedding": vector,
        "match_count": limit,
        "exclude_id": exclude,
        "min_subscribers": min_subs,
        "max_subscribers": max_subs,
        "min_similarity": min_similarity,
    }, timeout=30)
    # Last line of defence: the id may be absent or stale, but the handle came from the URL.
    want = (handle or "").lstrip("@").lower()
    out = [r for r in (rows or [])
           if (r.get("handle") or "").lstrip("@").lower() != want]
    return {"ok": True, "indexed": bool(known), "channels": out}


def _clamp(query, name, default, low, high):
    try:
        return max(low, min(high, int((query.get(name) or [default])[0])))
    except (TypeError, ValueError):
        return default


def _clamp_float(query, name, default, low, high):
    try:
        return max(low, min(high, float((query.get(name) or [default])[0])))
    except (TypeError, ValueError):
        return default


def _opt_int(query, name):
    raw = (query.get(name) or [""])[0]
    try:
        return int(raw) if raw else None
    except ValueError:
        return None


YT_API = "https://www.googleapis.com/youtube/v3"
YT_KEY = os.environ.get("YOUTUBE_API_KEY") or os.environ.get("NEXT_PUBLIC_YOUTUBE_API_KEY", "")
# Below this, a channel is not a competitor anybody is looking for, and indexing it only
# crowds the results. The 11-subscriber channel that reached the index during seeding is
# exactly what this keeps out.
MIN_INDEX_SUBS = 100
# Below this a match is noise. It was 0.55, which withheld everything for a channel whose
# best neighbour scored 50% — the panel then read as though nothing had been indexed at all,
# when the truth was "indexed, but not close". A scored 50% match the reader can judge beats
# silence they cannot.
DEFAULT_FLOOR = 0.45
INGEST_READY = bool(INDEX_READY and OPENAI_KEY and YT_KEY)


def _get_json(url, timeout=30):
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode("utf-8", "replace"))


def resolve_handles(handles):
    """Handle -> channel id, one quota unit each.

    Ingest keys off channel ids, so a payload carrying only a handle used to be dropped in
    silence. That is affordable here because it runs for the handful of channels a person
    actually visits, not for bulk discovery, which always arrives with ids attached.
    """
    out = {}
    for h in handles[:5]:
        handle = h if h.startswith("@") else "@" + h
        url = ("%s/channels?part=id&forHandle=%s&key=%s"
               % (YT_API, quote(handle), YT_KEY))
        try:
            data = _get_json(url)
        except Exception:
            continue
        items = data.get("items") or []
        if items:
            out[handle] = items[0]["id"]
    return out


def fetch_channel_records(ids):
    """Up to 50 channels for a single quota unit — the reason ingesting from user activity
    is affordable rather than something that needs rationing."""
    out = {}
    for i in range(0, len(ids), 50):
        batch = [c for c in ids[i:i + 50] if re.match(r"^UC[\w-]{20,24}$", c or "")]
        if not batch:
            continue
        url = ("%s/channels?part=snippet,statistics&id=%s&maxResults=50&key=%s"
               % (YT_API, ",".join(batch), YT_KEY))
        try:
            data = _get_json(url)
        except Exception:
            continue
        for item in data.get("items") or []:
            out[item["id"]] = item
    return out


def embed_many(texts):
    data = {"model": EMBED_MODEL, "input": texts, "dimensions": EMBED_DIMS}
    out = _post_json("https://api.openai.com/v1/embeddings", data,
                     {"Authorization": "Bearer " + OPENAI_KEY}, timeout=60)
    rows = sorted((out or {}).get("data") or [], key=lambda r: r["index"])
    return [r["embedding"] for r in rows]


def already_indexed(ids):
    if not ids:
        return set()
    quoted = ",".join('"' + i + '"' for i in ids)
    url = SUPABASE_URL + "/rest/v1/channels?select=id&id=in.(" + urllib.parse.quote(quoted) + ")"
    req = urllib.request.Request(url, headers={
        "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY})
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            return {r["id"] for r in json.loads(res.read().decode("utf-8", "replace"))}
    except Exception:
        return set()


def ingest_channels(pairs):
    """Index channels the extension discovered, so a niche fills itself in from use.

    The division of labour is what makes this work: the extension scrapes search from a
    residential connection, because a server doing the same gets the bot interstitial, and
    the server enriches through the API, because that needs keys no extension should carry.
    """
    if not INGEST_READY:
        return {"ok": False, "reason": "ingest not configured"}

    wanted = [p.get("id") for p in pairs if p.get("id")][:50]
    # Anything that arrived with only a handle: look the id up rather than dropping it.
    bare = [p.get("handle") for p in pairs if not p.get("id") and p.get("handle")]
    if bare and len(wanted) < 50:
        wanted += [cid for cid in resolve_handles(bare).values() if cid not in wanted]
    fresh = [c for c in wanted if c not in already_indexed(wanted)]
    if not fresh:
        return {"ok": True, "added": 0, "skipped": len(wanted)}

    records = fetch_channel_records(fresh)
    rows, texts, keep = [], [], []
    for cid, ch in records.items():
        stats = ch.get("statistics") or {}
        subs = int(stats.get("subscriberCount") or 0)
        if subs and subs < MIN_INDEX_SUBS:
            continue
        snip = ch.get("snippet") or {}
        text = "\n".join(x for x in [snip.get("title") or "",
                                     (snip.get("description") or "")[:800]] if x)[:2000]
        if not text.strip():
            continue
        texts.append(text)
        keep.append((cid, ch, text))

    if not texts:
        return {"ok": True, "added": 0, "skipped": len(wanted)}

    vectors = embed_many(texts)
    for (cid, ch, text), vec in zip(keep, vectors):
        snip = ch.get("snippet") or {}
        stats = ch.get("statistics") or {}
        views = int(stats.get("viewCount") or 0)
        count = int(stats.get("videoCount") or 0)
        handle = (snip.get("customUrl") or "").strip()
        if handle and not handle.startswith("@"):
            handle = "@" + handle
        thumbs = snip.get("thumbnails") or {}
        avatar = ((thumbs.get("medium") or thumbs.get("default") or {}).get("url")) or None
        rows.append({
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
            "embedding": vec,
            "embed_source": text[:500],
        })

    if rows:
        _supabase("/rest/v1/channels?on_conflict=id", rows, timeout=60,
                  prefer="resolution=merge-duplicates,return=minimal")
    return {"ok": True, "added": len(rows), "skipped": len(wanted) - len(rows)}


def record_sighting(channel_id, handle):
    """A channel someone looked at. The crawler drains this queue later.

    Deliberately fire-and-forget: a failure here must never affect the answer the user asked
    for, and the queue is a convenience for growing the corpus, not part of the request.
    """
    if not (INDEX_READY and channel_id):
        return
    try:
        _supabase("/rest/v1/channel_sightings?on_conflict=id",
                  [{"id": channel_id, "handle": handle or None}],
                  timeout=10, prefer="resolution=merge-duplicates,return=minimal")
    except Exception:
        pass

RATE_LIMIT = _int("RATE_LIMIT", 30)          # requests per IP per window
RATE_WINDOW = _int("RATE_WINDOW", 3600)      # seconds
CACHE_SIZE = _int("CACHE_SIZE", 256)
FETCH_TIMEOUT = _int("FETCH_TIMEOUT", 120)

def _resolve_ytdlp():
    """How to invoke yt-dlp, as an argv prefix.

    The console script is the obvious answer but not a dependable one off Docker: Render's
    native Python runtime installs the package into a virtualenv whose bin directory is not
    always on PATH for the process that ends up running this. Importing the module works
    wherever pip put it, so fall back to that rather than reporting yt-dlp missing when it is
    installed and merely unreachable by name.
    """
    exe = shutil.which("yt-dlp")
    if exe:
        return [exe]
    if importlib.util.find_spec("yt_dlp") is not None:
        return [sys.executable, "-m", "yt_dlp"]
    return None


YTDLP_CMD = _resolve_ytdlp()
YTDLP = YTDLP_CMD is not None          # kept as a boolean for the local entry point's check
VIDEO_ID = re.compile(r"^[\w-]{5,20}$")

_slots = threading.BoundedSemaphore(max(1, MAX_CONCURRENCY))
_cache = OrderedDict()
_cache_lock = threading.Lock()
_hits = defaultdict(deque)
_hits_lock = threading.Lock()


# ------------------------------------------------------------------ cookies

def _cookie_file():
    """Materialise cookies.txt from the environment, if provided.

    Hosts hand secrets over as single-line environment variables, but a Netscape cookie jar
    is inherently multi-line — hence the base64 variant, which is the one that survives every
    dashboard intact. yt-dlp rewrites this file as cookies refresh, so it has to be somewhere
    writable rather than baked into the image.
    """
    raw = os.environ.get("YTDLP_COOKIES_B64", "").strip()
    if raw:
        try:
            text = base64.b64decode(raw).decode("utf-8", "replace")
        except Exception:
            print("[helper] YTDLP_COOKIES_B64 is not valid base64 — ignoring", file=sys.stderr)
            return None
    else:
        text = os.environ.get("YTDLP_COOKIES", "").strip()
        if not text:
            return None
        text = text.replace("\\n", "\n")

    if "# Netscape HTTP Cookie File" not in text:
        text = "# Netscape HTTP Cookie File\n" + text

    path = os.path.join(tempfile.gettempdir(), "yt-cookies.txt")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text if text.endswith("\n") else text + "\n")
    os.chmod(path, 0o600)
    return path


COOKIE_FILE = _cookie_file()


# ------------------------------------------------------------------ parsing

def stamp(ms):
    total = int(ms // 1000)
    h, m, s = total // 3600, (total // 60) % 60, total % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def parse_json3(raw):
    data = json.loads(raw)
    out = []
    for event in data.get("events", []):
        text = "".join(seg.get("utf8", "") for seg in event.get("segs", []))
        text = " ".join(text.split())
        if text:
            out.append({"time": stamp(event.get("tStartMs", 0)), "text": text})
    return out


def parse_vtt(raw):
    """VTT repeats each line as the rolling caption scrolls, so drop consecutive repeats."""
    out = []
    time_re = re.compile(r"^(\d{2}):(\d{2}):(\d{2})\.\d{3}\s+-->")
    current = None
    for line in raw.splitlines():
        match = time_re.match(line.strip())
        if match:
            h, m, s = (int(x) for x in match.groups())
            current = (h * 3600 + m * 60 + s) * 1000
            continue
        text = re.sub(r"<[^>]+>", "", line).strip()
        if not text or text.startswith(("WEBVTT", "Kind:", "Language:")) or current is None:
            continue
        if out and out[-1]["text"] == text:
            continue
        out.append({"time": stamp(current), "text": text})
    return out


# ------------------------------------------------------------------ fetching

def _redact(text):
    """yt-dlp echoes the proxy URL (credentials included) and cookie path into its errors."""
    if PROXY:
        text = text.replace(PROXY, "<proxy>")
    if COOKIE_FILE:
        text = text.replace(COOKIE_FILE, "<cookies>")
    return text


def _ytdlp_command(template, url):
    cmd = YTDLP_CMD + [
        "--skip-download", "--write-subs", "--write-auto-subs",
        "--sub-langs", SUB_LANGS, "--sub-format", "json3/vtt/best",
        "--no-warnings", "--no-progress", "--output", template,
    ]
    if COOKIE_FILE:
        cmd += ["--cookies", COOKIE_FILE]
    if PROXY:
        cmd += ["--proxy", PROXY]
    if EXTRACTOR_ARGS:
        cmd += ["--extractor-args", EXTRACTOR_ARGS]
    cmd.append(url)
    return cmd


def fetch(video_id):
    if not YTDLP:
        return None, "yt-dlp is not installed"

    url = f"https://www.youtube.com/watch?v={video_id}"
    with tempfile.TemporaryDirectory() as tmp:
        template = os.path.join(tmp, "sub")
        try:
            proc = subprocess.run(_ytdlp_command(template, url),
                                  capture_output=True, text=True, timeout=FETCH_TIMEOUT)
        except subprocess.TimeoutExpired:
            return None, "yt-dlp timed out"

        files = sorted(os.listdir(tmp))
        if not files:
            detail = _redact(proc.stderr or proc.stdout or "").strip().splitlines()
            reason = detail[-1] if detail else "no subtitles available for this video"
            # The signature of a datacenter IP being turned away. Say so plainly, because the
            # fix is configuration (cookies or a proxy) rather than anything about the video.
            if "confirm you" in reason.lower() or "not a bot" in reason.lower():
                reason = ("YouTube is blocking this server as a bot — set YTDLP_COOKIES_B64 "
                          "or YTDLP_PROXY (see README)")
            return None, reason

        # Prefer manual captions over auto-generated, json3 over vtt.
        def rank(name):
            return (".json3" not in name, "auto" in name.lower())

        for name in sorted(files, key=rank):
            with open(os.path.join(tmp, name), encoding="utf-8", errors="replace") as handle:
                raw = handle.read()
            try:
                segments = parse_json3(raw) if name.endswith(".json3") else parse_vtt(raw)
            except (ValueError, json.JSONDecodeError):
                continue
            if segments:
                return segments, None

        return None, "subtitles downloaded but could not be parsed"


def fetch_cached(video_id):
    """A video's captions don't change, so a hit here saves an entire yt-dlp run."""
    with _cache_lock:
        if video_id in _cache:
            _cache.move_to_end(video_id)
            return _cache[video_id], None

    if not _slots.acquire(timeout=30):
        return None, "server busy — try again shortly"
    try:
        # Another thread may have populated the entry while this one waited for a slot.
        with _cache_lock:
            if video_id in _cache:
                _cache.move_to_end(video_id)
                return _cache[video_id], None
        segments, error = fetch(video_id)
    finally:
        _slots.release()

    if segments:
        with _cache_lock:
            _cache[video_id] = segments
            while len(_cache) > CACHE_SIZE:
                _cache.popitem(last=False)
    return segments, error


# ------------------------------------------------------------------ throttling

def rate_ok(ip):
    if RATE_LIMIT <= 0:
        return True
    now = time.time()
    with _hits_lock:
        window = _hits[ip]
        while window and now - window[0] > RATE_WINDOW:
            window.popleft()
        if not window and len(_hits) > 4096:
            _hits.clear()  # crude, but keeps a hostile caller from growing this without bound
        if len(window) >= RATE_LIMIT:
            return False
        window.append(now)
        return True


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "ytc-transcript/2.0"

    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Helper-Token")
        # Required, and easy to miss: a POST carrying application/json is preflighted, and
        # Chrome rejects the preflight outright when the allowed methods are not stated. GET
        # is a simple request and works without this, so the omission only breaks POST.
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def client_ip(self):
        forwarded = self.headers.get("X-Forwarded-For", "")
        return forwarded.split(",")[0].strip() or self.client_address[0]

    def authorised(self, path, query):
        """Token may arrive in the path, a header, or a query param.

        The path form is what the extension actually uses: background.js builds requests as
        `helperUrl + '/transcript?v=...'`, so folding the token into the configured base URL
        authenticates every call without the extension knowing a token exists.
        """
        if not ACCESS_TOKEN:
            return True, path
        prefix = "/k/" + ACCESS_TOKEN
        if path == prefix or path.startswith(prefix + "/"):
            return True, path[len(prefix):] or "/"
        supplied = self.headers.get("X-Helper-Token", "") or (query.get("key") or [""])[0]
        if supplied and compare_digest(supplied, ACCESS_TOKEN):
            return True, path
        return False, path

    def do_OPTIONS(self):
        self._send(204, {})

    def do_POST(self):
        """POST carries the channel's own text, for channels not yet in the index.

        The extension is standing on the channel page and can already read its title,
        description and recent video titles. Sending those means an unknown channel still
        gets an answer — the server embeds what it was given rather than trying to fetch the
        channel itself, which from a datacenter IP would mostly be refused anyway.
        """
        route = urlparse(self.path)
        query = parse_qs(route.query)
        ok, path = self.authorised(route.path, query)
        if not ok:
            self._send(404, {"ok": False, "reason": "not found"})
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > 64000:
            self._send(400, {"ok": False, "reason": "bad body"})
            return
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8", "replace"))
        except ValueError:
            self._send(400, {"ok": False, "reason": "bad json"})
            return
        if not isinstance(body, dict):
            self._send(400, {"ok": False, "reason": "bad json"})
            return

        if path == "/similar":
            if not INDEX_READY:
                self._send(200, {"ok": False, "reason": "channel index not configured"})
                return
            handle = str(body.get("channel") or "").strip()
            if handle and not handle.startswith("@"):
                handle = "@" + handle
            if not handle:
                self._send(400, {"ok": False, "reason": "channel required"})
                return

            text = "\n".join(str(x) for x in [
                body.get("title") or "",
                (body.get("about") or "")[:800],
                " · ".join([str(t) for t in (body.get("videoTitles") or [])][:10]),
            ] if x)

            def as_int(name):
                try:
                    v = body.get(name)
                    return int(v) if v not in (None, "") else None
                except (TypeError, ValueError):
                    return None

            limit = as_int("limit") or 25

            # `or` treats 0.0 as absent, so a caller asking for no floor silently got the
            # default one — which made "show me everything" indistinguishable from "show me
            # good matches" while debugging an empty result.
            raw_floor = body.get("minSimilarity")
            try:
                floor = float(raw_floor) if raw_floor is not None else DEFAULT_FLOOR
            except (TypeError, ValueError):
                floor = DEFAULT_FLOOR

            result = similar_channels(
                handle, text, max(1, min(100, limit)),
                as_int("minSubs"), as_int("maxSubs"), max(0.0, min(1.0, floor)),
                channel_id=body.get("channelId") or None)
            # Growing the corpus is a side effect of being asked, never a precondition.
            record_sighting(body.get("channelId"), handle)
            self._send(200, result)
            return

        if path == "/ingest":
            pairs = body.get("channels")
            if not isinstance(pairs, list) or not pairs:
                self._send(400, {"ok": False, "reason": "channels required"})
                return
            clean = [{"id": str(p.get("id") or ""), "handle": str(p.get("handle") or "")}
                     for p in pairs if isinstance(p, dict)][:50]
            self._send(200, ingest_channels(clean))
            return

        self._send(404, {"ok": False, "reason": "unknown route"})

    def do_GET(self):
        route = urlparse(self.path)
        query = parse_qs(route.query)

        # Liveness probe, deliberately outside the token check. A platform health check has
        # no way to hold the token, and with ACCESS_TOKEN set every other path answers 404 —
        # which reads as a failed deploy. This reveals nothing beyond "a server is here".
        if route.path == "/healthz":
            self._send(200, {"ok": True})
            return

        ok, path = self.authorised(route.path, query)
        if not ok:
            # 404 rather than 401: an unauthenticated scanner learns nothing about what is here.
            self._send(404, {"ok": False, "reason": "not found"})
            return

        if path == "/similar":
            if not INDEX_READY:
                self._send(200, {"ok": False, "reason": "channel index not configured"})
                return
            handle = (query.get("channel") or [""])[0].strip()
            if handle and not handle.startswith("@"):
                handle = "@" + handle
            if not handle:
                self._send(400, {"ok": False, "reason": "channel required"})
                return
            self._send(200, similar_channels(
                handle, "",
                _clamp(query, "limit", 25, 1, 100),
                _opt_int(query, "min_subs"),
                _opt_int(query, "max_subs"),
                _clamp_float(query, "min_similarity", DEFAULT_FLOOR, 0.0, 1.0)))
            return

        if path == "/health":
            version = ""
            if YTDLP:
                try:
                    version = subprocess.run(YTDLP_CMD + ["--version"], capture_output=True,
                                             text=True, timeout=30).stdout.strip()
                except Exception:
                    version = "unknown"
            self._send(200, {"ok": bool(YTDLP), "ytdlp": version,
                             "cookies": bool(COOKIE_FILE), "proxy": bool(PROXY)})
            return

        if path == "/":
            self._send(200, {"ok": True, "service": "yt-copy transcript helper"})
            return

        if path != "/transcript":
            self._send(404, {"ok": False, "reason": "unknown route"})
            return

        video_id = (query.get("v") or [""])[0]
        if not VIDEO_ID.match(video_id):
            self._send(400, {"ok": False, "reason": "bad video id"})
            return

        if not rate_ok(self.client_ip()):
            self._send(429, {"ok": False, "reason": "rate limited — try again later"})
            return

        segments, error = fetch_cached(video_id)
        if error:
            self._send(200, {"ok": False, "reason": error})
        else:
            self._send(200, {"ok": True, "segments": segments})

    def log_message(self, fmt, *args):
        sys.stderr.write("[helper] %s\n" % (fmt % args))


class QuietServer(ThreadingHTTPServer):
    """A client hanging up mid-request is normal here, not an error worth a traceback.

    The extension posts discoveries to /ingest fire-and-forget and drops the connection
    immediately, which is deliberate — filling the index must never delay the answer the user
    asked for. The default server treats that as an unhandled exception and prints a full
    stack trace for every one, burying anything that actually matters.
    """

    daemon_threads = True

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


def main():
    """Report what this process can actually do, not what it was originally for.

    The banner used to announce a transcript service and its yt-dlp cookie and proxy
    settings. Transcripts moved into the extension and were deprecated; this is the channel
    index backend now, and the yt-dlp flags say nothing about whether it will work. What
    matters is which keys are present, because a missing one surfaces much later as
    "ingest not configured" with nothing pointing at the cause.
    """
    shown = "/k/<token>" if ACCESS_TOKEN else ""
    print(f"YouTube Toolkit service on http://{HOST}:{PORT}{shown}")
    print(f"  similar   {'ready' if INDEX_READY else 'OFF — needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY'}")
    print(f"  embedding {'ready' if OPENAI_KEY else 'OFF — needs OPENAI_API_KEY (unindexed channels cannot be matched)'}")
    print(f"  ingest    {'ready' if INGEST_READY else 'OFF — needs YOUTUBE_API_KEY (the index will not fill itself)'}")
    if YTDLP:
        print(f"  transcripts (deprecated) available"
              f"  cookies={'yes' if COOKIE_FILE else 'no'} proxy={'yes' if PROXY else 'no'}")
    QuietServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
