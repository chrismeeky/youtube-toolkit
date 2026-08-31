-- Velocity sampling: what a view count was, and when.
--
-- Nothing here is derived. The tables store raw counts at known times; every rate the panel
-- shows is the difference between two of those rows. That is the whole point of the design —
-- the figure the cards already carry (views / age since publish) is a lifetime average, and
-- plotting it against publish date invents a downward slope on every keyword ever searched,
-- because the denominator grows whether or not interest changes.
--
-- Run once against the project's database:
--   psql "$DATABASE_URL" -f velocity_schema.sql

-- Every video whose count is being followed, whatever put it here.
create table if not exists tracked_videos (
  id            text primary key,                     -- YouTube video id
  first_seen    timestamptz not null default now(),
  last_sampled  timestamptz
);

-- Which videos stand for a keyword, and when that set was decided.
--
-- The set is pinned to a resolution rather than re-read every sample. Search rankings move on
-- their own, and taking "whatever is top-50 right now" each hour makes a video sliding down
-- the page look identical to its views disappearing — the series would then be measuring
-- YouTube's ranking churn while claiming to measure interest in the topic.
create table if not exists keyword_videos (
  keyword      text        not null,
  video_id     text        not null,
  resolved_at  timestamptz not null default now(),
  rank         int,
  primary key (keyword, video_id, resolved_at)
);

-- One row per video per sample.
create table if not exists video_samples (
  video_id    text        not null,
  sampled_at  timestamptz not null default now(),
  views       bigint      not null,
  primary key (video_id, sampled_at)
);

create index if not exists video_samples_video on video_samples (video_id, sampled_at);
create index if not exists video_samples_time  on video_samples (sampled_at desc);
create index if not exists keyword_videos_kw    on keyword_videos (keyword, resolved_at desc);
create index if not exists tracked_videos_stale on tracked_videos (last_sampled nulls first);
