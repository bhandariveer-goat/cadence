-- How students use Cadence, from the anonymous usage data (lib/metrics.js,
-- src/panel/insight.js). Paste one report at a time into Supabase > SQL
-- editor and run it; each starts with a line saying what it answers. The
-- "Chart" tab beside the results draws any of them.
--
-- Every number is an estimate: anyone can send these records, and someone
-- who turned usage data off is not in them. Nothing here can say who anyone
-- is: an "install" is one browser's random ID.
--
-- Times are in seconds unless a column says otherwise. Change the 30 in
-- "interval '30 days'" to look further back (records are kept 180 days).


-- 1. Sign-up screen: how many people see it, start typing, send it, and get in.
--    Counted per day with no ID, so these are visits to the screen, not people.
select name as step, sum(count) as times
from funnel_counts
where day >= current_date - 30
group by name
order by case name when 'signin:shown' then 1 when 'signin:started' then 2 when 'signin:submitted' then 3 when 'signin:done' then 4 end;


-- 2. Setup: how many installs reach each step, from starting setup to finishing it.
--    setup:activities:skip means they pressed "Skip for now" on the activities screen.
select name as step, count(distinct install_id) as installs
from ux_events
where kind = 'step' and name like 'setup:%' and at >= now() - interval '30 days'
group by name
order by installs desc;


-- 3. Setup: how long it takes to finish, from first seeing it (seconds).
select count(*) as finished,
  round(percentile_cont(0.5) within group (order by value)::numeric, 0) as median_seconds,
  round(percentile_cont(0.75) within group (order by value)::numeric, 0) as slowest_quarter_from,
  max(value) as longest
from ux_events
where kind = 'step' and name = 'setup:done' and at >= now() - interval '30 days';


-- 4. The tour: shown, finished and skipped. A high skip share means it is too long or in the way.
select
  count(distinct install_id) filter (where name = 'tour:shown') as shown,
  count(distinct install_id) filter (where name = 'tour:done') as finished,
  count(distinct install_id) filter (where name = 'tour:skip') as skipped,
  round(100.0 * count(distinct install_id) filter (where name = 'tour:skip')
        / nullif(count(distinct install_id) filter (where name = 'tour:shown'), 0), 1) as skip_pct
from ux_events
where kind = 'step' and name like 'tour:%' and at >= now() - interval '30 days';


-- 5. The tour: which stop people skip from (1 is the first of six).
select value + 1 as skipped_at_stop, count(*) as times
from ux_events
where kind = 'step' and name = 'tour:skip' and at >= now() - interval '30 days'
group by value
order by value;


-- 6. Where time goes: time spent on each screen while it is being used (a
--    screen left alone for a minute stops counting), and how long a typical stay is.
select screen_name as screen,
  round(sum(value) / 60000.0, 1) as total_minutes,
  round(100.0 * sum(value) / nullif(sum(sum(value)) over (), 0), 1) as share_pct,
  count(*) as stays,
  round((percentile_cont(0.5) within group (order by value) / 1000.0)::numeric, 1) as median_stay_seconds,
  count(distinct install_id) as installs
from (select install_id, name as screen_name, value from ux_events
      where kind = 'screen' and at >= now() - interval '30 days') s
group by screen_name
order by total_minutes desc;


-- 7. What gets pressed: each control, by its name in Cadence's code, on each screen.
select screen, name as control, count(*) as presses, count(distinct install_id) as installs
from ux_events
where kind = 'click' and at >= now() - interval '30 days'
group by screen, name
order by presses desc
limit 100;


-- 8. What hardly gets pressed: the same, least used first. A control missing
--    from both lists was never pressed at all.
select name as control, count(*) as presses, count(distinct install_id) as installs
from ux_events
where kind = 'click' and at >= now() - interval '30 days'
group by name
order by presses asc
limit 40;


-- 9. Presses on things that are not buttons: people expecting something to
--    happen that does not. The name is the kind of element and its style name.
select screen, name as pressed_on, count(*) as presses, count(distinct install_id) as installs
from ux_events
where kind = 'dead_click' and at >= now() - interval '30 days'
group by screen, name
order by presses desc
limit 50;


-- 10. Quick repeated presses (three or more within a second on the same
--     thing): something looked frozen or did not respond.
select screen, name as control, count(*) as bursts, count(distinct install_id) as installs
from ux_events
where kind = 'rage_click' and at >= now() - interval '30 days'
group by screen, name
order by bursts desc;


-- 11. Errors, and how many came in a student's first five minutes.
with first_seen as (select install_id, min(at) as t0 from ux_events group by install_id)
select e.name as error, count(*) as times,
  count(*) filter (where e.at < f.t0 + interval '5 minutes') as in_first_5_minutes,
  count(distinct e.install_id) as installs
from ux_events e join first_seen f using (install_id)
where e.kind = 'error' and e.at >= now() - interval '30 days'
group by e.name
order by times desc;


-- 12. First-impression crash rate: the share of new installs that hit any
--     error in their first five minutes.
with first_seen as (select install_id, min(at) as t0 from ux_events group by install_id having min(at) >= now() - interval '30 days')
select count(*) as new_installs,
  count(*) filter (where exists (select 1 from ux_events e where e.install_id = f.install_id and e.kind = 'error' and e.at < f.t0 + interval '5 minutes')) as with_early_error,
  round(100.0 * count(*) filter (where exists (select 1 from ux_events e where e.install_id = f.install_id and e.kind = 'error' and e.at < f.t0 + interval '5 minutes')) / nullif(count(*), 0), 1) as pct
from first_seen f;


-- 13. Speed: how long the app takes to open, and how long each of Cadence's
--     own requests takes (milliseconds). A name ending in :fail is one that failed.
select name as what, count(*) as times,
  round(percentile_cont(0.5) within group (order by value)::numeric, 0) as median_ms,
  round(percentile_cont(0.9) within group (order by value)::numeric, 0) as slowest_tenth_from_ms
from ux_events
where kind = 'timing' and at >= now() - interval '30 days'
group by name
order by times desc;


-- 14. Time to value: from first opening Cadence (after agreeing to the terms)
--     to each first milestone, such as the first assignment (has_work).
select name as milestone, count(*) as installs,
  round((percentile_cont(0.5) within group (order by value) / 60.0)::numeric, 1) as median_minutes,
  round((percentile_cont(0.75) within group (order by value) / 60.0)::numeric, 1) as slowest_quarter_from_minutes
from ux_events
where kind = 'milestone' and at >= now() - interval '90 days'
group by name
order by installs desc;


-- 15. Looking for the "aha" moment: for each thing a student did on their
--     first day, how many of those who did it came back in their second week,
--     against those who did not. Big gaps are worth steering new students to.
--     Needs installs at least 14 days old; shown once at least 5 did it.
with first_day as (
  select install_id, min(day) as d0 from usage_events where event = 'active'
  group by install_id having min(day) <= current_date - 14
),
kept as (
  select f.install_id, f.d0,
    exists (select 1 from usage_events u where u.install_id = f.install_id and u.event = 'active' and u.day between f.d0 + 7 and f.d0 + 13) as came_back
  from first_day f
),
did as (
  select distinct e.install_id, e.kind || ':' || e.name as action
  from ux_events e join kept k using (install_id)
  where e.kind in ('click', 'milestone') and e.at < (k.d0 + 1)::timestamptz
)
select d.action, count(*) as did_it,
  round(100.0 * avg(k.came_back::int), 1) as came_back_pct_if_did,
  (select round(100.0 * avg(k2.came_back::int), 1) from kept k2
    where not exists (select 1 from did d2 where d2.install_id = k2.install_id and d2.action = d.action)) as came_back_pct_if_not
from did d join kept k using (install_id)
group by d.action
having count(*) >= 5
order by avg(k.came_back::int) desc, did_it desc;


-- 16. Where interest runs out: for installs not seen for 7 days or more, the
--     screen they were last on and the last thing they did.
with last_seen as (
  select distinct on (install_id) install_id, screen, kind, name, at
  from ux_events
  order by install_id, at desc, seq desc
)
select coalesce(screen, '(no screen)') as last_screen, kind || ':' || name as last_thing, count(*) as installs
from last_seen
where at < now() - interval '7 days' and at >= now() - interval '90 days'
group by 1, 2
order by installs desc
limit 40;


-- 17. Visits: how long a visit lasts while being used, and visits per install.
select count(*) as visits,
  count(distinct install_id) as installs,
  round(count(*)::numeric / nullif(count(distinct install_id), 0), 1) as visits_per_install,
  round((percentile_cont(0.5) within group (order by value) / 60000.0)::numeric, 1) as median_minutes
from ux_events
where kind = 'session' and name = 'end' and at >= now() - interval '30 days';


-- 18. Day 1 retention: of installs first seen on a day, how many came back
--     the next day. (supabase/usage_queries.sql has day 7 and day 30 too.)
with first_seen as (select install_id, min(day) as d0 from usage_events where event = 'active' group by install_id)
select count(*) as installs,
  count(*) filter (where exists (select 1 from usage_events a where a.install_id = f.install_id and a.event = 'active' and a.day = f.d0 + 1)) as came_back_next_day,
  round(100.0 * count(*) filter (where exists (select 1 from usage_events a where a.install_id = f.install_id and a.event = 'active' and a.day = f.d0 + 1)) / nullif(count(*), 0), 1) as d1_pct
from first_seen f
where f.d0 between current_date - 30 and current_date - 1;
