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

> Free YouTube niche research. Find similar channels, filter results by size and outlier
> score, and read any channel's analytics.

## Detailed description

Free YouTube niche research, on the page you are already looking at. There is
no account to create and no subscription to buy.

Nothing is held back behind a sign-up or an upgrade prompt. Install it and
everything described below works straight away, for as long as you use it.

FIND THE CHANNELS YOU ARE COMPETING WITH

Open any channel and a Similar Channels tab lists the ones like it, ranked by
how closely they match. Each row shows how large the channel is, how many
views its videos average, how far it reaches past its own subscriber count,
how often it posts, how old it is and when it last uploaded.

Sort by any of those, or narrow the list to the channels worth finding:
the ones overperforming their size, the ones with small followings and large
view counts, the recent arrivals already doing big numbers, or simply
everything smaller than the channel you are on.

That last one is the point of the whole thing. A search shows you the biggest
channels in a subject. This shows you the ones just below them, including
channels with a few hundred subscribers that no search result would ever
surface.

TURN A SEARCH INTO A SHORTLIST

Search YouTube for a subject and scroll as far as you care to. The Filter
button in the header then takes everything the page has loaded and lets you
narrow it down. Set a range for how many subscribers a channel has or how
many views a video got, choose how recently it went up, or keep only long
form or only shorts. Sort by whichever of those matters.

YouTube cannot sort its own results by how big a channel is, or by how a video
did against that channel's average. This can, and it does it instantly,
because every figure was already on the page.

READ A CHANNEL BEFORE YOU COMMIT TO ITS NICHE

An Analytics tab on any channel estimates what it earns and shows what it
publishes. You get the views its recent uploads have taken and what those
are worth at the reference rate for its subject. You get how its long-form
views compare with its shorts. You get how often it posts and how long its
videos run, how old the channel is, and what an average video does on it.

JUDGE A VIDEO AT A GLANCE

Every thumbnail carries an outlier score, which compares a video's views with
its own channel's average. A video with 1.4M views on a channel that averages
1.5M is not a hit; it is a normal day. Views per hour sits beside it, and on a
watch page you also get engagement rate and an earnings estimate.

A monetization badge reads recent videos for advertising slots and reports
whether ads appear to be running. Hover it and you get the breakdown: not just
whether the channel earns, but how. It separates advertising from sponsorship
deals, from affiliate links, from products it sells and from viewer donations,
and shows you the line in the description that each one was read from.

MORE FEATURES

Copy the details of any video as clean text. You choose which parts you want
and how they are laid out. Copy as plain text, or as a bulleted or numbered
list. There is a Markdown option for pasting into documents and a CSV option
for spreadsheets, and JSON if you are feeding the output into something else.
If none of those suit you, write your own template and it will follow it.

View counts can come out the way YouTube shows them (271K) or as whole numbers
for sorting (271,000), and dates can stay relative or become calendar dates.

Take a transcript in one click, copied or saved as a file, with timestamps or
without. Download any thumbnail at the best resolution available. See
subscriber counts on thumbnails as you browse. Select several videos at once
and copy them together, with Alt+Shift+S to turn selection on and Alt+Shift+C
to copy what you have picked.

HONEST ABOUT ESTIMATES

The earnings figure is a view count multiplied by a reference rate for the
channel's subject, adjusted for video length and for the time of year, since
advertising is dearer in December than in January. Real rates are private to
each channel and no extension can read them. Audience country moves them
further than subject does, and that is not something a public page reveals, so
treat the number as a sense of scale rather than as revenue. Shorts show no
estimate at all, because they are paid from a different pool.

Monetization is inferred from whether recent videos carry advertising slots.
YouTube also runs ads on channels that are not monetized and keeps that
revenue, so the badge is an estimate rather than a status. Hover it to see how
many videos were checked. The one exception is a channel below 1,000
subscribers, which cannot run its own ads at all, and that is a fact rather
than a guess.

Similar channels are ranked by how a channel describes itself and titles its
videos, and by which channels YouTube recommends alongside it. When the
matches are weak the panel says so, rather than presenting a thin result as a
strong one.

WHAT LEAVES YOUR BROWSER

There are no accounts and no sign-in. Nothing is tracked and no analytics are
collected. Nothing is ever sold or shared. Your settings stay in your browser,
and free does not mean you are the product here, because there is no account
for anything to be attached to.

To produce its figures the extension reads the page you are on and requests
YouTube pages in the background. It reads channel pages and watch pages for
subscriber counts and advertising slots, and search results when it is looking
for related channels. Those requests go to YouTube and nowhere else, and carry
no account credentials.

Finding similar channels relies on a shared index of public channel
information. While that feature is switched on, the extension tells the index
which channel page you have opened and which channels YouTube recommended
beside a video you watched, so it can learn which channels resemble one
another. No account identifier and no viewing history is sent, and the index
holds relationships between channels rather than anything about people.

Switching "Similar Channels" off in the popup stops all of that.

## Permission justifications

| Permission | Why it is needed |
| --- | --- |
| `storage` | Saves your settings and caches subscriber counts and monetization results so the same channel is not looked up repeatedly. |
| `clipboardWrite` | Copying video details to the clipboard is the extension's primary function. |
| `downloads` | Saving a thumbnail image or a transcript as a file, only when you click those buttons. |
| `https://*.youtube.com/*` | Reads the YouTube pages you are on to find video cards and channel details, and fetches YouTube pages in the background to look up subscriber counts, ad slots, and related channels. |
| `https://i.ytimg.com/*` | Fetches thumbnail images for the download button, walking down resolutions until one exists. |

### Host permission justification (paste into the dashboard)

> The extension runs only on YouTube. It reads the page you are viewing to draw its
> statistics onto it, and requests other YouTube pages in the background to produce those
> figures: channel pages for subscriber counts, lifetime view totals and the date a channel
> was created; watch pages to check whether recent videos carry advertising slots and to read
> their descriptions for sponsorships, affiliate links, products and donations; and search
> results when looking for channels related to the one being viewed. i.ytimg.com is YouTube's
> thumbnail host, requested only for the thumbnail download button.
>
> The extension also sends channel handles to its own service at
> youtube-toolkit-ox3k.onrender.com, which finds similar channels. No host permission is
> requested for that, as the service permits cross-origin requests directly. No other host is
> contacted.

The backend is named deliberately. It takes no host permission, because the service sends
permissive CORS headers — but a reviewer watching network traffic sees a host the old
justification implied did not exist, and an unexplained one is worse than a declared one.

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
> Questions: nwodochristian@gmail.com
