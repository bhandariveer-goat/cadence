// The homepage's live app shows itself around, and this is the only place in
// Cadence where things move on their own.
//
// As the homepage opens, Today comes in a piece at a time. Then the app moves
// through its tabs by itself, Today, Calendar, School, Activities, Crew and
// round again: the mark under the tab springs across to the next one, the old
// page slides away, and the new one comes in from that side, its rows a beat
// behind the blocks that hold them.
//
// It only ever looks: switching tabs changes nothing that is saved, so the
// visitor's own demo week is left as it was. It runs only in the homepage's
// frame (demo.html?embed=1&autoplay=1), never for someone who has asked their
// device for less motion, and waits while the page is hidden. While it plays,
// the app does not scroll, so a wheel or a swipe over it moves the homepage
// as it would anywhere else. A click, a tap or a key press in it stops the
// tour for good and hands the app over; tab changes stay animated in here.
// Opacity and transform only.

import { app, EMBEDDED, DEMO } from './core.js';

const FIRST = 2200;  // milliseconds on Today after it arrives
const STAY = 2800;   // milliseconds on each tab after that
const SPRING = 'cubic-bezier(.34, 1.4, .64, 1)';   // a little past, then back
const OUT = 'cubic-bezier(.4, 0, 1, 1)';
// Repeated things inside a block, brought in one after another.
const ROWS = '.ring-tile, .daychip, .tl-item, .item, .person, .feed-card, .task, .card.flush > *';

let enabled = null;
let stopped = false;
let arrived = false;
let endChange = null;   // ends the change in progress, so a quick next one starts clean

class Stop extends Error {}

/** True in the homepage's frame, for a device that has not asked for less motion. */
export function on() {
  if (enabled === null) {
    enabled = EMBEDDED && DEMO && new URLSearchParams(location.search).get('autoplay') === '1' &&
      !matchMedia('(prefers-reduced-motion: reduce)').matches && typeof Element.prototype.animate === 'function';
  }
  return enabled;
}

const view = () => document.getElementById('view');

/** The pieces of the page on screen, each with how long it waits to move. */
function pieces() {
  const v = view();
  const bottom = v.getBoundingClientRect().bottom;
  const out = [];
  let block = 0;
  for (const child of v.children) {
    const r = child.getBoundingClientRect();
    if (r.top > bottom) break;
    if (!r.height) continue;
    out.push({ el: child, delay: block * 70, row: false });
    let row = 0;
    for (const el of child.querySelectorAll(ROWS)) {
      const rr = el.getBoundingClientRect();
      if (rr.top > bottom) break;
      if (row >= 8) break;
      out.push({ el, delay: block * 70 + 90 + row * 45, row: true });
      row++;
    }
    block++;
  }
  return out;
}

/** Where a tab's mark is drawn, relative to the tab bar: the tinted tab behind
    the icon on a phone (panel.css), the underline on a wider screen (web.css). */
export function markBox(tab) {
  if (!tab) return null;
  const barEl = document.getElementById('tabs');
  const bar = barEl.getBoundingClientRect();
  const x = (r) => r.left - bar.left + barEl.scrollLeft;
  const under = getComputedStyle(tab, '::before');
  if (under.content !== 'none' && under.position === 'absolute') {
    const r = tab.getBoundingClientRect();
    const left = parseFloat(under.left) || 0, right = parseFloat(under.right) || 0, h = parseFloat(under.height) || 2;
    return { left: x(r) + left, top: r.bottom - bar.top - h + 1, width: r.width - left - right, height: h, radius: under.borderRadius, color: 'var(--accent)' };
  }
  const icon = tab.querySelector('svg');
  if (!icon) return null;
  const r = icon.getBoundingClientRect();
  return { left: x(r), top: r.top - bar.top, width: r.width, height: r.height, radius: getComputedStyle(icon).borderRadius, color: 'var(--accent-soft)' };
}

const ARRIVAL = 1700;   // milliseconds the arrival takes, all pieces in
let arrivalStart = 0;

/** Today, coming in a piece at a time as the homepage opens. The app can draw
    itself again in its first moments, which puts new, still pieces in place,
    so a redraw during the arrival picks it up again from where it had got to. */
export function redrawn() {
  const now = performance.now();
  if (!arrived) { arrived = true; arrivalStart = now; }
  // Drawn again partway through a change of tab: the new page carries on coming in.
  // The redraw took the sliding mark and the old page with it, so the change ends there.
  if (now - changeStart < CHANGE) { endChange?.(); comeIn(changeDir, now - changeStart); return; }
  const gone = now - arrivalStart;
  if (gone > ARRIVAL) return;
  for (const { el, delay, row } of pieces()) {
    el.animate([{ opacity: 0, transform: `translateY(${row ? 18 : 28}px)` }, { opacity: 1, transform: 'none' }],
      { duration: 620, delay: delay + 120 - gone, easing: SPRING, fill: 'backwards' });
  }
  const mark = document.querySelector('#tabs .tab[aria-current] svg');
  mark?.animate([{ transform: 'scale(.6)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 560, delay: 380 - gone, easing: SPRING, fill: 'backwards' });
}

const CHANGE = 1600;   // milliseconds a change takes, all pieces in
const LEAVE = 170;     // the new page waits this long, until the old one is all but gone
let changeStart = -Infinity, changeDir = 1;

function comeIn(dir, gone) {
  return pieces().map(({ el, delay, row }) => el.animate(
    [{ opacity: 0, transform: `translateX(${dir * (row ? 36 : 56)}px)` }, { opacity: 1, transform: 'none' }],
    { duration: 640, delay: LEAVE + delay - gone, easing: SPRING, fill: 'backwards' }));
}

/** The change from one tab to the next. `from` is where the old tab's mark
    was, `leaving` the old page's nodes, `step` how many tabs along it moved. */
export function tabChange(from, leaving, step) {
  endChange?.();
  const v = view();
  const bar = document.getElementById('tabs');
  const dir = Math.sign(step) || 1;
  const runs = [];

  // The old page, laid exactly where it was and slid away.
  const ghost = document.createElement('div');
  ghost.className = 'view-leaving';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  const cs = getComputedStyle(v);
  Object.assign(ghost.style, { padding: cs.padding, top: `${v.scrollTop}px` });
  ghost.append(...leaving);
  v.append(ghost);
  runs.push(ghost.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${-dir * 48}px) scale(.97)` }],
    { duration: 190, easing: OUT, fill: 'forwards' }));

  // The new page, a block at a time, each block's rows a beat behind it.
  changeStart = performance.now();
  changeDir = dir;
  runs.push(...comeIn(dir, 0));

  // The mark, springing across from the old tab to the new one.
  const to = markBox(bar.querySelector('.tab[aria-current]'));
  let glideEl = null;
  if (from && to && from.width && to.width) {
    glideEl = Object.assign(document.createElement('span'), { className: 'tab-glide' });
    glideEl.setAttribute('aria-hidden', 'true');
    Object.assign(glideEl.style, { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px`, borderRadius: to.radius, background: to.color, transformOrigin: '0 0' });
    bar.append(glideEl);
    bar.classList.add('gliding');
    runs.push(glideEl.animate([
      { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})` },
      { transform: 'none' }
    ], { duration: 560, easing: SPRING }));
  }

  const end = () => {
    if (endChange !== end) return;
    endChange = null;
    for (const r of runs) r.cancel();
    ghost.remove();
    glideEl?.remove();
    bar.classList.remove('gliding');
  };
  endChange = end;
  Promise.all(runs.map((r) => r.finished)).then(end, () => {});
}

/** Wait, unless the visitor has taken over; hold still while the page is hidden. */
async function wait(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end || document.hidden) {
    if (stopped) throw new Stop();
    await new Promise((r) => setTimeout(r, Math.min(120, Math.max(16, end - Date.now()))));
  }
  if (stopped) throw new Stop();
}

async function tour() {
  await wait(FIRST);
  for (;;) {
    const tabs = [...document.querySelectorAll('#tabs [data-act="tab"]')];
    const at = tabs.findIndex((t) => t.hasAttribute('aria-current'));
    if (tabs.length) tabs[(at + 1) % tabs.length].click();
    await wait(STAY);
  }
}

/** The visitor's own first click, tap or key press ends the tour, and the app scrolls again. */
function takeOver(e) {
  if (!e.isTrusted) return;   // the tour's own clicks on the tabs
  stopped = true;
  document.body.classList.remove('showing');
}

export function startAutoplay() {
  if (!on()) return;
  document.body.classList.add('showing');
  for (const type of ['click', 'keydown']) {
    document.addEventListener(type, takeOver, { capture: true, passive: true });
  }
  // Wait for the plan before the first move.
  const go = () => (app.S ? tour().catch((e) => { if (!(e instanceof Stop)) throw e; }) : setTimeout(go, 200));
  go();
}
