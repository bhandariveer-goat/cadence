// First run: who you are, what you're working toward, your school week, your
// pace. About a minute, and every answer becomes something real in the plan.

import { app, persist, go, insideCanvas, syncCanvas, loadCrew } from '../core.js';
import { weekProgress, isFixed } from '../../lib/habits.js';
import { fmtMinutes, dateKey } from '../../lib/util.js';
import { svg, I, esc, KIND_ICON, ring, daysLabel } from '../ui.js';
import { ART, ringsDeck, scheduleLabel } from './parts.js';
import { presetCommitment, commitmentEditor } from './commitments.js';
import { routineChoices, applyRoutine, paceControls, applyPace } from './you.js';

const TILES = [
  { kind: 'practice', label: 'Music or art', sub: 'Instrument, voice, drawing', title: 'Instrument practice' },
  { kind: 'sport', label: 'A sport', sub: 'Practice, training, meets', title: 'Team practice' },
  { kind: 'club', label: 'A club or team', sub: 'Robotics, debate, MUN', title: 'Club meeting' },
  { kind: 'service', label: 'Volunteering', sub: 'Service hours', title: 'Volunteering' },
  { kind: 'work', label: 'A job', sub: 'Shifts and hours', title: 'Part-time job' },
  { kind: 'study', label: 'College apps', sub: 'Essays, applications', title: 'College essays' },
  { kind: 'project', label: 'A personal project', sub: 'Coding, writing, making', title: 'Personal project' },
  { kind: 'wellness', label: 'Health & fitness', sub: 'Workouts, running, sleep', title: 'Workout' }
];
const COLOR = { practice: '#8b5cf6', sport: '#10b981', club: '#3b82f6', service: '#ec4899', work: '#d97706', study: '#6366f1', project: '#ef4444', wellness: '#14b8a6' };

function draft() {
  if (!app.ob) {
    const S = app.S;
    app.ob = {
      step: 0, picks: [], schoolEnd: S.profile.schoolEnd || '15:30', routine: S.profile.routine || 'afternoon-evening',
      weekend: S.profile.weekend || 'relaxed', cap: S.settings.dailyCapacityMin, style: 'steady'
    };
  }
  return app.ob;
}

function progress(n) {
  return `<div class="row between" style="margin-bottom:14px">
    <div class="progress grow">${[1, 2, 3, 4].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</div>
    <button class="link small" data-act="ob-skip" style="margin-left:14px;color:var(--muted)">Skip</button></div>`;
}

const foot = (next = 'Continue', back = true) => `<div class="foot">
  ${back ? '<button class="btn ghost" data-act="ob-back">Back</button>' : ''}
  <button class="btn primary" data-act="ob-next">${next}</button></div>`;

export function viewOnboarding() {
  const o = draft();
  const S = app.S;
  const first = String(S.profile.name || '').split(' ')[0];

  if (o.step === 0) {
    return `<div class="ob">
      <div class="art">${ART}</div>
      <h1>${first ? `Hi ${esc(first)}.` : 'Welcome to Cadence.'}<br>Let's build a week you'll actually stick to.</h1>
      <p class="lead">Homework shows up on its own. Cadence helps you show up for everything else — practice, teams, jobs, goals — and keeps you accountable to it.</p>
      <div class="rolecards">
        <button class="rolecard" data-act="ob-role" data-role="student"><span class="kind-ic" style="--c:var(--accent)">${svg(I.star, 24)}</span>
          <div class="grow"><b>I'm a student</b><span>Plan my week and stay consistent</span></div>${svg(I.right, 18)}</button>
        <button class="rolecard" data-act="ob-role" data-role="teacher"><span class="kind-ic" style="--c:var(--green)">${svg(I.users, 24)}</span>
          <div class="grow"><b>I'm a teacher or club leader</b><span>Create assignments, run clubs</span></div>${svg(I.right, 18)}</button>
      </div>
      <p class="hint center" style="margin-top:auto;padding-top:20px">About a minute. Everything stays on this device.</p>
    </div>`;
  }

  if (o.step === 1) {
    const existing = (S.commitments || []).filter((c) => !c.archived);
    return `<div class="ob">
      ${progress(1)}
      <h1>What are you working toward outside of class?</h1>
      <p class="lead">Pick everything that's part of your week. Nothing on Canvas keeps you accountable for these — Cadence will.</p>
      ${existing.length && !o.picks.length ? `<div class="card good small" style="margin-bottom:12px">You already have ${existing.length} set up — pick more or continue.</div>` : ''}
      <div class="tiles">${TILES.map((t) => `<button class="tile" data-act="ob-pick" data-kind="${t.kind}" aria-pressed="${o.picks.includes(t.kind)}" style="--c:${COLOR[t.kind]}">
        <span class="kind-ic">${svg(KIND_ICON[t.kind])}</span><div><b>${t.label}</b><small>${t.sub}</small></div></button>`).join('')}</div>
      ${foot(o.picks.length || existing.length ? 'Continue' : 'Just homework for now')}
    </div>`;
  }

  if (o.step === 2) {
    const list = (S.commitments || []).filter((c) => !c.archived);
    return `<div class="ob">
      ${progress(2)}
      <h1>Make each one real</h1>
      <p class="lead">We guessed the details. Tap one to set the days, times and why it matters.</p>
      <div class="card flush">
        ${list.map((c) => `<div class="item tap" data-act="edit-commit" data-id="${c.id}" style="--c:${c.color}" role="button" tabindex="0">
          <span class="kind-ic">${svg(KIND_ICON[c.kind] || I.star)}</span>
          <div class="grow"><div class="t">${esc(c.title)}</div><div class="m">${esc(scheduleLabel(c, daysLabel))}${c.why ? ` · ${esc(c.why)}` : ''}</div></div>
          ${svg(I.edit, 18)}</div>`).join('') || '<div class="item"><div class="grow small muted">Nothing yet — that\'s fine, you can add some later.</div></div>'}
        <div class="item tap" data-act="add-commit" role="button" tabindex="0"><span class="kind-ic" style="--c:var(--accent)">${svg(I.plus)}</span>
          <div class="grow"><div class="t" style="color:var(--accent)">Add something else</div></div></div>
      </div>
      ${foot()}
    </div>`;
  }

  if (o.step === 3) {
    return `<div class="ob">
      ${progress(3)}
      <h1>When do you usually get work done?</h1>
      <p class="lead">Homework and flexible practice only land in these times. Set commitments like practice are kept clear automatically.</p>
      <div data-ob-routine>${routineChoices(o)}</div>
      ${foot()}
    </div>`;
  }

  if (o.step === 4) {
    return `<div class="ob">
      ${progress(4)}
      <h1>Find your pace</h1>
      <p class="lead">A plan you'll believe beats a perfect one you won't follow.</p>
      <div class="card" data-ob-pace>${paceControls(o)}</div>
      ${foot('Build my week')}
    </div>`;
  }

  // step 5 — all set
  const count = Object.values(S.tasks).length;
  return `<div class="ob">
    <div class="art">${ART}</div>
    <h1>You're set${first ? `, ${esc(first)}` : ''}.</h1>
    <p class="lead">These are your rings. Close them each week — Cadence plans the time, reminds you, and keeps count.</p>
    ${(S.commitments || []).some((c) => !c.archived) ? ringsDeck({ withAdd: false }) : ''}
    <div class="card flush">
      <div class="integration"><span class="ic" style="color:var(--accent)">${svg(I.flame, 19)}</span>
        <div class="grow"><div class="t">Check in once a day</div><div class="m">That's a streak. Miss a day and a freeze covers it.</div></div></div>
      <div class="integration"><span class="ic" style="color:#3b82f6">${svg(I.school, 19)}</span>
        <div class="grow"><div class="t">${insideCanvas ? 'Homework comes from Canvas' : count ? `${count} assignments ready` : 'Homework from Canvas'}</div>
          <div class="m">${insideCanvas ? 'Bringing in your assignments now' : 'Connect with the Chrome extension, or add them yourself'}</div></div></div>
      <div class="integration"><span class="ic" style="color:var(--green)">${svg(I.trophy, 19)}</span>
        <div class="grow"><div class="t">Your activities record starts today</div><div class="m">Every check-in counts toward it</div></div></div>
    </div>
    <div class="foot"><button class="btn primary" data-act="ob-done">Let's go</button></div>
  </div>`;
}

async function finish() {
  app.ob = null;
  app.stack = [];
  app.view = app.S.settings.role === 'teacher' ? 'create' : 'today';
  await persist((st) => { st.profile.onboarded = true; });
  if (insideCanvas) syncCanvas({ quiet: true });
  if (app.sync?.available) loadCrew();
}

async function next() {
  const o = draft();
  if (o.step === 1 && o.picks.length) {
    await persist((st) => {
      for (const kind of o.picks) {
        if (st.commitments.some((c) => c.kind === kind && !c.archived)) continue;
        const tile = TILES.find((t) => t.kind === kind);
        st.commitments.push(presetCommitment(kind, { title: tile?.title, color: COLOR[kind] }));
      }
    });
    o.picks = [];
    o.step = 2;
  } else if (o.step === 1) {
    o.step = (app.S.commitments || []).some((c) => !c.archived) ? 2 : 3;
  } else if (o.step === 3) {
    await persist((st) => applyRoutine(st, o));
    o.step = 4;
  } else if (o.step === 4) {
    await persist((st) => { applyPace(st, o); st.settings.role = 'student'; });
    o.step = 5;
  } else {
    o.step += 1;
  }
  document.getElementById('view').scrollTop = 0;
  const { render } = await import('../core.js');
  render();
}

export const actions = {
  'ob-role': async (el) => {
    if (el.dataset.role === 'teacher') {
      app.ob = null;
      app.view = 'create';
      return persist((st) => { st.settings.role = 'teacher'; st.profile.onboarded = true; }, { recalc: false });
    }
    draft().step = 1;
    const { render } = await import('../core.js');
    render();
  },
  'ob-pick': async (el) => {
    const o = draft();
    const k = el.dataset.kind;
    o.picks = o.picks.includes(k) ? o.picks.filter((x) => x !== k) : [...o.picks, k];
    el.setAttribute('aria-pressed', String(o.picks.includes(k)));
    const btn = document.querySelector('[data-act="ob-next"]');
    if (btn) btn.textContent = o.picks.length || app.S.commitments.some((c) => !c.archived) ? 'Continue' : 'Just homework for now';
  },
  'ob-next': () => next(),
  'ob-back': async () => {
    const o = draft();
    o.step = Math.max(0, o.step - 1);
    if (o.step === 2 && !(app.S.commitments || []).some((c) => !c.archived)) o.step = 1;
    const { render } = await import('../core.js');
    render();
  },
  'ob-skip': () => finish(),
  'ob-done': () => finish()
};

/** Buttons inside shared controls (routine, pace) don't carry data-act; handle them here. */
export function handleOnboardingClick(ev) {
  if (app.S.profile.onboarded || !app.ob) return false;
  const o = app.ob;
  const r = ev.target.closest('[data-routine]'), w = ev.target.closest('[data-weekend]'), s = ev.target.closest('[data-style]');
  if (!r && !w && !s) return false;
  if (r) o.routine = r.dataset.routine;
  if (w) o.weekend = w.dataset.weekend;
  if (s) o.style = s.dataset.style;
  const host = document.querySelector('[data-ob-routine]');
  if (host && (r || w)) host.innerHTML = routineChoices(o);
  const pace = document.querySelector('[data-ob-pace]');
  if (pace && s) pace.innerHTML = paceControls(o);
  return true;
}

export function handleOnboardingChange(ev) {
  if (app.S.profile.onboarded || !app.ob) return false;
  if (ev.target.matches('[data-school]')) {
    app.ob.schoolEnd = ev.target.value;
    const host = document.querySelector('[data-ob-routine]');
    if (host) host.innerHTML = routineChoices(app.ob);
    return true;
  }
  return false;
}

export function handleOnboardingInput(ev) {
  if (app.S.profile.onboarded || !app.ob || !ev.target.matches('[data-cap]')) return false;
  const v = Number(ev.target.value);
  app.ob.cap = v;
  const root = ev.target.closest('[data-ob-pace]');
  root.querySelector('[data-cap-label]').textContent = fmtMinutes(v);
  root.querySelector('[data-cap-word]').textContent = v <= 75 ? 'Light' : v <= 135 ? 'Balanced' : v <= 195 ? 'Focused' : 'Intense';
  return true;
}
