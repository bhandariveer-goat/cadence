// Crew: accountability partners, clubs and classes, and a feed of people
// showing up — with kudos (Strava's lightest possible reinforcement) and
// nudges (Apple's "your friend just closed their rings").

import { app, loadCrew, push, persist, render } from '../core.js';
import { newCommitment } from '../../lib/habits.js';
import { fmtMinutes } from '../../lib/util.js';
import { svg, I, esc, avatar, ring, sheet, toast, ago, plural, daysUntil, KIND_ICON } from '../ui.js';
import { ART } from './parts.js';
import { crewAccountSheet } from './you.js';

const FEEL_WORD = { great: 'Felt great', good: '', tough: 'Tough one' };

export function viewCrew() {
  const teacher = app.S.settings.role === 'teacher';
  if (!app.sync?.available) return connectCrew(teacher);
  if (!app.crew.loaded) {
    queueMicrotask(() => loadCrew());
    return `<section class="hello"><h1>${teacher ? 'Clubs & classes' : 'Your crew'}</h1></section>
      <div class="card"><div class="skeleton" style="width:60%"></div><div class="skeleton" style="width:40%;margin-top:10px"></div></div>`;
  }
  const { feed, partners, clubs, error } = app.crew;

  return `
    <section class="hello">
      <h1>${teacher ? 'Clubs & classes' : 'Your crew'}</h1>
      <p>${teacher ? "See who's on track and cheer them on — without chasing anyone." : 'The people who notice when you show up.'}</p>
    </section>
    ${error ? `<div class="card warm small">${esc(error)}</div>` : ''}

    ${teacher ? '' : `
    <div class="section-head"><h2>Accountability partners</h2><button class="link" data-act="invite-partner">Invite</button></div>
    <div class="people">
      ${partners.map(personTile).join('')}
      <button class="person" data-act="invite-partner" aria-label="Invite a partner">
        <span style="width:62px;height:62px;border-radius:50%;display:grid;place-items:center;border:2px dashed var(--line);color:var(--muted)">${svg(I.plus, 22)}</span>
        <span class="name muted">Invite</span>
      </button>
    </div>
    ${!partners.length ? '<p class="hint" style="margin:0 4px 8px">Partners see your weekly rings and can nudge you. You see theirs.</p>' : ''}`}

    <div class="section">
      <div class="section-head"><h2>${teacher ? 'Your groups' : 'Clubs'}</h2><button class="link" data-act="club-join">Join with a code</button></div>
      ${clubs.map(clubCard).join('')}
      <button class="btn soft block" data-act="club-create">${svg(I.plus, 16)} ${teacher ? 'Start a club or class' : 'Start a club'}</button>
    </div>

    ${teacher ? '' : `
    <div class="section">
      <div class="section-head"><h2>Activity</h2></div>
      ${feed.length ? feed.map(feedCard).join('') : '<div class="card soft center small muted">When your partners and clubs check in, it shows up here.</div>'}
    </div>`}`;
}

function connectCrew(teacher) {
  return `<div class="empty">
    <div class="art">${ART}</div>
    <h2>${teacher ? 'Run clubs and classes' : 'Accountability works better together'}</h2>
    <p>${teacher
      ? "Set a team goal, see who's keeping up each week, and cheer people on — without chasing anyone."
      : 'Invite a friend, join your team or club, and cheer each other on. People who know someone is watching show up more.'}</p>
    <div class="card" style="text-align:left;margin-top:18px">
      ${[[I.users, 'Partners', 'See each other\'s weekly rings and send a nudge'],
        [I.trophy, 'Clubs', 'Team goals with a shared ring toward the big event'],
        [I.thumb, 'Kudos', 'One tap to say "I saw that"'],
        [I.lock, 'You choose', 'Only commitments you share leave your device']].map(([ic, t, m]) => `
        <div class="row" style="padding:6px 0"><span class="kind-ic" style="--c:var(--accent);width:36px;height:36px">${svg(ic, 18)}</span>
          <div class="grow"><b style="font-size:14.5px">${t}</b><div class="small muted">${m}</div></div></div>`).join('')}
    </div>
    <button class="btn primary block" data-act="crew-account">Connect a crew account</button>
    <p class="hint">Your school sets up Cadence Crew once; then everyone signs in with their school email.</p>
  </div>`;
}

function personTile(p) {
  return `<button class="person" data-act="open-person" data-id="${p.id}">
    ${ring({ pct: p.weekPct || 0, color: p.color, size: 62, stroke: 5, inner: avatar(p, 46), label: `${p.name}: ${Math.round((p.weekPct || 0) * 100)}% this week` })}
    <span class="name">${esc(p.name.split(' ')[0])}</span>
    ${p.streak ? `<span class="streak">${svg(I.flame, 11)}${p.streak}</span>` : ''}
  </button>`;
}

function clubCard(c) {
  const days = c.commitment?.event?.date ? daysUntil(c.commitment.event.date) : null;
  return `<button class="card row" data-act="open-club" data-id="${c.id}" style="width:100%;text-align:left;cursor:pointer;--c:#3b82f6">
    <span class="kind-ic">${svg(c.kind === 'class' ? I.school : I.users)}</span>
    <div class="grow">
      <div class="card-title">${esc(c.name)} ${c.role === 'leader' ? '<span class="pill accent" style="vertical-align:2px">Leader</span>' : ''}</div>
      <div class="card-sub">${esc(c.commitment?.title || 'Team goal')} · ${c.commitment?.sessions || 1}× a week${days != null && days >= 0 ? ` · ${esc(c.commitment.event.label)} in ${days}d` : ''}</div>
      <div class="small muted" style="margin-top:2px">${plural(c.memberCount || 1, 'member')}</div>
    </div>
    ${ring({ pct: c.teamPct || 0, color: 'var(--green)', size: 54, stroke: 6, inner: `<b style="font-size:12.5px;color:var(--text)">${Math.round((c.teamPct || 0) * 100)}%</b>`, label: 'Team this week' })}
  </button>`;
}

export function feedCard(f) {
  const mine = f.kudos.includes('me');
  const others = f.kudos.filter((k) => k !== 'me').length;
  return `<div class="feed-card" style="--c:${f.color}">
    <div class="feed-head">
      ${avatar(f.who, 38)}
      <div class="grow"><div class="t">${f.mine ? 'You' : esc(f.who.name)}</div><div class="m">${ago(f.at)}${f.club ? ` · ${esc(f.club)}` : ''}</div></div>
    </div>
    <div class="feed-body">
      <div class="feed-activity"><span class="kind-ic">${svg(KIND_ICON[f.kind] || I.star)}</span>${esc(f.title)} · ${fmtMinutes(f.minutes)}</div>
      ${f.note ? `<div class="feed-note">${esc(f.note)}</div>` : ''}
      ${FEEL_WORD[f.feel] ? `<div class="small muted" style="margin-top:4px">${FEEL_WORD[f.feel]}</div>` : ''}
    </div>
    <div class="feed-actions">
      ${f.mine
        ? `<span class="small muted" style="padding:8px 12px">${f.kudos.length ? `${svg(I.thumb, 14)} ${plural(f.kudos.length, 'kudo')}` : 'Shared with your crew'}</span>`
        : `<button class="kudos ${mine ? 'on' : ''}" data-act="kudos" data-id="${f.id}" aria-pressed="${mine}">${svg(I.thumb, 18)}<span>${mine ? 'Kudos' : 'Give kudos'}${others + (mine ? 1 : 0) ? ` · ${others + (mine ? 1 : 0)}` : ''}</span></button>`}
    </div>
  </div>`;
}

// ------------------------------------------------------------------- club

export function viewClub() {
  const id = app.clubId;
  const cached = app.clubDetail?.[id];
  if (!cached) {
    queueMicrotask(() => loadClub(id));
    return `<button class="back" data-act="back">${svg(I.left, 16)} Back</button>
      <div class="card"><div class="skeleton" style="width:55%"></div><div class="skeleton" style="width:35%;margin-top:10px"></div></div>`;
  }
  const c = cached;
  const leader = c.role === 'leader';
  const days = c.commitment?.event?.date ? daysUntil(c.commitment.event.date) : null;
  const behind = c.members.filter((m) => m.weekPct < 1);
  const adopted = (app.S.commitments || []).some((x) => x.clubId === c.id && !x.archived);
  const who = c.kind === 'class' ? 'students' : 'members';

  return `
    <button class="back" data-act="back">${svg(I.left, 16)} Crew</button>
    <section class="hello" style="text-align:center;padding-top:0">
      <div style="display:grid;place-items:center;margin-bottom:10px">
        ${ring({ pct: c.teamPct, color: 'var(--green)', size: 116, stroke: 12, inner: `<b style="font-size:28px;font-weight:850;color:var(--text)">${Math.round(c.teamPct * 100)}%</b>`, label: 'Team progress this week' })}
      </div>
      <h1>${esc(c.name)}</h1>
      <p>${esc(c.commitment?.title || 'Team goal')} · ${c.commitment?.sessions || 1}× a week${days != null && days >= 0 ? ` · <b>${esc(c.commitment.event.label)}</b> in ${plural(days, 'day')}` : ''}</p>
    </section>

    ${leader ? `
      <div class="card">
        <div class="row between"><div><div class="card-title">Invite ${who}</div><div class="card-sub">They join with this code</div></div>
          <button class="btn small soft" data-act="club-copy" data-code="${esc(c.code)}">${svg(I.copy, 14)} Copy</button></div>
        <div class="code" style="margin-top:12px">${esc(c.code)}</div>
      </div>
      <div class="row" style="gap:8px;margin-bottom:12px">
        <button class="btn soft grow" data-act="club-post">${svg(I.chat, 16)} Post an update</button>
        ${behind.length ? `<button class="btn soft grow" data-act="club-nudge-all">${svg(I.bolt, 16)} Nudge ${behind.length}</button>` : ''}
      </div>` : !adopted ? `
      <div class="card good row"><div class="grow"><div class="card-title">Add this to your plan</div><div class="card-sub">Cadence will schedule it and count your check-ins toward the team.</div></div>
        <button class="btn small primary" data-act="club-adopt">Add</button></div>` : ''}

    <div class="section-head"><h2>This week</h2><span class="muted">${c.members.filter((m) => m.weekPct >= 1).length} of ${c.members.length} on track</span></div>
    <div class="card flush">
      ${c.members.slice().sort((a, b) => b.weekPct - a.weekPct).map((m) => `
        <div class="item">
          ${avatar(m, 38)}
          <div class="grow"><div class="t">${esc(m.name)}</div>
            <div class="m">${m.weekPct >= 1 ? 'Hit the goal' : m.weekPct > 0 ? 'Partway there' : 'Not yet this week'}${m.streak ? ` · ${svg(I.flame, 12)} ${m.streak}` : ''}</div></div>
          ${leader && m.weekPct < 1 ? `<button class="btn small ghost" data-act="club-nudge" data-id="${m.id}" data-name="${esc(m.name)}">${svg(I.bolt, 14)} Nudge</button>` : ''}
          ${ring({ pct: m.weekPct, color: 'var(--green)', size: 34, stroke: 4, label: `${m.name} this week` })}
        </div>`).join('') || '<div class="item"><div class="grow small muted">No one else yet — share the code.</div></div>'}
    </div>

    ${c.posts?.length ? `<div class="section"><div class="section-head"><h2>Updates</h2></div>
      ${c.posts.map((p) => `<div class="feed-card"><div class="feed-head">${avatar(p.from, 34)}<div class="grow"><div class="t">${esc(p.from?.name || 'Leader')}</div><div class="m">${ago(p.at)}</div></div></div>
        <div class="feed-note" style="margin:8px 0 4px 44px">${esc(p.text)}</div></div>`).join('')}</div>` : ''}`;
}

async function loadClub(id) {
  try {
    const detail = await app.sync.club(id);
    app.clubDetail = { ...(app.clubDetail || {}), [id]: detail };
  } catch (e) {
    toast(e.message);
    app.view = 'crew';
  }
  render();
}

// ---------------------------------------------------------------- actions

async function kudos(el) {
  const item = app.crew.feed.find((f) => f.id === el.dataset.id);
  if (!item) return;
  const i = item.kudos.indexOf('me');
  if (i >= 0) item.kudos.splice(i, 1); else item.kudos.push('me');
  render();
  const btn = document.querySelector(`[data-act="kudos"][data-id="${item.id}"]`);
  if (btn && i < 0) btn.classList.add('pop');
  try { await app.sync.kudos(item.id); } catch (e) { toast(e.message); loadCrew({ force: true }); }
}

async function openPerson(id) {
  const p = app.crew.partners.find((x) => x.id === id);
  if (!p) return;
  const messages = ['Practice tonight?', "You've got this", "Let's both check in by 9", 'Proud of you this week'];
  const res = await sheet(`
    <div class="sheet-hero">${ring({ pct: p.weekPct || 0, color: p.color, size: 70, stroke: 6, inner: avatar(p, 54) })}
      <div class="grow"><h2 style="margin:0">${esc(p.name)}</h2><div class="muted small">Partners since ${esc(p.since || 'recently')}${p.streak ? ` · ${svg(I.flame, 12)} ${p.streak}-day streak` : ''}</div></div></div>
    <div class="card soft small" style="margin:0 0 14px">Sharing: <b>${esc((p.sharing || []).join(', ') || 'nothing yet')}</b>${p.lastAt ? ` · last check-in ${ago(p.lastAt)}` : ''}</div>
    <div class="q" style="margin-top:0">Send a nudge</div>
    <div class="choices stacked">${messages.map((m) => `<button class="choice" name="msg" value="${esc(m)}">${esc(m)}</button>`).join('')}</div>
    <div class="actions"><button class="btn ghost" value="cancel">Close</button></div>`);
  if (!res?.get('msg')) return;
  try { await app.sync.nudge(p.id, res.get('msg')); toast(`Nudge sent to ${p.name.split(' ')[0]}`); }
  catch (e) { toast(e.message); }
}

async function invitePartner() {
  let code = '…';
  try { ({ code } = await app.sync.invite()); } catch (e) { return toast(e.message); }
  const res = await sheet(`
    <h2>Invite a partner</h2>
    <p class="lead">Pick someone who'll actually notice — a friend, teammate, sibling or parent. Share your code:</p>
    <div class="code">${esc(code)}</div>
    <button type="button" class="btn soft block" style="margin-top:10px" data-copy>${svg(I.copy, 16)} Copy code</button>
    <div class="q">Have a friend's code?</div>
    <div class="row" style="gap:8px"><input type="text" name="code" placeholder="MAYA-7K2" autocomplete="off" style="text-transform:uppercase">
      <button class="btn primary" name="op" value="accept">Add</button></div>
    <div class="actions"><button class="btn ghost" value="cancel">Done</button></div>`, {
    onMount(form) {
      form.querySelector('[data-copy]').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(code); toast('Code copied'); } catch { toast(`Your code is ${code}`); }
      });
    }
  });
  if (res?.get('op') !== 'accept') return;
  try {
    const p = await app.sync.acceptInvite(String(res.get('code') || ''));
    await loadCrew({ force: true });
    toast(`You and ${p?.name?.split(' ')[0] || 'your partner'} are connected`);
  } catch (e) { toast(e.message); }
}

async function joinClub() {
  const res = await sheet(`<h2>Join a club or class</h2><p class="lead">Your leader or teacher has the code.</p>
    <label class="field"><span>Code</span><input type="text" name="code" placeholder="ROBO-7Q" autocomplete="off" style="text-transform:uppercase"></label>
    <div class="actions"><button class="btn ghost" value="cancel">Cancel</button><button class="btn primary" name="op" value="join">Join</button></div>`);
  if (!res) return;
  try {
    const club = await app.sync.joinClub(String(res.get('code') || ''));
    await loadCrew({ force: true });
    toast(`Welcome to ${club?.name || 'the club'}`);
    if (club?.id) push('club', { clubId: club.id });
  } catch (e) { toast(e.message); }
}

async function createClub() {
  const teacher = app.S.settings.role === 'teacher';
  const res = await sheet(`
    <h2>${teacher ? 'Start a club or class' : 'Start a club'}</h2>
    <p class="lead">Set one weekly goal everyone works toward. Members see a shared ring; you see who's on track.</p>
    <label class="field"><span>Name</span><input type="text" name="name" placeholder="Green Team" maxlength="40" autocomplete="off"></label>
    <div class="field"><span>Type</span><div class="choices">
      <label class="choice"><input type="radio" name="kind" value="club" checked hidden> Club or team</label>
      <label class="choice"><input type="radio" name="kind" value="class" hidden> Class</label></div></div>
    <label class="field"><span>Weekly goal</span><input type="text" name="goal" placeholder="Practice rounds, build nights, research check-ins…" maxlength="50"></label>
    <label class="field"><span>Times per week</span><input type="number" name="sessions" min="1" max="7" value="2"></label>
    <div class="two">
      <label class="field"><span>Working toward <span class="muted">(optional)</span></span><input type="text" name="eventLabel" placeholder="Regionals"></label>
      <label class="field"><span>Date</span><input type="date" name="eventDate"></label>
    </div>
    <div class="actions"><button class="btn ghost" value="cancel">Cancel</button><button class="btn primary" name="op" value="create">Create</button></div>`, {
    onMount(form) {
      form.querySelectorAll('label.choice').forEach((l) => {
        const sync = () => form.querySelectorAll('label.choice').forEach((x) => x.setAttribute('aria-pressed', String(x.querySelector('input').checked)));
        l.addEventListener('click', () => setTimeout(sync));
        sync();
      });
    }
  });
  if (!res) return;
  const name = String(res.get('name') || '').trim();
  if (!name) return toast('Give it a name first');
  const eventLabel = String(res.get('eventLabel') || '').trim(), eventDate = String(res.get('eventDate') || '');
  try {
    const club = await app.sync.createClub({
      name, kind: String(res.get('kind') || 'club'),
      commitment: { title: String(res.get('goal') || '').trim() || 'Weekly goal', sessions: Math.max(1, Number(res.get('sessions')) || 1), event: eventLabel || eventDate ? { label: eventLabel || 'Big day', date: eventDate } : null }
    });
    await loadCrew({ force: true });
    toast(`${name} is ready — share the code`);
    if (club?.id) push('club', { clubId: club.id });
  } catch (e) { toast(e.message); }
}

async function postUpdate() {
  const res = await sheet(`<h2>Post an update</h2><p class="lead">Everyone in the club sees it. Specific praise works best.</p>
    <textarea name="text" placeholder="Huge build night Wednesday — the intake arm works. Two sessions this week, everyone!" maxlength="280"></textarea>
    <div class="actions"><button class="btn ghost" value="cancel">Cancel</button><button class="btn primary" name="op" value="post">Post</button></div>`);
  const text = String(res?.get('text') || '').trim();
  if (!text) return;
  try {
    await app.sync.shoutout(app.clubId, text);
    delete app.clubDetail[app.clubId];
    render();
    toast('Posted');
  } catch (e) { toast(e.message); }
}

export const actions = {
  kudos,
  'open-person': (el) => openPerson(el.dataset.id),
  'invite-partner': () => invitePartner(),
  'club-join': () => joinClub(),
  'club-create': () => createClub(),
  'open-club': (el) => { push('club', { clubId: el.dataset.id }); },
  'club-post': () => postUpdate(),
  'club-copy': async (el) => { try { await navigator.clipboard.writeText(el.dataset.code); toast('Code copied'); } catch { toast(el.dataset.code); } },
  'club-nudge': async (el) => {
    try { await app.sync.nudge(el.dataset.id, 'Quick reminder from your club — you’ve got this week!'); toast(`Nudged ${el.dataset.name.split(' ')[0]}`); }
    catch (e) { toast(e.message); }
  },
  'club-nudge-all': async () => {
    const club = app.clubDetail?.[app.clubId];
    const behind = club?.members.filter((m) => m.weekPct < 1) || [];
    try {
      await Promise.all(behind.map((m) => app.sync.nudge(m.id, `A friendly nudge from ${club.name} — still time this week!`)));
      toast(`Nudged ${plural(behind.length, 'member')}`);
    } catch (e) { toast(e.message); }
  },
  'club-adopt': async () => {
    const club = app.clubDetail?.[app.clubId];
    if (!club) return;
    const c = newCommitment({
      title: club.commitment?.title || club.name, kind: 'club', clubId: club.id, org: club.name,
      schedule: { mode: 'flexible' }, target: { sessions: club.commitment?.sessions || 1, minutes: 60 }, event: club.commitment?.event || null
    });
    await persist((st) => { st.commitments.push(c); });
    toast(`${c.title} is on your plan`);
  },
  'crew-account': () => crewAccountSheet()
};
