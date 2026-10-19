// The first-run tour: one short stop for each part of the app. A ring goes
// around the control and a small card beside it says what that part is for,
// in one sentence. It shows once, after setup, and can be replayed with the
// 'tour-start' action. Whether it has been seen is part of the plan, so it
// follows the student between devices.

import { app, persist, EMBEDDED } from './core.js';
import { esc } from './ui.js';
import { clamp } from '../lib/util.js';

const STEPS = [
  { sel: '[data-act="tab"][data-tab="today"]', title: 'Today', text: 'What to do next, and what is left today. Press Start block when you sit down to work.' },
  { sel: '[data-act="tab"][data-tab="calendar"]', title: 'Calendar', text: 'Your week in one place: school, practice, plans, and the time set aside for homework.' },
  { sel: '[data-act="tab"][data-tab="plan"]', title: 'School', text: 'Every assignment and how long it should take. Open one to see the steps to finish it.' },
  { sel: '[data-act="tab"][data-tab="activities"]', title: 'Activities', text: 'Practice, clubs, a job. Check in after each one to fill its ring for the week.' },
  { sel: '[data-act="tab"][data-tab="crew"]', title: 'Crew', text: 'Add a friend or join your club so you keep each other on track.' },
  { sel: '#btn-agent', title: 'Ask Cadence', text: 'Day changed? Say it in a sentence, like “I’m tired, an hour tonight”, and your plan moves to fit.' }
];

const PAD = 6;      // how far the ring sits outside the control
const GAP = 12;     // between the ring and the card
const EDGE = 16;    // the card keeps this far from the edges of the window
const RING = 2;     // the ring's width, kept on screen when the control touches an edge
const START_DELAY = 400;
// The regions of the frame (shell.js) that are taken out of reach while the tour is up.
const LOCKED = ['.skip', '#demo-bar', '#top', '#view', '#tabs', '#side', '#agent'];

let tour = null;    // the tour on screen, or null
let timer = 0;      // an automatic start waiting for the page to paint
let done = false;   // finished in this session; the saved flag may still be on its way

// ------------------------------------------------------------ when to show

/** The app itself is on screen (not sign-in or setup), for a student, with no dialog open. */
function clear() {
  const tabs = document.getElementById('tabs');
  return !!app.S && app.S.settings?.role !== 'teacher' && !!tabs && !tabs.hidden && !document.querySelector('dialog[open]');
}

// The homepage shows the demo in a frame; a tour there would pull the visitor's page around.
const due = () => clear() && !!app.S.profile?.onboarded && app.S.tourSeen !== true && !done && !EMBEDDED;

/** Shows the tour from the first stop. Without force, only the first time after setup. */
export function startTour({ force = false } = {}) {
  clearTimeout(timer);
  timer = 0;
  if (tour || !(force ? clear() : due())) return false;
  const first = nextShown(-1, 1);
  // Nothing to point at yet (the panel is still opening, or the assistant
  // covers the app): try again on a later render rather than count it as seen.
  if (first < 0) return false;
  open(first);
  return true;
}

/** Called after every render: starts the tour when it is due, and keeps an open one in place. */
export function maybeStartTour() {
  if (tour) return schedule();
  if (timer || !due()) return;
  timer = setTimeout(() => { timer = 0; startTour(); }, START_DELAY);
}

// ------------------------------------------------------------ the stops

const targetOf = (i) => document.querySelector(STEPS[i].sel);

/** Can the student see this control right now? */
function visible(el) {
  if (!el || !el.isConnected || el.closest('[hidden]')) return false;
  if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true })) return false;
  const r = el.getBoundingClientRect();
  return r.width >= 1 && r.height >= 1 && !underAssistant(el);
}

// On a narrow screen the assistant is a sheet over the whole app, so the
// controls under it are laid out but out of sight.
function underAssistant(el) {
  const pane = document.getElementById('agent');
  return !!pane && !pane.hidden && !pane.contains(el) && getComputedStyle(pane).position === 'fixed';
}

/** The next stop in this direction whose control can be seen, or -1. */
function nextShown(from, dir) {
  for (let i = from + dir; i >= 0 && i < STEPS.length; i += dir) {
    if (visible(targetOf(i))) return i;
  }
  return -1;
}

const shownSteps = () => STEPS.map((_, i) => i).filter((i) => visible(targetOf(i)));

// ------------------------------------------------------------ open and close

function open(i) {
  const root = document.createElement('div');
  root.className = 'tour is-plain';
  // The first stop's words are in place before the card is on the page, so the
  // live region only speaks when the stop changes; the first one is read as the
  // dialog's name and description when Next takes focus.
  root.innerHTML = `
    <div class="tour-halo" aria-hidden="true"></div>
    <div class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-text" tabindex="-1">
      <div aria-live="polite" aria-atomic="true">
        <h2 class="tour-title" id="tour-title">${esc(STEPS[i].title)}</h2>
        <p class="tour-text" id="tour-text">${esc(STEPS[i].text)}</p>
      </div>
      <div class="tour-foot">
        <span class="tour-count"></span>
        <button type="button" class="btn ghost small" data-tour="skip">Skip tour</button>
        <button type="button" class="btn ghost small" data-tour="back">Back</button>
        <button type="button" class="btn primary small" data-tour="next">Next</button>
      </div>
    </div>`;
  const q = (sel) => root.querySelector(sel);
  tour = {
    i, root, el: null, raf: 0,
    before: document.activeElement,
    inert: new Map(),
    halo: q('.tour-halo'), card: q('.tour-card'), title: q('.tour-title'), text: q('.tour-text'), count: q('.tour-count'),
    skip: q('[data-tour="skip"]'), back: q('[data-tour="back"]'), next: q('[data-tour="next"]'),
    observer: new MutationObserver(onMutate),
    listeners: []
  };
  tour.listeners = [
    [window, 'keydown', onKey, true],
    [window, 'resize', schedule, false],
    [document, 'scroll', schedule, true],
    [document, 'focusin', onFocus, false],
    [document, 'close', schedule, true],      // a dialog that opened over the tour has gone
    [root, 'mousedown', onPress, false],
    [tour.card, 'click', onClick, false]
  ];

  document.body.appendChild(root);
  lockPage();
  for (const [target, type, fn, capture] of tour.listeners) target.addEventListener(type, fn, capture);
  // A render can replace the tabs, hide them behind the sign-in screen, or
  // hand the page its focus back (views/agent.js sets inert on every render).
  tour.observer.observe(document.getElementById('root') || document.body,
    { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'inert'] });
  place();
  tour?.next.focus({ preventScroll: true });
}

/** Done, Skip and Escape all end here, and the tour is not offered again. */
function finish() {
  if (!tour) return;
  close();
  done = true;
  // Housekeeping, not an edit: it goes up with the next real change, and
  // closing a tour can never look like a change made while the account's
  // plan was still loading (which would ask which plan to keep).
  if (app.S && app.S.tourSeen !== true) persist((st) => { st.tourSeen = true; }, { recalc: false, edit: false }).catch(() => {});
}

function close() {
  const t = tour;
  tour = null;
  cancelAnimationFrame(t.raf);
  t.observer.disconnect();
  for (const [target, type, fn, capture] of t.listeners) target.removeEventListener(type, fn, capture);
  t.root.remove();
  for (const [el, was] of t.inert) if (el.inert !== was) el.inert = was;
  const prev = t.before;
  if (prev && prev !== document.body && prev.isConnected && typeof prev.focus === 'function') prev.focus({ preventScroll: true });
}

/** Takes the rest of the page out of reach, remembering how each part was. */
function lockPage() {
  for (const sel of LOCKED) {
    const el = document.querySelector(sel);
    if (!el) continue;
    if (!tour.inert.has(el)) tour.inert.set(el, el.inert);
    // Only when it changes: setting it again would wake the observer for nothing.
    if (!el.inert) el.inert = true;
  }
}

// ------------------------------------------------------------ moving between stops

function step(dir) {
  const j = nextShown(tour.i, dir);
  if (j >= 0) { tour.i = j; place(); }
  else if (dir > 0) finish();
}

function schedule() {
  if (!tour || tour.raf) return;
  tour.raf = requestAnimationFrame(() => {
    if (!tour) return;
    tour.raf = 0;
    place();
  });
}

/** Puts the ring around the current stop's control and the card beside it. */
function place() {
  // A dialog that opened over the tour has the student's attention; wait for it to close.
  if (!tour || document.querySelector('dialog[open]')) return;
  if (!visible(targetOf(tour.i))) {
    // Its control went away mid-tour (the layout changed, or the sign-in
    // screen came back). Move to the nearest stop that can still be seen.
    const ahead = nextShown(tour.i, 1);
    const k = ahead >= 0 ? ahead : nextShown(tour.i, -1);
    if (k < 0) return finish();
    tour.i = k;
  }
  const el = targetOf(tour.i);
  if (el !== tour.el) {
    tour.el = el;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  paint();

  const { root, halo, card } = tour;
  const vw = document.documentElement.clientWidth || innerWidth;
  const vh = document.documentElement.clientHeight || innerHeight;
  const r = el.getBoundingClientRect();
  const x1 = clamp(r.left - PAD, RING, vw - RING), x2 = clamp(r.right + PAD, RING, vw - RING);
  const y1 = clamp(r.top - PAD, RING, vh - RING), y2 = clamp(r.bottom + PAD, RING, vh - RING);
  halo.style.transform = `translate(${Math.round(x1)}px, ${Math.round(y1)}px)`;
  halo.style.width = `${Math.round(x2 - x1)}px`;
  halo.style.height = `${Math.round(y2 - y1)}px`;

  const w = card.offsetWidth, h = card.offsetHeight;
  const below = r.bottom + PAD + GAP + h <= vh - EDGE;
  const y = clamp(below ? r.bottom + PAD + GAP : r.top - PAD - GAP - h, EDGE, Math.max(EDGE, vh - h - EDGE));
  const x = clamp(r.left + r.width / 2 - w / 2, EDGE, Math.max(EDGE, vw - w - EDGE));
  card.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;

  if (root.classList.contains('is-plain')) {
    root.classList.remove('is-plain');
    // The first position is drawn as it is; only moves after it are animated.
    void root.offsetWidth;
    root.classList.add('is-live');
  }
}

/** Writes the current stop into the card. Unchanged text is left alone, so the live region stays quiet. */
function paint() {
  const { i, title, text, count, skip, back, next } = tour;
  const shown = shownSteps();
  const at = shown.indexOf(i);
  const last = at === shown.length - 1;
  setText(title, STEPS[i].title);
  setText(text, STEPS[i].text);
  setText(count, `${at + 1} of ${shown.length}`);
  setText(next, last ? 'Done' : 'Next');
  // Back goes on the first stop and Skip on the last; focus on either moves to Next.
  const first = at <= 0;
  const focused = [skip, back].find((b) => b === document.activeElement);
  if (skip.hidden !== last) skip.hidden = last;
  if (back.hidden !== first) back.hidden = first;
  if (focused?.hidden) next.focus({ preventScroll: true });
}

function setText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}

// ------------------------------------------------------------ input

function onClick(e) {
  const b = e.target.closest('[data-tour]');
  if (!b) return;
  if (b.dataset.tour === 'skip') finish();
  else step(b.dataset.tour === 'back' ? -1 : 1);
}

// Clicks on the dim layer do nothing, and do not take focus out of the card.
function onPress(e) {
  if (tour && !tour.card.contains(e.target)) e.preventDefault();
}

// Every key stops here while the tour is up, so the app's own shortcuts (a
// letter to change tab, Cmd K) cannot open things behind it. Enter and Space
// still press the focused button. A dialog that opened over the tour keeps its keys.
function onKey(e) {
  if (!tour || e.target.closest?.('dialog[open]')) return;
  e.stopPropagation();
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === 'Tab') return trap(e);
  if (e.key === 'Escape') { e.preventDefault(); finish(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
}

/** Tab and Shift+Tab go round the card's buttons and never leave it. */
function trap(e) {
  const items = [tour.skip, tour.back, tour.next].filter((b) => !b.hidden);
  const first = items[0], last = items[items.length - 1];
  const at = document.activeElement;
  if (!items.includes(at)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
  else if (e.shiftKey && at === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
}

function onFocus(e) {
  if (!tour || tour.root.contains(e.target) || e.target.closest?.('dialog[open]')) return;
  tour.next.focus({ preventScroll: true });
}

function onMutate(records) {
  if (!tour || records.every((r) => tour.root.contains(r.target))) return;
  lockPage();
  schedule();
}
