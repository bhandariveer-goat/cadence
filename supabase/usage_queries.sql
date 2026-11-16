-- Reading the usage counts. Paste into Supabase > SQL editor; nothing here
-- changes anything. See docs/VALUE_PROPOSITION_AND_FTUE.md for what each
-- number means and how far to trust it.
--
-- "Active" means the browser sent its daily "active" word on that day: someone
-- opened Cadence and used it. There is no time-spent number on purpose (see the
-- doc); days active is the measure.

-- 1. Retention by sign-up day: of the installs first seen on a day, how many
--    were active again exactly 1, 7 and 30 days later. A cohort is shown only
--    once it is old enough for the column (otherwise the column is empty).
with first_seen as (
  select install_id, min(day) as d0 from usage_events where event = 'active' group by install_id
)
select
  f.d0 as first_day,
  count(*) as installs,
  case when f.d0 <= current_date - 1  then round(100.0 * count(*) filter (where exists (select 1 from usage_events a where a.install_id = f.install_id and a.event = 'active' and a.day = f.d0 + 1))  / count(*), 1) end as d1_pct,
  case when f.d0 <= current_date - 7  then round(100.0 * count(*) filter (where exists (select 1 from usage_events a where a.install_id = f.install_id and a.event = 'active' and a.day = f.d0 + 7))  / count(*), 1) end as d7_pct,
  case when f.d0 <= current_date - 30 then round(100.0 * count(*) filter (where exists (select 1 from usage_events a where a.install_id = f.install_id and a.event = 'active' and a.day = f.d0 + 30)) / count(*), 1) end as d30_pct
from first_seen f
group by f.d0
order by f.d0 desc;

-- 2. Daily active installs, and stickiness (daily active / active in the last 30 days).
with days as (select generate_series(current_date - 29, current_date, interval '1 day')::date as day)
select
  d.day,
  (select count(distinct install_id) from usage_events u where u.event = 'active' and u.day = d.day) as dau,
  (select count(distinct install_id) from usage_events u where u.event = 'active' and u.day between d.day - 29 and d.day) as mau_30d,
  round(100.0 * (select count(distinct install_id) from usage_events u where u.event = 'active' and u.day = d.day)
        / nullif((select count(distinct install_id) from usage_events u where u.event = 'active' and u.day between d.day - 29 and d.day), 0), 1) as stickiness_pct
from days d
order by d.day desc;

-- 3. Activation: of the installs first seen at least 7 days ago, the share that
--    had work in a plan (an assignment or an activity) within 7 days of the
--    first day. This is the first-run "did it become useful" number.
with first_seen as (
  select install_id, min(day) as d0 from usage_events where event = 'active' group by install_id
)
select
  count(*) as installs_at_least_7_days_old,
  count(*) filter (where exists (select 1 from usage_events w where w.install_id = f.install_id and w.event = 'has_work' and w.day <= f.d0 + 7)) as had_work_in_7_days,
  round(100.0 * count(*) filter (where exists (select 1 from usage_events w where w.install_id = f.install_id and w.event = 'has_work' and w.day <= f.d0 + 7)) / nullif(count(*), 0), 1) as activation_pct
from first_seen f
where f.d0 <= current_date - 7;

-- 4. The first-run funnel: how many installs reached each step, ever.
select event, count(distinct install_id) as installs
from usage_events
group by event
order by case event when 'active' then 1 when 'onboarded' then 2 when 'connected' then 3 when 'has_work' then 4 when 'checked_in' then 5 end;

-- 5. Do the people who check in once come back more? Retention at day 7 for
--    installs that had work in the plan versus those that did not.
with first_seen as (
  select install_id, min(day) as d0 from usage_events where event = 'active' group by install_id
)
select
  exists (select 1 from usage_events w where w.install_id = f.install_id and w.event = 'has_work' and w.day <= f.d0 + 7) as had_work_in_7_days,
  count(*) as installs,
  round(100.0 * count(*) filter (where exists (select 1 from usage_events a where a.install_id = f.install_id and a.event = 'active' and a.day = f.d0 + 7)) / count(*), 1) as d7_pct
from first_seen f
where f.d0 <= current_date - 7
group by 1;
