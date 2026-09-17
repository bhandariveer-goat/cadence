// Commitments: the things nobody assigns you.
//
// Piano five times a week, robotics build nights, cross-country, college
// essays, volunteering. Canvas knows nothing about any of it, and nothing keeps
// a student accountable for it — so this is where Cadence earns its place.
//
// The mechanics are the ones that have held up at scale:
//   - a weekly target you can see filling (Apple's rings: the goal-gradient effect)
//   - a daily "showed up" streak with automatic freezes (Duolingo: loss aversion,
//     plus forgiveness so one bad day doesn't erase months)
//   - check-ins that take one tap and keep a record (which later becomes the
//     college activities list — accountability that pays off)
//   - weekly review that adjusts targets instead of shaming misses

import { dateKey, addDays, startOfDay, atTime, MIN, DAY, clamp, uid } from './util.js';

export const KINDS = {
  practice: { label: 'Practice', icon: 'music', color: '#8b5cf6', verb: 'Practiced' },
  sport: { label: 'Sport', icon: 'run', color: '#10b981', verb: 'Trained' },
  club: { label: 'Club or team', icon: 'users', color: '#3b82f6', verb: 'Worked' },
  service: { label: 'Service', icon: 'heart', color: '#ec4899', verb: 'Volunteered' },
  work: { label: 'Job', icon: 'briefcase', color: '#d97706', verb: 'Worked' },
  project: { label: 'Project', icon: 'spark', color: '#ef4444', verb: 'Built' },
  study: { label: 'Study goal', icon: 'book', color: '#6366f1', verb: 'Studied' },
  wellness: { label: 'Wellbeing', icon: 'leaf', color: '#14b8a6', verb: 'Made time for' },
  custom: { label: 'Something else', icon: 'star', color: '#f97316', verb: 'Put time into' }
};

export const COLORS = ['#f97316', '#8b5cf6', '#10b981', '#3b82f6', '#ec4899', '#d97706', '#14b8a6', '#6366f1', '#ef4444'];

export const FEELS = { great: 'Great', good: 'Okay', tough: 'Tough' };

/** Time-of-day preferences map to scheduling windows. */
export const TIME_WINDOWS = {
  morning: { start: '05:30', end: '12:00' },
  afternoon: { start: '12:00', end: '18:00' },
  evening: { start: '17:00', end: '23:00' }
};

/** Common App activities section limits. */
export const COMMON_APP = { maxActivities: 10, position: 50, organization: 100, description: 150 };

export function newCommitment(f = {}) {
  const kind = KINDS[f.kind] ? f.kind : 'custom';
  return {
    id: f.id || uid('c'),
    title: String(f.title || '').trim() || KINDS[kind].label,
    kind,
    color: f.color || KINDS[kind].color,
    why: f.why || '',
    // flexible: "5 sessions of 30 min, whenever" — fixed: "Tue & Thu, 4–6pm"
    schedule: f.schedule || { mode: 'flexible' },
    target: f.target || { sessions: 3, minutes: 30 },
    days: f.days || [],               // preferred days for flexible commitments
    time: f.time || 'any',
    event: f.event || null,           // { date: 'YYYY-MM-DD', label: 'Regionals' }
    org: f.org || '',
    role: f.role || '',
    grades: f.grades || [],
    timing: f.timing || 'school',     // school | break | all  (Common App wording)
    clubId: f.clubId || null,
    share: f.share !== false,
    createdAt: f.createdAt || new Date().toISOString(),
    archived: false
  };
}

const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };

export const isFixed = (c) => c.schedule?.mode === 'fixed';
export const targetSessions = (c) => (isFixed(c) ? (c.schedule.days || []).length : Math.max(1, c.target?.sessions || 1));
export const sessionMinutes = (c) => (isFixed(c) ? Math.max(15, toMin(c.schedule.end) - toMin(c.schedule.start)) : Math.max(10, c.target?.minutes || 30));

/** Weeks start on Monday — that's how a school week feels. */
export function weekStart(date = new Date()) {
  const d = startOfDay(date);
  return addDays(d, -((d.getDay() + 6) % 7));
}

export function weekProgress(c, checkins, date = new Date()) {
  const start = dateKey(weekStart(date)), end = dateKey(addDays(weekStart(date), 7));
  const mine = checkins.filter((k) => k.commitmentId === c.id && k.date >= start && k.date < end);
  const target = targetSessions(c);
  const done = mine.length;
  return {
    done,
    target,
    minutes: mine.reduce((a, k) => a + (k.minutes || 0), 0),
    pct: target ? clamp(done / target, 0, 1) : 0,
    met: done >= target,
    left: Math.max(0, target - done),
    label: `${done} of ${target}`
  };
}

export const checkedInOn = (c, checkins, date = new Date()) =>
  checkins.some((k) => k.commitmentId === c.id && k.date === dateKey(date));

/** Is today one of the days this needs to happen? */
export function dueToday(c, checkins, now = new Date()) {
  if (c.archived || checkedInOn(c, checkins, now)) return false;
  if (isFixed(c)) return (c.schedule.days || []).includes(now.getDay());
  const { left } = weekProgress(c, checkins, now);
  if (!left) return false;
  const daysLeft = 7 - ((now.getDay() + 6) % 7);           // today counts
  if (left >= daysLeft) return true;                         // must happen today to hit the target
  return !c.days?.length || c.days.includes(now.getDay());
}

/** Consecutive weeks the target was met (the current week counts once it's met). */
export function weekStreak(c, checkins, now = new Date()) {
  let n = weekProgress(c, checkins, now).met ? 1 : 0;
  const created = weekStart(new Date(c.createdAt || now));
  for (let w = weekStart(addDays(weekStart(now), -7)); w >= created; w = addDays(w, -7)) {
    if (!weekProgress(c, checkins, w).met) break;
    n++;
    if (n > 520) break;
  }
  return n;
}

// ---------------------------------------------------------------- streaks

/** Every day the student did *something* they planned: a check-in or a finished homework block. */
export function activeDates(state) {
  const set = new Set((state.checkins || []).map((k) => k.date));
  for (const s of state.plan?.sessions || []) if (s.done) set.add(dateKey(new Date(s.start)));
  return set;
}

export function showUpStreak(state, now = new Date()) {
  const active = activeDates(state);
  const frozen = new Set(state.streak?.frozenDays || []);
  const today = startOfDay(now);
  const todayDone = active.has(dateKey(today));
  let days = todayDone ? 1 : 0;
  for (let d = addDays(today, -1), guard = 0; guard < 3650; d = addDays(d, -1), guard++) {
    const k = dateKey(d);
    if (active.has(k)) days++;
    else if (!frozen.has(k)) break;
  }
  return { days, todayDone, freezes: state.streak?.freezes ?? 0, best: Math.max(state.streak?.best || 0, days) };
}

/**
 * Apply streak rules for today. Missed days get covered by freezes when there
 * are enough to cover the whole gap; every 7-day streak earns a freeze (max 2).
 * Returns what changed, so the UI can say "a freeze covered Sunday".
 */
export function settleStreak(state, now = new Date()) {
  const s = (state.streak ||= { freezes: 1, frozenDays: [], best: 0, lastAward: null });
  const active = activeDates(state);
  const frozen = new Set(s.frozenDays);
  const missed = [];
  let d = addDays(startOfDay(now), -1);
  while (!active.has(dateKey(d)) && !frozen.has(dateKey(d)) && missed.length < 4) { missed.push(dateKey(d)); d = addDays(d, -1); }
  const hadStreak = active.has(dateKey(d)) || frozen.has(dateKey(d));
  let usedFreezes = [];
  if (missed.length && hadStreak && missed.length <= s.freezes) {
    s.frozenDays.push(...missed);
    s.freezes -= missed.length;
    usedFreezes = missed;
  }
  const { days } = showUpStreak(state, now);
  let earned = false;
  if (days > 0 && days % 7 === 0 && s.lastAward !== dateKey(now) && s.freezes < 2) {
    s.freezes += 1;
    s.lastAward = dateKey(now);
    earned = true;
  }
  s.best = Math.max(s.best || 0, days);
  s.frozenDays = s.frozenDays.filter((k) => k >= dateKey(addDays(now, -120)));
  return { usedFreezes, earned, days };
}

// --------------------------------------------------------------- planning

function spread(days, n) {
  if (n <= 0) return [];
  if (n >= days.length) return days;
  const step = days.length / n;
  return [...Array(n)].map((_, i) => days[Math.floor(i * step + step / 2 - 0.5)] || days[i]);
}

/**
 * Flexible commitments become schedulable sessions: this week's remaining
 * sessions spread over the days left (preferring the days she picked), plus
 * next week's. Each session is pinned to its day with notBefore + due, so the
 * scheduler doesn't pile five piano sessions onto Monday.
 */
export function commitmentTasks(state, now = new Date(), horizonDays = 13) {
  const out = [];
  const today = startOfDay(now);
  const lateTonight = now.getHours() >= 22;
  for (const c of (state.commitments || []).filter((x) => !x.archived && !isFixed(x))) {
    const mins = sessionMinutes(c);
    for (let w = 0; w < 2; w++) {
      const ws = addDays(weekStart(now), 7 * w);
      const doneToday = checkedInOn(c, state.checkins || [], today);
      const days = [...Array(7)].map((_, i) => addDays(ws, i))
        .filter((d) => +d >= +today && +d < +today + horizonDays * DAY)
        .filter((d) => !(dateKey(d) === dateKey(today) && (doneToday || lateTonight)));
      if (!days.length) continue;
      const left = w === 0 ? weekProgress(c, state.checkins || [], now).left : targetSessions(c);
      const preferred = c.days?.length ? days.filter((d) => c.days.includes(d.getDay())) : [];
      const pool = preferred.length >= left ? preferred : days;
      for (const d of spread(pool, left)) {
        out.push({
          id: `c_${c.id}_${dateKey(d)}`,
          source: 'commitment',
          commitmentId: c.id,
          title: c.title,
          courseName: c.title,
          courseId: `c_${c.id}`,
          color: c.color,
          category: 'practice',
          status: 'todo',
          estimateMin: mins,
          userEstimateMin: mins,
          notBefore: d.toISOString(),
          due: atTime(d, '23:30').toISOString(),
          noBuffer: true,
          window: TIME_WINDOWS[c.time] || null
        });
      }
    }
  }
  return out;
}

/** Fixed-schedule commitments block time the same way activities did. */
export function fixedActivities(state) {
  return (state.commitments || []).filter((c) => !c.archived && isFixed(c)).map((c) => ({
    id: c.id, title: c.title, days: c.schedule.days, start: c.schedule.start, end: c.schedule.end
  }));
}

/** Fixed commitments that ended today with no check-in yet — "Did you make it to practice?" */
export function pendingCheckins(state, now = new Date()) {
  return (state.commitments || []).filter((c) => !c.archived && isFixed(c)
    && (c.schedule.days || []).includes(now.getDay())
    && toMin(`${now.getHours()}:${now.getMinutes()}`) >= toMin(c.schedule.end)
    && !checkedInOn(c, state.checkins || [], now));
}

// ------------------------------------------------------------ the record

const round1 = (n) => Math.round(n * 10) / 10;

function truncate(s, max) {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).replace(/[\s,;:.]+\S*$/, '')}…`;
}

/**
 * The activities list entry this commitment has earned so far, in Common App
 * terms: hours per week, weeks per year, and a 150-character description.
 */
export function activityRecord(state, c, now = new Date()) {
  const mine = (state.checkins || []).filter((k) => k.commitmentId === c.id).sort((a, b) => a.date.localeCompare(b.date));
  const totalMin = mine.reduce((a, k) => a + (k.minutes || 0), 0);
  const weeks = new Set(mine.map((k) => dateKey(weekStart(new Date(`${k.date}T12:00:00`)))));
  const first = mine[0] ? new Date(`${mine[0].date}T12:00:00`) : new Date(c.createdAt || now);
  const spanWeeks = Math.max(1, Math.ceil((+weekStart(now) - +weekStart(first)) / (7 * DAY)) + 1);
  const hoursPerWeek = weeks.size ? round1(totalMin / 60 / weeks.size) : round1(targetSessions(c) * sessionMinutes(c) / 60);
  const base = c.timing === 'all' ? 52 : c.timing === 'break' ? 10 : 36;
  const weeksPerYear = Math.max(1, Math.round(base * clamp(weeks.size / spanWeeks, 0.35, 1)));

  let best = 0, run = 0;
  for (let w = weekStart(first); w <= weekStart(now); w = addDays(w, 7)) {
    if (weekProgress(c, mine, w).met) { run++; best = Math.max(best, run); } else if (+w < +weekStart(now)) run = 0;
  }

  const seenNotes = new Set();
  const notes = mine.filter((k) => k.note).reverse()
    .filter((k) => { const key = k.note.trim().toLowerCase(); if (seenNotes.has(key)) return false; seenNotes.add(key); return true; })
    .slice(0, 6).map((k) => ({ date: k.date, note: k.note }));
  const verb = KINDS[c.kind]?.verb || 'Put time into';
  const cadence = isFixed(c) ? `${targetSessions(c)}x/wk` : `${targetSessions(c)}x/wk`;
  const why = c.why ? c.why.replace(/\.$/, '') : '';
  const goal = why ? why.charAt(0).toLowerCase() + why.slice(1) : '';
  const mentionsEvent = c.event?.label && goal.toLowerCase().includes(c.event.label.toLowerCase());
  const parts = [
    `${verb} ${cadence}, ~${Math.max(1, Math.round(hoursPerWeek))} hrs/wk`,
    c.event?.label && !mentionsEvent ? `toward ${c.event.label}` : '',
    goal ? `; goal: ${goal}` : '',
    `; ${Math.round(totalMin / 60)} hrs logged`
  ];
  const description = truncate(parts.filter(Boolean).join(' ').replace(/\s+;/g, ';'), COMMON_APP.description);

  return {
    commitmentId: c.id,
    title: c.title,
    position: truncate(c.role || c.title, COMMON_APP.position),
    organization: truncate(c.org || '', COMMON_APP.organization),
    grades: c.grades,
    timing: c.timing,
    hoursPerWeek,
    weeksPerYear,
    totalHours: round1(totalMin / 60),
    sessions: mine.length,
    activeWeeks: weeks.size,
    since: dateKey(first),
    bestWeekStreak: best,
    notes,
    description
  };
}

// ---------------------------------------------------------- weekly review

/**
 * Last week, looked at kindly: what was met, what slipped, and one concrete
 * adjustment per commitment. Missing twice in a row suggests a smaller target —
 * consistency beats intensity; hitting it three weeks running suggests a stretch.
 */
export function weeklyReview(state, now = new Date()) {
  const last = addDays(weekStart(now), -7), prev = addDays(last, -7);
  const active = activeDates(state);
  let showUpDays = 0;
  for (let i = 0; i < 7; i++) if (active.has(dateKey(addDays(last, i)))) showUpDays++;

  const items = (state.commitments || []).filter((c) => !c.archived && +new Date(c.createdAt) < +weekStart(now)).map((c) => {
    const p = weekProgress(c, state.checkins || [], last);
    const before = weekProgress(c, state.checkins || [], prev);
    let suggestion = null;
    if (!p.met && !before.met && !isFixed(c) && targetSessions(c) > 1) {
      suggestion = { type: 'lower', to: Math.max(1, Math.round(p.done + (targetSessions(c) - p.done) / 2)), text: 'Two tough weeks in a row. A smaller target you actually hit builds more than a big one you miss.' };
    } else if (p.met && before.met && weekStreak(c, state.checkins || [], addDays(last, 6)) >= 3 && !isFixed(c) && targetSessions(c) < 7) {
      suggestion = { type: 'raise', to: targetSessions(c) + 1, text: 'Three weeks straight. Ready to add one more session?' };
    }
    return { commitment: c, progress: p, previous: before, suggestion };
  });

  const minutes = (state.checkins || []).filter((k) => k.date >= dateKey(last) && k.date < dateKey(weekStart(now)))
    .reduce((a, k) => a + (k.minutes || 0), 0);
  return { weekOf: dateKey(last), showUpDays, hours: round1(minutes / 60), items, met: items.filter((i) => i.progress.met).length };
}
