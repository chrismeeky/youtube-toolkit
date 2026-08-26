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

# Only the three the index needs. Anything else in that file stays out of this process.
for key in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY OPENAI_API_KEY; do
  line="$(grep -m1 "^${key}=" "$ENV_FILE" || true)"
  if [ -z "$line" ]; then
    echo "Missing $key in $ENV_FILE" >&2
    exit 1
  fi
  export "${line?}"
done

echo "index service on http://127.0.0.1:${PORT}"
echo
echo "Paste this into the extension popup's \"Index API\" field:"
echo "    http://127.0.0.1:${PORT}/k/${TOKEN}"
echo
echo "Ctrl-C to stop."
echo

cd "$(dirname "$0")/../transcript_service"
HOST=127.0.0.1 PORT="$PORT" ACCESS_TOKEN="$TOKEN" MAX_CONCURRENCY=2 exec python3 app.py
