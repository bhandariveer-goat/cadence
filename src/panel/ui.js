// Shared UI vocabulary: icons, rings, sheets, toasts, and the small formatting
// helpers every view needs. No state lives here.

import { fmtTime, fmtClock, fmtDay, startOfDay, atTime, clamp, escapeHtml, DAY, MIN } from '../lib/util.js';

export const esc = escapeHtml;

/** Layout tiers: phone/extension panel < 768 <= desktop < 1180 <= wide (side pane). */
export const isDesktop = () => matchMedia('(min-width: 768px)').matches;
export const isWide = () => matchMedia('(min-width: 1180px)').matches;
export const $ = (sel, root = document) => root.querySelector(sel);

// ------------------------------------------------------------------ icons
// One family: 24px grid, 1.75px rounded strokes.

export const svg = (inner, size) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${size ? ` width="${size}" height="${size}"` : ''}>${inner}</svg>`;

export const I = {
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3.5 7l8.5 6 8.5-6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>',
  cal: '<rect x="3" y="4.5" width="18" height="16" rx="3.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.3-5.5 6.5-5.5s5.7 2 6.5 5.5"/><circle cx="17" cy="9" r="2.6"/><path d="M16.6 14.6c2.6.3 4.3 2.1 4.9 5"/>',
  you: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.6-4 4.6-6 8-6s6.4 2 8 6"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5" stroke-width="2.5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  send: '<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/>',
  sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  left: '<path d="M15 5l-7 7 7 7"/>',
  right: '<path d="M9 5l7 7-7 7"/>',
  down: '<path d="M5 9l7 7 7-7"/>',
  repeat: '<path d="M17 2.5l3 3-3 3"/><path d="M4 11.5v-1a5 5 0 0 1 5-5h11M7 21.5l-3-3 3-3"/><path d="M20 12.5v1a5 5 0 0 1-5 5H4"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20"/>',
  canvas: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>',
  pin: '<path d="M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3z"/>',
  swap: '<path d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>',
  reset: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  page: '<rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  video: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10.5 9.5v5l4-2.5z" fill="currentColor"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z"/>',
  quiz: '<rect x="5" y="4" width="14" height="17" rx="2.5"/><path d="M9 4.5V3h6v1.5M9 11l1.5 1.5L13 10M9 16h6"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  flame: '<path d="M12 21.5c4 0 7-2.7 7-6.6 0-3.2-2-5.6-3.8-7.5-.5 2-1.5 3.3-2.9 3.8.3-3.3-1-6.4-3.9-9.2-.4 3.7-4.4 6.4-4.4 11.6 0 4.8 3.6 7.9 8 7.9z"/>',
  snow: '<path d="M12 2.5v19M4.2 7l15.6 10M19.8 7L4.2 17"/><path d="M9.2 4l2.8 1.8L14.8 4M9.2 20l2.8-1.8 2.8 1.8"/>',
  heart: '<path d="M12 20.5s-8-4.6-8-10.7A4.8 4.8 0 0 1 12 6.6a4.8 4.8 0 0 1 8 3.2c0 6.1-8 10.7-8 10.7z"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  run: '<circle cx="15" cy="4.5" r="2"/><path d="M5 12.5l3.5-3.5 4 .5 2.5 3.5 3 .5"/><path d="M12.5 9.5l-2.5 5 3.5 2.5-1 4.5M10 14.5l-3 6.5"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2.5"/><path d="M8.5 7V5.5A2.5 2.5 0 0 1 11 3h2a2.5 2.5 0 0 1 2.5 2.5V7M3 12.5h18"/>',
  spark: '<path d="M12 2.5l2.3 6.2L20.5 11l-6.2 2.3L12 19.5l-2.3-6.2L3.5 11l6.2-2.3z"/>',
  leaf: '<path d="M5 20c0-8.8 5.8-14.5 15-15.5C19 13.8 13.8 20 5 20z"/><path d="M5 20l7.5-7.5"/>',
  star: '<path d="M12 3l2.8 5.8 6.2.9-4.5 4.4 1.1 6.2L12 17.4l-5.6 2.9 1.1-6.2L3 9.7l6.2-.9z"/>',
  school: '<path d="M2 9.5l10-5 10 5-10 5z"/><path d="M6.5 11.8v4.7c2.5 2.3 8.5 2.3 11 0v-4.7M22 9.5v5"/>',
  bell: '<path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15z"/><path d="M10 21h4"/>',
  trophy: '<path d="M7.5 4h9v5a4.5 4.5 0 0 1-9 0z"/><path d="M7.5 6H4.5a3 3 0 0 0 3 4M16.5 6h3a3 3 0 0 1-3 4M12 13.5v4M8 21h8M9.5 17.5h5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  edit: '<path d="M4 20h4.5L19.5 9 15 4.5 4 15.5z"/><path d="M13 6.5l4.5 4.5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  up: '<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>',
  thumb: '<path d="M7 10.5v10H4v-10z"/><path d="M7 10.5l4.2-7.5c1.6 0 2.6 1.2 2.3 2.8l-.7 3.7h5.7a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.3 20.5H7"/>',
  bolt: '<path d="M13 2.5L4.5 14h6.5l-1 7.5L18.5 10H12z"/>',
  list: '<path d="M10 6h10M10 12h10M10 18h10"/><path d="M3.5 6l1.5 1.5L7.5 5M3.5 12l1.5 1.5L7.5 11M3.5 18l1.5 1.5L7.5 17"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'
};

export const KIND_ICON = {
  practice: I.music, sport: I.run, club: I.users, service: I.heart, work: I.briefcase,
  project: I.spark, study: I.book, wellness: I.leaf, custom: I.star, school: I.school
};

// ---------------------------------------------------------------- visuals

/** A progress ring. Colors go through style="" because SVG attributes can't read CSS variables. */
export function ring({ pct = 0, color = 'var(--k-activity)', size = 64, stroke = 7, inner = '', label = '' } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = clamp(pct, 0, 1);
  return `<span class="ring${p >= 1 ? ' closed' : ''}" style="width:${size}px;height:${size}px;--rc:${color}" role="img" aria-label="${esc(label)}">
    <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" style="stroke:var(--ring-track)" stroke-width="${stroke}"/>
      <circle class="ring-fill" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" style="stroke:${color}" stroke-width="${stroke}"
        stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - p)).toFixed(2)}"
        transform="rotate(-90 ${size / 2} ${size / 2})"/>
    </svg>
    <span class="ring-in">${inner}</span>
  </span>`;
}

/**
 * Initials in a circle, tinted with the person's own colour when they have
 * one, so a crew of five is not five identical grey dots. The colour is only
 * ever a #rrggbb value; anything else falls back to grey.
 */
export function avatar(person = {}, size = 36) {
  const initials = String(person?.name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const type = size < 34 ? 12 : size < 50 ? 14 : 16;
  const tint = /^#[0-9a-f]{6}$/i.test(String(person?.color || '')) ? `;--pc:${person.color}` : '';
  return `<span class="avatar${tint ? ' tinted' : ''}" style="width:${size}px;height:${size}px;font-size:${type}px${tint}">${esc(initials)}</span>`;
}

const ACTIVITY_KINDS = new Set(['practice', 'sport', 'club', 'service', 'work', 'study', 'project', 'wellness']);

/** The colour of one activity, from what kind of activity it is (the --a tokens). */
export const activityColor = (c) => `var(--a-${ACTIVITY_KINDS.has(c?.kind) ? c.kind : 'custom'})`;

/**
 * Colour says what kind of thing something is, and there are four kinds (see
 * the --k tokens in panel.css). Homework is always the work colour; it used to
 * get a different hue per course, which made a list of six assignments six
 * colours for no reason a reader could use.
 */
export const colorFor = () => 'var(--k-work)';

// ---------------------------------------------------------- sheet & toast

/**
 * An overlay that asks for something. Resolves with FormData (including the
 * pressed button's name and value) or null.
 *
 * It is one of two things, decided by what is in it. With fields it is a
 * sheet: a short form, beside the page on a wide screen and rising from the
 * bottom on a narrow one. With no fields it is a question, shown as a small
 * dialog in the middle, and the way out of it is what has focus when it opens.
 * The browser's own <dialog> keeps focus inside and hands it back on close.
 */
const FIELDS = 'input:not([type=hidden]), select, textarea, .choices, .feel, .stepper, .days, .tiles';
export function sheet(html, { onMount } = {}) {
  const dlg = $('#sheet');
  const form = $('#sheet-form');
  form.innerHTML = `<div class="grab" aria-hidden="true"></div>${html}`;
  const confirm = !form.querySelector(FIELDS);
  dlg.classList.toggle('confirm', confirm);
  const heading = form.querySelector('h2');
  if (heading) { heading.id = 'sheet-title'; dlg.setAttribute('aria-labelledby', 'sheet-title'); } else dlg.removeAttribute('aria-labelledby');
  let submitter = null;
  const onSubmit = (e) => { submitter = e.submitter; };
  form.addEventListener('submit', onSubmit);
  dlg.showModal();
  if (confirm) form.querySelector('button[value="cancel"]')?.focus();
  onMount?.(form);
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => {
      form.removeEventListener('submit', onSubmit);
      if (!submitter || submitter.value === 'cancel') return resolve(null);
      const fd = new FormData(form);
      if (submitter.name) fd.set(submitter.name, submitter.value);
      resolve(fd);
    }, { once: true });
  });
}

/**
 * Names for controls that are only an icon. Anything with data-tip gets its
 * name beside it on hover and on keyboard focus, with its shortcut if it has
 * one (data-kbd). The title attribute is not used for this: it is slow, it
 * cannot show a key, and it never appears for someone using a keyboard.
 */
export function installTips() {
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.setAttribute('role', 'tooltip');
  tip.id = 'tip';
  tip.hidden = true;
  document.body.appendChild(tip);
  let owner = null;

  const hide = () => {
    if (!owner) return;
    owner.removeAttribute('aria-describedby');
    owner = null;
    tip.classList.remove('on');
    tip.hidden = true;
  };
  const show = (el) => {
    if (el === owner) return;
    hide();
    owner = el;
    tip.innerHTML = `<span>${esc(el.dataset.tip)}</span>${el.dataset.kbd ? `<kbd>${esc(el.dataset.kbd)}</kbd>` : ''}`;
    tip.hidden = false;
    el.setAttribute('aria-describedby', 'tip');
    const r = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const below = r.bottom + 8 + t.height < innerHeight;
    tip.style.top = `${Math.round(below ? r.bottom + 8 : r.top - t.height - 8)}px`;
    tip.style.left = `${Math.round(clamp(r.left + r.width / 2 - t.width / 2, 8, innerWidth - t.width - 8))}px`;
    tip.classList.add('on');
  };
  const target = (e) => e.target.closest?.('[data-tip]:not([data-tip=""])');

  document.addEventListener('mouseover', (e) => { const el = target(e); if (el) show(el); else hide(); });
  document.addEventListener('focusin', (e) => { const el = target(e); if (el && el.matches(':focus-visible')) show(el); else hide(); });
  document.addEventListener('focusout', hide);
  document.addEventListener('mousedown', hide);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  document.addEventListener('scroll', hide, true);
}

/**
 * Puts text on the clipboard. The modern way first; where that is blocked (an
 * older browser, or a frame that was not given the permission) the older way,
 * which needs a real text box to copy from. True if either worked.
 */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* try the older way */ }
  try {
    const box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', '');
    box.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
    // Inside an open dialog everything outside it is inert, so the box goes in it.
    (document.querySelector('dialog[open]') || document.body).appendChild(box);
    box.select();
    const ok = document.execCommand('copy');
    box.remove();
    return ok;
  } catch { return false; }
}

/** Copies, and says how it went on the button that was pressed, then puts the button's own words back. */
export async function copyFrom(button, text) {
  const html = button._html ?? (button._html = button.innerHTML);
  const ok = await copyText(text);
  button.textContent = ok ? 'Copied' : 'Could not copy. Select it instead.';
  button.classList.toggle('done', ok);
  button.setAttribute('aria-live', 'polite');
  if (document.activeElement !== button) button.focus({ preventScroll: true });
  clearTimeout(button._back);
  button._back = setTimeout(() => { button.innerHTML = html; button.classList.remove('done'); }, ok ? 2000 : 4000);
  return ok;
}

/**
 * Two small behaviours that work anywhere, including inside a sheet.
 *
 *   data-copy="text"    copies the text (see copyFrom above)
 *   data-reveal="id"    shows what is typed in the password field with that
 *                       id, or hides it again; the button says which it does
 */
export function installFieldHelpers() {
  document.addEventListener('click', (e) => {
    const copy = e.target.closest?.('[data-copy]');
    if (copy) {
      e.preventDefault();
      copyFrom(copy, copy.dataset.copy);
      return;
    }
    const reveal = e.target.closest?.('[data-reveal]');
    if (reveal) {
      e.preventDefault();
      const field = document.getElementById(reveal.dataset.reveal);
      if (!field) return;
      const show = field.type === 'password';
      const what = reveal.dataset.what || 'what you typed';
      field.type = show ? 'text' : 'password';
      reveal.textContent = show ? 'Hide' : 'Show';
      reveal.setAttribute('aria-label', `${show ? 'Hide' : 'Show'} ${what}`);
      field.focus({ preventScroll: true });
    }
  });
}

/**
 * Says that a form worked, in the status line next to that form (an element
 * that is already on the page and empty, so a screen reader announces the
 * change), and clears it again after a while.
 */
let flashTimer = null;
export function flash(id, text, ms = 10000) {
  clearTimeout(flashTimer);
  // After the view has been redrawn, so the line that gets the text is the
  // one now on the page.
  setTimeout(() => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    flashTimer = setTimeout(() => { const now = document.getElementById(id); if (now) now.textContent = ''; }, ms);
  }, 60);
}

/**
 * A short message at the bottom of the screen. With an action (Undo) it stays
 * for eight seconds, and for as long as the pointer or the keyboard is on it:
 * a way back that leaves before it can be reached is not a way back.
 */
let toastTimer = null;
let toastStale = null;
export function toast(msg, action) {
  const t = $('#toast');
  // Emptied when it goes, so a button that is no longer shown cannot be pressed.
  const hide = () => { clearTimeout(toastTimer); t.hidden = true; t.innerHTML = ''; };
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  if (action) t.querySelector('button').onclick = () => { hide(); action.run(); };
  t.hidden = false;
  const arm = () => { clearTimeout(toastTimer); toastTimer = setTimeout(hide, action ? 8000 : 3200); };
  t.onmouseenter = t.onfocusin = () => clearTimeout(toastTimer);
  t.onmouseleave = t.onfocusout = arm;
  arm();
  // An Undo that restores the whole plan (core.js undoTo) goes as soon as the
  // plan is changed again; see persist().
  document.removeEventListener('cadence:edited', toastStale);
  toastStale = action?.untilEdited ? hide : null;
  if (toastStale) document.addEventListener('cadence:edited', toastStale, { once: true });
}

// ------------------------------------------------------------- formatting

export const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DOW_TWO = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export const TIMES = (() => {
  const out = [];
  for (let h = 5; h < 24; h++) for (const m of [0, 15, 30, 45]) out.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  out.push('23:59');
  return out;
})();

export const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };
export const fromMin = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
export const shift = (hhmm, mins) => fromMin(clamp(toMin(hhmm) + mins, 0, 23 * 60 + 59));
export const clock = (hhmm) => fmtTime(atTime(new Date(), hhmm));
export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
export const mmss = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
export const listJoin = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0] || '');

export function short(hhmm) {
  return fmtClock(hhmm);
}
export function range(a, b) {
  return `${fmtClock(a)} to ${fmtClock(b)}`;
}

export function daysLabel(days = []) {
  const set = [...new Set(days)].sort((a, b) => WEEK_ORDER.indexOf(a) - WEEK_ORDER.indexOf(b));
  const key = set.join(',');
  if (key === '1,2,3,4,5') return 'Weekdays';
  if (set.length === 7) return 'Every day';
  if (key === '6,0') return 'Weekends';
  const names = set.map((d) => DOW_SHORT[d]);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] || 'Any day');
}

export function timeSelect(name, value, extra = '') {
  const opts = TIMES.includes(value) ? TIMES : [...TIMES, value].sort();
  return `<select name="${name}" ${extra}>${opts.map((t) =>
    `<option value="${t}" ${t === value ? 'selected' : ''}>${clock(t)}</option>`).join('')}</select>`;
}

export function greeting(name) {
  const h = new Date().getHours();
  const part = h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const first = String(name || '').trim().split(/\s+/)[0];
  return first ? `${part}, ${esc(first)}` : part;
}

export function dueLabel(due) {
  if (!due) return 'No due date';
  const d = new Date(due);
  const days = Math.round((+startOfDay(d) - +startOfDay(new Date())) / DAY);
  if (+d < Date.now()) return days === 0 ? 'Was due today' : days === -1 ? 'Was due yesterday' : `Was due ${-days} days ago`;
  if (days === 0) return `Due today ${fmtTime(d)}`;
  if (days === 1) return d.getHours() < 12 ? `Due tomorrow ${fmtTime(d)}` : 'Due tomorrow';
  if (days < 7) return `Due ${d.toLocaleDateString([], { weekday: 'long' })}`;
  return `Due ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
}

export function longDay(k) {
  const d = new Date(`${k}T12:00:00`);
  const rel = fmtDay(d);
  const date = d.toLocaleDateString([], { month: 'long', day: 'numeric' });
  return ['Today', 'Tomorrow'].includes(rel) ? `${rel}, ${date}` : d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

export function ago(iso) {
  const m = Math.round((Date.now() - +new Date(iso)) / MIN);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h ago`;
  if (m < 60 * 48) return 'yesterday';
  return fmtDay(iso);
}

export function daysUntil(dateStr) {
  return Math.round((+new Date(`${dateStr}T12:00:00`) - +startOfDay(new Date())) / DAY);
}

export function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
