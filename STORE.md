# Chrome Web Store listing & privacy answers

Written against what the code does, not what it used to do. If the extension's network
behaviour changes, this file changes with it — an undisclosed request is the fastest way to
fail review, and the slowest to explain afterwards.

## Single purpose

YouTube Toolkit helps you research YouTube channels and videos while you browse YouTube. On
the page you are viewing it shows how a video's views compare with its channel's average,
views per hour, engagement, an earnings estimate and monetization status; it lists channels
similar to the one you are on; and it copies video details or transcripts as text.

To produce those figures it also reads other YouTube pages in the background — channel
pages, watch pages and search results — and uses a shared index of public channel
information to find similar channels. Every feature serves the one purpose of researching
YouTube channels and videos.

## Short description (132 char limit)

> Copy video details as text, plus outlier scores, views/hour, earnings estimates,
> monetization status and similar channels.

## Detailed description

Free YouTube channel and video research, on the page you are already looking at.
There is no account to create and no subscription to buy.

Nothing here is held back behind a sign-up or an upgrade prompt. Install it and
everything described below works straight away, for as long as you use it.

WHAT IT DOES

• Copy the details of any video as clean text. You choose which parts you want
  and how they are laid out.

• See how a video performed against its own channel. A video with 1.4M views on
  a channel that averages 1.5M is not a hit; it is a normal day. The outlier
  score tells you which videos actually broke out.

• See how far a channel reaches beyond its own audience. On a channel page it
  compares the channel's average views with how many subscribers it has, so a
  channel punching well above its size is obvious at a glance.

• Watch how fast a video is moving. Views per hour sit on the thumbnail, and the
  watch page adds an engagement rate and a rough earnings estimate.

• Check whether a channel is earning. Each channel and video card shows whether
  ads appear to be running on recent videos, whether they do not, or whether the
  channel is still under the subscriber requirement that allows them.

• Find channels like the one you are viewing. A tab on any channel page lists
  them with the numbers that matter for comparison: how large each one is, how
  many views its videos average, how often it posts, how old it is and when it
  last uploaded. Sort by any of those, or narrow the list to channels
  overperforming their size, channels with small followings and large view
  counts, recent channels already doing big numbers, or channels smaller than
  the one you are on.

• Take a transcript in one click. Copy it or save it as a file, with timestamps
  or without.

• See subscriber counts on thumbnails as you browse the feed, search results and
  the sidebar.

• Download any thumbnail at the best resolution available.

• Select several videos at once and copy them together. Alt+Shift+S turns
  selection on and Alt+Shift+C copies what you have picked.

HOW IT COPIES

Copy as plain text, or as a bulleted or numbered list. There is a Markdown
option for pasting into documents and a CSV option for spreadsheets, and JSON if
you are feeding the output into something else. If none of those suit you, write
your own template and it will follow it.

View counts can come out the way YouTube shows them (271K) or as whole numbers
for sorting (271,000). Dates can stay relative the way the page displays them or
become calendar dates.

HONEST ABOUT ESTIMATES

The earnings figure is a view count multiplied by an assumed rate, adjusted for
video length. Real rates are private to each channel and no extension can read
them, so treat the number as a sense of scale rather than as revenue. Shorts
show no estimate at all, because they are paid from a different pool.

Monetization is inferred from whether recent videos carry advertising slots.
YouTube also runs ads on channels that are not monetized and keeps that revenue,
so the badge is an estimate rather than a status. Hover it to see how many
videos were checked. The one exception is a channel below 1,000 subscribers,
which cannot run its own ads at all — that is a fact rather than a guess.

Similar channels are ranked by how a channel describes itself and titles its
videos, and by which channels YouTube recommends alongside it. When the matches
are weak the panel says so, rather than presenting a thin result as a strong one.

WHAT LEAVES YOUR BROWSER

There are no accounts and no sign-in. Nothing is tracked and no analytics are
collected. Nothing is ever sold or shared. Your settings stay in your browser,
and free does not mean you are the product here — there is no account for
anything to be attached to.

To produce its figures the extension reads the page you are on and requests
YouTube pages in the background. It reads channel pages and watch pages for
subscriber counts and advertising slots, and search results when it is looking
for related channels. Those requests go to YouTube and nowhere else, and carry
no account credentials.

Finding similar channels relies on a shared index of public channel information.
While that feature is switched on, the extension tells the index which channel
page you have opened and which channels YouTube recommended beside a video you
watched, so it can learn which channels resemble one another. No account
identifier and no viewing history is sent, and the index holds relationships
between channels rather than anything about people.

Switching "Similar Channels" off in the popup stops all of that.

## Permission justifications

| Permission | Why it is needed |
| --- | --- |
| `storage` | Saves your settings and caches subscriber counts and monetization results so the same channel is not looked up repeatedly. |
| `clipboardWrite` | Copying video details to the clipboard is the extension's primary function. |
| `downloads` | Saving a thumbnail image or a transcript as a file, only when you click those buttons. |
| `https://*.youtube.com/*` | Reads the YouTube pages you are on to find video cards and channel details, and fetches YouTube pages in the background to look up subscriber counts, ad slots, and related channels. |
| `https://i.ytimg.com/*` | Fetches thumbnail images for the download button, walking down resolutions until one exists. |

**Remote code:** none. All JavaScript is contained in the package. No code is fetched or
evaluated at runtime.

## Data collection disclosure

Answer **yes** to collecting the categories below, and no to the rest.

### Website content — yes

To display its figures, the extension reads the YouTube page you are on and fetches YouTube
pages in the background:

- **Channel pages and watch pages** are fetched to read subscriber counts and to check
  recent videos for ad slots.
- **Search result pages** are fetched to find similar channels when the channel index has no
  answer.
- **Up to three watch pages** are fetched when the Similar Channels result is weak, to find
  which channels YouTube recommends alongside that channel.

These requests go to youtube.com only, from the user's own browser, and carry no
credentials. They are rate-limited and stop automatically if YouTube starts refusing them.

### Web history — yes, if the Similar Channels feature is on

With **"Similar Channels" tab on channel pages** enabled, two things are sent to the
extension's channel-index service:

- The **handle of a channel page you open**, so the channel can be added to the index.
- The **handles of channels YouTube recommends beside a video you watch**, so the index
  learns which channels share an audience.

No video titles you watch, no viewing history, no account identifiers, and no personally
identifying information are sent. The service stores channel-to-channel relationships, not
people. Requests carry your IP address, as any web request does; it is not stored against
the data.

**Turning the setting off stops all of it** — no channel is reported, no recommendations are
read, and no background pages are fetched for it.

### Everything else — no

No personally identifiable information, health, financial, authentication, personal
communications, location, or user activity beyond the above. Nothing is sold or transferred
to third parties. Nothing is used for advertising, and nothing is used for any purpose
unrelated to the extension's single purpose.

## Privacy policy text

> **YouTube Toolkit — Privacy**
>
> YouTube Toolkit reads the YouTube pages you visit in order to display video and channel
> statistics on them. It also requests YouTube pages in the background — channel pages,
> watch pages and search results — to look up subscriber counts, check recent videos for ad
> slots, and find related channels. These requests go only to youtube.com and carry no
> account credentials.
>
> Your settings and a cache of channel statistics are stored in your browser. Settings sync
> across your Chrome profile via Chrome's own sync; the cache stays on your device.
>
> If the "Similar Channels" feature is enabled, the extension sends the handle of channels
> you open, and the handles of channels YouTube recommends beside videos you watch, to its
> channel-index service. This builds a shared index of which channels resemble one another.
> No account identifiers, video titles from your viewing, or personally identifying
> information are sent, and the index stores relationships between channels rather than
> anything about people. Disabling the feature in the extension's popup stops this
> completely.
>
> No data is sold or shared with third parties. No advertising or tracking libraries are
> included, and the extension contains no remotely loaded code.
>
> Questions: <your contact address>
