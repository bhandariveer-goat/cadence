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
      spanish: task('spanish', 'Spanish quiz', 'Spanish 3', at(3, 9), 45, 'quiz'),
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
    label: "Coach moves Wednesday’s practice to 6pm",
    did: "Wednesday’s practice now runs from 6pm to 8pm. It goes on the calendar as an event, so the afternoon opens up and the evening fills.",
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
      st.tasks.lab = { id: 'lab', source: 'manual', title: 'Lab report', courseName: 'Chemistry', due: at(2, 8).toISOString(), userEstimateMin: 90, category: 'lab', status: 'todo', description: '' };
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

/** A due time as a student reads it: 11:59pm, not "midnight", which reads as the start of the day. */
const dueAt = (d) => { const x = new Date(d); return x.getHours() === 23 && x.getMinutes() === 59 ? '11:59pm' : fmtTime(x); };

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
    text: `School ends at ${fmtClock(st.school.end)}${taken.length ? `, followed by ${list(taken)}` : ''}. Cadence stops planning work ${DAY.windDown} minutes before Sam’s ${fmtClock(st.sleep.bed)} bedtime.`
  }];
  for (const c of goals(st)) {
    const blocks = sessionsOf(st, c.id);
    lines.push({
      title: c.title,
      text: `Sam’s goal is ${c.target.sessions} sessions of ${fmtMinutes(c.target.minutes)} a week, at no set time. ${blocks.length ? `Cadence planned ${blocks.length === 1 ? 'one' : 'them'} ${eachBlock(blocks)}.` : 'None of them fit this week.'}`
    });
  }
  for (const e of (st.sources?.mail?.enabled && st.sources.mail.events) || []) {
    lines.push({
      title: e.title,
      text: `It came in an email from the ${e.mail.from.toLowerCase()}, so it’s on the calendar ${dayWord(e.start)} from ${fmtTime(e.start)} to ${fmtTime(e.end)} and no work goes there.`
    });
  }
  const tasks = Object.values(st.tasks).filter((t) => t.status !== 'done').sort((a, b) => new Date(a.due) - new Date(b.due));
  for (const t of tasks) {
    const blocks = blocksFor(st, t.id);
    const total = blocks.reduce((n, b) => n + b.minutes, 0);
    lines.push({
      title: t.title,
      text: `It’s due ${dayWord(t.due)} at ${dueAt(t.due)}, ${planned(blocks, total)}.`
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
    if (!before.tasks[t.id]) out.push(`${t.title} goes in ${placement(now)}, before it’s due ${dayWord(t.due)} at ${dueAt(t.due)}.`);
    else if (sig(was) !== sig(now)) {
      // Day names alone can read the same before and after; then say the times.
      const same = placement(was) === placement(now);
      out.push(`${t.title} moves from ${same ? eachBlock(was) : placement(was)} to ${same ? eachBlock(now) : placement(now)}.`);
    }
  }
  const late = [...(after.plan?.late || []), ...(after.plan?.unplaced || [])];
  out.push(late.length ? `Some work no longer fits before it’s due (${list(late.map((x) => x.title || x))}). In the app, Cadence tells you and you decide what to do.` : "Everything still gets done before it’s due.");
  return out;
}

// ------------------------------------------------------------------ the page
// The week is drawn once and laid out two ways by site.css: on a wide screen
// as the app's own week grid (a column a day, the afternoon and evening from
// 2:30pm to 10pm), and on a phone as a list of days. Each thing carries where
// it starts and how long it lasts, in minutes into the grid, as two CSS
// variables; the list simply ignores them. Each also carries what it is and
// when it starts in the week (data-who, data-at), which is how a change
// knows which block went where.

const GRID_FROM = 14 * 60 + 30;                // 2:30pm: the end of school is on the grid
const GRID_TO = 22 * 60;                       // 10pm: Cadence stops planning 30 minutes before bed
const SHORT = 32;                              // a block shorter than this (in minutes) shows its title only
const TALL = 50;                               // from this long, a title may take two lines

/** Minutes after midnight, on the thing's own day. */
const minsOf = (d) => { const x = new Date(d); return x.getHours() * 60 + x.getMinutes(); };

/** Which of the app's four kinds something fixed is: school, an activity, or an event (views/week.js kindOf). */
const kindOf = (b) => (b.source === 'school' ? 'school' : b.source === 'activity' ? 'activity' : 'event');

/** Side by side where two things overlap, as the app's grid does: each gets a lane, and the lanes in its cluster. */
function lanes(items) {
  let cluster = [], end = -Infinity;
  const flush = () => {
    const ends = [];
    for (const it of cluster) {
      let lane = ends.findIndex((e) => e <= it.from);
      if (lane < 0) { ends.push(it.to); lane = ends.length - 1; } else ends[lane] = it.to;
      it.lane = lane;
    }
    for (const it of cluster) it.lanes = ends.length;
    cluster = [];
  };
  for (const it of items) {
    if (it.from >= end && cluster.length) flush();
    cluster.push(it);
    end = Math.max(end, it.to);
  }
  flush();
  return items;
}

/** Everything on one day of the story, in time order: school, what else is fixed, and the blocks Cadence planned. */
function dayItems(st, o, marks = {}) {
  const fixed = atMoment(NOW, () => allBusy(st))
    .filter((b) => offsetOf(b.start) === o)
    .map((b) => ({ kind: kindOf(b), source: b.source, start: b.start, end: b.end, title: b.title, email: b.source === 'mail',
      who: b.source === 'school' ? 'school' : `fixed:${b.title}` }));
  const planned = (st.plan?.sessions || []).filter((s) => s.taskId && offsetOf(s.start) === o)
    .map((s) => ({ kind: s.commitmentId ? 'activity' : 'work', planned: true, start: s.start, end: s.end, title: s.title, minutes: s.minutes,
      who: s.commitmentId ? `goal:${s.commitmentId}` : `work:${s.taskId}`, mark: marks[`${s.taskId}|${s.start}`] }));
  const items = [...fixed, ...planned].sort((a, b) => new Date(a.start) - new Date(b.start));
  for (const it of items) {
    it.from = minsOf(it.start);
    it.to = it.from + (new Date(it.end) - new Date(it.start)) / 60000;
    it.at = o * 1440 + it.from;
  }
  return lanes(items);
}

/** The second line of a block on the grid, in the app's own words (views/week.js block). */
function whenOf(it) {
  if (it.kind === 'school') return `until ${fmtTime(it.end)}`;
  if (it.planned) return `${fmtTime(it.start)} · ${fmtMinutes(it.minutes)}`;
  if (it.source === 'activity') return `${fmtTime(it.start)} to ${fmtTime(it.end)}`;
  return it.email ? `${fmtTime(it.start)} · From email` : fmtTime(it.start);
}

/** One thing on the week. On the grid it is placed by --at and --len (minutes into the grid). */
function itemHtml(it) {
  const from = Math.max(GRID_FROM, it.from), to = Math.min(GRID_TO, it.to);
  const place = `--at:${from - GRID_FROM};--len:${Math.max(20, to - from)}${it.lanes > 1 ? `;--lane:${it.lane};--lanes:${it.lanes}` : ''}`;
  const off = to <= from ? ' off-grid' : '';
  const size = to - from < SHORT ? ' short' : to - from >= TALL ? ' tall' : '';
  const time = it.kind === 'school' ? `until ${fmtTime(it.end)}` : fmtTime(it.start);
  const tags = `${it.mark ? `<small>${it.mark === 'new' ? 'New' : 'Moved'}</small>` : ''}${it.email ? '<small class="ev-from">From email</small>' : ''}`;
  return `
      <li class="ev-item k-${it.kind}${it.mark ? ` ${it.mark}` : ''}${size}${off}" data-who="${esc(it.who)}" data-at="${it.at}" style="${place}">${tags ? `<span class="ev-tags">${tags}</span>` : ''}<span class="ev-what">${esc(it.title)}</span><span class="ev-time">${time}</span><span class="ev-len">${fmtMinutes(it.minutes ?? (it.to - it.from))}</span><span class="ev-when">${whenOf(it)}</span></li>`;
}

/** The fixed things of a week (not school), by day, title and start, and by day and title: to tell, after a change, which are new and which moved. */
function fixedSeen(st) {
  const at = new Set(), titles = new Set();
  for (let o = 0; o < SHOWN_DAYS; o++) {
    for (const it of dayItems(st, o)) {
      if (!it.who.startsWith('fixed:')) continue;
      at.add(`${it.who}|${it.at}`);
      titles.add(`${o}|${it.who}`);
    }
  }
  return { at, titles };
}

/** The week, Monday to Friday: school, what else is fixed, and what Cadence planned. With `before`, the week as it was
    before a change, the blocks and fixed things that change moved or added are marked. */
function weekHtml(st, before = null) {
  const marks = before ? marksFor(before, st) : {};
  const seen = before ? fixedSeen(before) : null;
  const daysPlanned = Object.fromEntries((st.plan?.days || []).map((d) => [d.date, d.minutes]));
  const hours = [];
  for (let m = Math.ceil(GRID_FROM / 60) * 60; m <= GRID_TO; m += 60) hours.push(`<li style="--at:${m - GRID_FROM}"><span>${fmtClock(`${m / 60}:00`)}</span></li>`);
  const cols = [];
  for (let o = 0; o < SHOWN_DAYS; o++) {
    const items = dayItems(st, o, marks);
    // Something fixed that was not there before is new, or, if a thing of the same name was on that day, moved.
    if (seen) for (const it of items) if (it.who.startsWith('fixed:') && !seen.at.has(`${it.who}|${it.at}`)) it.mark = seen.titles.has(`${o}|${it.who}`) ? 'moved' : 'new';
    const due = Object.values(st.tasks).filter((t) => t.status !== 'done' && offsetOf(t.due) === o).length;
    // Under the day's name, as on the app's grid: what is due, or else how much work is planned.
    const load = daysPlanned[dateKey(storyDay(o))];
    const head = due ? `<span class="ev-due">${due} due</span>` : load ? `<span class="ev-due ev-load">${fmtMinutes(load)}</span>` : '<span class="ev-due ev-load"></span>';
    const now = o === 0 ? `<li class="ev-now" style="--at:${minsOf(NOW) - GRID_FROM}" aria-hidden="true"></li>` : '';
    const empty = items.every((it) => it.kind === 'school') ? '<p class="ev-none">Nothing planned</p>' : '';
    cols.push(`<li class="ev-col${o === 0 ? ' today' : ''}"><p class="ev-dayhead"><span class="ev-day">${WEEKDAYS[o]}</span>${head}</p>${empty}<ol class="ev-items">${now}${items.map(itemHtml).join('')}</ol></li>`);
  }
  return `<div class="ev-grid" style="--span:${GRID_TO - GRID_FROM}"><ol class="ev-hours" aria-hidden="true">${hours.join('')}</ol><ol class="ev-week">${cols.join('')}</ol></div>`;
}

/** Blocks that a change moved or added, keyed by assignment and start: new for a new assignment, moved for
    work that now starts somewhere it did not, or starts where it did but runs longer or shorter. */
function marksFor(before, after) {
  const marks = {};
  const had = new Map((before.plan?.sessions || []).map((s) => [`${s.taskId}|${s.start}`, s.minutes]));
  for (const s of after.plan?.sessions || []) {
    if (!s.taskId) continue;
    const key = `${s.taskId}|${s.start}`;
    // A weekly goal's session is never new: the goal was there before.
    if (!s.commitmentId && !before.tasks[s.taskId]) marks[key] = 'new';
    else if (!had.has(key) || had.get(key) !== s.minutes) marks[key] = 'moved';
  }
  return marks;
}

const PLURAL_DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

/** What Sam has told Cadence, read off the week as it stands: what is due,
    the activities, anything added to the calendar and what came in by email.
    `before` is the week before a change, to say what is new. */
function haveHtml(st, before = null) {
  const fresh = (yes) => (before && yes ? '<small>New</small>' : '');
  const row = (kind, key, title, meta, tag = '') => `
      <li class="ev-have-item k-${kind}" data-who="have:${esc(key)}" data-at="0"><span class="ev-what">${esc(title)}${tag}</span><span class="ev-meta">${esc(meta)}</span></li>`;
  const group = (label, rows) => (rows.length ? `<li><p class="ev-group">${label}</p><ol>${rows.join('')}</ol></li>` : '');

  const tasks = Object.values(st.tasks).filter((t) => t.status !== 'done').sort((a, b) => new Date(a.due) - new Date(b.due));
  const due = tasks.map((t) => row('work', t.id, t.title, `Due ${dayWord(t.due)} at ${dueAt(t.due)}, about ${fmtMinutes(t.userEstimateMin)} of work`, fresh(!before?.tasks[t.id])));

  const weekKeys = new Set([...Array(7)].map((_, i) => dateKey(storyDay(i))));
  const activities = (st.commitments || []).filter((c) => !c.archived).map((c) => {
    if (!isFixed(c)) return row('activity', c.id, c.title, `${c.target.sessions} sessions of ${fmtMinutes(c.target.minutes)} a week, at no set time`);
    const off = Object.keys(c.skip || {}).filter((k) => c.skip[k] && weekKeys.has(k)).map((k) => WEEKDAYS[offsetOf(new Date(`${k}T12:00`))]);
    return row('activity', c.id, c.title, `${list(c.schedule.days.map((d) => PLURAL_DAYS[d]))}, ${fmtClock(c.schedule.start)} to ${fmtClock(c.schedule.end)}${off.length ? `, but not ${list(off)} this week` : ''}`);
  });

  const had = new Set((before?.busy || []).map((b) => b.id));
  const added = (st.busy || []).map((b) => row('event', b.id, b.title, `${dayWord(b.start)}, ${fmtTime(b.start)} to ${fmtTime(b.end)}`, fresh(!had.has(b.id))));

  const mail = ((st.sources?.mail?.enabled && st.sources.mail.events) || []).map((e) => row('event', e.id, e.title, `${dayWord(e.start)}, ${fmtTime(e.start)} to ${fmtTime(e.end)}, in an email from the ${e.mail.from.toLowerCase()}`));

  return `<ol class="ev-have">${group('Due this week', due)}${group('Activities', activities)}${group('Added to the calendar', added)}${group('Found in email', mail)}</ol>`;
}

const linesHtml = (lines) => lines.map((l) => (typeof l === 'string' ? `<li>${esc(l)}</li>` : `<li><b>${esc(l.title)}</b> ${esc(l.text)}</li>`)).join('');

// ----------------------------------------------------------------- motion
// When a change re-plans the week, the blocks that moved glide from where
// they were to where they are now and the new ones arrive, with the same
// spring as the live app at the top of the page. Only ever in answer to a
// click, transform and opacity only, and not at all for someone who has asked
// their device for less motion.
//
// A block is matched to its place before the change by what it is (data-who):
// the same thing at the same time is the same block; whatever is left of each
// thing is paired up in time order, and those glide. Places are measured
// within the part of the page being redrawn, so the page moving around it
// does not count as a move.

const SPRING = 'cubic-bezier(.34, 1.4, .64, 1)';
const EASE_OUT = 'cubic-bezier(.16, 1, .3, 1)';
const calm = () => typeof matchMedia !== 'function' || matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Where each thing in `root` is now, within `root`. Things still arriving are left out, so they arrive again. */
function places(root) {
  if (!root?.querySelectorAll) return [];
  const base = root.getBoundingClientRect();
  const out = [];
  for (const el of root.querySelectorAll('[data-who]')) {
    if (el.dataset.arriving) continue;
    const r = el.getBoundingClientRect();
    if (r.width) out.push({ who: el.dataset.who, at: Number(el.dataset.at), x: r.left - base.left, y: r.top - base.top });
  }
  return out;
}

/** Moves each thing in `root` from where it was (`was`, from places()) to where it is now. */
function glide(was, root) {
  if (!was || !root?.querySelectorAll || calm()) return;
  const base = root.getBoundingClientRect();
  const now = [...root.querySelectorAll('[data-who]')].filter((el) => el.getBoundingClientRect().width);
  const pool = new Map();
  for (const p of was) pool.set(p.who, [...(pool.get(p.who) || []), p]);
  const from = new Map();
  for (const el of now) {
    const left = pool.get(el.dataset.who) || [];
    const i = left.findIndex((p) => p.at === Number(el.dataset.at));
    if (i >= 0) from.set(el, left.splice(i, 1)[0]);
  }
  for (const el of now.filter((e) => !from.has(e)).sort((a, b) => a.dataset.at - b.dataset.at)) {
    const left = (pool.get(el.dataset.who) || []).sort((a, b) => a.at - b.at);
    if (left.length) from.set(el, left.shift());
  }
  let arriving = 0;
  for (const el of now) {
    if (typeof el.animate !== 'function') return;
    const then = from.get(el);
    if (then) {
      const r = el.getBoundingClientRect();
      const dx = then.x - (r.left - base.left), dy = then.y - (r.top - base.top);
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 460, easing: EASE_OUT });
    } else {
      el.dataset.arriving = '1';
      const done = () => { delete el.dataset.arriving; };
      el.animate([{ opacity: 0, transform: 'translateY(8px) scale(.96)' }, { opacity: 1, transform: 'none' }],
        { duration: 520, delay: 140 + 60 * arriving++, easing: SPRING, fill: 'backwards' }).finished.then(done, done);
    }
  }
}

/** Puts the week, what Sam has, its reasons and (after a change) what changed into the page. */
function paint(host, st, { before = null, key = null, animate = false } = {}) {
  const week = host.querySelector('[data-ev-week]');
  const have = host.querySelector('[data-ev-have]');
  const wasWeek = animate ? places(week) : null;
  const wasHave = animate ? places(have) : null;
  week.innerHTML = weekHtml(st, before);
  if (have) have.innerHTML = haveHtml(st, before);
  host.querySelector('[data-ev-why]').innerHTML = linesHtml(whyLines(st));
  const changed = host.querySelector('[data-ev-changed]');
  const lines = before ? changeLines(before, st, key) : [];
  changed.hidden = !lines.length;
  changed.querySelector('ul').innerHTML = linesHtml(lines);
  // The key names the orange ring only while something is marked with it.
  const ring = host.querySelector('[data-ev-ring]');
  if (ring) ring.hidden = !before;
  glide(wasWeek, week);
  glide(wasHave, have);
}

/**
 * Brings the example to life on the homepage. The page already holds the
 * starting week, written in by hand from this same code (so it reads the same
 * without scripts); this works it out again, shows the buttons, and answers
 * them. The two changes stack: each button adds its change to the week as it
 * stands, or takes it back out, and the week is worked out again from Monday.
 * Start over is offered only once there is something to undo.
 */
export function mount(host) {
  const start = startingWeek();
  let applied = [];
  let shown = start;
  paint(host, start);
  const status = host.querySelector('[data-ev-status]');
  const buttons = [...host.querySelectorAll('[data-ev-change]')];
  const reset = host.querySelector('[data-ev-reset]');
  host.querySelector('[data-ev-try]').hidden = false;

  const weekWith = (keys) => keys.reduce((st, k) => change(st, k).after, start);
  const press = (key) => {
    const before = shown;
    const taking = applied.includes(key);
    applied = taking ? applied.filter((k) => k !== key) : [...applied, key];
    shown = weekWith(applied);
    for (const b of buttons) b.setAttribute('aria-pressed', String(applied.includes(b.dataset.evChange)));
    if (reset) reset.hidden = !applied.length;
    if (taking) {
      paint(host, shown, { animate: true });
      status.textContent = `Took back "${CHANGES[key].label[0].toLowerCase()}${CHANGES[key].label.slice(1)}" and planned the week again without it.`;
    } else {
      paint(host, shown, { before, key, animate: true });
      status.textContent = `${CHANGES[key].label}, so Cadence planned the week again.`;
    }
  };
  for (const b of buttons) b.addEventListener('click', () => press(b.dataset.evChange));
  reset?.addEventListener('click', () => {
    applied = [];
    shown = start;
    for (const b of buttons) b.setAttribute('aria-pressed', 'false');
    reset.hidden = true;
    paint(host, start, { animate: true });
    status.textContent = "Sam’s week is back to how it started.";
    // The button just pressed is gone; carry on from the first change.
    buttons[0]?.focus();
  });
}

const host = typeof document !== 'undefined' && document.querySelector('[data-evening]');
if (host) mount(host);
