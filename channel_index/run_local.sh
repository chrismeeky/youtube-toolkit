#!/usr/bin/env bash
# Run the index service locally, against the same Supabase the deployed one uses.
#
# The extension talks to this exactly as it talks to Render, so a bug found here is a bug
# that would otherwise only appear in production — the missing CORS preflight header was
# found this way, and it broke every POST while leaving GET working.
set -euo pipefail

ENV_FILE="${ENV_FILE:-$HOME/Desktop/youtube automation/.env}"
PORT="${PORT:-8790}"
TOKEN="${ACCESS_TOKEN:-localtest}"

if [ ! -f "$ENV_FILE" ]; then
  echo "No .env at $ENV_FILE — set ENV_FILE=/path/to/.env" >&2
  exit 1
fi

# Only what the index needs. Anything else in that file stays out of this process.
for key in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY OPENAI_API_KEY; do
  line="$(grep -m1 "^${key}=" "$ENV_FILE" || true)"
  if [ -z "$line" ]; then
    echo "Missing $key in $ENV_FILE" >&2
    exit 1
  fi
  export "${line?}"
done

# Ingestion needs the YouTube key to enrich the channels the extension discovers. The web app
# stores it under its own name, so map it across rather than asking for a duplicate entry.
# Without this the /ingest route answers "ingest not configured" and the index never fills.
yt_line="$(grep -m1 '^YOUTUBE_API_KEY=' "$ENV_FILE" || grep -m1 '^NEXT_PUBLIC_YOUTUBE_API_KEY=' "$ENV_FILE" || true)"
YT_KEY="${yt_line#*=}"
YT_KEY="${YT_KEY%\"}"; YT_KEY="${YT_KEY#\"}"
if [ -z "$YT_KEY" ]; then
  echo "note: no YouTube key found — /ingest will be disabled" >&2
fi

echo "index service on http://127.0.0.1:${PORT}"
echo
echo "Paste this into the extension popup's \"Index API\" field:"
echo "    http://127.0.0.1:${PORT}/k/${TOKEN}"
echo
echo "Ctrl-C to stop."
echo

cd "$(dirname "$0")/../transcript_service"
# Passed explicitly rather than exported. An exported value was not reaching the process,
# and a silently missing key shows up only as "ingest not configured" much later.
# PYTHONDONTWRITEBYTECODE: the service lives inside the folder Chrome loads as an unpacked
# extension, and Chrome refuses any directory whose name starts with "_" — a __pycache__ left
# here makes the whole extension fail to load with "Could not load manifest". The profile then
# keeps running whatever it loaded last, so the symptom is a stale extension, not an error.
HOST=127.0.0.1 PORT="$PORT" ACCESS_TOKEN="$TOKEN" MAX_CONCURRENCY=2 \
  YOUTUBE_API_KEY="$YT_KEY" PYTHONDONTWRITEBYTECODE=1 \
  exec python3 app.py
