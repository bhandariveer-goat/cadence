-- Checks the "how the app is used" SQL (supabase/schema.sql) and every report
-- in supabase/ux_reports.sql against a real database, without keeping
-- anything: it ends by raising an error on purpose, which undoes it all.
-- Written by scripts/make_ux_check.py from schema.sql and ux_reports.sql (do
-- not edit it by hand); run it in Supabase > SQL editor.
--
--   Success:  ERROR: ROLLED BACK: every check passed
--   Failure:  ERROR: FAIL ... (the message says which check)

do $t$
declare
  aid uuid := '22222222-2222-4222-8222-222222222222';
  bid uuid := '33333333-3333-4333-8333-333333333333';
  cid uuid := '44444444-4444-4444-8444-444444444444';
  sid uuid := '55555555-5555-4555-8555-555555555555';
  oid uuid := '66666666-6666-4666-8666-666666666666';
  xid uuid := '77777777-7777-4777-8777-777777777777';
  ua uuid := '88888888-8888-4888-8888-888888888881';
  ub uuid := '88888888-8888-4888-8888-888888888882';
  u1 uuid := '99999999-9999-4999-8999-999999999991';
  u2 uuid := '99999999-9999-4999-8999-999999999992';
  u3 uuid := '99999999-9999-4999-8999-999999999993';
  r1 jsonb; r2 jsonb;
  n int; m numeric;
begin
create table if not exists usage_events (install_id uuid not null, day date not null default current_date, event text not null, primary key (install_id, day, event));
create table if not exists ux_events (
  install_id uuid not null,
  session_id uuid not null,
  seq integer not null check (seq between 0 and 100000),
  at timestamptz not null default now(),
  kind text not null check (kind in ('screen', 'click', 'dead_click', 'rage_click', 'step', 'error', 'timing', 'session', 'milestone')),
  name text not null check (name ~ '^[a-z0-9][a-z0-9_.:-]{0,79}$'),
  screen text check (screen is null or screen ~ '^[a-z0-9][a-z0-9_.:-]{0,79}$'),
  value integer check (value is null or value between 0 and 2000000000),
  primary key (install_id, session_id, seq)
);
create index if not exists ux_events_at on ux_events (at);
create index if not exists ux_events_kind_name on ux_events (kind, name);

-- How many rows each ID, and everyone together (the all-zero ID), has added
-- today, so one browser, or a flood of made-up IDs, cannot fill the table.
create table if not exists ux_quota (
  day date not null default current_date,
  install_id uuid not null,
  n integer not null default 0,
  primary key (day, install_id)
);

alter table ux_events enable row level security;
alter table ux_quota enable row level security;

-- Adds up to 50 records for one ID and one visit. A record that is not one of
-- the shapes above is dropped and the rest are kept.
create or replace function record_events(p_id uuid, p_session uuid, p_events jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  e jsonb;
  everyone constant uuid := '00000000-0000-0000-0000-000000000000';
  mine integer; total integer; room integer; added integer := 0; got integer;
begin
  if p_id is null or p_session is null or p_id = everyone then raise exception 'no id'; end if;
  if jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events) > 50 then raise exception 'bad batch'; end if;

  delete from ux_events where at < now() - interval '180 days';
  delete from ux_quota where day < current_date - 2;

  select coalesce((select n from ux_quota where day = current_date and install_id = p_id), 0) into mine;
  select coalesce((select n from ux_quota where day = current_date and install_id = everyone), 0) into total;
  room := least(3000 - mine, 1000000 - total);
  if room <= 0 then return; end if;

  for e in select value from jsonb_array_elements(p_events) loop
    exit when added >= room;
    if jsonb_typeof(e) is distinct from 'object' then continue; end if;
    begin
      insert into ux_events (install_id, session_id, seq, kind, name, screen, value)
      values (p_id, p_session, (e->>'q')::integer, e->>'k', e->>'n', nullif(e->>'s', ''), (e->>'v')::integer)
      on conflict do nothing;
      get diagnostics got = row_count;
      added := added + got;
    exception when others then null;
    end;
  end loop;

  if added > 0 then
    insert into ux_quota as q (day, install_id, n) values (current_date, p_id, added), (current_date, everyone, added)
    on conflict (day, install_id) do update set n = q.n + excluded.n;
  end if;
end $$;


-- --------------------------------------------------- the sign-up screen
-- Before anyone has agreed to anything, so with no ID of any kind: how many
-- times a day the sign-up screen was shown, typed in, sent, and got someone
-- in. A row is a day, one of those four names, and a number. Kept 400 days.

create table if not exists funnel_counts (
  day date not null default current_date,
  name text not null check (name in ('signin:shown', 'signin:started', 'signin:submitted', 'signin:done')),
  count integer not null default 0,
  primary key (day, name)
);
alter table funnel_counts enable row level security;

create or replace function count_steps(p_names text[]) returns void
language plpgsql security definer set search_path = public as $$
declare s text;
begin
  if p_names is null or coalesce(array_length(p_names, 1), 0) not between 1 and 4 then raise exception 'bad steps'; end if;
  delete from funnel_counts where day < current_date - 400;
  foreach s in array p_names loop
    if s is null or s not in ('signin:shown', 'signin:started', 'signin:submitted', 'signin:done') then raise exception 'bad step'; end if;
    insert into funnel_counts as f (day, name, count) values (current_date, s, 1)
    on conflict (day, name) do update set count = f.count + 1 where f.count < 1000000;
  end loop;
end $$;


-- ---------------------------------------------------- reading it: the owner
-- The records above can be read by no one with the public key. The person who
-- runs Cadence reads them as totals through insights(), which the Insights
-- page in the app calls (src/panel/views/insights.js). It answers only for an
-- account listed in owners, and only with counts, medians and names made of
-- code characters, never a row of one browser's activity. To add yourself,
-- sign in to Cadence with your email once, then in the SQL editor:
--
--   insert into owners select id from auth.users where email = 'you@example.com';
--
-- The table is granted to nobody and has no policy, so it can be changed only
-- there.

create table if not exists owners (
  user_id uuid primary key references auth.users on delete cascade
);
alter table owners enable row level security;

create or replace function insights(p_days integer default 30) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  d integer := least(greatest(coalesce(p_days, 30), 1), 180);
  since timestamptz;
begin
  if auth.uid() is null or not exists (select 1 from owners where user_id = auth.uid()) then
    raise exception 'not allowed';
  end if;
  since := now() - make_interval(days => d);

  return jsonb_build_object(
    'days', d,

    'overview', (select to_jsonb(q) from (
      select count(distinct install_id) as installs,
        count(distinct install_id) filter (where day = current_date) as active_today,
        count(distinct install_id) filter (where day >= current_date - 6) as active_7_days,
        count(distinct install_id) filter (where day >= current_date - 29) as active_30_days
      from usage_events where event = 'active') q),

    'daily', (select coalesce(jsonb_agg(to_jsonb(q) order by q.day), '[]'::jsonb) from (
      select g.day::date as day,
        (select count(distinct u.install_id) from usage_events u where u.event = 'active' and u.day = g.day::date) as active
      from generate_series(current_date - (d - 1), current_date, interval '1 day') g(day)) q),

    'retention', (select coalesce(jsonb_agg(to_jsonb(q) order by q.after_days), '[]'::jsonb) from (
      with first_seen as (select install_id, min(day) as d0 from usage_events where event = 'active' group by install_id)
      select n.after_days,
        count(*) filter (where f.d0 <= current_date - n.after_days) as installs,
        count(*) filter (where f.d0 <= current_date - n.after_days and exists (
          select 1 from usage_events a where a.install_id = f.install_id and a.event = 'active' and a.day = f.d0 + n.after_days)) as came_back
      from first_seen f cross join (values (1), (7), (30)) n(after_days)
      group by n.after_days) q),

    'signup', (select coalesce(jsonb_agg(to_jsonb(q) order by q.step_order), '[]'::jsonb) from (
      select name, sum(count)::integer as times,
        case name when 'signin:shown' then 1 when 'signin:started' then 2 when 'signin:submitted' then 3 else 4 end as step_order
      from funnel_counts where day >= current_date - (d - 1) group by name) q),

    'setup', (select coalesce(jsonb_agg(to_jsonb(q) order by q.installs desc, q.name), '[]'::jsonb) from (
      select name, count(distinct install_id)::integer as installs
      from ux_events where kind = 'step' and name like 'setup:%' and at >= since group by name) q),

    'setup_time', (select to_jsonb(q) from (
      select count(*)::integer as finished,
        round(percentile_cont(0.5) within group (order by value)::numeric, 0) as median_seconds,
        round(percentile_cont(0.9) within group (order by value)::numeric, 0) as slowest_tenth_seconds
      from ux_events where kind = 'step' and name = 'setup:done' and at >= since) q),

    'tour', (select to_jsonb(q) from (
      select count(distinct install_id) filter (where name = 'tour:shown')::integer as shown,
        count(distinct install_id) filter (where name = 'tour:done')::integer as finished,
        count(distinct install_id) filter (where name = 'tour:skip')::integer as skipped
      from ux_events where kind = 'step' and name like 'tour:%' and at >= since) q),

    'tour_skips', (select coalesce(jsonb_agg(to_jsonb(q) order by q.stop), '[]'::jsonb) from (
      select (value + 1)::integer as stop, count(*)::integer as times
      from ux_events where kind = 'step' and name = 'tour:skip' and value is not null and at >= since group by value) q),

    'screens', (select coalesce(jsonb_agg(to_jsonb(q) order by q.total_minutes desc), '[]'::jsonb) from (
      select name as screen,
        round(sum(value) / 60000.0, 1) as total_minutes,
        count(*)::integer as stays,
        round((percentile_cont(0.5) within group (order by value) / 1000.0)::numeric, 0) as median_stay_seconds,
        count(distinct install_id)::integer as installs
      from ux_events where kind = 'screen' and value is not null and at >= since group by name order by sum(value) desc limit 20) q),

    'most_pressed', (select coalesce(jsonb_agg(to_jsonb(q) order by q.presses desc, q.control), '[]'::jsonb) from (
      select name as control, count(*)::integer as presses, count(distinct install_id)::integer as installs
      from ux_events where kind = 'click' and at >= since group by name order by count(*) desc, name limit 15) q),

    'least_pressed', (select coalesce(jsonb_agg(to_jsonb(q) order by q.presses, q.control), '[]'::jsonb) from (
      select name as control, count(*)::integer as presses, count(distinct install_id)::integer as installs
      from ux_events where kind = 'click' and at >= since group by name order by count(*), name limit 10) q),

    'dead_clicks', (select coalesce(jsonb_agg(to_jsonb(q) order by q.presses desc, q.pressed_on), '[]'::jsonb) from (
      select coalesce(screen, 'none') as screen, name as pressed_on, count(*)::integer as presses, count(distinct install_id)::integer as installs
      from ux_events where kind = 'dead_click' and at >= since group by screen, name order by count(*) desc, name limit 10) q),

    'rage_clicks', (select coalesce(jsonb_agg(to_jsonb(q) order by q.bursts desc, q.control), '[]'::jsonb) from (
      select coalesce(screen, 'none') as screen, name as control, count(*)::integer as bursts, count(distinct install_id)::integer as installs
      from ux_events where kind = 'rage_click' and at >= since group by screen, name order by count(*) desc, name limit 10) q),

    'errors', (select coalesce(jsonb_agg(to_jsonb(q) order by q.times desc, q.error), '[]'::jsonb) from (
      with first_seen as (select install_id, min(at) as t0 from ux_events group by install_id)
      select e.name as error, count(*)::integer as times,
        count(*) filter (where e.at < f.t0 + interval '5 minutes')::integer as in_first_5_minutes,
        count(distinct e.install_id)::integer as installs
      from ux_events e join first_seen f using (install_id)
      where e.kind = 'error' and e.at >= since group by e.name order by count(*) desc, e.name limit 10) q),

    'early_errors', (select to_jsonb(q) from (
      with first_seen as (select install_id, min(at) as t0 from ux_events group by install_id having min(at) >= since)
      select count(*)::integer as new_installs,
        count(*) filter (where exists (select 1 from ux_events e where e.install_id = f.install_id and e.kind = 'error' and e.at < f.t0 + interval '5 minutes'))::integer as with_error
      from first_seen f) q),

    'speed', (select coalesce(jsonb_agg(to_jsonb(q) order by q.times desc, q.what), '[]'::jsonb) from (
      select name as what, count(*)::integer as times,
        round(percentile_cont(0.5) within group (order by value)::numeric, 0) as median_ms,
        round(percentile_cont(0.9) within group (order by value)::numeric, 0) as slowest_tenth_ms
      from ux_events where kind = 'timing' and value is not null and at >= since group by name order by count(*) desc, name limit 15) q),

    'value', (select coalesce(jsonb_agg(to_jsonb(q) order by q.installs desc, q.milestone), '[]'::jsonb) from (
      select name as milestone, count(*)::integer as installs,
        round((percentile_cont(0.5) within group (order by value) / 60.0)::numeric, 1) as median_minutes
      from ux_events where kind = 'milestone' and value is not null and at >= since group by name) q),

    'visits', (select to_jsonb(q) from (
      select count(*)::integer as visits, count(distinct install_id)::integer as installs,
        round((percentile_cont(0.5) within group (order by value) / 60000.0)::numeric, 1) as median_minutes
      from ux_events where kind = 'session' and name = 'end' and value is not null and at >= since) q),

    'stops', (select coalesce(jsonb_agg(to_jsonb(q) order by q.installs desc, q.last_screen), '[]'::jsonb) from (
      with last_seen as (
        select distinct on (install_id) install_id, screen, kind, name, at
        from ux_events order by install_id, at desc, seq desc)
      select coalesce(screen, 'none') as last_screen, kind || ':' || name as last_thing, count(*)::integer as installs
      from last_seen where at < now() - interval '7 days' and at >= now() - interval '90 days'
      group by 1, 2 order by count(*) desc, 1 limit 10) q)
  );
end $$;

create or replace function forget_usage(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_id is null then raise exception 'no id'; end if;
  delete from usage_events where install_id = p_id;
  delete from ux_events where install_id = p_id;
  delete from ux_quota where install_id = p_id;
end $$;

  -- 1. A good batch of three is kept.
  perform record_events(aid, sid, '[{"q":0,"k":"screen","n":"today","v":1200},{"q":1,"k":"click","n":"tab","s":"today"},{"q":2,"k":"step","n":"tour:skip","v":2}]'::jsonb);
  select count(*) into n from ux_events where install_id = aid; if n <> 3 then raise exception 'FAIL good batch: %', n; end if;
  -- 2. The same order number twice is not added again.
  perform record_events(aid, sid, '[{"q":1,"k":"click","n":"tab","s":"today"}]'::jsonb);
  select count(*) into n from ux_events where install_id = aid; if n <> 3 then raise exception 'FAIL duplicate kept: %', n; end if;
  -- 3. Bad records are dropped, the good one beside them kept.
  perform record_events(aid, sid, '[{"q":3,"k":"keystroke","n":"x"},{"q":4,"k":"click","n":"Hello world"},{"q":5,"k":"click","n":"tab","v":-1},{"q":6,"k":"click","n":"ab@c.d"},{"q":7,"k":"click","n":"tab","s":"Today Screen"},{"q":8,"k":"timing","n":"boot","v":1.5},"text",{"q":9,"k":"click","n":"ok-button"}]'::jsonb);
  select count(*) into n from ux_events where install_id = aid; if n <> 4 then raise exception 'FAIL bad records: %', n; end if;
  if not exists (select 1 from ux_events where install_id = aid and seq = 9) then raise exception 'FAIL the good record beside bad ones was dropped'; end if;
  -- 4. A batch of more than 50 is refused.
  begin perform record_events(aid, sid, (select jsonb_agg(jsonb_build_object('q', g, 'k', 'click', 'n', 'tab')) from generate_series(100, 150) g)); raise exception 'FAIL took 51'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  -- 5. No ID, or the all-zero ID that holds the day's total, is refused.
  begin perform record_events(null, sid, '[]'::jsonb); raise exception 'FAIL took no id'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform record_events('00000000-0000-0000-0000-000000000000', sid, '[]'::jsonb); raise exception 'FAIL took the total id'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform record_events(aid, sid, '{"q":1}'::jsonb); raise exception 'FAIL took a non-list'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  -- 6. One ID's day is capped at 3000 rows.
  update ux_quota set n = 2999 where day = current_date and install_id = aid;
  perform record_events(aid, sid, '[{"q":20,"k":"click","n":"tab"},{"q":21,"k":"click","n":"tab"},{"q":22,"k":"click","n":"tab"}]'::jsonb);
  select count(*) into n from ux_events where install_id = aid; if n <> 5 then raise exception 'FAIL quota: %', n; end if;
  -- 7. Old rows go after 180 days.
  insert into ux_events (install_id, session_id, seq, at, kind, name) values (bid, sid, 1, now() - interval '181 days', 'click', 'tab');
  insert into ux_events (install_id, session_id, seq, at, kind, name) values (bid, sid, 2, now() - interval '179 days', 'click', 'tab');
  perform record_events(cid, sid, '[{"q":0,"k":"click","n":"tab"}]'::jsonb);
  select count(*) into n from ux_events where install_id = bid; if n <> 1 then raise exception 'FAIL 180 days: %', n; end if;
  -- 8. Forgetting an ID removes its rows and its quota, and nobody else's.
  perform forget_usage(aid);
  select count(*) into n from ux_events where install_id = aid; if n <> 0 then raise exception 'FAIL forget left %', n; end if;
  select count(*) into n from ux_quota where install_id = aid; if n <> 0 then raise exception 'FAIL forget left quota %', n; end if;
  select count(*) into n from ux_events where install_id in (bid, cid); if n <> 2 then raise exception 'FAIL forget touched others: %', n; end if;
  -- 9. The sign-up counts: the four names only, up to four at a time, and no ID.
  perform count_steps(array['signin:shown', 'signin:started']);
  perform count_steps(array['signin:shown']);
  select count into n from funnel_counts where day = current_date and name = 'signin:shown'; if n <> 2 then raise exception 'FAIL steps count: %', n; end if;
  begin perform count_steps(array['signin:email']); raise exception 'FAIL took a bad step'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform count_steps(array['signin:shown','signin:shown','signin:shown','signin:shown','signin:shown']); raise exception 'FAIL took 5 steps'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform count_steps(array[]::text[]); raise exception 'FAIL took none'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  -- 10. Every report runs on this data without an error.

  -- 11. insights(): only an owner may read it, and only totals.
  --     (The checks of the top-of-the-list answers assume the tables are
  --     nearly empty, so they add 600 records each to stay on top.)
  alter table owners drop constraint if exists owners_user_id_fkey;
  insert into owners values (oid);
  perform set_config('request.jwt.claims', '', true);
  begin perform insights(30); raise exception 'FAIL insights answered with no sign-in'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  perform set_config('request.jwt.claims', json_build_object('sub', xid)::text, true);
  begin perform insights(30); raise exception 'FAIL insights answered someone who is not an owner'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  perform set_config('request.jwt.claims', json_build_object('sub', oid)::text, true);
  r1 := insights(30);
  if (insights(500)->>'days')::int <> 180 or (insights(0)->>'days')::int <> 1 then raise exception 'FAIL insights range is not clamped'; end if;
  if jsonb_array_length(r1->'daily') <> 30 then raise exception 'FAIL insights daily rows: %', jsonb_array_length(r1->'daily'); end if;

  insert into usage_events (install_id, day, event) values (u1, current_date - 10, 'active'), (u1, current_date - 9, 'active'), (u2, current_date - 10, 'active'), (u3, current_date, 'active');
  insert into funnel_counts (name, count) values ('signin:shown', 5) on conflict (day, name) do update set count = funnel_counts.count + 5;
  insert into ux_events (install_id, session_id, seq, at, kind, name, screen, value) values
    (ua, sid, 0, now() - interval '1 hour', 'step', 'tour:shown', 'today', null),
    (ua, sid, 1, now() - interval '1 hour', 'step', 'tour:skip', 'today', 2),
    (ua, sid, 2, now() - interval '1 hour', 'step', 'setup:zz-test', 'setup:activities', null),
    (ua, sid, 3, now() - interval '1 hour', 'step', 'setup:done', 'setup:school', 40),
    (ua, sid, 4, now() - interval '1 hour', 'screen', 'zz-test-screen', 'zz-test-screen', 120000),
    (ua, sid, 5, now() - interval '1 hour', 'screen', 'zz-test-screen', 'zz-test-screen', 120000),
    (ua, sid, 6, now() - interval '59 minutes', 'error', 'zz-error:file.js:1', 'today', 5),
    (ua, sid, 7, now() - interval '59 minutes', 'error', 'zz-error:file.js:1', 'today', 6),
    (ua, sid, 8, now() - interval '1 hour', 'timing', 'zz-api', 'today', 100),
    (ua, sid, 9, now() - interval '1 hour', 'timing', 'zz-api', 'today', 200),
    (ua, sid, 10, now() - interval '1 hour', 'timing', 'zz-api', 'today', 300),
    (ua, sid, 11, now() - interval '1 hour', 'milestone', 'zz-milestone', null, 120),
    (ua, sid, 12, now() - interval '1 hour', 'session', 'end', 'today', 180000);
  insert into ux_events (install_id, session_id, seq, kind, name, screen)
    select ua, sid, g + case k when 'click' then 1000 when 'dead_click' then 2000 else 3000 end, k,
      case k when 'click' then 'zz-test-click' when 'dead_click' then 'zz-dead' else 'zz-rage' end, 'zz-test-screen'
    from generate_series(1, 600) g, unnest(array['click', 'dead_click', 'rage_click']) k;
  insert into ux_events (install_id, session_id, seq, at, kind, name, screen) values (ub, sid, 0, now() - interval '10 days', 'click', 'zz-stop', 'zz-stop-screen');
  r2 := insights(30);

  select (r2->'overview'->>'installs')::int - (r1->'overview'->>'installs')::int into n; if n <> 3 then raise exception 'FAIL insights installs: %', n; end if;
  select (r2->'overview'->>'active_today')::int - (r1->'overview'->>'active_today')::int into n; if n <> 1 then raise exception 'FAIL insights active today: %', n; end if;
  select coalesce((select (e->>'installs')::int from jsonb_array_elements(r2->'retention') e where (e->>'after_days')::int = 1), 0) - coalesce((select (e->>'installs')::int from jsonb_array_elements(r1->'retention') e where (e->>'after_days')::int = 1), 0) into n;
  if n <> 2 then raise exception 'FAIL insights day 1 installs: %', n; end if;
  select coalesce((select (e->>'came_back')::int from jsonb_array_elements(r2->'retention') e where (e->>'after_days')::int = 1), 0) - coalesce((select (e->>'came_back')::int from jsonb_array_elements(r1->'retention') e where (e->>'after_days')::int = 1), 0) into n;
  if n <> 1 then raise exception 'FAIL insights day 1 came back: %', n; end if;
  select (select (e->>'active')::int from jsonb_array_elements(r2->'daily') e where (e->>'day')::date = current_date) - (select (e->>'active')::int from jsonb_array_elements(r1->'daily') e where (e->>'day')::date = current_date) into n;
  if n <> 1 then raise exception 'FAIL insights daily today: %', n; end if;
  select coalesce((select (e->>'times')::int from jsonb_array_elements(r2->'signup') e where e->>'name' = 'signin:shown'), 0) - coalesce((select (e->>'times')::int from jsonb_array_elements(r1->'signup') e where e->>'name' = 'signin:shown'), 0) into n;
  if n <> 5 then raise exception 'FAIL insights sign-up: %', n; end if;
  select (select (e->>'installs')::int from jsonb_array_elements(r2->'setup') e where e->>'name' = 'setup:zz-test') into n; if n is distinct from 1 then raise exception 'FAIL insights setup step: %', n; end if;
  select (r2->'setup_time'->>'finished')::int - (r1->'setup_time'->>'finished')::int into n; if n <> 1 then raise exception 'FAIL insights setup time: %', n; end if;
  select ((r2->'tour'->>'shown')::int - (r1->'tour'->>'shown')::int) * 10 + ((r2->'tour'->>'skipped')::int - (r1->'tour'->>'skipped')::int) into n; if n <> 11 then raise exception 'FAIL insights tour: %', n; end if;
  select coalesce((select (e->>'times')::int from jsonb_array_elements(r2->'tour_skips') e where (e->>'stop')::int = 3), 0) - coalesce((select (e->>'times')::int from jsonb_array_elements(r1->'tour_skips') e where (e->>'stop')::int = 3), 0) into n; if n <> 1 then raise exception 'FAIL insights tour stop: %', n; end if;
  select (e->>'total_minutes')::numeric from jsonb_array_elements(r2->'screens') e where e->>'screen' = 'zz-test-screen' into m; if m is distinct from 4.0 then raise exception 'FAIL insights screen minutes: %', m; end if;
  select (e->>'median_stay_seconds')::numeric from jsonb_array_elements(r2->'screens') e where e->>'screen' = 'zz-test-screen' into m; if m is distinct from 120 then raise exception 'FAIL insights screen stay: %', m; end if;
  select (e->>'presses')::int from jsonb_array_elements(r2->'most_pressed') e where e->>'control' = 'zz-test-click' into n; if n is distinct from 600 then raise exception 'FAIL insights most pressed: %', n; end if;
  select (e->>'presses')::int from jsonb_array_elements(r2->'dead_clicks') e where e->>'pressed_on' = 'zz-dead' into n; if n is distinct from 600 then raise exception 'FAIL insights dead clicks: %', n; end if;
  select (e->>'bursts')::int from jsonb_array_elements(r2->'rage_clicks') e where e->>'control' = 'zz-rage' into n; if n is distinct from 600 then raise exception 'FAIL insights rage clicks: %', n; end if;
  select (e->>'in_first_5_minutes')::int from jsonb_array_elements(r2->'errors') e where e->>'error' = 'zz-error:file.js:1' into n; if n is distinct from 2 then raise exception 'FAIL insights early errors: %', n; end if;
  select ((r2->'early_errors'->>'new_installs')::int - (r1->'early_errors'->>'new_installs')::int) * 10 + ((r2->'early_errors'->>'with_error')::int - (r1->'early_errors'->>'with_error')::int) into n; if n <> 21 then raise exception 'FAIL insights early error rate (two new installs, one with an error): %', n; end if;
  select (e->>'median_ms')::numeric from jsonb_array_elements(r2->'speed') e where e->>'what' = 'zz-api' into m; if m is distinct from 200 then raise exception 'FAIL insights speed: %', m; end if;
  select (e->>'median_minutes')::numeric from jsonb_array_elements(r2->'value') e where e->>'milestone' = 'zz-milestone' into m; if m is distinct from 2.0 then raise exception 'FAIL insights value: %', m; end if;
  select (r2->'visits'->>'visits')::int - (r1->'visits'->>'visits')::int into n; if n <> 1 then raise exception 'FAIL insights visits: %', n; end if;
  select (e->>'installs')::int from jsonb_array_elements(r2->'stops') e where e->>'last_screen' = 'zz-stop-screen' and e->>'last_thing' = 'click:zz-stop' into n; if n is distinct from 1 then raise exception 'FAIL insights stops: %', n; end if;
  -- Nothing a person typed or a row of one browser comes back: only these keys.
  if (select array_agg(k order by k collate "C") from jsonb_object_keys(r2) k) <> array['daily','days','dead_clicks','early_errors','errors','least_pressed','most_pressed','overview','rage_clicks','retention','screens','setup','setup_time','signup','speed','stops','tour','tour_skips','value','visits'] then
    raise exception 'FAIL insights keys: %', (select string_agg(k, ',' order by k collate "C") from jsonb_object_keys(r2) k);
  end if;
  if r2::text like '%' || ua::text || '%' or r2::text like '%' || ub::text || '%' or r2::text like '%' || u1::text || '%' then raise exception 'FAIL insights returned a random ID'; end if;

  perform count(*) from (select name as step, sum(count) as times
from funnel_counts
where day >= current_date - 30
group by name
order by case name when 'signin:shown' then 1 when 'signin:started' then 2 when 'signin:submitted' then 3 when 'signin:done' then 4 end) q;  -- report 1
  perform count(*) from (select name as step, count(distinct install_id) as installs
from ux_events
where kind = 'step' and name like 'setup:%' and at >= now() - interval '30 days'
group by name
order by installs desc) q;  -- report 2
  perform count(*) from (select count(*) as finished,
  round(percentile_cont(0.5) within group (order by value)::numeric, 0) as median_seconds,
  round(percentile_cont(0.75) within group (order by value)::numeric, 0) as slowest_quarter_from,
  max(value) as longest
from ux_events
where kind = 'step' and name = 'setup:done' and at >= now() - interval '30 days') q;  -- report 3
  perform count(*) from (select
  count(distinct install_id) filter (where name = 'tour:shown') as shown,
  count(distinct install_id) filter (where name = 'tour:done') as finished,
  count(distinct install_id) filter (where name = 'tour:skip') as skipped,
  round(100.0 * count(distinct install_id) filter (where name = 'tour:skip')
        / nullif(count(distinct install_id) filter (where name = 'tour:shown'), 0), 1) as skip_pct
from ux_events
where kind = 'step' and name like 'tour:%' and at >= now() - interval '30 days') q;  -- report 4
  perform count(*) from (select value + 1 as skipped_at_stop, count(*) as times
from ux_events
where kind = 'step' and name = 'tour:skip' and at >= now() - interval '30 days'
group by value
order by value) q;  -- report 5
  perform count(*) from (select screen_name as screen,
  round(sum(value) / 60000.0, 1) as total_minutes,
  round(100.0 * sum(value) / nullif(sum(sum(value)) over (), 0), 1) as share_pct,
  count(*) as stays,
  round((percentile_cont(0.5) within group (order by value) / 1000.0)::numeric, 1) as median_stay_seconds,
  count(distinct install_id) as installs
from (select install_id, name as screen_name, value from ux_events
      where kind = 'screen' and at >= now() - interval '30 days') s
group by screen_name
order by total_minutes desc) q;  -- report 6
  perform count(*) from (select screen, name as control, count(*) as presses, count(distinct install_id) as installs
from ux_events
where kind = 'click' and at >= now() - interval '30 days'
group by screen, name
order by presses desc
limit 100) q;  -- report 7
  perform count(*) from (select name as control, count(*) as presses, count(distinct install_id) as installs
from ux_events
where kind = 'click' and at >= now() - interval '30 days'
group by name
order by presses asc
limit 40) q;  -- report 8
  perform count(*) from (select screen, name as pressed_on, count(*) as presses, count(distinct install_id) as installs
from ux_events
where kind = 'dead_click' and at >= now() - interval '30 days'
group by screen, name
order by presses desc
limit 50) q;  -- report 9
  perform count(*) from (select screen, name as control, count(*) as bursts, count(distinct install_id) as installs
from ux_events
where kind = 'rage_click' and at >= now() - interval '30 days'
group by screen, name
order by bursts desc) q;  -- report 10
  perform count(*) from (with first_seen as (select install_id, min(at) as t0 from ux_events group by install_id)
select e.name as error, count(*) as times,
  count(*) filter (where e.at < f.t0 + interval '5 minutes') as in_first_5_minutes,
  count(distinct e.install_id) as installs
from ux_events e join first_seen f using (install_id)
where e.kind = 'error' and e.at >= now() - interval '30 days'
group by e.name
order by times desc) q;  -- report 11
  perform count(*) from (with first_seen as (select install_id, min(at) as t0 from ux_events group by install_id having min(at) >= now() - interval '30 days')
select count(*) as new_installs,
  count(*) filter (where exists (select 1 from ux_events e where e.install_id = f.install_id and e.kind = 'error' and e.at < f.t0 + interval '5 minutes')) as with_early_error,
  round(100.0 * count(*) filter (where exists (select 1 from ux_events e where e.install_id = f.install_id and e.kind = 'error' and e.at < f.t0 + interval '5 minutes')) / nullif(count(*), 0), 1) as pct
from first_seen f) q;  -- report 12
  perform count(*) from (select name as what, count(*) as times,
  round(percentile_cont(0.5) within group (order by value)::numeric, 0) as median_ms,
  round(percentile_cont(0.9) within group (order by value)::numeric, 0) as slowest_tenth_from_ms
from ux_events
where kind = 'timing' and at >= now() - interval '30 days'
group by name
order by times desc) q;  -- report 13
  perform count(*) from (select name as milestone, count(*) as installs,
  round((percentile_cont(0.5) within group (order by value) / 60.0)::numeric, 1) as median_minutes,
  round((percentile_cont(0.75) within group (order by value) / 60.0)::numeric, 1) as slowest_quarter_from_minutes
from ux_events
where kind = 'milestone' and at >= now() - interval '90 days'
group by name
order by installs desc) q;  -- report 14
  perform count(*) from (with first_day as (
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
order by avg(k.came_back::int) desc, did_it desc) q;  -- report 15
  perform count(*) from (with last_seen as (
  select distinct on (install_id) install_id, screen, kind, name, at
  from ux_events
  order by install_id, at desc, seq desc
)
select coalesce(screen, '(no screen)') as last_screen, kind || ':' || name as last_thing, count(*) as installs
from last_seen
where at < now() - interval '7 days' and at >= now() - interval '90 days'
group by 1, 2
order by installs desc
limit 40) q;  -- report 16
  perform count(*) from (select count(*) as visits,
  count(distinct install_id) as installs,
  round(count(*)::numeric / nullif(count(distinct install_id), 0), 1) as visits_per_install,
  round((percentile_cont(0.5) within group (order by value) / 60000.0)::numeric, 1) as median_minutes
from ux_events
where kind = 'session' and name = 'end' and at >= now() - interval '30 days') q;  -- report 17
  perform count(*) from (with first_seen as (select install_id, min(day) as d0 from usage_events where event = 'active' group by install_id)
select count(*) as installs,
  count(*) filter (where exists (select 1 from usage_events a where a.install_id = f.install_id and a.event = 'active' and a.day = f.d0 + 1)) as came_back_next_day,
  round(100.0 * count(*) filter (where exists (select 1 from usage_events a where a.install_id = f.install_id and a.event = 'active' and a.day = f.d0 + 1)) / nullif(count(*), 0), 1) as d1_pct
from first_seen f
where f.d0 between current_date - 30 and current_date - 1) q;  -- report 18
  raise exception 'ROLLED BACK: every check passed';
end $t$;
