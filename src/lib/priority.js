// What should I do first, and when do I have to start?
//
// The interesting number isn't "days until due" — it's the *start-by* date:
// the last moment she can begin and still finish, given the free time she
// actually has between now and the deadline. Two assignments due Friday are
// not equally urgent if one takes 20 minutes and the other takes six hours.

import { DAY, HOUR, clamp, addDays, startOfDay } from './util.js';
import { freeMinutesBetween } from './calendar.js';

/**
 * Walk backward from the deadline until we've banked enough free time.
 * @returns {Date|null} the latest safe start, or null if it no longer fits.
 */
export function startByDate(estimateMin, deadline, availability, busy, settings) {
  const need = estimateMin * 1.15;              // 15% cushion for real life
  let cursor = new Date(deadline);
  for (let i = 0; i < 60; i++) {
    const prev = startOfDay(addDays(cursor, -1));
    const banked = freeMinutesBetween(prev, deadline, availability, busy, settings);
    if (banked >= need) {
      // Refine within the day: how far into that day can she start?
      const dayFree = freeMinutesBetween(prev, cursor, availability, busy, settings);
      const stillNeeded = need - freeMinutesBetween(cursor, deadline, availability, busy, settings);
      const frac = dayFree > 0 ? clamp(1 - stillNeeded / dayFree, 0, 1) : 0;
      return new Date(+prev + frac * (+cursor - +prev));
    }
    cursor = prev;
    if (+cursor < Date.now() - 30 * DAY) break;
  }
  return null;                                   // doesn't fit — flagged as at-risk
}

/**
 * The date the work actually has to be finished by.
 *
 * The "finish early" buffer is a preference, not a constraint. Applied blindly
 * it declares anything due tonight impossible, which is both wrong and useless.
 * So: aim for due-minus-buffer, but give the buffer up when that's the only way
 * the work fits. Anything already late gets a fresh two-day runway instead of
 * being written off entirely.
 */

/** Past-due by more than this and we assume it no longer needs submitting. */
export const STALE_AFTER_DAYS = 30;

export function isStale(task, now = Date.now()) {
  return !!task.due && +new Date(task.due) < +now - STALE_AFTER_DAYS * DAY;
}
export function effectiveDeadline(due, estimateMin, ctx = {}) {
  const { availability, busy, settings = {}, now = new Date(), noBuffer = false } = ctx;
  // Practice sessions belong to their day — no "finish the night before".
  if (noBuffer) return new Date(Math.max(+due, +now));
  // Late work gets a calm week-long runway, behind anything still on time.
  if (+due < +now) return new Date(+now + 7 * DAY);

  const buffered = new Date(+due - (settings.bufferHours ?? 12) * HOUR);
  if (+buffered <= +now) return new Date(due);
  if (!availability) return buffered;

  const room = freeMinutesBetween(now, buffered, availability, busy, settings);
  return room >= (estimateMin || 0) * 1.05 ? buffered : new Date(due);
}

/**
 * Score one task. Higher = do it sooner.
 * @returns {{score:number, startBy:Date|null, deadline:Date, slack:number,
 *            feasible:boolean, reason:string, band:'now'|'soon'|'later'}}
 */
export function scoreTask(task, ctx) {
  const { availability, busy, settings, maxPoints = 100 } = ctx;
  const now = new Date();
  const est = task.estimateMin || 30;

  if (!task.due) {
    return {
      score: 0.25 + (task.pinned ? 0.5 : 0),
      startBy: null, deadline: null, slack: Infinity, feasible: true,
      reason: 'No deadline — fits wherever there is room', band: 'later'
    };
  }

  const due = new Date(task.due);
  const deadline = effectiveDeadline(due, est, { availability, busy, settings, now, noBuffer: task.noBuffer });
  const startBy = startByDate(est, deadline, availability, busy, settings);
  const available = freeMinutesBetween(now, deadline, availability, busy, settings);
  const slack = available - est;                 // spare minutes after doing it
  const feasible = available >= est * 1.05;

  // 1. Urgency — driven by start-by, not due date.
  let urgency;
  if (!startBy || +startBy <= +now) urgency = 1;
  else urgency = clamp(1 - (+startBy - +now) / (4 * DAY), 0.05, 0.98);
  const late = +due < +now;
  if (late) urgency = 0.7;                       // matters, but not ahead of work still on time

  // 2. Grade impact.
  const impact = clamp((task.points ?? 10) / Math.max(maxPoints, 20), 0.05, 1);

  // 3. Effort risk — big things need to start earlier and get partial credit
  //    in the ranking so they don't lose to a pile of 10-minute tasks.
  const effort = clamp(est / 240, 0.05, 1);

  // 4. Tightness — if slack is thin, bump it hard.
  const tight = feasible ? clamp(1 - slack / Math.max(est * 3, 120), 0, 1) : 1;

  let score = 0.42 * urgency + 0.20 * impact + 0.16 * effort + 0.22 * tight;
  if (task.pinned) score += 0.25;
  if (task.status === 'in_progress') score += 0.06;
  score = clamp(score, 0, 1.5);

  let reason;
  if (late) reason = 'Past due — worth catching up on this week';
  else if (!feasible) reason = 'A tight one — Cadence is making extra room for it';
  else if (!startBy || +startBy <= +now) reason = 'Best to start today';
  else if (+startBy < +addDays(now, 1)) reason = 'Start by tomorrow and it stays easy';
  else reason = `No rush — starting ${startBy.toLocaleDateString([], { weekday: 'long' })} is plenty`;

  const band = late ? 'catchup' : (!feasible || urgency > 0.85) ? 'now' : urgency > 0.5 ? 'soon' : 'later';
  return { score, startBy, deadline, slack, feasible, reason, band };
}

/** Score + sort a whole list. Returns tasks with a `.priority` field attached. */
export function prioritize(tasks, ctx) {
  const maxPoints = Math.max(20, ...tasks.map((t) => t.points || 0));
  return tasks
    .map((t) => ({ ...t, priority: scoreTask(t, { ...ctx, maxPoints }) }))
    .sort((a, b) => {
      if (b.priority.score !== a.priority.score) return b.priority.score - a.priority.score;
      return (a.due ? +new Date(a.due) : Infinity) - (b.due ? +new Date(b.due) : Infinity);
    });
}
