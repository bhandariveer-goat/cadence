// Turn a prioritized task list + real free time into actual work sessions.
//
// Rules it enforces, which are the ones students actually break:
//   - nothing longer than one focused block (default 50 min) without a break
//   - a daily ceiling, so the plan is one she'd believe
//   - big assignments get spread across several days instead of one panic night
//   - everything lands before due-minus-buffer, never at 11:58pm
//
// The job is to *fit the work in*. When the preferred limits make that
// impossible, the scheduler bends them one at a time — pacing first, then the
// finish-early buffer, then the daily ceiling — and records which days it had
// to stretch. Only work with genuinely no free time left before it's due comes
// back as unplaced.

import { MIN, HOUR, DAY, addDays, dateKey, clamp, startOfDay } from './util.js';
import { freeSlots } from './calendar.js';
import { effectiveDeadline } from './priority.js';

/** Minutes left in a task's time-of-day window from `at` (Infinity when it has none). */
function windowLeft(win, at) {
  if (!win) return Infinity;
  const [sh, sm] = win.start.split(':').map(Number), [eh, em] = win.end.split(':').map(Number);
  const mins = at.getHours() * 60 + at.getMinutes();
  if (mins < sh * 60 + sm || mins >= eh * 60 + em) return 0;
  return eh * 60 + em - mins;
}

const uidCounter = (() => { let i = 0; return () => `s${Date.now().toString(36)}${(i++).toString(36)}`; })();

/**
 * @param {Array} tasks tasks with .estimateMin and .priority (from prioritize())
 * @returns {{generatedAt:string, sessions:Array, unplaced:Array, days:Array}}
 */
export function buildPlan(tasks, { availability, busy, settings, from = new Date() }) {
  const horizon = addDays(from, settings.lookaheadDays ?? 14);
  const slots = freeSlots(from, horizon, availability, busy, settings);

  const sessionMax = (settings.sessionMaxMin ?? 50);
  const sessionMin = (settings.sessionMinMin ?? 20);
  const breakMin = (settings.breakMin ?? 10);
  const dailyCap = (settings.dailyCapacityMin ?? 180);

  const open = tasks
    .filter((t) => t.status !== 'done' && (t.estimateMin || 0) > 0)
    .map((t) => {
      const deadline = t.priority?.deadline
        ? new Date(t.priority.deadline)
        : (t.due ? effectiveDeadline(new Date(t.due), t.estimateMin, { availability, busy, settings, now: from, noBuffer: t.noBuffer }) : horizon);
      const remaining = Math.max(0, (t.estimateMin || 0) - (t.loggedMin || 0));
      const daysLeft = Math.max(1, Math.ceil((+deadline - +from) / DAY));
      // Spread anything over ~90 minutes across multiple days.
      const idealDays = clamp(Math.ceil(remaining / 90), 1, Math.min(daysLeft, 5));
      return {
        task: t,
        deadline,
        remaining,
        perDayCap: Math.max(sessionMin, Math.ceil(remaining / idealDays / 5) * 5)
      };
    })
    .filter((t) => t.remaining > 0);

  const dayUsed = new Map();     // dateKey -> minutes booked
  const taskDayUsed = new Map(); // `${taskId}|${dateKey}` -> minutes
  const sessions = [];
  const stretchDays = new Set();  // days pushed past the daily ceiling to fit everything
  // Free pieces get consumed as we book into them; `start` is the running edge.
  const pieces = slots.map((s) => ({ start: new Date(s.start), end: new Date(s.end) }));

  /**
   * Fill the remaining free pieces.
   * @param {object} o
   * @param {boolean} o.relax drop the "spread it over several days" pacing cap
   * @param {number}  o.cap   daily minutes allowed on this pass
   */
  function fill({ relax = false, cap = dailyCap } = {}) {
    for (const piece of pieces) {
      let cursor = new Date(piece.start);
      const slotEnd = piece.end;

      while (slotEnd - cursor >= sessionMin * MIN) {
        const key = dateKey(cursor);
        const capLeft = cap - (dayUsed.get(key) || 0);
        if (capLeft < sessionMin) break;

        const candidates = open
          .filter((c) => c.remaining > 0)
          .filter((c) => +c.deadline > +cursor)
          .filter((c) => !c.task.notBefore || +cursor >= +new Date(c.task.notBefore))
          .filter((c) => windowLeft(c.task.window, cursor) >= Math.min(sessionMin, c.remaining))
          .filter((c) => {
            if (relax) return true;
            const used = taskDayUsed.get(`${c.task.id}|${key}`) || 0;
            return c.perDayCap - used >= Math.min(sessionMin, c.remaining);
          })
          // Earliest deadline first keeps the plan feasible; priority score
          // settles ties (and lifts pinned / at-risk work).
          .sort((a, b) => (+a.deadline - +b.deadline)
            || ((b.task.priority?.score ?? 0) - (a.task.priority?.score ?? 0)));

        const pick = candidates[0];
        if (!pick) break;

        const taskLeftToday = relax
          ? Infinity
          : pick.perDayCap - (taskDayUsed.get(`${pick.task.id}|${key}`) || 0);
        const hardMax = Math.floor(Math.min(
          capLeft,
          windowLeft(pick.task.window, cursor),
          Math.floor((slotEnd - cursor) / MIN),
          Math.floor((+pick.deadline - +cursor) / MIN)
        ) / 5) * 5;
        let minutes = Math.floor(Math.min(sessionMax, pick.remaining, taskLeftToday, hardMax) / 5) * 5;
        if (minutes < Math.min(sessionMin, pick.remaining)) break;

        // Don't leave a 5-minute orphan block behind: either swallow the tail
        // now, or shorten this block so the tail is worth sitting down for.
        const tail = pick.remaining - minutes;
        if (tail > 0 && tail < sessionMin) {
          if (pick.remaining <= Math.min(hardMax, sessionMax + sessionMin)) minutes = pick.remaining;
          else if (minutes - (sessionMin - tail) >= sessionMin) minutes -= sessionMin - tail;
        }

        const start = new Date(cursor);
        const end = new Date(+cursor + minutes * MIN);
        sessions.push({
          id: uidCounter(),
          taskId: pick.task.id,
          title: pick.task.title,
          courseName: pick.task.courseName || '',
          courseId: pick.task.courseId || null,
          commitmentId: pick.task.commitmentId || null,
          color: pick.task.color || null,
          category: pick.task.category,
          start: start.toISOString(),
          end: end.toISOString(),
          minutes,
          done: false
        });

        pick.remaining -= minutes;
        dayUsed.set(key, (dayUsed.get(key) || 0) + minutes);
        if (dayUsed.get(key) > dailyCap) stretchDays.add(key);
        taskDayUsed.set(`${pick.task.id}|${key}`, (taskDayUsed.get(`${pick.task.id}|${key}`) || 0) + minutes);
        cursor = new Date(+end + breakMin * MIN);
      }
      piece.start = cursor;                      // whatever is left of this window
    }
  }

  const leftover = () => open.some((c) => c.remaining > 0);

  fill();
  // Pacing is a preference; deadlines aren't.
  if (leftover()) fill({ relax: true });
  // Give up the finish-early buffer before anything else.
  if (leftover()) {
    for (const c of open) {
      if (c.remaining > 0 && c.task.due && +new Date(c.task.due) > +c.deadline) c.deadline = new Date(c.task.due);
    }
    fill({ relax: true });
  }
  // Then let busy days run longer — a fuller Thursday beats a missed assignment.
  if (leftover()) fill({ relax: true, cap: Math.round(dailyCap * 1.5) });
  if (leftover()) fill({ relax: true, cap: Infinity });
  sessions.sort((a, b) => new Date(a.start) - new Date(b.start));

  numberParts(sessions);

  const unplaced = open
    .filter((c) => c.remaining > 0)
    .map((c) => ({
      taskId: c.task.id,
      title: c.task.title,
      courseName: c.task.courseName,
      due: c.task.due,
      missingMin: c.remaining
    }));

  return {
    generatedAt: new Date().toISOString(),
    sessions,
    unplaced,
    stretchDays: [...stretchDays],
    days: summarizeDays(sessions, from, horizon)
  };
}

/** "Part 2 of 4" — numbered across a task's whole history, not just new blocks. */
function numberParts(sessions) {
  const counts = {};
  sessions.forEach((s) => { counts[s.taskId] = (counts[s.taskId] || 0) + 1; });
  const seen = {};
  sessions.forEach((s) => {
    seen[s.taskId] = (seen[s.taskId] || 0) + 1;
    s.part = seen[s.taskId];
    s.parts = counts[s.taskId];
  });
}

export function summarizeDays(sessions, from, to) {
  const byDay = new Map();
  for (let d = startOfDay(from); d <= to; d = addDays(d, 1)) byDay.set(dateKey(d), { date: dateKey(d), minutes: 0, sessions: [] });
  for (const s of sessions) {
    const k = dateKey(new Date(s.start));
    if (!byDay.has(k)) byDay.set(k, { date: k, minutes: 0, sessions: [] });
    const d = byDay.get(k);
    d.minutes += s.minutes;
    d.sessions.push(s);
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Re-plan after something changed (finished early, skipped a block, a new
 * assignment dropped). Finished blocks from the last week and any block that's
 * running right now are kept as-is: their minutes count as progress, and a
 * running block's time is held so nothing gets booked on top of it.
 */
export function replan(state, prioritized, busy = state.busy) {
  const weekAgo = addDays(startOfDay(new Date()), -7);
  const kept = (state.plan?.sessions || []).filter((s) => (state.tasks[s.taskId] || s.commitmentId)
    && ((s.done && new Date(s.start) >= weekAgo) || (s.startedAt && !s.done)));

  const progress = {};
  for (const s of kept) progress[s.taskId] = (progress[s.taskId] || 0) + s.minutes;
  const withProgress = prioritized.map((t) => ({ ...t, loggedMin: progress[t.id] || 0 }));

  const running = kept.filter((s) => !s.done).map((s) => ({
    start: s.startedAt,
    end: new Date(+new Date(s.startedAt) + s.minutes * MIN).toISOString()
  }));

  const plan = buildPlan(withProgress, {
    availability: state.availability,
    busy: [...busy, ...running],
    settings: state.settings
  });
  plan.sessions = [...kept, ...plan.sessions].sort((a, b) => new Date(a.start) - new Date(b.start));
  numberParts(plan.sessions);
  plan.days = summarizeDays(plan.sessions, new Date(), addDays(new Date(), state.settings.lookaheadDays ?? 14));
  return plan;
}
