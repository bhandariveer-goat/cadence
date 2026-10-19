// The homepage's live app shows itself around: it moves through its tabs on
// its own, Today, Calendar, School, Activities, Crew and round again, a few
// seconds on each. The change itself is drawn by app.js (the tab's mark slides
// across and the page comes in from that side), the same as when a student
// picks a tab.
//
// It only ever looks: switching tabs changes nothing that is saved, so the
// visitor's own demo week is left as it was. It runs only in the homepage's
// frame (demo.html?embed=1&autoplay=1), never for someone who has asked their
// device for less motion, waits while the page is hidden, and stops for good
// the moment the visitor clicks, taps, scrolls or presses a key in it.

import { app, EMBEDDED, DEMO } from './core.js';

const STAY = 3200;   // milliseconds on each tab

let stopped = false;

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

async function tour() {
  for (;;) {
    await wait(STAY);
    const tabs = [...document.querySelectorAll('#tabs [data-act="tab"]')];
    if (!tabs.length) continue;
    const at = tabs.findIndex((t) => t.hasAttribute('aria-current'));
    tabs[(at + 1) % tabs.length].click();
  }
}

/** The visitor's own first touch ends the tour, wherever it had got to. */
function takeOver() {
  stopped = true;
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
