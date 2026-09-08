-- Channel keywords, from Studio → Settings → Channel.
--
-- Why they are worth a column. The vector a channel is classified by is built from its title,
-- description and recent video titles, and all three are written for humans: titles chase
-- whatever story the channel covered this week, and descriptions are often a contact address.
-- Keywords are the one piece of channel text written FOR a classifier — YouTube's — so they
-- carry no hype and almost nothing off-topic.
--
-- Measured on @truedarkcrimes, which this index had classified as Music production because it
-- was reached through a single video title reading "Audio Enhancement Gone Wrong":
--
--   video title alone     Music production   cosine 0.272   z 2.45
--   keywords alone        True crime         cosine 0.71    z 5.46
--
-- 0.71 is higher than any fully indexed channel measured against this taxonomy, including
-- @UnrealTrueCrime at 0.634 with a description and ten video titles behind it.
--
-- They cost nothing to collect: seed.py already calls channels.list, and that endpoint bills
-- one quota unit per call however many parts are asked for, so brandingSettings is free.
--
-- Run once against the project's database:
--   psql "$DATABASE_URL" -f keywords_schema.sql

-- The raw string as YouTube returns it: space separated, multi-word phrases quoted.
-- Stored unparsed on purpose. The phrases are the signal — a channel bids on "how to build
-- muscle", not on four separate words — and re-splitting a normalised array to rebuild them
-- would be work to undo work.
alter table channels add column if not exists keywords text;

-- The blank-description channels are the ones this is meant to rescue: they are embedded from
-- title and video titles alone, which is exactly the thin signal that misclassifies. Partial,
-- because that is the only query this index serves.
create index if not exists channels_blank_desc_keywords
  on channels (fetched_at)
  where (description is null or description !~ '[^[:space:]]') and keywords is not null;
