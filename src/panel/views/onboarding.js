// First run, after signing in: what do you do outside class, and when is
// school. Two screens.
//
// It used to be five, and two of them asked when you like to work and how much
// a night. Nobody knows the answer to either, and the answers made every
// Tuesday identical whether or not Tuesday had a meet. Cadence works both out
// from the calendar now (lib/daymodel.js), so the questions are gone.

import { app, persist, render, insideCanvas, syncCanvas, loadCrew } from '../core.js';
import { svg, I, esc, KIND_ICON, daysLabel, range } from '../ui.js';
import { ART, scheduleLabel } from './parts.js';
import { presetCommitment } from './commitments.js';
import { interpret, applyOps } from '../../lib/agent.js';

const TILES = [
  { kind: 'practice', label: 'Music or art', sub: 'Instrument, voice, drawing', title: 'Instrument practice' },
  { kind: 'sport', label: 'A sport', sub: 'Practice, training, meets', title: 'Team practice' },
  { kind: 'club', label: 'A club or team', sub: 'Robotics, debate, MUN', title: 'Club meeting' },
  { kind: 'service', label: 'Volunteering', sub: 'Service hours', title: 'Volunteering' },
  { kind: 'work', label: 'A job', sub: 'Shifts and hours', title: 'Part-time job' },
  { kind: 'study', label: 'College apps', sub: 'Essays, applications', title: 'College essays' },
  { kind: 'project', label: 'A personal project', sub: 'Coding, writing, making', title: 'Personal project' },
  { kind: 'wellness', label: 'Health and fitness', sub: 'Workouts, running', title: 'Workout' }
];

function draft() {
  app.ob ||= { step: 0, picks: [], said: '' };
  return app.ob;
}

const foot = (next, back) => `<div class="foot">
  ${back ? '<button class="btn ghost" data-act="ob-back">Go back</button>' : ''}
  <button class="btn primary" data-act="ob-next">${next}</button></div>`;

export function viewOnboarding() {
  const o = draft();
  const S = app.S;
  const first = String(S.account?.name || S.profile.name || '').split(' ')[0];
  const list = (S.commitments || []).filter((c) => !c.archived);

  if (o.step === 0) {
    return `<div class="ob">
      <h1>${first ? `Hi ${esc(first)}.` : 'Welcome.'} What do you do outside class?</h1>
      <p class="lead">Homework has due dates and teachers. These don't, which is why they are the first thing to slip. Pick what is part of your week and Cadence will plan around it and keep count.</p>
      <div class="tiles">${TILES.map((t) => `<button class="tile k-activity" data-act="ob-pick" data-kind="${t.kind}" aria-pressed="${o.picks.includes(t.kind)}">
        <span class="kind-ic">${svg(KIND_ICON[t.kind])}</span><div><b>${t.label}</b><small>${t.sub}</small></div></button>`).join('')}</div>
      <label class="field mt4"><span>Or say it in your own words</span>
        <textarea data-ob-said rows="2" placeholder="Robotics Monday and Wednesday 3:45 to 5:30">${esc(o.said)}</textarea></label>
      ${foot(o.picks.length || o.said.trim() ? 'Add these to my week' : 'Skip for now', false)}
    </div>`;
  }

  const sc = S.school;
  return `<div class="ob">
    <h1>${list.length ? 'Check the details' : 'One last thing'}</h1>
    <p class="lead">${list.length ? 'These are guesses. Tap one to set its days and times.' : 'When is school? Cadence keeps those hours clear and plans work after the last bell.'}</p>
    ${list.length ? `<div class="card flush">
      ${list.map((c) => `<div class="item tap k-activity" data-act="edit-commit" data-id="${c.id}" role="button" tabindex="0">
        <span class="kind-ic">${svg(KIND_ICON[c.kind] || I.star)}</span>
        <div class="grow"><div class="t">${esc(c.title)}</div><div class="m">${esc(scheduleLabel(c, daysLabel))}</div></div>
        ${svg(I.edit, 18)}</div>`).join('')}
      <div class="item tap" data-act="add-commit" role="button" tabindex="0"><span class="kind-ic">${svg(I.plus)}</span>
        <div class="grow"><div class="t">Add another activity</div></div></div>
    </div>` : ''}
    <div class="card flush">
      <div class="item tap" data-act="school-sheet" role="button" tabindex="0">
        <span class="kind-ic k-school">${svg(I.school)}</span>
        <div class="grow"><div class="t">School</div><div class="m">${esc(daysLabel(sc.days))}, ${esc(range(sc.start, sc.end))}</div></div>
        ${svg(I.edit, 18)}</div>
    </div>
    <p class="hint">${insideCanvas
      ? 'Your assignments come in from Canvas on their own.'
      : 'Assignments come in through the Chrome extension on Canvas, or you can add them yourself.'}</p>
    ${foot('Show me my week', true)}
  </div>`;
}

async function finish() {
  app.ob = null;
  app.stack = [];
  app.view = 'today';
  await persist((st) => { st.profile.onboarded = true; st.settings.role = st.settings.role || 'student'; });
  if (insideCanvas) syncCanvas({ quiet: true });
  if (app.sync?.available) loadCrew();
}

async function next() {
  const o = draft();
  if (o.step === 0) {
    const said = o.said.trim();
    await persist((st) => {
      for (const kind of o.picks) {
        if (st.commitments.some((c) => c.kind === kind && !c.archived)) continue;
        const tile = TILES.find((t) => t.kind === kind);
        st.commitments.push(presetCommitment(kind, { title: tile?.title }));
      }
      if (said) applyOps(st, interpret(said, st, new Date()), new Date());
    });
    o.picks = [];
    o.said = '';
    o.step = 1;
    document.getElementById('view').scrollTop = 0;
    return render();
  }
  return finish();
}

export const actions = {
  'ob-pick': (el) => {
    const o = draft();
    const k = el.dataset.kind;
    o.picks = o.picks.includes(k) ? o.picks.filter((x) => x !== k) : [...o.picks, k];
    el.setAttribute('aria-pressed', String(o.picks.includes(k)));
    const btn = document.querySelector('[data-act="ob-next"]');
    if (btn) btn.textContent = o.picks.length || o.said.trim() ? 'Add these to my week' : 'Skip for now';
  },
  'ob-next': () => next(),
  'ob-back': () => { draft().step = 0; render(); }
};

/** The free-text box keeps its value across renders without a round trip. */
export function handleOnboardingInput(ev) {
  if (app.S.profile.onboarded || !app.ob || !ev.target.matches('[data-ob-said]')) return false;
  app.ob.said = ev.target.value;
  const btn = document.querySelector('[data-act="ob-next"]');
  if (btn) btn.textContent = app.ob.picks.length || app.ob.said.trim() ? 'Add these to my week' : 'Skip for now';
  return true;
}
