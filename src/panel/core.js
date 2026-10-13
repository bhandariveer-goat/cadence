// App state and the operations every screen shares: loading and saving, the
// merged plan (homework + commitments), the Canvas bridge, crew sync, check-ins
// and navigation. Views read `app` and call these; app.js wires up rendering.

import { loadState, saveState, update, useBucket } from '../lib/store.js';
import { learn } from '../lib/estimator.js';
import { isStale } from '../lib/priority.js';
import { recomputeState, allBusy as busyFromState, plannable as taskPlannable } from '../lib/replanner.js';
import { runAll, applyResults, pushGoogle, SOURCE_META, sourceEvents } from '../lib/sources/sources.js';
import * as canvas from '../lib/canvas.js';
import * as ai from '../lib/ai.js';
import { createSync } from '../lib/sync.js';
import { createCloud, adopt, hasSubstance } from '../lib/cloud.js';
import { schoolBlocks } from '../lib/daymodel.js';
import { CONFIG, cloudConfigured } from '../config.js';
import { weekProgress, settleStreak, showUpStreak, sessionMinutes, isFixed, weekStart } from '../lib/habits.js';
import { dateKey, addDays, startOfDay, atTime, uid, MIN, DAY } from '../lib/util.js';

export const params = new URLSearchParams(location.search);
// The website's pages (app.html, demo.html) carry class="web" on <body>. That,
// not whether the page is in a frame, is what makes this the website: the
// homepage shows the demo in an iframe, and treating every framed copy as the
// extension panel left that demo waiting for a Canvas page that was not there.
export const STANDALONE = document.body.classList.contains('web') || params.get('standalone') === '1' || window.parent === window;
export const insideCanvas = !STANDALONE;
// The demo is its own page (demo.html) with its own storage. It is never a
// mode a real account can drift into: opening the app is always your week.
export const DEMO = STANDALONE && (document.body.dataset.demo === '1' || params.get('demo') === '1');
export const EMBEDDED = params.get('embed') === '1';
useBucket(DEMO ? 'demo' : 'real');

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
  ob: null,
  cloud: null,          // account + sync client (lib/cloud.js), when configured
  signin: null          // draft state for the sign-in screen
};

/** Is someone signed in on this device (or looking at the demo)? */
export const signedIn = () => DEMO || (app.S?.account?.mode && app.S.account.mode !== 'none');

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
  if (DEMO) await seedDemo({ onlyIfStale: true });
  if (insideCanvas) app.ctx = await ask('cadence:context');
  app.courses = app.S.courses || [];

  if (!DEMO && cloudConfigured()) {
    app.cloud = createCloud({
      url: CONFIG.supabaseUrl, anonKey: CONFIG.supabaseAnonKey, session: app.S.cloud?.session || null,
      onSession: (session) => persist((st) => { st.cloud.session = session; }, { recalc: false, edit: false })
    });
  }
  rebuildSync();
  if (app.cloud) watchAccount();

  // Plans are time-sensitive and streaks depend on yesterday: settle both on open.
  app.S = await update((st) => { settleStreak(st, new Date()); recompute(st); return st; });
  render();
  updateBadge();
  retireServiceWorker();

  if (!signedIn()) {
    // Inside Canvas the student is already signed in to school; offer that name.
    if (insideCanvas) offerCanvasName();
    return;
  }
  if (insideCanvas && !app.S.profile.name) fetchName();
  if (app.cloud?.signedIn) await syncDown();
  if (insideCanvas && app.S.profile.onboarded && shouldAutoSync()) syncCanvas({ quiet: true });
  if (app.S.profile.onboarded && sourcesStale()) refreshSources({ quiet: true });
  if (app.sync.available && app.S.profile.onboarded) loadCrew();
}

/** Crew (partners, clubs) rides on the same sign-in as everything else. */
export function rebuildSync() {
  app.sync = createSync(app.S, { demo: DEMO, cloud: app.cloud });
  app.crew = { feed: [], partners: [], clubs: [], nudges: [], loaded: false, loading: false, error: null };
}

/**
 * Cadence shipped a service worker for a while, and it kept serving old files
 * after every deploy. The site no longer installs one; anything left over from
 * an earlier visit is removed here.
 */
function retireServiceWorker() {
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister())).catch(() => {});
  if (window.caches?.keys) caches.keys().then((keys) => keys.filter((k) => k.startsWith('cadence')).forEach((k) => caches.delete(k))).catch(() => {});
}

/**
 * Lay down the demo week. Due dates and check-ins are written relative to
 * today, so the seed is re-run whenever it was made on an earlier day;
 * otherwise a demo left open overnight slowly fills with overdue work.
 */
async function seedDemo({ onlyIfStale = false } = {}) {
  const today = dateKey(new Date());
  const empty = !app.S.commitments.length && !Object.keys(app.S.tasks).length;
  if (onlyIfStale && !empty && app.S.demoSeed === today) return;

  const { mockTasks, mockCommitments, mockCheckins, mockCourses, mockLogs, mockEvents } = await import('./mock.js');
  app.S = await update((st) => {
    st.tasks = Object.fromEntries(mockTasks().map((t) => [t.id, t]));
    st.commitments = mockCommitments();
    st.checkins = mockCheckins();
    st.busy = mockEvents();
    st.courses = mockCourses;
    st.profile.name = 'Fiona';
    st.profile.onboarded = true;
    st.account = { mode: 'demo', id: null, email: '', name: 'Fiona', createdAt: new Date().toISOString() };
    st.dismissed = {};
    st.dayOverrides = {};
    st.plan = null;
    st.streak = { freezes: 1, frozenDays: [], best: 0, lastAward: null };
    st.model = { biases: {}, globalFactor: 1 };
    for (const l of mockLogs) st.model = learn(st.model, l);
    st.logs = mockLogs.map((l) => ({ ...l, at: new Date().toISOString() }));
    settleStreak(st, new Date());
    // A demo that says "0-day streak" under 40 check-ins reads as broken.
    st.streak.best = Math.max(st.streak.best, showUpStreak(st).days, 18);
    st.demoSeed = today;
    return st;
  });
}

// ------------------------------------------------------------- accounts

/** Start an account that lives in this browser: a name, nothing else. */
export async function signInLocal(name) {
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) throw new Error('Enter a name for Cadence to call you.');
  await persist((st) => {
    st.account = { mode: 'local', id: null, email: '', name: clean, createdAt: new Date().toISOString() };
    st.profile.name = clean;
  }, { recalc: false });
}

/** Step two of email sign-in. Decides what happens to a plan already on this device. */
export async function signInCloud(email, code, name) {
  if (!app.cloud) throw new Error('Email sign-in is not set up for this copy of Cadence');
  await app.cloud.verify(email, code, name);
  const user = app.cloud.user();

  // "Could not load your plan" is not "you have no plan". Treating it as one
  // would save this device's (possibly empty) plan over the account's, so if
  // the account cannot be read the sign-in is undone and nothing is changed.
  let remote = null;
  for (let attempt = 0; ; attempt++) {
    try { remote = await app.cloud.pull(); break; } catch (e) {
      if (attempt < 2) { await new Promise((r) => setTimeout(r, 700)); continue; }
      await app.cloud.signOut();
      throw new Error('That code worked, but your saved plan could not be loaded, so nothing was changed. Check your connection and ask for a new code.');
    }
  }

  // Signing back in to the account this device was already using (a session
  // that ended) is not a meeting of two plans: the device knows which version
  // it last matched, so the ordinary rules decide, and usually nothing is asked.
  if (app.S.account?.mode === 'cloud' && app.S.account.id === user.id && app.S.cloud?.seenAt) {
    rebuildSync();
    await syncDown();
    return { conflict: planConflict(), remote };
  }

  const conflict = !!remote && hasSubstance(app.S);     // two plans: the screen asks which to keep
  if (remote && !conflict) await adoptRemote(remote);
  await persist((st) => {
    const known = st.account?.name || st.profile.name || '';
    st.account = { mode: 'cloud', id: user.id, email: user.email, name: String(name || known || '').trim(), createdAt: st.account?.createdAt || new Date().toISOString() };
    if (st.account.name) st.profile.name = st.account.name;
    st.cloud.pulledAt = new Date().toISOString();
    // Nothing syncs in either direction until the person has said which plan
    // to keep. The flag is saved, so closing the tab at this point cannot let
    // one overwrite the other.
    st.cloud.conflict = conflict ? 'signin' : false;
    if (!remote || conflict) st.cloud.seenAt = null;
  }, { edit: false });
  rebuildSync();
  if (!remote) await pushNow();
  return { conflict, remote };
}

/** Is there an unanswered "which plan?" question on this device? */
export const planConflict = () => !DEMO && !!app.S?.cloud?.conflict;

/** Answer it: keep the account's plan, or this device's. */
export async function resolvePlanConflict(keep, remote = null) {
  if (keep === 'cloud') {
    const saved = (await app.cloud.pull().catch(() => null)) || remote;
    if (!saved) throw new Error('Could not load the plan saved to your account. Try again.');
    await adoptRemote(saved);
  } else {
    if (!await pushNow({ force: true })) throw new Error('Could not save to your account. Check your connection and try again.');
    render();
  }
}

/**
 * Sign out. With `wipe` the plan is removed from this browser, which is final
 * for anything the account does not have yet, so that is saved first; if it
 * cannot be, this stops and says so unless `force` is set.
 */
export async function signOut({ wipe = true, force = false } = {}) {
  if (wipe && !force && app.cloud?.signedIn && unsaved()) {
    const saved = !planConflict() && await pushNow();
    if (!saved || unsaved()) throw Object.assign(new Error('Your latest changes could not be saved to your account.'), { unsaved: true });
  }
  clearTimeout(pushTimer);
  pushTimer = null;
  await queue(() => {});                  // let a save already under way finish
  if (app.cloud?.signedIn) await app.cloud.signOut();
  if (wipe) {
    const { resetState } = await import('../lib/store.js');
    app.S = await saveState(await resetState());
  } else {
    await persist((st) => { st.account = { mode: 'none', id: null, email: '', name: '', createdAt: null }; st.cloud.session = null; }, { recalc: false, edit: false });
  }
  app.stack = [];
  app.view = 'today';
  app.ob = null;
  app.signin = null;
  rebuildSync();
  render();
}

// ------------------------------------------------------------------ sync
//
// One row per account holds the plan. Each device remembers which version of
// that row it last matched (cloud.seenAt), and from that every case can be
// told apart without trusting two devices' clocks to agree:
//
//   the account is unchanged, this device changed   save this device's plan
//   the account changed, this device did not        load the account's plan
//   both changed                                    ask; never choose silently
//
// Saving is conditional on the row still being the version last seen, so a
// tab left open all day cannot write its old plan over newer work.

const sameMoment = (a, b) => !!a && !!b && +new Date(a) === +new Date(b);

/** Has the plan been changed here since it last matched the account? */
const unsaved = () => !!app.S.editedAt && !sameMoment(app.S.editedAt, app.S.cloud?.seenAt);

/** True when this device holds changes its account does not have yet. */
export const hasUnsavedChanges = () => !DEMO && app.S?.account?.mode === 'cloud' && unsaved();

// Everything that talks to the account's row runs one at a time, in order.
let chain = Promise.resolve();
const queue = (fn) => { const run = chain.then(fn); chain = run.catch(() => {}); return run; };
let lastLook = 0;

/** Bring this device and the account into step, whichever way that goes. */
export const syncDown = () => queue(() => settle());
const pushNow = (opts = {}) => queue(() => settle({ ...opts, saving: true }));

let pushTimer = null;
/** Save to the account shortly after the last change, not on every keystroke. */
function pushSoon(delay = 1500) {
  if (DEMO || !app.cloud?.signedIn || planConflict()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { pushTimer = null; pushNow(); }, delay);
}

/** Replace what is here with the account's plan. Connections made on this device stay. */
async function adoptRemote(remote) {
  const account = app.S.account;
  const at = new Date(remote.editedAt).toISOString();
  app.S = await saveState({ ...adopt(app.S, remote.data), account, editedAt: at });
  app.S = await update((st) => {
    Object.assign(st.cloud, { pulledAt: new Date().toISOString(), seenAt: at, error: null, conflict: false });
    recompute(st);
    return st;
  });
  updateBadge();
  render();
}

/** Write this device's plan to the account. False when the account moved first. */
async function save({ force = false, expect = null } = {}) {
  const sent = app.S.editedAt;
  let at;
  try { at = await app.cloud.push(app.S, { expect, force }); } catch (e) { if (e.changed) return false; throw e; }
  app.S = await update((st) => { Object.assign(st.cloud, { pushedAt: at, seenAt: at, error: null }); if (force) st.cloud.conflict = false; return st; });
  if (app.S.editedAt !== sent) pushSoon();      // changed again while that was on its way
  return true;
}

async function settle({ force = false, saving = false } = {}) {
  if (DEMO || !app.cloud?.signedIn || (planConflict() && !force)) return false;
  lastLook = Date.now();
  try {
    if (force) return await save({ force: true });
    // The usual case when saving: nothing else has touched the account.
    if (saving && app.S.cloud?.seenAt && unsaved() && await save({ expect: app.S.cloud.seenAt })) return true;

    for (let round = 0; round < 3; round++) {
      const seen = app.S.cloud?.seenAt || null;
      const head = await app.cloud.head();
      if (!head || sameMoment(head, seen)) {
        // The account is empty, or exactly where this device left it.
        if (head && !unsaved()) {
          if (app.S.cloud.error) app.S = await update((st) => { st.cloud.error = null; return st; });
          return true;
        }
        if (await save({ expect: head ? seen : null })) return true;
        continue;                               // someone saved in between: look again
      }
      // The account holds a version this device has not seen.
      if (seen && unsaved()) return await askWhich();
      const remote = await app.cloud.pull();
      if (!remote) continue;
      // A device from before versions were tracked: the newer plan wins, once.
      if (!seen && +new Date(app.S.editedAt || 0) > +new Date(remote.editedAt) + 1000) return await save({ force: true });
      if (seen && unsaved()) return await askWhich();   // edited while that was loading
      await adoptRemote(remote);
      return true;
    }
    return false;
  } catch (e) {
    app.S = await update((st) => { st.cloud.error = e.message; return st; });
    return false;
  }
}

async function askWhich() {
  app.S = await update((st) => { st.cloud.conflict = 'diverged'; return st; });
  app.stack = [];
  render();
  return false;
}

/**
 * Keep an open tab honest. A plan changed on another device is picked up when
 * this one comes back into view and once a minute while it stays there; a
 * save still waiting on its timer goes out when the tab is hidden.
 */
function watchAccount() {
  const look = () => {
    if (document.visibilityState !== 'visible' || !app.cloud?.signedIn || planConflict()) return;
    if (Date.now() - lastLook > 15000) syncDown();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { if (pushTimer) pushNow(); } else look();
  });
  window.addEventListener('focus', look);
  setInterval(look, 60000);
}

async function offerCanvasName() {
  try {
    const me = await canvas.whoAmI();
    const name = me?.short_name || me?.name;
    if (name) { app.signin = { ...(app.signin || {}), canvasName: name }; render(); }
  } catch { /* the sign-in screen just asks for a name */ }
}

async function fetchName() {
  try {
    const me = await canvas.whoAmI();
    const name = me?.short_name || me?.name;
    if (name) await persist((st) => { st.profile.name = name; }, { recalc: false, edit: false });
  } catch { /* the greeting stays generic */ }
}

const shouldAutoSync = () => !app.S.lastSync || Date.now() - +new Date(app.S.lastSync) > 20 * MIN;

/**
 * The one way state changes. `edit` marks the change as something the person
 * did (as opposed to housekeeping), which is what sync compares between devices.
 */
export async function persist(mutator, { recalc = true, edit = true } = {}) {
  // An Undo still on screen that works by putting the whole plan back was
  // made for the plan as it stood before this change. It is withdrawn here,
  // because pressing it now would undo this change as well.
  if (edit) document.dispatchEvent(new Event('cadence:edited'));
  app.S = await update((st) => { mutator(st); if (edit) st.editedAt = new Date().toISOString(); if (recalc) recompute(st); return st; });
  updateBadge();
  render();
  if (edit) pushSoon();
}

/** The Undo for a change that is taken back by restoring the plan from just before it. */
export const undoTo = (snapshot) => ({ label: 'Undo', run: () => restore(snapshot), untilEdited: true });

export async function restore(snapshot) {
  document.dispatchEvent(new Event('cadence:edited'));
  app.S = await saveState({ ...snapshot, cloud: app.S.cloud, editedAt: new Date().toISOString() });
  updateBadge();
  render();
  pushSoon();
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
  for (const c of (S.commitments || []).filter((x) => !x.archived && isFixed(x) && x.schedule.days.includes(day.getDay()) && !x.skip?.[k])) {
    items.push({
      type: 'fixed', at: +atTime(day, c.schedule.start), end: +atTime(day, c.schedule.end), commitment: c,
      checkin: (S.checkins || []).find((x) => x.commitmentId === c.id && x.date === k) || null
    });
  }
  const external = [...(S.busy || []), ...sourceEvents(S), ...schoolBlocks(S, day, 2)];
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
    // Connected calendars belong to this device and are not part of what is
    // saved to the account, so refreshing them is not an edit.
    const results = await runAll(app.S, {
      saveGoogle: (t) => persist((st) => { Object.assign(st.sources.google, t); }, { recalc: false, edit: false })
    }, { only });

    await persist((st) => {
      applyResults(st, results);
      st.autoSync.lastRun = new Date().toISOString();
    }, { edit: false });

    if (app.S.sources?.google?.push) await pushGoogleBlocks({ quiet: true });

    const failed = Object.entries(results).filter(([, r]) => !r.ok);
    const good = Object.entries(results).filter(([, r]) => r.ok);
    if (!quiet) {
      if (failed.length && !good.length) toast(`${SOURCE_META[failed[0][0]]?.short || 'Sync'}: ${failed[0][1].error}`);
      else if (failed.length) toast(`Synced, but ${SOURCE_META[failed[0][0]]?.short} failed: ${failed[0][1].error}`);
      else {
        const n = good.reduce((a, [, r]) => a + (r.events?.length || 0) + (r.assignments?.length || 0), 0);
        toast(n ? `Calendars up to date, ${n} items` : 'Calendars up to date');
      }
    }
    return results;
  } finally {
    app.sourcesSyncing = false;
    render();
  }
}

/**
 * Push opted-in blocks to Google Calendar. Safe to call often: it reconciles
 * against what Cadence wrote before rather than creating duplicates.
 */
export async function pushGoogleBlocks({ quiet = false } = {}) {
  const g = app.S.sources?.google;
  if (!g?.enabled || !g.push) return null;
  const { toast } = await import('./ui.js');
  try {
    const res = await pushGoogle(app.S, {
      saveGoogle: (t) => persist((st) => { Object.assign(st.sources.google, t); }, { recalc: false, edit: false })
    });
    if (!res) return null;
    await persist((st) => {
      st.sources.google.pushed = res.map;
      st.sources.google.lastPush = new Date().toISOString();
      st.sources.google.pushError = res.errors[0] || null;
    }, { recalc: false, edit: false });
    if (!quiet) {
      const changed = res.created + res.updated + res.deleted;
      toast(changed
        ? `Google Calendar updated: ${[res.created && `${res.created} added`, res.updated && `${res.updated} moved`, res.deleted && `${res.deleted} removed`].filter(Boolean).join(', ')}`
        : 'Google Calendar already matches your plan');
    }
    return res;
  } catch (e) {
    await persist((st) => { st.sources.google.pushError = e.message; }, { recalc: false, edit: false });
    if (!quiet) toast(`Couldn't update Google Calendar: ${e.message}`);
    return null;
  }
}

export const sourcesStale = () => {
  const { enabled, everyMinutes, lastRun } = app.S.autoSync || {};
  if (!enabled) return false;
  return !lastRun || Date.now() - +new Date(lastRun) > (everyMinutes || 20) * MIN;
};
