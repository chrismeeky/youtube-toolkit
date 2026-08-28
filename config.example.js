/* Channel-index endpoint, baked in at build time rather than typed by the user.
 *
 * Copy this file to config.js and paste the real URL, token path included:
 *     https://<service>.onrender.com/k/<ACCESS_TOKEN>
 *
 * config.js is gitignored. This repository is public, and a token committed here would be
 * scraped within minutes — the service spends YouTube quota and OpenAI credits, so that costs
 * real money. Note the token is only a speed bump either way: anyone who installs the
 * extension can read it out of the package. Rate limiting on the server is the actual
 * protection; this just keeps it off a public repo.
 *
 * Leave INDEX_API empty and Similar Channels falls back to live YouTube search, which finds
 * established channels but never small ones.
 */
self.YTCopyConfig = { INDEX_API: '' };
