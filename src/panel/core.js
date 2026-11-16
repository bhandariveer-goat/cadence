// App state and the operations every screen shares: loading and saving, the
// merged plan (homework + commitments), the Canvas bridge, crew sync, check-ins
// and navigation. Views read `app` and call these; app.js wires up rendering.

import { loadState, saveState, update, useBucket } from '../lib/store.js';
import { POLICY_CHANGE } from '../lib/policy.js';
import { learn } from '../lib/estimator.js';
import { isStale } from '../lib/priority.js';
import { recomputeState, allBusy as busyFromState, plannable as taskPlannable } from '../lib/replanner.js';
import { runAll, applyResults, pushGoogle, SOURCE_META, sourceEvents, isCalendar } from '../lib/sources/sources.js';
import * as gmail from '../lib/sources/gmail.js';
import { clientIdFor } from '../lib/sources/googleCalendar.js';
import { noteUsage, forgetUsage, usageIsOn, usageConfigured } from '../lib/metrics.js';
import { findEvents, applyFound, alreadyRead, leaseHeld, nanoState, deleteEvent, undoDelete, dateOrder } from '../lib/mailEvents.js';
import * as canvas from '../lib/canvas.js';
import * as ai from '../lib/ai.js';
import { createSync } from '../lib/sync.js';
import { createCloud, adopt, hasSubstance, sessionFromLink, anonymousToken } from '../lib/cloud.js';
import { feedThroughServer } from '../lib/sources/canvasFeed.js';
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
  usageOn: null,        // whether anonymous usage counts are on for this browser (lib/metrics.js); null until read
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
// app.js hands over its draw function here, so views can redraw without
// importing app.js (which would import them back).
export const setRender = (fn) => { renderFn = fn; };
// Redraws the app from app.S and app's screen state.
export const render = () => renderFn();

// ------------------------------------------------------------ navigation

/** Switches to a tab, forgetting any screens opened on top of the last one. */
export function go(view) {
  app.stack = [];
  app.view = view;
  scrollTop();
  render();
}

/** Opens a screen on top of the current one (`data` is merged into app, for
    example which club to show); back() returns to where it was opened from. */
export function push(view, data = {}) {
  app.stack.push({ view: app.view });
  Object.assign(app, data);
  app.view = view;
  scrollTop();
  render();
}

/** Goes back to the screen this one was opened from, or Today. */
export function back() {
  const prev = app.stack.pop();
  app.view = prev?.view || 'today';
  scrollTop();
  render();
}

/** Which tab lights up: sub-screens belong to the tab they were opened from. */
export const activeTab = () => (app.stack.length ? app.stack[0].view : app.view);

// A new screen starts at its top.
const scrollTop = () => { const v = document.getElementById('view'); if (v) v.scrollTop = 0; };

// ---------------------------------------------------------------- bridge

const pending = new Map();
window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (!m || typeof m !== 'object') return;
  // Answers come from the Canvas page that holds this panel, never another frame.
  if (ev.source !== window.parent || window.parent === window) return;
  if (m.type === 'cadence:canvas:res' || m.type === 'cadence:context:res') {
    const r = pending.get(m.id);
    if (r) { pending.delete(m.id); r(m.payload ?? m.context); }
  }
  if (m.type === 'cadence:shown') app.ctx = m.context || app.ctx;
});

/** Asks the Canvas page that hosts Cadence (content.js) to do something only
    it can, like a Canvas API call with the student's session, and waits for
    the answer. After `timeout` milliseconds it answers itself with a failure,
    so a page that went away does not leave Cadence waiting forever. */
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

// ---------------------------------------------------------------- invites
//
// A club or partner invite travels as a link: /app?join=<club code> or
// /app?partner=<invite code>. The code is kept in this browser until it is
// used, because the person opening it usually has to sign in first, and an
// email sign-in link can land in another tab. Partners and clubs need an
// email account, so it is offered once one is signed in (views/crew.js).

const INVITE_SLOT = 'cadence.pending-invite';
const INVITE_CODE = /^[A-Z0-9][A-Z0-9-]{3,31}$/;

/** Keeps an invite code from the address (?join= for a club, ?partner= for a
    partner) until the student is signed in and can be asked to accept it. */
function captureInvite() {
  if (DEMO || !STANDALONE) return;           // the demo never takes or offers a real invite
  const join = params.get('join'), partner = params.get('partner');
  if (join == null && partner == null) return;
  const code = String(join ?? partner).trim().toUpperCase();
  if (INVITE_CODE.test(code)) {
    try { localStorage.setItem(INVITE_SLOT, JSON.stringify({ kind: join != null ? 'club' : 'partner', code, at: Date.now() })); } catch { /* storage refused: the code is still in the message they were sent */ }
  }
  const url = new URL(location.href);
  url.searchParams.delete('join');
  url.searchParams.delete('partner');
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
}

/** The invite waiting in this browser, if any, for up to two weeks. */
export function pendingInvite() {
  try {
    const v = JSON.parse(localStorage.getItem(INVITE_SLOT) || 'null');
    if (!v || !INVITE_CODE.test(v.code || '') || !['club', 'partner'].includes(v.kind) || Date.now() - v.at > 14 * DAY) return null;
    return v;
  } catch { return null; }
}
export function clearPendingInvite() { try { localStorage.removeItem(INVITE_SLOT); } catch { /* nothing to clear */ } }

/** The link that invites someone, or null where this copy does not know its own address. */
export function inviteLink(kind, code) {
  const base = /^https?:$/.test(location.protocol) && STANDALONE ? location.origin
    : CONFIG.site?.domain ? `https://${CONFIG.site.domain}` : null;
  if (!base || !code) return null;
  const url = new URL('/app', base);
  url.searchParams.set(kind === 'club' ? 'join' : 'partner', code);
  return url.href;
}

/** Starts the app: reads a sign-in link from the address, loads the saved
    plan (and the sample week in the demo), asks the Canvas page for its
    address and course when inside it, connects to the account, starts
    watching for changes, then
    brings the plan, the account and the calendars up to date. */
export async function boot() {
  captureInvite();
  // Someone opening a sign-in link arrives with the session in the address.
  // It is read and taken out of the address before anything else happens, so
  // it is not left in the address bar or in the browser's history.
  const link = !DEMO && STANDALONE ? sessionFromLink(location.hash) : null;
  if (link) history.replaceState(history.state, '', location.pathname + location.search);

  app.S = await loadState();
  if (DEMO) await seedDemo({ onlyIfStale: true });
  if (insideCanvas) app.ctx = await ask('cadence:context');
  app.courses = app.S.courses || [];

  if (!DEMO && cloudConfigured()) {
    app.cloud = createCloud({
      url: CONFIG.supabaseUrl, anonKey: CONFIG.supabaseKey, session: app.S.cloud?.session || null,
      onSession: (session) => persist((st) => { st.cloud.session = session; }, { recalc: false, edit: false })
    });
  }
  rebuildSync();
  if (app.cloud) watchAccount();
  if (STANDALONE) watchSources();
  if (link && app.cloud) await arriveByLink(link);
  // The same thing arriving on a page that is already open (the link's
  // address pasted into this tab) changes only the part after the #, which
  // does not reload the page, so it is watched for.
  if (app.cloud && STANDALONE) {
    window.addEventListener('hashchange', async () => {
      const late = sessionFromLink(location.hash);
      if (!late) return;
      history.replaceState(history.state, '', location.pathname + location.search);
      await arriveByLink(late);
      render();
      if (signedIn() && app.cloud.signedIn) syncDown();
    });
  }

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
  if (app.S.profile.onboarded) watchMail();
  startUsage();
  // The website shows the events the extension in this browser found in email.
  if (app.S.profile.onboarded && !DEMO && !inExtension() && CONFIG.extensionId) import('./mailbridge.js').then((b) => b.startMailBridge());
  if (app.sync.available && app.S.profile.onboarded) loadCrew();
}

// ------------------------------------------------------- anonymous usage counts

let usageStarted = false;

/**
 * Anonymous counts of use (lib/metrics.js), when this copy has them switched
 * on. The people who agreed to the privacy policy before it said so are shown
 * what changed once, and are counted only after they have seen it. Counted:
 * now, whenever the page is shown again, and after changes to the plan (which
 * is when a milestone such as the first assignment becomes true).
 */
function startUsage() {
  if (usageStarted || DEMO || !usageConfigured()) return;
  usageStarted = true;
  usageIsOn().then((on) => { app.usageOn = on; render(); });
  import('./views/agent.js').then((m) => m.askPolicyNotice?.()).catch(() => {}).finally(() => noteUsage(app.S, { demo: DEMO }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') noteUsage(app.S, { demo: DEMO }); });
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
    consentNow(st);
  }, { recalc: false });
  keepStorage();
}

/** Record agreeing to the terms and the privacy policy: when, and which
    version of the policy, so a later change is announced (lib/policy.js).
    Someone who agreed before keeps their date, and is told about the change. */
function consentNow(st) {
  if (st.profile.consentedAt) return;
  st.profile.consentedAt = consentStamp();
  if (st.profile.consentedAt) st.profile.policySeen = POLICY_CHANGE.date;
}

/** When the sign-in screen's "13 or older, I agree" box was ticked in this browser. */
function consentStamp() {
  try { return localStorage.getItem('cadence.consented-at') || null; } catch { return null; }
}

/**
 * Ask the browser not to clear this site's storage on its own. Without it,
 * Safari drops a site's storage after a week without a visit, and an account
 * that lives only in this browser goes with it. Browsers may say no; nothing
 * depends on the answer.
 */
export function keepStorage() {
  try { navigator.storage?.persist?.().catch(() => {}); } catch { /* not offered here */ }
}

/** Step two of email sign-in, with the code from the email. */
export async function signInCloud(email, code, name) {
  if (!app.cloud) throw new Error('Email sign-in is not set up for this copy of Cadence');
  await app.cloud.verify(email, code, name);
  return finishCloudSignIn(name);
}

/** Sign in with an email and the password set on the account. */
export async function signInPassword(email, password, name) {
  if (!app.cloud) throw new Error('Email sign-in is not set up for this copy of Cadence');
  await app.cloud.signInWithPassword(email, password);
  // As with a code (cloud.verify): the name partners and clubs see goes up
  // with the sign-in, and failing to write it does not undo the sign-in.
  if (name) { try { await app.cloud.setName(name); } catch { /* written again the next time the name is saved */ } }
  return finishCloudSignIn(name);
}

// Whether an email account has been used in this browser before, so the
// sign-in screen opens on "Sign in" rather than "Create an account". Only a
// yes or no: no email or anything else about the account is kept for this.
const HAD_ACCOUNT = 'cadence.had-account';
export const hadAccount = () => { try { return localStorage.getItem(HAD_ACCOUNT) === '1'; } catch { return false; } };
// Forgotten when the account is deleted, so the screen offers to make one again.
export const forgetHadAccount = () => { try { localStorage.removeItem(HAD_ACCOUNT); } catch { /* nothing stored */ } };

/**
 * Step two the other way: the email had a link in it and this is where it
 * led. The session is already made; what is left is the same as with a code,
 * except that nobody has typed a name, so it is asked for if none is known.
 */
async function arriveByLink(link) {
  // Signed out, the reason goes on the sign-in screen. Signed in, that screen
  // is not showing, so it is handed to the app to say once it has drawn.
  const fail = (message) => { if (signedIn()) app.linkProblem = message; else app.signin = { step: 'start', error: message, errorFor: 'email' }; };
  if (link.error) return fail(link.error);
  try {
    // Already signed in here with an email: the link may only be for that account.
    const mine = app.S.account?.mode === 'cloud' && app.cloud.signedIn ? app.S.account.id : null;
    await app.cloud.adoptLink(link, { onlyFor: mine });
    const { conflict, remote } = await finishCloudSignIn('');
    app.signin = conflict ? { step: 'conflict', remote, email: app.cloud.user()?.email || '' }
      : app.S.account?.name ? null : { step: 'name' };
  } catch (e) { fail(e.message); }
}

/** Give the account the name its owner wants to be called. */
export async function nameAccount(name) {
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) throw new Error('Enter a name for Cadence to call you.');
  await persist((st) => { st.account.name = clean; st.profile.name = clean; }, { recalc: false });
  // The profile row is what partners and clubs see; the plan does not wait on it.
  try { await app.cloud?.setName(clean); } catch { /* written again the next time the name is saved */ }
}

/** Decides what happens to a plan already on this device, once the account is known. */
async function finishCloudSignIn(name) {
  const user = app.cloud.user();
  try { localStorage.setItem(HAD_ACCOUNT, '1'); } catch { /* the screen just opens on "Create an account" */ }

  // "Could not load your plan" is not "you have no plan". Treating it as one
  // would save this device's (possibly empty) plan over the account's, so if
  // the account cannot be read the sign-in is undone and nothing is changed.
  let remote = null;
  for (let attempt = 0; ; attempt++) {
    try { remote = await app.cloud.pull(); break; } catch (e) {
      if (attempt < 2) { await new Promise((r) => setTimeout(r, 700)); continue; }
      await app.cloud.signOut();
      throw new Error('You were signed in, but your saved plan could not be loaded, so nothing was changed. Check your connection and sign in again.');
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
    consentNow(st);
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
    gmail.drop();                         // the Gmail sign-in held in memory goes too
    await forgetUsage();                  // and this browser's anonymous usage counts, here and on the server
    // What else this browser kept for the person: the hidden account the
    // assistant and calendar links use (deleted on the server after 30 days
    // without use), an invite not yet used, and the terms agreement.
    anonymousTokens = null;
    for (const slot of ['cadence.assistant-session', 'cadence.pending-invite', 'cadence.consented-at']) {
      try { localStorage.removeItem(slot); } catch { /* nothing stored */ }
    }
    // And their chats with the assistant, which only ever lived here.
    const { clearChats } = await import('../lib/chats.js');
    clearChats();
    app.agent = null;
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
// Save to the account now, in turn with any sync already running.
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
  const at = new Date(remote.editedAt).toISOString();
  // What belongs to this device (its calendars and the events found in email,
  // the Gmail connection, keys, the account session) is taken from storage,
  // not from this page's memory: another page may have changed it since this
  // one loaded (a Disconnect, or an email event deleted on the website).
  app.S = await update((local) => {
    const st = { ...adopt(local, remote.data), account: local.account, editedAt: at };
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

/** Brings this device and the account into step. If the account is where
    this device last saw it, local changes are saved. If it moved on and this
    device has no unsaved changes, the account's plan is taken. If both
    changed, nothing is overwritten: the student is asked which plan to keep.
    It looks again (up to three times) if someone saved in between. `force`
    saves this device's plan over the account's. */
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

/** Marks the plan as changed in two places and shows the screen that asks
    which to keep. */
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
/**
 * A session for Cadence's server functions: the account's, when signed in
 * with an email, or else a hidden anonymous one (the database lets it do
 * nothing but be counted; see supabase/schema.sql).
 */
let anonymousTokens = null;
/** A token for Cadence's own server functions: the account's when signed in
    with email, otherwise an anonymous one for this browser. */
export function siteToken() {
  if (app.cloud?.signedIn) return app.cloud.token();
  anonymousTokens ||= anonymousToken({ url: CONFIG.supabaseUrl, key: CONFIG.supabaseKey });
  return anonymousTokens();
}

/**
 * How this copy fetches a Canvas feed: the extension directly (it has host
 * permissions), the website through Cadence's server.
 */
function feedFetch() {
  if (!/^https?:$/.test(location.protocol) || !cloudConfigured()) return null;
  return feedThroughServer(new URL('/api/canvas-feed', location.origin).href, siteToken);
}

/** Cadence's server, for the website and the extension alike (Google Calendar links). */
function serverFetch() {
  if (!cloudConfigured()) return null;
  const base = /^https?:$/.test(location.protocol) ? location.origin : CONFIG.site?.domain ? `https://${CONFIG.site.domain}` : null;
  return base ? feedThroughServer(`${base}/api/canvas-feed`, siteToken) : null;
}

/**
 * The extension's background worker re-syncs calendars on a timer. An open
 * website tab does the same itself, once a minute checking whether they are
 * due (the setting under Calendars, every 20 minutes by default).
 */
function watchSources() {
  setInterval(() => {
    if (document.visibilityState !== 'visible' || !app.S?.profile?.onboarded || app.sourcesSyncing) return;
    if (sourcesStale()) refreshSources({ quiet: true });
  }, 60000);
}

/** Keeps the account current while the page is open: saves at once when the
    tab is hidden (in case it is closed), and looks for changes from other
    devices when it comes back (no more than once every 15 seconds). */
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

/** Inside Canvas, offers the name Canvas knows to the sign-in screen, so the student does not have to type it. */
async function offerCanvasName() {
  try {
    const me = await canvas.whoAmI();
    const name = me?.short_name || me?.name;
    if (name) { app.signin = { ...(app.signin || {}), canvasName: name }; render(); }
  } catch { /* the sign-in screen just asks for a name */ }
}

/** Inside Canvas, uses the name Canvas knows for the greeting. */
async function fetchName() {
  try {
    const me = await canvas.whoAmI();
    const name = me?.short_name || me?.name;
    if (name) await persist((st) => { st.profile.name = name; }, { recalc: false, edit: false });
  } catch { /* the greeting stays generic */ }
}

// Canvas is read again on open if the last sync was more than 20 minutes ago.
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
  // A student who has just finished setup starts being counted now, not at the next open.
  if (!usageStarted && app.S.profile?.onboarded && signedIn()) startUsage();
  else if (usageStarted) noteUsage(app.S, { demo: DEMO });
  updateBadge();
  render();
  if (edit) pushSoon();
}

/** The Undo for a change that is taken back by restoring the plan from just before it. */
export const undoTo = (snapshot) => ({ label: 'Undo', run: () => restore(snapshot), untilEdited: true });

/** Puts a whole earlier plan back (what Undo does after a bigger change),
    keeping the current sync details so the account is not confused. */
export async function restore(snapshot) {
  document.dispatchEvent(new Event('cadence:edited'));
  // The account session, the Gmail connection and the events found in email
  // belong to this device, not to the plan: an Undo or an assistant reply never
  // brings back an old one. Gmail's and the email events are read from
  // storage, so a second open page cannot undo a Disconnect made in another,
  // and an Undo cannot bring back an email event the student deleted.
  const stored = await loadState();
  const next = {
    ...snapshot, cloud: app.S.cloud, gmail: stored.gmail,
    sources: { ...snapshot.sources, mail: stored.sources?.mail || snapshot.sources?.mail },
    editedAt: new Date().toISOString()
  };
  // The plan was made around the email events the snapshot had; when they
  // have changed since, it is made again around the ones kept.
  if (JSON.stringify(next.sources.mail?.events || []) !== JSON.stringify(snapshot.sources?.mail?.events || [])) recompute(next);
  app.S = await saveState(next);
  updateBadge();
  render();
  pushSoon();
}

/** Inside Canvas, tells the page how many blocks are left today, for the badge on Cadence's button. */
function updateBadge() {
  if (!insideCanvas) return;
  const k = dateKey(new Date());
  const count = (app.S.plan?.sessions || []).filter((s) => !s.done && dateKey(new Date(s.start)) === k).length;
  window.parent.postMessage({ type: 'cadence:badge', count }, '*');
}

// ----------------------------------------------------------- computation

// Everything the plan has to work around: busy blocks, school hours, timed
// calendar events and activities at set times.
export const allBusy = (st = app.S) => busyFromState(st);
// Whether an assignment still needs time planned: open, not hidden, not too
// old, and due on a date (or added by the student, or picked to do first).
export const plannable = (t, st = app.S) => taskPlannable(t, st);

/** Estimates, ranking and the plan: homework, commitments and every calendar. */
export function recompute(st = app.S) {
  return recomputeState(st);
}

/** Every assignment with its priority, most urgent first, then soonest due. */
export function rankedTasks() {
  const byId = Object.fromEntries((app.S.ranked || []).map((r) => [r.id, r.priority]));
  return Object.values(app.S.tasks)
    .map((t) => ({ ...t, priority: byId[t.id] }))
    .sort((a, b) => ((b.priority?.score ?? -1) - (a.priority?.score ?? -1))
      || ((a.due ? +new Date(a.due) : Infinity) - (b.due ? +new Date(b.due) : Infinity)));
}

// A planned block by id, in the given state.
export const findSession = (st, id) => (st.plan?.sessions || []).find((s) => s.id === id);
// An activity by id.
export const commitmentById = (id) => (app.S.commitments || []).find((c) => c.id === id) || null;
// Whole minutes since a moment, never negative.
export const minutesSince = (iso) => Math.max(0, Math.round((Date.now() - +new Date(iso)) / MIN));

/** The blocks planned on day `k` (YYYY-MM-DD), earliest first. */
export function sessionsOn(k) {
  return (app.S.plan?.sessions || []).filter((s) => dateKey(new Date(s.start)) === k)
    .sort((a, b) => new Date(a.start) - new Date(b.start));
}

// The block whose timer is running, if any.
export const runningSession = () => (app.S.plan?.sessions || []).find((s) => s.startedAt && !s.done) || null;

/** The block to show as "now": the one running, else today's next one that has not ended. */
export function currentSession() {
  const running = runningSession();
  if (running) return running;
  const now = Date.now();
  return sessionsOn(dateKey(new Date())).find((s) => !s.done && +new Date(s.end) > now) || null;
}

/** The first block planned after today, offered as a head start. */
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
      source: b.source, allDay: !!b.allDay, url: b.url || null, calendarName: b.calendarName || '',
      id: b.id || null, mail: b.mail || null
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

/** Removes a check-in, and reopens the planned block it had closed. */
export async function undoCheckin(id) {
  await persist((st) => {
    const k = st.checkins.find((x) => x.id === id);
    st.checkins = st.checkins.filter((x) => x.id !== id);
    if (k) for (const s of st.plan?.sessions || []) if (s.commitmentId === k.commitmentId && s.doneAt === k.at) Object.assign(s, { done: false, actualMin: null, doneAt: null });
  });
}

/** Loads partners, clubs and nudges, and the feed of shared check-ins, once
    per page unless `force`. */
export async function loadCrew({ force = false } = {}) {
  const c = app.crew;
  if (!app.sync?.available || c.loading || (c.loaded && !force)) return;
  c.loading = true;
  if (!c.loaded) render();
  try {
    const [partners, clubs, nudges] = await Promise.all([
      app.sync.partners(), app.sync.clubs(), app.sync.nudges ? app.sync.nudges() : []
    ]);
    // The feed is asked for by these people and clubs (lib/sync.js).
    const feed = await app.sync.feed({ partnerIds: partners.map((p) => p.id), clubIds: clubs.map((c) => c.id) });
    Object.assign(c, { feed, partners, clubs, nudges, loaded: true, error: null });
  } catch (e) {
    c.error = e.message;
  } finally {
    c.loading = false;
    render();
  }
}

// ------------------------------------------------------------------ canvas

/** Reads the student's courses and assignments from Canvas (inside Canvas
    only), adds new ones and updates changed ones. A changed description
    means the guide is fetched again. Unless `quiet`, the toast says how many
    came in. */
export async function syncCanvas({ quiet = false } = {}) {
  if (app.syncing || !insideCanvas) return;
  const { toast } = await import('./ui.js');
  app.syncing = true; render();
  try {
    app.courses = await canvas.listCourses();
    const nameById = Object.fromEntries(app.courses.map((c) => [c.id, c.name]));
    const items = await canvas.fetchPlannerItems({ daysBack: 30, daysAhead: (app.S.settings.lookaheadDays ?? 14) + 16 });
    const fetched = items.map((i) => canvas.taskFromPlannerItem(i, nameById)).filter(Boolean);
    // Four courses at a time: one after another made a first sync take long
    // enough to look like nothing had been found.
    const mine = app.courses.filter((x) => /student/i.test(x.role)).slice(0, 10);
    for (let i = 0; i < mine.length; i += 4) {
      const batch = await Promise.all(mine.slice(i, i + 4).map((c) => canvas.fetchCourseAssignments(c.id)
        .then((list) => list.map((a) => canvas.taskFromAssignment(a, c)).filter(Boolean))
        .catch(() => [])));                       // one locked course shouldn't fail the sync
      for (const list of batch) fetched.push(...list);
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

/** With the student's own key, asks the model for better estimates of
    assignments that have instructions and no estimate of their own yet. */
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

/** What the estimator learned about this student's speed, as a short note for the model. */
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
  const enabled = Object.entries(app.S.sources || {}).filter(([id, s]) => isCalendar(id) && (s.enabled || id === only));
  if (!enabled.length) return null;

  app.sourcesSyncing = true;
  render();
  const { toast } = await import('./ui.js');
  try {
    // Connected calendars belong to this device and are not part of what is
    // saved to the account, so refreshing them is not an edit. A refresh that
    // runs by itself (quiet) never opens Google's sign-in window.
    const results = await runAll(app.S, {
      interactive: !quiet,
      feedFetch: feedFetch(),
      serverFetch: serverFetch()
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
    const res = await pushGoogle(app.S, { interactive: !quiet });
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

// True when automatic sync is on and the sources are due to be checked again.
// ---------------------------------------------------------- email events
//
// With Gmail connected under Calendars and "Add events from email
// automatically" on, the extension reads the recent inbox and adds the events
// it finds (lib/mailEvents.js). It runs only while a Cadence page is open:
// Google's sign-in is held in this page's memory, and Chrome's on-device AI
// cannot run in the background worker. Nothing it reads or finds leaves this
// browser. The website shows the same events by asking the extension
// (mailbridge.js), and never reads email itself.

const MAIL_EVERY = 30 * MIN;
let mailTimer = null;

/** Is this the extension (which has its own storage), rather than the website? */
export const inExtension = () => typeof chrome !== 'undefined' && !!chrome?.storage?.local;

/** Can this page read email for events: the extension, not the demo, signed in, Gmail connected and the switch on? */
export const mailReady = (st = app.S) => !DEMO && gmail.available() && signedIn() && !!st?.gmail?.enabled && !!st?.sources?.mail?.enabled;

/** Is a reading due: never tried, or last tried more than 30 minutes ago? */
const mailDue = () => { const t = app.S?.sources?.mail?.lastTry; return !t || Date.now() - +new Date(t) > MAIL_EVERY; };

/**
 * Read the inbox now and then while this page is open: when it is shown, and
 * every 30 minutes while it stays visible. Started once per page.
 */
export function watchMail() {
  if (mailTimer || DEMO || !gmail.available()) return;
  const tick = () => { if (document.visibilityState === 'visible' && mailReady() && mailDue()) refreshMail({ quiet: true }); };
  mailTimer = setInterval(tick, MIN);
  document.addEventListener('visibilitychange', tick);
  window.addEventListener('pagehide', () => {
    clearInterval(mailTimer);
    mailTimer = null;
    document.removeEventListener('visibilitychange', tick);
  }, { once: true });
  tick();
}

/**
 * Read the inbox and fold in the events found. A quiet run (on its own) never
 * opens Google's sign-in window and shows no message. One page reads at a
 * time: each takes a lease in storage (sources.mail.scanStartedAt), and a page
 * that finds a lease taken in the last few minutes leaves the reading to the
 * page that holds it. Returns what changed, or null.
 */
export async function refreshMail({ quiet = true } = {}) {
  if (!mailReady() || app.mailRunning) return null;
  app.mailRunning = true;
  render();
  try {
    const run = () => readMailNow({ quiet });
    // Web Locks keep two of this extension's pages from even trying at once; the lease is what counts where locks are not shared.
    return navigator.locks?.request
      ? await navigator.locks.request('cadence-mail-scan', { ifAvailable: true }, (lock) => (lock ? run() : null))
      : await run();
  } finally {
    app.mailRunning = false;
    render();
  }
}

/** The reading itself, once refreshMail() has made sure no other is running here. */
async function readMailNow({ quiet }) {
  const { toast, plural } = await import('./ui.js');
  const now = new Date();
  let claimed = false;
  await persist((st) => {
    const m = st.sources?.mail;
    if (!m?.enabled || !st.gmail?.enabled || leaseHeld(m, now)) return;
    m.scanStartedAt = now.toISOString();
    claimed = true;
  }, { recalc: false, edit: false });
  if (!claimed) {
    if (!quiet) toast('Cadence is already checking your email in another tab.');
    return null;
  }
  const account = app.S.gmail.email;
  const order = dateOrder();
  try {
    const clientId = clientIdFor(app.S.sources.google);
    let token;
    try {
      if (!clientId) throw new Error('No client ID');
      token = await gmail.freshToken(account, clientId, { interactive: !quiet });
    } catch {
      throw Object.assign(new Error('Gmail needs your approval again.'), { code: 401 });
    }
    const nano = (await nanoState()) === 'available';
    const { messages } = await gmail.readInbox(token, { account, skip: alreadyRead(app.S.sources.mail, { nano }), now });
    const found = await findEvents(messages, { now, engine: nano ? 'nano' : 'rules', order, school: app.S.school });
    let merged = null;
    await persist((st) => {
      const m = st.sources?.mail;
      if (!m) return;
      // Disconnected, switched off, or connected to another address while
      // reading: nothing read is kept.
      if (!m.enabled || !st.gmail?.enabled || String(st.gmail.email || '').toLowerCase() !== String(account || '').toLowerCase()) { m.scanStartedAt = null; return; }
      merged = applyFound(m, found, { now, order });
    }, { edit: false });
    if (!quiet) {
      const added = merged ? merged.added + merged.replaced : 0;
      toast(!merged ? 'Gmail was disconnected while Cadence was reading it, so nothing was added.'
        : added ? `Found ${plural(added, 'event')} in your email`
          : merged.removed ? `Removed ${plural(merged.removed, 'cancelled event')} from your calendar`
            : 'No new events in your email');
    }
    return merged;
  } catch (e) {
    const message = mailProblem(e);
    if (e?.code === 401 || e?.code === 403) gmail.drop();
    await persist((st) => {
      const m = st.sources?.mail;
      if (!m) return;
      m.scanStartedAt = null;
      m.lastTry = now.toISOString();
      m.error = message;
    }, { recalc: false, edit: false });
    if (!quiet) toast(message);
    return null;
  }
}

/** What went wrong, as the student should hear it. */
function mailProblem(e) {
  if (e?.code === 401 || e?.code === 403) return 'Gmail needs your approval again. Choose Check email now to give it.';
  if (/could not be reached|took too long/i.test(String(e?.message || ''))) return 'Gmail could not be reached. Cadence will try again in a while.';
  return 'Cadence could not read your email this time. It will try again in a while.';
}

/**
 * Delete an event found in email, so it is not added again. On the website
 * the extension owns these events, so the extension is asked to delete it
 * (mailbridge.js). Returns the deleted event, or null.
 */
export async function deleteMailEvent(id) {
  if (!inExtension()) return (await import('./mailbridge.js')).dismissInExtension(id);
  let gone = null;
  await persist((st) => { if (st.sources?.mail) gone = deleteEvent(st.sources.mail, id, new Date()); }, { edit: false });
  return gone;
}

/** Take back the deletion of an email event, while that is still allowed. Returns {ok, why}. */
export async function undoMailEvent(id) {
  if (!inExtension()) return (await import('./mailbridge.js')).restoreInExtension(id);
  let result = { ok: false, why: 'gone' };
  await persist((st) => { if (st.sources?.mail) result = undoDelete(st.sources.mail, id, new Date(), { order: dateOrder() }); }, { edit: false });
  return result;
}

export const sourcesStale = () => {
  const { enabled, everyMinutes, lastRun } = app.S.autoSync || {};
  if (!enabled) return false;
  return !lastRun || Date.now() - +new Date(lastRun) > (everyMinutes || 20) * MIN;
};
