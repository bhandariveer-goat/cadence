// Crew: accountability partners, clubs and classes, and a feed of people
// showing up — with kudos (Strava's lightest possible reinforcement) and
// nudges (Apple's "your friend just closed their rings").

import { app, back, loadCrew, push, persist, render, pendingInvite, clearPendingInvite, inviteLink, DEMO } from '../core.js';
import { newCommitment } from '../../lib/habits.js';
import { fmtMinutes } from '../../lib/util.js';
import { svg, I, esc, avatar, ring, sheet, toast, ago, plural, daysUntil, KIND_ICON, copyText, activityColor } from '../ui.js';
import { ART } from './parts.js';

const FEEL_WORD = { great: 'Felt great', good: '', tough: 'Tough one' };

/** The Crew tab: partners with their week's ring, clubs and classes, and
    the feed of shared check-ins. Without an account it explains what Crew is
    instead; while the crew loads it shows placeholders. A teacher sees the
    same tab as "Clubs & classes". */
export function viewCrew() {
  const teacher = app.S.settings.role === 'teacher';
  if (!app.sync?.available) return connectCrew(teacher);
  if (!app.crew.loaded) {
    queueMicrotask(() => loadCrew());
    return `<section class="hello"><h1>${teacher ? 'Clubs & classes' : 'Your crew'}</h1></section>
      <div class="card" aria-busy="true"><div class="skeleton"></div><div class="skeleton mt3"></div></div>`;
  }
  const { feed, partners, clubs, error } = app.crew;

  return `
    <section class="hello">
      <h1>${teacher ? 'Clubs & classes' : 'Your crew'}</h1>
      <p>${teacher ? "See who has checked in this week, and nudge anyone who has not." : 'The people who notice when you show up.'}</p>
    </section>
    ${error ? `<div class="card warm small">${esc(error)}</div>` : ''}

    ${teacher ? '' : `
    <div class="section-head"><h2>Accountability partners</h2><button class="link" data-act="invite-partner">Invite a partner</button></div>
    <div class="people">
      ${partners.map(personTile).join('')}
      <button class="person" data-act="invite-partner" aria-label="Invite a partner">
        <span class="person-add">${svg(I.plus, 20)}</span>
        <span class="name text-2">Invite</span>
      </button>
    </div>
    ${!partners.length ? '<p class="hint">Partners see the check-ins you share and can nudge you. You see theirs.</p>' : ''}`}

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

/** What Crew offers, shown before there is an account to share through. */
function connectCrew(teacher) {
  return `<div class="empty">
    <h2>${teacher ? 'Run clubs and classes' : 'Check in with a friend or your club'}</h2>
    <p>${teacher
      ? "Set a weekly goal for your team and see who has checked in."
      : "Invite a friend or join your club. You see each other's check-ins and can send a nudge."}</p>
    <div class="card left mt4 stack">
      ${[[I.users, 'Partners', 'See each other\'s check-ins and send a nudge'],
        [I.trophy, 'Clubs', 'Team goals with a shared ring toward the big event'],
        [I.thumb, 'Kudos', 'One tap to say "I saw that"'],
        [I.lock, 'You choose', 'Only the activities you share are visible to them']].map(([ic, t, m]) => `
        <div class="row"><span class="kind-ic sm">${svg(ic, 16)}</span>
          <div class="grow small"><b>${t}</b><div class="text-2">${m}</div></div></div>`).join('')}
    </div>
    <button class="btn primary block" data-act="crew-account">Add an email to your account</button>
    <p class="hint">Partners and clubs need an email sign-in, so your progress can reach the people you choose.</p>
  </div>`;
}

/** A partner: their avatar inside this week's ring (or on its own when the
    server sends no progress for them), first name and streak. */
function personTile(p) {
  return `<button class="person" data-act="open-person" data-id="${p.id}">
    ${p.weekPct == null ? avatar(p, 56) : ring({ pct: p.weekPct, size: 56, stroke: 4, inner: avatar(p, 44), label: `${p.name}: ${Math.round(p.weekPct * 100)}% this week` })}
    <span class="name">${esc(p.name.split(' ')[0])}</span>
    ${p.streak ? `<span class="streak">${svg(I.flame, 11)}${p.streak}</span>` : ''}
  </button>`;
}

/** A club or class on the Crew tab: its goal, how often, the countdown to its
    big day, how many members, and the team's ring for the week. */
function clubCard(c) {
  const days = c.commitment?.event?.date ? daysUntil(c.commitment.event.date) : null;
  return `<button class="card tap row k-event" data-act="open-club" data-id="${c.id}">
    <span class="kind-ic">${svg(c.kind === 'class' ? I.school : I.users)}</span>
    <div class="grow">
      <div class="card-title">${esc(c.name)} ${c.role === 'leader' ? '<span class="pill accent">Leader</span>' : ''}</div>
      <div class="card-sub">${esc(c.commitment?.title || 'Team goal')} · ${c.commitment?.sessions || 1}× a week${days != null && days >= 0 ? ` · ${esc(c.commitment.event.label)} in ${days}d` : ''}</div>
      <div class="card-sub mt0">${plural(c.memberCount || 1, 'member')}</div>
    </div>
    ${ring({ pct: c.teamPct || 0, size: 48, stroke: 4, inner: `<b class="ring-num">${Math.round((c.teamPct || 0) * 100)}%</b>`, label: 'Team this week' })}
  </button>`;
}

/** One shared check-in in the feed: who, when, what and for how long, their
    note and how it went, with the kudos button. */
export function feedCard(f) {
  const mine = f.kudos.includes('me');
  const others = f.kudos.filter((k) => k !== 'me').length;
  return `<div class="feed-card k-activity" style="--c:${activityColor(f)}">
    <div class="feed-head">
      ${avatar(f.who, 38)}
      <div class="grow"><div class="t">${f.mine ? 'You' : esc(f.who.name)}</div><div class="m">${ago(f.at)}${f.club ? ` · ${esc(f.club)}` : ''}</div></div>
    </div>
    <div class="feed-body">
      <div class="feed-activity"><span class="kind-ic">${svg(KIND_ICON[f.kind] || I.star)}</span>${esc(f.title)} · ${fmtMinutes(f.minutes)}</div>
      ${f.note ? `<div class="feed-note">${esc(f.note)}</div>` : ''}
      ${FEEL_WORD[f.feel] ? `<div class="small muted mt1">${FEEL_WORD[f.feel]}</div>` : ''}
    </div>
    <div class="feed-actions">
      ${f.mine
        ? `<span class="small muted">${f.kudos.length ? `${svg(I.thumb, 14)} ${plural(f.kudos.length, 'kudo')}` : 'Shared with your crew'}</span>`
        : `<button class="kudos ${mine ? 'on' : ''}" data-act="kudos" data-id="${f.id}" aria-pressed="${mine}">${svg(I.thumb, 18)}<span>${mine ? 'Kudos' : 'Give kudos'}${others + (mine ? 1 : 0) ? ` · ${others + (mine ? 1 : 0)}` : ''}</span></button>`}
    </div>
  </div>`;
}

// ------------------------------------------------------------------- club

/** One club or class: the team's week, each member's progress (with nudges
    for those behind, for the leader), its updates, and the code to join.
    Loads the club the first time it is opened. */
export function viewClub() {
  const id = app.clubId;
  const cached = app.clubDetail?.[id];
  if (!cached) {
    queueMicrotask(() => loadClub(id));
    return `<button class="back" data-act="back">${svg(I.left, 16)} Back</button>
      <div class="card" aria-busy="true"><div class="skeleton"></div><div class="skeleton mt3"></div></div>`;
  }
  const c = cached;
  const leader = c.role === 'leader';
  const days = c.commitment?.event?.date ? daysUntil(c.commitment.event.date) : null;
  const behind = c.members.filter((m) => m.weekPct < 1);
  const adopted = (app.S.commitments || []).some((x) => x.clubId === c.id && !x.archived);
  const who = c.kind === 'class' ? 'students' : 'members';

  return `
    <button class="back" data-act="back">${svg(I.left, 16)} Crew</button>
    <section class="hello center">
      <div class="stack center-items mb3">
        ${ring({ pct: c.teamPct, size: 112, stroke: 8, inner: `<b class="ring-num lg">${Math.round(c.teamPct * 100)}%</b>`, label: 'Team progress this week' })}
      </div>
      <h1>${esc(c.name)}</h1>
      <p>${esc(c.commitment?.title || 'Team goal')} · ${c.commitment?.sessions || 1}× a week${days != null && days >= 0 ? ` · <b>${esc(c.commitment.event.label)}</b> in ${plural(days, 'day')}` : ''}</p>
    </section>

    ${leader ? `
      <div class="card">
        <div class="card-title">Invite ${who}</div>
        <div class="card-sub">${inviteLink('club', c.code) ? 'Send the link: once they sign in with an email, Cadence asks them to join. Or they can type the code.' : 'They join with this code'}</div>
        <div class="code mt3">${esc(c.code)}</div>
        <div class="row gap2 mt3 wrap">
          ${inviteLink('club', c.code) ? `<button class="btn small primary" data-act="club-share" data-code="${esc(c.code)}" data-name="${esc(c.name)}">${svg(I.link, 14)} Share invite link</button>` : ''}
          <button class="btn small soft" data-copy="${esc(c.code)}">${svg(I.copy, 14)} Copy code</button>
          <button class="btn small ghost" data-act="club-rotate">New code</button>
        </div>
      </div>
      <div class="row gap2 mb3">
        <button class="btn soft grow" data-act="club-post">${svg(I.chat, 16)} Post an update</button>
        ${behind.length ? `<button class="btn soft grow" data-act="club-nudge-all">${svg(I.bolt, 16)} Nudge ${behind.length}</button>` : ''}
      </div>` : !adopted ? `
      <div class="card good row"><div class="grow"><div class="card-title">Add this to your plan</div><div class="card-sub">Cadence will schedule it and count your check-ins toward the team.</div></div>
        <button class="btn small primary" data-act="club-adopt">Add to my plan</button></div>` : ''}

    <div class="section-head"><h2>This week</h2><span class="muted">${c.members.filter((m) => m.weekPct >= 1).length} of ${c.members.length} on track</span></div>
    <div class="card flush">
      ${c.members.slice().sort((a, b) => b.weekPct - a.weekPct).map((m) => `
        <div class="item">
          ${avatar(m, 38)}
          <div class="grow"><div class="t">${esc(m.name)}</div>
            <div class="m">${m.weekPct >= 1 ? 'Hit the goal' : m.weekPct > 0 ? 'Partway there' : 'Not yet this week'}${m.streak ? ` · ${svg(I.flame, 12)} ${m.streak}` : ''}</div></div>
          ${leader && m.weekPct < 1 ? `<button class="btn small ghost" data-act="club-nudge" data-id="${m.id}" data-name="${esc(m.name)}">${svg(I.bolt, 14)} Nudge</button>` : ''}
          ${ring({ pct: m.weekPct, color: 'var(--green)', size: 34, stroke: 4, label: `${m.name} this week` })}
          ${leader ? `<button class="btn small ghost danger" data-act="club-remove" data-id="${m.id}" data-name="${esc(m.name)}">Remove</button>` : ''}
        </div>`).join('') || '<div class="item"><div class="grow small muted">No one else yet. Share the code.</div></div>'}
    </div>

    ${c.posts?.length ? `<div class="section"><div class="section-head"><h2>Updates</h2></div>
      ${c.posts.map((p) => `<div class="feed-card"><div class="feed-head">${avatar(p.from, 34)}<div class="grow"><div class="t">${esc(p.from?.name || 'Leader')}</div><div class="m">${ago(p.at)}</div></div></div>
        <div class="feed-body"><div class="feed-note">${esc(p.text)}</div></div></div>`).join('')}</div>` : ''}

    <button class="btn ghost danger block mt4" data-act="club-leave">Leave ${c.kind === 'class' ? 'class' : 'club'}</button>`;
}

/** Fetches one club's details, going back to Crew if that fails. */
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

/** Gives or takes back kudos on a check-in. The screen changes at once and is
    put right from the server if saving fails. */
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

/** A partner's sheet: what they share and when they last checked in, a choice
    of nudges to send, and the way to end the partnership. */
async function openPerson(id) {
  const p = app.crew.partners.find((x) => x.id === id);
  if (!p) return;
  const messages = ['Practice tonight?', "You've got this", "Let's both check in by 9", 'Proud of you this week'];
  const res = await sheet(`
    <div class="sheet-hero">${p.weekPct == null ? avatar(p, 64) : ring({ pct: p.weekPct, size: 64, stroke: 5, inner: avatar(p, 48) })}
      <div class="grow"><h2 class="m0">${esc(p.name)}</h2><div class="text-2 small">Partners since ${esc(p.since || 'recently')}${p.streak ? ` · ${svg(I.flame, 12)} ${p.streak}-day streak` : ''}</div></div></div>
    <div class="card soft small mb4">Sharing: <b>${esc((p.sharing || []).join(', ') || 'nothing yet')}</b>${p.lastAt ? ` · last check-in ${ago(p.lastAt)}` : ''}</div>
    <div class="q mt0">Send a nudge</div>
    <div class="choices stacked">${messages.map((m) => `<button class="choice" name="msg" value="${esc(m)}">${esc(m)}</button>`).join('')}</div>
    <div class="actions"><button class="btn ghost danger" name="op" value="end">End partnership</button><button class="btn ghost" value="cancel">Close</button></div>`);
  if (res?.get('op') === 'end') return endPartnership(p);
  if (!res?.get('msg')) return;
  try { await app.sync.nudge(p.id, res.get('msg')); toast(`Nudge sent to ${p.name.split(' ')[0]}`); }
  catch (e) { toast(e.message); }
}

/** Ends a partnership after asking. Either of them can start a new one later. */
async function endPartnership(p) {
  const first = p.name.split(' ')[0];
  const ok = await sheet(`<h2>End partnership with ${esc(first)}?</h2>
    <p class="lead">You stop seeing each other's check-ins and cannot nudge each other. To connect again, one of you sends a new invite.</p>
    <div class="actions"><button class="btn ghost" value="cancel">Keep partner</button><button class="btn danger-solid" name="op" value="end">End partnership</button></div>`);
  if (!ok) return;
  try { await app.sync.endPartnership(p.id); await loadCrew({ force: true }); toast(`You and ${first} are no longer partners`); }
  catch (e) { toast(e.message); }
}

/** Leaves the open club or class after saying what happens: a member just
    leaves; a leader's class is deleted, and a leader's club passes to the
    member who joined first (or is deleted if they were the only one). */
async function leaveClub() {
  const club = app.clubDetail?.[app.clubId];
  if (!club) return;
  const leading = club.role === 'leader';
  const what = !leading ? 'The club stops seeing your progress and check-ins. To come back, you need its code again.'
    : club.kind === 'class' ? 'You lead this class, so leaving deletes it for everyone in it.'
      : 'You lead this club. It passes to the member who joined first, or is deleted if no one else is in it.';
  const ok = await sheet(`<h2>Leave ${esc(club.name)}?</h2>
    <p class="lead">${what}</p>
    <div class="actions"><button class="btn ghost" value="cancel">Stay</button><button class="btn danger-solid" name="op" value="leave">Leave</button></div>`);
  if (!ok) return;
  try {
    await app.sync.leaveClub(club.id);
    delete app.clubDetail[club.id];
    await loadCrew({ force: true });
    back();
    toast(`You left ${club.name}`);
  } catch (e) { toast(e.message); }
}

/** The leader removes a member from the club. They could join again with the
    same code, which the sheet says, so a new code can be made as well. */
async function removeMember(el) {
  const club = app.clubDetail?.[app.clubId];
  if (!club) return;
  const name = el.dataset.name;
  const ok = await sheet(`<h2>Remove ${esc(name)}?</h2>
    <p class="lead">They leave ${esc(club.name)} and stop seeing its updates. They can join again with the code, so make a new code if you need to keep them out.</p>
    <div class="actions"><button class="btn ghost" value="cancel">Cancel</button><button class="btn danger-solid" name="op" value="remove">Remove</button></div>`);
  if (!ok) return;
  try {
    await app.sync.removeMember(club.id, el.dataset.id);
    delete app.clubDetail[club.id];
    render();
    toast(`Removed ${name.split(' ')[0]}`);
  } catch (e) { toast(e.message); }
}

/** Makes a new join code for the club. The old one stops working; members
    already in stay in. */
async function rotateCode() {
  const club = app.clubDetail?.[app.clubId];
  if (!club) return;
  const ok = await sheet(`<h2>Make a new code?</h2>
    <p class="lead">The old code stops working. Everyone already in ${esc(club.name)} stays in.</p>
    <div class="actions"><button class="btn ghost" value="cancel">Cancel</button><button class="btn primary" name="op" value="rotate">Make new code</button></div>`);
  if (!ok) return;
  try {
    const code = await app.sync.rotateCode(club.id);
    club.code = code;
    render();
    toast('New code ready');
  } catch (e) { toast(e.message); }
}

/** The partner sheet: make an invite (a link where the site has an address,
    otherwise a code) or type a friend's code to accept theirs. */
async function invitePartner() {
  // The invite is made only when the student asks for one, so opening this
  // sheet to type a friend's code does not use up an invite.
  let made = null;
  const res = await sheet(`
    <h2>Invite a partner</h2>
    <p class="lead">Pick someone who will actually notice: a friend, teammate, sibling or parent.</p>
    <div data-invite-out hidden><div class="code" data-invite-code></div>
      <input type="text" class="mt3 w100" readonly data-invite-link aria-label="Invite link" hidden>
      <p class="hint" data-invite-said role="status"></p></div>
    <button type="button" class="btn primary block" data-invite-make>${svg(I.link, 16)} ${inviteLink('partner', 'CODE') ? 'Share an invite link' : 'Get an invite code'}</button>
    <div class="q">Have a friend's code?</div>
    <div class="row gap2"><input type="text" class="code-input" name="code" placeholder="K7Q2-XM4P" autocomplete="off" spellcheck="false" aria-label="Partner code">
      <button class="btn soft" name="op" value="accept">Add partner</button></div>
    <div class="actions"><button class="btn ghost" value="cancel">Close</button></div>`, {
    onMount(form) {
      const btn = form.querySelector('[data-invite-make]');
      const said = (text) => { form.querySelector('[data-invite-said]').textContent = text; form.querySelector('[data-invite-out]').hidden = false; };
      btn.addEventListener('click', async () => {
        if (btn.getAttribute('aria-busy') === 'true') return;
        btn.setAttribute('aria-busy', 'true');
        try {
          made ||= await app.sync.invite();
          form.querySelector('[data-invite-code]').textContent = made.code;
          const link = inviteLink('partner', made.code);
          const field = form.querySelector('[data-invite-link]');
          const how = await shareInvite('partner', made.code);
          if (how === 'cancelled') { form.querySelector('[data-invite-out]').hidden = false; return; }
          // Where nothing could be shared or copied, the link is there to select.
          if (link && !how) { field.value = link; field.hidden = false; field.addEventListener('focus', () => field.select()); }
          said(how === 'shared' ? 'Sent. It works once, for the first person who uses it.'
            : how === 'copied' ? 'Copied. Paste it in a message to them. It works once, for the first person who uses it.'
              : link ? 'Copy this link and send it to them. It works once, for the first person who uses it.'
                : 'Send them this code. It works once, for the first person who uses it.');
        } catch (e) {
          said(e.message);
        } finally { btn.removeAttribute('aria-busy'); }
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

/**
 * Send an invite: the phone's share sheet where there is one, otherwise the
 * clipboard. The code goes in the message too, for anyone whose link opens in
 * a different browser. Returns 'shared', 'copied', 'cancelled' (the share
 * sheet was closed), or null when nothing could be shared or copied.
 */
async function shareInvite(kind, code, clubName = '') {
  const url = inviteLink(kind, code);
  const text = kind === 'club'
    ? `Join ${clubName || 'my club'} on Cadence${url ? `: ${url}` : '.'} If the link does not work, the code is ${code}.`
    : `Be my accountability partner on Cadence${url ? `: ${url}` : '.'} If the link does not work, the code is ${code}.`;
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ title: 'Cadence', text }); return 'shared'; }
    catch (e) { if (e?.name === 'AbortError') return 'cancelled'; }
  }
  return (await copyText(text)) ? 'copied' : null;
}

/**
 * An invite link this browser opened earlier, offered once the student is
 * signed in (partners and clubs need an email account). The app calls this
 * after it draws; it asks at most once per invite and kind of account.
 */
export async function offerPendingInvite() {
  if (DEMO) return;                          // a real invite waits for the real app
  const inv = pendingInvite();
  const mode = app.S.account?.mode;
  if (!inv || app.inviteBusy || app.inviteAsked === `${inv.code}|${mode}` || document.querySelector('dialog[open]')) return;
  app.inviteAsked = `${inv.code}|${mode}`;
  const what = inv.kind === 'club' ? 'join a club' : 'be accountability partners';
  if (!app.sync?.available) {
    if (mode !== 'local') return;
    const res = await sheet(`<h2>You have an invite</h2>
      <p class="lead">Someone invited you to ${what} on Cadence. Partners and clubs need an email account, so the check-ins you share can reach them. Your plan stays as it is.</p>
      <div class="actions"><button class="btn ghost" value="cancel">Not now</button><button class="btn primary" name="op" value="email">Add an email</button></div>`);
    if (res?.get('op') !== 'email') return clearPendingInvite();
    app.signin = { step: 'start', name: app.S.account?.name || '', email: '', upgrading: true };
    return render();
  }
  const res = await sheet(`<h2>${inv.kind === 'club' ? 'Join this club?' : 'Add an accountability partner?'}</h2>
    <p class="lead">${inv.kind === 'club'
      ? `You opened an invite to a club on Cadence, code <b>${esc(inv.code)}</b>. Members see each other's check-ins for the club's goal.`
      : `You opened an invite from a friend on Cadence, code <b>${esc(inv.code)}</b>. Partners see the check-ins you each choose to share, and can nudge each other.`}</p>
    <div class="actions"><button class="btn ghost" value="cancel">Not now</button><button class="btn primary" name="op" value="yes">${inv.kind === 'club' ? 'Join club' : 'Add partner'}</button></div>`);
  if (res?.get('op') !== 'yes') return clearPendingInvite();
  app.inviteBusy = true;
  try {
    if (inv.kind === 'club') {
      const club = await app.sync.joinClub(inv.code);
      clearPendingInvite();
      await loadCrew({ force: true });
      toast(`Welcome to ${club?.name || 'the club'}`);
      if (club?.id) push('club', { clubId: club.id });
    } else {
      const p = await app.sync.acceptInvite(inv.code);
      clearPendingInvite();
      await loadCrew({ force: true });
      toast(`You and ${p?.name?.split(' ')[0] || 'your partner'} are connected`);
      push('crew');
    }
  } catch (e) {
    clearPendingInvite();
    toast(e.message);
  } finally { app.inviteBusy = false; }
}

/** Joins a club or class by its code, then opens it. */
async function joinClub() {
  const res = await sheet(`<h2>Join a club or class</h2><p class="lead">Your leader or teacher has the code.</p>
    <label class="field"><span>Code</span><input type="text" class="code-input" name="code" placeholder="ROBOT-K7Q2XM" autocomplete="off" spellcheck="false"></label>
    <div class="actions"><button class="btn ghost" value="cancel">Cancel</button><button class="btn primary" name="op" value="join">Join club</button></div>`);
  if (!res) return;
  try {
    const club = await app.sync.joinClub(String(res.get('code') || ''));
    await loadCrew({ force: true });
    toast(`Welcome to ${club?.name || 'the club'}`);
    if (club?.id) push('club', { clubId: club.id });
  } catch (e) { toast(e.message); }
}

/** Starts a club (or, for a teacher, a class) with one weekly goal everyone
    works toward, and optionally a big day to count down to. */
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
      <label class="field"><span>Working toward <span class="muted">(optional)</span></span><input type="text" name="eventLabel" placeholder="Regionals" maxlength="40"></label>
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
    toast(`${name} is ready. Share the code.`);
    if (club?.id) push('club', { clubId: club.id });
  } catch (e) { toast(e.message); }
}

/** The leader posts an update that everyone in the club sees. */
async function postUpdate() {
  const res = await sheet(`<h2>Post an update</h2><p class="lead">Everyone in the club sees it. Specific praise works best.</p>
    <textarea name="text" placeholder="Big build night Wednesday: the intake arm works. Two sessions this week, everyone." maxlength="280"></textarea>
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
  'club-share': async (el) => {
    const how = await shareInvite('club', el.dataset.code, el.dataset.name);
    if (how === 'copied') return toast('Invite copied. Paste it in your group chat or a Canvas announcement.');
    if (how === 'shared' || how === 'cancelled') return;
    // Nothing could be shared or copied: show the link to select by hand.
    await sheet(`<h2>Invite link</h2>
      <p class="lead">Copy this link and send it to your ${el.dataset.name ? esc(el.dataset.name) : 'club'} group. Once they sign in with an email, Cadence asks them to join.</p>
      <input type="text" class="w100" readonly value="${esc(inviteLink('club', el.dataset.code) || '')}" aria-label="Invite link" data-select-all>
      <div class="actions"><button class="btn primary" value="cancel">Done</button></div>`, {
      onMount(form) { const f = form.querySelector('[data-select-all]'); f.addEventListener('focus', () => f.select()); }
    });
  },
  'club-create': () => createClub(),
  'open-club': (el) => { push('club', { clubId: el.dataset.id }); },
  'club-post': () => postUpdate(),
  'club-leave': () => leaveClub(),
  'club-remove': (el) => removeMember(el),
  'club-rotate': () => rotateCode(),
  'club-nudge': async (el) => {
    try { await app.sync.nudge(el.dataset.id, 'A reminder from your club: there is still time this week.'); toast(`Nudged ${el.dataset.name.split(' ')[0]}`); }
    catch (e) { toast(e.message); }
  },
  'club-nudge-all': async () => {
    const club = app.clubDetail?.[app.clubId];
    const behind = club?.members.filter((m) => m.weekPct < 1) || [];
    try {
      await Promise.all(behind.map((m) => app.sync.nudge(m.id, `A nudge from ${club.name}: there is still time this week.`)));
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
  'crew-account': () => push('account')
};
