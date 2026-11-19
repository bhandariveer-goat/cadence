// The homepage's live app shows itself around, and this is the only place in
// Cadence where things move on their own.
//
// As the homepage opens, Activities comes in a piece at a time. Then the app
// moves by itself through School, Calendar, the assistant, Crew and Today and
// round again, saying in a line what each one is: the mark under the tab
// springs across to the next one, the old page slides away, and the new one
// comes in from that side, its rows a beat behind the blocks that hold them.
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

const FIRST = 2200;  // milliseconds on the first stop after it arrives
const STAY = 2800;   // milliseconds on each tab after that
const COME = 640;    // one piece coming in, at the arrival or a change (twice --m4)
const EXIT = 200;    // the old page sliding away (--m3)
const SPRING = 'cubic-bezier(.34, 1.4, .64, 1)';   // a little past, then back (--ease-spring)
const OUT = 'cubic-bezier(.4, 0, 1, 1)';           // speeding up as it leaves (--ease-in)
// Repeated things inside a block, brought in one after another.
const ROWS = '.ring-tile, .daychip, .tl-item, .item, .person, .feed-card, .task, .card.flush > *';

let enabled = null;
let stopped = false;
let arrived = false;
let inView = true;      // whether any of the frame is on the homepage's screen
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

// The app's page column.
const view = () => document.getElementById('view');

/** The pieces of the page on screen, each with how long it waits to move.
    The old page sliding away is not one of them. Blocks after the sixth
    keep the sixth's beat, so a change lands in about the same time however
    much of the page the frame shows. */
function pieces() {
  const v = view();
  const bottom = v.getBoundingClientRect().bottom;
  const out = [];
  let block = 0;
  for (const child of v.children) {
    if (child.classList.contains('view-leaving')) continue;
    const r = child.getBoundingClientRect();
    if (r.top > bottom) break;
    if (!r.height) continue;
    const beat = Math.min(block, 5) * 70;
    out.push({ el: child, delay: beat, row: false });
    let row = 0;
    for (const el of child.querySelectorAll(ROWS)) {
      const rr = el.getBoundingClientRect();
      if (rr.top > bottom) break;
      if (row >= 8) break;
      out.push({ el, delay: beat + 90 + row * 40, row: true });
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
  // From the bar's padding box, which is what the glide is placed in.
  const x = (v) => v - bar.left - barEl.clientLeft + barEl.scrollLeft;
  const y = (v) => v - bar.top - barEl.clientTop;
  const under = getComputedStyle(tab, '::before');
  if (under.content !== 'none' && under.position === 'absolute') {
    const r = tab.getBoundingClientRect();
    const left = parseFloat(under.left) || 0, right = parseFloat(under.right) || 0, h = parseFloat(under.height) || 2, below = parseFloat(under.bottom) || 0;
    return { left: x(r.left) + left, top: y(r.bottom) - h - below, width: r.width - left - right, height: h, radius: under.borderRadius, color: 'var(--accent)', under: true };
  }
  const icon = tab.querySelector('svg');
  if (!icon) return null;
  const r = icon.getBoundingClientRect();
  return { left: x(r.left), top: y(r.top), width: r.width, height: r.height, radius: getComputedStyle(icon).borderRadius, color: 'var(--accent-soft)' };
}

/** A copy of a tab's mark laid over the tab bar, for moving the mark without touching the real one. */
function glideAt(box) {
  const el = Object.assign(document.createElement('span'), { className: 'tab-glide' });
  el.setAttribute('aria-hidden', 'true');
  Object.assign(el.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`, borderRadius: box.radius, background: box.color, transformOrigin: '0 0' });
  return el;
}

const ARRIVAL = 1700;   // milliseconds the arrival takes, all pieces in
let arrivalStart = 0;

/** Today, coming in a piece at a time as the homepage opens. The app can draw
    itself again in its first moments, which puts new, still pieces in place,
    so a redraw during the arrival picks it up again from where it had got to. */
export function redrawn() {
  const now = performance.now();
  if (!arrived) {
    arrived = true;
    arrivalStart = now;
    // The homepage shows the frame the moment its first page starts to come in.
    try { parent.postMessage({ type: 'cadence:arrive' }, location.origin); } catch { /* shown on load instead */ }
  }
  // Drawn again partway through a change of tab: the new page carries on coming in.
  // The redraw took the sliding mark and the old page with it, so the change ends there.
  if (now < changeEnd) { endChange?.(); comeIn(changeDir, now - changeStart); return; }
  const gone = now - arrivalStart;
  if (gone > ARRIVAL) return;
  for (const { el, delay, row } of pieces()) {
    el.animate([{ opacity: 0, transform: `translateY(${row ? 18 : 28}px)` }, { opacity: 1, transform: 'none' }],
      { duration: COME, delay: delay + 120 - gone, easing: SPRING, fill: 'backwards' });
  }
  // The current tab's mark: on a phone the tint behind its icon pops in; on a
  // wider screen the line under it draws itself out from the left.
  const tab = document.querySelector('#tabs .tab[aria-current]');
  const box = markBox(tab);
  if (box?.under) {
    const bar = document.getElementById('tabs');
    const line = glideAt(box);
    bar.append(line);
    bar.classList.add('gliding');
    const done = () => { line.remove(); if (!bar.querySelector('.tab-glide')) bar.classList.remove('gliding'); };
    line.animate([{ transform: 'scaleX(0)' }, { transform: 'none' }], { duration: 560, delay: 380 - gone, easing: SPRING, fill: 'backwards' })
      .finished.then(done, done);
  } else {
    tab?.querySelector('svg')?.animate([{ transform: 'scale(.6)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 560, delay: 380 - gone, easing: SPRING, fill: 'backwards' });
  }
}

const LEAVE = EXIT - 20;   // the new page waits this long, until the old one is all but gone
let changeStart = -Infinity, changeEnd = -Infinity, changeDir = 1;

/** The new page coming in, a piece at a time, from the side `dir` (1 right,
    -1 left). `gone` is how far into the change it already is, for picking it
    up after a redraw. Returns the animations. */
function comeIn(dir, gone) {
  return pieces().map(({ el, delay, row }) => el.animate(
    [{ opacity: 0, transform: `translateX(${dir * (row ? 36 : 56)}px)` }, { opacity: 1, transform: 'none' }],
    { duration: COME, delay: LEAVE + delay - gone, easing: SPRING, fill: 'backwards' }));
}

/** The change from one tab to the next. `from` is where the old tab's mark
    was, `leaving` the old page's nodes, `step` how many tabs along it moved,
    and `scrolls` where any scrolling part of the old page was scrolled to. */
export function tabChange(from, leaving, step, scrolls = []) {
  endChange?.();
  const v = view();
  const bar = document.getElementById('tabs');
  const dir = Math.sign(step) || 1;
  const runs = [];

  // The old page, laid exactly where it was and slid away. A page that was
  // itself still sliding away when this change began simply goes: carried
  // over, it would come back at full strength under the next one.
  const ghost = document.createElement('div');
  ghost.className = 'view-leaving';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  const cs = getComputedStyle(v);
  Object.assign(ghost.style, { padding: cs.padding, top: `${v.scrollTop - (app.leftScroll || 0)}px` });
  app.leftScroll = 0;
  ghost.append(...leaving.filter((n) => !n.classList?.contains('view-leaving')));
  v.append(ghost);
  // Put back into the page, a scrolling part starts at its top again; put it back where it was.
  for (const [el, top] of scrolls) el.scrollTop = top;
  runs.push(ghost.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${-dir * 48}px) scale(.97)` }],
    { duration: EXIT, easing: OUT, fill: 'forwards' }));

  // The new page, a block at a time, each block's rows a beat behind it.
  changeStart = performance.now();
  changeDir = dir;
  const coming = pieces();
  changeEnd = changeStart + LEAVE + Math.max(0, ...coming.map((p) => p.delay)) + COME;
  runs.push(...comeIn(dir, 0));

  // The mark, springing across from the old tab to the new one.
  const to = markBox(bar.querySelector('.tab[aria-current]'));
  let glideEl = null;
  if (from && to && from.width && to.width) {
    glideEl = glideAt(to);
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
  // Cancelled from anywhere (a redraw, the next change), it still clears up after itself.
  Promise.all(runs.map((r) => r.finished)).then(end, end);
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait, unless the visitor has taken over. While the page is hidden or the
    frame is scrolled out of sight, hold still, checking only now and then;
    once it is back, the page on show gets its full stay before the next
    move. And never start a move before the last one has finished (at most
    three seconds more, in case it never says so). */
async function wait(ms) {
  let end = Date.now() + ms;
  for (;;) {
    if (stopped) throw new Stop();
    if (document.hidden || !inView) {
      await pause(250);
      end = Date.now() + ms;
      continue;
    }
    const left = end - Date.now();
    if (left > 0) { await pause(Math.min(120, left)); continue; }
    if (endChange && left > -3000) { await pause(50); continue; }
    break;
  }
}

// What the tour shows, in order, and what it says about each stop. It opens
// on Activities, because that is what the homepage is about, goes through
// School to the Calendar where everything comes together, shows the
// assistant, then Crew, and ends on Today.
const STOPS = [
  { tab: 'activities', note: 'Everything you do outside class' },
  { tab: 'plan', note: 'Your homework, with time to do it' },
  { tab: 'calendar', note: 'This is where everything comes together' },
  { assistant: true, note: 'When plans change, just tell it' },
  { tab: 'crew', note: 'Keep your friends accountable' },
  { tab: 'today', note: 'Then each day, what to do next' }
];
const SAY = 'Practice is cancelled Wednesday';   // typed into the assistant, never sent

let noteEl = null;

/** Says what the stop on show is, in a small label at the foot of the frame. */
function say(text) {
  if (!noteEl) {
    noteEl = Object.assign(document.createElement('p'), { className: 'tour-note' });
    noteEl.setAttribute('aria-hidden', 'true');
    document.body.append(noteEl);
  }
  noteEl.textContent = text;
  noteEl.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: SPRING, fill: 'backwards' });
}

const agentOpen = () => !document.getElementById('agent')?.hidden;
const toggleAgent = () => document.getElementById('btn-agent')?.click();

/** Types into the assistant's box, a letter at a time. It is never sent: the demo week stays as it was. */
async function type(text) {
  for (let i = 1; i <= text.length; i++) {
    const box = document.getElementById('ag-input');
    if (!box) return;
    box.value = text.slice(0, i);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(i === 1 ? 500 : 45);
  }
}

/** Goes to one stop. The assistant is opened beside the page and closed again on the way out. */
async function visit(stop) {
  if (agentOpen() && !stop.assistant) {
    const box = document.getElementById('ag-input');
    if (box) { box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true })); }
    toggleAgent();
  }
  if (stop.assistant) {
    if (!agentOpen()) toggleAgent();
    const pane = document.getElementById('agent');
    pane?.animate([{ opacity: 0, transform: 'translateX(24px)' }, { opacity: 1, transform: 'none' }], { duration: 2 * 160, easing: SPRING, fill: 'backwards' });
    say(stop.note);
    await type(SAY);
    return;
  }
  document.querySelector(`#tabs [data-act="tab"][data-tab="${stop.tab}"]`)?.click();
  say(stop.note);
}

/** The tour itself: the first stop for a moment, then each of the others in turn, round and round. */
async function tour() {
  say(STOPS[0].note);
  await wait(FIRST);
  for (let i = 1; ; i = (i + 1) % STOPS.length) {
    await visit(STOPS[i]);
    await wait(STAY);
  }
}

/** The visitor's own first click, tap or key press ends the tour, and the app scrolls again. */
function takeOver(e) {
  if (!e.isTrusted) return;   // the tour's own clicks on the tabs
  stopped = true;
  document.body.classList.remove('showing');
  noteEl?.remove();
}

/** Starts the tour in the homepage's frame. */
export function startAutoplay() {
  if (!on()) return;
  document.body.classList.add('showing');
  // Seen from inside the frame, this tells whether any of it is on the homepage's screen.
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => { inView = entries[entries.length - 1].isIntersecting; }).observe(document.documentElement);
  }
  for (const type of ['click', 'keydown']) {
    document.addEventListener(type, takeOver, { capture: true, passive: true });
  }
  // Wait for the plan before the first move.
  const go = () => (app.S ? tour().catch((e) => { if (!(e instanceof Stop)) throw e; }) : setTimeout(go, 200));
  go();
}
