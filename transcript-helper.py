#!/usr/bin/env python3
"""Local transcript helper for the YT Copy extension.

In-browser transcript extraction stopped being reliable: YouTube gates the caption URLs
behind proof-of-origin tokens (they return HTTP 200 with an empty body) and rejects
InnerTube calls that don't come from its own player. yt-dlp tracks those changes and is
maintained for exactly this, so the extension asks this helper instead.

    python3 transcript-helper.py           # listens on 127.0.0.1:8731

The implementation lives in transcript_service/app.py, shared with the hosted deployment so
the two can't drift apart. This entry point only pins the defaults that make it local:
loopback binding and the port the extension falls back to. Running from home is still the
most reliable option, because YouTube blocks datacenter IPs far more aggressively than
residential ones — see transcript_service/README.md if you want it hosted anyway.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "transcript_service"))

# app.py reads its configuration at import time, so these have to be set first. setdefault
# keeps any value already exported in the shell.
os.environ.setdefault("HOST", "127.0.0.1")
os.environ.setdefault("PORT", os.environ.get("YTC_HELPER_PORT", "8731"))
os.environ.setdefault("RATE_LIMIT", "0")  # no throttling when nothing off-machine can reach it

import app  # noqa: E402  (must follow the environment defaults above)

if __name__ == "__main__":
    if not app.YTDLP:
        print("yt-dlp not found on PATH. Install it with:  brew install yt-dlp", file=sys.stderr)
    app.main()
