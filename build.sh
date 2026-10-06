#!/usr/bin/env bash
# Builds the store packages: dist/youtube-toolkit-<version>-chrome.zip and -firefox.zip.
#
# Both come from the same source files. Only the manifest differs:
#   - Firefox has no extension service workers, so `background.service_worker` becomes
#     `background.scripts`, with config.js and format.js listed first (background.js loads
#     them itself with importScripts only when it runs as a worker).
#   - Firefox requires an add-on id and, for new add-ons, a data-collection declaration.
#
# Only runtime files go in: no docs, no Python, no .git, no macOS __MACOSX folders. The
# manifest sits at the root of each zip, which addons.mozilla.org requires.
set -euo pipefail
cd "$(dirname "$0")"

# The add-on id is permanent once the first version is uploaded to addons.mozilla.org.
GECKO_ID="youtube-toolkit@chrismeeky"
# 140 is the current ESR, and the first release that shows the data-collection consent.
GECKO_MIN="140.0"

FILES=(manifest.json background.js config.js content.js content.css format.js page.js
       paste.js studio.js studio.css whatsnew.js whatsnew.css whatsnew popup.html
       popup.js popup.css icons)

[ -f config.js ] || { echo "config.js is missing — copy config.example.js and fill it in." >&2; exit 1; }
# A dev config pointing at the local index must never ship.
if grep -qE "127\.0\.0\.1|localhost" config.js; then
  echo "config.js points at a local index. Switch it to the store endpoint first." >&2
  exit 1
fi
for f in "${FILES[@]}"; do [ -e "$f" ] || { echo "missing: $f" >&2; exit 1; }; done

VERSION=$(node -p "require('./manifest.json').version")
rm -rf dist/chrome dist/firefox
mkdir -p dist/chrome dist/firefox
for d in chrome firefox; do cp -R "${FILES[@]}" "dist/$d/"; done
find dist -name .DS_Store -delete

GECKO_ID="$GECKO_ID" GECKO_MIN="$GECKO_MIN" node - <<'JS'
const fs = require('fs');
const path = 'dist/firefox/manifest.json';
const m = JSON.parse(fs.readFileSync(path, 'utf8'));
m.background = { scripts: ['config.js', 'format.js', 'background.js'] };
m.browser_specific_settings = {
  gecko: {
    id: process.env.GECKO_ID,
    strict_min_version: process.env.GECKO_MIN,
    /* What leaves the browser, in Mozilla's categories (see PRIVACY.md):
         browsingActivity — channels and videos opened, sent to the channel index, and a
                            video id sent to the Internet Archive for thumbnail history
         websiteContent   — a channel's public title, description and video titles
         searchTerms      — YouTube searches, for the search companion's keyword chart */
    data_collection_permissions: {
      required: ['browsingActivity', 'websiteContent', 'searchTerms']
    }
  }
};
fs.writeFileSync(path, JSON.stringify(m, null, 2) + '\n');
JS

for d in chrome firefox; do
  out="dist/youtube-toolkit-$VERSION-$d.zip"
  rm -f "$out"
  (cd "dist/$d" && zip -qr -X "../$(basename "$out")" .)
  # Listed into a variable first: piping straight into grep -q kills unzip mid-write, and
  # pipefail then reports the pipeline as failed even when the manifest is there.
  listing=$(unzip -Z1 "$out")
  grep -qx "manifest.json" <<<"$listing" || { echo "$out: manifest not at root" >&2; exit 1; }
  echo "built $out"
done
