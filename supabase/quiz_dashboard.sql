-- ============================================================
-- Harmonium Evolution quiz dashboard
-- Run this ONCE in Supabase -> SQL Editor (project "quiz").
-- Safe to run again: everything is "if not exists" / "or replace".
-- ============================================================

-- 1) Anonymous quiz events. No email, no name, not linked to quiz_leads.
create table if not exists public.quiz_events (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  sid          text not null,          -- random session id from the browser
  ev           text not null,          -- view | q | email | submit
  step         int,                    -- question number (1..11) when ev = 'q'
  route        text,                   -- A | B | D, only when ev = 'submit'
  qualified    boolean,                -- only when ev = 'submit'
  device       text,                   -- mobile | desktop
  utm_source   text,
  utm_campaign text,
  utm_content  text
);
create index if not exists quiz_events_created_idx on public.quiz_events (created_at);
create index if not exists quiz_events_sid_idx     on public.quiz_events (sid);

-- The quiz writes with the public anon key, so: insert only, nothing else.
alter table public.quiz_events enable row level security;
drop policy if exists "quiz anon insert" on public.quiz_events;
create policy "quiz anon insert" on public.quiz_events
  for insert to anon
  with check (ev in ('view','q','email','submit'));
-- (no select/update/delete policy for anon: reading happens through the
--  stats Function with the service key, which bypasses RLS)

-- 2) One function that returns everything the dashboard shows, as JSON.
--    p_days = 7 / 14 / 30, or null for all time.
create or replace function public.quiz_stats(p_days int default null)
returns json
language sql
stable
set search_path = public
as $$
with since as (
  select case when p_days is null then timestamptz '-infinity'
              else now() - make_interval(days => p_days) end as t
),
ev as (
  select e.*, (e.created_at at time zone 'Europe/Amsterdam')::date as day
  from quiz_events e, since where e.created_at >= since.t
),
ld as (
  select l.*, (l.created_at at time zone 'Europe/Amsterdam')::date as day
  from quiz_leads l, since where l.created_at >= since.t
),
-- funnel: step 0 = page view, 1..11 = question answered, 100 = email step seen, 101 = submitted
steps as (
  select sid,
         case ev when 'view' then 0
                 when 'q'    then step
                 when 'email' then 100
                 when 'submit' then 101 end as step
  from ev
),
funnel as (
  select step, count(distinct sid) as n
  from steps where step is not null
  group by step
),
starts as (
  select * from ev where ev = 'q' and step = 1
),
daily_starts as (
  select day, count(distinct sid) as n from starts group by day
),
daily_submits as (
  select day, count(*) as n, count(*) filter (where qualified) as q from ld group by day
),
daily as (
  select coalesce(s.day, l.day) as day,
         coalesce(s.n, 0) as starts,
         coalesce(l.n, 0) as submits,
         coalesce(l.q, 0) as qualified
  from daily_starts s full outer join daily_submits l on s.day = l.day
),
ad_starts as (
  select coalesce(nullif(utm_content, ''), '(no utm_content)') as ad, count(distinct sid) as n
  from starts group by 1
),
ad_leads as (
  select coalesce(nullif(utm_content, ''), '(no utm_content)') as ad,
         count(*) as submits, count(*) filter (where qualified) as qualified
  from ld group by 1
),
by_ad as (
  select coalesce(a.ad, l.ad) as ad,
         coalesce(a.n, 0) as starts,
         coalesce(l.submits, 0) as submits,
         coalesce(l.qualified, 0) as qualified
  from ad_starts a full outer join ad_leads l on a.ad = l.ad
),
dev_starts as (
  select coalesce(device, 'unknown') as device, count(distinct sid) as n from starts group by 1
),
dev_submits as (
  select coalesce(device, 'unknown') as device, count(distinct sid) as n
  from ev where ev = 'submit' group by 1
),
by_device as (
  select coalesce(s.device, u.device) as device, coalesce(s.n, 0) as starts, coalesce(u.n, 0) as submits
  from dev_starts s full outer join dev_submits u on s.device = u.device
),
routes as (
  select coalesce(route, '?') as route, count(*) as n, count(*) filter (where qualified) as qualified
  from ld group by 1
),
consent as (
  select coalesce(consent_region, 'unknown') as region,
         email_consent,
         count(*) as n
  from ld group by 1, 2
)
select json_build_object(
  'days', p_days,
  'generated_at', now(),
  'totals', json_build_object(
    'views',     (select count(distinct sid) from ev where ev = 'view'),
    'starts',    (select count(distinct sid) from starts),
    'submits',   (select count(*) from ld),
    'qualified', (select count(*) filter (where qualified) from ld),
    'advanced',  (select count(*) filter (where advanced) from ld)
  ),
  'funnel',    (select coalesce(json_agg(json_build_object('step', step, 'n', n) order by step), '[]'::json) from funnel),
  'daily',     (select coalesce(json_agg(json_build_object('day', day, 'starts', starts, 'submits', submits, 'qualified', qualified) order by day), '[]'::json) from daily),
  'by_ad',     (select coalesce(json_agg(json_build_object('ad', ad, 'starts', starts, 'submits', submits, 'qualified', qualified) order by starts desc, submits desc), '[]'::json) from by_ad),
  'by_device', (select coalesce(json_agg(json_build_object('device', device, 'starts', starts, 'submits', submits) order by starts desc), '[]'::json) from by_device),
  'routes',    (select coalesce(json_agg(json_build_object('route', route, 'n', n, 'qualified', qualified) order by route), '[]'::json) from routes),
  'consent',   (select coalesce(json_agg(json_build_object('region', region, 'email_consent', email_consent, 'n', n) order by region, email_consent), '[]'::json) from consent)
);
$$;

-- Only the service key (used by the stats Function) may call it.
revoke execute on function public.quiz_stats(int) from public, anon, authenticated;
grant  execute on function public.quiz_stats(int) to service_role;
