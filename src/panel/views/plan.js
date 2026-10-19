// School: every assignment, in the order to start them, each one opened up
// into what it is, how long it takes, and the steps to get it done.
//
// This is a list, on purpose. When things happen is the Calendar's job; this
// tab answers "what do I actually have to do, and how big is it".

import {
  app, persist, go, push, render, findSession, runningSession, minutesSince, rankedTasks, plannable, undoTo, insideCanvas
} from '../core.js';
import { learn } from '../../lib/estimator.js';
import { observe } from '../../lib/memory.js';
import { isSchoolDay, dayWindows } from '../../lib/daymodel.js';
import { freeSlots } from '../../lib/calendar.js';
import { allBusy } from '../../lib/replanner.js';
import { isStale } from '../../lib/priority.js';
import { parseAssignmentText } from '../../lib/parse.js';
import { fmtMinutes, fmtTime, fmtDay, dateKey, addDays, atTime, uid, MIN, DAY, clamp, startOfDay } from '../../lib/util.js';
import {
  svg, I, esc, sheet, toast, flash, colorFor, dueLabel, longDay, timeSelect, plural, toLocalInput
} from '../ui.js';
import { ART } from './parts.js';
import { stepSchedule, ensureGuide } from './guide.js';
import { clockOf, dayWord } from '../../lib/agentops.js';
import { atRisk } from '../../lib/scheduler.js';

export function viewPlan() {
  return `
    <section class="hello"><h1>School</h1><p>${schoolSubtitle()}</p></section>
    ${schoolList()}`;
}

// ------------------------------------------------------------------ school

function schoolSubtitle() {
  const open = Object.values(app.S.tasks).filter((t) => plannable(t));
  if (!open.length) return 'No assignments right now.';
  return `${plural(open.length, 'assignment')}, about ${fmtMinutes(open.reduce((a, t) => a + (t.estimateMin || 0), 0))} of work. Open one to see what it is and how to break it down.`;
}

function schoolList() {
  const all = rankedTasks();
  const open = all.filter((t) => t.status !== 'done' && !app.S.dismissed?.[t.id] && !isStale(t));
  const weekOut = +addDays(new Date(), 7);
  // "Start today" and "Catch up" stay in priority order. The dated groups read
  // down the date column, so they go by due date, with "Doing this first" on
  // top and priority breaking ties.
  const byDue = (list) => list.slice().sort((a, b) => (!!b.pinned - !!a.pinned) || (+new Date(a.due) - +new Date(b.due)));
  const groups = [
    ['Start today', open.filter((t) => t.due && t.priority?.band === 'now')],
    ['This week', byDue(open.filter((t) => t.due && (t.priority?.band === 'soon' || (t.priority?.band === 'later' && +new Date(t.due) < weekOut))))],
    ['Catch up', open.filter((t) => t.priority?.band === 'catchup')],
    ['Later on', byDue(open.filter((t) => t.due && t.priority?.band === 'later' && +new Date(t.due) >= weekOut))],
    ['Whenever', open.filter((t) => !t.due)]
  ];
  const done = all.filter((t) => t.status === 'done' && t.completedAt && +new Date(t.completedAt) > Date.now() - 7 * DAY);

  return `
    <label class="quickadd-label" for="quick-add">Add an assignment</label>
    <form class="quickadd" data-form="quick-add">
      <input type="text" id="quick-add" name="text" placeholder="Spanish quiz Thursday, 30 min" autocomplete="off" required data-error="Type the assignment first, for example: Spanish quiz Thursday, 30 min.">
      <button class="btn primary" type="submit">Add assignment</button>
    </form>
    <p class="form-success" id="quick-add-status" role="status"></p>

    ${groups.filter(([, list]) => list.length).map(([label, list]) => `
      <div class="section group"><div class="section-head"><h2>${label}</h2><span class="muted">${list.length}</span></div>
      <div class="card flush">${list.map(taskRow).join('')}</div></div>`).join('')}
    ${done.length ? `<div class="section group"><div class="section-head"><h2>Finished this week</h2><span class="muted">${done.length}</span></div>
      <div class="card flush">${done.map(taskRow).join('')}</div></div>` : ''}
    ${!open.length && !done.length ? `<div class="card"><div class="empty"><h2>No assignments yet</h2><p>${insideCanvas ? 'They come in from Canvas on their own, or add one in the box above.'
      : app.S.sources?.canvasFeed?.enabled ? 'Nothing is due in your Canvas feed right now. Add one in the box above.'
        : 'Connect your Canvas calendar feed and they come in by themselves, or add one in the box above.'} Each gets a time estimate and its own blocks on your calendar.</p>
      ${!insideCanvas && !app.S.sources?.canvasFeed?.enabled ? '<button class="btn primary" data-act="canvas-feed-sheet">Connect Canvas</button>' : ''}</div></div>` : ''}`;
}

function taskRow(t) {
  const isDone = t.status === 'done';
  const open = app.openTask === t.id && !isDone;
  return `<div class="task ${open ? 'open' : ''} ${isDone ? 'done' : ''}">
    <div class="item tap" data-act="toggle-task" data-id="${t.id}" role="button" tabindex="0" aria-expanded="${open}">
      ${dueTab(t)}
      <div class="grow">
        <div class="t">${esc(t.title)}${t.pinned ? ` <span class="first-tag">Doing this first</span>` : ''}</div>
        <div class="m">${esc(t.courseName || 'Personal')} · ${esc(dueLabel(t.due))}${isDone ? '' : ` · about ${fmtMinutes(t.estimateMin || 0)}`}</div>
      </div>
      <span class="chev">${svg(open ? I.down : I.right, 16)}</span>
      <button class="check ${isDone ? 'on' : ''}" data-act="${isDone ? 'reopen' : 'complete'}" data-id="${t.id}" aria-label="${isDone ? 'Mark not done' : 'Mark done'}">${svg(I.check)}</button>
    </div>
    ${open ? breakdown(t) : ''}
  </div>`;
}

/**
 * The due date as a planner tab: the weekday and the date, amber when it is
 * due today or tomorrow, red once it is late. The same date is in the words
 * beside it, so the tab is hidden from screen readers.
 */
function dueTab(t) {
  if (!t.due) return '<span class="due-tab none" aria-hidden="true"></span>';
  const d = new Date(t.due);
  const days = Math.round((+startOfDay(d) - +startOfDay(new Date())) / DAY);
  const state = t.status === 'done' ? '' : +d < Date.now() ? ' late' : days <= 1 ? ' soon' : '';
  return `<span class="due-tab${state}" aria-hidden="true"><small>${esc(d.toLocaleDateString([], { weekday: 'short' }))}</small><b>${d.getDate()}</b></span>`;
}

/** What it is, how long, and the steps, each with the block it lands in. */
function breakdown(t) {
  const { guide: g, steps, upcoming } = stepSchedule(t);
  const first = upcoming[0];
  return `<div class="breakdown">
    <p class="bd-summary">${esc(g.headline)}</p>
    <div class="bd-facts">
      <span><b>${fmtMinutes(t.estimateMin || 0)}</b> in total</span>
      <span><b>${upcoming.length || 'No'}</b> ${upcoming.length === 1 ? 'block' : 'blocks'} planned</span>
      ${first ? `<span>Starts <b>${esc(dayWord(dateKey(new Date(first.start))))} ${esc(clockOf(first.start))}</b></span>` : ''}
    </div>
    <ol class="bd-steps">${steps.map((st) => `<li class="${st.done ? 'done' : ''}">
      <span class="bd-step">${esc(st.title)}${st.detail ? `<small>${esc(st.detail)}</small>` : ''}</span>
      <span class="bd-when">${st.done ? 'Done' : st.when ? `${esc(dayWord(dateKey(new Date(st.when.start))))} ${esc(clockOf(st.when.start))}` : ''}</span>
      <span class="bd-min">${fmtMinutes(st.minutes)}</span></li>`).join('')}</ol>
    <div class="bd-actions">
      <button class="btn small soft" data-act="open-guide" data-id="${t.id}">Open materials and instructions</button>
      <button class="btn small ghost" data-act="edit" data-id="${t.id}">Change the estimate</button>
      <button class="btn small ghost" data-act="pin" data-id="${t.id}">${t.pinned ? 'Stop doing this first' : 'Do this first'}</button>
    </div>
  </div>`;
}

// -------------------------------------------------------------- homework flows

const FEEL = { faster: 0.75, right: 1, longer: 1.35 };
const fmtHM = (d) => { const x = new Date(d); return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`; };
/** What a finished assignment says: its own name, plainly. */
const doneLine = (title) => (title ? `${title} is done.` : 'Done.');

async function startSession(id) {
  await persist((st) => {
    for (const s of st.plan?.sessions || []) if (s.startedAt && !s.done && s.id !== id) s.startedAt = null;
    const s = findSession(st, id);
    if (!s) return;
    const now = new Date();
    // When the evening's homework really began, against the first free time
    // the day had for it: how Cadence learns when this student gets going.
    // Not against the plan, which is rebuilt from "now" whenever the app opens
    // and so would always seem to start when they did.
    if (!s.commitmentId) {
      const day = new Date(now); day.setHours(0, 0, 0, 0);
      const first = freeSlots(day, addDays(day, 1), dayWindows(st), allBusy(st), st.settings)[0];
      observe(st, { type: 'start', school: isSchoolDay(st, now), planned: first ? fmtHM(first.start) : null }, now);
    }
    s.startedAt = now.toISOString();
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
    // Stopped before the block was up: how long a block really lasts.
    if (worked < x.minutes) observe(st, { type: 'focus', planned: x.minutes, actual: worked });
    observe(st, { type: 'done', course: x.courseName || st.tasks[x.taskId]?.courseName });
    Object.assign(x, { done: true, startedAt: null, minutes: Math.round(worked / 5) * 5 || 5, actualMin: worked });
    const t = st.tasks[x.taskId];
    if (t) t.actualMin = (t.actualMin || 0) + worked;
  });
  toast(worked < 5 ? 'Stopped. It stays on your plan.' : `Saved ${fmtMinutes(worked)} of progress. The rest is rescheduled.`);
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
    <h2>How long did that take?</h2>
    <p class="lead">${esc(s.title)} · ${s.minutes} min block</p>
    ${useTimer ? `<div class="card soft small m0">You focused for <b>${fmtMinutes(elapsed)}</b>.</div>`
      : `<div class="q mt0">How long did it actually take?</div>
        <div class="choices grid3">
          <button class="choice" name="feel" value="faster">Quicker<small>~${fmtMinutes(Math.round(s.minutes * FEEL.faster))}</small></button>
          <button class="choice" name="feel" value="right">About right<small>${fmtMinutes(s.minutes)}</small></button>
          <button class="choice" name="feel" value="longer">Longer<small>~${fmtMinutes(Math.round(s.minutes * FEEL.longer))}</small></button>
        </div>`}
    <label class="toggle mt4"><input type="checkbox" name="finished" ${lastPart ? 'checked' : ''}><i></i><span>That finishes the whole assignment</span></label>
    <div class="actions"><button class="btn ghost" value="cancel">Cancel</button>${useTimer ? '<button class="btn primary" name="feel" value="timer">Save the timed length</button>' : ''}</div>`);
  if (!res?.get('feel')) return;

  const feel = res.get('feel');
  const finished = res.get('finished') === 'on';
  const actual = feel === 'timer' ? elapsed : Math.round(s.minutes * (FEEL[feel] || 1));
  const snap = structuredClone(app.S);
  let drift = 0;
  await persist((st) => {
    const x = findSession(st, id);
    if (!x) return;
    // A timed block that ended while the assignment goes on says how long
    // this student focuses. One that finished the assignment says how fast
    // they are, which the estimate learns from instead.
    if (feel === 'timer' && !finished) observe(st, { type: 'focus', planned: x.minutes, actual });
    observe(st, { type: 'done', course: x.courseName || st.tasks[x.taskId]?.courseName });
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
  const msg = !finished ? 'Block done.'
    : drift > 0.2 ? 'Done. Next time Cadence plans more time for this kind of work.'
      : drift < -0.2 ? 'Done, and quicker than planned. Next time Cadence plans less.' : doneLine(app.S.plan?.sessions?.find((y) => y.id === id)?.title);
  toast(msg, undoTo(snap));
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
    if (!s.commitmentId) observe(st, { type: 'push', course: s.courseName || st.tasks[s.taskId]?.courseName });
  });
  const moved = (app.S.plan?.sessions || []).find((x) => (x.taskId === s.taskId || (s.commitmentId && x.commitmentId === s.commitmentId)) && !x.done && x.id !== s.id);
  toast(moved ? `Moved to ${fmtDay(moved.start) === 'Today' ? 'later today' : fmtDay(moved.start)} at ${fmtTime(moved.start)}` : 'Moved to later',
    undoTo(snap));
}

async function completeTask(taskId) {
  const t = app.S.tasks[taskId];
  if (!t) return;
  const est = t.estimateMin || 30;
  const res = await sheet(`
    <h2>Mark as finished</h2><p class="lead">${esc(t.title)}</p>
    <div class="q mt0">How long did it take overall?</div>
    <div class="choices grid3">
      <button class="choice" name="actual" value="${Math.round(est * FEEL.faster)}">Quicker<small>~${fmtMinutes(Math.round(est * FEEL.faster))}</small></button>
      <button class="choice" name="actual" value="${est}">About<small>${fmtMinutes(est)}</small></button>
      <button class="choice" name="actual" value="${Math.round(est * FEEL.longer)}">Longer<small>~${fmtMinutes(Math.round(est * FEEL.longer))}</small></button>
    </div>
    <div class="actions"><button class="btn ghost" name="actual" value="skip">Finish without a time</button></div>`);
  if (!res) return;
  const actual = res.get('actual');
  const snap = structuredClone(app.S);
  if (app.view === 'guide') { app.view = app.stack.pop()?.view || 'plan'; }
  await persist((st) => { finishTask(st, st.tasks[taskId], actual === 'skip' ? 0 : Number(actual)); });
  toast(doneLine(app.S.tasks?.[taskId]?.title), undoTo(snap));
}

async function dismissTask(taskId) {
  const t = app.S.tasks[taskId];
  if (!t) return;
  const snap = structuredClone(app.S);
  if (app.view === 'guide') { app.view = app.stack.pop()?.view || 'plan'; }
  await persist((st) => { if (t.source === 'manual') delete st.tasks[taskId]; else st.dismissed[taskId] = true; });
  toast(t.source === 'manual' ? 'Deleted' : 'Taken off your plan', undoTo(snap));
}

async function editTask(taskId) {
  const t = app.S.tasks[taskId];
  if (!t) return;
  const res = await sheet(`
    <h2>How long will this take?</h2><p class="lead">${esc(t.title)}</p>
    ${t.source === 'manual' ? `<label class="field"><span>Title</span><input type="text" name="title" value="${esc(t.title)}"></label>
      <label class="field"><span>Due</span><input type="datetime-local" name="due" value="${toLocalInput(t.due)}"></label>` : ''}
    <div class="choices grid4">${[15, 30, 45, 60, 90, 120, 180, 240].map((m) =>
      `<button class="choice center" name="est" value="${m}" aria-pressed="${t.userEstimateMin === m}">${fmtMinutes(m)}</button>`).join('')}</div>
    <div class="actions"><button class="btn ghost" name="est" value="auto">Let Cadence estimate</button>
      ${t.source === 'manual' ? '<button class="btn primary" name="est" value="keep">Save changes</button>' : ''}</div>`);
  if (!res) return;
  const est = res.get('est');
  await persist((st) => {
    const x = st.tasks[taskId];
    if (x.source === 'manual') { x.title = String(res.get('title') || x.title); const due = String(res.get('due') || ''); x.due = due ? new Date(due).toISOString() : null; }
    if (est === 'auto') { x.userEstimateMin = null; x.estimateBoost = 0; }
    else if (est !== 'keep') { x.userEstimateMin = Number(est); x.estimateBoost = 0; }
  });
  toast('Updated. Your plan moved with it.');
}

async function blockTime(k) {
  const res = await sheet(`
    <h2>Add to your calendar</h2><p class="lead">${esc(longDay(k))}</p>
    <label class="field"><span>Event</span><input type="text" name="title" placeholder="Dentist" autocomplete="off"></label>
    <div class="field"><span>When?</span><div class="pair">${timeSelect('start', '16:00')}<span class="to">to</span>${timeSelect('end', '18:00')}</div></div>
    <div class="actions"><button class="btn ghost" value="cancel">Cancel</button><button class="btn primary" name="op" value="save">Add to calendar</button></div>`);
  if (!res) return;
  const day = new Date(`${k}T00:00:00`);
  const start = atTime(day, String(res.get('start'))), end = atTime(day, String(res.get('end')));
  if (end <= start) return toast('Pick an end time after the start time.');
  await persist((st) => { st.busy.push({ id: uid('busy'), title: String(res.get('title') || '').trim() || 'Busy', source: 'manual', start: start.toISOString(), end: end.toISOString() }); });
  toast('Added. Your plan moved around it.');
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
  // Said under the box it was typed in, and the cursor goes back there, so a
  // list of five things is five lines and five Enters.
  flash('quick-add-status', first
    ? `Added ${t.title}. About ${fmtMinutes(t.estimateMin)}, starting ${dayWord(dateKey(new Date(first.start)))} at ${clockOf(first.start)}.`
    : `Added ${t.title}.`);
  if (app.view === 'plan') document.getElementById('quick-add')?.focus();
}

export const actions = {
  'toggle-task': (el) => {
    const id = el.dataset.id;
    app.openTask = app.openTask === id ? null : id;
    if (app.openTask) ensureGuide(id);
    render();
  },
  'pick-day': (el) => { app.planDay = el.dataset.day; render(); },
  'week-shift': (el) => { app.weekOffset = clamp(app.weekOffset + Number(el.dataset.dir), 0, 3); app.planDay = null; render(); },
  'open-day': (el) => { app.calMode = 'day'; app.planDay = el.dataset.day; app.weekOffset = 0; go('calendar'); },
  'start-session': (el) => startSession(el.dataset.id),
  'stop-session': (el) => stopSession(el.dataset.id),
  'finish-session': (el) => finishSession(el.dataset.id),
  'undo-session': (el) => undoSession(el.dataset.id),
  'skip-session': (el) => skipSession(el.dataset.id),
  complete: (el) => completeTask(el.dataset.id),
  reopen: (el) => persist((st) => { const t = st.tasks[el.dataset.id]; if (t) { t.status = 'todo'; t.completedAt = null; } }),
  pin: (el) => persist((st) => { const t = st.tasks[el.dataset.id]; if (t) t.pinned = !t.pinned; }),
  edit: (el) => editTask(el.dataset.id),
  dismiss: (el) => dismissTask(el.dataset.id),
  'block-time': (el) => blockTime(el.dataset.day || dateKey(new Date()))
};

export const submitActions = {
  'quick-add': (form, fd) => quickAdd(form, String(fd.get('text') || '').trim())
};

/** Right pane on wide screens: what needs attention, and the week's shape. */
export function side(mode = 'school') {
  if (mode === 'school') {
    const open = Object.values(app.S.tasks).filter((t) => plannable(t));
    const soon = rankedTasks().filter((t) => plannable(t)).slice(0, 5);
    return `<div class="section-head"><h2>Start these first</h2></div>
      <div class="card flush">${soon.map((t) => `<div class="item tap k-work" data-act="toggle-task" data-id="${t.id}" role="button" tabindex="0">
        <div class="bar"></div><div class="grow"><div class="t">${esc(t.title)}</div>
        <div class="m">${esc(dueLabel(t.due))} · about ${fmtMinutes(t.estimateMin || 0)}</div></div></div>`).join('')
        || '<div class="item"><div class="grow small muted">Nothing open.</div></div>'}</div>
      <p class="hint">${open.length} open, ${fmtMinutes(open.reduce((a, t) => a + (t.estimateMin || 0), 0))} of work in all.</p>`;
  }
  return weekShape();
}

/** How heavy each day is, and whether everything fits. Used beside the Calendar. */
export function weekShape() {
  const today = dateKey(new Date());
  const days = (app.S.plan?.days || []).filter((d) => d.date >= today).slice(0, 7);
  const unplaced = atRisk(app.S.plan);
  const most = Math.max(60, ...days.map((d) => Math.max(d.minutes, d.cap || 0)));
  const busiest = days.slice().sort((a, b) => b.minutes - a.minutes)[0];
  const assigned = unplaced.filter((u) => !u.commitmentId);

  return `
    ${unplaced.length ? `<div class="card warm">
      <div class="card-title">${assigned.length ? (assigned.every((u) => u.late) ? 'Planned, but after it is due' : 'No free time left') : 'No free time left for practice'}</div>
      <div class="card-sub">${unplaced.slice(0, 3).map((u) => `${esc(u.title)}${u.due && !u.commitmentId ? `, due ${esc(dayWord(dateKey(new Date(u.due))))}` : ''}`).join('. ')}${unplaced.length > 3 ? `, and ${unplaced.length - 3} more` : ''}.</div>
      <button class="btn small primary mt3" data-act="agent-open" data-seed="${assigned.length ? 'I can do more on ' : ''}">${assigned.length ? 'Tell Cadence when you have more time' : 'Ask Cadence to move things'}</button>
    </div>` : `<div class="card good"><div class="card-title">Everything fits</div>
      <div class="card-sub">Every assignment lands before it is due${(app.S.plan?.stretchDays || []).some((d) => d >= today) ? ', with some days heavier than usual (marked below)' : ''}.</div></div>`}

    <div class="section-head"><h2>The next seven days</h2></div>
    <div class="card flush">
      ${days.map((d) => {
        const over = d.cap != null && d.minutes > d.cap;
        return `<div class="item load-row ${over ? 'over' : ''}">
          <div class="grow"><div class="t">${esc(fmtDay(`${d.date}T12:00:00`))}</div>
            <div class="load-bar"><i style="width:${Math.round((d.minutes / most) * 100)}%"></i></div></div>
          <span class="side">${d.minutes ? fmtMinutes(d.minutes) : 'Free'}</span></div>`;
      }).join('')}
    </div>
    ${busiest?.minutes ? `<p class="hint">Cadence spreads the work so no day carries more than it has to. ${esc(fmtDay(`${busiest.date}T12:00:00`))} is the fullest at ${fmtMinutes(busiest.minutes)}.</p>` : ''}`;
}
