// Everything the public pages (home, privacy, terms) do beyond being read.
//
// The pages work without this file: every word, every link and the layout are
// plain HTML and CSS, and the contact form posts by itself. What is added here
// is progressive: the theme toggle, search, the mobile menu's manners, copy
// buttons, the back-to-top and contact buttons, the bar of actions on a phone,
// the storage notice, kinder errors on the contact form, and what happens to
// a link that arrives with a campaign label on it. Controls that need this
// file are hidden in the HTML and shown from here, so nothing is ever a dead
// button.
//
// Who runs the site, the reply-time promise and the like are written into the
// HTML by scripts/stamp_pages.py from src/config.js. They are filled in again
// here from the same file, so an edit to the config shows on the next reload
// while working on the site; the pre-launch check fails if the two disagree.

import { CONFIG, cloudConfigured } from './src/config.js';

const site = CONFIG.site || {};
// Where the site's root is, worked out from where this file was loaded from.
// The 404 page is served at whatever address was asked for, so nothing here
// may assume the page it is running on sits next to its neighbours.
const ROOT = new URL('.', import.meta.url);
// Small helpers: a page's full address from the site root, the first or every
// element matching a selector, text made safe for HTML, whether the visitor
// asked their device for less motion, and browser storage that never throws.
const at = (path) => new URL(path, ROOT).href;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* a private window: it just shows again next time */ } }
};

// The date the public pages last changed. scripts/prelaunch_check.py fails if
// this is older than the newest commit that touched them, so it cannot rot.
const SITE_UPDATED = '2026-10-20';

const ICON = {
  search: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
  sun: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
  up: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>',
  mail: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3.5 7l8.5 6 8.5-6"/></svg>'
};

// ------------------------------------------------------- who runs the site

const pending = (what) => `<mark class="pending">${what} to be added before launch</mark>`;

/** Fills in what the pages say from the site settings (src/config.js): the
    operator's name, the contact email, the reply time and the last-updated
    date, or a visible "to be added before launch" note where one is missing. */
function fillSite() {
  const date = new Date(`${SITE_UPDATED}T12:00:00Z`);
  // Written the way the page already has it (stamp_pages.py), not in the
  // visitor's own date format: a script here never changes what a page says.
  const long = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(date);
  for (const el of $$('[data-site]')) {
    const key = el.dataset.site;
    if (key === 'operator') el.innerHTML = site.operator ? escapeHtml(site.operator) : pending('Operator name');
    if (key === 'contact') {
      el.innerHTML = site.contactEmail
        ? `<a href="mailto:${escapeHtml(site.contactEmail)}">${escapeHtml(site.contactEmail)}</a> <button type="button" class="copy" data-copy="${escapeHtml(site.contactEmail)}">Copy address</button>`
        : pending('Contact email');
    }
    if (key === 'domain') el.textContent = site.domain || location.host;
    if (key === 'reply') el.textContent = site.replyWithin || '';
    if (key === 'updated') el.innerHTML = `<time datetime="${SITE_UPDATED}">${escapeHtml(long)}</time>`;
  }
  // Sentences that are only true in some set-ups are written into the page
  // and switched here, so the page never claims something this copy lacks.
  const facts = { cloud: cloudConfigured(), visits: !!site.countVisits, contact: !!site.contactEmail, reply: !!site.replyWithin };
  for (const el of $$('[data-needs]')) {
    const [not, name] = el.dataset.needs.startsWith('no-') ? [true, el.dataset.needs.slice(3)] : [false, el.dataset.needs];
    if (name in facts) el.hidden = not ? facts[name] : !facts[name];
  }
}

// ------------------------------------------------------------ anchor ids
// Every heading and every question gets an id made from its words, on the
// live page and in the copies search reads, so a result can link to it.

const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'section';

/** Gives every heading and question on the page an id from its words, so a
    search result or a shared link can point straight at it. */
function nameSections(root) {
  const used = new Set($$('[id]', root).map((el) => el.id));
  for (const el of $$('main h2, main h3, main summary', root)) {
    if (el.id) continue;
    let id = slug(el.textContent);
    for (let n = 2; used.has(id); n++) id = `${slug(el.textContent)}-${n}`;
    used.add(id);
    el.id = id;
  }
}

/** Arriving at #a-question opens that question. */
function openTarget() {
  let id = '';
  try { id = decodeURIComponent(location.hash.slice(1)); } catch { /* a stray % in the address: there is no such place on the page */ }
  const el = id ? document.getElementById(id) : null;
  const box = el?.closest('details');
  if (box) box.open = true;
  if (el) el.scrollIntoView({ block: 'start' });
}

// ------------------------------------------------------------------ theme

/** What the theme button says it will do. */
function themeLabel() {
  return window.CadenceTheme?.current() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
}

/** Shows the light and dark buttons and keeps them in step with the theme. */
function initTheme() {
  if (!window.CadenceTheme) return;
  const paint = () => {
    const dark = window.CadenceTheme.current() === 'dark';
    for (const b of $$('[data-theme-toggle]')) {
      b.hidden = false;
      b.setAttribute('aria-pressed', String(dark));
      if (b.classList.contains('tool')) {
        b.innerHTML = dark ? ICON.sun : ICON.moon;
        b.setAttribute('aria-label', themeLabel());
        b.dataset.tip = themeLabel();
      } else {
        b.textContent = themeLabel();
      }
    }
  };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-theme-toggle]')) return;
    window.CadenceTheme.set(window.CadenceTheme.current() === 'dark' ? 'light' : 'dark');
  });
  document.addEventListener('cadence:theme', paint);
  paint();
}

// ------------------------------------------------------------- mobile menu
// <details> opens and closes without help. What it does not do is close when
// a link in it is followed, when Escape is pressed, or on a tap elsewhere.

function initMenu() {
  const menu = $('.menu');
  if (!menu) return;
  const summary = $('summary', menu);
  const panel = $('nav', menu);
  // The two controls that live in the header on a wide screen move in here.
  panel.insertAdjacentHTML('beforeend',
    '<button type="button" data-search hidden>Search this site</button><button type="button" data-theme-toggle hidden></button>');
  const sync = () => summary.setAttribute('aria-expanded', String(menu.open));
  const close = (focus) => { if (!menu.open) return; menu.open = false; sync(); if (focus) summary.focus(); };
  menu.addEventListener('toggle', sync);
  menu.addEventListener('click', (e) => { if (e.target.closest('a, button')) close(false); });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) close(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu.open) { e.preventDefault(); close(true); } });
  sync();
}

// ----------------------------------------------------------------- search
// Three pages, read once on first use and searched in the browser. Nothing
// typed here is sent anywhere.

// /, /index.html, /privacy and /privacy.html are the same pages under two names.
const pathKey = (p) => p.replace(/index\.html$/, '').replace(/\.html$/, '').replace(/\/$/, '') || '/';
// Whether an address is this page (with or without .html or a trailing slash).
const samePage = (url) => url.origin === location.origin && pathKey(url.pathname) === pathKey(location.pathname);

const PAGES = [
  { url: at('./'), name: 'Home' },
  { url: at('privacy.html'), name: 'Privacy policy' },
  { url: at('terms.html'), name: 'Terms' },
  { url: at('contact.html'), name: 'Contact' }
];
let indexing = null;

/** The words of an element as the page shows them: nothing that is hidden. */
function shownText(el) {
  if (!el.querySelector('[hidden]')) return el.textContent;
  const copy = el.cloneNode(true);
  for (const off of copy.querySelectorAll('[hidden]')) off.remove();
  return copy.textContent;
}

/** A page cut into sections for search: each heading with the text under it. */
function sectionsOf(doc, page) {
  nameSections(doc);
  const main = $('main', doc);
  if (!main) return [];
  const out = [];
  const tidy = (t) => t.replace(/\s+/g, ' ').trim();
  // Whatever comes before the first heading belongs to the page as a whole.
  let cur = { page, id: '', title: page.name, text: '' };
  const push = () => { if (cur.text || cur.heading) out.push({ page: cur.page, id: cur.id, title: cur.title, text: tidy(cur.text) }); };
  for (const el of $$('h1, h2, h3, summary, p, li, dt, dd, th, td, figcaption', main)) {
    // Not what is hidden, not the breadcrumbs (they are the way here, not
    // something the page says), and not the form's own messages.
    if (el.closest('[hidden], nav, form')) continue;
    if (el.matches('h1, h2, h3, summary')) {
      push();
      cur = { page, id: el.id || '', title: tidy(shownText(el)), text: '', heading: true };
    } else if (!el.querySelector('p, li, dd, td')) {
      cur.text += ` ${shownText(el)}`;
    }
  }
  push();
  return out;
}

/** Reads the public pages once (this one from the page itself, the others by
    fetching them) and keeps their sections for searching. */
function buildIndex() {
  indexing ||= Promise.all(PAGES.map(async (page) => {
    if (samePage(new URL(page.url, location.href))) return sectionsOf(document, page);
    try {
      const res = await fetch(page.url, { credentials: 'same-origin' });
      if (!res.ok) return [];
      return sectionsOf(new DOMParser().parseFromString(await res.text(), 'text/html'), page);
    } catch { return []; }
  })).then((lists) => lists.flat());
  return indexing;
}

// A term matches where a word starts with it: "phone" finds "phones" but not
// "microphone", which is what someone typing it expects.
const wordStart = (t) => new RegExp(`(?:^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');

/** The sections where every word of the query starts a word, best first
    (a word in the title counts more), each with a short excerpt. */
function searchIndex(sections, query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const tests = terms.map(wordStart);
  const hits = [];
  for (const s of sections) {
    if (!tests.every((re) => re.test(s.title) || re.test(s.text))) continue;
    const score = tests.reduce((a, re) => a + (re.test(s.title) ? 3 : 0) + (re.test(s.text) ? 1 : 0), 0);
    const first = tests.map((re) => s.text.search(re)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
    const from = Math.max(0, first - 50);
    const snippet = (from ? '…' : '') + s.text.slice(from, from + 150).trim() + (from + 150 < s.text.length ? '…' : '');
    hits.push({ ...s, score, snippet });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 8);
}

// The matched words, marked. The text is escaped piece by piece around the
// matches, so a search for "amp" or "39" can never land inside an entity.
const mark = (text, terms) => {
  const words = [...terms].sort((x, y) => y.length - x.length).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return escapeHtml(text);
  let out = '', last = 0;
  for (const m of text.matchAll(new RegExp(`(^|[^a-z0-9])(${words.join('|')})`, 'gi'))) {
    const start = m.index + m[1].length;
    out += `${escapeHtml(text.slice(last, start))}<mark>${escapeHtml(m[2])}</mark>`;
    last = start + m[2].length;
  }
  return out + escapeHtml(text.slice(last));
};

/** The site search: a dialog over the public pages, opened by the search
    button or a key, with results that update as the visitor types. */
function initSearch() {
  const openers = $$('[data-search]');
  if (!openers.length || !window.HTMLDialogElement) return;
  for (const b of openers) b.hidden = false;

  const dlg = document.createElement('dialog');
  dlg.className = 'search';
  dlg.setAttribute('aria-labelledby', 'search-label');
  dlg.innerHTML = `
    <form method="dialog" class="search-form" role="search">
      <label class="search-field" for="search-input">${ICON.search}<span id="search-label">Search this site</span></label>
      <input type="search" id="search-input" autocomplete="off" spellcheck="false" placeholder="canvas, privacy, phone…" aria-controls="search-results">
      <button class="btn plain small" value="cancel">Close</button>
    </form>
    <p class="search-status" role="status" aria-live="polite"></p>
    <ul class="search-results" id="search-results"></ul>`;
  document.body.appendChild(dlg);
  const input = $('input', dlg), list = $('.search-results', dlg), status = $('.search-status', dlg);
  let sections = null, cursor = 0, opener = null;

  const paint = () => {
    const q = input.value.trim();
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!sections) { status.textContent = 'Reading the pages…'; list.innerHTML = ''; return; }
    if (!q) { status.textContent = 'Type a word. Results come from the pages of this site.'; list.innerHTML = ''; return; }
    const hits = searchIndex(sections, q);
    cursor = Math.min(cursor, Math.max(0, hits.length - 1));
    if (!hits.length) {
      status.innerHTML = `No matches for “${escapeHtml(q)}”. Try a shorter word. <button type="button" class="link" data-clear>Clear search</button>`;
      list.innerHTML = '';
      return;
    }
    status.textContent = `${hits.length} ${hits.length === 1 ? 'result' : 'results'}`;
    list.innerHTML = hits.map((h, i) => `<li><a href="${escapeHtml(h.page.url)}${h.id ? `#${escapeHtml(h.id)}` : ''}" ${i === cursor ? 'aria-current="true"' : ''}>
      <b>${mark(h.title, terms)}</b><small>${escapeHtml(h.page.name)}</small>
      ${h.snippet ? `<span>${mark(h.snippet, terms)}</span>` : ''}</a></li>`).join('');
    $('[aria-current]', list)?.scrollIntoView({ block: 'nearest' });
  };

  const open = async (from) => {
    opener = from || document.activeElement;
    input.value = '';
    cursor = 0;
    dlg.showModal();
    input.focus();
    paint();
    sections ||= await buildIndex();
    paint();
  };
  const follow = (a) => {
    if (!a) return;
    dlg.close();
    const url = new URL(a.href);
    if (!samePage(url)) { location.href = a.href; return; }
    if (url.hash) {
      location.hash = url.hash;
      openTarget();                 // the same hash again fires no hashchange
    } else {
      // The top of this page: drop whatever section the address was pointing at.
      history.replaceState(history.state, '', location.pathname + location.search);
      window.scrollTo({ top: 0 });
    }
  };

  for (const b of openers) b.addEventListener('click', () => open(b));
  input.addEventListener('input', () => { cursor = 0; paint(); });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) return dlg.close();
    if (e.target.closest('[data-clear]')) { input.value = ''; input.focus(); return paint(); }
    const a = e.target.closest('.search-results a');
    if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); follow(a); }
  });
  dlg.addEventListener('keydown', (e) => {
    const links = $$('a', list);
    if (e.key === 'ArrowDown') { e.preventDefault(); cursor = Math.min(cursor + 1, links.length - 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cursor = Math.max(cursor - 1, 0); paint(); }
    else if (e.key === 'Enter' && e.target === input) { e.preventDefault(); follow(links[cursor]); }
  });
  // The browser's <dialog> gives focus back to wherever it was when the
  // dialog opened. The one case it cannot handle is the search button inside
  // the phone menu, which is hidden again by then: focus goes to the Menu
  // button instead of nowhere.
  dlg.addEventListener('close', () => {
    const shut = opener?.closest?.('details:not([open])');
    if (shut) $('summary', shut)?.focus();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || dlg.open) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    e.preventDefault();
    open(null);                     // opened from the keyboard: focus returns to where it was
  });
}

// ------------------------------------------------------------ copy buttons

/** Copy buttons (data-copy): copy the text, say so on the button, and put the label back after a moment. */
function initCopy() {
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    const label = b.dataset.label || (b.dataset.label = b.textContent);
    let ok = true;
    try { await navigator.clipboard.writeText(b.dataset.copy); } catch { ok = false; }
    b.textContent = ok ? 'Copied' : 'Copy it by hand';
    b.classList.toggle('done', ok);
    b.setAttribute('aria-live', 'polite');
    setTimeout(() => { b.textContent = label; b.classList.remove('done'); }, 2000);
  });
}

// ------------------------------------------------------- the contact form
// Without this the form still works: the browser checks the fields and posts
// them, and the host answers with the thank-you page. With it, what is wrong
// is said under the field it is about, the button says it is sending, and if
// the message cannot be sent it stays in the box with a way round.

function initEnquiry() {
  const form = $('[data-enquiry]');
  if (!form) return;
  // A copy of this page opened from inside the Chrome extension has no server
  // behind it. Say where the form does work instead of failing on Send.
  if (!/^https?:$/.test(location.protocol)) {
    const note = $('[data-form-elsewhere]');
    if (note) note.hidden = false;
    form.hidden = true;
    return;
  }
  form.noValidate = true;
  const box = $('[data-form-error]', form);
  const button = $('button[type="submit"]', form);
  const label = button.textContent;

  const clear = (el) => {
    if (el.getAttribute?.('aria-invalid') !== 'true') return;
    el.removeAttribute('aria-invalid');
    $(`#err-${el.id}`, form)?.remove();
    if (el.dataset.described) el.setAttribute('aria-describedby', el.dataset.described); else el.removeAttribute('aria-describedby');
  };
  const show = (el) => {
    clear(el);
    if (el.validity.valid) return false;
    if (el.dataset.described === undefined) el.dataset.described = el.getAttribute('aria-describedby') || '';
    const p = document.createElement('p');
    p.className = 'field-error';
    p.id = `err-${el.id}`;
    p.textContent = el.dataset.error || 'Check this and try again.';
    el.setAttribute('aria-invalid', 'true');
    el.setAttribute('aria-describedby', `${p.id} ${el.dataset.described}`.trim());
    el.insertAdjacentElement('afterend', p);
    return true;
  };
  const busy = (on) => {
    form.toggleAttribute('data-sending', on);
    if (on) button.setAttribute('aria-busy', 'true'); else button.removeAttribute('aria-busy');
    button.textContent = on ? 'Sending…' : label;
  };

  form.addEventListener('input', (e) => clear(e.target));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (form.hasAttribute('data-sending')) return;
    box.hidden = true;
    const bad = [...form.elements].filter((el) => el.willValidate && show(el));
    if (bad.length) { bad[0].focus(); return; }

    busy(true);
    let sent = false;
    try {
      const res = await fetch(at('./'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(new FormData(form)).toString()
      });
      sent = res.ok;
    } catch { /* offline, or the host did not answer */ }
    if (sent) { location.assign(at('thanks.html')); return; }

    busy(false);
    // The sentence is already in the page. Putting it back in as it is shown
    // is what makes a screen reader say it.
    const words = box.innerHTML;
    box.hidden = false;
    box.innerHTML = words;
  });
  // Coming back to this page with the Back button after a message went: the
  // browser may bring the page back exactly as it was left, mid-send.
  addEventListener('pageshow', (e) => { if (e.persisted) busy(false); });
}

// ------------------------------------------------ back to top, and contact

/** The buttons that sit in the corner: back to the top, and the way to the contact page. */
function initFloaters() {
  // The way to the contact page, except on the contact pages themselves.
  const onContact = /\/(contact|thanks)$/.test(pathKey(location.pathname));
  const box = document.createElement('div');
  box.className = 'floaters';
  box.innerHTML = `
    <button type="button" class="float" data-top hidden aria-label="Back to top" data-tip="Back to top">${ICON.up}</button>
    ${onContact ? '' : `<a class="float wide" href="${escapeHtml(at('contact.html'))}">${ICON.mail}<span>Contact</span></a>`}`;
  document.body.appendChild(box);

  // Shown once the top of the page is a screen and a half behind. A marker at
  // the very top is watched instead of the scroll position, so nothing runs
  // while the page is being scrolled; "a screen and a half" is the margin the
  // browser is asked to allow above the screen before it calls the marker gone.
  const top = $('[data-top]', box);
  const marker = document.createElement('div');
  marker.className = 'top-marker';
  marker.setAttribute('aria-hidden', 'true');
  document.body.prepend(marker);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => { top.hidden = entry.isIntersecting; }, { rootMargin: '150% 0px 0px 0px' }).observe(marker);
  }
  top.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: calm() ? 'auto' : 'smooth' });
    $('.brand')?.focus({ preventScroll: true });
  });
}

// ------------------------------------------- the two actions, on a phone
// The homepage has its two buttons at the top and again at the end. In
// between, on a phone, they follow in a bar at the bottom of the screen. The
// bar is hidden whenever either of the page's own pairs is on screen, so the
// same button is never there twice. Nothing runs while the page scrolls: the
// browser reports when a pair of buttons comes into or leaves the screen.

// ------------------------------------------------- where you are on the page
// The header link for the section being read is marked (aria-current, and a
// line under it in site.css). It changes a link at a time as a section's top
// reaches the upper part of the screen, and goes away back in the intro.
function initSections() {
  const links = $$('.nav .links a[href^="#"]');
  if (!links.length) return;
  const byId = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]));
  const mark = (id) => {
    for (const [k, a] of byId) {
      if (k === id) a.setAttribute('aria-current', 'location');
      else if (a.getAttribute('aria-current') === 'location') a.removeAttribute('aria-current');
    }
  };
  for (const a of links) a.addEventListener('click', () => mark(a.getAttribute('href').slice(1)));
  if (!('IntersectionObserver' in window)) return;
  // The section under a line just below the header is the one being read.
  // Positions are measured, not guessed from what is "in view": a link jumps
  // a section's top to exactly where the one before it ends, and both
  // touching that edge used to leave the mark on the section above.
  // Sections the header does not list count as the listed one before them.
  const hero = $('.hero');
  const targets = [hero, ...$$('main section[id]').filter((t) => byId.has(t.id))].filter(Boolean);
  const LINE = 120;
  const pick = () => {
    let cur = null;
    for (const t of targets) if (t.getBoundingClientRect().top <= LINE) cur = t;
    mark(cur && cur !== hero ? cur.id : null);
  };
  // Told whenever a section starts or stops crossing that line.
  let here = null;
  const watch = () => {
    here?.disconnect();
    here = new IntersectionObserver(pick, { rootMargin: `-${LINE}px 0px -${Math.max(0, innerHeight - LINE - 1)}px 0px` });
    for (const t of targets) here.observe(t);
  };
  watch();
  addEventListener('resize', watch);
  addEventListener('hashchange', () => setTimeout(pick, 0));
}

/** On a phone, the bar with the homepage's two buttons, shown only while
    the page's own pair of buttons is off screen. */
function initCtaBar() {
  const bar = $('[data-cta-bar]');
  const pairs = $$('main .cta');
  if (!bar || !pairs.length) return;
  if (!('IntersectionObserver' in window)) return;
  const root = document.documentElement;
  const onScreen = new Set();
  const fit = () => root.style.setProperty('--cta-h', `${bar.offsetHeight}px`);
  const show = (yes) => { bar.hidden = !yes; fit(); };
  // The top 64px of the screen is the header, so a pair of buttons that has
  // slid under it no longer counts as on screen.
  const watch = new IntersectionObserver((entries) => { for (const e of entries) { if (e.isIntersecting) onScreen.add(e.target); else onScreen.delete(e.target); } show(onScreen.size === 0); }, { rootMargin: '-64px 0px 0px 0px' });
  for (const pair of pairs) watch.observe(pair);
  // The header's own copy of the button is not needed while this is working.
  root.classList.add('cta-bar-on');
  addEventListener('resize', fit);
}

// --------------------------------------------------------- storage notice
// Cadence sets no cookies, so there is nothing to ask consent for. What it
// does do is keep a plan in this browser's storage, and a person is owed one
// plain sentence about that the first time they arrive.

function initNotice() {
  const bar = $('[data-notice]');
  if (!bar) return;
  if (store.get('cadence.notice') === 'seen') { bar.remove(); return; }
  bar.hidden = false;
  const fit = () => document.documentElement.style.setProperty('--notice-h', `${bar.offsetHeight}px`);
  fit();
  addEventListener('resize', fit);
  $('[data-dismiss]', bar).addEventListener('click', () => {
    store.set('cadence.notice', 'seen');
    bar.remove();
    removeEventListener('resize', fit);
    document.documentElement.style.removeProperty('--notice-h');
  });
}

// --------------------------------------------------------- campaign links
// A link shared in a newsletter can carry a label (utm_source and friends).
// The label is taken off the address straight away, so a link someone copies
// from here is clean. It is counted only if the owner of this copy of Cadence
// has turned that on (site.countVisits in src/config.js), and then only as
// "one more visit with this label today": no cookie, no id, nothing about
// the person or the device. See netlify/functions/visit.mjs.

function initCampaign() {
  const q = new URLSearchParams(location.search);
  const clean = (k) => (q.get(k) || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  const tag = { source: clean('utm_source'), medium: clean('utm_medium'), campaign: clean('utm_campaign') };
  const tagged = [...q.keys()].some((k) => k.startsWith('utm_'));
  if (!tagged) return;

  for (const k of [...q.keys()]) if (k.startsWith('utm_')) q.delete(k);
  const rest = q.toString();
  history.replaceState(history.state, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`);

  if (!site.countVisits || !(tag.source || tag.medium || tag.campaign)) return;
  let counted = false;
  try { counted = sessionStorage.getItem('cadence.visit') === '1'; sessionStorage.setItem('cadence.visit', '1'); } catch { /* count it */ }
  if (counted) return;
  const body = JSON.stringify(tag);
  try {
    if (!navigator.sendBeacon?.('/api/visit', new Blob([body], { type: 'application/json' }))) {
      fetch('/api/visit', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
    }
  } catch { /* a count that fails is not worth an error */ }
}

// ------------------------------------------------------------------- start

initCampaign();
nameSections(document);
fillSite();
initMenu();
initTheme();
initSearch();
initCopy();
initEnquiry();
initFloaters();
initCtaBar();
initSections();
initNotice();
openTarget();
addEventListener('hashchange', openTarget);
// On paper every answer is shown, whichever questions happened to be open.
addEventListener('beforeprint', () => { for (const d of $$('main details')) { d.dataset.was = String(d.open); d.open = true; } });
addEventListener('afterprint', () => { for (const d of $$('main details')) { if (d.dataset.was === 'false') d.open = false; delete d.dataset.was; } });
// The live demo takes a moment; until it has loaded its frame shows a quiet
// placeholder instead of an empty box.
for (const frame of $$('.live iframe')) {
  const done = () => frame.closest('.live')?.classList.add('ready');
  frame.addEventListener('load', done);
  if (frame.contentDocument?.readyState === 'complete' && frame.contentDocument.body?.childElementCount) done();
}
