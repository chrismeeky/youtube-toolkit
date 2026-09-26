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

### Remake verdict

> **On from 1.27.0**, after shipping dark in 1.26.0. `REMAKE_UI` in `content.js` remains as a
> kill switch — setting it to `false` hides the badge and takes the settings row with it —
> because the bands below were fitted to four videos and have already been rewritten once.
> Worth re-checking the thresholds against a larger sample.


On a watch page the badge row carries a verdict on whether the video would transfer if you
remade it:

```
183K subs   7x   12 VPH   [███████░░░] Remake: Strong
```

Drawn as a battery. Five tiers on the same colour ladder as the outlier pills — **Strong,
Good, Fair, Weak, Avoid** — with the fill showing where in the 0-100 scale the video actually
landed. The two answer different questions, which is why both are on the badge: four videos
can all read *Weak* and still be 22, 30, 35 and 39 out of 100. The word is what you scan a
page for; the fill is what you compare two candidates with.

The inputs are four things the page has already given up: the like rate, the outlier against
the channel's lifetime average, the channel's subscriber count, and the video's age. Nothing
extra is fetched. The like rate is already on its way for the Engagement cell and the outlier
for the Outlier cell, so this is arithmetic on numbers that were arriving anyway.

Two of the bands are counterintuitive, and they are the reason the badge exists.

**A low like rate vetoes a high outlier.** In a 40-video sweep of the bodycam niche the
biggest outlier by a distance was The Modesto Bee's Patterson traffic stop: 854,924 views on
an 11,400-subscriber channel, a **645x** outlier. Two channels remade it and took **6,188 and
117 views**. Its like rate was 1.30%. "Dog Abuser Meets The Wrong Cop" did comparable views
(862,768) on a comparable channel (15,000 subs) at **5.67%**, on a premise eight unrelated
channels have since cleared 800K with. The like rate told those two apart in advance; the
outlier score ranked them the wrong way round.

So the like rate **multiplies** the other three rather than adding to them: x0.25 where nobody
cared, x1.0 where the payoff was exceptional. It began as a hard cap — under 2%, score = 35 —
which was right about the ranking and wrong about everything else. Most videos in this niche
sit under 2%, so every one of them landed on exactly 35 and the badge read the same on a 21x
outlier from a 13K channel as on a 3x from a million-subscriber one. As a multiplier the same
judgement survives with the ordering intact: a 1.3% like rate still cannot reach Strong from
any base, because 0.32 x 100 is 31 — it just no longer collides with every other low-rate
video on the way down.

**An extreme outlier is a warning, not a prize.** Past roughly 100x the usual explanation is a
channel whose own average is tiny — a local news desk posting raw footage between council
meetings — so the ratio is measuring their quiet week rather than the video's pull.

A base out of 100 for how far it travelled and how well that transfers, then the like rate
scales it:

| Input | Best band | Worst band |
| --- | --- | --- |
| Outlier (0-45) | 5–50x | < 1.5x, or > 100x |
| Channel size (0-30) | ≤ 50K subs | > 1M subs |
| Age (0-25) | 12–36 months | > 5 years |
| Like rate (x0.25–x1.0) | ≥ 5% | < 1% |

Measured against the four videos in the sweep: Dog Abuser **82**, Routine Stop **82**, Student
Caught Packing Heat **25**, Patterson **20**.

Hover the badge for the breakdown, the score out of 100, and the one thing it cannot see:
**whether the theme repeats across other channels.** That is the strongest signal of the lot —
eight independent channels clearing 800K on animal-cruelty bodycam footage is demand, where
one channel's hit can be one thumbnail's luck — and it needs a search rather than a page, so
the badge names it rather than quietly leaving it out.

Watch pages only. The like count is free here because the player response carries an exact
figure; feed markup never does. Scoring a card without it would mean guessing at the one input
that exists to prevent a confident mistake, so no card gets a verdict. The badge needs the
subscriber lookup and the stats reader for its two main inputs and draws nothing when either
is switched off — no badge rather than a guess wearing a colour.

### Commenters

The comment section names everyone by handle and nothing else, so there is no way to tell a
viewer from a 200K creator replying under a competitor's video. With **Subscriber count on
commenters** on, a small outlined pill sits beside each handle, next to the timestamp:

```
@IrishRose-gx5xr  2 days ago  1.2K subs
```

It is the only research feature that ships **off**, and the reason is arithmetic. A single
watch page can show fifty different channels, every unfamiliar one costs a channel-page fetch,
and the queue runs two at a time — resolved eagerly that is precisely the burst that earns
Google's "unusual traffic" interstitial, which then stalls the thumbnail badges and panels
that the rest of the extension is built on.

So the badges are deliberately cheap:

- **Only what's on screen.** Comments are resolved as they come within 400px of the viewport,
  driven by scrolling rather than by how many YouTube has loaded. Reading the first ten
  comments costs ten lookups, not two hundred.
- **A light lookup.** Card badges fetch `/about` because the outlier ratio needs the channel's
  lifetime totals, and those sit at the very end of a multi-megabyte page. A commenter needs
  only the count, so that attempt is skipped and the read aborts the moment the number
  appears. Light and full answers are cached separately: a light one never overwrites totals a
  card badge already paid for, and never gets served to something that needs them.
- **Two in flight, 60 per page.** The cap resets when you open the next video. Counts already
  in memory are kept across videos — the same channels recur across a niche, and a repeat
  costs nothing.
- **Silence on failure.** A count that never arrived prints nothing. Fifty dashed `— subs`
  pills down a comment section is noise; on a card the pill is the only thing in its slot, so
  there its absence would read as a bug.

Handles and `/channel/UC…` links resolve to the same key as everywhere else, so a commenter
whose videos you have already scrolled past is free. Only the author line is read, never the
comment body: people link to channels in what they write, and the first channel link inside a
comment is regularly somebody else's.

### Shorts

YouTube's Shorts lockups carry a title, a view count and a thumbnail. That is the entire
payload — measured across fifty of them on two live results pages, there is no byline and no
upload date, in the DOM or in `ytInitialData`, under any key. So a Short on a results page has
no channel to look up and no age to divide views by, which is every badge on the row:
subscribers, both ratios and views per hour. Waiting for hydration cannot supply what was
never sent.

The video id is the one identifier a Short does carry, so the extension asks the index service
who published it: **fifty ids per quota unit**, batched, and cached for a month because the
answer cannot change. That restores the channel (and with it the subscriber badge and both
ratios) and the publish time, which is an exact timestamp rather than the "3 weeks ago" other
cards are aged from — so a Short's views per hour is more precise than a normal card's, not
less.

Without `INDEX_API` set there is nowhere to ask, and a Short keeps the dim `— subs` badge; its
tooltip says so rather than blaming the video.

### Tooltips

Every figure here is inferred from something, and the explanation is usually a sentence or
four: what the number divides by, where it came from, what it cannot see. The browser's native
tooltip renders that as grey system text in a box it controls — no heading, no spacing, a
delay it picks, and on a dark page a light box with light text.

The monetization breakdown had already been built to escape all of that, so the rest of the
tooltips now open on the same card. One chrome (`.ytc-pop`), one placement engine — below the
badge if it fits, above if not, clamped to the window, re-placed on scroll — and two bodies:
the monetization evidence rows, and a plain heading-and-prose panel for everything else.

Attaching one is declarative. An element carries its explanation in `data-ytc-tip`
(plus optional `data-ytc-tip-title` and `data-ytc-tip-foot`), or calls `setTip(el, {title,
body, foot})`, and a single delegated listener does the rest. Nothing is wired per badge, so a
badge that is recycled, rebuilt or redrawn keeps working — the explanation came with the
element rather than living in a closure that outlived it. Body text is plain lines; a line
opening with a bullet joins a list, anything else becomes a paragraph.

`setTip` always strips the native `title`. An element carrying both gets two tooltips, the
browser's drawn over ours saying the same thing in a greyer box — which is the exact bug the
monetization panel had to fix when it was the only panel here.

Three things the native tooltip could not do come free with it: the panel opens on keyboard
focus and on tap, Escape closes it, and it closes itself when whatever it explains is rebuilt
underneath it (the stats card replaces its cells on every scan, and a panel left anchored to a
detached element measures a zero-sized rectangle and lands in the corner of the page pointing
at nothing).

Short control labels — *Copy this video*, *Expand*, *Filter the videos this page has loaded* —
keep the native tooltip. They name an action rather than explaining a number, and a card that
big for two words would be worse, not better.

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
| Channel preview on hover | Hovering a card's channel name lists that channel's recent uploads |
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

## Saved filter presets

The filter modal ships with eleven presets. Anything you can set on the sliders can become a
twelfth: open **Custom filters**, set what you want, and click **Save these filters as a
preset**. A name and description field appear directly above the button, and the button itself
becomes **Add preset**. Saving closes the form and puts the button back.

The description is what shows under the preset's name in the list. Leave it blank and the
sliders describe themselves instead — `Shorts · 25K subs · 3× avg` — because a list of names
with nothing under them is the ambiguity the built-in rows already solved.

Saved presets carry a **⋮** menu with *Edit…* and *Delete*. Editing loads the preset first:
its filters go onto the sliders, its name and description into the form, and the button
becomes **Update preset**. That is deliberate — a preset's name is only half of it, and a form
that renamed something while the drawer showed a different preset's filters would be editing
two things at once. Adjust the sliders before updating and the filters are updated too.

Built-in presets have no menu. They cannot be renamed, changed or removed.

**Drag any preset to reorder it**, built-ins included — a grip fades in at the left edge of a
row when you hover it. Only saved presets can be edited, but the order is yours either way: a
built-in you never use has no claim on the top of the list. A row inserts *before* the one you
drop it on, which is what the marker on its top edge promises; drop below the last row to send
it to the end. The list expands for the duration of a drag, since a chip cannot be dropped on
a target that is clipped out of view.

Presets are stored in the browser (`chrome.storage.local`) and are limited to 40. What is
saved is the slider *positions* plus the video type and sort — not a rule of its own, so a
saved preset stays visible and adjustable in the drawer exactly like a built-in one. Saving in
one tab updates any other tab with the modal open.

### When the tab lights up but nothing appears

The panel is inserted as a **sibling** of the channel body and the body is then hidden. That
only works while the two really are siblings, and `pageContent()` used to be one
`querySelector` with three comma-separated selectors — which returns the element earliest in
*document order* matching any of them, not the first selector that matches. `#contents` is a
bare id YouTube reuses across a channel page, so the answer changed between calls. When a
later call returned an element that happened to be an *ancestor* of the panel, hiding the body
hid the panel with it: tab lit, body blank. The panel was then found and reused by class
alone, so the bad placement stuck until the page was reloaded — which is why it looked
intermittent.

Three things hold it together now: the selectors are tried in an explicit order and the
outermost match within one wins; a panel found by class is re-homed beside the current body
before use; and the element that was hidden is remembered, so the one restored on the way out
is the one that was hidden rather than whatever the selector resolves to by then. Every scan
re-asserts whichever view is open, since YouTube rebuilds the body on its own tabs and on
hydration.

## Pockets

Named lists of channels, kept in the browser. Open a channel and press **☆ Pocket** beside
Subscribe, or press the **☆** on any row of the Similar channels table — both open the same
chooser: pick an existing pocket, or make one with a name and an optional description. Clicking
a pocket you are already in takes the channel back out, since that row is the only thing on
screen saying it is in there.

**Pockets live in YouTube's own sidebar, under Shorts** — they belong to you, not to whatever
channel happens to be on screen, so they sit beside YouTube's other global destinations rather
than in a channel's tab row. Clicking it opens a modal over whatever page you are on. The entry
is anchored to the Shorts row by its href and never by its label, since the guide is translated
and matching text is one locale away from landing in the wrong place. Both guides get it: the
full one, and the mini rail that is left when the window is narrow.

The first time you ever save anything, a callout slides out of the sidebar saying where it
went — once, ever. The save happens in a dialog anchored to a button elsewhere on the page, and
without it the first pocket is created and then lost, because nothing gives you a reason to
look down the sidebar for something you have never seen there.

The modal lists every pocket. Each channel shows its
avatar, channel id, subscribers, average views and outlier score — the same figures the
similar-channels table shows, from the same helpers, so a saved channel reads identically to a
considered one. Pockets can be renamed and re-described, channels removed one at a time, and a
pocket deleted — with a confirmation that names how many channels go with it, because "delete
this pocket" and "delete the 23 channels I collected" are different sentences and only the
second is true.

A pocket stores a **snapshot** of each channel's figures rather than a reference to resolve
later. The numbers are already on screen when you save, so keeping them costs nothing, where
re-resolving forty channels on opening the list would be forty lookups and a quota bill. And a
saved list is a record of what you saw: a channel doing 3× its subscriber count when you
pocketed it is *why* it is in there, and quietly rewriting that to today's figure loses the
thing worth keeping. A figure that was unknown at save time stays unknown rather than being
invented.

One channel is one channel however it was reached — the id decides when there is one and the
lower-cased handle when there is not, so saving from the channel page and from the similar list
cannot produce two entries. Stored in `chrome.storage.local`; 50 pockets, 500 channels each.
Saving in one tab updates the stars in every other. Turn it off in the popup.

## Channel preview

Hover a card's **channel name** and a popover lists that channel's recent uploads — thumbnail,
title, views, age and duration — with a **Latest** / **Most viewed** toggle. Answering "what
else does this channel make?" otherwise costs a tab, a channel page load and your scroll
position.

The same preview works in the **filter modal**, on the channel name under each result. There
is no link to hover there — the whole row is one anchor pointing at the video, and a channel
link nested inside it would be invalid markup and would fight the row's own click — so the
name carries the channel key in a data attribute and becomes the trigger itself. It underlines
on hover to say so. The key was already read off the card for the subscriber lookup, so
carrying it costs nothing.

On the page it is bound to the channel link rather than the card. Hovering a card is something you do by
accident on the way somewhere else, and each accidental hover would be a request; moving onto
the name is already a deliberate act. A 350 ms delay means passing over a name on the way
elsewhere never asks for anything.

**Most viewed** is the most viewed of the *uploads loaded here* — the fifty most recent — not
the channel's best ever. A channel whose breakout was two years ago will not show it. The tab
is named for what it does rather than what you might hope it does; hover it for the
qualification.

The popover is a fixed-position element on `<body>`, deliberately not drawn inside the card.
That keeps it outside every stacking context the card creates, which is the same problem that
made overlaying the thumbnail unworkable for the Copy button — a raised `z-index` reaches on
the home grid but not on search results.

Uploads come from the channel index's `/videos` route, so **this needs `INDEX_API` set**;
without it the popover says so rather than blaming the channel. Each new channel costs a
couple of API units, cached for 30 minutes in the service worker and for the life of the page
in the tab, so re-hovering is free. Turn it off in the popup.

## Similar channels & the channel index

The filter modal's sliders cover views, subscribers, views per hour, views against the
channel's average, views against its subscriber count, upload date and **channel age**. The
last is read off the channel's about page, so it arrives with the subscriber count rather than
with the card — a row whose channel has not been looked up yet has no value and drops out once
that slider is moved, like every other range. It sorts too, negated like the upload date so the
arrow means the same thing in both: pointing down puts the newest first.

Channel age is the one range whose value is not already on the card. Views, subscribers and
the ratios are painted on by the time a card is on screen; a join date is read from the
channel's about page, fetched per channel and queued two at a time. So moving that slider
excludes most rows at first, and the modal says so — a progress line above the list counts how
many channels have answered out of how many there are, and quietly asks the unasked ones,
eight per repaint so a filter cannot turn into a rate-limit. It disappears when nothing is
left to resolve. Channels whose about page carries no join date are not counted as pending;
they are unavailable, and counting them would leave the total one short forever.

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

### Handle URLs and id URLs are the same channel

A channel opens as `/@handle` or as `/channel/UC…` depending only on which link was followed,
and the key the extension carries differs accordingly. That difference used to leak everywhere:
`/similar` prefixed `@` to whatever it was given, turning `channel/UC…` into `@channel/UC…`
and matching nothing; the row lookup had no id path even though the id was being sent
alongside; and both the ingest call and the sighting report were gated on the key starting
with `@`. So a channel opened by its id URL was never added to the corpus, and one that had
been indexed for weeks reported itself unindexed on every visit and was ranked from its page
text instead — worse results, and paying to embed text it already had a vector for.

The id is now extracted from either form, the row is looked up by handle and then by id, and
both the ingest and the sighting accept an id-only channel.

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
