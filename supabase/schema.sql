-- Cadence Crew backend (Supabase / Postgres).
--
-- Run this in the Supabase SQL editor for a new project, then:
--   Authentication → Providers → Email: enable, and edit the Magic Link email
--   template to include {{ .Token }} so students get a 6-digit code.
-- In Cadence: You → Connected → Crew account, paste the project URL + anon key.
--
-- Privacy model: you only ever see check-ins from your accountability
-- partners and people in clubs you've joined, and only for commitments you
-- chose to share. Everything else stays on your own device.

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

alter table profiles enable row level security;
alter table partnerships enable row level security;
alter table invites enable row level security;
alter table clubs enable row level security;
alter table club_members enable row level security;
alter table checkins enable row level security;
alter table kudos enable row level security;
alter table nudges enable row level security;
alter table club_posts enable row level security;

create policy "see connected profiles" on profiles for select using (is_connected(id));
create policy "write own profile" on profiles for insert with check (id = auth.uid());
create policy "update own profile" on profiles for update using (id = auth.uid());

create policy "see own partnerships" on partnerships for select using (auth.uid() in (user_a, user_b));
create policy "end own partnerships" on partnerships for delete using (auth.uid() in (user_a, user_b));

create policy "see own invites" on invites for select using (owner = auth.uid());
create policy "create invites" on invites for insert with check (owner = auth.uid());

create policy "see my clubs" on clubs for select using (id in (select my_club_ids()));
create policy "leaders edit clubs" on clubs for update using (leader = auth.uid());

create policy "see members of my clubs" on club_members for select using (club_id in (select my_club_ids()));
create policy "leave clubs" on club_members for delete using (user_id = auth.uid());

create policy "see connected check-ins" on checkins for select using (is_connected(user_id));
create policy "share own check-ins" on checkins for insert with check (user_id = auth.uid() and (club_id is null or club_id in (select my_club_ids())));
create policy "delete own check-ins" on checkins for delete using (user_id = auth.uid());

create policy "see kudos on visible check-ins" on kudos for select using (exists (select 1 from checkins c where c.id = checkin_id));
create policy "give kudos" on kudos for insert with check (from_user = auth.uid() and exists (select 1 from checkins c where c.id = checkin_id));
create policy "take back kudos" on kudos for delete using (from_user = auth.uid());

create policy "see my nudges" on nudges for select using (auth.uid() in (from_user, to_user));
create policy "nudge connections" on nudges for insert with check (from_user = auth.uid() and is_connected(to_user));
create policy "mark nudges seen" on nudges for update using (to_user = auth.uid());

create policy "read club posts" on club_posts for select using (club_id in (select my_club_ids()));
create policy "post in my clubs" on club_posts for insert with check (from_user = auth.uid() and club_id in (select my_club_ids()));

-- -------------------------------------------------------------------- rpcs

create or replace function accept_invite(invite_code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare inviter uuid;
begin
  select owner into inviter from invites where code = invite_code and used_by is null;
  if inviter is null then raise exception 'That invite code is invalid or already used'; end if;
  if inviter = auth.uid() then raise exception 'That''s your own invite code'; end if;
  insert into partnerships (user_a, user_b) values (least(inviter, auth.uid()), greatest(inviter, auth.uid())) on conflict do nothing;
  update invites set used_by = auth.uid() where code = invite_code;
  return inviter;
end $$;

create or replace function create_club(club_name text, club_kind text, club_commitment jsonb) returns clubs
language plpgsql security definer set search_path = public as $$
declare new_club clubs;
begin
  insert into clubs (name, kind, code, leader, commitment)
  values (club_name, coalesce(club_kind, 'club'),
          upper(regexp_replace(left(club_name, 5), '[^A-Za-z]', '', 'g')) || '-' || upper(substr(md5(random()::text), 1, 3)),
          auth.uid(), club_commitment)
  returning * into new_club;
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

-- Weekly progress: check-ins shared to a club this week vs the club's target.
create or replace function club_members_progress(target_club uuid, week_start timestamptz)
returns table (user_id uuid, name text, color text, week_pct numeric, streak int)
language sql stable security definer set search_path = public as $$
  select m.user_id, p.name, p.color,
         least(1, count(c.id)::numeric / greatest(1, coalesce((cl.commitment->>'sessions')::int, 1))),
         0
  from club_members m
  join clubs cl on cl.id = m.club_id
  join profiles p on p.id = m.user_id
  left join checkins c on c.user_id = m.user_id and c.club_id = m.club_id and c.at >= week_start
  where m.club_id = target_club and target_club in (select my_club_ids()) and m.user_id <> auth.uid()
  group by m.user_id, p.name, p.color, cl.commitment
$$;

create or replace function my_club_overview(week_start timestamptz)
returns table (id uuid, name text, kind text, role text, code text, commitment jsonb, member_count int, team_pct numeric)
language sql stable security definer set search_path = public as $$
  select cl.id, cl.name, cl.kind, me.role,
         case when me.role = 'leader' then cl.code else cl.code end,
         cl.commitment,
         (select count(*)::int from club_members where club_id = cl.id),
         (select avg(week_pct) from club_members_progress(cl.id, week_start))
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
