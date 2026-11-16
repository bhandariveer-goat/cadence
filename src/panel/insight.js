// How the app is used, for the anonymous usage data (lib/metrics.js, which
// decides whether anything is kept and sends it). Everything here is a name
// from Cadence's own code, a number, or both:
//
//   screen      which screen was open, and for how long it was being used.
//               A screen left alone for a minute stops counting, and so does
//               one in a tab that is not showing.
//   click       a control was pressed: its data-act name (the same name the
//               app runs it by), or for anything else its kind and code name
//               ("field:email", "link:privacy"). Never what is written on
//               it, never what is in a field, never where on the screen.
//   dead_click  a press on something that is not a control: the element's
//               kind and its style name ("div.card").
//   rage_click  three or more presses within a second on the same thing.
//   step        how far setup and the tour got (step()).
//   error       an error in the app: its kind and the file and line in
//               Cadence's code, never its message.
//   timing      how long the app took to open, and how long Cadence's own
//               requests took (its server and its database), by name.
//   session     a visit starting, and how long it was used when it ends.
//
// Nothing about email is ever recorded: a control whose name mentions mail is
// skipped. Nothing at all happens in the demo or in the homepage's frame. The
// sign-up screen's own steps go through countStep(), with no ID.

import { track, flush, detailAllowed, countStep, NAME } from '../lib/metrics.js';
import { CONFIG } from '../config.js';

const IDLE = 60 * 1000;          // a screen left alone this long stops counting
const LONGEST = 4 * 60 * 60 * 1000;
const RAGE = { presses: 3, within: 1000 };
const EVERY = 20 * 1000;         // how often what is waiting is sent
const MAX_ERRORS = 20;           // per visit
// Names never recorded: Gmail and the events found in email (gmail-connect,
// open-mail-event, mail-toggle). Not an email address field (field:email).
const EMAIL = /\bg?mail\b/;

const CONTROL = 'button, a[href], [data-act], [data-tour], [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="option"], input, select, textarea, label, summary';
// Pressing these is pressing the page's background, not a missed control.
const BACKGROUND = new Set(['HTML', 'BODY', 'MAIN']);
const BACKGROUND_IDS = new Set(['root', 'view', 'side', 'top', 'tabs']);

let on = false;
let demo = false;
let screenOf = () => '';
let screen = '';             // the screen being shown
let mark = 0;                // when the time on it was last added up
let lastInput = 0;           // the last press or key
let spent = 0;               // time used on this screen so far
let used = 0;                // time used in this visit so far
let visitStarted = false;
let opened = 0;              // performance.now() when the app itself was first drawn
let openSent = false;
let setupT0 = 0;
let setupStarted = false;
let wasSignin = false;
let errors = 0;
let rage = { el: null, t: 0, n: 0 };

/** A name in the shape the server accepts: lower case, code characters only. */
export function codeName(s) {
  const out = String(s || '').toLowerCase().replace(/[^a-z0-9_.:-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 80).replace(/-+$/, '');
  return NAME.test(out) ? out : '';
}

// A sheet about email (its heading carries data-about="email") is open.
const emailOpen = () => !!document.querySelector('#sheet[open] [data-about="email"]');

const keep = (kind, name, extra = {}) => {
  // The owner's own Insights page is not student activity.
  if (screen === 'insights' || String(name).startsWith('insights')) return false;
  if (!name || EMAIL.test(name) || EMAIL.test(screen) || emailOpen()) return false;
  return track(kind, name, { screen: screen || undefined, ...extra });
};

// ------------------------------------------------------------ the screen

/** Adds the time used since the last mark to the current screen. While the
    page is hidden there is no mark, so nothing is added. */
function credit(now = performance.now()) {
  if (!mark) return;
  const until = Math.min(now, lastInput + IDLE);
  if (until > mark) { spent += until - mark; used += until - mark; }
  mark = now;
}

/** A press or a key: the time up to it is added first, so a long pause before it is not counted as use. */
function touch() {
  credit();
  lastInput = performance.now();
}

/** Closes the current screen's stay, recording how long it was used. Never
    the sign-up screen: that time was spent before the person agreed. */
function leave() {
  credit();
  if (screen && !screen.startsWith('signin') && spent >= 500) keep('screen', screen, { value: Math.min(spent, LONGEST) });
  spent = 0;
}

/**
 * Called after every render, and when a sheet opens or closes: notices a new
 * screen, the sign-up screen's steps, and the start of setup.
 */
export function update() {
  if (!on) return;
  // While a sheet about email is open there is no screen, so its time is not recorded.
  const next = emailOpen() ? '' : codeName(screenOf()) || '';
  // The sign-up screen, counted with no ID.
  if (next.startsWith('signin')) { if (!wasSignin) countStep('signin:shown', { demo }); wasSignin = true; }
  else if (wasSignin && next) { countStep('signin:done', { demo }); wasSignin = false; }

  if (detailAllowed() && !visitStarted) {
    visitStarted = true;
    track('session', 'start');
  }
  if (next !== screen) {
    leave();
    screen = next;
    // How long the app took to be drawn, when it opened straight into the app.
    if (!opened && next) opened = next.startsWith('signin') || next.startsWith('setup') ? -1 : performance.now();
  }
  // Kept once records are allowed, which can be a render or two after the app is drawn.
  if (opened > 0 && !openSent && detailAllowed()) openSent = keep('timing', 'open', { value: opened });
  if (next.startsWith('setup:') && !setupStarted && detailAllowed()) {
    setupStarted = true;
    setupT0 = performance.now();
    keep('step', 'setup:start');
  }
}

/** Records a step of setup or the tour ("tour:skip"), with a number if it has one. */
export function step(name, value) {
  if (!on) return;
  keep('step', codeName(name), Number.isFinite(value) ? { value } : {});
}

/** Seconds since setup was first shown in this visit (0 if it was not). */
export const setupSeconds = () => (setupT0 ? Math.round((performance.now() - setupT0) / 1000) : 0);

// ------------------------------------------------------------ presses

/** The name a control is recorded by, from Cadence's code only. Empty when it is not to be recorded. */
export function controlName(el) {
  const d = el.dataset || {};
  let name = '';
  if (d.act) {
    name = d.act;
    // A few actions are one name for several things; the second part is code too.
    if ((d.act === 'tab' || d.act === 'go') && d.tab) name += `:${d.tab}`;
    else if (d.act === 'ob-pick' && d.kind) name += `:${d.kind}`;
  } else if (d.tour) name = `tour-${d.tour}`;
  else if (el.tagName === 'DIALOG') name = 'sheet:outside';
  else if (el.closest('#sheet') && el.tagName === 'BUTTON') name = `sheet:${codeName(el.value) || 'button'}`;
  else if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) name = `field:${codeName(el.name) || codeName(el.form?.dataset.form) || codeName(el.type) || 'text'}`;
  else if (el.tagName === 'BUTTON' && el.form?.dataset.form) name = `button:${el.form.dataset.form}`;
  else if (el.tagName === 'A') {
    let path = '';
    try {
      const u = new URL(el.getAttribute('href'), location.href);
      path = u.origin === location.origin ? (u.pathname.split('/').pop() || 'home').replace(/\.html$/, '') : 'external';
    } catch { path = 'other'; }
    name = `link:${codeName(path) || 'other'}`;
  } else name = `${el.tagName.toLowerCase()}${el.id ? `:${el.id}` : ''}`;
  name = codeName(name);
  return EMAIL.test(name) ? '' : name;
}

/** What a press that hit no control landed on: the element's kind and its style name. */
function landedOn(el) {
  if (BACKGROUND.has(el.tagName) || BACKGROUND_IDS.has(el.id)) return '';
  const styled = el.classList.length ? el : el.closest('[class]');
  const cls = styled ? [...styled.classList].map(codeName).find(Boolean) : '';
  return codeName(`${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`);
}

function onPress(ev) {
  const el = ev.target instanceof Element ? ev.target : null;
  if (!el) return;
  touch();
  // The dim area around an open sheet, which closes it.
  const ctl = el.tagName === 'DIALOG' ? el : el.closest(CONTROL);
  // A label hands its press on to its field, which is recorded then.
  if (ctl?.tagName === 'LABEL' && ctl.control) return;
  const name = ctl ? controlName(ctl) : landedOn(el);
  if (!name) return;
  keep(ctl ? 'click' : 'dead_click', name);
  // Presses from a pointer only (ev.detail is 0 for Enter on a button).
  if (!ev.detail) return;
  const target = ctl || el;
  const now = ev.timeStamp;
  if (rage.el === target && now - rage.t <= RAGE.within) {
    rage.n += 1;
    if (rage.n === RAGE.presses) keep('rage_click', name, { value: rage.n });
  } else rage = { el: target, t: now, n: 1 };
}

function onKey() {
  touch();
}

// The sign-up screen's forms, by their code name. Not by the screen: pressing
// Return can take the app past the sign-up screen before the form's own
// submit event arrives.
const signinForm = (el) => !!el?.closest?.('form[data-form^="signin"]');

function onInput(ev) {
  touch();
  // Typing in a field, not ticking the agreement box.
  if (signinForm(ev.target) && ev.target.matches('input:not([type="checkbox"]), textarea')) countStep('signin:started', { demo });
}

function onSubmit(ev) {
  if (signinForm(ev.target)) countStep('signin:submitted', { demo });
}

// ------------------------------------------------------------ errors

/** "typeerror:core.js:120": the error's kind and where in Cadence's code, never its message. */
function errorName(err, file, line) {
  const kind = codeName(err?.name) || 'error';
  let where = '';
  const frame = typeof err?.stack === 'string' ? err.stack.match(/\/([\w.-]+\.m?js):(\d+):\d+/) : null;
  if (frame) where = `${frame[1]}:${frame[2]}`;
  else if (file) {
    try {
      const u = new URL(file, location.href);
      const own = u.origin === location.origin || u.protocol === 'chrome-extension:';
      where = own ? `${u.pathname.split('/').pop()}:${line || 0}` : 'elsewhere';
    } catch { where = 'elsewhere'; }
  }
  return codeName(`${kind}${where ? `:${where}` : ''}`);
}

function onError(ev) {
  // The browser's own notes (a resize loop, a blocked extension) carry no error or file of Cadence's.
  if (!ev.error && !ev.filename) return;
  if (errors++ >= MAX_ERRORS) return;
  keep('error', errorName(ev.error, ev.filename, ev.lineno), { value: Math.round(performance.now()) });
}

function onRejection(ev) {
  if (errors++ >= MAX_ERRORS) return;
  const reason = ev.reason;
  keep('error', errorName(reason instanceof Error ? reason : { name: 'rejection' }), { value: Math.round(performance.now()) });
}

// ------------------------------------------------------------ requests

/** The name a request is timed by, or '' for one that is not Cadence's own (or is this data itself). */
export function requestName(input) {
  let u;
  try { u = new URL(typeof input === 'string' ? input : input?.url || String(input), location.href); } catch { return ''; }
  const site = CONFIG.site?.domain || '';
  if (/^\/api\//.test(u.pathname) && (u.host === location.host || (site && u.host === site))) {
    const what = u.pathname.split('/')[2] || '';
    return what === 'metric' ? '' : codeName(`api:${what}`);
  }
  if (/\.supabase\.co$/.test(u.hostname)) {
    if (u.pathname.startsWith('/auth/')) return 'db:auth';
    const rpc = u.pathname.match(/^\/rest\/v1\/rpc\/([a-z0-9_]+)/);
    return codeName(rpc ? `db:rpc:${rpc[1]}` : 'db:rest');
  }
  return '';
}

function timeRequests() {
  const original = window.fetch;
  if (typeof original !== 'function' || original.cadenceTimed) return;
  const timed = async (input, init) => {
    const name = requestName(input);
    if (!name) return original(input, init);
    const t0 = performance.now();
    try {
      const res = await original(input, init);
      keep('timing', res.ok ? name : `${name}:fail`, { value: performance.now() - t0 });
      return res;
    } catch (err) {
      // A request the app cancelled on purpose is not a failure.
      if (err?.name !== 'AbortError') keep('timing', `${name}:fail`, { value: performance.now() - t0 });
      throw err;
    }
  };
  timed.cadenceTimed = true;
  window.fetch = timed;
}

// ------------------------------------------------------------ the visit

function onHidden() {
  if (document.visibilityState === 'hidden') { credit(); mark = 0; flush(); } else { mark = lastInput = performance.now(); }
}

function onLeave() {
  leave();
  if (visitStarted) keep('session', 'end', { value: Math.min(used, LONGEST) });
  flush();
}

/**
 * Starts watching, once. `screenOf` says which screen is showing, in code
 * characters (src/panel/app.js). Does nothing in the demo or a frame.
 */
export function startInsight({ screenOf: fn, demo: isDemo = false, embedded = false } = {}) {
  if (on || isDemo || embedded) return;
  on = true;
  demo = isDemo;
  screenOf = fn || (() => '');
  mark = lastInput = performance.now();
  document.addEventListener('click', onPress, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('input', onInput, true);
  document.addEventListener('submit', onSubmit, true);
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', onLeave);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  // A sheet opening or closing changes what is on screen without a render.
  const sheet = document.getElementById('sheet');
  if (sheet) new MutationObserver(update).observe(sheet, { attributes: true, attributeFilter: ['open'] });
  timeRequests();
  setInterval(() => { credit(); update(); flush(); }, EVERY);
  update();
}
