// The homepage's worked example: one Monday for one made-up student, planned
// by Cadence's real planner in the visitor's own browser.
//
// Nothing here is a recording. The week below goes through the same steps as
// a student's own plan (lib/replanner.js recomputeState), and the two changes
// a visitor can make are made the way the app's own buttons make them (see
// CHANGES). What is shown afterwards is read off the result: the blocks, the
// free hours (lib/daymodel.js workWindows) and, after a change, which blocks
// moved, found by comparing the plan before and after.
//
// The planner reads the clock, and the story only makes sense at one moment:
// a Monday at 3:15pm, school just out. So every call into it runs with the
// clock set to that moment and put back straight afterwards (atMoment). The
// calls are synchronous, so nothing else on the page ever sees the borrowed
// time. Nothing is saved anywhere: the week lives in this page and is gone
// when it closes, and it never touches a real plan or the demo's.

import { DEFAULT_STATE } from '../lib/store.js';
import { recomputeState, allBusy } from '../lib/replanner.js';
import { workWindows, DAY } from '../lib/daymodel.js';
import { newCommitment, isFixed } from '../lib/habits.js';
import { check, ymd } from '../lib/mailEvents.js';
import { fmtTime, fmtMinutes, fmtClock, startOfDay, dateKey, escapeHtml as esc } from '../lib/util.js';

// The Monday of the story. A fixed date, so every visitor sees the same plan,
// in a week when no country changes its clocks. Only weekday names are shown.
const MONDAY = [2026, 1, 9];                   // February 9, 2026 (months count from 0)
const at = (dayOffset, hh, mm = 0) => new Date(MONDAY[0], MONDAY[1], MONDAY[2] + dayOffset, hh, mm);
export const NOW = at(0, 15, 15);

/** Runs `fn` with the clock reading `when`, then puts the real clock back. */
export function atMoment(when, fn) {
  const Real = Date;
  const fixed = +when;
  class Pinned extends Real {
    constructor(...args) { if (args.length) super(...args); else super(fixed); }
    static now() { return fixed; }
  }
  globalThis.Date = Pinned;
  try { return fn(); } finally { globalThis.Date = Real; }
}

/** Sam's week as it stands on Monday afternoon, before anything is planned. */
export function startingWeek() {
  return atMoment(NOW, () => {
    const st = structuredClone(DEFAULT_STATE);
    st.profile = { ...st.profile, name: 'Sam', onboarded: true };
    st.account = { ...st.account, mode: 'local', name: 'Sam' };
    st.school = { ...st.school, days: [1, 2, 3, 4, 5], start: '08:00', end: '15:00' };
    st.sleep = { bed: '22:30', wake: '07:00' };
    // Two activities, made the way the Activities tab makes them: practice at
    // set times, and a weekly goal with no set time that Cadence finds time for.
    st.commitments = [newCommitment({
      id: 'practice', kind: 'sport', title: 'Basketball practice',
      schedule: { mode: 'fixed', days: [1, 3], start: '15:30', end: '17:30' }
    }), newCommitment({
      id: 'essay', kind: 'custom', title: 'College essay',
      target: { sessions: 2, minutes: 45 }
    })];
    // One event that came in by email, kept the way the Chrome extension keeps it.
    st.sources.mail.enabled = true;
    st.sources.mail.events = [roboticsEmail()];
    const task = (id, title, courseName, due, minutes, category) => ({
      id, source: 'manual', title, courseName, due: due.toISOString(), userEstimateMin: minutes, category, status: 'todo', description: ''
    });
    st.tasks = {
      calc: task('calc', 'Calculus problem set 4.2', 'AP Calculus', at(1, 8), 60, 'problemset'),
      spanish: task('spanish', 'Study for the Spanish quiz', 'Spanish 3', at(3, 9), 45, 'quiz'),
      // What School's "Add an assignment" box makes of the sentence "Robotics
      // build log due Friday, about an hour" (lib/parse.js): due at 11:59pm.
      log: task('log', 'Robotics build log', '', at(4, 23, 59), 60, 'project')
    };
    return recomputeState(st);
  });
}

/**
 * The robotics meeting, from an email the team captain sent on Sunday: what
 * Chrome's built-in model reports for that email, put through the same check
 * the extension runs on everything it finds in email (lib/mailEvents.js), so
 * it is kept in exactly the shape the app keeps it.
 */
function roboticsEmail() {
  const quote = 'We are meeting Thursday from 3:30 to 5 in room 114 to finish the drivetrain.';
  const message = { id: 'robotics', subject: 'Robotics this week', fromName: 'Robotics captain', fromKey: 'robotics-captain', receivedMs: +at(-1, 19), text: `Hi all. ${quote} Bring your build logs.` };
  return check({ title: 'Robotics meeting', date: ymd(at(3, 12)), start: '15:30', end: '17:00', kind: 'meeting', quote }, message, NOW, { engine: 'nano' }).event;
}

/**
 * The two things a visitor can change, each made the way the app makes it:
 * practice moving is that day's practice called off, the way the assistant
 * calls off one day of an activity, and the new time added to the calendar as
 * busy (Calendar, "Add to your calendar"); a new assignment is one added with
 * its time (School, "Add an assignment"). Then the plan is worked out again,
 * exactly as it is in the app after either. Returns the new week.
 */
export const CHANGES = {
  moved: {
    label: "Coach moves Wednesday's practice to 6pm",
    did: "Wednesday's practice now runs from 6pm to 8pm, so the afternoon opens up and the evening fills.",
    apply: (st) => {
      const practice = st.commitments.find((c) => c.id === 'practice');
      (practice.skip ||= {})[dateKey(at(2, 12))] = true;
      st.busy.push({ id: 'moved', title: 'Basketball practice', source: 'manual', start: at(2, 18).toISOString(), end: at(2, 20).toISOString() });
    }
  },
  lab: {
    label: 'A lab report comes in',
    did: 'A chemistry lab report comes in that is due Wednesday at 8am and should take about 1h 30m.',
    apply: (st) => {
      st.tasks.lab = { id: 'lab', source: 'manual', title: 'Chemistry lab report', courseName: 'Chemistry', due: at(2, 8).toISOString(), userEstimateMin: 90, category: 'lab', status: 'todo', description: '' };
    }
  }
};

export function change(state, key) {
  return atMoment(NOW, () => {
    const after = structuredClone(state);
    CHANGES[key].apply(after);
    recomputeState(after);
    return { after };
  });
}

/** The hours work may go into on a day of the story (0 is Monday). */
export const freeHours = (state, dayOffset) => atMoment(NOW, () => workWindows(state, at(dayOffset, 12)));

export const storyDay = (dayOffset) => at(dayOffset, 12);

// ------------------------------------------------------------------ words
// Everything below turns the planner's result into what the page shows. It
// reads the result; it never decides anything the planner did not.

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SHOWN_DAYS = 5;                          // Monday to Friday: the essay is due the next Monday
const offsetOf = (d) => Math.round((+startOfDay(new Date(d)) - +startOfDay(NOW)) / 86400000);

/** A day of the story the way Sam would say it: tonight, tomorrow, Thursday, next Monday. */
function dayWord(d, { evening = false } = {}) {
  const o = offsetOf(d);
  if (o === 0) return evening ? 'tonight' : 'today';
  if (o === 1) return 'tomorrow';
  if (o === 7) return 'next Monday';
  return WEEKDAYS[((o % 7) + 7) % 7];
}
const list = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0] || '');

/** The blocks planned for one assignment, earliest first. */
const blocksFor = (st, id) => (st.plan?.sessions || []).filter((s) => s.taskId === id).sort((a, b) => new Date(a.start) - new Date(b.start));

/** The sessions planned this week for one weekly goal, earliest first. */
const sessionsOf = (st, id) => (st.plan?.sessions || []).filter((s) => s.commitmentId === id && offsetOf(s.start) < 7).sort((a, b) => new Date(a.start) - new Date(b.start));

/** The activities with a weekly goal and no set time: the ones Cadence plans sessions for. */
const goals = (st) => (st.commitments || []).filter((c) => !c.archived && !isFixed(c));

/** Where an assignment's work went: "tonight at 5:30pm", or "Wednesday and Thursday" for several days. */
function placement(blocks) {
  if (!blocks.length) return 'not planned';
  const days = [...new Set(blocks.map((b) => dayWord(b.start, { evening: true })))];
  if (blocks.length === 1) return `${days[0]} at ${fmtTime(blocks[0].start)}`;
  if (days.length === 1) return `${days[0]}, from ${fmtTime(blocks[0].start)}`;
  return list(days);
}

/** What is fixed on a day: everything the plan has to work around, except school (said once, above). */
function fixedOn(st, o) {
  return atMoment(NOW, () => allBusy(st))
    .filter((b) => b.source !== 'school' && offsetOf(b.start) === o)
    .sort((a, b) => new Date(a.start) - new Date(b.start));
}

/** Free time tonight, as the planner sees it: its work hours, less what is fixed. */
function freeTonight(st) {
  const windows = freeHours(st, 0);
  const fixed = fixedOn(st, 0);
  const free = [];
  for (const w of windows) {
    let from = at(0, ...w.start.split(':').map(Number));
    const to = at(0, ...w.end.split(':').map(Number));
    for (const b of fixed) {
      const bs = new Date(b.start), be = new Date(b.end);
      if (be <= from || bs >= to) continue;
      if (bs > from) free.push([from, bs]);
      if (be > from) from = be;
    }
    if (to > from) free.push([from, to]);
  }
  return { free: free.filter(([a, b]) => (b - a) / 60000 >= (st.settings.sessionMinMin || 20)), fixed };
}

/** Why the week looks the way it does: the free hours, the activities, then each assignment, soonest due first. */
function whyLines(st) {
  const { free, fixed } = freeTonight(st);
  const taken = fixed.map((b) => `${b.title.toLowerCase()} from ${fmtTime(b.start)} to ${fmtTime(b.end)}`);
  const lines = [{
    title: `Free tonight: ${list(free.map(([a, b]) => `${fmtTime(a)} to ${fmtTime(b)}`)) || 'none'}`,
    text: `School ends at ${fmtClock(st.school.end)}${taken.length ? `, followed by ${list(taken)}` : ''}. Cadence stops planning work ${DAY.windDown} minutes before Sam's ${fmtClock(st.sleep.bed)} bedtime.`
  }];
  for (const c of goals(st)) {
    const blocks = sessionsOf(st, c.id);
    lines.push({
      title: c.title,
      text: `Sam's goal is ${c.target.sessions} sessions of ${fmtMinutes(c.target.minutes)} a week, at no set time. ${blocks.length ? `Cadence planned ${blocks.length === 1 ? 'one' : 'them'} ${eachBlock(blocks)}.` : 'None of them fit this week.'}`
    });
  }
  for (const e of (st.sources?.mail?.enabled && st.sources.mail.events) || []) {
    lines.push({
      title: e.title,
      text: `It came in an email from the ${e.mail.from.toLowerCase()}, so it's on the calendar ${dayWord(e.start)} from ${fmtTime(e.start)} to ${fmtTime(e.end)} and no work goes there.`
    });
  }
  const tasks = Object.values(st.tasks).filter((t) => t.status !== 'done').sort((a, b) => new Date(a.due) - new Date(b.due));
  for (const t of tasks) {
    const blocks = blocksFor(st, t.id);
    const total = blocks.reduce((n, b) => n + b.minutes, 0);
    lines.push({
      title: t.title,
      text: `It's due ${dayWord(t.due)} at ${fmtTime(t.due)}, ${planned(blocks, total)}.`
    });
  }
  return lines;
}

/** How an assignment's time was planned, as the end of a sentence: "and Cadence planned 1h for it tonight at 5:30pm". */
function planned(blocks, total) {
  if (!blocks.length) return 'and none of it is planned yet';
  const days = new Set(blocks.map((b) => dayWord(b.start, { evening: true })));
  if (blocks.length === 1) return `and Cadence planned ${fmtMinutes(total)} for it ${placement(blocks)}`;
  if (days.size === 1) return `and Cadence planned ${fmtMinutes(total)} for it ${placement(blocks)}, in ${blocks.length} blocks`;
  // Say the number of blocks only when some day has more than one.
  return `and Cadence split its ${fmtMinutes(total)} across ${placement(blocks)}${blocks.length > days.size ? `, in ${blocks.length} blocks` : ''}`;
}

/** Every block of an assignment, with its day and time: for a move that stays on the same days. */
const eachBlock = (blocks) => list(blocks.map((b) => `${dayWord(b.start, { evening: true })} at ${fmtTime(b.start)}`));

/** What one change did, read off the plans before and after it. */
function changeLines(before, after, key) {
  const out = [CHANGES[key].did];
  const sig = (bs) => bs.map((b) => `${b.start}|${b.minutes}`).join(',');
  for (const c of goals(after)) {
    const was = sessionsOf(before, c.id), now = sessionsOf(after, c.id);
    if (sig(was) === sig(now)) out.push(`${c.title} keeps its ${now.length === 1 ? 'session' : 'sessions'}, ${eachBlock(now)}.`);
    else if (!was.length) out.push(`${c.title} now fits ${eachBlock(now)}.`);
    else out.push(`${c.title} moves from ${eachBlock(was)} to ${now.length ? eachBlock(now) : 'nowhere this week'}.`);
  }
  for (const t of Object.values(after.tasks).sort((a, b) => new Date(a.due) - new Date(b.due))) {
    const was = blocksFor(before, t.id), now = blocksFor(after, t.id);
    if (!before.tasks[t.id]) out.push(`${t.title} goes in ${placement(now)}, before it's due ${dayWord(t.due)} at ${fmtTime(t.due)}.`);
    else if (sig(was) !== sig(now)) {
      // Day names alone can read the same before and after; then say the times.
      const same = placement(was) === placement(now);
      out.push(`${t.title} moves from ${same ? eachBlock(was) : placement(was)} to ${same ? eachBlock(now) : placement(now)}.`);
    }
  }
  const late = [...(after.plan?.late || []), ...(after.plan?.unplaced || [])];
  out.push(late.length ? `Some work no longer fits before it's due (${list(late.map((x) => x.title || x))}). In the app, Cadence tells you and you decide what to do.` : "Everything still gets done before it's due.");
  return out;
}

// ------------------------------------------------------------------ the page

/** The week, Monday to Friday: what is fixed and what Cadence planned. `marks` flags blocks a change moved or added. */
function weekHtml(st, marks = {}) {
  const rows = [];
  for (let o = 0; o < SHOWN_DAYS; o++) {
    const items = [
      ...fixedOn(st, o).map((b) => ({ kind: 'fixed', start: b.start, end: b.end, title: b.title, email: b.source === 'mail' })),
      ...(st.plan?.sessions || []).filter((s) => s.taskId && offsetOf(s.start) === o)
        .map((s) => ({ kind: 'work', start: s.start, end: s.end, title: s.title, minutes: s.minutes, mark: marks[`${s.taskId}|${s.start}`] }))
    ].sort((a, b) => new Date(a.start) - new Date(b.start));
    rows.push(`<li><span class="ev-day">${WEEKDAYS[o]}</span>${items.length ? `<ol class="ev-items">${items.map((it) => `
      <li class="ev-item ${it.kind}${it.mark ? ` ${it.mark}` : ''}"><span class="ev-time">${fmtTime(it.start)}</span><span class="ev-what">${esc(it.title)}${it.mark ? `<small>${it.mark === 'new' ? 'New' : 'Moved'}</small>` : ''}${it.email ? '<small class="ev-from">From email</small>' : ''}</span><span class="ev-len">${fmtMinutes(it.minutes ?? (new Date(it.end) - new Date(it.start)) / 60000)}</span></li>`).join('')}</ol>` : '<p class="ev-none">Nothing planned</p>'}</li>`);
  }
  return `<ol class="ev-week">${rows.join('')}</ol>`;
}

/** Blocks that a change moved or added, keyed by assignment and start. */
function marksFor(before, after) {
  const marks = {};
  const had = new Set((before.plan?.sessions || []).map((s) => `${s.taskId}|${s.start}`));
  for (const s of after.plan?.sessions || []) {
    if (!s.taskId) continue;
    const key = `${s.taskId}|${s.start}`;
    // A weekly goal's session is never new: the goal was there before.
    if (!s.commitmentId && !before.tasks[s.taskId]) marks[key] = 'new';
    else if (!had.has(key)) marks[key] = 'moved';
  }
  return marks;
}

const linesHtml = (lines) => lines.map((l) => (typeof l === 'string' ? `<li>${esc(l)}</li>` : `<li><b>${esc(l.title)}</b> ${esc(l.text)}</li>`)).join('');

/** Puts the week, its reasons and (after a change) what changed into the page. */
function paint(host, st, { before = null, key = null } = {}) {
  host.querySelector('[data-ev-week]').innerHTML = weekHtml(st, before ? marksFor(before, st) : {});
  host.querySelector('[data-ev-why]').innerHTML = linesHtml(whyLines(st));
  const changed = host.querySelector('[data-ev-changed]');
  const lines = before ? changeLines(before, st, key) : [];
  changed.hidden = !lines.length;
  changed.querySelector('ul').innerHTML = linesHtml(lines);
}

/**
 * Brings the example to life on the homepage. The page already holds the
 * starting week, written in by hand from this same code (so it reads the same
 * without scripts); this works it out again, shows the buttons, and answers
 * them. The two changes stack: each button adds its change to the week as it
 * stands, or takes it back out, and the week is worked out again from Monday.
 */
export function mount(host) {
  const start = startingWeek();
  let applied = [];
  let shown = start;
  paint(host, start);
  const status = host.querySelector('[data-ev-status]');
  const buttons = [...host.querySelectorAll('[data-ev-change]')];
  host.querySelector('[data-ev-try]').hidden = false;

  const weekWith = (keys) => keys.reduce((st, k) => change(st, k).after, start);
  const press = (key) => {
    const before = shown;
    const taking = applied.includes(key);
    applied = taking ? applied.filter((k) => k !== key) : [...applied, key];
    shown = weekWith(applied);
    for (const b of buttons) b.setAttribute('aria-pressed', String(applied.includes(b.dataset.evChange)));
    if (taking) {
      paint(host, shown);
      status.textContent = `Took back "${CHANGES[key].label[0].toLowerCase()}${CHANGES[key].label.slice(1)}" and planned the week again without it.`;
    } else {
      paint(host, shown, { before, key });
      status.textContent = `${CHANGES[key].label}, so Cadence planned the week again.`;
    }
  };
  for (const b of buttons) b.addEventListener('click', () => press(b.dataset.evChange));
  host.querySelector('[data-ev-reset]')?.addEventListener('click', () => {
    applied = [];
    shown = start;
    for (const b of buttons) b.setAttribute('aria-pressed', 'false');
    paint(host, start);
    status.textContent = "Sam's week is back to how it started.";
  });
}

const host = typeof document !== 'undefined' && document.querySelector('[data-evening]');
if (host) mount(host);
