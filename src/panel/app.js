// Cadence: the app shell. Views render HTML strings; this file mounts the
// frame, routes between views, keeps the header and tabs in sync, and turns
// clicks into actions.

import { mountShell } from './shell.js';
import {
  app, boot, setRender, go, back, push, activeTab, runningSession, findSession, syncCanvas, insideCanvas, STANDALONE, DEMO, EMBEDDED, signedIn, planConflict, pendingInvite
} from './core.js';
import { showUpStreak } from '../lib/habits.js';
import { svg, I, mmss, toast, $, isWide, isDesktop, esc, installTips, installFieldHelpers } from './ui.js';

import * as today from './views/today.js';
import * as plan from './views/plan.js';
import * as crew from './views/crew.js';
import * as activities from './views/activities.js';
import * as account from './views/account.js';
import * as signin from './views/signin.js';
import * as calendar from './views/calendar.js';
import * as calendars from './views/calendars.js';
import * as commitments from './views/commitments.js';
import * as guide from './views/guide.js';
import * as create from './views/create.js';
import * as onboarding from './views/onboarding.js';
import * as agent from './views/agent.js';
import * as memory from './views/memory.js';
import { openPalette, installShortcuts, shortcutsSheet } from './views/palette.js';
import { maybeStartTour, startTour } from './tour.js';
import { maybeStartSetup, open as openSetup } from './setup.js';
import { checkinPicker } from './views/commitments.js';

mountShell();
document.body.classList.toggle('web', STANDALONE);
document.body.classList.toggle('embedded', EMBEDDED);

const VIEWS = {
  today: today.viewToday,
  calendar: calendar.viewCalendar,
  calendars: calendars.viewCalendars,
  plan: plan.viewPlan,
  activities: activities.viewActivities,
  record: activities.viewRecord,
  review: activities.viewReview,
  crew: crew.viewCrew,
  club: crew.viewClub,
  account: account.viewAccount,
  memory: memory.viewMemory,
  guide: guide.viewGuide,
  create: create.viewCreate
};

const TABS = {
  student: [['today', 'Today', I.sun], ['calendar', 'Calendar', I.cal], ['plan', 'School', I.list], ['activities', 'Activities', I.star], ['crew', 'Crew', I.users]],
  teacher: [['create', 'Create', I.mic], ['calendar', 'Calendar', I.cal], ['crew', 'Clubs', I.users]]
};

const ACTIONS = {
  ...today.actions, ...plan.actions, ...crew.actions, ...activities.actions, ...account.actions, ...signin.actions,
  ...calendar.actions, ...calendars.actions, ...commitments.actions, ...guide.actions, ...create.actions,
  ...onboarding.actions, ...agent.actions, ...memory.actions,
  go: (el) => { if (el.dataset.mode) app.planMode = el.dataset.mode; go(el.dataset.tab); },
  tab: (el) => { if (el.dataset.tab === activeTab() && app.stack.length === 0) { $('#view').scrollTop = 0; return; } go(el.dataset.tab); },
  back: () => back(),
  palette: () => openPalette(),
  'tour-start': () => startTour({ force: true }),
  'calendar-setup': (el) => openSetup({ from: 'calendars', focus: el?.dataset?.id || null }),
  shortcuts: () => shortcutsSheet(),
  'theme-toggle': () => window.CadenceTheme?.set(window.CadenceTheme.current() === 'dark' ? 'light' : 'dark'),
  streak: () => {
    const s = showUpStreak(app.S);
    toast(s.days
      ? `${s.days}-day streak${s.todayDone ? '' : '. Check in today to keep it going'}. ${s.freezes ? `${s.freezes} freeze${s.freezes === 1 ? '' : 's'} ready if you miss a day.` : 'Every 7 days earns a freeze.'}`
      : 'Check in on anything today to start a streak.');
  }
};
const CHANGE = { ...activities.changeActions, ...account.changeActions, ...calendars.changeActions, ...memory.changeActions };
const SUBMIT = { ...plan.submitActions, ...create.submitActions, ...agent.submitActions, ...signin.submitActions, ...calendar.submitActions, ...memory.submitActions, ...onboarding.submitActions };

// ------------------------------------------------------------------ render

let rendering = false, again = false;

function renderApp() {
  if (!app.S) return;
  if (rendering) { again = true; return; }
  rendering = true;
  try {
    const S = app.S;
    const teacher = S.settings.role === 'teacher';
    // Signed out, or signed in with an unanswered "which plan?": both are the sign-in screen.
    // Adding an email to an account that already exists on this device shows
    // the same screen, without signing that account out first.
    const gate = !signedIn() || planConflict() || app.signin?.upgrading || app.signin?.step === 'name' ? 'signin' : (!S.profile.onboarded && !teacher) ? 'onboarding' : null;

    $('#demo-bar').hidden = !DEMO || EMBEDDED;
    if (DEMO) $('#demo-exit').href = signin.pageUrl('app.html');
    $('#tabs').hidden = !!gate;
    $('#btn-sync').hidden = !insideCanvas || !!gate;
    $('#btn-sync').classList.toggle('spin', app.syncing);
    $('#btn-close').hidden = STANDALONE;
    $('#btn-cmd').hidden = !isDesktop() || !!gate;
    renderStreak(!!gate || teacher);
    renderTheme();
    renderAccount(!!gate);
    const ask = $('#btn-agent');
    ask.hidden = !!gate || teacher;
    ask.setAttribute('aria-pressed', String(!!app.agent?.open));

    if (gate) {
      $('#side').hidden = true;
      $('#agent').hidden = true;
      document.body.classList.remove('agent-open');
      $('#view').innerHTML = gate === 'signin' ? signin.viewSignIn() : onboarding.viewOnboarding();
      // A new student connects their calendars first, in a dialog over setup.
      if (gate === 'onboarding') maybeStartSetup();
      return;
    }

    const allowed = teacher ? ['create', 'calendar', 'calendars', 'crew', 'club', 'account', 'guide'] : Object.keys(VIEWS).filter((v) => v !== 'create');
    if (!VIEWS[app.view] || !allowed.includes(app.view)) { app.view = teacher ? 'create' : 'today'; app.stack = []; }

    const tabs = TABS[teacher ? 'teacher' : 'student'];
    const active = activeTab();
    const unseen = (app.crew.nudges || []).some((n) => !n.seen);
    $('#tabs').innerHTML = tabs.map(([id, label, ic]) => `<button class="tab" data-act="tab" data-tab="${id}" ${active === id ? 'aria-current="page"' : ''}>
      ${svg(ic)}<span>${label}</span>${id === 'crew' && unseen ? '<i class="dot-badge" role="img" aria-label="New"></i>' : ''}</button>`).join('');

    $('#view').innerHTML = VIEWS[app.view]();
    // An invite link opened before signing in is offered once the app is up.
    if (!DEMO && pendingInvite()) setTimeout(() => crew.offerPendingInvite(), 0);
    // The short tour of the tabs, once, the first time the app is up after setup.
    maybeStartTour();
    // The week grid covers the whole day; open it where the day actually starts.
    const grid = $('.wg-body');
    if (grid) {
      const first = grid.querySelector('.wg-block');
      const now = grid.querySelector('.wg-now');
      const anchor = now || first;
      if (anchor) grid.scrollTop = Math.max(0, parseFloat(anchor.style.top || 0) - 70);
    }
    renderSide();
    agent.render();
    restartTimer();
  } finally {
    rendering = false;
    if (again) { again = false; renderApp(); }
  }
}

function renderStreak(hide) {
  const chip = $('#streak');
  const s = hide ? null : showUpStreak(app.S);
  // An empty streak is not worth a place in the header.
  if (!s || !s.days) { chip.hidden = true; return; }
  chip.hidden = false;
  chip.classList.toggle('lit', s.todayDone);
  chip.setAttribute('aria-label', `${s.days}-day streak${s.freezes ? `, ${s.freezes} freezes` : ''}`);
  chip.dataset.tip = `${s.days}-day streak`;
  chip.innerHTML = `${svg(I.flame, 16)}<span>${s.days}</span>`;
}

/** Light or dark, one click away where the header has room for it. The same
    choice, with "match this device" as well, is under Account > Appearance. */
function renderTheme() {
  const btn = $('#btn-theme');
  const T = window.CadenceTheme;
  btn.hidden = !T || !isDesktop();
  if (btn.hidden) return;
  const dark = T.current() === 'dark';
  const label = dark ? 'Switch to light theme' : 'Switch to dark theme';
  btn.innerHTML = svg(dark ? I.sun : I.moon, 18);
  btn.dataset.tip = label;
  btn.setAttribute('aria-label', label);
}

function renderAccount(hide) {
  const btn = $('#btn-account');
  btn.hidden = hide;
  if (hide) return;
  const name = app.S.account?.name || app.S.profile.name || '';
  const initials = name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '?';
  btn.textContent = initials;
  btn.dataset.tip = 'Account and settings';
  btn.setAttribute('aria-label', name ? `${name}: account and settings` : 'Account and settings');
}

const SIDES = { today: today.side, plan: () => plan.side('school'), calendar: () => plan.side('week') };

/** The right pane only exists on wide screens; views opt in by exporting side(). */
function renderSide() {
  const el = $('#side');
  const fn = SIDES[app.view];
  const html = isWide() && fn ? fn() : '';
  el.innerHTML = html;
  el.hidden = !html;
}

let tick = null;
function restartTimer() {
  clearInterval(tick);
  const cur = runningSession();
  if (!cur || !$('#timer')) return;
  const id = cur.id;
  tick = setInterval(() => {
    const node = $('#timer');
    const s = findSession(app.S, id);
    if (!node || !s?.startedAt) return clearInterval(tick);
    node.textContent = mmss(Math.max(0, s.minutes * 60 - Math.floor((Date.now() - +new Date(s.startedAt)) / 1000)));
  }, 1000);
}

setRender(renderApp);

// ------------------------------------------------------------------ events

document.addEventListener('click', (ev) => {
  if (ev.target.closest('dialog')) return;
  const el = ev.target.closest('[data-act]');
  if (!el || ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  if (el.tagName === 'A') ev.preventDefault();
  if (el.tagName === 'BUTTON' && el.type === 'submit' && !el.closest('form[data-form]')) ev.preventDefault();
  fn(el, ev);
});

document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter' && ev.key !== ' ') return;
  const el = ev.target.closest?.('[role="button"][data-act]');
  if (el && el === ev.target) { ev.preventDefault(); el.click(); }
});

document.addEventListener('change', (ev) => {
  if (ev.target.closest('dialog')) return;
  const el = ev.target.closest('[data-act]');
  if (el && CHANGE[el.dataset.act]) CHANGE[el.dataset.act](el, ev);
});

document.addEventListener('input', (ev) => {
  if (ev.target.closest('dialog')) return;
  onboarding.handleOnboardingInput(ev);
});

// Fields are checked when they are left, never while they are being typed in,
// and the message goes as soon as the field is changed. Submit is always
// clickable: with something missing it says what, next to the field, and puts
// the cursor there. The message stays while the cursor arrives (focus alone
// does not clear it, or pointing at the field would erase what it was being
// pointed at for). The browser's own bubbles are turned off (novalidate is
// set as forms appear) so errors have one voice, in one place.
const fieldMessage = (el) => (el.validity.valid ? '' : (el.dataset.error || (el.validity.valueMissing ? 'Fill this in to go on.' : 'Check this and try again.')));
function clearFieldError(el) {
  if (el.getAttribute('aria-invalid') !== 'true') return;
  el.removeAttribute('aria-invalid');
  el.removeAttribute('aria-describedby');
  el.parentElement?.querySelector('.field-error')?.remove();
}
function showFieldError(el) {
  clearFieldError(el);
  const msg = fieldMessage(el);
  if (!msg) return false;
  const p = document.createElement('p');
  p.className = 'field-error';
  p.id = `err-${el.name || 'field'}`;
  p.setAttribute('role', 'alert');
  p.textContent = msg;
  el.setAttribute('aria-invalid', 'true');
  el.setAttribute('aria-describedby', p.id);
  el.insertAdjacentElement('afterend', p);
  return true;
}
const checked = (el) => el.matches?.('input, select, textarea') && el.willValidate && !!el.closest('form');
// Leaving a field by pressing a button: the check waits until the press is
// over. A message appearing under the field moves everything below it, and a
// button that moves between the press and the release never gets its click.
// (mousedown and mouseup, because a tap produces those too, and it is on
// mousedown that focus leaves the field.)
let pressing = false;
document.addEventListener('mousedown', () => { pressing = true; }, true);
document.addEventListener('mouseup', () => { pressing = false; }, true);
document.addEventListener('keydown', () => { pressing = false; }, true);
window.addEventListener('blur', () => { pressing = false; });
document.addEventListener('focusout', (ev) => {
  const el = ev.target;
  if (!checked(el) || el.value === '') return;
  const check = () => { if (el.isConnected && el.value !== '') showFieldError(el); };
  if (!pressing) return check();
  // The click, if there is one, is sent straight after mouseup; this runs after it.
  document.addEventListener('mouseup', () => setTimeout(check, 0), { capture: true, once: true });
});
document.addEventListener('input', (ev) => { if (checked(ev.target)) clearFieldError(ev.target); });
new MutationObserver(() => { for (const f of document.querySelectorAll('form:not([novalidate])')) f.noValidate = true; })
  .observe(document.documentElement, { childList: true, subtree: true });

/** True when every field is fine; otherwise marks them and focuses the first. */
function formIsValid(form) {
  const bad = [...form.elements].filter((el) => el.willValidate && showFieldError(el));
  if (bad.length) { bad[0].focus(); bad[0].scrollIntoView({ block: 'center' }); }
  return !bad.length;
}

document.addEventListener('submit', (ev) => {
  const form = ev.target.closest('form');
  if (!form) return;
  // A sheet's Cancel always works, whatever state the fields are in.
  const leaving = ev.submitter?.value === 'cancel' || ev.submitter?.hasAttribute('formnovalidate');
  if (!leaving && !formIsValid(form)) { ev.preventDefault(); ev.stopImmediatePropagation(); return; }
  if (!form.dataset.form) return;
  ev.preventDefault();
  const fn = SUBMIT[form.dataset.form];
  if (fn) fn(form, new FormData(form));
}, true);

$('#btn-sync').addEventListener('click', () => syncCanvas());
$('#btn-close').addEventListener('click', () => window.parent.postMessage({ type: 'cadence:close' }, '*'));
$('#sheet').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

// Crossing a layout breakpoint changes which views render what.
for (const q of ['(min-width: 768px)', '(min-width: 1180px)']) {
  matchMedia(q).addEventListener('change', () => renderApp());
}

installShortcuts({ checkinPicker });
agent.installAgentInput();
installTips();
installFieldHelpers();

// The theme can change from here, from another tab, or with the system at
// sunset. The header button always follows; the page is redrawn only when it
// is the one that shows the choice, so nothing being typed elsewhere is lost.
document.addEventListener('cadence:theme', () => {
  renderTheme();
  if (app.S && app.view === 'account' && signedIn()) renderApp();
});

// The palette runs actions by name rather than reaching into every module.
document.addEventListener('cadence:act', (e) => {
  const { act, ...rest } = e.detail || {};
  const fn = ACTIONS[act];
  if (fn) fn({ dataset: { act, ...rest } });
});

boot().then(() => {
  if (app.linkProblem) { toast(app.linkProblem); app.linkProblem = null; }
  // In the homepage's frame, the demo shows itself around (autoplay.js).
  if (EMBEDDED) import('./autoplay.js').then((m) => m.startAutoplay());
});
