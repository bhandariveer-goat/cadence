// The planning pipeline, with no DOM in it.
//
// The panel used to own this; it lives here so the background service worker
// can re-plan after an autosync without touching the UI. Given a state object
// it merges every calendar source, re-estimates, re-ranks and rebuilds the plan.

import { estimate, classify } from './estimator.js';
import { prioritize, isStale } from './priority.js';
import { replan } from './scheduler.js';
import { expandActivities } from './calendar.js';
import { commitmentTasks, fixedActivities } from './habits.js';
import { addDays, startOfDay, DAY } from './util.js';
import { sourceEvents, sourceAssignments } from './sources/sources.js';

/** Everything that blocks time: imported events, connected calendars, fixed commitments. */
export function allBusy(st) {
  const days = (st.settings?.lookaheadDays ?? 14) + 2;
  return [
    ...(st.busy || []),
    ...sourceEvents(st).filter((e) => e.busy !== false && !e.allDay),
    ...expandActivities(fixedActivities(st), new Date(), days),
    ...expandActivities(st.activities || [], new Date(), days)
  ];
}

export function plannable(t, st) {
  if (t.status === 'done' || st.dismissed?.[t.id] || isStale(t)) return false;
  return !!(t.due || t.source === 'manual' || t.pinned);
}

export function pruneTasks(st) {
  const monthAgo = Date.now() - 30 * DAY;
  for (const [id, t] of Object.entries(st.tasks)) {
    const oldDone = t.status === 'done' && t.completedAt && +new Date(t.completedAt) < monthAgo;
    if ((t.status !== 'done' && isStale(t)) || oldDone) delete st.tasks[id];
  }
  const yesterday = +addDays(startOfDay(new Date()), -1);
  st.busy = (st.busy || []).filter((b) => b.source === 'ics' || +new Date(b.end) > yesterday);
}

/**
 * Fold feed assignments into tasks. The Canvas API (when Cadence runs inside
 * Canvas) knows more — submissions, points, instructions — so the feed only
 * fills gaps and updates due dates; it never overwrites richer data.
 */
export function mergeSourceAssignments(st) {
  let added = 0;
  for (const a of sourceAssignments(st)) {
    const prev = st.tasks[a.id];
    if (!prev) {
      st.tasks[a.id] = { ...a };
      added++;
      continue;
    }
    if (a.due && a.due !== prev.due) prev.due = a.due;
    if (!prev.courseName && a.courseName) prev.courseName = a.courseName;
    if (!prev.url && a.url) prev.url = a.url;
    if (!prev.description && a.description) prev.description = a.description;
  }
  return added;
}

/** Estimates → ranking → schedule. Mutates and returns the state. */
export function recomputeState(st) {
  pruneTasks(st);
  mergeSourceAssignments(st);

  for (const t of Object.values(st.tasks)) {
    if (!t.category) t.category = classify(t);
    if (!t.userEstimateMin && !t.aiEstimateMin) {
      const e = estimate(t, st.model);
      t.heuristicMin = e.minutes;
      t.estimateWhy = e.rationale;
    }
    t.baseEstimateMin = t.userEstimateMin || t.aiEstimateMin || t.heuristicMin || 30;
    t.estimateMin = t.baseEstimateMin + (t.estimateBoost || 0);
  }

  const busy = allBusy(st);
  const homework = Object.values(st.tasks).filter((t) => plannable(t, st));
  const practice = commitmentTasks(st, new Date(), (st.settings.lookaheadDays ?? 14) - 1);
  const ranked = prioritize([...homework, ...practice], { availability: st.availability, busy, settings: st.settings });
  st.ranked = ranked.filter((t) => t.source !== 'commitment').map((t) => ({ id: t.id, priority: t.priority }));
  st.plan = replan(st, ranked, busy);
  return st;
}

/**
 * Blocks the student has opted in to mirror on Google Calendar.
 *
 * Opt-in is per item — a commitment or an assignment — not a blanket setting,
 * so nothing appears on someone's real calendar without them asking for it.
 * The key is stable across re-plans (item + start time), which is what lets a
 * resync recognise an event it wrote earlier.
 */
export function pushableBlocks(st, { daysAhead = 21 } = {}) {
  const until = Date.now() + daysAhead * DAY;
  const from = Date.now() - 60 * 60 * 1000;
  const out = [];

  for (const s of st.plan?.sessions || []) {
    if (s.done) continue;
    const at = +new Date(s.start);
    if (at < from || at > until) continue;

    const commitment = s.commitmentId ? (st.commitments || []).find((c) => c.id === s.commitmentId) : null;
    const task = s.taskId ? st.tasks[s.taskId] : null;
    const item = commitment || task;
    if (!item?.pushToGoogle) continue;

    const itemId = commitment ? commitment.id : task.id;
    out.push({
      key: `${itemId}|${new Date(s.start).toISOString()}`,
      itemId,
      title: commitment ? `${s.title} (Cadence)` : `${s.title}${s.parts > 1 ? ` · part ${s.part}/${s.parts}` : ''}`,
      start: s.start,
      end: s.end,
      description: commitment
        ? `${commitment.why ? `${commitment.why}\n\n` : ''}Scheduled by Cadence.`
        : `${task?.courseName ? `${task.courseName}. ` : ''}Scheduled by Cadence.${task?.url ? `\n${task.url}` : ''}`
    });
  }
  return out;
}

/** Items currently opted in, for the settings screen. */
export function pushedItems(st) {
  return [
    ...(st.commitments || []).filter((c) => c.pushToGoogle && !c.archived).map((c) => ({ id: c.id, title: c.title, kind: 'commitment', color: c.color })),
    ...Object.values(st.tasks || {}).filter((t) => t.pushToGoogle && t.status !== 'done').map((t) => ({ id: t.id, title: t.title, kind: 'assignment', color: null }))
  ];
}
