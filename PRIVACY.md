# YouTube Toolkit — Privacy Policy

_Last updated: 28 August 2026_

YouTube Toolkit shows statistics about YouTube channels and videos on the YouTube pages you
are already viewing, and helps you copy that information as text. There is no account, no
sign-in and no payment, so there is nothing for us to attach data to.

This policy describes everything the extension stores and everything it sends, including the
requests it makes in the background. It is written against what the code actually does.

## What stays on your device

- **Your settings** — which figures to show, copy format, template. Stored with Chrome's
  settings sync, so they follow your Chrome profile. Nothing else is synced.
- **A cache of channel statistics** — subscriber counts, monetization results and recent
  lookups, kept so the same channel is not fetched repeatedly. Stored locally and never
  synced. Clearing it is a button in the extension's popup.

Neither is readable by us. Both disappear when you uninstall the extension.

## What is sent to YouTube

To show its figures the extension requests YouTube pages in the background, in addition to
the page you opened:

- **Channel pages**, for subscriber counts and lifetime view totals.
- **Watch pages**, to check whether recent videos carry advertising slots, and — when the
  Similar Channels result is thin — to read which channels YouTube recommends alongside a
  channel's videos.
- **Search result pages**, when looking for channels related to the one you are viewing.
- **Thumbnail images** from `i.ytimg.com`, for the thumbnail download button.

These go to YouTube and nowhere else. Some carry your existing YouTube session cookies,
because they are ordinary requests from your browser to a site you are already signed in to,
exactly as loading a YouTube page does. No credentials are read, stored or transmitted
anywhere else.

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

The index stores **relationships between channels**. It does not store a record of who
looked at what: no account identifier, no device identifier, no cookie, no profile, and no
viewing history is sent or kept. As with any web request, the service receives your IP
address in transit; it is not recorded against the data.

**Turning "Similar Channels" off in the extension's popup stops all of this completely** —
no channel is reported, no recommendations are read, and no background pages are fetched for
it. The rest of the extension continues to work.

## What is never collected

No names, email addresses, passwords or payment details. No location. No health, financial
or personal-communication data. No browsing history outside YouTube. No advertising or
analytics libraries are included, and the extension contains no remotely loaded code.

Nothing is sold, rented or shared with third parties, and nothing is used for advertising or
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
