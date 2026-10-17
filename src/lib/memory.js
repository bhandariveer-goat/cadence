// What Cadence remembers about one student, and how the plan adapts to it.
//
// Two kinds of memory, kept apart because they are trusted differently:
//
//   told      things the student said, or the assistant saved when they said
//             them: free-form notes ("practice often runs late on Tuesdays")
//             and a few preferences the planner understands (block length is
//             a setting; earliest start and a class to do first live here).
//   noticed   patterns worked out from what they actually do: when they press
//             Start, how long a block lasts before they stop, which class
//             keeps getting moved later. Nothing is concluded from a few days.
//
// Everything the planner takes from either is a preference, never a rule. The
// scheduler (lib/scheduler.js) first plans with them, and if that leaves
// assigned work without room before it is due, plans without them. Starting
// at 7:30pm because you usually do is fine; missing a deadline because of it
// is not.
//
// It all lives in the plan (state.memory), so it stays in this browser and
// syncs to the account with everything else when the student signs in with an
// email. The assistant is sent the notes, the preferences and what has been
// noticed with every message (lib/agentops.js planView).

import { dateKey, addDays, startOfDay, uid, fmtClock } from './util.js';

export const EMPTY_MEMORY = { learn: true, notes: [], prefs: {}, seen: { starts: [], focus: [], pushes: [] }, ignore: {} };

const LIMITS = { notes: 40, noteChars: 160, starts: 60, focus: 60, pushes: 200, keepDays: 42 };
// How much evidence a pattern needs before it is used.
const NEED = { startDays: 5, lateShare: 0.6, lateBy: 20, focusBlocks: 6, pushes: 3, pushShare: 0.5, speedSamples: 2, speedGap: 0.15 };

const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };
const fromMin = (t) => { const m = ((Math.round(t) % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const hm = (d) => fromMin(new Date(d).getHours() * 60 + new Date(d).getMinutes());
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const isTime = (v) => /^\d{1,2}:\d{2}$/.test(String(v || ''));
export const courseKey = (name) => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** The memory record on a plan, created and filled out when missing. */
export function memoryOf(state) {
  const m = (state.memory ||= structuredClone(EMPTY_MEMORY));
  m.learn = m.learn !== false;
  m.notes = Array.isArray(m.notes) ? m.notes : [];
  m.prefs = m.prefs && typeof m.prefs === 'object' ? m.prefs : {};
  m.seen = m.seen && typeof m.seen === 'object' ? m.seen : {};
  for (const k of ['starts', 'focus', 'pushes']) m.seen[k] = Array.isArray(m.seen[k]) ? m.seen[k] : [];
  m.ignore = m.ignore && typeof m.ignore === 'object' ? m.ignore : {};
  return m;
}

// ------------------------------------------------------------------ notes

// Notes are sent to the assistant on every message, so nothing that looks
// like contact details or a secret is kept, whoever typed it.
const PRIVATE = /[\w.+-]+@[\w-]+\.[\w.]+|\b\d[\d\s().-]{7,}\d\b|https?:\/\/|\bpass(word|code)\b|\bsk-[a-z0-9]/i;

/**
 * Keep a note. Returns { note } or { error } with a reason a person can read.
 * A note that says the same as one already kept refreshes that one instead.
 */
export function addNote(state, text, by = 'you', now = new Date()) {
  const m = memoryOf(state);
  const clean = String(text || '').replace(/\s+/g, ' ').trim().replace(/^(remember( that)?|note( that)?)[:,]?\s+/i, '');
  if (clean.length < 3) return { error: 'That note is empty.' };
  if (clean.length > LIMITS.noteChars) return { error: `Keep a note under ${LIMITS.noteChars} characters.` };
  if (PRIVATE.test(clean)) return { error: 'Cadence does not keep contact details, links or passwords in its memory.' };
  const key = courseKey(clean).replace(/[.!]+$/, '');
  const same = m.notes.find((n) => { const k = courseKey(n.text).replace(/[.!]+$/, ''); return k === key || (key.length > 12 && (k.includes(key) || key.includes(k))); });
  if (same) {
    same.text = clean.length >= same.text.length ? clean : same.text;
    same.at = now.toISOString();
    return { note: same, refreshed: true };
  }
  const note = { id: uid('m'), text: clean, by: by === 'assistant' ? 'assistant' : 'you', at: now.toISOString() };
  m.notes.push(note);
  // The oldest go first when the list is full.
  if (m.notes.length > LIMITS.notes) m.notes.splice(0, m.notes.length - LIMITS.notes);
  return { note };
}

export function forgetNote(state, id) {
  const m = memoryOf(state);
  const before = m.notes.length;
  m.notes = m.notes.filter((n) => n.id !== id);
  return m.notes.length < before;
}

// ------------------------------------------------------------ preferences

/** Set or clear the preferences the planner understands. Returns what changed, as words. */
export function setPrefs(state, { startSchool, startFree, firstCourse, blockMin, clear = [] } = {}) {
  const m = memoryOf(state);
  const did = [];
  for (const k of clear) {
    if (k === 'block_minutes') {
      if (!state.settings.styleChosen) continue;
      Object.assign(state.settings, { sessionMaxMin: 45, breakMin: 10, sessionMinMin: 20 });
      delete state.settings.styleChosen;
      did.push('block length back to 45 minutes');
      continue;
    }
    const field = { school_day_start: 'startSchool', free_day_start: 'startFree', first_class: 'firstCourse' }[k];
    if (field && m.prefs[field] != null) { delete m.prefs[field]; did.push(`${k.replace(/_/g, ' ')} cleared`); }
  }
  if (isTime(startSchool)) { m.prefs.startSchool = fromMin(toMin(startSchool)); did.push(`school days start from ${fmtClock(m.prefs.startSchool)}`); }
  if (isTime(startFree)) { m.prefs.startFree = fromMin(toMin(startFree)); did.push(`days off start from ${fmtClock(m.prefs.startFree)}`); }
  if (typeof firstCourse === 'string' && firstCourse.trim()) { m.prefs.firstCourse = firstCourse.trim().slice(0, 60); did.push(`${m.prefs.firstCourse} first`); }
  if (Number.isFinite(blockMin) && blockMin > 0) {
    const max = Math.max(15, Math.min(90, Math.round(blockMin / 5) * 5));
    state.settings.sessionMaxMin = max;
    state.settings.breakMin = max <= 30 ? 5 : max <= 50 ? 10 : 15;
    state.settings.sessionMinMin = Math.min(20, max);
    state.settings.styleChosen = true;
    did.push(`${max}-minute blocks`);
  }
  return did;
}

// ----------------------------------------------------------- observations

const recent = (list, now) => {
  const from = dateKey(addDays(startOfDay(now), -LIMITS.keepDays));
  return list.filter((x) => x.date >= from);
};

/**
 * Record something the student did. Called by the screens where it happens.
 *   { type: 'start',  school, planned }          pressed Start on homework
 *   { type: 'focus',  planned, actual }          a timed block ended before the assignment did
 *   { type: 'push',   course }                   moved a homework block later
 *   { type: 'done',   course }                   finished a homework block
 * Does nothing while learning is switched off.
 */
export function observe(state, event, now = new Date()) {
  const m = memoryOf(state);
  if (!m.learn || !event) return;
  const date = dateKey(now);
  const s = m.seen;
  if (event.type === 'start') {
    // Only the first start of a day says when the evening began.
    if (s.starts.some((x) => x.date === date)) return;
    s.starts.push({ date, school: !!event.school, at: hm(now), planned: isTime(event.planned) ? event.planned : null });
  } else if (event.type === 'focus') {
    const planned = Math.round(event.planned), actual = Math.round(event.actual);
    if (!(planned >= 10) || !(actual >= 5) || actual > 240) return;
    s.focus.push({ date, planned, actual });
  } else if (event.type === 'push' || event.type === 'done') {
    const course = String(event.course || '').trim().slice(0, 60);
    if (!course) return;
    s.pushes.push({ date, course, kind: event.type });
  } else return;
  s.starts = recent(s.starts, now).slice(-LIMITS.starts);
  s.focus = recent(s.focus, now).slice(-LIMITS.focus);
  s.pushes = recent(s.pushes, now).slice(-LIMITS.pushes);
}

/** Forget every observation, and the learned speed per class with them. */
export function clearNoticed(state) {
  const m = memoryOf(state);
  m.seen = { starts: [], focus: [], pushes: [] };
  m.ignore = {};
  state.model = { biases: {}, globalFactor: 1 };
  state.logs = [];
}

// --------------------------------------------------------------- insights

const CATEGORY_WORDS = {
  reading: 'readings', problemset: 'problem sets', essay: 'writing assignments', lab: 'labs', project: 'projects',
  quiz: 'test prep', discussion: 'discussion posts', presentation: 'presentations', worksheet: 'worksheets', admin: 'small tasks'
};

/** When the student usually gets going, from days they started later than planned. */
function startPattern(starts, school) {
  const days = starts.filter((x) => x.school === school && x.planned);
  if (days.length < NEED.startDays) return null;
  const late = days.filter((x) => toMin(x.at) - toMin(x.planned) >= NEED.lateBy);
  if (late.length / days.length < NEED.lateShare) return null;
  // Rounded down to the quarter hour: a plan that starts a little before you
  // usually do is one you can still keep.
  const usual = Math.floor(median(days.map((x) => toMin(x.at))) / 15) * 15;
  if (usual < toMin('12:00') && school) return null;
  return fromMin(usual);
}

/**
 * Everything Cadence has worked out, for the memory screen and the assistant.
 * Each has an id (used to switch it off), the words for it, what it changes,
 * and whether it is in use. Patterns the student switched off are listed with
 * active false so they can be switched back on.
 */
export function insights(state, now = new Date()) {
  const m = memoryOf(state);
  const out = [];
  const add = (id, text, effect, value) => out.push({ id, text, effect, value, active: m.learn && !m.ignore[id] });
  const starts = recent(m.seen.starts, now);

  const school = startPattern(starts, true);
  if (school) add('start-school', `You usually start homework around ${fmtClock(school)} on school days.`, `Plans your first block from about ${fmtClock(school)} when the week has room.`, school);
  const free = startPattern(starts, false);
  if (free) add('start-free', `On days off you usually get going around ${fmtClock(free)}.`, `Plans days off from about ${fmtClock(free)} when the week has room.`, free);

  // Only real blocks count (a short end-of-day sliver says nothing), and
  // they are measured against the student's own block length, not against
  // the length Cadence planned: once the plan uses 30-minute blocks, a block
  // of 30 would otherwise look "on time" and the pattern would switch itself
  // off, flipping the plan between 30 and 45 every few days.
  const focus = recent(m.seen.focus, now).filter((x) => x.planned >= 20);
  if (focus.length >= NEED.focusBlocks) {
    const max = state.settings?.sessionMaxMin ?? 45;
    const typical = Math.round(median(focus.map((x) => x.actual)) / 5) * 5;
    const ratio = median(focus.map((x) => x.actual / max));
    if (ratio <= 0.8 && typical >= 20 && typical < max) {
      add('focus', `Your blocks usually last about ${typical} minutes before you stop.`, `Plans ${typical}-minute blocks${state.settings?.styleChosen ? ' (off while you have picked a block length yourself)' : ''}.`, typical);
    } else if (ratio >= 1.3 && typical > max) {
      const longer = Math.min(75, typical);
      add('focus', `You often keep going past the end of a block, to about ${typical} minutes.`, `Plans ${longer}-minute blocks${state.settings?.styleChosen ? ' (off while you have picked a block length yourself)' : ''}.`, longer);
    }
  }

  const byCourse = new Map();
  for (const p of m.seen.pushes.filter((x) => x.date >= dateKey(addDays(startOfDay(now), -28)))) {
    const k = courseKey(p.course);
    const e = byCourse.get(k) || { name: p.course, push: 0, done: 0 };
    e[p.kind === 'push' ? 'push' : 'done']++;
    byCourse.set(k, e);
  }
  for (const [k, e] of byCourse) {
    if (e.push >= NEED.pushes && e.push / (e.push + e.done) >= NEED.pushShare) {
      add(`push:${k}`, `${e.name} often gets moved later (${e.push} times in the last four weeks).`, `Starts ${e.name} earlier, so there is still room when it slips.`, e.name);
    }
  }

  // Speed per class, which the estimator has been learning all along.
  const names = new Map();
  for (const t of Object.values(state.tasks || {})) if (t.courseId && t.courseName) names.set(String(t.courseId), t.courseName);
  for (const [key, b] of Object.entries(state.model?.biases || {})) {
    const [courseId, category] = key.split('::');
    if (courseId === 'any' || !b || b.n < NEED.speedSamples || Math.abs(b.factor - 1) < NEED.speedGap) continue;
    const what = `${names.get(courseId) ? `${names.get(courseId)} ` : ''}${CATEGORY_WORDS[category] || 'assignments'}`;
    const pct = Math.round(Math.abs(b.factor - 1) * 100);
    const capital = what.charAt(0).toUpperCase() + what.slice(1);
    add(`speed:${key}`, b.factor > 1 ? `${capital} take you about ${pct}% longer than a typical estimate.` : `You finish ${what} about ${pct}% faster than a typical estimate.`,
      b.factor > 1 ? 'Plans more time for them.' : 'Plans less time for them.', key);
  }
  return out;
}

/** The estimator's model with any speed patterns the student switched off left out. */
export function modelFor(state) {
  const m = memoryOf(state);
  const model = state.model || { biases: {}, globalFactor: 1 };
  const off = Object.keys(m.ignore).filter((id) => id.startsWith('speed:')).map((id) => id.slice(6));
  if (m.learn && !off.length) return model;
  const biases = { ...(model.biases || {}) };
  if (!m.learn) for (const k of Object.keys(biases)) if (!k.startsWith('any::')) delete biases[k];
  for (const k of off) delete biases[k];
  return { ...model, biases };
}

/**
 * What the planner should prefer, from both kinds of memory. A preference the
 * student stated beats one that was noticed.
 * @returns {null|{start:(day:Date, school:boolean)=>string|null, early:Set<string>, first:string|null, blockMin:number|null, why:object}}
 */
export function planPrefs(state, now = new Date()) {
  const m = memoryOf(state);
  const active = new Map(insights(state, now).filter((i) => i.active).map((i) => [i.id, i]));
  const startSchool = m.prefs.startSchool || active.get('start-school')?.value || null;
  const startFree = m.prefs.startFree || active.get('start-free')?.value || null;
  const early = new Set([...active.keys()].filter((id) => id.startsWith('push:')).map((id) => id.slice(5)));
  const first = m.prefs.firstCourse ? courseKey(m.prefs.firstCourse) : null;
  const blockMin = !state.settings?.styleChosen ? active.get('focus')?.value || null : null;
  if (!startSchool && !startFree && !early.size && !first && !blockMin) return null;
  return {
    start: (_day, school) => (school ? startSchool : startFree),
    early, first, blockMin,
    why: {
      startSchool: startSchool ? (m.prefs.startSchool ? 'told' : 'noticed') : null,
      startFree: startFree ? (m.prefs.startFree ? 'told' : 'noticed') : null
    }
  };
}

/** Does a course name match one of the keys in a set or a single key? */
export function courseIn(name, keys) {
  const k = courseKey(name);
  if (!k) return false;
  const list = keys instanceof Set ? [...keys] : [keys];
  return list.some((x) => x && (k === x || k.includes(x) || (x.length >= 4 && x.includes(k))));
}

/** The compact form the assistant is sent with every message. */
export function memoryView(state, now = new Date()) {
  const m = memoryOf(state);
  const prefs = {};
  if (m.prefs.startSchool) prefs.school_day_start = m.prefs.startSchool;
  if (m.prefs.startFree) prefs.free_day_start = m.prefs.startFree;
  if (m.prefs.firstCourse) prefs.first_class = m.prefs.firstCourse;
  if (state.settings?.styleChosen) prefs.block_minutes = state.settings.sessionMaxMin;
  const noticed = insights(state, now).filter((i) => i.active).map((i) => `${i.text} ${i.effect}`);
  if (!m.notes.length && !Object.keys(prefs).length && !noticed.length) return null;
  return {
    notes: m.notes.map((n) => ({ id: n.id, text: n.text })),
    ...(Object.keys(prefs).length ? { preferences: prefs } : {}),
    ...(noticed.length ? { noticed } : {})
  };
}
