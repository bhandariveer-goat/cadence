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
-- counter's function, and an anonymous account (for using the assistant with
-- only a name) can do nothing but be counted.

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
-- The Crew feed asks for check-ins by these people and these clubs, newest
-- first (lib/sync.js), so it reads only theirs, not the whole table.
create index if not exists checkins_club_at on checkins (club_id, at desc);
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
-- A leader can take someone out of their club. This reads clubs, not
-- club_members, so the policy does not read its own table.
drop policy if exists "leaders remove members" on club_members;
create policy "leaders remove members" on club_members for delete using (
  club_id in (select id from clubs where leader = (select auth.uid())));

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
drop policy if exists "clear my nudges" on nudges;
create policy "clear my nudges" on nudges for delete using (to_user = (select auth.uid()));

drop policy if exists "read club posts" on club_posts;
create policy "read club posts" on club_posts for select using (club_id in (select my_club_ids()));
drop policy if exists "post in my clubs" on club_posts;              -- the earlier rule, which let any member post
drop policy if exists "leaders post updates" on club_posts;
create policy "leaders post updates" on club_posts for insert with check (
  from_user = (select auth.uid()) and club_id in (select id from clubs where leader = (select auth.uid())));

-- ------------------------------------------------------- anonymous accounts
-- Someone using Cadence with only a name gets a hidden anonymous account
-- (Supabase's anonymous sign-in), only so the assistant's server function can
-- count their requests. Anonymous accounts use the same database role as
-- everyone else, so each table also gets a restrictive policy: whatever the
-- other policies allow, an anonymous account gets nothing. It cannot keep a
-- plan, a profile name, check-ins or anything in Crew. It can only be counted
-- by bump_agent_usage(), which runs with the database owner's rights.

create or replace function anonymous_account() returns boolean
language sql stable set search_path = public as $$
  select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
$$;

drop policy if exists "not for anonymous accounts" on profiles;
create policy "not for anonymous accounts" on profiles as restrictive to authenticated
  using (not (select anonymous_account())) with check (not (select anonymous_account()));
drop policy if exists "not for anonymous accounts" on partnerships;
create policy "not for anonymous accounts" on partnerships as restrictive to authenticated
  using (not (select anonymous_account())) with check (not (select anonymous_account()));
drop policy if exists "not for anonymous accounts" on invites;
create policy "not for anonymous accounts" on invites as restrictive to authenticated
  using (not (select anonymous_account())) with check (not (select anonymous_account()));
drop policy if exists "not for anonymous accounts" on clubs;
create policy "not for anonymous accounts" on clubs as restrictive to authenticated
  using (not (select anonymous_account())) with check (not (select anonymous_account()));
drop policy if exists "not for anonymous accounts" on club_members;
create policy "not for anonymous accounts" on club_members as restrictive to authenticated
  using (not (select anonymous_account())) with check (not (select anonymous_account()));
drop policy if exists "not for anonymous accounts" on checkins;
create policy "not for anonymous accounts" on checkins as restrictive to authenticated
  using (not (select anonymous_account())) with check (not (select anonymous_account()));
drop policy if exists "not for anonymous accounts" on kudos;
create policy "not for anonymous accounts" on kudos as restrictive to authenticated
  using (not (select anonymous_account())) with check (not (select anonymous_account()));
drop policy if exists "not for anonymous accounts" on nudges;
create policy "not for anonymous accounts" on nudges as restrictive to authenticated
  using (not (select anonymous_account())) with check (not (select anonymous_account()));
drop policy if exists "not for anonymous accounts" on club_posts;
create policy "not for anonymous accounts" on club_posts as restrictive to authenticated
  using (not (select anonymous_account())) with check (not (select anonymous_account()));
drop policy if exists "not for anonymous accounts" on planner_state;
create policy "not for anonymous accounts" on planner_state as restrictive to authenticated
  using (not (select anonymous_account())) with check (not (select anonymous_account()));

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
  if auth.uid() is null or anonymous_account() then raise exception 'Sign in with an email to add a partner'; end if;
  -- An invite lasts two weeks, so an old code left in a group chat stops working.
  delete from invites where code = invite_code and owner <> auth.uid() and created_at > now() - interval '14 days'
  returning owner into inviter;
  if inviter is null then
    if exists (select 1 from invites where code = invite_code and owner = auth.uid()) then raise exception 'That''s your own invite code'; end if;
    raise exception 'That invite code is invalid, already used, or more than two weeks old';
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
  if auth.uid() is null or anonymous_account() then raise exception 'Sign in with an email to start a club'; end if;
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

-- A leader can give the club a new code when the old one has spread too far.
-- The old code stops working at once; people already in the club stay in.
-- Leaving a club, for members and leaders alike. A leader's club passes to
-- the member who joined it earliest; a class (whose leader is the teacher),
-- or a club with no one else in it, is removed, as when a leader deletes
-- their account.
create or replace function leave_club(target uuid) returns void
language plpgsql security definer set search_path = public as $$
declare club_kind text; heir uuid;
begin
  if auth.uid() is null or anonymous_account() then raise exception 'Sign in with an email to use clubs'; end if;
  if not exists (select 1 from club_members where club_id = target and user_id = auth.uid()) then
    raise exception 'You are not in that club';
  end if;
  select kind into club_kind from clubs where id = target and leader = auth.uid();
  if found then
    if club_kind = 'club' then
      select user_id into heir from club_members
      where club_id = target and user_id <> auth.uid() order by joined_at, user_id limit 1;
    end if;
    if heir is null then
      delete from clubs where id = target;
      return;
    end if;
    update clubs set leader = heir where id = target;
    update club_members set role = 'leader' where club_id = target and user_id = heir;
  end if;
  delete from club_members where club_id = target and user_id = auth.uid();
end $$;

create or replace function rotate_club_code(target uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  letters constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  club_name text;
  prefix text;
  random_bytes bytea;
  suffix text;
  new_code text;
begin
  if auth.uid() is null or anonymous_account() then raise exception 'Sign in with an email to change a club code'; end if;
  select name into club_name from clubs where id = target and leader = auth.uid();
  if club_name is null then raise exception 'Only the club leader can change its code'; end if;
  prefix := coalesce(nullif(upper(regexp_replace(left(club_name, 5), '[^A-Za-z]', '', 'g')), ''), 'CLUB');
  for attempt in 1..5 loop
    random_bytes := uuid_send(gen_random_uuid());
    suffix := '';
    for i in 0..5 loop
      suffix := suffix || substr(letters, get_byte(random_bytes, i) % 32 + 1, 1);
    end loop;
    begin
      update clubs set code = prefix || '-' || suffix where id = target returning code into new_code;
      exit;
    exception when unique_violation then
      if attempt = 5 then raise; end if;
    end;
  end loop;
  return new_code;
end $$;

-- Wrong codes are counted, 20 a day per account, so codes cannot be guessed
-- by trying many: a club shows its members' names and check-ins. A wrong code
-- returns null rather than raising an error, because an error would undo the
-- row that counts it.
create table if not exists join_attempts (
  user_id uuid not null,
  at timestamptz not null default now()
);
create index if not exists join_attempts_user_at on join_attempts (user_id, at);
alter table join_attempts enable row level security;

create or replace function join_club(club_code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare target uuid;
begin
  if auth.uid() is null or anonymous_account() then raise exception 'Sign in with an email to join a club'; end if;
  if (select count(*) from join_attempts where user_id = auth.uid() and at > now() - interval '1 day') >= 20 then
    raise exception 'Too many wrong codes today. Check the code with your leader and try again tomorrow.';
  end if;
  select id into target from clubs where code = club_code;
  if target is null then
    insert into join_attempts (user_id) values (auth.uid());
    delete from join_attempts where at < now() - interval '2 days';
    return null;
  end if;
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
-- token before every model request. These tables have row level security on
-- and no policies, so nobody can read or reset a count directly; the
-- functions are the only way in.
--
-- What is counted is questions: a request that starts from something the
-- student typed. One question can take a few more requests while the model
-- uses tools (is_step), and those are counted separately, up to six for
-- every question asked that day, so they cannot be used to ask for free. An email
-- account gets 60 questions a day; a hidden anonymous account (a student
-- using Cadence with only a name) gets 15, because a new one costs nothing.
-- Each count stops one past its limit, so calling this over and over cannot
-- push the day's total up. The day starts at midnight Pacific time, not UTC,
-- which was 5pm in California and 8pm in New York, in the middle of homework.
--
-- It returns this account's questions today (mine), everyone's (total), this account's limit (cap), the questions from anonymous accounts today
-- (anon_total; the server keeps those to a share of the total, so throwaway
-- accounts cannot use up everyone's day), whether a step is still allowed,
-- and a ticket. When the model then fails (busy, down, too slow), the server
-- hands the ticket to refund_agent_usage() and the question is given back.
-- The ticket never leaves the server, so a student cannot refund a question
-- that reached the model.
--
-- user_id is deliberately not a foreign key. A count row is an id and a
-- number, it is removed soon after its day, and keeping it when an account is
-- deleted is what stops delete-and-sign-up-again from resetting the day.

create table if not exists agent_usage (
  user_id uuid not null,
  day date not null default current_date,
  count int not null default 0,
  primary key (user_id, day)
);
alter table agent_usage add column if not exists steps int not null default 0;
alter table agent_usage enable row level security;

-- The day's totals in one row per kind of account (email, anonymous), so the
-- check on every request reads a few rows instead of adding up every account.
create table if not exists agent_usage_total (
  day date not null,
  kind text not null check (kind in ('email', 'anonymous')),
  questions bigint not null default 0,
  primary key (day, kind)
);
alter table agent_usage_total enable row level security;

create table if not exists agent_usage_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  day date not null,
  step boolean not null,
  kind text not null,
  counted boolean not null,
  at timestamptz not null default now()
);
alter table agent_usage_tickets enable row level security;

drop function if exists bump_agent_usage();
create or replace function bump_agent_usage(is_step boolean default false)
returns table (mine int, total bigint, cap int, anon_account boolean, anon_total bigint, steps_ok boolean, ticket uuid)
language plpgsql security definer set search_path = public as $$
declare
  today date := (now() at time zone 'America/Los_Angeles')::date;
  anon boolean := coalesce(anonymous_account(), false);
  who text := case when anon then 'anonymous' else 'email' end;
  lim int := case when anon then 15 else 60 end;
  before_q int; before_s int; n int; s int; counted boolean; t uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  -- Housekeeping about once in a hundred requests rather than on every one:
  -- counts and tickets from earlier days, and anonymous accounts nobody has
  -- used for 30 days (Supabase does not remove those itself; a browser whose
  -- account was removed simply gets a new one).
  if random() < 0.01 then
    delete from agent_usage where day < today - 1;
    delete from agent_usage_total where day < today - 7;
    delete from agent_usage_tickets where at < now() - interval '1 hour';
    delete from auth.users
    where is_anonymous and id <> auth.uid()
      and coalesce(last_sign_in_at, created_at) < now() - interval '30 days';
  end if;

  select a.count, a.steps into before_q, before_s from agent_usage a where a.user_id = auth.uid() and a.day = today;
  before_q := coalesce(before_q, 0);
  before_s := coalesce(before_s, 0);
  -- A step is allowed only while there have been fewer than six for every
  -- question asked today: steps follow questions, so they cannot stand in
  -- for them (a request is a step when the student's side of it is only
  -- tool results, which a client could send without asking anything).
  counted := case when is_step then before_s < before_q * 6 else before_q <= lim end;
  insert into agent_usage as u (user_id, day, count, steps)
    values (auth.uid(), today, case when is_step then 0 else 1 end, 0)
  on conflict (user_id, day) do update set
    count = case when is_step or u.count > lim then u.count else u.count + 1 end,
    steps = case when is_step and u.steps < u.count * 6 then u.steps + 1 else u.steps end;
  select a.count, a.steps into n, s from agent_usage a where a.user_id = auth.uid() and a.day = today;

  -- Only a question that was counted moves the day's total.
  if counted and not is_step then
    insert into agent_usage_total as g (day, kind, questions) values (today, who, 1)
    on conflict (day, kind) do update set questions = g.questions + 1;
  end if;
  insert into agent_usage_tickets (user_id, day, step, kind, counted)
    values (auth.uid(), today, is_step, who, counted) returning id into t;

  return query select n,
    (select coalesce(sum(g.questions), 0)::bigint from agent_usage_total g where g.day = today),
    lim, anon,
    (select coalesce(sum(g.questions), 0)::bigint from agent_usage_total g where g.day = today and g.kind = 'anonymous'),
    case when is_step then counted else true end, t;
end $$;

-- Gives back what one bump counted, when the model failed to answer. Only
-- the account that made the ticket can use it, only once, and only for two
-- minutes.
create or replace function refund_agent_usage(ticket_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare tk agent_usage_tickets;
begin
  if auth.uid() is null then return; end if;
  delete from agent_usage_tickets
  where id = ticket_id and user_id = auth.uid() and at > now() - interval '2 minutes'
  returning * into tk;
  if tk.id is null or not tk.counted then return; end if;
  update agent_usage set
    count = case when tk.step then count else greatest(count - 1, 0) end,
    steps = case when tk.step then greatest(steps - 1, 0) else steps end
  where user_id = auth.uid() and day = tk.day;
  if not tk.step then
    update agent_usage_total set questions = greatest(questions - 1, 0) where day = tk.day and kind = tk.kind;
  end if;
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


-- ------------------------------------------------------------- usage counts
-- Anonymous counts of use, so the person who runs Cadence can see whether
-- people come back and whether they get as far as having work in a plan. Only
-- when site.countUsage is true in src/config.js (see lib/metrics.js).
--
-- A row is: a random ID made by one browser, a day, and one of a few words
-- (active, onboarded, has_work, checked_in, connected). The ID is not the
-- account, the name, the email or anything else, and is made again if the
-- person turns usage counts off. No IP address, cookie, page, title or message
-- is ever kept, and nothing comes from email. The day is the server's, not the
-- browser's. Rows older than 400 days are deleted.
--
-- Anyone can send these, so the numbers are estimates, not a meter. What stops
-- abuse is that a request can only add one of five words for one ID for one
-- day, and that the table is capped per day.

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

  -- A milestone is counted once per ID, on the first day it is seen.
  if p_event <> 'active' and exists (select 1 from usage_events u where u.install_id = p_id and u.event = p_event) then return; end if;
  -- A day's rows are capped, so a flood of made-up IDs cannot fill the table.
  if (select count(*) from usage_events u where u.day = current_date) >= 50000 then return; end if;

  insert into usage_events (install_id, day, event) values (p_id, current_date, p_event) on conflict do nothing;
end $$;

-- Someone who turns usage counts off, or deletes their data, takes their rows
-- with them. The ID is a random secret held by their browser, so knowing it is
-- the permission.
create or replace function forget_usage(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_id is null then raise exception 'no id'; end if;
  delete from usage_events where install_id = p_id;
  delete from ux_events where install_id = p_id;
  delete from ux_quota where install_id = p_id;
end $$;


-- ------------------------------------------------------ how the app is used
-- With the same random ID as the counts above, and only after the same
-- agreement: which screen is open and for how long it is used, which control
-- is pressed (by its name in Cadence's code, never what was typed or where on
-- the screen), presses on things that are not controls, quick repeated
-- presses, how far setup and the tour get, errors (their kind and the place in
-- Cadence's code), and how long Cadence's own requests take. See
-- src/panel/insight.js, which decides what is recorded, and lib/metrics.js,
-- which sends it.
--
-- A row is: the random ID, a random ID for the visit (new each time the app is
-- opened), its order in the visit, the server's time, a kind from a fixed
-- list, a name made of code characters only, the screen it happened on, and a
-- number (milliseconds, a count, or a step). Rows older than 180 days are
-- deleted. Nothing from email: Cadence's email screens are never recorded.

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
  planner_state, agent_usage, agent_usage_total, agent_usage_tickets, join_attempts, visit_counts, usage_events, ux_events, ux_quota, funnel_counts, owners, partner_overview from anon, authenticated;

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
grant delete on nudges to authenticated;                            -- its recipient can clear it
grant select on club_posts to authenticated;
grant insert (club_id, text) on club_posts to authenticated;
grant select, insert, update, delete on planner_state to authenticated;
grant select on partner_overview to authenticated;

-- agent_usage (and its totals and tickets), join_attempts, visit_counts and
-- the usage tables (usage_events, ux_events, ux_quota, funnel_counts) and
-- owners are granted to nobody. They are reached only
-- through their functions, which run with the database owner's rights, and
-- read by the project's owner in the dashboard.

-- Functions. A new function can be run by anyone until that is taken away,
-- so it is taken away from everyone first and then given to who needs it.
revoke execute on function
  my_club_ids(), is_connected(uuid), accept_invite(text), create_club(text, text, jsonb), join_club(text), rotate_club_code(uuid), leave_club(uuid),
  club_members_progress(uuid, timestamptz), my_club_overview(timestamptz),
  bump_agent_usage(boolean), refund_agent_usage(uuid), delete_my_account(), count_visit(text, text, text), record_usage(uuid, text), forget_usage(uuid), record_events(uuid, uuid, jsonb), count_steps(text[]), insights(integer), handle_new_user(), club_sessions(jsonb),
  limit_per_day(), anonymous_account()
  from public, anon, authenticated;

grant execute on function
  my_club_ids(), is_connected(uuid), accept_invite(text), create_club(text, text, jsonb), join_club(text), rotate_club_code(uuid), leave_club(uuid),
  club_members_progress(uuid, timestamptz), my_club_overview(timestamptz),
  bump_agent_usage(boolean), refund_agent_usage(uuid), delete_my_account(), anonymous_account(), insights(integer)
  to authenticated;

-- The visit counter and the usage counts are the only things a visitor without
-- an account can call.
grant execute on function count_visit(text, text, text) to anon, authenticated;
grant execute on function record_usage(uuid, text), forget_usage(uuid) to anon, authenticated;
grant execute on function record_events(uuid, uuid, jsonb), count_steps(text[]) to anon, authenticated;

-- Tell the API to look again, so the grants and functions above are in
-- effect straight away.
notify pgrst, 'reload schema';
