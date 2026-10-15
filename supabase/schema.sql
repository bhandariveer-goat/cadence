-- Cadence backend (Supabase / Postgres): accounts, the plan each account
-- keeps, crew, the assistant's rate limit, and the optional visit counter.
--
-- Run this whole file in the project's SQL editor. It can be run again at any
-- time, for instance after pulling a newer version: nothing in it fails
-- because it already exists, and it never touches what people have saved.
--
-- The rest of the set-up (the project's address and key, sign-in email, the
-- addresses a sign-in link may return to) is in LAUNCH.md, step 3.
--
-- Two layers protect the data, and both are in this file:
--   grants    decide whether a person can reach a table at all. Supabase
--             projects differ here: many grant every new table to everyone,
--             people who are not signed in included, and leave the rest to
--             the policies; others grant nothing. So this file takes every
--             grant away and gives back, by name, at the end, exactly what
--             the app uses.
--   policies  (row level security) decide which rows. A plan is one row that
--             only its owner can read or write. A check-in the student shares
--             reaches their partners, and reaches a club only if it was made
--             for that club. Sizes and daily counts are limited, so one
--             account cannot crowd out or slow down everyone else.
-- Someone who is not signed in ("anon") can reach nothing but the visit
-- counter's function.

create extension if not exists pgcrypto;

create table if not exists profiles (
  id uuid primary key references auth.users on delete cascade,
  name text not null default '',
  color text not null default '#f97316',
  created_at timestamptz not null default now()
);

create table if not exists partnerships (
  user_a uuid not null references profiles on delete cascade,
  user_b uuid not null references profiles on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_a, user_b),
  check (user_a < user_b)
);

create table if not exists invites (
  code text primary key,
  owner uuid not null references profiles on delete cascade default auth.uid(),
  used_by uuid references profiles on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists clubs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null default 'club' check (kind in ('club', 'class')),
  code text not null unique,
  leader uuid references profiles on delete set null,
  commitment jsonb,
  created_at timestamptz not null default now()
);

create table if not exists club_members (
  club_id uuid not null references clubs on delete cascade,
  user_id uuid not null references profiles on delete cascade,
  role text not null default 'member' check (role in ('member', 'leader')),
  joined_at timestamptz not null default now(),
  primary key (club_id, user_id)
);

create table if not exists checkins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles on delete cascade default auth.uid(),
  club_id uuid references clubs on delete set null,
  title text not null,
  kind text,
  color text,
  minutes int,
  feel text,
  note text,
  at timestamptz not null default now()
);
create index if not exists checkins_user_at on checkins (user_id, at desc);

create table if not exists kudos (
  checkin_id uuid not null references checkins on delete cascade,
  from_user uuid not null references profiles on delete cascade default auth.uid(),
  at timestamptz not null default now(),
  primary key (checkin_id, from_user)
);

create table if not exists nudges (
  id uuid primary key default gen_random_uuid(),
  from_user uuid not null references profiles on delete cascade default auth.uid(),
  to_user uuid not null references profiles on delete cascade,
  message text not null,
  at timestamptz not null default now(),
  seen boolean not null default false
);

create table if not exists club_posts (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs on delete cascade,
  from_user uuid not null references profiles on delete cascade default auth.uid(),
  text text not null,
  at timestamptz not null default now()
);

-- Check-ins carry the time they were made as well as the time they are for
-- (which the student may set to earlier today), so daily limits can count them.
alter table checkins add column if not exists created_at timestamptz not null default now();

-- Limits on size, set well above anything the app sends (a name of 60
-- characters, a note of 120, a post of 280), so that no one account can make
-- other people's screens slow or fill the database.
alter table profiles drop constraint if exists profiles_sizes;
alter table profiles add constraint profiles_sizes check (char_length(name) <= 100 and char_length(color) <= 40);
alter table clubs drop constraint if exists clubs_sizes;
alter table clubs add constraint clubs_sizes check (char_length(name) <= 100 and char_length(code) <= 40
  and (commitment is null or (jsonb_typeof(commitment) = 'object' and octet_length(commitment::text) <= 4000)));
alter table invites drop constraint if exists invites_sizes;
alter table invites add constraint invites_sizes check (char_length(code) <= 20);
alter table checkins drop constraint if exists checkins_sizes;
alter table checkins add constraint checkins_sizes check (char_length(title) <= 200 and char_length(coalesce(note, '')) <= 1000
  and char_length(coalesce(kind, '')) <= 40 and char_length(coalesce(feel, '')) <= 40 and char_length(coalesce(color, '')) <= 40
  and (minutes is null or minutes between 0 and 1440));
alter table nudges drop constraint if exists nudges_sizes;
alter table nudges add constraint nudges_sizes check (char_length(message) <= 300);
alter table club_posts drop constraint if exists club_posts_sizes;
alter table club_posts add constraint club_posts_sizes check (char_length(text) <= 1000);

-- An index on each column that points at another table, so the lookups the
-- policies make, the app's lists (newest first), and removing an account
-- (which removes everything that points at it) stay quick as tables grow.
create index if not exists checkins_club_id on checkins (club_id);
create index if not exists club_members_user_id on club_members (user_id);
create index if not exists club_posts_club_at on club_posts (club_id, at desc);
create index if not exists club_posts_from_user on club_posts (from_user);
create index if not exists clubs_leader on clubs (leader);
create index if not exists invites_owner on invites (owner);
create index if not exists invites_used_by on invites (used_by);
create index if not exists kudos_from_user on kudos (from_user);
create index if not exists nudges_from_user on nudges (from_user);
create index if not exists nudges_to_user_at on nudges (to_user, at desc);
create index if not exists partnerships_user_b on partnerships (user_b);
create index if not exists checkins_user_created on checkins (user_id, created_at);

-- ------------------------------------------------------- a profile per account
-- Check-ins, invites, nudges and club membership all point at a person's
-- profile row, so the row has to exist before any of them can be written.
-- It is made here, by the database, when the account is made, instead of
-- relying on the app to remember. The app fills in the name afterwards.

create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- Accounts that were made before this trigger existed.
insert into profiles (id) select id from auth.users on conflict (id) do nothing;

-- ------------------------------------------------------------------ helpers
-- security definer so policies can ask "who am I connected to?" without
-- recursing through club_members' own policy.

create or replace function my_club_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select club_id from club_members where user_id = auth.uid()
$$;

create or replace function is_connected(other uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select other = auth.uid()
    or exists (select 1 from partnerships where (user_a = auth.uid() and user_b = other) or (user_b = auth.uid() and user_a = other))
    or exists (select 1 from club_members where user_id = other and club_id in (select my_club_ids()))
$$;

-- ---------------------------------------------------------------- policies
-- (select auth.uid()) rather than auth.uid(): the same value, but worked out
-- once per request instead of once per row.

alter table profiles enable row level security;
alter table partnerships enable row level security;
alter table invites enable row level security;
alter table clubs enable row level security;
alter table club_members enable row level security;
alter table checkins enable row level security;
alter table kudos enable row level security;
alter table nudges enable row level security;
alter table club_posts enable row level security;

drop policy if exists "see connected profiles" on profiles;
create policy "see connected profiles" on profiles for select using (is_connected(id));
drop policy if exists "write own profile" on profiles;
create policy "write own profile" on profiles for insert with check (id = (select auth.uid()));
drop policy if exists "update own profile" on profiles;
create policy "update own profile" on profiles for update using (id = (select auth.uid()));

drop policy if exists "see own partnerships" on partnerships;
create policy "see own partnerships" on partnerships for select using ((select auth.uid()) in (user_a, user_b));
drop policy if exists "end own partnerships" on partnerships;
create policy "end own partnerships" on partnerships for delete using ((select auth.uid()) in (user_a, user_b));

drop policy if exists "see own invites" on invites;
create policy "see own invites" on invites for select using (owner = (select auth.uid()));
drop policy if exists "create invites" on invites;
create policy "create invites" on invites for insert with check (owner = (select auth.uid()));

drop policy if exists "see my clubs" on clubs;
create policy "see my clubs" on clubs for select using (id in (select my_club_ids()));
drop policy if exists "leaders edit clubs" on clubs;
create policy "leaders edit clubs" on clubs for update using (leader = (select auth.uid()));

drop policy if exists "see members of my clubs" on club_members;
create policy "see members of my clubs" on club_members for select using (club_id in (select my_club_ids()));
drop policy if exists "leave clubs" on club_members;
create policy "leave clubs" on club_members for delete using (user_id = (select auth.uid()));

-- Your partners see every check-in you share. A club sees only the check-ins
-- for that club, so one club never sees what was meant for another.
drop policy if exists "see connected check-ins" on checkins;
create policy "see connected check-ins" on checkins for select using (
  user_id = (select auth.uid())
  or (club_id is not null and club_id in (select my_club_ids()))
  or exists (select 1 from partnerships p
             where (p.user_a = (select auth.uid()) and p.user_b = checkins.user_id)
                or (p.user_b = (select auth.uid()) and p.user_a = checkins.user_id)));
-- Not dated more than a day ahead (a little room for a clock that is off).
drop policy if exists "share own check-ins" on checkins;
create policy "share own check-ins" on checkins for insert with check (
  user_id = (select auth.uid())
  and at <= now() + interval '1 day'
  and (club_id is null or club_id in (select my_club_ids())));
drop policy if exists "delete own check-ins" on checkins;
create policy "delete own check-ins" on checkins for delete using (user_id = (select auth.uid()));

drop policy if exists "see kudos on visible check-ins" on kudos;
create policy "see kudos on visible check-ins" on kudos for select using (exists (select 1 from checkins c where c.id = checkin_id));
drop policy if exists "give kudos" on kudos;
create policy "give kudos" on kudos for insert with check (from_user = (select auth.uid()) and exists (select 1 from checkins c where c.id = checkin_id));
drop policy if exists "take back kudos" on kudos;
create policy "take back kudos" on kudos for delete using (from_user = (select auth.uid()));

drop policy if exists "see my nudges" on nudges;
create policy "see my nudges" on nudges for select using ((select auth.uid()) in (from_user, to_user));
drop policy if exists "nudge connections" on nudges;
create policy "nudge connections" on nudges for insert with check (from_user = (select auth.uid()) and is_connected(to_user));
drop policy if exists "mark nudges seen" on nudges;
create policy "mark nudges seen" on nudges for update using (to_user = (select auth.uid()));

drop policy if exists "read club posts" on club_posts;
create policy "read club posts" on club_posts for select using (club_id in (select my_club_ids()));
drop policy if exists "post in my clubs" on club_posts;              -- the earlier rule, which let any member post
drop policy if exists "leaders post updates" on club_posts;
create policy "leaders post updates" on club_posts for insert with check (
  from_user = (select auth.uid()) and club_id in (select id from clubs where leader = (select auth.uid())));

-- ------------------------------------------------------------ daily limits
-- How many of each thing one account may add in a day. Checked as each row
-- goes in, by the database, not in a policy: a policy that counted rows of
-- its own table would make Postgres refuse every insert ("infinite
-- recursion"). The times counted are filled in by the database (the grants
-- below do not let anyone set them), so they cannot be backdated. Generous
-- for real use: a teacher nudging three classes, a student checking in to
-- every activity.

create or replace function limit_per_day() returns trigger
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if tg_table_name = 'checkins' then
    select count(*) into n from checkins where user_id = new.user_id and created_at > now() - interval '1 day';
    if n >= 200 then raise exception 'That is as many check-ins as one day allows'; end if;
  elsif tg_table_name = 'nudges' then
    select count(*) into n from nudges where from_user = new.from_user and at > now() - interval '1 day';
    if n >= 300 then raise exception 'That is as many nudges as one day allows'; end if;
    select count(*) into n from nudges where from_user = new.from_user and to_user = new.to_user and at > now() - interval '1 day';
    if n >= 20 then raise exception 'That is enough nudges to one person for today'; end if;
  elsif tg_table_name = 'club_posts' then
    select count(*) into n from club_posts where from_user = new.from_user and at > now() - interval '1 day';
    if n >= 50 then raise exception 'That is as many updates as one day allows'; end if;
  elsif tg_table_name = 'invites' then
    select count(*) into n from invites where owner = new.owner and created_at > now() - interval '1 day';
    if n >= 100 then raise exception 'That is as many invite codes as one day allows'; end if;
  end if;
  return new;
end $$;

drop trigger if exists checkins_per_day on checkins;
create trigger checkins_per_day before insert on checkins for each row execute function limit_per_day();
drop trigger if exists nudges_per_day on nudges;
create trigger nudges_per_day before insert on nudges for each row execute function limit_per_day();
drop trigger if exists club_posts_per_day on club_posts;
create trigger club_posts_per_day before insert on club_posts for each row execute function limit_per_day();
drop trigger if exists invites_per_day on invites;
create trigger invites_per_day before insert on invites for each row execute function limit_per_day();

-- -------------------------------------------------------------------- rpcs

-- An invite is removed as it is used, in the same step that reads it, so it
-- works once even if two people try it at the same moment, and does not come
-- back to life if the person who used it later deletes their account.
create or replace function accept_invite(invite_code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare inviter uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  delete from invites where code = invite_code and owner <> auth.uid() returning owner into inviter;
  if inviter is null then
    if exists (select 1 from invites where code = invite_code) then raise exception 'That''s your own invite code'; end if;
    raise exception 'That invite code is invalid or already used';
  end if;
  insert into partnerships (user_a, user_b) values (least(inviter, auth.uid()), greatest(inviter, auth.uid())) on conflict do nothing;
  return inviter;
end $$;

-- A club's code is how people join it, so it must not be guessable: the
-- name's first letters, then six characters drawn from the database's secure
-- random source. That is about a billion codes for any one club name. The
-- characters leave out I, O, 0 and 1, which are easy to mix up when read out.
create or replace function create_club(club_name text, club_kind text, club_commitment jsonb) returns clubs
language plpgsql security definer set search_path = public as $$
declare
  new_club clubs;
  letters constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  prefix text := coalesce(nullif(upper(regexp_replace(left(club_name, 5), '[^A-Za-z]', '', 'g')), ''), 'CLUB');
  random_bytes bytea;
  suffix text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if (select count(*) from clubs where leader = auth.uid() and created_at > now() - interval '1 day') >= 20 then
    raise exception 'That is as many new clubs as one person can start in a day';
  end if;
  for attempt in 1..5 loop
    random_bytes := uuid_send(gen_random_uuid());      -- the first six bytes of a new uuid are random
    suffix := '';
    for i in 0..5 loop
      suffix := suffix || substr(letters, get_byte(random_bytes, i) % 32 + 1, 1);
    end loop;
    begin
      insert into clubs (name, kind, code, leader, commitment)
      values (club_name, coalesce(club_kind, 'club'), prefix || '-' || suffix, auth.uid(), club_commitment)
      returning * into new_club;
      exit;
    exception when unique_violation then
      if attempt = 5 then raise; end if;             -- five clashes in a row would mean something else is wrong
    end;
  end loop;
  insert into club_members (club_id, user_id, role) values (new_club.id, auth.uid(), 'leader');
  return new_club;
end $$;

create or replace function join_club(club_code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare target uuid;
begin
  select id into target from clubs where code = club_code;
  if target is null then raise exception 'No club with that code'; end if;
  insert into club_members (club_id, user_id) values (target, auth.uid()) on conflict do nothing;
  return target;
end $$;

-- A club's weekly target, from 1 to 7 times. Whatever a leader stores, this
-- gives a number, so a bad value cannot stop the club from loading.
create or replace function club_sessions(commitment jsonb) returns numeric
language sql immutable set search_path = public as $$
  select case when jsonb_typeof(commitment -> 'sessions') = 'number'
              then least(greatest((commitment ->> 'sessions')::numeric, 1), 7) else 1 end
$$;

-- Weekly progress: check-ins shared to a club in the week from week_start,
-- against the club's target.
create or replace function club_members_progress(target_club uuid, week_start timestamptz)
returns table (user_id uuid, name text, color text, week_pct numeric, streak int)
language sql stable security definer set search_path = public as $$
  select m.user_id, p.name, p.color,
         least(1, count(c.id)::numeric / club_sessions(cl.commitment)),
         0
  from club_members m
  join clubs cl on cl.id = m.club_id
  join profiles p on p.id = m.user_id
  left join checkins c on c.user_id = m.user_id and c.club_id = m.club_id
                      and c.at >= week_start and c.at < week_start + interval '7 days'
  where m.club_id = target_club and target_club in (select my_club_ids()) and m.user_id <> auth.uid()
  group by m.user_id, p.name, p.color, cl.commitment
$$;

-- The team ring is the average over the club's members, the person looking
-- included. The leader is left out: in a class that is the teacher, who does
-- not check in.
create or replace function my_club_overview(week_start timestamptz)
returns table (id uuid, name text, kind text, role text, code text, commitment jsonb, member_count int, team_pct numeric)
language sql stable security definer set search_path = public as $$
  select cl.id, cl.name, cl.kind, me.role, cl.code, cl.commitment,
         (select count(*)::int from club_members where club_id = cl.id),
         coalesce((select avg(least(1, (select count(*) from checkins c
                                        where c.user_id = m.user_id and c.club_id = cl.id
                                          and c.at >= week_start and c.at < week_start + interval '7 days')::numeric
                                       / club_sessions(cl.commitment)))
                   from club_members m where m.club_id = cl.id and m.role = 'member'), 0)
  from clubs cl
  join club_members me on me.club_id = cl.id and me.user_id = auth.uid()
$$;

create or replace view partner_overview with (security_invoker = true) as
  select case when pt.user_a = auth.uid() then pt.user_b else pt.user_a end as partner_id,
         p.name, p.color, pt.created_at::date as since,
         (select array_agg(distinct c.title) from checkins c where c.user_id = p.id and c.at > now() - interval '30 days') as sharing,
         null::numeric as week_pct, 0 as streak,
         (select max(c.at) from checkins c where c.user_id = p.id) as last_at
  from partnerships pt
  join profiles p on p.id = case when pt.user_a = auth.uid() then pt.user_b else pt.user_a end
  where auth.uid() in (pt.user_a, pt.user_b);


-- ------------------------------------------------------------ planner sync
-- One row per account holding the plan itself, so the Chrome extension and the
-- website show the same week. Owner-only in every direction.

create table if not exists planner_state (
  user_id uuid primary key references auth.users on delete cascade default auth.uid(),
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table planner_state enable row level security;

drop policy if exists "read own plan" on planner_state;
create policy "read own plan" on planner_state for select using (user_id = (select auth.uid()));
drop policy if exists "create own plan" on planner_state;
create policy "create own plan" on planner_state for insert with check (user_id = (select auth.uid()));
drop policy if exists "update own plan" on planner_state;
create policy "update own plan" on planner_state for update using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "delete own plan" on planner_state;
create policy "delete own plan" on planner_state for delete using (user_id = (select auth.uid()));

-- ----------------------------------------------------- assistant rate limit
-- netlify/functions/agent.mjs calls bump_agent_usage() with the student's own
-- token before every model request. The table has row level security on and
-- no policies, so nobody can read or reset their count directly; the function
-- is the only way in. It returns two numbers: this account's requests today,
-- and everyone's, and the server function refuses a request when either is
-- over its limit (AGENT_DAILY_LIMIT and AGENT_DAILY_TOTAL). An account's own
-- count stops going up at 61, one past the default limit of 60, so that one
-- account calling this over and over cannot use up everyone's total. Raising
-- AGENT_DAILY_LIMIT above 60 needs that number raised here too.
--
-- user_id is deliberately not a foreign key. A count row is an id and a
-- number, it is removed the day after it is written, and keeping it when an
-- account is deleted is what stops delete-and-sign-up-again from resetting
-- the day's total.

create table if not exists agent_usage (
  user_id uuid not null,
  day date not null default current_date,
  count int not null default 0,
  primary key (user_id, day)
);

alter table agent_usage enable row level security;

create or replace function bump_agent_usage() returns table (mine int, total bigint)
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  -- Only today's counts are kept; earlier days are of no use and are removed.
  delete from agent_usage where day < current_date;
  insert into agent_usage as u (user_id, day, count) values (auth.uid(), current_date, 1)
  on conflict (user_id, day) do update set count = u.count + 1 where u.count <= 60;
  select a.count into n from agent_usage a where a.user_id = auth.uid() and a.day = current_date;
  return query select n, coalesce(sum(a.count), 0)::bigint from agent_usage a where a.day = current_date;
end $$;


-- ------------------------------------------------------------ visit counts
-- Optional, and off unless site.countVisits is true in src/config.js. When a
-- link to the site carries a label (utm_source and friends), the site asks
-- netlify/functions/visit.mjs to add one to that label's count for the day.
--
-- A row is three short labels, a date and a number. There is no visitor in
-- it: no ip address, no account, no cookie, no user agent. Row level security
-- is on with no policies, so the count can only be added to through the
-- function below and only read by the project owner (the SQL editor, or the
-- Table editor in the Supabase dashboard).
--
-- The function is open to "anon" because a visitor has no account. So that an
-- open function cannot be used to fill the table, a day holds at most 200
-- different labels; anything past that is added to one row called "other".
-- Rows older than 400 days are removed.

create table if not exists visit_counts (
  day date not null default current_date,
  source text not null default '',
  medium text not null default '',
  campaign text not null default '',
  count int not null default 0,
  primary key (day, source, medium, campaign)
);

alter table visit_counts enable row level security;

create or replace function count_visit(p_source text, p_medium text, p_campaign text) returns void
language plpgsql security definer set search_path = public as $$
declare
  s text := coalesce(p_source, '');
  m text := coalesce(p_medium, '');
  c text := coalesce(p_campaign, '');
begin
  -- The same rule the server function applies, repeated here because this
  -- function can also be called directly with the public key.
  if s !~ '^[a-z0-9_-]{0,40}$' or m !~ '^[a-z0-9_-]{0,40}$' or c !~ '^[a-z0-9_-]{0,40}$' then
    raise exception 'bad label';
  end if;
  if s = '' and m = '' and c = '' then raise exception 'no label'; end if;

  delete from visit_counts where day < current_date - 400;

  if not exists (select 1 from visit_counts v where v.day = current_date and v.source = s and v.medium = m and v.campaign = c)
     and (select count(*) from visit_counts v where v.day = current_date) >= 200 then
    s := 'other'; m := ''; c := '';
  end if;

  insert into visit_counts as v (day, source, medium, campaign, count) values (current_date, s, m, c, 1)
  on conflict (day, source, medium, campaign) do update set count = v.count + 1;
end $$;


-- --------------------------------------------------------- delete my account
-- Removes the sign-in itself; every table above references auth.users or
-- profiles with "on delete cascade", so the plan, check-ins, kudos, nudges and
-- memberships go with it. A club the person leads first passes to the member
-- who joined it earliest; a class (whose leader is the teacher) is removed,
-- as is a club with no one else in it.

create or replace function delete_my_account() returns void
language plpgsql security definer set search_path = public as $$
declare led record; heir uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  for led in select id, kind from clubs where leader = auth.uid() loop
    heir := null;
    if led.kind = 'club' then
      select user_id into heir from club_members
      where club_id = led.id and user_id <> auth.uid() order by joined_at, user_id limit 1;
    end if;
    if heir is null then
      delete from clubs where id = led.id;
    else
      update clubs set leader = heir where id = led.id;
      update club_members set role = 'leader' where club_id = led.id and user_id = heir;
    end if;
  end loop;
  delete from auth.users where id = auth.uid();
end $$;

-- ------------------------------------------------------------------- grants
-- What the app's API may reach, by name. Row level security above then
-- decides which rows. Each table gets exactly the actions its policies allow,
-- and no more. Run after everything else so every object exists.

grant usage on schema public to anon, authenticated;

-- Start from nothing, whatever this project granted by default when the
-- tables were made (many projects grant every new table to everyone and
-- leave the rest to the policies). Nothing at all is for someone not signed in.
revoke all on profiles, partnerships, invites, clubs, club_members, checkins, kudos, nudges, club_posts,
  planner_state, agent_usage, visit_counts, partner_overview from anon, authenticated;

-- Signed in: the tables the app reads and writes, and only in the ways it does.
grant select, insert, update on profiles to authenticated;
grant select, delete on partnerships to authenticated;
grant select on invites to authenticated;
grant insert (code) on invites to authenticated;                      -- owner and time are filled in by the database
grant select on clubs to authenticated;
grant update (name, commitment) on clubs to authenticated;          -- a leader renames a club; its code and leader are not editable
grant select, delete on club_members to authenticated;
grant select, delete on checkins to authenticated;
grant insert (title, kind, color, club_id, minutes, feel, note, at) on checkins to authenticated;
grant select, delete on kudos to authenticated;
grant insert (checkin_id) on kudos to authenticated;
grant select on nudges to authenticated;
grant insert (to_user, message) on nudges to authenticated;          -- sender and time are filled in by the database
grant update (seen) on nudges to authenticated;                     -- a nudge can be marked read, not rewritten
grant select on club_posts to authenticated;
grant insert (club_id, text) on club_posts to authenticated;
grant select, insert, update, delete on planner_state to authenticated;
grant select on partner_overview to authenticated;

-- agent_usage and visit_counts are granted to nobody. They are reached only
-- through their functions, which run with the database owner's rights, and
-- read by the project's owner in the dashboard.

-- Functions. A new function can be run by anyone until that is taken away,
-- so it is taken away from everyone first and then given to who needs it.
revoke execute on function
  my_club_ids(), is_connected(uuid), accept_invite(text), create_club(text, text, jsonb), join_club(text),
  club_members_progress(uuid, timestamptz), my_club_overview(timestamptz),
  bump_agent_usage(), delete_my_account(), count_visit(text, text, text), handle_new_user(), club_sessions(jsonb),
  limit_per_day()
  from public, anon, authenticated;

grant execute on function
  my_club_ids(), is_connected(uuid), accept_invite(text), create_club(text, text, jsonb), join_club(text),
  club_members_progress(uuid, timestamptz), my_club_overview(timestamptz),
  bump_agent_usage(), delete_my_account()
  to authenticated;

-- The visit counter is the one thing a visitor without an account can call.
grant execute on function count_visit(text, text, text) to anon, authenticated;

-- Tell the API to look again, so the grants and functions above are in
-- effect straight away.
notify pgrst, 'reload schema';
