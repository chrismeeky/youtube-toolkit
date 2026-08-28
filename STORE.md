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

**YouTube Toolkit adds the numbers you actually research with, directly on YouTube.**

**Copy clean text.** Select any videos on a page and copy their titles, view counts, dates,
channels and URLs — as plain lines, bullets, Markdown, CSV, JSON, or your own template.

**See performance in context.** Every thumbnail carries an outlier score (a video's views
against its own channel's lifetime average) and views per hour. Watch pages add engagement
rate and an earnings estimate based on the video's category and length.

**Check monetization.** A badge reads recent videos for ad slots and reports Monetized, Not
monetized, Not eligible, or Unknown. Channels under YouTube's 1,000-subscriber requirement
are settled without guessing.

**Find similar channels.** A Similar Channels tab lists channels like the one you are
viewing, with subscribers, average views, uploads per month, age and last upload — sortable,
with presets for outliers, low-subscriber/high-view channels, and new channels. Small
channels appear beside large ones, which is the point: a 1,000-subscriber channel in your
niche is invisible to search but visible here.

**Grab transcripts and thumbnails.** One click for a video's transcript, and thumbnail
downloads at the best resolution available.

Nothing is overlaid on thumbnails, nothing autoplays, and every feature can be switched off
in the popup.

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
