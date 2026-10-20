// "Connect your calendars": the first thing a new student sees after signing
// in, and the same dialog later from Calendars.
//
// Step one connects each source with its own link: Canvas (every due date),
// Google Calendar, Outlook and iCloud (busy time). Step two shows what came in
// for the next two weeks, so it is plain that it worked. Calendars are read
// through Cadence's server and kept on this device, never in the account (see
// lib/sources/sources.js and netlify/functions/canvas-feed.mjs).
//
// It is shown once, before the rest of setup, and not again once it has been
// finished or skipped (state.calendarSetupSeen, which cloud adopt() keeps).
// Not for teachers, and not in the demo.

import { app, persist, render, refreshSources, insideCanvas, keepStorage, DEMO, EMBEDDED } from './core.js';
import { svg, I, esc, plural, toast } from './ui.js';
import { looksLikeFeedUrl } from '../lib/sources/canvasFeed.js';
import { looksLikeGoogleIcs, looksLikeOutlookIcs, looksLikeIcloudIcs } from '../lib/sources/sources.js';
import { CONFIG } from '../config.js';

const DAY = 86400000;

const ROWS = [
  {
    id: 'canvasFeed', name: 'Canvas', icon: I.canvas,
    brings: 'Every due date, and new assignments as they are posted',
    field: 'Calendar feed link', placeholder: 'https://school.instructure.com/feeds/calendars/user_….ics',
    how: ['Open Canvas in a browser and go to Calendar.', 'At the bottom right, choose Calendar Feed and copy the link.'],
    note: 'On a phone, use Canvas in your browser: the Canvas app does not show the feed. Treat the link like a password.',
    looksLike: looksLikeFeedUrl,
    wrong: 'That is not a Canvas feed link. It contains /feeds/calendars/ and ends in .ics.'
  },
  {
    id: 'googleFeed', name: 'Google Calendar', icon: I.cal,
    brings: 'Games, shifts and appointments, as busy time',
    field: 'Secret address in iCal format', placeholder: 'https://calendar.google.com/calendar/ical/…/basic.ics',
    how: ['Open Google Calendar on a computer and go to Settings.', 'Choose your calendar on the left, then Integrate calendar.', 'Copy the secret address in iCal format.'],
    note: 'Cadence keeps only each event\'s time and title, on this device.',
    looksLike: looksLikeGoogleIcs,
    wrong: 'That is not the secret iCal address. It starts with https://calendar.google.com/calendar/ical/ and ends in basic.ics.'
  },
  {
    id: 'outlookFeed', name: 'Outlook', icon: I.cal,
    brings: 'An Outlook or school Microsoft calendar, as busy time',
    field: 'Published calendar link (ICS)', placeholder: 'https://outlook.office365.com/owa/calendar/…/calendar.ics',
    how: ['Open Outlook on the web: Settings, Calendar, Shared calendars.', 'Under Publish a calendar, pick the calendar and "Can view when I\'m busy", then Publish.', 'Copy the ICS link.'],
    note: 'Some schools turn publishing off. If the option is missing, skip this one.',
    looksLike: looksLikeOutlookIcs,
    wrong: 'That is not an Outlook ICS link. It contains /owa/calendar/ and ends in calendar.ics.'
  },
  {
    id: 'icloudFeed', name: 'Apple iCloud', icon: I.cal,
    brings: 'The calendar on your iPhone or Mac, as busy time',
    field: 'Public calendar link', placeholder: 'webcal://p01-caldav.icloud.com/published/2/…',
    how: ['In Calendar on iCloud.com or a Mac, open the calendar\'s sharing settings.', 'Turn on Public Calendar and copy the link.'],
    note: 'Anyone with a public calendar link can see that calendar.',
    looksLike: looksLikeIcloudIcs,
    wrong: 'That is not an iCloud public calendar link. It looks like webcal://p01-caldav.icloud.com/published/…'
  }
];

let ui = null;          // { step, open, busy, errors, values, from } while the dialog is up
let closedThisSession = false;

// A source's saved settings, or an empty object before it was ever set up.
const cfgOf = (id) => app.S.sources?.[id] || {};
// Connected means a working link. Inside Canvas, Canvas itself counts as
// connected, since assignments come straight from the page.
const connected = (id) => (id === 'canvasFeed' && insideCanvas) || (!!cfgOf(id).enabled && !!cfgOf(id).url && !cfgOf(id).error);
// Whether the student has connected at least one link of their own.
const anyConnected = () => ROWS.some((r) => connected(r.id) && !(r.id === 'canvasFeed' && insideCanvas));

/** Is it time to show the dialog by itself? Only for a new student, once. */
function due() {
  const S = app.S;
  return !!S && !DEMO && !EMBEDDED && !closedThisSession && !ui
    && S.settings?.role !== 'teacher' && !S.profile?.onboarded && S.calendarSetupSeen !== true
    && !document.querySelector('dialog[open]');
}

/** Called after each render while setup is showing. */
export function maybeStartSetup() {
  if (due()) open({ from: 'onboarding' });
}

/** Open it, from first run or from Calendars. `focus` opens one row straight away. */
export function open({ from = 'calendars', focus = null } = {}) {
  ui = { step: 1, open: focus, busy: null, errors: {}, values: {}, from };
  const dlg = mount();
  paint();
  if (!dlg.open) dlg.showModal();
  const first = focus ? dlg.querySelector(`#su-input-${focus}`) : dlg.querySelector('[data-su="toggle"]');
  first?.focus();
}

/** Adds the setup dialog to the page once, with its handlers. */
function mount() {
  let dlg = document.getElementById('setup');
  if (dlg) return dlg;
  dlg = document.createElement('dialog');
  dlg.id = 'setup';
  dlg.className = 'setup';
  dlg.setAttribute('aria-labelledby', 'su-title');
  document.body.append(dlg);
  // Esc is the same as Skip: it ends setup, it does not lose anything.
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); if (!ui?.busy) finish(); });
  // However it closes (a second Esc can close it without a cancel), setup ends properly.
  dlg.addEventListener('close', () => { if (ui) finish(); });
  dlg.addEventListener('click', onClick);
  dlg.addEventListener('submit', onSubmit);
  // What is typed in an open field is kept across repaints.
  dlg.addEventListener('input', (e) => { if (ui && e.target.matches('input[name="url"]')) ui.values[e.target.dataset.id] = e.target.value; });
  return dlg;
}

// ---------------------------------------------------------------- drawing

/** Redraws the dialog for the step it is on, putting focus back on the
    control that had it, so typing and tabbing are not interrupted. */
function paint() {
  const dlg = document.getElementById('setup');
  if (!dlg || !ui) return;
  const had = document.activeElement?.closest?.('#setup') ? document.activeElement.id : '';
  dlg.innerHTML = ui.step === 1 ? stepOne() : stepTwo();
  if (had) document.getElementById(had)?.focus();
}

// The two steps across the top, with the current one marked.
const steps = () => `<ol class="su-steps" aria-label="Setup steps">
  <li class="${ui.step > 1 ? 'done' : ''}" ${ui.step === 1 ? 'aria-current="step"' : ''}><b>${ui.step > 1 ? svg(I.check, 12) : '1'}</b>Connect calendars</li>
  <li ${ui.step === 2 ? 'aria-current="step"' : ''}><b>2</b>Check what came in</li>
</ol>`;

/** Step one: a row per calendar to connect, the offer of the Chrome
    extension, and the buttons to skip or go on. */
function stepOne() {
  const pending = !!ui.open && !!(ui.values[ui.open] || '').trim() && !connected(ui.open);
  const ready = anyConnected();
  return `<div class="su-body">
    ${steps()}
    <h2 id="su-title">Connect your calendars</h2>
    <p class="lead">Cadence plans around what it can see: what is due, and when you are already busy. Add the ones you use. You can change them later in Calendars.</p>
    <div class="su-list">${ROWS.map(row).join('')}</div>
    ${extensionOffer()}
  </div>
  <div class="su-foot">
    ${ready || pending
      ? `<button type="button" class="btn ghost" data-su="skip" id="su-skip">${ready ? 'Skip the rest' : 'Skip for now'}</button>
         <button type="button" class="btn primary" data-su="next" id="su-next">Next</button>`
      : '<button type="button" class="btn ghost" data-su="skip" id="su-skip">Skip for now</button>'}
  </div>`;
}

/** One calendar's row: its name and status, and when opened, how to find the
    link, a box to paste it into, and any error. */
function row(r) {
  const cfg = cfgOf(r.id);
  const on = connected(r.id);
  const isOpen = ui.open === r.id;
  const busy = ui.busy === r.id;
  const err = ui.errors[r.id] || (cfg.enabled && cfg.error) || '';
  const viaCanvas = r.id === 'canvasFeed' && insideCanvas;
  const status = viaCanvas ? 'Connected through Canvas'
    : busy ? 'Connecting…'
      : on ? `Connected${count(r.id) != null ? `, ${count(r.id)}` : ''}` : '';
  return `<div class="su-row ${on ? 'on' : ''}">
    <div class="su-head">
      <span class="kind-ic sm">${svg(r.icon)}</span>
      <div class="grow"><div class="su-name">${esc(r.name)}</div>
        <div class="su-sub">${status ? `<span class="su-state">${esc(status)}</span>` : esc(r.brings)}</div></div>
      ${viaCanvas ? '' : `<button type="button" class="btn small ${on ? 'ghost' : 'soft'}" data-su="toggle" data-id="${r.id}" id="su-toggle-${r.id}" aria-expanded="${isOpen}" aria-controls="su-form-${r.id}">${isOpen ? 'Close' : on ? 'Change' : 'Connect'}</button>`}
    </div>
    ${isOpen && !viaCanvas ? `<form class="su-form" id="su-form-${r.id}" data-id="${r.id}" novalidate autocomplete="off">
      <ol class="su-how">${r.how.map((h) => `<li>${esc(h)}</li>`).join('')}</ol>
      <label class="field"><span>${esc(r.field)}</span>
        <input type="text" name="url" id="su-input-${r.id}" data-id="${r.id}" value="${esc(ui.values[r.id] ?? cfg.url ?? '')}" placeholder="${esc(r.placeholder)}" spellcheck="false" inputmode="url" ${err ? `aria-invalid="true" aria-describedby="su-err-${r.id}"` : ''}></label>
      ${err ? `<p class="field-error" id="su-err-${r.id}" role="alert">${esc(err)}</p>` : ''}
      <p class="hint">${esc(r.note)}</p>
      <div class="su-actions">
        ${cfg.url ? `<button type="button" class="btn small ghost danger" data-su="remove" data-id="${r.id}" id="su-remove-${r.id}">Remove</button>` : ''}
        <button type="submit" class="btn small ${anyConnected() ? 'soft' : 'primary'}" id="su-save-${r.id}" ${busy ? 'aria-busy="true"' : ''}>${busy ? 'Connecting…' : on ? 'Save link' : `Connect ${esc(r.name)}`}</button>
      </div>
    </form>` : ''}
  </div>`;
}

/** What a source brought in for the next two weeks, in words, or null when not known. */
function count(id) {
  const cfg = cfgOf(id);
  if (!cfg.lastSync) return null;
  const now = Date.now();
  const soon = (iso) => { const t = +new Date(iso); return t >= now - DAY && t <= now + 14 * DAY; };
  if (id === 'canvasFeed') {
    const n = (cfg.assignments || []).filter((a) => a.due && soon(a.due)).length;
    return n ? `${plural(n, 'assignment')} due in the next two weeks` : 'nothing due in the next two weeks yet';
  }
  const n = (cfg.events || []).filter((e) => e.start && soon(e.start)).length;
  return n ? `${plural(n, 'event')} in the next two weeks` : 'no events in the next two weeks';
}

/** Step two: what came in from each connected calendar, and the button to
    carry on (Continue during onboarding, Done otherwise). */
function stepTwo() {
  const done = ROWS.filter((r) => connected(r.id));
  const last = ui.from === 'onboarding' ? 'Continue' : 'Done';
  return `<div class="su-body">
    ${steps()}
    <h2 id="su-title">Here's what came in</h2>
    <p class="lead">Cadence is planning around these now, and new ones arrive on their own.</p>
    <div class="su-list">${done.map((r) => {
      const viaCanvas = r.id === 'canvasFeed' && insideCanvas;
      const what = viaCanvas ? 'Assignments come in from Canvas as you use it' : (count(r.id) || 'Connected');
      return `<div class="su-row on"><div class="su-head">
        <span class="kind-ic sm">${svg(r.icon)}</span>
        <div class="grow"><div class="su-name">${esc(r.name)}</div><div class="su-sub">${esc(what.charAt(0).toUpperCase() + what.slice(1))}</div></div>
        <span class="su-tick" aria-hidden="true">${svg(I.check, 16)}</span>
      </div></div>`;
    }).join('')}</div>
    <p class="hint mt3">Something missing? Go back and check the link, or add it later in Calendars.</p>
  </div>
  <div class="su-foot">
    <button type="button" class="btn ghost" data-su="back" id="su-back">Go back</button>
    <button type="button" class="btn primary" data-su="finish" id="su-finish">${last}</button>
  </div>`;
}

/** On a computer with Chrome, the extension reads more of Canvas than the feed. Only once it is published. */
function extensionOffer() {
  const url = /^https:\/\/chromewebstore\.google\.com\//.test(CONFIG.site?.extensionUrl || '') ? CONFIG.site.extensionUrl : '';
  if (insideCanvas || (typeof chrome !== 'undefined' && chrome.runtime?.id)) return '';
  const desktopChrome = /Chrome\//.test(navigator.userAgent) && !/Mobile|Android|CrOS/.test(navigator.userAgent);
  const chromebook = /CrOS/.test(navigator.userAgent);
  if (!url || !(desktopChrome || chromebook)) return '';
  return `<p class="hint mt3">Using Chrome on this computer? <a href="${esc(url)}" target="_blank" rel="noopener">Add the Cadence extension</a> and it reads Canvas for you, with points and what you have already submitted.</p>`;
}

// ---------------------------------------------------------------- doing

/** Connects a calendar from a pasted link: checks that it looks right, saves
    it, and syncs it once. A link that does not work is not left switched on:
    the source goes back to how it was, and the row says what went wrong.
    Returns whether it worked. */
async function connect(id, raw) {
  const r = ROWS.find((x) => x.id === id);
  if (!r || ui.busy) return false;
  const url = String(raw || '').trim().replace(/^webcal:/i, 'https:');
  ui.values[id] = url;
  ui.errors[id] = '';
  if (!url) { ui.errors[id] = `Paste the link from ${r.name} first.`; paint(); focusInput(id); return false; }
  if (!r.looksLike(url)) { ui.errors[id] = r.wrong; paint(); focusInput(id); return false; }
  ui.busy = id;
  paint();
  // A link that already worked is put back if the new one does not.
  const prev = structuredClone(cfgOf(id));
  const hadWorking = !!(prev.enabled && prev.url && !prev.error);
  const undoChange = () => persist((st) => { st.sources[id] = hadWorking ? prev : { ...st.sources[id], enabled: false, url: '', error: null }; }, { recalc: false });
  let good = false;
  try {
    await persist((st) => { st.sources[id] = { ...(st.sources[id] || {}), url, enabled: true, error: null }; }, { recalc: false });
    const results = await refreshSources({ only: id, quiet: true });
    const res = results?.[id];
    good = !!res?.ok;
    if (good) {
      keepStorage();
      ui.open = null;
      delete ui.values[id];
    } else {
      ui.errors[id] = res?.error || `Cadence could not reach ${r.name}. Check the link and try again.`;
      // A link that does not work is not left switched on.
      await undoChange();
    }
  } catch (e) {
    ui.errors[id] = e?.message || `Cadence could not reach ${r.name}. Try again.`;
    await undoChange().catch(() => {});
  } finally {
    if (ui) {
      ui.busy = null;
      paint();
      if (good) document.getElementById(`su-toggle-${id}`)?.focus();
      else focusInput(id);
    }
  }
  return good;
}

/** Disconnects a calendar from the dialog, with Undo. */
async function remove(id) {
  const prev = structuredClone(cfgOf(id));
  const name = ROWS.find((r) => r.id === id)?.name || 'calendar';
  await persist((st) => { st.sources[id] = { ...st.sources[id], enabled: false, url: '', events: [], assignments: [], error: null }; });
  ui.values[id] = '';
  ui.errors[id] = '';
  paint();
  document.getElementById(`su-toggle-${id}`)?.focus();
  toast(`Removed ${name}`, { label: 'Undo', run: () => persist((st) => { st.sources[id] = prev; }).then(() => paint()) });
}

// Puts the cursor in a row's link box, after an error, so the link can be fixed.
const focusInput = (id) => document.getElementById(`su-input-${id}`)?.focus();

/** A link typed into the open row but not connected yet is connected now rather than lost. */
async function connectPending() {
  const id = ui.open;
  const typed = id ? (document.getElementById(`su-input-${id}`)?.value || '').trim() : '';
  if (!typed || (connected(id) && cfgOf(id).url === typed.replace(/^webcal:/i, 'https:'))) return true;
  return connect(id, typed);
}

/** Closes setup for good: it is not shown by itself again (state.calendarSetupSeen). */
async function finish() {
  closedThisSession = true;
  const dlg = document.getElementById('setup');
  ui = null;
  if (dlg?.open) dlg.close();
  dlg?.remove();
  if (app.S && app.S.calendarSetupSeen !== true) await persist((st) => { st.calendarSetupSeen = true; }, { recalc: false, edit: false });
  render();
}

/** Clicks inside the dialog, by data-su: open or close a row, remove a
    calendar, go on (connecting a link left typed in first; with nothing
    connected, that ends setup), go back, skip or finish. Connecting itself
    is the form's submit (onSubmit). */
async function onClick(ev) {
  const dlg = ev.currentTarget;
  if (ev.target === dlg) return;          // a click on the backdrop does nothing: setup is ended with a button
  const el = ev.target.closest('[data-su]');
  if (!el || !ui || ui.busy) return;
  const id = el.dataset.id;
  switch (el.dataset.su) {
    case 'toggle':
      ui.open = ui.open === id ? null : id;
      ui.errors[id] = '';
      paint();
      if (ui.open) focusInput(id); else document.getElementById(`su-toggle-${id}`)?.focus();
      break;
    case 'remove': return remove(id);
    case 'skip': return finish();
    case 'next': {
      if (!(await connectPending())) return;
      if (!anyConnected()) return finish();
      ui.step = 2;
      ui.open = null;
      paint();
      document.getElementById('su-finish')?.focus();
      break;
    }
    case 'back':
      ui.step = 1;
      paint();
      document.getElementById('su-next')?.focus();
      break;
    case 'finish': return finish();
    default:
  }
}

/** Enter in a link box connects that calendar instead of submitting the page. */
function onSubmit(ev) {
  ev.preventDefault();
  ev.stopPropagation();
  const form = ev.target.closest('form.su-form');
  if (!form || !ui) return;
  connect(form.dataset.id, form.querySelector('input[name="url"]')?.value);
}
