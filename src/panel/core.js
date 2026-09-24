// App state and the operations every screen shares: loading and saving, the
// merged plan (homework + commitments), the Canvas bridge, crew sync, check-ins
// and navigation. Views read `app` and call these; app.js wires up rendering.

import { loadState, saveState, update } from '../lib/store.js';
import { learn } from '../lib/estimator.js';
import { isStale } from '../lib/priority.js';
import { recomputeState, allBusy as busyFromState, plannable as taskPlannable } from '../lib/replanner.js';
import { runAll, applyResults, SOURCE_META, sourceEvents } from '../lib/sources/sources.js';
import * as canvas from '../lib/canvas.js';
import * as ai from '../lib/ai.js';
import { createSync } from '../lib/sync.js';
import { weekProgress, settleStreak, showUpStreak, sessionMinutes, isFixed, weekStart } from '../lib/habits.js';
import { dateKey, addDays, startOfDay, atTime, uid, MIN, DAY } from '../lib/util.js';

export const params = new URLSearchParams(location.search);
export const STANDALONE = params.get('standalone') === '1' || window.parent === window;
export const DEMO = params.get('demo') === '1';
export const insideCanvas = !STANDALONE;

export const app = {
  S: null,
  view: 'today',
  stack: [],            // sub-screens opened from a tab, for Back
  ctx: {},              // Canvas page context from the content script
  courses: [],
  syncing: false,
  coach: null,
  sync: null,           // crew adapter (lib/sync.js)
  crew: { feed: [], partners: [], clubs: [], nudges: [], loaded: false, loading: false, error: null },
  guideId: null,
  clubId: null,
  planMode: 'week',
  planDay: null,
  weekOffset: 0,
  ob: null
};

let renderFn = () => {};
export const setRender = (fn) => { renderFn = fn; };
export const render = () => renderFn();

// ------------------------------------------------------------ navigation

export function go(view) {
  app.stack = [];
  app.view = view;
  scrollTop();
  render();
}

export function push(view, data = {}) {
  app.stack.push({ view: app.view });
  Object.assign(app, data);
  app.view = view;
  scrollTop();
  render();
}

export function back() {
  const prev = app.stack.pop();
  app.view = prev?.view || 'today';
  scrollTop();
  render();
}

/** Which tab lights up — sub-screens belong to the tab they were opened from. */
export const activeTab = () => (app.stack.length ? app.stack[0].view : app.view);

const scrollTop = () => { const v = document.getElementById('view'); if (v) v.scrollTop = 0; };

// ---------------------------------------------------------------- bridge

const pending = new Map();
window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'cadence:canvas:res' || m.type === 'cadence:context:res') {
    const r = pending.get(m.id);
    if (r) { pending.delete(m.id); r(m.payload ?? m.context); }
  }
  if (m.type === 'cadence:shown') app.ctx = m.context || app.ctx;
});

function ask(type, extra = {}, timeout = 15000) {
  return new Promise((resolve) => {
    const id = uid('req');
    pending.set(id, resolve);
    window.parent.postMessage({ type, id, ...extra }, '*');
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); resolve({ ok: false, status: 0, data: { message: 'Canvas did not respond.' } }); }
    }, timeout);
  });
}
canvas.setTransport((req) => ask('cadence:canvas', { req }));

// ------------------------------------------------------------- lifecycle

export async function boot() {
  app.S = await loadState();
  if (DEMO && !app.S.commitments.length && !Object.keys(app.S.tasks).length) await seedDemo();
  if (insideCanvas) app.ctx = await ask('cadence:context');
  app.courses = app.S.courses || [];
  app.sync = createSync(app.S, {
    demo: DEMO,
    saveSession: (session) => persist((st) => { st.sync.session = session; }, { recalc: false })
  });
  // Plans are time-sensitive and streaks depend on yesterday: settle both on open.
  app.S = await update((st) => { settleStreak(st, new Date()); recompute(st); return st; });
  render();
  updateBadge();

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('../../sw.js').catch(() => {});
  }
  if (insideCanvas && !app.S.profile.name) fetchName();
  if (insideCanvas && app.S.profile.onboarded && shouldAutoSync()) syncCanvas({ quiet: true });
  if (app.S.profile.onboarded && sourcesStale()) refreshSources({ quiet: true });
  if (app.sync.available && app.S.profile.onboarded) loadCrew();
}

async function seedDemo() {
  const { mockTasks, mockCommitments, mockCheckins, mockCourses, mockLogs } = await import('./mock.js');
  app.S = await update((st) => {
    for (const t of mockTasks()) st.tasks[t.id] = t;
    st.commitments = mockCommitments();
    st.checkins = mockCheckins();
    st.courses = mockCourses;
    st.profile.name = 'Fiona';
    st.streak = { freezes: 1, frozenDays: [], best: 0, lastAward: null };
    for (const l of mockLogs) st.model = learn(st.model, l);
    st.logs = mockLogs.map((l) => ({ ...l, at: new Date().toISOString() }));
    return st;
  });
}

async function fetchName() {
  try {
    const me = await canvas.whoAmI();
    const name = me?.short_name || me?.name;
    if (name) await persist((st) => { st.profile.name = name; }, { recalc: false });
  } catch { /* the greeting stays generic */ }
}

const shouldAutoSync = () => !app.S.lastSync || Date.now() - +new Date(app.S.lastSync) > 20 * MIN;

export async function persist(mutator, { recalc = true } = {}) {
  app.S = await update((st) => { mutator(st); if (recalc) recompute(st); return st; });
  updateBadge();
  render();
}

export async function restore(snapshot) {
  app.S = await saveState(snapshot);
  updateBadge();
  render();
}

function updateBadge() {
  if (!insideCanvas) return;
  const k = dateKey(new Date());
  const count = (app.S.plan?.sessions || []).filter((s) => !s.done && dateKey(new Date(s.start)) === k).length;
  window.parent.postMessage({ type: 'cadence:badge', count }, '*');
}

// ----------------------------------------------------------- computation

export const allBusy = (st = app.S) => busyFromState(st);
export const plannable = (t, st = app.S) => taskPlannable(t, st);

/** Estimates, ranking and the plan — homework, commitments and every calendar. */
export function recompute(st = app.S) {
  return recomputeState(st);
}

export function rankedTasks() {
  const byId = Object.fromEntries((app.S.ranked || []).map((r) => [r.id, r.priority]));
  return Object.values(app.S.tasks)
    .map((t) => ({ ...t, priority: byId[t.id] }))
    .sort((a, b) => ((b.priority?.score ?? -1) - (a.priority?.score ?? -1))
      || ((a.due ? +new Date(a.due) : Infinity) - (b.due ? +new Date(b.due) : Infinity)));
}

export const findSession = (st, id) => (st.plan?.sessions || []).find((s) => s.id === id);
export const commitmentById = (id) => (app.S.commitments || []).find((c) => c.id === id) || null;
export const minutesSince = (iso) => Math.max(0, Math.round((Date.now() - +new Date(iso)) / MIN));

export function sessionsOn(k) {
  return (app.S.plan?.sessions || []).filter((s) => dateKey(new Date(s.start)) === k)
    .sort((a, b) => new Date(a.start) - new Date(b.start));
}

export const runningSession = () => (app.S.plan?.sessions || []).find((s) => s.startedAt && !s.done) || null;

export function currentSession() {
  const running = runningSession();
  if (running) return running;
  const now = Date.now();
  return sessionsOn(dateKey(new Date())).find((s) => !s.done && +new Date(s.end) > now) || null;
}

export function nextFutureSession() {
  const today = dateKey(new Date());
  return (app.S.plan?.sessions || []).find((s) => !s.done && dateKey(new Date(s.start)) > today) || null;
}

/** Homework as one ring: this week's planned homework blocks, done vs total. */
export function schoolWeek(now = new Date()) {
  const start = dateKey(weekStart(now)), end = dateKey(addDays(weekStart(now), 7));
  const blocks = (app.S.plan?.sessions || []).filter((s) => !s.commitmentId && dateKey(new Date(s.start)) >= start && dateKey(new Date(s.start)) < end);
  const total = blocks.reduce((a, s) => a + s.minutes, 0);
  const done = blocks.filter((s) => s.done).reduce((a, s) => a + s.minutes, 0);
  const today = blocks.filter((s) => !s.done && dateKey(new Date(s.start)) === dateKey(now)).length;
  return { total, done, pct: total ? done / total : 0, todayLeft: today, count: blocks.length, hasWork: blocks.length > 0 };
}

/** Everything on a given day, in order: blocks, fixed commitments, other calendar events, ad-hoc check-ins. */
export function dayAgenda(k) {
  const S = app.S;
  const day = new Date(`${k}T00:00:00`), end = addDays(day, 1);
  const items = [];
  for (const s of sessionsOn(k)) {
    items.push({ type: 'session', at: +new Date(s.start), end: +new Date(s.end), session: s, commitment: s.commitmentId ? commitmentById(s.commitmentId) : null });
  }
  for (const c of (S.commitments || []).filter((x) => !x.archived && isFixed(x) && x.schedule.days.includes(day.getDay()))) {
    items.push({
      type: 'fixed', at: +atTime(day, c.schedule.start), end: +atTime(day, c.schedule.end), commitment: c,
      checkin: (S.checkins || []).find((x) => x.commitmentId === c.id && x.date === k) || null
    });
  }
  const external = [...(S.busy || []), ...sourceEvents(S)];
  for (const b of external.filter((x) => x.source !== 'skip' && new Date(x.start) < end && new Date(x.end) > day)) {
    items.push({
      type: 'busy', at: +new Date(b.start), end: +new Date(b.end), title: b.title,
      source: b.source, allDay: !!b.allDay, url: b.url || null, calendarName: b.calendarName || ''
    });
  }
  for (const ci of (S.checkins || []).filter((x) => x.date === k)) {
    const c = commitmentById(ci.commitmentId);
    if (!c || isFixed(c)) continue;
    if (items.some((i) => i.type === 'session' && i.session.commitmentId === c.id && i.session.done)) continue;
    items.push({ type: 'checkin', at: +new Date(ci.at), checkin: ci, commitment: c });
  }
  return items.sort((a, b) => a.at - b.at);
}

// ------------------------------------------------------------- check-ins

/**
 * Record a check-in: it fills the ring, settles the streak, marks the planned
 * block done, and (if shared) tells the crew. Returns what changed so the UI
 * can celebrate a closed ring.
 */
export async function checkIn(commitmentId, { minutes, feel = 'good', note = '', sessionId = null, date = new Date() } = {}) {
  const c = commitmentById(commitmentId);
  if (!c) return null;
  const before = weekProgress(c, app.S.checkins, date);
  const checkin = {
    id: uid('k'), commitmentId, date: dateKey(date), at: new Date().toISOString(),
    minutes: Math.max(5, Math.round(minutes || sessionMinutes(c))), feel, note: String(note || '').trim()
  };
  let settle = null;
  await persist((st) => {
    st.checkins.push(checkin);
    if (sessionId) {
      const s = findSession(st, sessionId);
      if (s) Object.assign(s, { done: true, startedAt: null, actualMin: checkin.minutes, doneAt: checkin.at });
    }
    settle = settleStreak(st, new Date());
  });
  const after = weekProgress(c, app.S.checkins, date);
  if (app.sync?.available) app.sync.share(checkin, c).then(() => { if (app.crew.loaded) loadCrew({ force: true }); }).catch(() => {});
  return { checkin, before, after, ringClosed: !before.met && after.met, streak: showUpStreak(app.S), settle };
}

export async function undoCheckin(id) {
  await persist((st) => {
    const k = st.checkins.find((x) => x.id === id);
    st.checkins = st.checkins.filter((x) => x.id !== id);
    if (k) for (const s of st.plan?.sessions || []) if (s.commitmentId === k.commitmentId && s.doneAt === k.at) Object.assign(s, { done: false, actualMin: null, doneAt: null });
  });
}

export async function loadCrew({ force = false } = {}) {
  const c = app.crew;
  if (!app.sync?.available || c.loading || (c.loaded && !force)) return;
  c.loading = true;
  if (!c.loaded) render();
  try {
    const [feed, partners, clubs, nudges] = await Promise.all([
      app.sync.feed(), app.sync.partners(), app.sync.clubs(), app.sync.nudges ? app.sync.nudges() : []
    ]);
    Object.assign(c, { feed, partners, clubs, nudges, loaded: true, error: null });
  } catch (e) {
    c.error = e.message;
  } finally {
    c.loading = false;
    render();
  }
}

// ------------------------------------------------------------------ canvas

export async function syncCanvas({ quiet = false } = {}) {
  if (app.syncing || !insideCanvas) return;
  const { toast } = await import('./ui.js');
  app.syncing = true; render();
  try {
    app.courses = await canvas.listCourses();
    const nameById = Object.fromEntries(app.courses.map((c) => [c.id, c.name]));
    const items = await canvas.fetchPlannerItems({ daysBack: 30, daysAhead: (app.S.settings.lookaheadDays ?? 14) + 16 });
    const fetched = items.map((i) => canvas.taskFromPlannerItem(i, nameById)).filter(Boolean);
    for (const c of app.courses.filter((x) => /student/i.test(x.role)).slice(0, 10)) {
      try {
        for (const a of await canvas.fetchCourseAssignments(c.id)) {
          const t = canvas.taskFromAssignment(a, c);
          if (t) fetched.push(t);
        }
      } catch { /* one locked course shouldn't fail the sync */ }
    }
    let added = 0;
    await persist((st) => {
      st.courses = app.courses;
      st.settings.canvasHost = app.ctx.origin || st.settings.canvasHost;
      for (const t of fetched) {
        const prev = st.tasks[t.id];
        if (!prev) { st.tasks[t.id] = t; if (t.status !== 'done') added++; continue; }
        if (t.description && prev.description && t.description !== prev.description) { prev.guideData = null; prev.guideAI = null; }
        Object.assign(prev, { title: t.title, due: t.due, points: t.points, url: t.url, description: t.description || prev.description, courseName: t.courseName || prev.courseName });
        if (t.status === 'done' && prev.status !== 'done') { prev.status = 'done'; prev.completedAt = t.completedAt || new Date().toISOString(); }
      }
      st.lastSync = new Date().toISOString();
    });
    if (!quiet) toast(added ? `Added ${added} new assignment${added === 1 ? '' : 's'} from Canvas` : "You're caught up with Canvas");
    refineWithAI();
  } catch (e) {
    if (!quiet) toast(e.message || "Couldn't reach Canvas just now");
  } finally {
    app.syncing = false; render();
  }
}

export async function refineWithAI() {
  if (!ai.aiAvailable(app.S.settings)) return;
  const targets = Object.values(app.S.tasks).filter((t) => plannable(t) && !t.userEstimateMin && !t.aiEstimatedAt && t.description);
  if (!targets.length) return;
  try {
    const byId = await ai.refineEstimates(app.S.settings, targets, { notes: learnedNotes() });
    await persist((st) => {
      for (const [id, r] of Object.entries(byId)) {
        const t = st.tasks[id];
        if (!t) continue;
        Object.assign(t, { aiEstimateMin: r.minutes, category: r.category || t.category, estimateWhy: [r.reason], steps: r.steps || t.steps, aiEstimatedAt: new Date().toISOString() });
      }
    });
  } catch { /* heuristics already cover it */ }
}

export function learnedNotes() {
  return Object.entries(app.S.model?.biases || {})
    .filter(([k, v]) => v.n >= 2 && k.startsWith('any::'))
    .map(([k, v]) => `${k.split('::')[1]}: takes ${Math.round(v.factor * 100)}% of a typical estimate`)
    .join('; ');
}

// ------------------------------------------------------- calendar sources

/**
 * Pull every connected calendar, cache what came back, and re-plan around it.
 * Failures are per-source: a dead Canvas feed never stops Google from syncing,
 * and the last good data stays on screen either way.
 */
export async function refreshSources({ only = null, quiet = false } = {}) {
  const enabled = Object.entries(app.S.sources || {}).filter(([id, s]) => s.enabled || id === only);
  if (!enabled.length) return null;

  app.sourcesSyncing = true;
  render();
  const { toast } = await import('./ui.js');
  try {
    const results = await runAll(app.S, {
      saveGoogle: (t) => persist((st) => { Object.assign(st.sources.google, t); }, { recalc: false })
    }, { only });

    await persist((st) => {
      applyResults(st, results);
      st.autoSync.lastRun = new Date().toISOString();
    });

    const failed = Object.entries(results).filter(([, r]) => !r.ok);
    const good = Object.entries(results).filter(([, r]) => r.ok);
    if (!quiet) {
      if (failed.length && !good.length) toast(`${SOURCE_META[failed[0][0]]?.short || 'Sync'}: ${failed[0][1].error}`);
      else if (failed.length) toast(`Synced, but ${SOURCE_META[failed[0][0]]?.short} failed — ${failed[0][1].error}`);
      else {
        const n = good.reduce((a, [, r]) => a + (r.events?.length || 0) + (r.assignments?.length || 0), 0);
        toast(n ? `Calendars up to date — ${n} items` : 'Calendars up to date');
      }
    }
    return results;
  } finally {
    app.sourcesSyncing = false;
    render();
  }
}

export const sourcesStale = () => {
  const { enabled, everyMinutes, lastRun } = app.S.autoSync || {};
  if (!enabled) return false;
  return !lastRun || Date.now() - +new Date(lastRun) > (everyMinutes || 20) * MIN;
};
