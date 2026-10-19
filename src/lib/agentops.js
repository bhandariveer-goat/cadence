// What the assistant can do, as plain data.
//
// Everything the assistant changes goes through one small set of operations:
// add an event, add an activity, add an assignment, put a number on one day,
// change school or sleep, mark something done, move it, remove it. Reading a
// sentence offline (lib/agent.js) and asking Claude (lib/agentllm.js) both
// produce these same operations, and applyOps() is the only code that performs
// them. That is what makes every change listable and undoable in one step.
//
// The other half of this file answers questions without changing anything:
// what to do now, what is left tonight, whether Friday evening is free, and
// what would move if something were added.

import { addDays, startOfDay, atTime, dateKey, uid, fmtMinutes, fmtClock, MIN, DAY as DAY_MS } from './util.js';
import { newCommitment, KINDS, isFixed, weekProgress } from './habits.js';
import { classify } from './estimator.js';
import { recomputeState, allBusy, plannable } from './replanner.js';
import { workWindows, isSchoolDay, schoolEnd, overrideFor } from './daymodel.js';
import { freeSlots } from './calendar.js';
import { addNote, forgetNote, setPrefs, memoryView } from './memory.js';
import { atRisk } from './scheduler.js';

const pad = (n) => String(n).padStart(2, '0');
export const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };
export const fromMin = (t) => { const m = ((Math.round(t) % 1440) + 1440) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
const isTime = (v) => /^\d{1,2}:\d{2}$/.test(String(v || ''));
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const noon = (k) => new Date(`${k}T12:00:00`);

/** "6pm", "6:30pm", "midnight": how a person says a clock time. */
export const clock = fmtClock;

/** The same, from a Date or ISO string. */
export const clockOf = (d) => { const x = new Date(d); return clock(`${pad(x.getHours())}:${pad(x.getMinutes())}`); };

const DOW_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function joinDays(days = []) {
  const names = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DOW_ABBR[d]);
  if (names.length === 7) return 'day';
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] || '';
}

/** "today", "tomorrow", "Friday", "Oct 12": a date, the way you'd say it. */
export function dayWord(k, now = new Date()) {
  const diff = Math.round((+startOfDay(noon(k)) - +startOfDay(now)) / DAY_MS);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  if (diff > 1 && diff < 7) return noon(k).toLocaleDateString([], { weekday: 'long' });
  return noon(k).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
const nightWord = (k, now) => (k === dateKey(now) ? 'tonight' : dayWord(k, now));
const dur = (min) => fmtMinutes(Math.max(0, Math.round(min)));

// --------------------------------------------------------------- finding

const STOP = new Set(['the', 'a', 'an', 'my', 'of', 'for', 'to', 'and', 'on', 'in', 'at', 'hw', 'homework', 'assignment', 'thing', 'stuff', 'work']);
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));

/**
 * Find what someone means by "the lab report" or "chem" or "piano".
 * @returns {{type:'task'|'activity'|'event', id, title, score}[]} best first
 */
export function findItems(state, phrase, { types = ['task', 'activity', 'event'], now = new Date() } = {}) {
  const want = words(phrase);
  if (!want.length) return [];
  const score = (hay) => {
    const have = words(hay);
    if (!have.length) return 0;
    let hit = 0;
    for (const w of want) if (have.some((h) => h === w || (w.length >= 3 && (h.startsWith(w) || w.startsWith(h))))) hit++;
    return hit / want.length;
  };
  const out = [];
  if (types.includes('task')) {
    for (const t of Object.values(state.tasks || {})) {
      if (t.status === 'done' || state.dismissed?.[t.id]) continue;
      const s = Math.max(score(t.title), score(`${t.courseName || ''} ${t.title}`) * 0.95, score(t.courseName || '') * 0.6);
      if (s >= 0.5) out.push({ type: 'task', id: t.id, title: t.title, score: s });
    }
  }
  if (types.includes('activity')) {
    for (const c of (state.commitments || []).filter((x) => !x.archived)) {
      const s = score(c.title);
      if (s >= 0.5) out.push({ type: 'activity', id: c.id, title: c.title, score: s + 0.01 });
    }
  }
  if (types.includes('event')) {
    for (const b of (state.busy || [])) {
      if (b.source === 'skip' || +new Date(b.end) < +now) continue;
      const s = score(b.title);
      if (s >= 0.5) out.push({ type: 'event', id: b.id, title: b.title, score: s, at: b.start });
    }
  }
  return out.sort((a, b) => b.score - a.score || String(a.at || '').localeCompare(String(b.at || '')));
}

// -------------------------------------------------------------- describe

/** One line saying what an operation does, for the list under each reply. */
export function describe(op, state, now = new Date()) {
  switch (op.kind) {
    case 'event': {
      const when = op.days?.length ? `every ${joinDays(op.days)}` : (op.dates || []).map((k) => dayWord(k, now)).join(', ');
      return `${op.title} · ${clock(op.start)} to ${clock(op.end)} ${when}`.trim();
    }
    case 'activity':
      return op.mode === 'fixed'
        ? `${op.title} · ${joinDays(op.days)} ${clock(op.start)} to ${clock(op.end)}`
        : `${op.title} · ${op.sessions || 3} times a week, ${dur(op.minutes || 30)} each`;
    case 'task':
      return `${op.title} · due ${dayWord(dateKey(new Date(op.due)), now)}${op.minutes ? `, about ${dur(op.minutes)}` : ''}`;
    case 'day': {
      const which = (op.dates || []).map((k) => nightWord(k, now)).join(', ');
      if (op.clear) return `Back to a normal day ${which}`;
      if (op.off) return `No work ${which}`;
      const bits = [];
      // These are the limits the student set; what is actually planned can be less.
      if (Number.isFinite(op.budgetMin)) bits.push(`up to ${dur(op.budgetMin)} of work`);
      if (isTime(op.startAt)) bits.push(`starting ${clock(op.startAt)}`);
      if (isTime(op.until)) bits.push(`stopping by ${clock(op.until)}`);
      return `${which[0].toUpperCase()}${which.slice(1)}: ${bits.join(', ')}`;
    }
    case 'school': {
      const bits = [];
      if (op.offDates?.length) bits.push(`No school ${op.offDates.map((k) => dayWord(k, now)).join(', ')}`);
      for (const e of op.early || []) bits.push(`Out of school at ${clock(e.time)} ${dayWord(e.date, now)}`);
      if (op.onDates?.length) bits.push(`School is on ${op.onDates.map((k) => dayWord(k, now)).join(', ')}`);
      if (isTime(op.end) || isTime(op.start)) bits.push(`School runs ${clock(op.start || state.school.start)} to ${clock(op.end || state.school.end)}`);
      if (op.days) bits.push(`School days: ${joinDays(op.days)}`);
      return bits.join('. ');
    }
    case 'sleep':
      return [isTime(op.wake) && `Up around ${clock(op.wake)}`, isTime(op.bed) && `In bed around ${clock(op.bed)}`].filter(Boolean).join(', ');
    case 'done': return `${op.title} · marked done`;
    case 'estimate': return `${op.title} · now about ${dur(op.minutes)}`;
    case 'move': return `${op.title} · moved to ${dayWord(op.date, now)}`;
    case 'first': return `${op.title} · do this first`;
    case 'remove': return op.date ? `${op.title} · off ${dayWord(op.date, now)}` : `${op.title} · removed`;
    case 'limit': return op.minutes ? `No more than ${dur(op.minutes)} of work on any day` : 'Daily limit removed';
    case 'memory':
      if (op.forget) return `Forgot: ${op.title || 'a note'}`;
      if (op.note) return `Remembered: ${op.note}`;
      return op.said?.length ? `Preference: ${op.said.join(', ')}` : 'Preferences updated';
    default: return '';
  }
}

export const KIND_LABEL = {
  event: 'On your calendar', activity: 'New activity', task: 'New assignment', day: 'Just this day', school: 'School',
  sleep: 'Sleep', done: 'Assignment', estimate: 'Time estimate', move: 'Moved', first: 'Priority', remove: 'Removed', limit: 'Daily limit',
  memory: 'Memory'
};

// ----------------------------------------------------------------- apply

const HORIZON_WEEKS = 8;

/**
 * Perform operations. Mutates `state`; the caller keeps a snapshot for undo.
 * @returns {object[]} the operations that actually took effect
 */
export function applyOps(state, ops, now = new Date()) {
  const done = [];
  for (const op of ops || []) {
    try {
      if (APPLY[op.kind]?.(state, op, now) !== false) done.push(op);
    } catch { /* one bad operation shouldn't lose the rest of the message */ }
  }
  return done;
}

const APPLY = {
  event(state, op, now) {
    if (!isTime(op.start) || !isTime(op.end)) return false;
    const rule = uid('rule');
    const stamps = [];
    if (op.days?.length) {
      for (let i = 0; i < HORIZON_WEEKS * 7; i++) {
        const d = addDays(startOfDay(now), i);
        if (op.days.includes(d.getDay())) stamps.push(d);
      }
    } else {
      for (const k of (op.dates?.length ? op.dates : [dateKey(now)])) if (isDate(k)) stamps.push(noon(k));
    }
    let added = 0;
    for (const day of stamps) {
      const s = atTime(day, op.start);
      let e = atTime(day, op.end);
      if (e <= s) e = addDays(e, 1);
      if (e < now) continue;
      state.busy.push({ id: uid('agent'), title: op.title || 'Busy', start: s.toISOString(), end: e.toISOString(), source: 'agent', rule, allDay: false });
      added++;
    }
    return added > 0;
  },

  activity(state, op) {
    const kind = KINDS[op.type] ? op.type : 'custom';
    const fixed = op.mode === 'fixed' && op.days?.length && isTime(op.start) && isTime(op.end);
    const minutes = fixed ? Math.max(15, toMin(op.end) - toMin(op.start)) : Math.max(10, op.minutes || 30);
    state.commitments.push(newCommitment({
      title: op.title, kind,
      schedule: fixed ? { mode: 'fixed', days: [...op.days], start: op.start, end: op.end } : { mode: 'flexible' },
      target: { sessions: fixed ? op.days.length : Math.max(1, op.sessions || 3), minutes },
      days: fixed ? [] : (op.days || [])
    }));
  },
  // Older callers still say "commitment".
  commitment(state, op) {
    state.commitments.push(newCommitment(op.commitment));
  },

  task(state, op) {
    const due = new Date(op.due);
    if (isNaN(due)) return false;
    const id = uid('you');
    const t = {
      id, source: 'manual', title: op.title || 'Assignment', due: due.toISOString(), status: 'todo',
      courseName: op.course || '', description: '', points: null, url: null,
      userEstimateMin: op.minutes || null, createdAt: new Date().toISOString()
    };
    t.category = classify(t);
    state.tasks[id] = t;
    op.taskId = id;
  },

  day(state, op, now) {
    state.dayOverrides ||= {};
    for (const k of op.dates || []) {
      if (!isDate(k)) continue;
      if (op.clear) { delete state.dayOverrides[k]; continue; }
      const next = { ...(state.dayOverrides[k] || {}) };
      const shapes = Number.isFinite(op.budgetMin) || isTime(op.startAt) || isTime(op.until);
      if (op.off) { next.off = true; delete next.budgetMin; }
      // "Done for tonight", then "actually I can work till 10": the later
      // message wins, or it would be accepted and change nothing.
      else if (shapes) delete next.off;
      if (Number.isFinite(op.budgetMin)) {
        next.budgetMin = Math.max(0, Math.min(720, Math.round(op.budgetMin)));
        next.since = now.toISOString();
        // A cut-off that was worked out from an earlier amount ("90 minutes,
        // then bed") goes when the amount changes; one she stated stays.
        if (next.untilAuto && !isTime(op.until)) { delete next.until; delete next.untilAuto; }
      }
      if (isTime(op.startAt)) next.startAt = op.startAt;
      if (isTime(op.until)) { next.until = op.until; if (op.untilAuto) next.untilAuto = true; else delete next.untilAuto; }
      if (op.note) next.note = String(op.note).slice(0, 80);
      // "Keep my 10pm limit": the assistant stops moving tonight later to fit
      // what is due tomorrow (lib/agentllm.js). A new limit without it lets
      // the assistant be realistic again.
      if (op.kept === true) next.kept = true;
      else if (op.kept === false || op.off || isTime(op.until) || Number.isFinite(op.budgetMin)) delete next.kept;
      state.dayOverrides[k] = next;
    }
  },

  school(state, op) {
    const sc = state.school;
    sc.off ||= {}; sc.early ||= {};
    for (const k of op.offDates || []) if (isDate(k)) { sc.off[k] = true; delete sc.early[k]; }
    for (const k of op.onDates || []) if (isDate(k)) { delete sc.off[k]; delete sc.early[k]; }
    for (const e of op.early || []) if (isDate(e.date) && isTime(e.time)) { sc.early[e.date] = e.time; delete sc.off[e.date]; }
    if (isTime(op.start)) sc.start = op.start;
    if (isTime(op.end)) sc.end = op.end;
    if (Array.isArray(op.days) && op.days.length) sc.days = op.days.filter((d) => d >= 0 && d <= 6);
  },

  sleep(state, op) {
    if (isTime(op.bed)) state.sleep.bed = op.bed;
    if (isTime(op.wake)) state.sleep.wake = op.wake;
  },

  done(state, op) {
    const t = state.tasks[op.taskId];
    if (!t) return false;
    t.status = 'done';
    t.completedAt = new Date().toISOString();
  },

  estimate(state, op) {
    const t = state.tasks[op.taskId];
    if (!t || !(op.minutes > 0)) return false;
    t.userEstimateMin = Math.round(op.minutes);
    t.estimateBoost = 0;
  },

  move(state, op, now) {
    const t = state.tasks[op.taskId];
    if (!t || !isDate(op.date)) return false;
    if (op.date <= dateKey(now)) { t.notBefore = null; t.pinned = true; } else { t.notBefore = startOfDay(noon(op.date)).toISOString(); t.pinned = false; }
  },

  first(state, op) {
    const t = state.tasks[op.taskId];
    if (!t) return false;
    t.pinned = true;
    t.notBefore = null;
  },

  remove(state, op) {
    if (op.target === 'event') {
      const hit = (state.busy || []).find((b) => b.id === op.id);
      if (!hit) return false;
      const same = (b) => (hit.rule ? b.rule === hit.rule : b.id === hit.id || (b.title === hit.title && b.source === hit.source));
      if (op.date) {
        // One date was named: take the occurrence on that date, which is not
        // necessarily the one the name was matched against (the earliest).
        const gone = new Set(state.busy.filter((b) => same(b) && dateKey(new Date(b.start)) === op.date).map((b) => b.id));
        if (!gone.size) return false;
        state.busy = state.busy.filter((b) => !gone.has(b.id));
        return true;
      }
      // No date: a repeating event goes as a whole, a single one on its own.
      state.busy = state.busy.filter((b) => (hit.rule ? b.rule !== hit.rule : b.id !== hit.id));
      return true;
    }
    if (op.target === 'activity') {
      const c = (state.commitments || []).find((x) => x.id === op.id);
      if (!c) return false;
      if (op.date) { (c.skip ||= {})[op.date] = true; return true; }
      c.archived = true;
      return true;
    }
    if (op.target === 'task') {
      const t = state.tasks[op.id];
      if (!t) return false;
      if (t.source === 'manual') delete state.tasks[op.id]; else (state.dismissed ||= {})[op.id] = true;
      return true;
    }
    return false;
  },

  // Notes and preferences (lib/memory.js). A note that cannot be kept (too
  // long, or contact details) is refused rather than trimmed.
  memory(state, op, now) {
    if (op.forget) return forgetNote(state, op.forget);
    if (op.note) {
      const r = addNote(state, op.note, op.by === 'you' ? 'you' : 'assistant', now);
      if (r.error) return false;
      op.note = r.note.text;
      return true;
    }
    if (op.prefs) {
      op.said = setPrefs(state, op.prefs);
      return op.said.length > 0;
    }
    return false;
  },

  limit(state, op) {
    state.settings.maxDailyMin = op.minutes > 0 ? Math.max(20, Math.min(720, Math.round(op.minutes))) : null;
  },
  capacity(state, op) { APPLY.limit(state, op); }
};

// ------------------------------------------------------------------ diff

const openSessions = (state) => (state.plan?.sessions || []).filter((s) => !s.done);
const onDay = (sessions, k) => sessions.filter((s) => dateKey(new Date(s.start)) === k).sort((a, b) => new Date(a.start) - new Date(b.start));

/**
 * What changed between two plans, in the terms a student cares about: what
 * tonight looks like now, what moved to another day, and what no longer fits.
 */
export function diffPlans(before, after, now = new Date()) {
  const today = dateKey(now);
  const a = openSessions(before), b = openSessions(after);
  const mins = (list) => list.reduce((x, s) => x + s.minutes, 0);
  const tonightBefore = onDay(a, today), tonightAfter = onDay(b, today);

  const daysOf = (list) => {
    const m = new Map();
    for (const s of list) {
      const key = s.commitmentId ? `c:${s.commitmentId}` : `t:${s.taskId}`;
      if (!m.has(key)) m.set(key, { title: s.title, days: new Map() });
      const k = dateKey(new Date(s.start));
      m.get(key).days.set(k, (m.get(key).days.get(k) || 0) + s.minutes);
    }
    return m;
  };
  const was = daysOf(a), is = daysOf(b);
  const moved = [];
  for (const [key, cur] of is) {
    const prev = was.get(key);
    if (!prev) continue;
    const from = [...prev.days.keys()].sort(), to = [...cur.days.keys()].sort();
    if (from.join() === to.join()) continue;
    const gone = from.filter((k) => !cur.days.has(k)), came = to.filter((k) => !prev.days.has(k));
    if (!gone.length && !came.length) continue;
    moved.push({ title: cur.title, from: gone, to: came, key });
  }
  // What left tonight matters most; then order by how soon it lands.
  moved.sort((x, y) => Number(y.from.includes(today)) - Number(x.from.includes(today)) || String(x.to[0] || '').localeCompare(String(y.to[0] || '')));

  const wasUnplaced = new Set(atRisk(before.plan).map((u) => u.commitmentId || u.taskId));
  const newlyUnplaced = atRisk(after.plan).filter((u) => !wasUnplaced.has(u.commitmentId || u.taskId));
  const last = tonightAfter.at(-1);

  return {
    tonight: {
      before: mins(tonightBefore),
      after: mins(tonightAfter),
      blocks: tonightAfter.map((s) => ({ title: s.title, start: s.start, end: s.end, minutes: s.minutes })),
      endsAt: last ? last.end : null
    },
    moved: moved.slice(0, 6),
    movedCount: moved.length,
    unplaced: atRisk(after.plan).map((u) => ({ title: u.title, minutes: u.missingMin, due: u.due, assigned: !u.commitmentId, late: !!u.late })),
    newlyUnplaced: newlyUnplaced.map((u) => ({ title: u.title, minutes: u.missingMin, due: u.due, assigned: !u.commitmentId })),
    level: { before: before.plan?.level ?? null, after: after.plan?.level ?? null }
  };
}

/** Apply operations to a copy and report what would change, touching nothing. */
export function simulate(state, ops, now = new Date()) {
  const next = structuredClone(state);
  const applied = applyOps(next, ops, now);
  recomputeState(next);
  return { next, applied, diff: diffPlans(state, next, now) };
}

// --------------------------------------------------------------- answers

/** Free stretches on a date once school, events and planned work are taken out. */
export function freeOn(state, k, now = new Date()) {
  const day = noon(k);
  const from = k === dateKey(now) ? now : startOfDay(day);
  const to = addDays(startOfDay(day), 1);
  const sleep = state.sleep || { bed: '22:30', wake: '07:00' };
  const wide = () => [{ start: sleep.wake, end: sleep.bed }];
  const planned = openSessions(state).map((s) => ({ start: s.start, end: s.end }));
  const open = freeSlots(from, to, wide, [...allBusy(state), ...planned], { sessionMinMin: 20 });
  return open.map((s) => ({ start: s.start, end: s.end, minutes: Math.round((s.end - s.start) / MIN) }));
}

const blockLine = (s) => `${clockOf(s.start)} ${s.title} (${dur(s.minutes)})`;

export function answer(query, state, now = new Date()) {
  const today = dateKey(now);
  const open = openSessions(state);
  const tonight = onDay(open, today).filter((s) => +new Date(s.end) > +now);

  if (query.kind === 'now') {
    const running = open.find((s) => s.startedAt);
    const next = running || tonight[0] || open.find((s) => +new Date(s.start) > +now);
    if (!next) return { text: 'Nothing is planned right now. You are clear.' };
    const t = state.tasks[next.taskId];
    const late = t?.due && +new Date(t.due) < +now;
    const why = t?.due ? ` It ${late ? 'was' : 'is'} due ${dayWord(dateKey(new Date(t.due)), now)}.` : '';
    const when = dateKey(new Date(next.start)) === today
      ? (+new Date(next.start) <= +now ? 'now' : `at ${clockOf(next.start)}`)
      : `${dayWord(dateKey(new Date(next.start)), now)} at ${clockOf(next.start)}`;
    return { text: `${running ? 'Keep going with' : 'Next up'}: ${next.title}, ${dur(next.minutes)}, ${when}.${why}`, focus: next.taskId || null };
  }

  if (query.kind === 'today') {
    if (!tonight.length) return { text: 'Nothing left for today.' };
    const total = tonight.reduce((a, s) => a + s.minutes, 0);
    return { text: `${dur(total)} left today, finishing around ${clockOf(tonight.at(-1).end)}.`, list: tonight.map(blockLine) };
  }

  if (query.kind === 'week') {
    const days = (state.plan?.days || []).filter((d) => d.date >= today).slice(0, 7);
    const due = Object.values(state.tasks || {}).filter((t) => plannable(t, state) && t.due && +new Date(t.due) < +addDays(now, 7))
      .sort((x, y) => new Date(x.due) - new Date(y.due));
    const unplaced = atRisk(state.plan);
    const heavy = days.slice().sort((x, y) => y.minutes - x.minutes)[0];
    const text = [
      due.length ? `${due.length} thing${due.length === 1 ? '' : 's'} due in the next week.` : 'Nothing is due in the next week.',
      heavy?.minutes ? `The heaviest day is ${dayWord(heavy.date, now)} at ${dur(heavy.minutes)}.` : '',
      unplaced.length ? `${unplaced.map((u) => u.title).join(', ')} ${unplaced.length === 1 ? 'is' : 'are'} planned to finish after ${unplaced.length === 1 ? 'its' : 'their'} due date.` : 'Everything fits.'
    ].filter(Boolean).join(' ');
    return {
      text,
      list: [
        ...due.slice(0, 6).map((t) => `${t.title}: due ${dayWord(dateKey(new Date(t.due)), now)}, about ${dur(t.estimateMin || 0)}`),
        ...days.filter((d) => d.minutes).map((d) => `${dayWord(d.date, now)}: ${dur(d.minutes)} planned`)
      ]
    };
  }

  if (query.kind === 'free') {
    const k = query.date || today;
    let slots = freeOn(state, k, now);
    if (query.part) {
      const [lo, hi] = { morning: [0, 720], afternoon: [720, 1020], evening: [1020, 1440], night: [1080, 1440] }[query.part] || [0, 1440];
      slots = slots.filter((s) => { const m = s.start.getHours() * 60 + s.start.getMinutes(); const e = m + s.minutes; return e > lo && m < hi; });
    }
    const plannedMin = onDay(open, k).reduce((a, s) => a + s.minutes, 0);
    const label = `${dayWord(k, now)}${query.part ? ` ${query.part}` : ''}`;
    if (!slots.length) return { text: `${label[0].toUpperCase()}${label.slice(1)} is full${plannedMin ? `, with ${dur(plannedMin)} of planned work that could move` : ''}.` };
    return {
      text: `${label[0].toUpperCase()}${label.slice(1)} you are free ${slots.slice(0, 3).map((s) => `${clockOf(s.start)} to ${clockOf(s.end)}`).join(', and ')}.${plannedMin ? ` ${dur(plannedMin)} of work is planned that day.` : ''}`
    };
  }

  if (query.kind === 'when') {
    const t = state.tasks[query.taskId];
    if (!t) return { text: 'I could not find that one.' };
    const mine = open.filter((s) => s.taskId === t.id).sort((x, y) => new Date(x.start) - new Date(y.start));
    const due = t.due ? `due ${dayWord(dateKey(new Date(t.due)), now)} at ${clockOf(t.due)}` : 'no due date';
    if (!mine.length) return { text: `${t.title} is ${due}. Nothing is planned for it yet.` };
    return { text: `${t.title} is ${due}, about ${dur(t.estimateMin || 0)} in ${mine.length} block${mine.length === 1 ? '' : 's'}.`, list: mine.map((s) => `${dayWord(dateKey(new Date(s.start)), now)} ${clockOf(s.start)} (${dur(s.minutes)})`) };
  }

  if (query.kind === 'activities') {
    const list = (state.commitments || []).filter((c) => !c.archived).map((c) => {
      const p = weekProgress(c, state.checkins || [], now);
      return `${c.title}: ${p.done} of ${p.target} this week`;
    });
    return { text: list.length ? 'Here is where your activities stand this week.' : 'You have not added any activities yet.', list };
  }

  return { text: '' };
}

// --------------------------------------------------- a compact view of it

/** The plan as a small JSON document: what a model needs to reason about it. */
export function planView(state, now = new Date(), days = 7) {
  const today = dateKey(now);
  const until = dateKey(addDays(now, days));
  const sessions = openSessions(state).filter((s) => dateKey(new Date(s.start)) < until);
  const hm = (d) => `${pad(new Date(d).getHours())}:${pad(new Date(d).getMinutes())}`;
  const out = {
    now: `${today} ${hm(now)} (${now.toLocaleDateString('en-US', { weekday: 'long' })})`,
    school: { days: state.school.days, start: state.school.start, end: state.school.end, off: Object.keys(state.school.off || {}), early: state.school.early || {} },
    sleep: state.sleep,
    dayOverrides: state.dayOverrides || {},
    assignments: Object.values(state.tasks || {}).filter((t) => plannable(t, state)).map((t) => ({
      id: t.id, title: t.title, course: t.courseName || '', due: t.due ? `${dateKey(new Date(t.due))} ${hm(t.due)}` : null,
      minutes: t.estimateMin || null, overdue: !!t.due && +new Date(t.due) < +now
    })),
    activities: (state.commitments || []).filter((c) => !c.archived).map((c) => ({
      id: c.id, title: c.title,
      schedule: isFixed(c) ? { days: c.schedule.days, start: c.schedule.start, end: c.schedule.end } : { timesPerWeek: c.target.sessions, minutes: c.target.minutes },
      thisWeek: weekProgress(c, state.checkins || [], now).label
    })),
    events: allBusy(state).filter((b) => b.source !== 'skip' && dateKey(new Date(b.start)) >= today && dateKey(new Date(b.start)) < until)
      .sort((x, y) => new Date(x.start) - new Date(y.start))
      // Events that came from Google Calendar are passed on as a time with no
      // title: Cadence needs to plan around them, the model doesn't need to
      // know what they are.
      .map((b) => ({ id: b.id, title: ['google', 'googleFeed', 'outlookFeed', 'icloudFeed'].includes(b.source) ? 'Busy' : b.title, date: dateKey(new Date(b.start)), start: hm(b.start), end: hm(b.end) })).slice(0, 80),
    plannedWork: sessions.map((s) => ({ item: s.taskId || s.commitmentId, title: s.title, date: dateKey(new Date(s.start)), start: hm(s.start), minutes: s.minutes })),
    perDay: (state.plan?.days || []).filter((d) => d.date >= today && d.date < until).map((d) => ({ date: d.date, plannedMinutes: d.minutes, school: isSchoolDay(state, noon(d.date)) })),
    doesNotFit: (state.plan?.unplaced || []).map((u) => ({ title: u.title, minutes: u.missingMin, due: u.due || null }))
  };
  const memory = memoryView(state, now);
  if (memory) out.memory = memory;
  return out;
}

export { workWindows, isSchoolDay, schoolEnd, overrideFor };
