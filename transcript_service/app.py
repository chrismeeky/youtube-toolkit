#!/usr/bin/env python3
"""Transcript service for the YT Copy extension — runs locally or hosted.

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

import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from collections import OrderedDict, defaultdict, deque
from hmac import compare_digest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs


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
RATE_LIMIT = _int("RATE_LIMIT", 30)          # requests per IP per window
RATE_WINDOW = _int("RATE_WINDOW", 3600)      # seconds
CACHE_SIZE = _int("CACHE_SIZE", 256)
FETCH_TIMEOUT = _int("FETCH_TIMEOUT", 120)

YTDLP = shutil.which("yt-dlp")
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
    cmd = [YTDLP, "--skip-download", "--write-subs", "--write-auto-subs",
           "--sub-langs", SUB_LANGS, "--sub-format", "json3/vtt/best",
           "--no-warnings", "--no-progress", "--output", template]
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

    def do_GET(self):
        route = urlparse(self.path)
        query = parse_qs(route.query)

        ok, path = self.authorised(route.path, query)
        if not ok:
            # 404 rather than 401: an unauthenticated scanner learns nothing about what is here.
            self._send(404, {"ok": False, "reason": "not found"})
            return

        if path == "/health":
            version = ""
            if YTDLP:
                try:
                    version = subprocess.run([YTDLP, "--version"], capture_output=True,
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


def main():
    if not YTDLP:
        print("yt-dlp not found on PATH. Install it with:  pip install yt-dlp", file=sys.stderr)
    shown = "/k/<token>" if ACCESS_TOKEN else ""
    print(f"YT Copy transcript service on http://{HOST}:{PORT}{shown}"
          f"  (cookies={'yes' if COOKIE_FILE else 'no'}, proxy={'yes' if PROXY else 'no'})")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
