"""Writes supabase/ux_check.sql from the "how the app is used" part of
supabase/schema.sql and every report in supabase/ux_reports.sql, so the check
always tests what will be applied. Run it after changing either:

    python3 scripts/make_ux_check.py
"""
import sys
from pathlib import Path
root = sys.argv[1] if len(sys.argv) > 1 else str(Path(__file__).resolve().parent.parent)
schema = open(f'{root}/supabase/schema.sql').read()
a = schema.index('create table if not exists ux_events')
b = schema.index("end $$;", schema.index('create or replace function insights')) + len("end $$;")
section = schema[a:b]
f0 = schema.index('create or replace function forget_usage')
f1 = schema.index('end $$;', f0) + len('end $$;')
forget = schema[f0:f1]
reports = open(f'{root}/supabase/ux_reports.sql').read()
stmts = []
nocomments = '\n'.join(l for l in reports.splitlines() if not l.strip().startswith('--'))
for chunk in nocomments.split(';'):
    body = chunk.strip()
    if body: stmts.append(body)
perform_reports = '\n'.join(f"  perform count(*) from ({s}) q;  -- report {i+1}" for i, s in enumerate(stmts))
checks = r"""
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
"""
insights_checks = r"""
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
"""
checks += insights_checks
out = f"""-- Checks the "how the app is used" SQL (supabase/schema.sql) and every report
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
{section}

{forget}
{checks}
{perform_reports}
  raise exception 'ROLLED BACK: every check passed';
end $t$;
"""
open(f'{root}/supabase/ux_check.sql', 'w').write(out)
print(len(out.splitlines()), 'lines,', len(stmts), 'reports')
