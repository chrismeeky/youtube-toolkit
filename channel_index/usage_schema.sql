-- Anonymous feature-usage statistics, written by the extension's /usage endpoint.
--
-- install_id is a random UUID the extension makes for itself. It is not derived from the
-- user, the browser profile or any YouTube account, and it cannot be linked back to one.
--
-- Run once against the project's database:
--   psql "$DATABASE_URL" -f usage_schema.sql

create table if not exists usage_installs (
  install_id  text primary key,
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  version     text,
  settings    jsonb not null default '{}'::jsonb      -- { showSubs: true, showPockets: false, ... }
);

-- Running total of times a feature was opened, per install per day. The extension sends the
-- day's cumulative count, so a repeated upload overwrites instead of double counting.
create table if not exists usage_daily (
  install_id  text   not null,
  day         date   not null,
  feature     text   not null,
  n           int    not null,
  primary key (install_id, day, feature)
);
create index if not exists usage_daily_day on usage_daily (day);

-- No policies: the anon key (public, shipped in web apps) can read nothing here. The index
-- service uses the service-role key, which bypasses row-level security.
alter table usage_installs enable row level security;
alter table usage_daily enable row level security;
