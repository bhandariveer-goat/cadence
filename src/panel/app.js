// Cadence — app shell. Views render HTML strings; this file routes between
// them, keeps the header and tabs in sync, and turns clicks into actions.

import {
  app, boot, setRender, go, back, activeTab, runningSession, findSession, syncCanvas, insideCanvas, STANDALONE
} from './core.js';
import { showUpStreak } from '../lib/habits.js';
import { svg, I, mmss, toast, $, isWide, isDesktop } from './ui.js';

import * as today from './views/today.js';
import * as plan from './views/plan.js';
import * as crew from './views/crew.js';
import * as you from './views/you.js';
import * as calendar from './views/calendar.js';
import * as calendars from './views/calendars.js';
import * as commitments from './views/commitments.js';
import * as guide from './views/guide.js';
import * as create from './views/create.js';
import * as onboarding from './views/onboarding.js';
import { openPalette, installShortcuts, shortcutsSheet } from './views/palette.js';
import { checkinPicker } from './views/commitments.js';

const VIEWS = {
  today: today.viewToday,
  calendar: calendar.viewCalendar,
  calendars: calendars.viewCalendars,
  plan: plan.viewPlan,
  crew: crew.viewCrew,
  club: crew.viewClub,
  you: you.viewYou,
  record: you.viewRecord,
  review: you.viewReview,
  availability: you.viewAvailability,
  guide: guide.viewGuide,
  create: create.viewCreate
};

const TABS = {
  student: [['today', 'Today', I.sun], ['calendar', 'Calendar', I.cal], ['plan', 'School', I.list], ['crew', 'Crew', I.users], ['you', 'You', I.you]],
  teacher: [['create', 'Create', I.mic], ['calendar', 'Calendar', I.cal], ['crew', 'Clubs', I.users], ['you', 'You', I.you]]
};

const ACTIONS = {
  ...today.actions, ...plan.actions, ...crew.actions, ...you.actions, ...calendar.actions, ...calendars.actions,
  ...commitments.actions, ...guide.actions, ...create.actions, ...onboarding.actions,
  go: (el) => { if (el.dataset.mode) app.planMode = el.dataset.mode; go(el.dataset.tab); },
  tab: (el) => { if (el.dataset.tab === activeTab() && app.stack.length === 0) { $('#view').scrollTop = 0; return; } go(el.dataset.tab); },
  back: () => back(),
  palette: () => openPalette(),
  shortcuts: () => shortcutsSheet(),
  streak: () => {
    const s = showUpStreak(app.S);
    toast(s.days
      ? `${s.days}-day streak${s.todayDone ? '' : ' — check in today to keep it going'}. ${s.freezes ? `${s.freezes} freeze${s.freezes === 1 ? '' : 's'} ready if you miss a day.` : 'Every 7 days earns a freeze.'}`
      : 'Check in on anything today to start a streak.');
  }
};
const CHANGE = { ...you.changeActions, ...calendars.changeActions };
const SUBMIT = { ...plan.submitActions, ...create.submitActions };

// ------------------------------------------------------------------ render

let rendering = false, again = false;

function renderApp() {
  if (!app.S) return;
  if (rendering) { again = true; return; }
  rendering = true;
  try {
    const S = app.S;
    const onboardingNow = !S.profile.onboarded;
    const teacher = S.settings.role === 'teacher';

    $('#tabs').hidden = onboardingNow;
    $('#btn-sync').hidden = !insideCanvas || onboardingNow;
    $('#btn-sync').classList.toggle('spin', app.syncing);
    $('#btn-close').hidden = STANDALONE;
    renderStreak(onboardingNow || teacher);

    if (onboardingNow) {
      $('#view').innerHTML = onboarding.viewOnboarding();
      return;
    }

    const allowed = teacher ? ['create', 'calendar', 'calendars', 'crew', 'club', 'you', 'guide'] : Object.keys(VIEWS).filter((v) => v !== 'create');
    if (!VIEWS[app.view] || !allowed.includes(app.view)) { app.view = teacher ? 'create' : 'today'; app.stack = []; }

    const tabs = TABS[teacher ? 'teacher' : 'student'];
    const active = activeTab();
    const unseen = (app.crew.nudges || []).some((n) => !n.seen);
    $('#tabs').innerHTML = tabs.map(([id, label, ic]) => `<button class="tab" data-act="tab" data-tab="${id}" ${active === id ? 'aria-current="page"' : ''}>
      ${svg(ic)}<span>${label}</span>${id === 'crew' && unseen ? '<i class="dot-badge"></i>' : ''}</button>`).join('');

    $('#view').innerHTML = VIEWS[app.view]();
    // The week grid covers the whole day; open it where the day actually starts.
    const grid = $('.wg-body');
    if (grid) {
      const first = grid.querySelector('.wg-block');
      const now = grid.querySelector('.wg-now');
      const anchor = now || first;
      if (anchor) grid.scrollTop = Math.max(0, parseFloat(anchor.style.top || 0) - 70);
    }
    renderSide();
    $('#btn-cmd').hidden = !isDesktop();
    restartTimer();
  } finally {
    rendering = false;
    if (again) { again = false; renderApp(); }
  }
}

function renderStreak(hide) {
  const chip = $('#streak');
  if (hide) { chip.hidden = true; return; }
  const s = showUpStreak(app.S);
  chip.hidden = false;
  chip.classList.toggle('lit', s.todayDone);
  chip.setAttribute('aria-label', `${s.days}-day streak${s.freezes ? `, ${s.freezes} freezes` : ''}`);
  chip.innerHTML = `${svg(I.flame, 17)}<span>${s.days}</span>${s.freezes ? `<span class="freeze">${svg(I.snow, 12)}${s.freezes}</span>` : ''}`;
}

const SIDES = { today: today.side, plan: plan.side, calendar: plan.side };

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
  if (onboarding.handleOnboardingClick(ev)) return;
  const el = ev.target.closest('[data-act]');
  if (!el || ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
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
  if (onboarding.handleOnboardingChange(ev)) return;
  const el = ev.target.closest('[data-act]');
  if (el && CHANGE[el.dataset.act]) CHANGE[el.dataset.act](el, ev);
});

document.addEventListener('input', (ev) => {
  if (ev.target.closest('dialog')) return;
  onboarding.handleOnboardingInput(ev);
});

document.addEventListener('submit', (ev) => {
  const form = ev.target.closest('[data-form]');
  if (!form) return;
  ev.preventDefault();
  const fn = SUBMIT[form.dataset.form];
  if (fn) fn(form, new FormData(form));
});

$('#btn-sync').addEventListener('click', () => syncCanvas());
$('#btn-close').addEventListener('click', () => window.parent.postMessage({ type: 'cadence:close' }, '*'));
$('#sheet').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

// Crossing a layout breakpoint changes which views render what.
for (const q of ['(min-width: 768px)', '(min-width: 1180px)']) {
  matchMedia(q).addEventListener('change', () => renderApp());
}

installShortcuts({ checkinPicker });

// The palette runs actions by name rather than reaching into every module.
document.addEventListener('cadence:act', (e) => {
  const { act, id } = e.detail || {};
  const fn = ACTIONS[act];
  if (fn) fn({ dataset: { id, act } });
});

boot();
