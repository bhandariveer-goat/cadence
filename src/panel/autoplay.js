// The homepage's live app shows itself around: it scrolls Today, moves
// through the tabs, opens an assignment and the assistant, and starts over.
// Each tap is marked with a soft circle where a finger would land, the way a
// phone demo is filmed (not a pointer gliding about).
//
// It only ever looks: switching tabs, opening an assignment's steps and the
// assistant panel change nothing that is saved, so the visitor's own demo
// week is left as it was. It runs only in the homepage's frame
// (demo.html?embed=1&autoplay=1), never for someone who has asked their
// device for less motion, waits while the page is hidden, and stops for good
// the moment the visitor clicks, taps, scrolls or presses a key in it.

import { app, EMBEDDED, DEMO } from './core.js';

let stopped = false;
let hint = null;

class Stop extends Error {}

/** Wait, unless the visitor has taken over; hold still while the page is hidden. */
async function wait(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end || document.hidden) {
    if (stopped) throw new Stop();
    await new Promise((r) => setTimeout(r, Math.min(120, Math.max(16, end - Date.now()))));
  }
  if (stopped) throw new Stop();
}

const view = () => document.getElementById('view');

/** Scroll the page column smoothly to `top` (pixels), and give it time to get there. */
async function scrollTo(top, ms = 1400) {
  view()?.scrollTo({ top, behavior: 'smooth' });
  await wait(ms);
}

/** A tap: a circle where a finger would land, then the click itself. */
async function tap(selector) {
  if (stopped) throw new Stop();
  const el = document.querySelector(selector);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  // Scrolled within the app only: scrollIntoView would move the homepage around it too.
  if (r.bottom < 0 || r.top > innerHeight) { view()?.scrollBy({ top: r.top - innerHeight / 2, behavior: 'smooth' }); await wait(700); }
  const box = el.getBoundingClientRect();
  hint ||= Object.assign(document.createElement('span'), { className: 'tap-hint' });
  hint.setAttribute('aria-hidden', 'true');
  hint.style.left = `${box.left + box.width / 2}px`;
  hint.style.top = `${box.top + box.height / 2}px`;
  hint.classList.remove('on');
  document.body.append(hint);
  void hint.offsetWidth;
  hint.classList.add('on');
  await wait(260);
  el.click();
  await wait(500);
  return true;
}

async function tour() {
  for (;;) {
    // Today: down through the next step and the activities, and back up.
    await wait(1800);
    await scrollTo(380, 1700);
    await wait(900);
    await scrollTo(0, 1200);
    // Calendar, and a look at the week.
    await tap('[data-act="tab"][data-tab="calendar"]');
    await wait(1200);
    await scrollTo(260, 1500);
    await wait(700);
    // School: open the first assignment to show its steps.
    await tap('[data-act="tab"][data-tab="plan"]');
    await wait(1000);
    if (await tap('#view .task [data-act="toggle-task"]')) {
      await wait(1600);
      await scrollTo(200, 1300);
      await wait(1200);
      await tap('#view .task.open [data-act="toggle-task"]');
    }
    // Activities: the rings for the week.
    await tap('[data-act="tab"][data-tab="activities"]');
    await wait(2200);
    // The assistant, opened and closed again.
    await tap('#btn-agent');
    await wait(2600);
    await tap('[data-act="agent-close"]');
    await wait(500);
    await tap('[data-act="tab"][data-tab="today"]');
    await wait(1200);
  }
}

/** The visitor's own first touch ends the tour, wherever it had got to. */
function takeOver() {
  if (stopped) return;
  stopped = true;
  hint?.remove();
}

export function startAutoplay() {
  const asked = new URLSearchParams(location.search).get('autoplay') === '1';
  if (!asked || !EMBEDDED || !DEMO || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    document.addEventListener(type, takeOver, { capture: true, passive: true });
  }
  // Wait for the plan before the first move.
  const go = () => (app.S ? tour().catch((e) => { if (!(e instanceof Stop)) throw e; }) : setTimeout(go, 200));
  go();
}
