#!/usr/bin/env python3
"""Local transcript helper for the YT Copy extension.

In-browser transcript extraction stopped being reliable: YouTube gates the caption URLs
behind proof-of-origin tokens (they return HTTP 200 with an empty body) and rejects
InnerTube calls that don't come from its own player. yt-dlp tracks those changes and is
maintained for exactly this, so the extension asks this helper instead.

    python3 transcript-helper.py           # listens on 127.0.0.1:8731

Serves:  GET /transcript?v=VIDEO_ID  ->  {"ok": true, "segments": [{"time","text"}, ...]}
         GET /health                 ->  {"ok": true, "ytdlp": "<version>"}

Binds to localhost only; nothing is exposed off this machine.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("YTC_HELPER_PORT", "8731"))
YTDLP = shutil.which("yt-dlp")
VIDEO_ID = re.compile(r"^[\w-]{5,20}$")


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


def fetch(video_id):
    if not YTDLP:
        return None, "yt-dlp is not installed (brew install yt-dlp)"

    url = f"https://www.youtube.com/watch?v={video_id}"
    with tempfile.TemporaryDirectory() as tmp:
        template = os.path.join(tmp, "sub")
        try:
            proc = subprocess.run(
                [YTDLP, "--skip-download", "--write-subs", "--write-auto-subs",
                 "--sub-langs", "en.*,en", "--sub-format", "json3/vtt/best",
                 "--output", template, url],
                capture_output=True, text=True, timeout=120,
            )
        except subprocess.TimeoutExpired:
            return None, "yt-dlp timed out"

        files = sorted(os.listdir(tmp))
        if not files:
            detail = (proc.stderr or proc.stdout or "").strip().splitlines()
            return None, detail[-1] if detail else "no subtitles available for this video"

        # Prefer manual captions over auto-generated, json3 over vtt.
        def rank(name):
            return (".json3" not in name, "auto" in name.lower())

        for name in sorted(files, key=rank):
            path = os.path.join(tmp, name)
            with open(path, encoding="utf-8", errors="replace") as handle:
                raw = handle.read()
            try:
                segments = parse_json3(raw) if name.endswith(".json3") else parse_vtt(raw)
            except (ValueError, json.JSONDecodeError):
                continue
            if segments:
                return segments, None

        return None, "subtitles downloaded but could not be parsed"


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204, {})

    def do_GET(self):
        route = urlparse(self.path)
        if route.path == "/health":
            version = ""
            if YTDLP:
                try:
                    version = subprocess.run([YTDLP, "--version"], capture_output=True,
                                             text=True, timeout=30).stdout.strip()
                except Exception:
                    version = "unknown"
            self._send(200, {"ok": bool(YTDLP), "ytdlp": version})
            return

        if route.path != "/transcript":
            self._send(404, {"ok": False, "reason": "unknown route"})
            return

        video_id = (parse_qs(route.query).get("v") or [""])[0]
        if not VIDEO_ID.match(video_id):
            self._send(400, {"ok": False, "reason": "bad video id"})
            return

        segments, error = fetch(video_id)
        if error:
            self._send(200, {"ok": False, "reason": error})
        else:
            self._send(200, {"ok": True, "segments": segments})

    def log_message(self, fmt, *args):
        sys.stderr.write("[helper] %s\n" % (fmt % args))


if __name__ == "__main__":
    if not YTDLP:
        print("yt-dlp not found on PATH. Install it with:  brew install yt-dlp", file=sys.stderr)
    print(f"YT Copy transcript helper listening on http://127.0.0.1:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
