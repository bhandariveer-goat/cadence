// Command palette (Cmd K) and keyboard shortcuts. One palette for navigation,
// actions, assignments and activities; "?" lists every shortcut.

import { MOD } from '../shell.js';
import { app, go, push, syncCanvas, currentSession, insideCanvas, plannable, signedIn } from '../core.js';
import { weekProgress } from '../../lib/habits.js';
import { fmtMinutes } from '../../lib/util.js';
import { svg, I, esc, sheet, KIND_ICON, dueLabel, $ } from '../ui.js';

let dlg = null;
let items = [];
let cursor = 0;

const NAV = [
  { id: 'today', label: 'Today', hint: 'Rings, next block, your day', icon: I.sun, run: () => go('today') },
  { id: 'calendar', label: 'Calendar', hint: 'Everything, with a time', icon: I.cal, run: () => go('calendar') },
  { id: 'school', label: 'School', hint: 'Every assignment, broken down', icon: I.school, run: () => go('plan') },
  { id: 'activities', label: 'Activities', hint: 'What you do outside class', icon: I.star, run: () => go('activities') },
  { id: 'crew', label: 'Crew', hint: 'Partners and clubs', icon: I.users, run: () => go('crew') },
  { id: 'record', label: 'Activities record', hint: 'Hours and descriptions for applications', icon: I.trophy, run: () => { go('activities'); push('record'); } },
  { id: 'review', label: 'Last week in review', hint: 'What worked last week', icon: I.chart, run: () => { go('activities'); push('review'); } },
  { id: 'account', label: 'Account and settings', hint: 'School hours, sleep, calendars, sign out', icon: I.you, run: () => { go('today'); push('account'); } }
];

function build(query) {
  const q = query.trim().toLowerCase();
  const out = [];
  const add = (x) => { if (!q || `${x.label} ${x.hint || ''}`.toLowerCase().includes(q)) out.push(x); };

  const cur = currentSession();
  if (cur) add({ label: `Start ${cur.title}`, hint: 'Begin the next block', icon: I.play, kind: 'Action', run: () => document.querySelector(`[data-act="start-session"][data-id="${cur.id}"]`)?.click() || go('today') });
  add({ label: 'Ask Cadence', hint: 'Say what is going on and the plan changes', icon: I.chat, kind: 'Action', run: () => document.dispatchEvent(new CustomEvent('cadence:act', { detail: { act: 'agent-open' } })) });
  add({ label: 'Add an activity', hint: 'Practice, team, job, goal', icon: I.plus, kind: 'Action', run: () => document.dispatchEvent(new CustomEvent('cadence:act', { detail: { act: 'add-commit' } })) });
  add({ label: 'Add an assignment', hint: 'Type it how you would say it', icon: I.list, kind: 'Action', run: () => { go('plan'); setTimeout(() => $('.quickadd input')?.focus(), 60); } });
  if (insideCanvas) add({ label: 'Refresh from Canvas', hint: 'Pull new assignments', icon: I.canvas, kind: 'Action', run: () => syncCanvas() });
  if (window.CadenceTheme) {
    const dark = window.CadenceTheme.current() === 'dark';
    add({ label: dark ? 'Switch to light theme' : 'Switch to dark theme', hint: 'Appearance: light or dark, kept in this browser', icon: dark ? I.sun : I.moon, kind: 'Action',
      run: () => window.CadenceTheme.set(dark ? 'light' : 'dark') });
  }
  add({ label: 'Keyboard shortcuts', hint: 'Everything you can press', icon: I.settings, kind: 'Action', run: () => shortcutsSheet() });

  for (const n of NAV) add({ ...n, kind: 'Go to' });

  for (const c of (app.S.commitments || []).filter((x) => !x.archived)) {
    const p = weekProgress(c, app.S.checkins);
    add({ label: c.title, hint: `${p.label} this week · check in`, icon: KIND_ICON[c.kind] || I.star, kind: 'Activity', color: c.color,
      run: () => document.dispatchEvent(new CustomEvent('cadence:act', { detail: { act: 'checkin', id: c.id } })) });
  }
  for (const t of Object.values(app.S.tasks).filter((t) => plannable(t)).slice(0, 40)) {
    add({ label: t.title, hint: `${t.courseName || 'Personal'} · ${dueLabel(t.due)}`, icon: I.school, kind: 'Assignment',
      run: () => document.dispatchEvent(new CustomEvent('cadence:act', { detail: { act: 'open-guide', id: t.id } })) });
  }
  return out.slice(0, 40);
}

function render(query) {
  items = build(query);
  cursor = Math.min(cursor, Math.max(0, items.length - 1));
  const list = dlg.querySelector('.results');
  list.innerHTML = items.length ? items.map((it, i) => `
    <button type="button" class="res" data-i="${i}" aria-selected="${i === cursor}">
      <span class="ic">${svg(it.icon || I.right, 16)}</span>
      <span class="grow"><span class="t">${esc(it.label)}</span>${it.hint ? `<span class="m block">${esc(it.hint)}</span>` : ''}</span>
      ${it.kind ? `<span class="pill">${it.kind}</span>` : ''}
    </button>`).join('') : '<div class="res"><span class="m">No matches. Try a shorter word, or press Esc to close.</span></div>';
  list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}

function choose(i) {
  const it = items[i];
  if (!it) return;
  dlg.close();
  setTimeout(() => it.run(), 30);
}

export function openPalette() {
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.className = 'palette';
    dlg.innerHTML = `
      <label class="palette-search">${svg(I.search, 16)}<span class="sr-only">Search</span>
        <input type="text" placeholder="Search assignments, activities and commands…" autocomplete="off" spellcheck="false"></label>
      <div class="results" role="listbox"></div>
      <div class="hintbar"><span><kbd>↑</kbd> <kbd>↓</kbd> Move</span><span><kbd>Enter</kbd> Open</span><span><kbd>Esc</kbd> Close</span><span class="grow"></span><span><kbd>?</kbd> Shortcuts</span></div>`;
    document.body.appendChild(dlg);
    const input = dlg.querySelector('input');
    input.addEventListener('input', () => { cursor = 0; render(input.value); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); cursor = Math.min(cursor + 1, items.length - 1); render(input.value); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); cursor = Math.max(cursor - 1, 0); render(input.value); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(cursor); }
    });
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) return dlg.close();
      const res = e.target.closest('.res[data-i]');
      if (res) choose(Number(res.dataset.i));
    });
  }
  const input = dlg.querySelector('input');
  input.value = '';
  cursor = 0;
  render('');
  dlg.showModal();
  input.focus();
}

export function shortcutsSheet() {
  const keys = [
    [`${MOD}K`, 'Search and commands'],
    ['/', 'Search'],
    ['A', 'Ask Cadence'],
    ['Q', 'Add an assignment'],
    ['C', 'Check in on an activity'],
    ['T', 'Today'],
    ['L', 'Calendar'],
    ['S', 'School'],
    ['V', 'Activities'],
    ['R', 'Crew'],
    ['←  →', 'Previous / next week, on the calendar'],
    ['N', 'Start the next block'],
    ['?', 'This list'],
    ['Esc', 'Close what is open']
  ];
  return sheet(`<h2>Keyboard shortcuts</h2><p class="lead">Anywhere except while typing in a field.</p>
    <div class="keys">${keys.map(([k, v]) => `<div class="keyrow"><span>${esc(v)}</span><kbd>${esc(k)}</kbd></div>`).join('')}</div>
    <div class="actions"><button class="btn soft" value="cancel">Close</button></div>`);
}

/** Global keys. Ignored while typing, and inside any open dialog. */
export function installShortcuts(actions) {
  document.addEventListener('keydown', (e) => {
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable;
    if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (signedIn() && app.S?.profile?.onboarded) openPalette(); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    if (!app.S?.profile?.onboarded || !signedIn()) return;

    const k = e.key.toLowerCase();
    const nav = { t: 'today', l: 'calendar', s: 'plan', v: 'activities', r: 'crew' };
    if (k === '?') { e.preventDefault(); return shortcutsSheet(); }
    if (k === '/') { e.preventDefault(); return openPalette(); }
    if (k === 'a') { e.preventDefault(); return document.dispatchEvent(new CustomEvent('cadence:act', { detail: { act: 'agent-open' } })); }
    if (k === 'q') { e.preventDefault(); go('plan'); return setTimeout(() => $('.quickadd input')?.focus(), 60); }
    if (k === 'c') { e.preventDefault(); return actions.checkinPicker(); }
    if (k === 'n') {
      const cur = currentSession();
      if (cur) { e.preventDefault(); document.querySelector(`[data-act="start-session"][data-id="${cur.id}"]`)?.click(); }
      return;
    }
    if (nav[k]) { e.preventDefault(); return go(nav[k]); }
    if (app.view === 'calendar' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      app.weekOffset = Math.max(0, Math.min(3, app.weekOffset + (e.key === 'ArrowRight' ? 1 : -1)));
      app.planDay = null;
      go('calendar');
    }
  });
}
