// Turn a prioritized task list + real free time into actual work sessions.
//
// Rules it enforces, which are the ones students actually break:
//   - nothing longer than one focused block (default 45 min) without a break
//   - big assignments get spread across several days instead of one panic night
//   - everything lands before due-minus-buffer, never at 11:58pm
//   - no more than two blocks of the same thing in a row
//
// How much goes on each day is not a setting. The planner tries the lightest
// daily load first and raises it one step at a time until everything fits
// before it is due, so a light week stays light and a heavy week is only as
// heavy as the work makes it. A day the student has put a number on ("ninety
// minutes tonight") keeps that number and the rest of the week absorbs the
// difference.
//
// Everything gets a place. When the levels run out, days go past their limit
// (stretchDays), then past a number the student set, and as a last resort
// work is booked after its due date (late) rather than left out. The plan
// says which days were stretched and what will be late; the student decides
// what to drop or move. Only work with no free time anywhere in the next two
// weeks comes back as unplaced.

import { MIN, HOUR, DAY, addDays, dateKey, clamp, startOfDay } from './util.js';
import { freeSlots } from './calendar.js';
import { effectiveDeadline } from './priority.js';
import { dayWindows, workWindows, isSchoolDay, dayCap, overrideFor, DAY as DAYMODEL } from './daymodel.js';
import { planPrefs, courseIn } from './memory.js';

/** Minutes left in a task's time-of-day window from `at` (Infinity when it has none). */
function windowLeft(win, at) {
  if (!win) return Infinity;
  const [sh, sm] = win.start.split(':').map(Number), [eh, em] = win.end.split(':').map(Number);
  const mins = at.getHours() * 60 + at.getMinutes();
  if (mins < sh * 60 + sm || mins >= eh * 60 + em) return 0;
  return eh * 60 + em - mins;
}

const LONG_BREAK = 30;   // minutes off after two blocks of the same thing

const uidCounter = (() => { let i = 0; return () => `s${Date.now().toString(36)}${(i++).toString(36)}`; })();

/**
 * @param {Array} tasks tasks with .estimateMin and .priority (from prioritize())
 * @param {object} ctx
 * @param {Function|object} ctx.availability  free windows per date (lib/daymodel.js)
 * @param {Function} [ctx.capFor]  (date, level) -> minutes that date may carry
 * @param {number[]} [ctx.levels]  daily-load levels to try, lightest first
 * @param {object}   [ctx.spent]   dateKey -> minutes already worked that day
 * @param {Function} [ctx.firmDay] (date) -> true when the student set that day's load herself
 * @param {object}   [ctx.prefer]  what this student prefers (lib/memory.js planPrefs): classes
 *                                 to start earlier because they tend to slip, and a class to do first
 * @returns {{generatedAt:string, sessions:Array, unplaced:Array, days:Array, level:number, fits:boolean}}
 */
export function buildPlan(tasks, { availability, busy, settings, from = new Date(), capFor = null, levels = null, spent = {}, firmDay = null, prefer = null }) {
  const horizon = addDays(from, settings.lookaheadDays ?? 14);
  const slots = freeSlots(from, horizon, availability, busy, settings);

  const sessionMax = (settings.sessionMaxMin ?? 50);
  const sessionMin = (settings.sessionMinMin ?? 20);
  const breakMin = (settings.breakMin ?? 10);
  const fixedCap = (settings.dailyCapacityMin ?? 180);
  // The first moment each day has room, so pacing can ask "how many days after
  // this one could still take some of this before it is due?"
  const dayOpens = new Map();
  for (const sl of slots) { const k = dateKey(sl.start); if (!dayOpens.has(k)) dayOpens.set(k, +sl.start); }
  const laterDays = (key, deadline) => {
    let n = 0;
    for (const [k, opens] of dayOpens) if (k > key && opens + sessionMin * MIN <= +deadline) n++;
    return n;
  };

  const tryLevels = levels?.length ? levels : [fixedCap];
  const capAt = capFor || ((day, level) => level);
  const firm = (day) => !!firmDay?.(new Date(day));

  const candidatesFor = () => tasks
    .filter((t) => t.status !== 'done' && (t.estimateMin || 0) > 0)
    .map((t) => {
      let deadline = t.priority?.deadline
        ? new Date(t.priority.deadline)
        : (t.due ? effectiveDeadline(new Date(t.due), t.estimateMin, { availability, busy, settings, now: from, noBuffer: t.noBuffer }) : horizon);
      // A class that keeps getting moved later is aimed a day early (or half
      // the time left, when that is less), so there is still room when it slips.
      if (prefer?.early?.size && !t.commitmentId && courseIn(t.courseName, prefer.early) && +deadline > +from) {
        deadline = new Date(+deadline - Math.min(DAY, (+deadline - +from) / 2));
      }
      const remaining = Math.max(0, (t.estimateMin || 0) - (t.loggedMin || 0));
      const daysLeft = Math.max(1, Math.ceil((+deadline - +from) / DAY));
      // Overdue work gets a runway to land on (effectiveDeadline), which would
      // otherwise sort it behind everything due this week. It goes first.
      const overdue = !!t.due && +new Date(t.due) < +from;
      // Spread anything over ~90 minutes across multiple days.
      const idealDays = clamp(Math.ceil(remaining / 90), 1, Math.min(daysLeft, 5));
      return {
        task: t,
        deadline,
        overdue,
        remaining,
        perDayCap: Math.max(sessionMin, Math.ceil(remaining / idealDays / 5) * 5)
      };
    })
    .filter((t) => t.remaining > 0);

  /**
   * One complete attempt at a given daily-load level. Each attempt starts from
   * nothing, so trying a lighter level first never taints a heavier one.
   */
  function attempt(level) {
    const open = candidatesFor();
    const dayUsed = new Map(Object.entries(spent || {}));   // dateKey -> minutes booked
    const taskDayUsed = new Map();                          // `${taskId}|${dateKey}` -> minutes
    const sessions = [];
    const crammed = new Set();                              // days pushed past their cap for a deadline
    const caps = new Map();
    // Free pieces get consumed as we book into them; `start` is the running edge.
    const pieces = slots.map((s) => ({ start: new Date(s.start), end: new Date(s.end) }));

    const capOf = (at) => {
      const key = dateKey(at);
      if (!caps.has(key)) caps.set(key, Math.max(0, Math.round(capAt(new Date(at), level))));
      return caps.get(key);
    };
    // Even when pacing is relaxed, one assignment shouldn't eat a whole evening.
    const dayLimit = (c, relax) => (relax ? Math.max(c.perDayCap * 2, sessionMax) : c.perDayCap);
    // Due before the next evening comes round: tonight is the last chance.
    const lastChance = (c, at) => !c.overdue && !c.task.commitmentId && !!c.task.due && +new Date(c.task.due) - +at < 20 * HOUR;
    /**
     * How much of a task today may take. Normally its paced share. But pacing
     * is only kind when there are later days to pace into: if the days left
     * before the deadline can't absorb the rest at that pace, today takes the
     * difference, before something due later fills the evening instead.
     */
    const roomToday = (c, key, relax) => {
      const share = dayLimit(c, relax);
      const paced = share - (taskDayUsed.get(`${c.task.id}|${key}`) || 0);
      const must = c.remaining - share * laterDays(key, c.deadline);
      return Math.max(paced, must);
    };

    /** The run of same-task blocks that ends just before `at`, if any. */
    function trailingRun(at) {
      const near = (a, b) => +b - +a >= 0 && +b - +a <= (breakMin + 2) * MIN;
      const before = sessions.filter((x) => +new Date(x.end) <= +at).sort((a, b) => new Date(b.end) - new Date(a.end));
      if (!before.length || !near(new Date(before[0].end), at)) return { runTask: null, run: 0 };
      let run = 1;
      for (let i = 1; i < before.length; i++) {
        if (before[i].taskId !== before[0].taskId || !near(new Date(before[i].end), new Date(before[i - 1].start))) break;
        run++;
      }
      return { runTask: before[0].taskId, run };
    }

    /**
     * Fill the remaining free pieces.
     * @param {boolean} o.relax      drop the "spread it over several days" pacing cap
     * @param {false|'due'|'all'} o.cram  ignore the day's levelled cap: for work due within two days, or for everything
     * @param {boolean} o.force      also ignore a number the student set on a day, and pacing
     */
    function fill({ relax = false, cram = false, force = false } = {}) {
      for (const piece of pieces) {
        let cursor = new Date(piece.start);
        const slotEnd = piece.end;
        // Three blocks of the same thing in a row is where a plan starts to feel
        // like a punishment, so after two we switch if anything else can go here.
        // An earlier pass may already have booked right up to this point.
        let { runTask, run } = trailingRun(cursor);

        while (slotEnd - cursor >= Math.min(sessionMin, 10) * MIN) {
          const key = dateKey(cursor);
          // Cramming ignores the levelled cap, never a number the student put
          // on the day herself: ninety minutes tonight stays ninety minutes.
          const cap = cram && (force || !firm(cursor)) ? Infinity : capOf(cursor);
          const capLeft = cap - (dayUsed.get(key) || 0);
          // A short stated budget ("twenty minutes tonight") still gets a block.
          const smallest = Math.min(sessionMin, Math.max(10, Number.isFinite(cap) ? cap : sessionMin));
          if (capLeft < smallest) break;

          const candidates = open
            .filter((c) => c.remaining > 0)
            .filter((c) => +c.deadline > +cursor)
            .filter((c) => !c.task.notBefore || +cursor >= +new Date(c.task.notBefore))
            .filter((c) => cram !== 'due' || (!c.task.commitmentId && c.task.due && +new Date(c.task.due) - +cursor < 2 * DAY))
            .filter((c) => windowLeft(c.task.window, cursor) >= Math.min(smallest, c.remaining))
            // Any allotment left for this task today is enough to try: a
            // 60-minute share is one 45-minute block plus 15, and refusing the
            // 15 because it is under the minimum block length made paced work
            // come up short by exactly that remainder every day.
            .filter((c) => force || roomToday(c, key, relax) > 0)
            // What can only still be on time if it happens now goes first,
            // then anything already late, then earliest deadline. Late work
            // ahead of everything sounds right until it takes the last free
            // hour from something due at 8am tomorrow.
            .sort((a, b) => (Number(lastChance(b, cursor)) - Number(lastChance(a, cursor)))
              || (Number(b.overdue) - Number(a.overdue))
              // "Math first": among things due the same day, that class leads.
              || (prefer?.first ? dateKey(a.deadline).localeCompare(dateKey(b.deadline))
                || (Number(courseIn(b.task.courseName, prefer.first)) - Number(courseIn(a.task.courseName, prefer.first))) : 0)
              || (+a.deadline - +b.deadline)
              || ((b.task.priority?.score ?? 0) - (a.task.priority?.score ?? 0)));

          if (!candidates.length) {
            // Nothing can start yet, but something may once its time of day
            // begins ("evenings" from 5pm on a free afternoon): wait for that
            // instead of giving up the rest of this free time.
            const next = open
              .filter((c) => c.remaining > 0 && c.task.window && +c.deadline > +cursor)
              .filter((c) => !c.task.notBefore || +cursor >= +new Date(c.task.notBefore))
              .filter((c) => cram !== 'due' || (!c.task.commitmentId && c.task.due && +new Date(c.task.due) - +cursor < 2 * DAY))
              .filter((c) => force || roomToday(c, key, relax) > 0)
              .map((c) => { const [h, m] = c.task.window.start.split(':').map(Number); const at = new Date(cursor); at.setHours(h, m, 0, 0); return at; })
              .filter((at) => +at > +cursor && +slotEnd - +at >= Math.min(sessionMin, 10) * MIN)
              .sort((x, y) => x - y)[0];
            if (next) { cursor = next; run = 0; continue; }
            break;
          }
          const switched = run >= 2 ? candidates.filter((c) => c.task.id !== runTask) : candidates;
          if (!switched.length) {
            // Nothing else can go here. Rather than a third block of the same
            // thing straight away, leave a proper break and carry on after it.
            cursor = new Date(+cursor + Math.max(0, LONG_BREAK - breakMin) * MIN);
            run = 0;
            continue;
          }
          // The first candidate that can take a real block here. The top one
          // may not be able to (its deadline is minutes away, or it has three
          // minutes left), and that must not stop everything behind it from
          // using the rest of this free time.
          let pick = null, minutes = 0, hardMax = 0;
          for (const c of switched) {
            const taskLeftToday = force ? c.remaining : Math.max(roomToday(c, key, relax), Math.min(smallest, c.remaining));
            const most = Math.floor(Math.min(
              capLeft,
              windowLeft(c.task.window, cursor),
              Math.floor((slotEnd - cursor) / MIN),
              Math.floor((+c.deadline - +cursor) / MIN)
            ) / 5) * 5;
            const m = Math.floor(Math.min(sessionMax, c.remaining, taskLeftToday, most) / 5) * 5;
            if (m > 0 && m >= Math.min(smallest, c.remaining)) { pick = c; minutes = m; hardMax = most; break; }
          }
          if (!pick) {
            // Only the task that just had two blocks fits: break, then go on.
            if (run >= 2 && switched.length < candidates.length) {
              cursor = new Date(+cursor + Math.max(5, LONG_BREAK - breakMin) * MIN);
              run = 0;
              continue;
            }
            break;
          }

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
          if (cram) crammed.add(key);
          taskDayUsed.set(`${pick.task.id}|${key}`, (taskDayUsed.get(`${pick.task.id}|${key}`) || 0) + minutes);
          run = pick.task.id === runTask ? run + 1 : 1;
          runTask = pick.task.id;
          cursor = new Date(+end + breakMin * MIN);
        }
        piece.start = cursor;                      // whatever is left of this window
      }
    }

    const left = (pick) => open.reduce((a, c) => a + (c.remaining >= 10 && pick(c) ? c.remaining : 0), 0);
    const leftover = () => left(() => true);
    // Work somebody else set a deadline for, as opposed to practice she chose.
    const leftAssigned = () => left((c) => !c.task.commitmentId);

    fill();
    // Pacing is a preference; deadlines aren't.
    if (leftover()) fill({ relax: true });
    // Give up the finish-early buffer before asking for a heavier day.
    if (leftover()) {
      for (const c of open) {
        if (c.remaining > 0 && c.task.due && +new Date(c.task.due) > +c.deadline) c.deadline = new Date(c.task.due);
      }
      fill({ relax: true });
    }
    return { level, open, sessions, crammed, caps, capOf, fill, leftover, leftAssigned };
  }

  // How heavy each day is comes from how much work there is. Try the lightest
  // level first and stop at the first one where the assigned work lands before
  // it is due: a light week stays light, and a heavy one rises only as far as
  // needed. Practice she chose for herself may lift the level a little further,
  // but only when that makes everything fit: sessions pinned to a full day
  // can't be fixed by making every other day heavier.
  const PRACTICE_HEADROOM = 30;
  let best = null;
  let fitAt = null;
  const trace = [];
  for (const level of tryLevels) {
    if (fitAt != null && level > fitAt + PRACTICE_HEADROOM) break;
    const a = attempt(level);
    trace.push({ level, assigned: a.leftAssigned(), all: a.leftover(), stuck: a.open.filter((c) => c.remaining >= 10 && !c.task.commitmentId).map((c) => `${c.task.title}:${c.remaining}`) });
    if (fitAt == null) {
      if (!best || a.leftAssigned() < best.leftAssigned()) best = a;
      if (!a.leftAssigned()) fitAt = level;
    } else if (!a.leftover()) {
      best = a;
    }
    if (!best.leftover()) break;
  }
  // Past the top level, nothing is left out. Work due in the next two days
  // goes first, then everything else past the day's limit, then past a number
  // the student set, and last of all after its due date. The student sees
  // which days were stretched and what will be late, and decides from there.
  if (best.leftAssigned()) best.fill({ relax: true, cram: 'due' });
  if (best.leftover()) best.fill({ relax: true, cram: 'all' });
  if (best.leftover()) best.fill({ relax: true, cram: 'all', force: true });
  if (best.leftover()) {
    for (const c of best.open) if (c.remaining > 0) c.deadline = horizon;
    best.fill({ relax: true, cram: 'all', force: true });
  }

  const { open, sessions, crammed } = best;
  sessions.sort((a, b) => new Date(a.start) - new Date(b.start));
  numberParts(sessions);

  // One row per thing, not per session: a commitment with three unplaced
  // sessions was listing its name three times.
  const byTask = new Map();
  for (const c of open) {
    // Estimates are approximate; a five-minute remainder isn't something to
    // put a warning card on someone's week for.
    if (c.remaining < 10) continue;
    const key = c.task.commitmentId || c.task.id;
    const prev = byTask.get(key);
    if (prev) { prev.missingMin += c.remaining; prev.sessions += 1; continue; }
    byTask.set(key, {
      taskId: c.task.id,
      commitmentId: c.task.commitmentId || null,
      title: c.task.title,
      courseName: c.task.courseName,
      due: c.task.due,
      missingMin: c.remaining,
      sessions: 1
    });
  }
  const unplaced = [...byTask.values()];

  // What will be finished after it is due, by how much: shown to the student.
  const late = [];
  for (const c of open) {
    // Work that was already late before this plan is under Catch up, not here.
    if (c.task.commitmentId || !c.task.due || +new Date(c.task.due) < +from) continue;
    const mine = sessions.filter((x) => x.taskId === c.task.id);
    const last = mine.reduce((m, x) => Math.max(m, +new Date(x.end)), 0);
    const after = mine.filter((x) => +new Date(x.end) > +new Date(c.task.due)).reduce((m, x) => m + x.minutes, 0);
    if (last > +new Date(c.task.due)) late.push({ taskId: c.task.id, commitmentId: null, title: c.task.title, courseName: c.task.courseName, due: c.task.due, finishes: new Date(last).toISOString(), missingMin: after, late: true });
  }

  const days = summarizeDays(sessions, from, horizon);
  for (const d of days) d.cap = best.capOf(new Date(`${d.date}T12:00:00`));

  return {
    generatedAt: new Date().toISOString(),
    sessions,
    unplaced,
    level: best.level,
    trace,
    fits: !unplaced.length && !late.length,
    late,
    stretchDays: [...crammed],
    days
  };
}

/**
 * Free time per date with a preferred start applied: "you usually start at
 * 7:30pm" moves the start of the window, never past a start the student set
 * for that day themselves, and never so late that less than an hour is left.
 */
function preferredWindows(state, prefer) {
  const base = dayWindows(state);
  return (day) => {
    const wins = base(day);
    const want = prefer.start?.(day, isSchoolDay(state, day));
    if (!wins.length || !want || overrideFor(state, day)?.startAt) return wins;
    const toM = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };
    const w = wins[0];
    const end = toM(w.end) <= toM('05:00') ? toM(w.end) + 1440 : toM(w.end);
    if (toM(want) <= toM(w.start) || toM(want) + 60 > end) return wins;
    return [{ start: want, end: w.end }, ...wins.slice(1)];
  };
}

/** The dates in the next two weeks whose start moved, and why, for the Today screen. */
function adaptedDays(state, prefer, now) {
  const start = {};
  const shifted = preferredWindows(state, prefer);
  for (let i = 0; i < (state.settings.lookaheadDays ?? 14); i++) {
    const d = addDays(startOfDay(now), i);
    const a = shifted(d)[0], b = workWindows(state, d)[0];
    if (a && b && a.start !== b.start) start[dateKey(d)] = { at: a.start, why: isSchoolDay(state, d) ? prefer.why.startSchool : prefer.why.startFree };
  }
  return { start, early: [...prefer.early], first: prefer.first, blockMin: prefer.blockMin };
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
export function replan(state, prioritized, busy = state.busy, settings = state.settings) {
  const now = new Date();
  const weekAgo = addDays(startOfDay(now), -7);
  // Finished blocks are the record of progress, so the ones for an assignment
  // that is still open are kept however old they are: dropping them after a
  // week made a long project forget its first sessions and plan them again.
  // A block left "running" long after it should have ended was abandoned
  // (a closed tab, usually) and goes back in the pool.
  const stillOpen = (s) => !s.commitmentId && !!state.tasks[s.taskId] && state.tasks[s.taskId].status !== 'done';
  const live = (s) => s.startedAt && !s.done && +now - +new Date(s.startedAt) < ((s.minutes || 0) + 120) * MIN;
  const kept = (state.plan?.sessions || []).filter((s) => (state.tasks[s.taskId] || s.commitmentId)
    && ((s.done && (new Date(s.start) >= weekAgo || stillOpen(s))) || live(s)));

  const progress = {};
  for (const s of kept) progress[s.taskId] = (progress[s.taskId] || 0) + s.minutes;
  const withProgress = prioritized.map((t) => ({ ...t, loggedMin: progress[t.id] || 0 }));

  const running = kept.filter((s) => !s.done).map((s) => ({
    start: s.startedAt,
    end: new Date(+new Date(s.startedAt) + s.minutes * MIN).toISOString()
  }));

  // What's already been done today counts toward today, so finishing a block
  // doesn't make room for another one. When she has put a number on tonight,
  // the count starts from when she said it: "ninety more minutes" means more.
  const todayKey = dateKey(now);
  const since = +new Date(state.dayOverrides?.[todayKey]?.since || 0);
  const doneToday = kept
    .filter((s) => s.done && dateKey(new Date(s.start)) === todayKey && +new Date(s.doneAt || s.end || s.start) >= since)
    .reduce((a, s) => a + (s.minutes || 0), 0)
    // The block in progress counts too, or a ninety-minute night becomes
    // ninety minutes plus whatever is running. Only the part of it that falls
    // after she set tonight's number is counted against that number.
    + kept
      .filter((s) => !s.done && dateKey(new Date(s.startedAt)) === todayKey)
      .reduce((a, s) => a + Math.max(0, Math.round((s.minutes || 0) - Math.max(0, since - +new Date(s.startedAt)) / MIN)), 0);

  const levels = [];
  for (let l = DAYMODEL.floorMin; l <= DAYMODEL.ceilingSchoolDay; l += DAYMODEL.stepMin) levels.push(l);

  const run = (prefer) => buildPlan(withProgress, {
    availability: prefer ? preferredWindows(state, prefer) : dayWindows(state),
    busy: [...busy, ...running],
    settings: prefer?.blockMin ? { ...settings, sessionMaxMin: prefer.blockMin, sessionMinMin: Math.min(settings.sessionMinMin ?? 20, prefer.blockMin) } : settings,
    capFor: (day, level) => dayCap(state, day, level),
    firmDay: (day) => { const o = overrideFor(state, day); return !!o && (o.off || Number.isFinite(o.budgetMin)); },
    levels,
    spent: doneToday ? { [todayKey]: doneToday } : {},
    prefer
  });

  // What this student prefers (lib/memory.js) is tried first. If that leaves
  // assigned work short of room before it is due, the plain plan is used
  // instead: a habit is worth following, not worth a missed deadline.
  const prefer = planPrefs(state, now);
  let plan = run(prefer);
  if (prefer) {
    // Something finishing after it is due counts for far more than minutes short.
    const short = (p) => (p.late?.length || 0) * 100000 + p.unplaced.filter((u) => !u.commitmentId).reduce((a, u) => a + u.missingMin, 0);
    const mine = short(plan);
    const plain = mine > 0 ? run(null) : null;
    if (plain && short(plain) < mine) plan = plain;
    else plan.adapted = adaptedDays(state, prefer, now);
  }
  plan.sessions = [...kept, ...plan.sessions].sort((a, b) => new Date(a.start) - new Date(b.start));
  numberParts(plan.sessions);
  plan.days = summarizeDays(plan.sessions, now, addDays(now, state.settings.lookaheadDays ?? 14));
  for (const d of plan.days) d.cap = dayCap(state, new Date(`${d.date}T12:00:00`), plan.level);
  return plan;
}

/**
 * What in a plan will not be done in time: work booked after its due date
 * (late) and anything with no free time at all (unplaced), in one list.
 * Everything that warns the student, or tells the assistant, reads this.
 */
export const atRisk = (plan) => [...(plan?.late || []), ...(plan?.unplaced || [])];
