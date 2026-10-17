// Crew sync: partners, clubs, kudos and nudges.
//
// Accountability that works is social (Strava: people who know someone they
// care about can see their activity show up more consistently). That needs
// accounts and a shared database, so this file hides the backend behind one
// small adapter interface:
//
//   local     : single device, no account. Crew features show how to connect.
//   demo      : simulated friends and clubs, for the demo page.
//   supabase  : real accounts (email code sign-in) over Supabase's REST API.
//               Plain fetch, because an MV3 extension can't load remote scripts.
//               Schema + row-level security live in supabase/schema.sql.

import { uid, addDays, dateKey, startOfDay } from './util.js';

const PEOPLE_COLORS = ['#8b5cf6', '#10b981', '#3b82f6', '#ec4899', '#d97706', '#14b8a6'];

export function createSync(state, { demo = false, cloud = null } = {}) {
  if (demo) return demoAdapter(state);
  if (cloud?.signedIn) return supabaseAdapter(cloud);
  return localAdapter();
}

class CrewUnavailable extends Error {
  constructor() { super('Sign in with your email to use Crew.'); this.code = 'unavailable'; }
}

// ------------------------------------------------------------------ local

function localAdapter() {
  const no = async () => { throw new CrewUnavailable(); };
  return {
    mode: 'local', available: false, signedIn: false,
    me: () => null,
    feed: async () => [], partners: async () => [], clubs: async () => [], nudges: async () => [],
    share: async () => {}, kudos: no, nudge: no, invite: no, acceptInvite: no,
    createClub: no, joinClub: no, club: no, shoutout: no,
    leaveClub: no, removeMember: no, endPartnership: no, rotateCode: no
  };
}

// ------------------------------------------------------------------- demo

let demoCache = null;

function demoAdapter(state) {
  const now = Date.now();
  const ago = (min) => new Date(now - min * 60000).toISOString();
  if (!demoCache) {
    const people = {
      maya: { id: 'maya', name: 'Maya Chen', color: PEOPLE_COLORS[0] },
      jordan: { id: 'jordan', name: 'Jordan Lee', color: PEOPLE_COLORS[2] },
      priya: { id: 'priya', name: 'Priya Shah', color: PEOPLE_COLORS[1] },
      sam: { id: 'sam', name: 'Sam Rivera', color: PEOPLE_COLORS[4] },
      ava: { id: 'ava', name: 'Ava Brooks', color: PEOPLE_COLORS[3] },
      leo: { id: 'leo', name: 'Leo Park', color: PEOPLE_COLORS[5] },
      patel: { id: 'patel', name: 'Mr. Patel', color: '#475569' }
    };
    demoCache = {
      people,
      feed: [
        { id: 'f1', who: people.maya, title: 'Violin', kind: 'practice', color: '#8b5cf6', minutes: 45, feel: 'great', note: 'Finally got the shifting in the Bach right', at: ago(38), kudos: ['priya'], mine: false },
        { id: 'f2', who: people.jordan, title: 'Robotics build night', kind: 'club', color: '#3b82f6', minutes: 120, feel: 'good', note: 'Intake arm prototype works!', at: ago(150), kudos: ['maya', 'sam'], mine: false, club: 'Nueva Robotics' },
        { id: 'f3', who: people.priya, title: 'Cross-country', kind: 'sport', color: '#10b981', minutes: 50, feel: 'tough', note: 'Hill repeats. Legs are gone.', at: ago(60 * 20), kudos: [], mine: false },
        { id: 'f4', who: people.maya, title: 'SAT practice', kind: 'study', color: '#6366f1', minutes: 30, feel: 'good', note: '', at: ago(60 * 26), kudos: ['jordan'], mine: false }
      ],
      partners: [
        { id: 'maya', ...people.maya, since: dateKey(addDays(new Date(), -40)), sharing: ['Violin', 'SAT practice'], weekPct: 0.8, streak: 23, lastAt: ago(38) },
        { id: 'priya', ...people.priya, since: dateKey(addDays(new Date(), -12)), sharing: ['Cross-country'], weekPct: 0.5, streak: 6, lastAt: ago(60 * 20) }
      ],
      nudges: [
        { id: 'n1', from: people.maya, message: 'Piano tonight? I am doing violin at 7.', at: ago(95), seen: false }
      ],
      clubs: [
        {
          id: 'robotics', name: 'Nueva Robotics', kind: 'club', role: 'member', code: 'ROBO-7Q', leader: people.patel,
          commitment: { title: 'Build nights', sessions: 2, event: { label: 'Regionals', date: dateKey(addDays(new Date(), 146)) } },
          members: [
            { ...people.jordan, weekPct: 1, streak: 9 }, { ...people.sam, weekPct: 0.5, streak: 3 },
            { ...people.leo, weekPct: 0.5, streak: 5 }, { ...people.ava, weekPct: 0, streak: 0 }
          ],
          posts: [{ id: 'p1', from: people.patel, text: 'Big night Wednesday: the intake arm is working. Two build nights this week, everyone.', at: ago(60 * 30) }]
        },
        {
          id: 'green', name: 'Green Team', kind: 'club', role: 'leader', code: 'GREEN-4K', leader: null,
          commitment: { title: 'Compost audit shifts', sessions: 1, event: { label: 'Earth Week report', date: dateKey(addDays(new Date(), 60)) } },
          members: [
            { ...people.priya, weekPct: 1, streak: 4 }, { ...people.ava, weekPct: 1, streak: 2 },
            { ...people.leo, weekPct: 0, streak: 0 }, { ...people.sam, weekPct: 0, streak: 0 },
            { id: 'nina', name: 'Nina Alvarez', color: '#ec4899', weekPct: 1, streak: 6 }
          ],
          posts: []
        }
      ]
    };
  }
  const c = demoCache;
  const meName = state.profile?.name || 'You';
  const clubSummary = (club) => ({
    ...club,
    memberCount: club.members.length + 1,
    teamPct: club.members.length ? club.members.reduce((a, m) => a + m.weekPct, 0) / club.members.length : 0
  });

  return {
    mode: 'demo', available: true, signedIn: true,
    me: () => ({ id: 'me', name: meName }),
    feed: async () => c.feed.slice().sort((a, b) => b.at.localeCompare(a.at)),
    partners: async () => c.partners,
    nudges: async () => c.nudges,
    clubs: async () => c.clubs.map(clubSummary),
    club: async (id) => { const club = c.clubs.find((x) => x.id === id); if (!club) throw new Error('Club not found'); return clubSummary(club); },
    share: async (checkin, commitment) => {
      if (!commitment?.share) return;
      c.feed.unshift({ id: uid('f'), who: { id: 'me', name: meName, color: '#f97316' }, title: commitment.title, kind: commitment.kind, color: commitment.color,
        minutes: checkin.minutes, feel: checkin.feel, note: checkin.note, at: new Date().toISOString(), kudos: [], mine: true });
      // A friend reacts, the way it happens in real life.
      setTimeout(() => { const item = c.feed.find((f) => f.mine && f.kudos.length === 0); if (item) item.kudos.push('maya'); }, 4000);
    },
    kudos: async (itemId) => {
      const item = c.feed.find((f) => f.id === itemId);
      if (!item) return;
      const i = item.kudos.indexOf('me');
      if (i >= 0) item.kudos.splice(i, 1); else item.kudos.push('me');
    },
    nudge: async () => {},
    seenNudge: async (id) => { const n = c.nudges.find((x) => x.id === id); if (n) n.seen = true; },
    invite: async () => ({ code: 'FIONA-3X9' }),
    acceptInvite: async (code) => {
      if (!/^[A-Z]+-[A-Z0-9]{3}$/i.test(code)) throw new Error("That code doesn't look right. It should look like MAYA-7K2.");
      const p = { id: uid('p'), name: 'Alex Kim', color: PEOPLE_COLORS[3], since: dateKey(new Date()), sharing: ['Guitar'], weekPct: 0.4, streak: 2, lastAt: new Date().toISOString() };
      c.partners.push(p);
      return p;
    },
    createClub: async ({ name, commitment, kind = 'club' }) => {
      const club = { id: uid('club'), name, kind, role: 'leader', code: `${name.replace(/[^A-Za-z]/g, '').slice(0, 5).toUpperCase() || 'CLUB'}-${Math.random().toString(36).slice(2, 4).toUpperCase()}`, leader: null, commitment, members: [], posts: [] };
      c.clubs.push(club);
      return clubSummary(club);
    },
    joinClub: async (code) => {
      const club = c.clubs.find((x) => x.code.toLowerCase() === String(code).trim().toLowerCase());
      if (club) return clubSummary(club);
      throw new Error('No club with that code. Check it with your leader.');
    },
    shoutout: async (clubId, text) => {
      const club = c.clubs.find((x) => x.id === clubId);
      if (club) club.posts.unshift({ id: uid('p'), from: { id: 'me', name: meName, color: '#f97316' }, text, at: new Date().toISOString() });
    },
    leaveClub: async (clubId) => { c.clubs = c.clubs.filter((x) => x.id !== clubId); },
    removeMember: async (clubId, userId) => {
      const club = c.clubs.find((x) => x.id === clubId);
      if (club) club.members = club.members.filter((m) => m.id !== userId);
    },
    endPartnership: async (partnerId) => { c.partners = c.partners.filter((p) => p.id !== partnerId); },
    rotateCode: async (clubId) => {
      const club = c.clubs.find((x) => x.id === clubId);
      if (!club) throw new Error('Club not found');
      club.code = `${club.code.split('-')[0]}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      return club.code;
    }
  };
}

// --------------------------------------------------------------- supabase

function supabaseAdapter(cloud) {
  // Sign-in and token refresh live in lib/cloud.js; crew is one more thing the
  // same account can do, not a separate login.
  const rest = async (path, opts) => {
    try { return await cloud.rest(path, opts); }
    catch (e) { throw new Error(String(e.message || '').replace(/^Sync failed/, 'Crew sync failed')); }
  };
  const session = { get user() { return cloud.user(); } };

  const rpc = (name, args) => rest(`rpc/${name}`, { method: 'POST', body: args });
  const uidOf = () => session?.user?.id;
  const weekStartIso = () => { const d = startOfDay(new Date()); return addDays(d, -((d.getDay() + 6) % 7)).toISOString(); };

  return {
    mode: 'supabase',
    available: true,
    get signedIn() { return cloud.signedIn; },
    me: () => cloud.user(),

    feed: async ({ partnerIds = [], clubIds = [] } = {}) => {
      // Asked for by whose and which clubs', which the database can answer
      // from its indexes. Without these filters it had to read every visible
      // row of the whole table to find the newest 40. The rules about who may
      // see what still apply on top (schema.sql, "see connected check-ins").
      const uuid = /^[0-9a-f-]{36}$/i;
      const people = [uidOf(), ...partnerIds].filter((x) => uuid.test(String(x || '')));
      const clubs = clubIds.filter((x) => uuid.test(String(x || '')));
      if (!people.length) return [];
      const who = `or=(user_id.in.(${people.join(',')})${clubs.length ? `,club_id.in.(${clubs.join(',')})` : ''})`;
      const since = new Date(Date.now() - 60 * 86400000).toISOString();
      const rows = await rest(`checkins?select=id,user_id,title,kind,color,minutes,feel,note,at,profiles!checkins_user_id_fkey(name,color),kudos(from_user)&${who}&at=gte.${encodeURIComponent(since)}&order=at.desc&limit=40`);
      return rows.map((r) => ({
        id: r.id, who: { id: r.user_id, name: r.profiles?.name || 'Someone', color: r.profiles?.color || '#94a3b8' },
        title: r.title, kind: r.kind, color: r.color, minutes: r.minutes, feel: r.feel, note: r.note, at: r.at,
        kudos: (r.kudos || []).map((k) => (k.from_user === uidOf() ? 'me' : k.from_user)), mine: r.user_id === uidOf()
      }));
    },
    share: async (checkin, commitment) => {
      if (!commitment?.share) return;
      // Kept inside the sizes the database accepts (supabase/schema.sql).
      await rest('checkins', { method: 'POST', body: {
        title: String(commitment.title || '').slice(0, 200), kind: commitment.kind, color: commitment.color, club_id: commitment.clubId || null,
        minutes: Math.min(1440, checkin.minutes), feel: checkin.feel, note: checkin.note ? String(checkin.note).slice(0, 1000) : null, at: checkin.at
      } });
    },
    kudos: async (itemId) => {
      const existing = await rest(`kudos?checkin_id=eq.${itemId}&from_user=eq.${uidOf()}`);
      if (existing.length) await rest(`kudos?checkin_id=eq.${itemId}&from_user=eq.${uidOf()}`, { method: 'DELETE' });
      else await rest('kudos', { method: 'POST', body: { checkin_id: itemId } });
    },
    nudge: (toUser, message) => rest('nudges', { method: 'POST', body: { to_user: toUser, message } }),
    nudges: async () => {
      const rows = await rest(`nudges?select=id,message,at,seen,from:profiles!nudges_from_user_fkey(id,name,color)&to_user=eq.${uidOf()}&order=at.desc&limit=10`);
      // A sender who is no longer connected cannot be seen any more, so their
      // profile comes back empty; their nudge still shows, from "Someone".
      return rows.map((r) => ({ id: r.id, from: r.from || { id: null, name: 'Someone' }, message: r.message, at: r.at, seen: r.seen }));
    },
    seenNudge: (id) => rest(`nudges?id=eq.${id}`, { method: 'PATCH', body: { seen: true } }),

    invite: async () => {
      // Hard to guess (the browser's secure random source, about a trillion
      // codes) and easy to read out: no I, O, 0 or 1.
      const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const pick = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (x) => letters[x % 32]).join('');
      const code = `${pick(4)}-${pick(4)}`;
      await rest('invites', { method: 'POST', body: { code } });
      return { code };
    },
    acceptInvite: async (code) => {
      const id = await rpc('accept_invite', { invite_code: String(code).trim().toUpperCase() });
      const [p] = await rest(`profiles?select=id,name&id=eq.${id}`).catch(() => []);
      return { id, name: p?.name || '' };
    },
    partners: async () => {
      const rows = await rest('partner_overview?select=*');
      // week_pct is not worked out for partners yet (the target lives in each
      // person's own plan), so it stays null and no ring is drawn for it.
      return rows.map((r) => ({ id: r.partner_id, name: r.name, color: r.color, since: r.since, sharing: r.sharing || [], weekPct: r.week_pct ?? null, streak: r.streak || 0, lastAt: r.last_at }));
    },

    clubs: async () => {
      const rows = await rpc('my_club_overview', { week_start: weekStartIso() });
      return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, role: r.role, code: r.code, commitment: r.commitment, memberCount: r.member_count, teamPct: r.team_pct || 0, members: [], posts: [] }));
    },
    club: async (id) => {
      const [summary] = (await rpc('my_club_overview', { week_start: weekStartIso() })).filter((r) => r.id === id);
      if (!summary) throw new Error('Club not found');
      const members = await rpc('club_members_progress', { target_club: id, week_start: weekStartIso() });
      const posts = await rest(`club_posts?select=id,text,at,from:profiles(id,name,color)&club_id=eq.${id}&order=at.desc&limit=20`);
      return {
        id, name: summary.name, kind: summary.kind, role: summary.role, code: summary.code, commitment: summary.commitment,
        memberCount: summary.member_count, teamPct: summary.team_pct || 0,
        members: members.map((m) => ({ id: m.user_id, name: m.name, color: m.color, weekPct: m.week_pct || 0, streak: m.streak || 0 })),
        posts: posts.map((p) => ({ ...p, from: p.from || { id: null, name: 'Someone' } }))
      };
    },
    createClub: ({ name, commitment, kind = 'club' }) => rpc('create_club', { club_name: name, club_kind: kind, club_commitment: commitment }),
    joinClub: async (code) => {
      const id = await rpc('join_club', { club_code: String(code).trim().toUpperCase() });
      // A wrong code comes back empty (the database counts wrong tries; see join_club).
      if (!id) throw new Error('No club with that code. Check it with your leader.');
      const [c] = await rest(`clubs?select=id,name&id=eq.${id}`).catch(() => []);
      return { id, name: c?.name || '' };
    },
    shoutout: (clubId, text) => rest('club_posts', { method: 'POST', body: { club_id: clubId, text } }),
    // Through the database, so a leader's club passes to the next member (leave_club in schema.sql).
    leaveClub: (clubId) => rpc('leave_club', { target: clubId }),
    removeMember: (clubId, userId) => rest(`club_members?club_id=eq.${clubId}&user_id=eq.${userId}`, { method: 'DELETE' }),
    endPartnership: (partnerId) => {
      // Each pair is stored once, with the smaller id first (accept_invite).
      const [a, b] = [uidOf(), partnerId].sort();
      return rest(`partnerships?user_a=eq.${a}&user_b=eq.${b}`, { method: 'DELETE' });
    },
    rotateCode: (clubId) => rpc('rotate_club_code', { target: clubId })
  };
}
