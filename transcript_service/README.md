---
title: YT Transcript Helper
emoji: 📝
colorFrom: red
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# Transcript service

The yt-dlp transcript helper, packaged to run on a free container host instead of only on
localhost. Same API the extension already speaks:

```
GET <base>/transcript?v=VIDEO_ID   ->  {"ok": true, "segments": [{"time","text"}, ...]}
GET <base>/health                  ->  {"ok": true, "ytdlp": "...", "cookies": bool}
GET /healthz                       ->  {"ok": true}          (no token, for platform probes)
```

`app.py` is shared with the local entry point (`../transcript-helper.py`), so there is one
implementation rather than a hosted copy that quietly drifts from the local one.

## Read this before deploying

**YouTube blocks datacenter IPs.** This is the whole difficulty of hosting this service, and
it is not specific to any provider. Requests from a home connection usually succeed; requests
from Hugging Face, Render, Koyeb, Fly, AWS or Cloudflare frequently come back with *"Sign in
to confirm you're not a bot."* The service detects that response and tells you plainly rather
than reporting it as a missing-captions error.

If you hit it, you have two levers, `YTDLP_COOKIES_B64` and `YTDLP_PROXY` — both documented
below. Neither is guaranteed forever; this is an adversarial system that changes.

**Running locally remains the most reliable option.** Host it for convenience, not because
it will work better. `python3 ../transcript-helper.py` still does the right thing.

## Why not Cloudflare, next to the DDG worker?

The Workers **free** tier allows 10 ms of CPU per request. The DDG worker fits because it is
almost entirely `await fetch()`, and I/O wait doesn't count toward CPU time. Resolving a
video with yt-dlp is real compute — the cold fetch measured during testing took ~19 seconds —
so it exceeds that budget by orders of magnitude. Separately, Workers run a V8 isolate with
no way to ship or exec a binary, and Python Workers run Pyodide, which supports only async
HTTP libraries (yt-dlp's networking stack is synchronous `urllib`).

Cloudflare's real answer is **Containers**, which runs this exact Dockerfile — but requires
the Workers **Paid** plan ($5/mo). If you upgrade, this image moves there unchanged.

## Deploy: Hugging Face Spaces (recommended free option)

Genuinely free, no credit card, and no spin-down-after-15-minutes penalty.

1. Create a Space: **New Space** → SDK **Docker** → **Blank**. Set it to **Private** unless
   you have a reason not to.
2. Push the *contents of this directory* to the Space repo (this README carries the YAML
   frontmatter Spaces needs, so keep it at the repo root):

   ```bash
   git clone https://huggingface.co/spaces/<you>/<space> hf-space
   cp app.py Dockerfile requirements.txt .dockerignore README.md hf-space/
   cd hf-space && git add -A && git commit -m "Add transcript service" && git push
   ```
3. In **Settings → Variables and secrets**, add a secret `ACCESS_TOKEN`. Generate one with
   `openssl rand -hex 24`. **Do not skip this** — a Space URL is guessable, and an open
   yt-dlp endpoint is a free downloader for whoever finds it.
4. Your base URL is `https://<you>-<space>.hf.space/k/<ACCESS_TOKEN>`.

## Deploy: Render (no Docker)

Render's native Python runtime is enough — the Dockerfile is only there for hosts that need
one. Two settings are not defaults and will otherwise fail the build.

1. **New → Web Service**, connect the repo.
2. **Root Directory: `transcript_service`** — everything below is relative to this folder.
   Skip it and Render looks for `requirements.txt` at the repo root and finds nothing.
3. **Language: Python 3.**
4. **Build Command:** `pip install -r requirements.txt`
5. **Start Command:** `python app.py`
6. **Instance type: Free.**
7. **Health Check Path: `/healthz`** — that route sits outside the token check. Every other
   path answers 404 without the token, which Render reads as a failed deploy.
8. **Environment variables:**

   | key | value |
   | --- | --- |
   | `ACCESS_TOKEN` | `openssl rand -hex 24` |
   | `MAX_CONCURRENCY` | `1` — the free instance has 512 MB, and two yt-dlp runs can exhaust it |
   | `PYTHON_VERSION` | `3.12` (optional; pins the runtime) |

   `PORT` is injected by Render and already honoured — do not set it.
9. Deploy. Your helper URL is `https://<service>.onrender.com/k/<ACCESS_TOKEN>`; paste it,
   token included, into the extension popup's **Helper** field.

yt-dlp installs from `requirements.txt` as a normal package. `app.py` invokes it by console
script when that is on PATH and falls back to `python -m yt_dlp` when it is not, so the
native runtime works without any PATH fiddling.

Verify without the extension:

```bash
curl https://<service>.onrender.com/healthz              # {"ok": true}
curl https://<service>.onrender.com/k/<token>/health     # yt-dlp version
```

### What the free tier costs you

Free instances **sleep after ~15 minutes idle**, and waking one takes the better part of a
minute. That lands on top of the yt-dlp fetch, and the extension gives up at 120 s, so the
first transcript after an idle period can time out where a second attempt succeeds.

Expect YouTube to challenge the requests as well: Render egress is datacenter IP space, which
is exactly what the bot checks target. `YTDLP_COOKIES_B64` and `YTDLP_PROXY` are the levers,
and neither is guaranteed — see the warning at the top of this file.

## Deploy: Koyeb

Same image. New Service → **Dockerfile**, set the work directory to `transcript_service`, add
`ACCESS_TOKEN` as a secret. `$PORT` is injected and already honoured.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ACCESS_TOKEN` | *(none)* | Required token. Unset means **no authentication** — only acceptable on localhost. |
| `PORT` / `HOST` | `7860` / `0.0.0.0` | Listen address. `$PORT` is set for you on Render and Koyeb. |
| `YTDLP_COOKIES_B64` | *(none)* | base64 of a Netscape `cookies.txt`. The main fix for bot-blocking. |
| `YTDLP_COOKIES` | *(none)* | Raw cookie text, if your host preserves newlines. Prefer the base64 form. |
| `YTDLP_PROXY` | *(none)* | `http://user:pass@host:port`. A residential proxy is the other bot-blocking fix. |
| `YTDLP_EXTRACTOR_ARGS` | *(none)* | Passed to `--extractor-args`. Try `youtube:player_client=android` or `youtube:player_client=tv` when blocked. |
| `YTDLP_SUB_LANGS` | `en.*,en` | Passed to `--sub-langs`. |
| `MAX_CONCURRENCY` | `2` | Simultaneous yt-dlp runs. Free instances have little RAM; raising this invites OOM kills. |
| `RATE_LIMIT` / `RATE_WINDOW` | `30` / `3600` | Requests per IP per window. `0` disables (the local entry point sets this). |
| `CACHE_SIZE` | `256` | Cached transcripts. Captions don't change, so hits are free — measured at 8 ms against ~19 s cold. |
| `FETCH_TIMEOUT` | `120` | Seconds before a yt-dlp run is abandoned. |

### Supplying cookies

```bash
# Export cookies.txt from a logged-in browser (e.g. the "Get cookies.txt LOCALLY" extension),
# then collapse it to one line for the host's secrets field:
base64 -i cookies.txt | tr -d '\n' | pbcopy
```

Paste as `YTDLP_COOKIES_B64`. Two warnings worth taking seriously: these cookies are live
credentials for whichever Google account exported them, so treat the value as a password;
and YouTube does sometimes flag accounts used this way, so **use a throwaway account, not
your main one**.

## Pointing the extension at it

Open the extension popup and set **Helper** to the full base URL including the token:

```
https://<you>-<space>.hf.space/k/<ACCESS_TOKEN>
```

`background.js` builds requests as `helperUrl + '/transcript?v=...'`, so folding the token
into the base URL authenticates every call with no extension changes. Click **Test** — it
should report the yt-dlp version.

The token is also accepted as an `X-Helper-Token` header or a `?key=` parameter if you'd
rather not keep it in a URL.

Leave the field empty (or set `http://127.0.0.1:8731`) to go back to the local helper.

## Running locally

```bash
python3 ../transcript-helper.py          # 127.0.0.1:8731, no token, no rate limit
```

Or the service directly, with hosted-style settings:

```bash
ACCESS_TOKEN=dev123 PORT=8739 HOST=127.0.0.1 python3 app.py
curl "http://127.0.0.1:8739/k/dev123/health"
```
