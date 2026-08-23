# YT Copy — Titles, Views & Dates

Chrome extension (Manifest V3) that copies YouTube video details as clean, formatted text.
Pick which parts you want — title, view count, time posted, channel, URL — and how the
clipboard output is laid out.

## Install (unpacked)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this `yt-copy-extension` folder
4. Open any YouTube page — search results, a channel's Videos tab, home, or a watch page

## Using it

**One video** — click the **Copy** button in the card's text block, beside the subscriber badge.

**Many videos** — open the extension popup and click **Select videos…** (or press
`Alt+Shift+S`). A checkbox appears in every card's control row; tick the ones you want, then
**Copy selected** (or `Alt+Shift+C`). `Esc` leaves select mode.

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

Two consoles tell you where it broke:

- **Page console** (DevTools on YouTube) — `[YT Copy] subs @handle -> 183K subscribers`, or
  `-> not found` with a reason. No line at all means no channel link was found on the card.
- **Service worker console** (`chrome://extensions` → *service worker* under this extension) —
  logs every lookup and why it failed: `HTTP 429`, `not in first 60KB`, `redirected to …`.

A lookup that fails is cached as a failure for 6 hours; *Clear cache* in the popup resets it.

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

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest, content-script matches, keyboard commands |
| `format.js` | Shared settings defaults + formatting engine (content script and popup both load it) |
| `content.js` | Reads video cards from the page, injects the Copy button / checkboxes / action bar |
| `content.css` | Styling for the injected UI |
| `popup.html` / `popup.css` / `popup.js` | Settings UI with live preview |
| `background.js` | Keyboard shortcuts, plus the subscriber-count fetch queue and cache |

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
- No analytics, no third-party servers. Permissions: `storage` (your settings), `clipboardWrite`,
  and host access to `youtube.com` — the host permission is what lets the popup see that the
  active tab is a YouTube page at all (`tab.url` is empty without it).
