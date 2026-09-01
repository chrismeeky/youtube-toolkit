# YouTube Toolkit — Titles, Views & Dates

> **Transcripts read YouTube's own panel.** No helper, no server, nothing to install. The
> button opens YouTube's transcript panel off-screen, reads the segments out of the page and
> closes it again — measured at 0.6 s for a 24-minute video, 181 segments, 97% coverage.
>
> This replaced three routes that are all dead: the InnerTube endpoint returns 400 in the page
> and 403 from the service worker, caption URLs come back empty behind proof-of-origin tokens,
> and while yt-dlp worked it needed a local helper running — and hosting that helper failed
> too, since YouTube blocks datacenter IPs (1 of 4 videos succeeded from Render against 4 of 4
> residentially). `transcript-helper.py` and `transcript_service/` are kept but are no longer
> used by the extension.

Chrome extension (Manifest V3) that copies YouTube video details as clean, formatted text.
Pick which parts you want — title, view count, time posted, channel, URL — and how the
clipboard output is laid out.

## Install (unpacked)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this `yt-copy-extension` folder
4. Open any YouTube page — search results, a channel's Videos tab, home, or a watch page
5. *Optional* — `cp config.example.js config.js` and set `INDEX_API` to power Similar
   Channels from a channel index rather than live search. See
   [Similar channels & the channel index](#similar-channels--the-channel-index).

## Using it

**One video** — click the **Copy** button in the card's text block, beside the subscriber badge.

**Many videos** — open the extension popup and click **Select videos…** (or press
`Alt+Shift+S`). A checkbox appears in every card's control row; tick the ones you want, then
**Copy selected** (or `Alt+Shift+C`). `Esc` leaves select mode.

**Thumbnails** — click **Thumb** on any card to save its thumbnail, or tick several videos
and use **Download thumbs** in the select bar. On a watch page the same row appears under the
video title, so you can copy or save the thumbnail for the video you're actually watching. Files land in `Downloads/yt-thumbnails/`, named
`<title> [<video id>].jpg`.

**Transcript** — on a watch page, click **Transcript** to copy the video's transcript. Nothing
else happens: no panel opens, the description stays collapsed, the page doesn't scroll.
Timestamps are off by default, since the usual reason to grab a transcript is to paste the
words somewhere else; both that and *save as .txt* are popup settings. Saved files go to
`Downloads/yt-transcripts/`.

**Everything on screen** — popup → **Copy all on page**. Only currently-rendered videos are
included, so scroll first to load more.

## Subscriber badge

YouTube's feed markup contains the channel name but never its subscriber count, so the
extension looks each channel up once from its channel page and caches the result for a week.
A small badge sits in the card's text block, just under the views/date line:

```
183K subs   13×
```

The second pill is **views ÷ subscribers** — the outlier signal. The scale runs good → bad,
so a breakout reads as a win at a glance:

| Ratio | Colour | Meaning |
| --- | --- | --- |
| ≥ 10× | green | breakout |
| 3–10× | olive | strong |
| 1–3× | amber | beat the subscriber count |
| 0.5–1× | orange | soft |
| < 0.5× | red | well below the subscriber count |

A video pulling 224× its channel's subscriber count is doing something unusual; that's the
number channel-research tools lead with. Hover the pill for the tier in words.

The colour is derived from the **rounded** number on the pill, not the exact ratio. An exact
0.4509 displays as `0.5×`, and colouring that by the exact value would put two badges reading
`0.5×` in different colours — technically defensible, visibly broken.

Each channel gets up to three shots, stopping at the first that works: cookieless (clean and
cheap), then with cookies (gets past the consent interstitial YouTube serves to cookieless
requests), then `/about` (a smaller page when the channel's home tab is enormous).

Lookups are lazy and deduplicated — only channels you actually scroll to are fetched, once
per channel no matter how many of its videos are on screen, two at a time, and the read is
aborted as soon as the count is found rather than downloading the whole ~1MB page. After the
first pass everything comes from cache. *Clear cache* in the popup forces a refresh.

Cached channels resolve instantly, so no spinner appears for them — it's only visible when a
lookup actually goes to the network. While one is in flight the badge shows a small spinner — `⟳ subs` on first load,
`⟳ retrying` after a click — so a slow channel reads as working rather than broken. Under a
`prefers-reduced-motion` setting the spinner pulses instead of rotating.

Failures retry themselves at two levels. Within a lookup: 3 rounds of that chain, with ~0.7s
and ~1.8s backoff plus jitter. Then on the page: a failed badge re-asks on its own after 8s
and again after 25s, and any failure older than 30s is re-asked when its card scrolls back
into view. Throttling often outlasts a 3-second retry window, so without the page-level timers
a badge that failed on page load would stay failed until clicked.

Only a hard 404 on every attempt stops the retries. "No count found" is not treated as final —
in practice it's often a consent page, a truncated response, or a throttled reply wearing a
normal one's clothes, and those do come good on a second ask. Retries also locate cards by
channel rather than by the badge element, since YouTube recycles cards as you scroll and the
badge may not survive until the timer fires. Each round is queued separately, so waiting doesn't hold a
slot other channels could use. A failure that can't be fixed by waiting — a 404, or a count
that genuinely isn't on the page — breaks out after the first round instead of burning retries.

Cards that aren't videos — feed ads, Playables game tiles, shelf entries with no `/watch`
link — are skipped entirely; there's no channel behind them to look up. A real video card
whose channel still can't be identified gets a plain dim `— subs` you can click to re-check.

That distinction matters because YouTube hydrates card metadata *after* the card scrolls into
view, so the channel link often doesn't exist yet when the observer fires. Detection retries
at 0.4s, 1.2s and 3s before concluding there's no channel — treating the first empty read as
final leaves fully-normal videos permanently badgeless.

It also recycles card elements: the same `<ytd-rich-item-renderer>` gets refilled with a
different video as you scroll. Every scan compares each card's current video id against the
one its badge was computed for and rebuilds the badge when they differ, so a badge can never
outlive the video it describes. The same pass re-checks any card sitting on an empty badge
that has since grown a channel link.

A channel whose lookup still fails after that gets a dim, dashed `— subs` badge rather than nothing, so
"unavailable" never looks like "still loading". Hover it for the reason; **click it to retry**
that channel immediately.

Failures are cached by kind: a throttled or offline lookup (`HTTP 429`, `5xx`, network error)
is re-tried after 2 minutes, while a count that genuinely isn't on the page — a channel hiding it —
waits 12 hours. Fetching a dozen channels in a row can get you rate-limited, and that's a
temporary state, not a verdict about the channel.

### If badges don't appear

The badge itself carries the reason — hover it. A dim badge reading `— subs` is a failed
lookup and its tooltip says why (`HTTP 429`, `not in page`, a redirect); clicking it retries
immediately. A spinner means the lookup is still running.

The extension logs nothing to the console: a released build should be quiet in a page it does
not own. If you need tracing while developing, add it locally rather than shipping it.

A lookup that fails is cached as a failure for 6 hours; *Clear cache* in the popup resets it.

### Thumbnail resolution

YouTube only generates `maxresdefault` for videos uploaded with a large enough source image,
and 404s rather than falling back, so the fetcher walks down — `maxres` → `sd` → `hq` → `mq` —
and saves the first that resolves. A video with none of them reports as unavailable rather
than saving a broken file.

Filenames are sanitised for every OS: characters illegal on Windows are stripped, the title is
capped at 110 characters, trailing dots and spaces are removed, and the video id is appended so
two videos with the same title can't collide.

## Settings (popup)

| Setting | What it does |
| --- | --- |
| Include | Which fields go on each line: title, view count, time posted, channel, URL |
| Format | Plain lines, bulleted, numbered, Markdown, CSV, JSON, or a custom template |
| Separator | What joins the fields — em dash, pipe, dot, comma, tab, or newline |
| Plain numbers for views | `271K views` → `271,000` (spreadsheet-friendly) |
| Absolute date | `23 hours ago` → `2026-08-22` |
| Wrap title in quotes | Useful when pasting into CSV-ish tools |
| Show Copy button | Hide the Copy button and work only through select mode |
| Show thumbnail button | Hide the **Thumb** button on cards |
| Show transcript button | Hide the **Transcript** button on watch pages |
| Include timestamps | Prefix each transcript line with its timestamp |
| Save transcripts as .txt | Download instead of copying to the clipboard |
| Confirmation toast | The little "Copied" pill at the bottom of the page |

Settings save instantly, sync across your Chrome profile, and the popup shows a live preview.

### Custom template tokens

`{title}` `{views}` `{viewsRaw}` `{viewsNum}` `{date}` `{dateRaw}` `{dateISO}` `{channel}` `{url}` `{id}` `{index}`

Example — `{index}. {title} ({viewsNum} views, {dateISO})` produces:

```
1. TokTok Users Just Got PAYBACK! RIP NOLAN WELLS (271000 views, 2026-08-21)
```

## Output examples

Plain, default fields:
```
TokTok Users Just Got PAYBACK! RIP NOLAN WELLS — 271K views — 23 hours ago
TikTok Users Reveal More Nolan Wells Footage! — 120K views — 6 hours ago
```

CSV with header:
```
Title,View count,Time posted
TokTok Users Just Got PAYBACK! RIP NOLAN WELLS,271K views,23 hours ago
```

Markdown with URLs:
```
- [TokTok Users Just Got PAYBACK! RIP NOLAN WELLS](https://www.youtube.com/watch?v=6KCPs3Umu5w) — 271K views · 23 hours ago
```

## Similar channels & the channel index

The **Similar Channels** tab on a channel page lists channels like the one you are looking
at, with subscribers, average views, upload rate, age, last upload, and a monetization
estimate — sortable, and filterable by preset ("Overperforming", "Low subs, high views",
"New channels").

It asks two sources and merges them. The **index** ranks the whole corpus by topic, which is
how a 20K-subscriber channel surfaces beside a household name — no search result would ever
have shown it to you. **YouTube search** answers the other half: it finds the channels nobody
has crawled yet, which no index can know about.

These used to be alternatives, and search ran only when the index returned literally nothing.
With a 0.35 similarity floor a corpus of any size almost always returns *something*, so that
path was very nearly unreachable, and every list answered "who is already in the corpus"
rather than "who is out there". Both now run on every lookup.

Without a backend, only the search half runs — established channels, no scores, no filters.

### Pointing it at an index

The endpoint lives in `config.js`, not in the popup — it is a deployment detail, not a user
preference. Copy the example and fill it in:

```bash
cp config.example.js config.js
# then edit config.js:
#   INDEX_API: 'https://<service>.onrender.com/k/<ACCESS_TOKEN>'
```

`config.js` is gitignored. This repository is public, and the URL carries an access token
that spends YouTube quota and OpenAI credits. Note the token is only a speed bump either
way — anyone who installs the extension can read it out of the package, so rate limiting on
the server is the real protection.

Leave it empty and everything else still works; only Similar Channels degrades to search.

### How a match is decided

Each channel is reduced to one 512-dimension vector from its title, description and recent
video titles, and ranked by cosine similarity in Postgres (pgvector). Two things then adjust
it:

- **Subscriber filters** are applied in the same query, so "smaller than this channel" is a
  real question the index answers rather than a filter over an already-truncated list.
- **Co-recommendation** adds up to +0.15 for a channel YouTube itself recommends beside the
  source's videos. Text similarity answers "describes itself like this channel"; the
  recommendation graph answers "watched by the same people", which is usually the question
  being asked.
- **Search agreement** adds up to +0.12 for a channel that also ranked in YouTube's own
  results for the source's topics, priced just under co-recommendation for the same reason it
  is worth anything at all: ranking for the same words is close to what the vector already
  measures, while being recommended beside the videos is not. Rows carrying it are marked with
  a dot beside the score.

The three topics are derived from the channel's description, then its name, then repeated
phrases in its titles — in that order, because a description states a niche and titles often
chase a story. The panel prints them under the table, so a list answering the wrong question
can be recognised as one.

Search results are handed to the server with the request and enriched before the match runs,
so a channel discovered a second ago is ranked in the same answer rather than the next one.
That is also the defence against a weak topic: a query that drifts returns channels whose
vectors do not match, and the similarity floor drops them.

### Filling the index

Two things happen on their own as you browse, both free:

| While you | The index gains |
| --- | --- |
| Open a channel page | That channel, indexed |
| Watch a video | The edges between that video's channel and everything recommended beside it |

The second is the cheap one. The crawler spends five page fetches per channel to read the
list of recommended channels; a viewer already has that list in the sidebar, so reading it
costs no fetch at all. Only edges between channels already indexed are stored — unknown ones
are dropped rather than looked up, which keeps it free and stops heavy browsing running up a
bill.

That accumulates channels but does not make any one niche dense, so the crawler exists for
deliberate expansion:

```bash
# Walk YouTube's recommendations out from a channel — the highest-yield mode.
python3 channel_index/seed.py --channels "@somechannel" --graph --limit 60

# Index the channels users have looked at but nobody has indexed yet.
python3 channel_index/seed.py --drain --graph --limit 100

# See what a run would do without spending anything.
python3 channel_index/seed.py --channels "@somechannel" --graph --dry-run
```

`--graph` samples a channel's recent videos and reads the channels recommended beside them,
counting how often each appears. Measured on a horror-shorts channel, search-based expansion
returned a documentary director and a YouTube-coaching channel; the graph returned
`@thehauntinghourseries`, `@WarnerBrosUKHorror` and `@HorrorShortsParty`.

Discovery is free scraping; only enrichment costs quota, at roughly one unit per new
channel against a 10,000/day limit.

To top up without thinking about it, a nightly cron over the channels people looked at but
nobody indexed:

```
0 3 * * *  cd /path/to/yt-copy-extension && python3 channel_index/seed.py --drain --graph --limit 100
```

**Run the crawler from your own machine, not from the server.** A datacenter IP gets
YouTube's bot interstitial — measured 1 success in 4 from Render against 4 in 4 locally.
The split is deliberate: the extension and crawler scrape from residential connections, the
server holds the API keys and does the enrichment.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest, content-script matches, keyboard commands |
| `format.js` | Shared settings defaults + formatting engine (content script and popup both load it) |
| `content.js` | Reads video cards from the page, injects the Copy button / checkboxes / action bar |
| `content.css` | Styling for the injected UI |
| `popup.html` / `popup.css` / `popup.js` | Settings UI with live preview |
| `page.js` | Tiny `world: "MAIN"` script; reads live-page values the isolated world can't see |
| `transcript-helper.py` | Local yt-dlp wrapper on `127.0.0.1:8731`; the reliable transcript path |
| `background.js` | Keyboard shortcuts, the subscriber-count fetch queue and cache, and the index client |
| `config.js` | Index endpoint incl. its token. Gitignored — copy from `config.example.js` |
| `channel_index/seed.py` | Crawler: discovers channels, enriches, embeds, stores |
| `transcript_service/app.py` | The index service — `/similar`, `/ingest`, `/healthz` |

## Notes

- Nothing is drawn over the thumbnail. The Copy button, checkbox and badges share one row
  (`.ytc-tools`) inside the card's text block. Overlaying the thumbnail cannot be made to
  work: YouTube's hover-preview player renders in a stacking context that a raised `z-index`
  reaches on the home grid but not on search results, so overlaid controls vanish exactly
  when you hover to use them.
- The whole row is rebuilt on every scan if it goes missing — a hover preview makes YouTube
  re-render a card's contents and take our elements with it. A ticked card keeps its tick,
  and the badge is restored from what we already know rather than re-fetching the channel.
- Titles are taken from the element's `title` attribute when YouTube truncates the visible
  text, so you get the full title rather than `TokTok Users Just Got PAYB…`.
- Card detection covers search results, home/subscription grids, channel Videos tabs,
  watch-page sidebars, playlists, and both YouTube's classic `ytd-*` renderers and the newer
  `yt-lockup-view-model` markup.
- The watch page's metadata block is treated as a card: same row, same Copy and Thumb
  buttons, minus the checkbox (there's nothing to multi-select). Its video id comes from the
  address bar rather than a thumbnail link — applied only to that block, so a sidebar card
  that hasn't hydrated yet can't inherit the main video's id. Its subscriber count is read
  from `#owner-sub-count`, which the page already shows, so no fetch and no chance of picking
  the wrong channel's number.
- Channel detection parses every anchor on the card rather than matching one selector:
  links appear as `/@handle`, `/channel/UC…`, legacy `/c/Name` and `/user/Name`, and
  sometimes as absolute URLs. Collab videos list several channels; the first one wins.
- View count and upload time are matched **by their text**, not by wrapper class names —
  YouTube renames those between builds (`…-view-model-wiz__metadata-row` → `…-view-model__metadata-row`),
  which silently empties any class-bound selector. `findMeta` tries known selectors, then every
  leaf element in the card, then the thumbnail's `aria-label`. Anchored patterns keep a title
  like *"How I Got 1M views 3 years ago"* from being mistaken for metadata.
- Popup-triggered copies are clipboarded *by the popup*, not by the page: while the popup is
  open the YouTube tab is unfocused, and `navigator.clipboard.writeText` rejects on an
  unfocused document. The content script returns the formatted text and the popup writes it.
  Shortcut-triggered copies (`Alt+Shift+C`) do run in the focused page, so those copy in-page.
- The badge is inserted after the card's last metadata row rather than positioned over the
  thumbnail. Nothing needs measuring, nothing collides with YouTube's own thumbnail overlays
  or hover preview, and it reads the same on every layout.
- Where it lands depends on the container: search results lay metadata out as a row flex, so
  the badge becomes a flex item beside the views/date text and gets a left gap plus
  `align-self: center`. Grid cards stack in a column, where it takes its own line and neither
  applies. `markFlow` reads the parent's computed `display`/`flex-direction` at insert time
  and tags the badge accordingly.
- Picking the right number off a channel page is the hard part, and got it wrong three
  separate ways before this. The page holds many counts — related-channel shelves, featured
  channels, collab lockups — and the fetcher aborts on its first match, so any sloppy rule
  confidently returns a stranger's number. The rule that finally holds:
  1. Scan **header-shaped blocks** (`aboutChannelViewModel`, `c4TabbedHeaderRenderer`,
     `pageHeaderViewModel`, `channelHeaderViewModel`), each bounded by where the next one
     starts so a block can't reach into its neighbour.
  2. Inside a block, take the count **closest to the block start**, not the first pattern
     that hits — builds differ in shape (`subscriberCountText` vs `metadataParts`), and a
     pattern-ordered search skips a new-style header for an old-style shelf below it.
  3. Accept it only if the **handle or id we actually requested** appears in that same block.
  4. If counts exist but none sit beside our channel, return nothing. A blank badge beats a
     confident wrong number.
- Cache entries carry a `CACHE_VERSION`. Bumping it on a parsing fix retires every value the
  old code wrote, so a wrong count can't outlive the fix — the 7-day TTL would otherwise keep
  it on screen long after the bug was gone. An anchored-but-headerless
  match is kept only as a fallback for pages whose header shape isn't recognised.
- A card can link to its channel by handle *and* by id; the handle wins, so one channel can't
  end up looked up and cached under two keys.
- The subscriber badge is the only thing that touches the network, and it only ever requests
  `youtube.com` channel pages. Turn it off in the popup and the extension makes no requests
  at all.
- `host_permissions` covers `https://*.youtube.com/*`, not just `www` — a cookieless request
  gets redirected to `consent.youtube.com`, and Chrome fails the whole fetch with a bare
  `Failed to fetch` if the redirect target isn't permitted. Fetching happens in the service worker so
  one queue and one cache are shared across every open YouTube tab.
- Transcripts are fetched **from the page's own origin** by the content script, falling back
  to the service worker. These endpoints answer a request that looks like the site's own and
  return 403 to one carrying a `chrome-extension://` origin. Credentials matter per endpoint:
  caption URLs want cookies, while `get_transcript` rejects cookies sent without a
  `SAPISIDHASH` header, so that one call is deliberately anonymous.
- Transcripts are fetched without driving YouTube's transcript panel.
  Clicking YouTube's own button works, but it opens a panel, expands the description and
  Sources are tried in order:
  1. **The local helper** (`transcript-helper.py`), which shells out to `yt-dlp`. This is the
     only path that works consistently — see below.
  2. `youtubei/v1/get_transcript` using the API key and transcript params read from the
     **live page** (`window.ytcfg`, `window.ytInitialData`) by a `world: "MAIN"` content
     script, sent with session cookies, then signed with a `SAPISIDHASH` header, then
     anonymously.
  3. The live player response's caption URLs.
  4. The same, from a re-fetched watch page (the service worker fallback).
  5. `timedtext` with `fmt=json3` and then as XML.

  Steps 2–5 are kept because they cost nothing when the helper isn't running and they do
  work on some videos. Responses are walked recursively for `transcriptSegmentRenderer`
  rather than followed down a fixed path, since that nesting is seven levels deep and changes
  between builds.

### Why a local helper

YouTube gates its caption endpoints behind proof-of-origin tokens that a browser extension
cannot mint. In practice `timedtext` returns HTTP 200 with a **zero-byte body** and
`get_transcript` returns 400, no matter how faithfully the request is reproduced — signed
with `SAPISIDHASH`, carrying live session params, sent from the page's own origin. Every
in-browser avenue was tried and measured before conceding this.

`yt-dlp` tracks those changes and is maintained for precisely this problem, so the helper is
a thin wrapper around it:

```
python3 transcript-helper.py        # listens on 127.0.0.1:8731
```

It binds to localhost only and exposes two routes: `/transcript?v=ID` and `/health`. The
popup's **Test** button reports whether it's running and which `yt-dlp` version it found. If
it isn't running, the transcript button says so instead of failing vaguely.

This mirrors what the other projects on this machine already do: *Quack* falls back to a
Python `youtube_transcript_api` backend, and *YouTube automation* shells out to `yt-dlp`.
Neither extracts transcripts in the browser.

  Caption tracks come from `ytInitialPlayerResponse` by its documented path, falling back to
  scanning for the `captionTracks` array. Manual captions are preferred over auto-generated,
  English over whatever comes first. An already-open panel is read directly — that's free.
- A failed transcript reports every attempt in the toast and in the service worker console
  (`timedtext 403; transcript API 400`), so a break can be diagnosed rather than guessed at.
- On watch pages the control row is anchored after `#top-row`, which puts it above the
  description rather than below it.
- Thumbnail downloads use the `downloads` permission and fetch only from `i.ytimg.com`. This
  saves the still image YouTube already serves for a video — it does not download video or
  audio, which YouTube's terms prohibit and which no longer works reliably in any case
  (ciphered URLs, throttling parameters, proof-of-origin tokens, SABR streaming).
- No analytics, no third-party servers. Permissions: `storage` (your settings), `clipboardWrite`,
  and host access to `youtube.com` — the host permission is what lets the popup see that the
  active tab is a YouTube page at all (`tab.url` is empty without it).
