-- Transcript-based embeddings for channels whose text says nothing about them.
--
-- Why this exists: about 7% of indexed channels have an empty description, so their vector is
-- built from the channel title plus recent video titles alone. On a shorts channel those
-- titles are hashtag soup, and the resulting vector is not near anything in particular —
-- @valorreviews scored 0.394 against its own best topic, with a 0.044 margin over the runner
-- up, which is how it came to sit in a list of six unrelated channels at a confident-looking
-- 0.55-0.61.
--
-- What captions fix, and what they do not: embedded one video at a time, transcripts classify
-- sharply (a $40-trillion-debt short hits "economics" at 0.527 where its title reached 0.174).
-- But a channel with no single subject stays scattered however well each video is read, and
-- the aggregate is then worse than useless because it looks precise. So both numbers are
-- stored: the vector, and how much the videos behind it agreed with each other.
--
-- Run once against the project's database:
--   psql "$DATABASE_URL" -f coherence_schema.sql

-- Mean pairwise cosine between a channel's own per-video transcript vectors, 0..1.
-- Measured separation, eight videos each: a mixed channel 0.250 (min 0.091, max 0.452) against
-- a single-subject cooking channel 0.674 (min 0.571, max 0.802) — the ranges do not overlap,
-- which is what makes a fixed floor safe to draw between them.
alter table channels add column if not exists topic_coherence real;

-- Which text the stored vector came from: 'titles' (the default path) or 'transcripts'.
-- Kept so a bad batch can be found and re-run without re-embedding the whole table.
alter table channels add column if not exists embed_basis text;

-- When the transcript pass last ran. Null means never, and is what the backfill queue reads.
-- Set on failure too, so a channel whose videos have no captions is not retried forever.
alter table channels add column if not exists enriched_at timestamptz;

-- The backfill queue: description-less channels the transcript pass has not yet considered.
-- Partial, because it only ever serves this one query and the other 93% of rows are noise in it.
-- Blank is not just NULL and '': some rows hold a single newline. btrim's default strips
-- spaces only, so the predicate asks whether any non-whitespace character is present at all.
create index if not exists channels_needs_enrich
  on channels (enriched_at nulls first)
  where description is null or description !~ '[^[:space:]]';
