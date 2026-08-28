# Chrome Web Store listing & privacy answers

Written against what the code does, not what it used to do. If the extension's network
behaviour changes, this file changes with it — an undisclosed request is the fastest way to
fail review, and the slowest to explain afterwards.

## Single purpose

Research YouTube channels and videos from the pages themselves: copy video details as clean
text, and show performance context — outlier score, views per hour, engagement, estimated
earnings, monetization status, and similar channels — without leaving YouTube.

## Short description (132 char limit)

> Copy video details as text, plus outlier scores, views/hour, earnings estimates,
> monetization status and similar channels.

## Detailed description

Free YouTube channel and video research, right on the page. No account, no
subscription, no trial, no limits.

The tools that do this normally cost $30-100 a month. This one is free, and
free in the way that matters: no sign-up wall, no credit card, no locked
features, no "upgrade to see the rest", no usage cap that stops you mid-task.
Install it and everything below works immediately.

WHAT IT DOES

• Copy video details as clean text — title, views, upload date, channel, URL.
  Pick which fields you want and how they're laid out.

• Outlier score — how a video's views compare to its channel's own average.
  A 1.4M-view video on a channel that averages 1.5M isn't a hit; it's typical.
  This tells you which videos actually broke out.

• Channel reach — on a channel page, how its average views compare to its
  subscriber count. A channel pulling three times its subscriber count is
  reaching well past the audience it has already earned.

• Views per hour, engagement rate, and an earnings estimate — shown together
  in a card beside the video.

• Monetization status — Monetized, Not monetized, Not eligible, or Unknown,
  on channels and on every video card.

• Similar channels — a tab on any channel page listing channels like it, with
  subscribers, average views, reach, uploads per month, age, last upload and
  monetization. Sort by any column, or filter to the ones worth finding:
  overperforming, low subscribers with high views, new channels doing big
  numbers, or channels smaller than the one you're looking at.

• One-click transcripts — copy or save the full transcript as a .txt file,
  with or without timestamps.

• Subscriber counts on thumbnails throughout the feed, search and sidebar.

• Download thumbnails at the highest resolution available.

• Multi-select mode — tick several videos and copy them all at once.
  Alt+Shift+S to toggle, Alt+Shift+C to copy.

FORMATS

Plain text, bullets, numbered lists, Markdown, CSV, JSON, or a custom template
you define. View counts can be copied as displayed (271K) or as full numbers
(271,000), and dates as relative ("23 hours ago") or absolute (2026-08-22).

HONEST ABOUT ESTIMATES

The earnings figure is your view count multiplied by an assumed RPM, adjusted
for video length. Real RPM is private to each channel and no extension can
read it, so treat that number as a rough sense of scale, not revenue. Shorts
show no estimate at all, because they're paid from a different pool entirely.

Monetization is inferred from whether recent videos carry ad slots. YouTube
also runs ads on channels that are not monetized and keeps that revenue, so
the badge is an estimate, not a status — hover it to see how many videos were
checked. "Not eligible" is the one exception: below 1,000 subscribers a
channel cannot run its own ads, and that is a fact rather than a guess.

Similar channels are ranked by how a channel describes itself and titles its
videos, and by which channels YouTube recommends alongside it. The panel says
so when the matches are weak rather than presenting a thin result as a strong
one.

WHAT LEAVES YOUR BROWSER

No accounts, no sign-in, no tracking, no analytics, and nothing is ever sold
or shared. Your settings live in your browser. Free does not mean you are the
product here — there is nothing to monetise, because there is no account to
attach anything to.

To show its figures the extension reads the page you are on and requests
YouTube pages in the background — channel pages and watch pages for
subscriber counts and ad slots, and search results when looking for related
channels. Those go to youtube.com only and carry no account credentials.

The Similar Channels feature uses a shared channel index. While it is on, the
handle of a channel page you open, and the channels YouTube recommends beside
a video you watch, are sent to that index so it can learn which channels
resemble one another. No account identifiers, no viewing history and no
personal information are sent, and the index stores relationships between
channels rather than anything about people.

Turning "Similar Channels" off in the popup stops all of that completely.

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
