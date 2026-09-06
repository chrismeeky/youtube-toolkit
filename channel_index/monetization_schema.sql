-- Monetization observations, one row per channel per niche.
--
-- Why rows rather than a rolling average per niche. The obvious design is a single
-- monetized_rate column updated on each visit, and it is wrong three times over:
--
--   Double counting. Two channels in the same niche return overlapping similar lists — that
--   is what "same niche" means — so a channel present in five lists would move the niche
--   rate five times. Keyed on channel id, a repeat sighting overwrites rather than re-votes.
--
--   Equal weighting. A visit resolving 6 channels would count as much as one resolving 45.
--   Pooling the underlying counts weights each visit by what it actually learned.
--
--   The curve. Rate against subscriber count cannot be recovered from one scalar per niche;
--   splitting by band needs the per-channel subscriber figure kept beside the verdict.
--
-- The rate is therefore always derived, never stored: monetized / (monetized + not
-- monetized) over distinct channels. Under-1,000-subscriber channels are recorded but sit
-- outside that denominator — see state below.
--
-- Run once against the project's database:
--   psql "$DATABASE_URL" -f monetization_schema.sql

create table if not exists channel_monetization (
  channel_id   text        primary key,           -- one verdict per channel, not per sighting
  handle       text,
  -- The niche the channel was classified into when it was observed, from niche_for(). The
  -- aggregation key. Denormalised deliberately: channels.embedding can be re-embedded and
  -- the label redrawn, and a rate must stay attributable to the label it was computed under.
  niche        text        not null,
  -- 'likely-monetized' | 'likely-not' | 'not-eligible' | 'unknown', the four verdicts
  -- background.js already produces. Stored verbatim so the server never re-derives a
  -- judgement the client made from evidence the server cannot see.
  state        text        not null,
  -- Subscribers at observation time, which is the x-axis of the curve. Kept beside the
  -- verdict rather than joined from channels: the two are only comparable if they were true
  -- at the same moment, and a channel that has since grown must not move an old verdict into
  -- a new band.
  subscribers  bigint,
  -- How much evidence the verdict rests on: videos sampled, and how many carried ad slots.
  -- Not used by the rate, kept so a suspicious band can be audited rather than trusted.
  checked      int         default 0,
  with_ads     int         default 0,
  observed_at  timestamptz not null default now()
);

-- The aggregate query is always "every row for one niche", so the niche leads the index.
-- state follows it because the rate counts by state within the niche, and subscribers
-- follows that because the curve buckets by size within each state.
create index if not exists channel_monetization_niche
  on channel_monetization (niche, state, subscribers);

-- Staleness sweeps and the "last updated" line on the panel.
create index if not exists channel_monetization_seen
  on channel_monetization (observed_at desc);
