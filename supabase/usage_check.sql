-- Checks the usage-count SQL (supabase/schema.sql, "usage counts") and the
-- report queries (supabase/usage_queries.sql) against a real database, without
-- keeping anything. Paste all of it into Supabase > SQL editor and run it.
--
-- It creates the table and the two functions, adds fake installs, checks the
-- counts the reports give, and then ends by raising an error ON PURPOSE.
-- Postgres undoes everything a block did when it ends in an error, so nothing
-- stays behind.
--
--   Success:  ERROR: ROLLED BACK: every check passed
--   Failure:  ERROR: FAIL ... (the message says which check)
--   Anything else (a syntax error, a missing table) means the SQL needs a fix.
--
-- Run this before applying the schema, and again if the usage SQL changes.

do $t$
declare aid uuid := '11111111-1111-4111-8111-111111111111'; ids uuid[] := '{}'; id uuid; n int; r record; i int;
begin
create table if not exists usage_events (
  install_id uuid not null,
  day date not null default current_date,
  event text not null check (event in ('active', 'onboarded', 'has_work', 'checked_in', 'connected')),
  primary key (install_id, day, event)
);
create index if not exists usage_events_day_event on usage_events (day, event);

alter table usage_events enable row level security;

create or replace function record_usage(p_id uuid, p_event text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_id is null then raise exception 'no id'; end if;
  if p_event not in ('active', 'onboarded', 'has_work', 'checked_in', 'connected') then raise exception 'bad event'; end if;

  delete from usage_events where day < current_date - 400;

  if p_event <> 'active' and exists (select 1 from usage_events u where u.install_id = p_id and u.event = p_event) then return; end if;
  if (select count(*) from usage_events u where u.day = current_date) >= 50000 then return; end if;

  insert into usage_events (install_id, day, event) values (p_id, current_date, p_event) on conflict do nothing;
end $$;

create or replace function forget_usage(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_id is null then raise exception 'no id'; end if;
  delete from usage_events where install_id = p_id;
end $$;



  perform record_usage(aid,'active'); perform record_usage(aid,'active');
  select count(*) into n from usage_events where install_id=aid; if n<>1 then raise exception 'FAIL active twice a day: %', n; end if;
  perform record_usage(aid,'has_work');
  update usage_events set day=current_date-1 where install_id=aid and event='has_work';
  perform record_usage(aid,'has_work');
  select count(*) into n from usage_events where install_id=aid and event='has_work'; if n<>1 then raise exception 'FAIL milestone twice: %', n; end if;
  begin perform record_usage(aid,'login'); raise exception 'FAIL accepted a bad word'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform record_usage(null,'active'); raise exception 'FAIL accepted no id'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin insert into usage_events(install_id,event) values (aid,'x'); raise exception 'FAIL table took a bad word'; exception when check_violation then null; end;
  for i in 1..4 loop
    id := gen_random_uuid(); ids := ids || id;
    insert into usage_events(install_id, day, event) values (id, current_date-10, 'active');
    if i <= 2 then insert into usage_events(install_id, day, event) values (id, current_date-9, 'active'), (id, current_date-8, 'has_work'); end if;
    if i = 1 then insert into usage_events(install_id, day, event) values (id, current_date-3, 'active'); end if;
  end loop;
  select * into r from (with first_seen as (
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
order by f.d0 desc) q where first_day = current_date-10;
  if r.installs <> 4 or r.d1_pct <> 50.0 or r.d7_pct <> 25.0 or r.d30_pct is not null then raise exception 'FAIL retention: % % % % %', r.installs, r.d1_pct, r.d7_pct, r.d30_pct, 0; end if;
  select count(*) into n from (with days as (select generate_series(current_date - 29, current_date, interval '1 day')::date as day)
select
  d.day,
  (select count(distinct install_id) from usage_events u where u.event = 'active' and u.day = d.day) as dau,
  (select count(distinct install_id) from usage_events u where u.event = 'active' and u.day between d.day - 29 and d.day) as mau_30d,
  round(100.0 * (select count(distinct install_id) from usage_events u where u.event = 'active' and u.day = d.day)
        / nullif((select count(distinct install_id) from usage_events u where u.event = 'active' and u.day between d.day - 29 and d.day), 0), 1) as stickiness_pct
from days d
order by d.day desc) q; if n <> 30 then raise exception 'FAIL dau rows: %', n; end if;
  select * into r from (with first_seen as (
  select install_id, min(day) as d0 from usage_events where event = 'active' group by install_id
)
select
  count(*) as installs_at_least_7_days_old,
  count(*) filter (where exists (select 1 from usage_events w where w.install_id = f.install_id and w.event = 'has_work' and w.day <= f.d0 + 7)) as had_work_in_7_days,
  round(100.0 * count(*) filter (where exists (select 1 from usage_events w where w.install_id = f.install_id and w.event = 'has_work' and w.day <= f.d0 + 7)) / nullif(count(*), 0), 1) as activation_pct
from first_seen f
where f.d0 <= current_date - 7) q;
  if r.installs_at_least_7_days_old <> 4 or r.had_work_in_7_days <> 2 or r.activation_pct <> 50.0 then raise exception 'FAIL activation: % % %', r.installs_at_least_7_days_old, r.had_work_in_7_days, r.activation_pct; end if;
  select count(*) into n from (select event, count(distinct install_id) as installs
from usage_events
group by event
order by case event when 'active' then 1 when 'onboarded' then 2 when 'connected' then 3 when 'has_work' then 4 when 'checked_in' then 5 end) q; if n <> 2 then raise exception 'FAIL funnel rows: %', n; end if;
  select * into r from (with first_seen as (
  select install_id, min(day) as d0 from usage_events where event = 'active' group by install_id
)
select
  exists (select 1 from usage_events w where w.install_id = f.install_id and w.event = 'has_work' and w.day <= f.d0 + 7) as had_work_in_7_days,
  count(*) as installs,
  round(100.0 * count(*) filter (where exists (select 1 from usage_events a where a.install_id = f.install_id and a.event = 'active' and a.day = f.d0 + 7)) / count(*), 1) as d7_pct
from first_seen f
where f.d0 <= current_date - 7
group by 1) q where had_work_in_7_days; if r.installs <> 2 or r.d7_pct <> 50.0 then raise exception 'FAIL split true: % %', r.installs, r.d7_pct; end if;
  select * into r from (with first_seen as (
  select install_id, min(day) as d0 from usage_events where event = 'active' group by install_id
)
select
  exists (select 1 from usage_events w where w.install_id = f.install_id and w.event = 'has_work' and w.day <= f.d0 + 7) as had_work_in_7_days,
  count(*) as installs,
  round(100.0 * count(*) filter (where exists (select 1 from usage_events a where a.install_id = f.install_id and a.event = 'active' and a.day = f.d0 + 7)) / count(*), 1) as d7_pct
from first_seen f
where f.d0 <= current_date - 7
group by 1) q where not had_work_in_7_days; if r.installs <> 2 or r.d7_pct <> 0.0 then raise exception 'FAIL split false: % %', r.installs, r.d7_pct; end if;
  perform forget_usage(aid);
  select count(*) into n from usage_events where install_id=aid; if n<>0 then raise exception 'FAIL forget left % rows', n; end if;
  select count(*) into n from usage_events where install_id = any(ids); if n <> 9 then raise exception 'FAIL forget touched others: %', n; end if;
  raise exception 'ROLLED BACK: every check passed';
end $t$;
