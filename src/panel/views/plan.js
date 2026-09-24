// Plan: the week at a glance (homework and commitments on one path) and
// School (every assignment, grouped by when to start it).

import {
  app, persist, restore, go, push, findSession, runningSession, minutesSince, rankedTasks, plannable, dayAgenda
} from '../core.js';
import { learn, CATEGORIES } from '../../lib/estimator.js';
import { isStale } from '../../lib/priority.js';
import { parseAssignmentText } from '../../lib/parse.js';
import { fmtMinutes, fmtTime, fmtDay, dateKey, addDays, startOfDay, atTime, uid, MIN, DAY, clamp } from '../../lib/util.js';
import {
  svg, I, esc, sheet, toast, colorFor, dueLabel, longDay, timeSelect, toMin, shift, listJoin, plural, DOW_SHORT, toLocalInput
} from '../ui.js';
import { timeline, ART } from './parts.js';
import { weekGrid } from './week.js';
import { isDesktop } from '../ui.js';
import { applyRoutine } from './you.js';

export function viewPlan() {
  // The merged week grid moved to its own Calendar tab; School stays the
  // assignment list, with the week one tap away.
  const mode = app.planMode === 'week' ? 'week' : 'school';
  return `
    <section class="hello" style="padding-bottom:12px"><h1>${mode === 'school' ? 'School' : 'Your week'}</h1><p>${mode === 'school' ? schoolSubtitle() : weekSubtitle()}</p></section>
    <div class="seg" role="tablist">
      <button data-act="plan-mode" data-mode="school" aria-pressed="${mode === 'school'}">Assignments</button>
      <button data-act="go" data-tab="calendar" aria-pressed="false">Calendar</button>
    </div>
    ${mode === 'school' ? schoolList() : weekView()}`;
}

// -------------------------------------------------------------------- week

function weekSubtitle() {
  const start = dateKey(startOfDay(new Date())), end = dateKey(addDays(new Date(), 7));
  const blocks = (app.S.plan?.sessions || []).filter((s) => { const k = dateKey(new Date(s.start)); return k >= start && k < end && !s.done; });
  const hw = blocks.filter((s) => !s.commitmentId).reduce((a, s) => a + s.minutes, 0);
  const practice = blocks.filter((s) => s.commitmentId).reduce((a, s) => a + s.minutes, 0);
  if (!hw && !practice) return 'Nothing planned yet this week.';
  return [hw && `${fmtMinutes(hw)} of homework`, practice && `${fmtMinutes(practice)} of practice`].filter(Boolean).join(' and ') + ', planned around everything else.';
}

function weekView() {
  const start = addDays(startOfDay(new Date()), app.weekOffset * 7);
  const days = [...Array(7)].map((_, i) => addDays(start, i));
  const keys = days.map(dateKey);
  if (!keys.includes(app.planDay)) app.planDay = keys[0];
  const today = dateKey(new Date());

  if (isDesktop()) {
    return `
      <div class="row between" style="margin:-4px 0 12px">
        <span class="small muted" style="font-weight:700">${app.weekOffset ? 'Next week' : 'This week'} · ${esc(longDay(keys[0]))} – ${esc(longDay(keys[6]))}</span>
        <span class="row" style="gap:6px">
          <button class="btn small soft" data-act="block-time" data-day="${app.planDay}">${svg(I.plus, 14)} Block off time</button>
          <button class="icon-btn" data-act="week-shift" data-dir="-1" ${app.weekOffset ? '' : 'disabled style="opacity:.3"'} aria-label="Previous week">${svg(I.left, 18)}</button>
          <button class="icon-btn" data-act="week-shift" data-dir="1" ${app.weekOffset ? 'disabled style="opacity:.3"' : ''} aria-label="Next week">${svg(I.right, 18)}</button>
        </span>
      </div>
      ${weekGrid()}`;
  }

  return `
    <div class="row between" style="margin:-4px 0 8px">
      <span class="small muted" style="font-weight:700">${app.weekOffset ? 'Next week' : 'This week'}</span>
      <span class="row" style="gap:0">
        <button class="icon-btn" data-act="week-shift" data-dir="-1" ${app.weekOffset ? '' : 'disabled style="opacity:.3"'} aria-label="Previous week">${svg(I.left, 18)}</button>
        <button class="icon-btn" data-act="week-shift" data-dir="1" ${app.weekOffset ? 'disabled style="opacity:.3"' : ''} aria-label="Next week">${svg(I.right, 18)}</button>
      </span>
    </div>
    <div class="strip">${days.map((d, i) => {
      const k = keys[i];
      const colors = [...new Set(dayAgenda(k).filter((it) => it.type !== 'busy')
        .map((it) => it.commitment?.color || colorFor(it.session || {})))].slice(0, 4);
      return `<button class="daychip ${k === today ? 'today' : ''}" data-act="pick-day" data-day="${k}" aria-current="${k === app.planDay}" aria-label="${esc(longDay(k))}">
        <span class="dow">${k === today ? 'Today' : DOW_SHORT[d.getDay()]}</span><span class="num">${d.getDate()}</span>
        <span class="dots">${colors.map((c) => `<i style="--c:${c}"></i>`).join('')}</span></button>`;
    }).join('')}</div>

    <div class="section-head" style="margin-top:6px"><h2>${esc(longDay(app.planDay))}</h2></div>
    ${timeline(app.planDay, { emptyText: 'A free day — nothing on the calendar.' })}
    <div class="row" style="margin-top:12px;gap:8px">
      <button class="btn small soft" data-act="block-time" data-day="${app.planDay}">${svg(I.plus, 14)} Block off time</button>
      <button class="btn small ghost" data-act="open-availability">When I'm free</button>
    </div>`;
}

// ------------------------------------------------------------------ school

function schoolSubtitle() {
  const open = Object.values(app.S.tasks).filter((t) => plannable(t));
  if (!open.length) return 'No assignments right now.';
  return `${plural(open.length, 'assignment')} · about ${fmtMinutes(open.reduce((a, t) => a + (t.estimateMin || 0), 0))} of work, already planned`;
}

function schoolList() {
  const all = rankedTasks();
  const open = all.filter((t) => t.status !== 'done' && !app.S.dismissed?.[t.id] && !isStale(t));
  const weekOut = +addDays(new Date(), 7);
  const groups = [
    ['Start today', open.filter((t) => t.due && t.priority?.band === 'now')],
    ['This week', open.filter((t) => t.due && (t.priority?.band === 'soon' || (t.priority?.band === 'later' && +new Date(t.due) < weekOut)))],
    ['Catch up', open.filter((t) => t.priority?.band === 'catchup')],
    ['Later on', open.filter((t) => t.due && t.priority?.band === 'later' && +new Date(t.due) >= weekOut)],
    ['Whenever', open.filter((t) => !t.due)]
  ];
  const done = all.filter((t) => t.status === 'done' && t.completedAt && +new Date(t.completedAt) > Date.now() - 7 * DAY);

  return `
    <form class="quickadd" data-form="quick-add">
      <input type="text" name="text" placeholder="Add homework… “Spanish quiz Thursday, 30 min”" autocomplete="off" aria-label="Add homework">
      <button class="btn small primary" type="submit">Add</button>
    </form>
    <p class="hint" style="margin:6px 6px 0">Tap any assignment for a guide: what to do, the steps, and where the materials are.</p>

    ${groups.filter(([, list]) => list.length).map(([label, list]) => `
      <div class="section"><div class="section-head"><h2>${label}</h2><span class="muted">${list.length}</span></div>
      <div class="card flush">${list.map(taskRow).join('')}</div></div>`).join('')}
    ${done.length ? `<div class="section"><div class="section-head"><h2>Finished this week</h2><span class="muted">${done.length}</span></div>
      <div class="card flush">${done.map(taskRow).join('')}</div></div>` : ''}
    ${!open.length && !done.length ? `<div class="empty"><div class="art">${ART}</div><h2>All clear</h2><p>Nothing due. That's a good feeling.</p></div>` : ''}`;
}

function taskRow(t) {
  const isDone = t.status === 'done';
  return `<div class="item tap ${isDone ? 'done' : ''}" data-act="open-guide" data-id="${t.id}" style="--c:${colorFor(t)}" role="button" tabindex="0">
    <div class="bar"></div>
    <div class="grow">
      <div class="t">${t.pinned ? `<span style="color:var(--accent)">${svg(I.pin, 12)}</span> ` : ''}${esc(t.title)}</div>
      <div class="m">${esc(t.courseName || 'Personal')} · ${esc(dueLabel(t.due))}${isDone ? '' : ` · ~${fmtMinutes(t.estimateMin || 0)}`}</div>
    </div>
    <button class="check ${isDone ? 'on' : ''}" data-act="${isDone ? 'reopen' : 'complete'}" data-id="${t.id}" aria-label="${isDone ? 'Mark not done' : 'Mark done'}">${svg(I.check)}</button>
  </div>`;
}

// -------------------------------------------------------------- homework flows

const FEEL = { faster: 0.75, right: 1, longer: 1.35 };
const CHEERS = ['Done and dusted.', 'One less thing on your plate.', "That's off your list.", 'Nicely done.'];

async function startSession(id) {
  await persist((st) => {
    for (const s of st.plan?.sessions || []) if (s.startedAt && !s.done && s.id !== id) s.startedAt = null;
    const s = findSession(st, id);
    if (!s) return;
    s.startedAt = new Date().toISOString();
    const t = st.tasks[s.taskId];
    if (t && t.status === 'todo') t.status = 'in_progress';
  }, { recalc: false });
  go('today');
}

async function stopSession(id) {
  const s = findSession(app.S, id);
  if (!s?.startedAt) return;
  const worked = minutesSince(s.startedAt);
  if (s.commitmentId && worked >= 5) {
    const { checkinFlow } = await import('./commitments.js');
    return checkinFlow(s.commitmentId, { sessionId: s.id });
  }
  await persist((st) => {
    const x = findSession(st, id);
    if (worked < 5) { x.startedAt = null; return; }
    Object.assign(x, { done: true, startedAt: null, minutes: Math.round(worked / 5) * 5 || 5, actualMin: worked });
    const t = st.tasks[x.taskId];
    if (t) t.actualMin = (t.actualMin || 0) + worked;
  });
  toast(worked < 5 ? 'Stopped — it stays on your plan' : `Saved ${fmtMinutes(worked)} of progress. The rest is rescheduled.`);
}

function finishTask(st, t, actualMin) {
  t.status = 'done';
  t.completedAt = new Date().toISOString();
  const est = t.baseEstimateMin || t.estimateMin;
  if (actualMin && est) {
    st.logs.push({ taskId: t.id, category: t.category, courseId: t.courseId, estimateMin: est, actualMin, at: t.completedAt });
    st.model = learn(st.model, { courseId: t.courseId, category: t.category, estimateMin: est, actualMin });
    return actualMin / est - 1;
  }
  return 0;
}

async function finishSession(id) {
  const s = findSession(app.S, id);
  if (!s) return;
  if (s.commitmentId) {
    const { checkinFlow } = await import('./commitments.js');
    return checkinFlow(s.commitmentId, { sessionId: s.id });
  }
  const running = !!s.startedAt;
  const elapsed = running ? minutesSince(s.startedAt) : 0;
  const useTimer = running && elapsed >= 3;
  const lastPart = (s.part || 1) >= (s.parts || 1);

  const res = await sheet(`
    <h2>Nice work</h2>
    <p class="lead">${esc(s.title)} · ${s.minutes} min block</p>
    ${useTimer ? `<div class="card soft small" style="margin:0">You focused for <b>${fmtMinutes(elapsed)}</b>.</div>`
      : `<div class="q" style="margin-top:0">How long did it actually take?</div>
        <div class="choices grid3">
          <button class="choice" name="feel" value="faster">Quicker<small>~${fmtMinutes(Math.round(s.minutes * FEEL.faster))}</small></button>
          <button class="choice" name="feel" value="right">About right<small>${fmtMinutes(s.minutes)}</small></button>
          <button class="choice" name="feel" value="longer">Longer<small>~${fmtMinutes(Math.round(s.minutes * FEEL.longer))}</small></button>
        </div>`}
    <label class="toggle" style="margin-top:14px"><input type="checkbox" name="finished" ${lastPart ? 'checked' : ''}><i></i><span>That finishes the whole assignment</span></label>
    <div class="actions"><button class="btn ghost" value="cancel">Not yet</button>${useTimer ? '<button class="btn primary" name="feel" value="timer">Save</button>' : ''}</div>`);
  if (!res?.get('feel')) return;

  const feel = res.get('feel');
  const finished = res.get('finished') === 'on';
  const actual = feel === 'timer' ? elapsed : Math.round(s.minutes * (FEEL[feel] || 1));
  const snap = structuredClone(app.S);
  let drift = 0;
  await persist((st) => {
    const x = findSession(st, id);
    if (!x) return;
    Object.assign(x, { done: true, startedAt: null, actualMin: actual, doneAt: new Date().toISOString() });
    if (+new Date(x.start) > Date.now()) {
      x.end = new Date().toISOString();
      x.start = new Date(Date.now() - Math.min(actual, x.minutes) * MIN).toISOString();
    }
    const t = st.tasks[x.taskId];
    if (!t) return;
    t.actualMin = (t.actualMin || 0) + actual;
    if (finished) drift = finishTask(st, t, t.actualMin);
    else {
      const progress = st.plan.sessions.filter((y) => y.taskId === t.id && y.done).reduce((a, y) => a + y.minutes, 0);
      if (progress >= t.estimateMin) t.estimateBoost = (t.estimateBoost || 0) + Math.max(30, x.minutes);
    }
  });
  const msg = !finished ? 'Block done — nice momentum.'
    : drift > 0.2 ? 'Done! Next time Cadence will plan more time for these.'
      : drift < -0.2 ? 'Done — quicker than planned. Cadence will remember.' : CHEERS[Math.floor(Math.random() * CHEERS.length)];
  toast(msg, { label: 'Undo', run: () => restore(snap) });
}

async function undoSession(id) {
  const s = findSession(app.S, id);
  if (s?.commitmentId) {
    const k = app.S.checkins.find((x) => x.commitmentId === s.commitmentId && x.at === s.doneAt);
    if (k) { const { undoCheckin } = await import('../core.js'); return undoCheckin(k.id); }
  }
  await persist((st) => {
    const x = findSession(st, id);
    if (!x) return;
    const t = st.tasks[x.taskId];
    if (t) { t.actualMin = Math.max(0, (t.actualMin || 0) - (x.actualMin || 0)); if (t.status === 'done') { t.status = 'todo'; t.completedAt = null; } }
    Object.assign(x, { done: false, actualMin: null });
  });
}

async function skipSession(id) {
  const s = findSession(app.S, id);
  if (!s) return;
  const snap = structuredClone(app.S);
  await persist((st) => {
    const start = new Date(Math.max(Date.now(), +new Date(s.start)));
    const end = new Date(Math.max(+new Date(s.end), +start + s.minutes * MIN));
    st.busy.push({ id: uid('skip'), title: 'Skipped', source: 'skip', start: start.toISOString(), end: end.toISOString() });
  });
  const moved = (app.S.plan?.sessions || []).find((x) => (x.taskId === s.taskId || (s.commitmentId && x.commitmentId === s.commitmentId)) && !x.done && x.id !== s.id);
  toast(moved ? `Moved to ${fmtDay(moved.start) === 'Today' ? 'later today' : fmtDay(moved.start)} at ${fmtTime(moved.start)}` : 'Moved to later',
    { label: 'Undo', run: () => restore(snap) });
}

async function makeRoom() {
  const before = (app.S.plan?.unplaced || []).length;
  const changes = [];
  const fits = () => !(app.S.plan?.unplaced || []).length;
  const weekendMin = [0, 6].reduce((a, d) => a + (app.S.availability[d] || []).reduce((b, w) => b + toMin(w.end) - toMin(w.start), 0), 0);
  if (weekendMin < 14 * 60) {
    await persist((st) => applyRoutine(st, { schoolEnd: st.profile.schoolEnd, routine: st.profile.routine, weekend: 'productive' }));
    changes.push('weekend time');
  }
  if (!fits()) {
    await persist((st) => {
      for (const d of [1, 2, 3, 4, 5]) {
        const wins = st.availability[d] || [];
        if (!wins.length) st.availability[d] = [{ start: shift(st.profile.schoolEnd || '15:30', 15), end: '22:00' }];
        else { const last = wins.at(-1); if (toMin(last.end) < toMin('22:00')) last.end = '22:00'; }
      }
      st.profile.routine = 'custom';
    });
    changes.push('a little more evening time');
  }
  const after = (app.S.plan?.unplaced || []).length;
  if (!after) toast(`Added ${listJoin(changes)} — everything fits now.`);
  else if (after < before) toast(`Found room for ${before - after}. For the rest, asking for a little more time is completely okay.`);
  else toast("It's a genuinely packed week. Asking early for a little more time is completely okay.");
}

async function completeTask(taskId) {
  const t = app.S.tasks[taskId];
  if (!t) return;
  const est = t.estimateMin || 30;
  const res = await sheet(`
    <h2>Finished!</h2><p class="lead">${esc(t.title)}</p>
    <div class="q" style="margin-top:0">How long did it take overall?</div>
    <div class="choices grid3">
      <button class="choice" name="actual" value="${Math.round(est * FEEL.faster)}">Quicker<small>~${fmtMinutes(Math.round(est * FEEL.faster))}</small></button>
      <button class="choice" name="actual" value="${est}">About<small>${fmtMinutes(est)}</small></button>
      <button class="choice" name="actual" value="${Math.round(est * FEEL.longer)}">Longer<small>~${fmtMinutes(Math.round(est * FEEL.longer))}</small></button>
    </div>
    <div class="actions"><button class="btn ghost" name="actual" value="skip">Skip this</button></div>`);
  if (!res) return;
  const actual = res.get('actual');
  const snap = structuredClone(app.S);
  if (app.view === 'guide') { app.view = app.stack.pop()?.view || 'plan'; }
  await persist((st) => { finishTask(st, st.tasks[taskId], actual === 'skip' ? 0 : Number(actual)); });
  toast(CHEERS[Math.floor(Math.random() * CHEERS.length)], { label: 'Undo', run: () => restore(snap) });
}

async function dismissTask(taskId) {
  const t = app.S.tasks[taskId];
  if (!t) return;
  const snap = structuredClone(app.S);
  if (app.view === 'guide') { app.view = app.stack.pop()?.view || 'plan'; }
  await persist((st) => { if (t.source === 'manual') delete st.tasks[taskId]; else st.dismissed[taskId] = true; });
  toast(t.source === 'manual' ? 'Deleted' : 'Taken off your plan', { label: 'Undo', run: () => restore(snap) });
}

async function editTask(taskId) {
  const t = app.S.tasks[taskId];
  if (!t) return;
  const res = await sheet(`
    <h2>How long will this take?</h2><p class="lead">${esc(t.title)}</p>
    ${t.source === 'manual' ? `<label class="field"><span>Title</span><input type="text" name="title" value="${esc(t.title)}"></label>
      <label class="field"><span>Due</span><input type="datetime-local" name="due" value="${toLocalInput(t.due)}"></label>` : ''}
    <div class="choices" style="display:grid;grid-template-columns:repeat(4,1fr)">${[15, 30, 45, 60, 90, 120, 180, 240].map((m) =>
      `<button class="choice" style="text-align:center" name="est" value="${m}" aria-pressed="${t.userEstimateMin === m}">${fmtMinutes(m)}</button>`).join('')}</div>
    <div class="actions"><button class="btn ghost" name="est" value="auto">Let Cadence estimate</button>
      ${t.source === 'manual' ? '<button class="btn primary" name="est" value="keep">Save</button>' : ''}</div>`);
  if (!res) return;
  const est = res.get('est');
  await persist((st) => {
    const x = st.tasks[taskId];
    if (x.source === 'manual') { x.title = String(res.get('title') || x.title); const due = String(res.get('due') || ''); x.due = due ? new Date(due).toISOString() : null; }
    if (est === 'auto') { x.userEstimateMin = null; x.estimateBoost = 0; }
    else if (est !== 'keep') { x.userEstimateMin = Number(est); x.estimateBoost = 0; }
  });
  toast('Updated — your plan adjusted');
}

async function blockTime(k) {
  const res = await sheet(`
    <h2>Block off time</h2><p class="lead">${esc(longDay(k))}</p>
    <label class="field"><span>What's happening?</span><input type="text" name="title" placeholder="Dentist, game, family trip…" autocomplete="off"></label>
    <div class="field"><span>When?</span><div class="pair">${timeSelect('start', '16:00')}<span class="to">to</span>${timeSelect('end', '18:00')}</div></div>
    <div class="actions"><button class="btn ghost" value="cancel">Cancel</button><button class="btn primary" name="op" value="save">Block it off</button></div>`);
  if (!res) return;
  const day = new Date(`${k}T00:00:00`);
  const start = atTime(day, String(res.get('start'))), end = atTime(day, String(res.get('end')));
  if (end <= start) return toast('The end time needs to be after the start');
  await persist((st) => { st.busy.push({ id: uid('busy'), title: String(res.get('title') || '').trim() || 'Busy', source: 'manual', start: start.toISOString(), end: end.toISOString() }); });
  toast('Blocked off — your plan moved around it');
}

async function quickAdd(form, text) {
  if (!text) return;
  const p = parseAssignmentText(text, { courses: app.courses });
  const id = uid('manual');
  await persist((st) => {
    st.tasks[id] = { id, source: 'manual', title: p.title, description: '', courseId: p.courseId, courseName: p.courseName, due: p.due, points: p.points, category: p.category, status: 'todo', ...(p.estimateMin ? { userEstimateMin: p.estimateMin } : {}) };
  });
  form.reset();
  const first = (app.S.plan?.sessions || []).find((s) => s.taskId === id && !s.done);
  const t = app.S.tasks[id];
  toast(first ? `Added — about ${fmtMinutes(t.estimateMin)}, starting ${fmtDay(first.start)} at ${fmtTime(first.start)}` : `Added “${t.title}”`);
}

export const actions = {
  'plan-mode': (el) => { app.planMode = el.dataset.mode; go('plan'); },
  'pick-day': (el) => { app.planDay = el.dataset.day; go('plan'); },
  'week-shift': (el) => { app.weekOffset = clamp(app.weekOffset + Number(el.dataset.dir), 0, 1); app.planDay = null; go('plan'); },
  'open-day': (el) => { app.planMode = 'week'; app.planDay = el.dataset.day; app.weekOffset = 0; go('plan'); },
  'start-session': (el) => startSession(el.dataset.id),
  'stop-session': (el) => stopSession(el.dataset.id),
  'finish-session': (el) => finishSession(el.dataset.id),
  'undo-session': (el) => undoSession(el.dataset.id),
  'skip-session': (el) => skipSession(el.dataset.id),
  'make-room': () => makeRoom(),
  complete: (el) => completeTask(el.dataset.id),
  reopen: (el) => persist((st) => { const t = st.tasks[el.dataset.id]; if (t) { t.status = 'todo'; t.completedAt = null; } }),
  pin: (el) => persist((st) => { const t = st.tasks[el.dataset.id]; if (t) t.pinned = !t.pinned; }),
  edit: (el) => editTask(el.dataset.id),
  dismiss: (el) => dismissTask(el.dataset.id),
  'block-time': (el) => blockTime(el.dataset.day)
};

export const submitActions = {
  'quick-add': (form, fd) => quickAdd(form, String(fd.get('text') || '').trim())
};

/** Right pane on wide screens: what needs attention, and the week's shape. */
export function side() {
  if (app.planMode === 'school') {
    const open = Object.values(app.S.tasks).filter((t) => plannable(t));
    const soon = rankedTasks().filter((t) => plannable(t)).slice(0, 5);
    return `<div class="section-head"><h2>Start these first</h2></div>
      <div class="card flush">${soon.map((t) => `<div class="item tap" data-act="open-guide" data-id="${t.id}" style="--c:${colorFor(t)}" role="button" tabindex="0">
        <div class="bar"></div><div class="grow"><div class="t">${esc(t.title)}</div>
        <div class="m">${esc(dueLabel(t.due))} · ~${fmtMinutes(t.estimateMin || 0)}</div></div></div>`).join('')
        || '<div class="item"><div class="grow small muted">Nothing open.</div></div>'}</div>
      <p class="hint">${open.length} open · ${fmtMinutes(open.reduce((a, t) => a + (t.estimateMin || 0), 0))} of work</p>`;
  }

  const days = (app.S.plan?.days || []).filter((d) => d.date >= dateKey(new Date())).slice(0, 7);
  const busiest = days.slice().sort((a, b) => b.minutes - a.minutes)[0];
  const cap = app.S.settings.dailyCapacityMin || 150;
  const stretch = new Set(app.S.plan?.stretchDays || []);
  const unplaced = app.S.plan?.unplaced || [];

  return `
    ${unplaced.length ? `<div class="card warm">
      <div class="card-title">Needs a little more room</div>
      <div class="card-sub">${unplaced.slice(0, 3).map((u) => esc(u.title)).join(', ')}${unplaced.length > 3 ? ` +${unplaced.length - 3}` : ''}</div>
      <button class="btn small primary" style="margin-top:10px" data-act="make-room">Find time for me</button>
    </div>` : `<div class="card good"><div class="card-title">Everything fits</div>
      <div class="card-sub">Nothing is squeezed out this week.</div></div>`}

    <div class="section-head"><h2>Daily load</h2></div>
    <div class="card flush">
      ${days.map((d) => `<div class="item" style="--c:${stretch.has(d.date) ? 'var(--amber)' : 'var(--accent)'}">
        <div class="grow"><div class="t" style="font-weight:650">${esc(fmtDay(`${d.date}T12:00:00`))}</div>
          <div class="capacity" style="margin:6px 0 0;height:5px;border-radius:3px;background:var(--surface-2);overflow:hidden">
            <i style="display:block;height:100%;width:${Math.min(100, Math.round((d.minutes / cap) * 100))}%;background:var(--c)"></i></div></div>
        <span class="side">${fmtMinutes(d.minutes)}</span></div>`).join('')}
    </div>
    ${busiest?.minutes ? `<p class="hint">Busiest: ${esc(fmtDay(`${busiest.date}T12:00:00`))} at ${fmtMinutes(busiest.minutes)}. Anything over your ${fmtMinutes(cap)} limit is Cadence making room for a deadline.</p>` : ''}`;
}
