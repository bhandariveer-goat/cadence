// What a day looks like, worked out per date instead of asked for.
//
// Cadence used to open with two questions: when do you want to work, and how
// much a night. Both were the wrong thing to ask. Students don't know, the
// answers were the same for every Tuesday whether or not Tuesday had a meet,
// and a day off from school still started homework at 3:45 because that was
// the "after school" window.
//
// So free time is derived. A day runs from waking to bed. School takes its
// hours on school days and nothing on days off. Whatever the calendar holds is
// subtracted by the scheduler. How much work lands on a day comes from how
// much work there is (see buildPlan), not from a slider.
//
// One-off changes belong to a date: "no school Friday", "I'm tired, 90
// minutes tonight", "I can stay up till midnight". They are stored against
// that date and expire with it.

import { atTime, addDays, startOfDay, dateKey } from './util.js';

const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };
const fromMin = (t) => { const m = ((Math.round(t) % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const valid = (hhmm) => /^\d{1,2}:\d{2}$/.test(String(hhmm || ''));

// The few numbers this model rests on, in one place.
export const DAY = {
  settleAfterSchool: 20,   // minutes between the last bell and the first block
  wakeUpBuffer: 90,        // nobody starts an essay the minute they wake up
  earliestFreeDay: '09:30',
  windDown: 30,            // stop this long before bed
  // Daily load is levelled between these: light weeks sit at the floor,
  // heavy weeks rise only as far as the work requires.
  floorMin: 75,
  stepMin: 15,
  ceilingSchoolDay: 240,
  ceilingFreeDay: 360,
  freeDayFactor: 1.5       // a day with no school can carry this much more
};

export const overrideFor = (st, day) => st.dayOverrides?.[dateKey(day)] || null;

/** Is there school on this date? Weekday rule, minus the days marked off. */
export function isSchoolDay(st, day) {
  const sc = st.school || {};
  if (sc.off?.[dateKey(day)]) return false;
  return (sc.days || []).includes(new Date(day).getDay());
}

/** When school lets out on this date (an early-release day ends sooner). */
export function schoolEnd(st, day) {
  const early = st.school?.early?.[dateKey(day)];
  return valid(early) ? early : (st.school?.end || '15:30');
}

/**
 * The hours work may be planned into on one date.
 * @returns {{start:string,end:string}[]} local clock times; end may be past midnight
 */
export function workWindows(st, day) {
  const o = overrideFor(st, day) || {};
  if (o.off) return [];

  const sleep = st.sleep || { bed: '22:30', wake: '07:00' };
  let start;
  if (isSchoolDay(st, day)) start = fromMin(toMin(schoolEnd(st, day)) + DAY.settleAfterSchool);
  else start = fromMin(Math.max(toMin(sleep.wake) + DAY.wakeUpBuffer, toMin(DAY.earliestFreeDay)));

  // Bed past midnight is still "tonight": 00:30 means the window runs over.
  const bed = toMin(sleep.bed) < toMin('05:00') ? toMin(sleep.bed) + 1440 : toMin(sleep.bed);
  let end = fromMin(bed - DAY.windDown);

  if (valid(o.startAt)) start = o.startAt;
  if (valid(o.until)) end = o.until;
  // An end in the small hours belongs to tonight, not to this morning. And a
  // start at or after the end is no window at all: read as clock times it
  // would wrap round to most of tomorrow.
  const startMin = toMin(start);
  const endMin = toMin(end) <= toMin('05:00') ? toMin(end) + 1440 : toMin(end);
  if (endMin - startMin < 5) return [];
  return [{ start, end }];
}

/** The availability the scheduler asks for: a function of the date. */
export const dayWindows = (st) => (day) => workWindows(st, day);

/** How much a date can carry at the very most, before anything is levelled. */
export function dayCeiling(st, day) {
  const o = overrideFor(st, day);
  if (o?.off) return 0;
  if (Number.isFinite(o?.budgetMin)) return Math.max(0, o.budgetMin);
  const base = isSchoolDay(st, day) ? DAY.ceilingSchoolDay : DAY.ceilingFreeDay;
  const stated = st.settings?.maxDailyMin;
  return Number.isFinite(stated) && stated > 0 ? Math.min(base, stated) : base;
}

/**
 * The cap for one date at a given level. A stated budget for the day wins
 * outright: if she said ninety minutes tonight, tonight is ninety minutes.
 */
export function dayCap(st, day, level) {
  const o = overrideFor(st, day);
  if (o?.off) return 0;
  if (Number.isFinite(o?.budgetMin)) return Math.max(0, o.budgetMin);
  const scaled = isSchoolDay(st, day) ? level : Math.round(level * DAY.freeDayFactor);
  return Math.min(dayCeiling(st, day), scaled);
}

/** School itself, as calendar blocks, so the week view shows where the day goes. */
export function schoolBlocks(st, from = new Date(), days = 21) {
  const out = [];
  const sc = st.school || {};
  if (!valid(sc.start) || !valid(sc.end)) return out;
  for (let i = -1; i < days; i++) {
    const d = addDays(startOfDay(from), i);
    if (!isSchoolDay(st, d)) continue;
    const end = schoolEnd(st, d);
    if (toMin(end) <= toMin(sc.start)) continue;
    out.push({
      id: `school_${dateKey(d)}`,
      title: sc.early?.[dateKey(d)] ? 'School (out early)' : 'School',
      start: atTime(d, sc.start).toISOString(),
      end: atTime(d, end).toISOString(),
      source: 'school'
    });
  }
  return out;
}

/** Overrides and exceptions are for one date; drop them once it has passed. */
export function pruneDayModel(st, now = new Date()) {
  const today = dateKey(now);
  for (const bag of [st.dayOverrides, st.school?.off, st.school?.early]) {
    for (const k of Object.keys(bag || {})) if (k < today) delete bag[k];
  }
}
