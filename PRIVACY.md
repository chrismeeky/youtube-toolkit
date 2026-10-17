# YouTube Toolkit — Privacy Policy

_Last updated: 6 October 2026_

YouTube Toolkit shows statistics about YouTube channels and videos on the YouTube pages you
are already viewing, and helps you copy that information as text. There is no account, no
sign-in and no payment. It does send anonymous usage statistics, described below, which you can
turn off. (Sign-in is planned for 1 January 2027; this policy will be updated before it starts.)

This policy describes everything the extension stores and everything it sends, including the
requests it makes in the background. It is written against what the code actually does.

## What stays on your device

- **Your settings** — which figures to show, copy format, template. Stored with Chrome's
  settings sync, so they follow your Chrome profile. Nothing else is synced.
- **A cache of channel statistics** — subscriber counts, monetization results and recent
  lookups, kept so the same channel is not fetched repeatedly. Stored locally and never
  synced. Clearing it is a button in the extension's popup.

- **Thumbnail versions of videos you watch** — a fingerprint and a small (192×108) copy of a
  video's thumbnail, kept only when it differs from the last one seen, so the thumbnail
  gallery can show a change the Internet Archive never captured. Up to 300 videos; the oldest
  are dropped first. Switching off "Thumbnail card on watch pages" stops it.
- **Studio preview preferences** — the screen size, theme and view you last used in the home
  page preview, and which feature introductions you have already seen. Stored locally.

None of this is readable by us. All of it disappears when you uninstall the extension.

## What is sent to YouTube

To show its figures the extension requests YouTube pages in the background, in addition to
the page you opened:

- **Channel pages**, for subscriber counts and lifetime view totals.
- **Watch pages**, to check whether recent videos carry advertising slots, and — when the
  Similar Channels result is thin — to read which channels YouTube recommends alongside a
  channel's videos.
- **Search result pages**, when looking for channels related to the one you are viewing.
- **Thumbnail images** from `i.ytimg.com`, for the thumbnail download button.
- **When you open the home page preview in YouTube Studio:** your YouTube home page, so your
  video can be shown beside the videos YouTube recommends to you; the watch page of the video
  being previewed, for its channel name, view count and length; and, if you switch to the
  Suggested view, a search for the video's title and the watch page of the top result, for the
  videos suggested beside it. The title and thumbnail you are editing are read from the Studio
  page and shown in the preview only. They are not sent anywhere, and nothing is changed in
  Studio.

These go to YouTube and nowhere else. Some carry your existing YouTube session cookies,
because they are ordinary requests from your browser to a site you are already signed in to,
exactly as loading a YouTube page does. No credentials are read, stored or transmitted
anywhere else.

## The comment models (Hugging Face)

**Ideas from comments** can group a video's comments by meaning, using a small language model
(all-MiniLM-L6-v2, about 23 MB). Its **Feedback** tab can also read each comment's tone, using a
second model (twitter-roberta-base-sentiment-latest, about 126 MB). Neither is bundled. Each
is downloaded from Hugging Face (`huggingface.co`) only when you press its download button,
once, from one fixed version, and each file is checked against a fingerprint before it is
kept. Hugging Face sees an ordinary
download request, with no account, cookie or identifier of yours. After that the model runs
entirely on your computer: the comments it groups or scores are never sent anywhere to be
grouped or scored. The comment model can be removed from the same dialog.

The comments themselves are read from YouTube, the same way YouTube's own comment section
loads them.

## What goes to ChatGPT, Claude or Gemini

Four features build a prompt for an AI chat: **Generate titles** in the Filter, **Why did
this work?** beside an outlier score, **Ideas from comments** on a watch page, and **Ask AI** in
the Studio preview's Check panel. Nothing is sent by the extension itself. When you press the
button, it opens the chat site you chose, in a new tab, and types the prompt into the message
box for you to read and send. The prompt holds only public information about YouTube videos:
titles, view counts, dates, lengths, a video's description and tags, and (for Ideas from
comments) a sample of its public comments, plus anything you
typed into the dialog. The Studio one also includes your own video's title and the description
from the Studio form, which may not be public yet, and attaches your thumbnail beside its
neighbours'. For *Why did this work?* it also attaches one image to the message:
the public thumbnails it compares, with a copy on your clipboard. You can switch that off in the
dialog. The message is not sent until you send it, and what happens after that is between you
and that service, under its own terms and privacy policy.

## What is sent to the channel index

The **Similar Channels** feature uses a shared index of channels so that it can find small
channels that a YouTube search would never surface. While that feature is enabled, the
extension sends the following to the index service:

- **When you ask for similar channels:** the handle, ID, title, public description and up to
  ten recent video titles **of the channel you are viewing**. These are used to compute a
  topic match. They are public YouTube information about that channel, not about you.
- **When you open a channel page:** that channel's handle and ID, so it can be added to the
  index.
- **When you watch a video:** the handle of that video's channel, and the channels or video
  IDs YouTube recommended beside it, so the index learns which channels share an audience.
- **When you search YouTube with the Search companion on:** the search terms, so it can chart
  how many videos on that topic were published recently. Turning the Search companion off in
  the extension's settings stops this.

The index stores **relationships between channels**. It does not store a record of who
looked at what: no account identifier, no device identifier (the usage-statistics install ID
above is never sent with these requests), no cookie, no profile, and no
viewing history is sent or kept. As with any web request, the service receives your IP
address in transit; it is not recorded against the data.

**Turning "Similar Channels" off in the extension's popup stops all of this completely** —
no channel is reported, no recommendations are read, and no background pages are fetched for
it. The rest of the extension continues to work.

## Anonymous usage statistics

So that we know which features are worth maintaining, the extension reports, about twice a day:

- **A random install ID** the extension generates for itself. It is not derived from you, your
  browser profile or any YouTube or Google account.
- **The extension version.**
- **Which feature switches are on or off** (for example, whether "Similar Channels" is on).
- **How many times each feature was opened per day** (for example, the copy button, the
  thumbnail gallery, Pockets). Only a feature name and a number are recorded.

It never includes what you watch, search for, copy or save, any channel or video, or any text
you type. As with any web request, the service receives your IP address in transit; it is not
stored with these statistics.

**To stop it:** Toolkit settings → Privacy → "Share anonymous usage statistics". Nothing is
sent after you switch it off. Uninstalling removes the install ID from your device.

## What is sent to the Internet Archive

When you open the **thumbnail gallery** on a watch page, the extension asks the Internet
Archive (`web.archive.org`) which copies it holds of that video's thumbnail images, and
downloads a sample of them to find the earlier versions. The request names the **video ID**
and nothing else — no account, cookie or identifier of yours is sent (requests go without
credentials). It happens only when you open the gallery, and the answer is cached for three
days. The Internet Archive's own privacy policy covers what it logs.

## What is never collected

No names, email addresses, passwords or payment details. No location. No advertising identifiers. No health, financial
or personal-communication data. No browsing history outside YouTube. No third-party advertising or
analytics libraries are included (the usage statistics above go only to our own service), and the extension contains no remotely loaded code.

Nothing is sold, rented or shared with third parties (the Internet Archive request above
names only a public video ID), and nothing is used for advertising or
for any purpose unrelated to showing you these statistics.

## Retention

Data on your device lasts until you clear the cache or uninstall the extension. Channel
information in the index is kept as long as it is useful for matching, and refreshed
periodically; it describes public YouTube channels and contains no personal data.

## Changes

If the extension's data handling changes, this policy changes with it before the new
version ships.

## Contact

Questions about this policy: nwodochristian@gmail.com
