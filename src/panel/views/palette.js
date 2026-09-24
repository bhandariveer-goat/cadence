// Command palette (⌘K) and keyboard shortcuts — the thing that makes a web app
// feel like a desktop product rather than a page. One palette for navigation,
// actions, assignments and commitments; "?" lists every shortcut.

import { app, go, push, syncCanvas, currentSession, insideCanvas, plannable } from '../core.js';
import { weekProgress } from '../../lib/habits.js';
import { fmtMinutes } from '../../lib/util.js';
import { svg, I, esc, sheet, KIND_ICON, dueLabel, $ } from '../ui.js';

let dlg = null;
let items = [];
let cursor = 0;

const NAV = [
  { id: 'today', label: 'Today', hint: 'Rings, next block, your day', icon: I.sun, run: () => go('today') },
  { id: 'plan', label: 'Plan — week', hint: 'The whole week on a grid', icon: I.cal, run: () => { app.planMode = 'week'; go('plan'); } },
  { id: 'school', label: 'Plan — school', hint: 'Every assignment', icon: I.school, run: () => { app.planMode = 'school'; go('plan'); } },
  { id: 'crew', label: 'Crew', hint: 'Partners, clubs, kudos', icon: I.users, run: () => go('crew') },
  { id: 'you', label: 'You', hint: 'Commitments and settings', icon: I.you, run: () => go('you') },
  { id: 'record', label: 'Activities record', hint: 'Hours and descriptions for applications', icon: I.trophy, run: () => { go('you'); push('record'); } },
  { id: 'review', label: 'Week in review', hint: 'What worked last week', icon: I.chart, run: () => { go('you'); push('review'); } },
  { id: 'availability', label: "When I'm free", hint: 'Edit your week', icon: I.clock, run: () => { go('you'); push('availability'); } }
];

function build(query) {
  const q = query.trim().toLowerCase();
  const out = [];
  const add = (x) => { if (!q || `${x.label} ${x.hint || ''}`.toLowerCase().includes(q)) out.push(x); };

  const cur = currentSession();
  if (cur) add({ label: `Start “${cur.title}”`, hint: 'Begin the next block', icon: I.play, kind: 'Action', run: () => document.querySelector(`[data-act="start-session"][data-id="${cur.id}"]`)?.click() || go('today') });
  add({ label: 'Add a commitment', hint: 'Practice, team, job, goal', icon: I.plus, kind: 'Action', run: () => document.dispatchEvent(new CustomEvent('cadence:act', { detail: { act: 'add-commit' } })) });
  add({ label: 'Add homework', hint: 'Type it how you\'d say it', icon: I.list, kind: 'Action', run: () => { app.planMode = 'school'; go('plan'); setTimeout(() => $('.quickadd input')?.focus(), 60); } });
  if (insideCanvas) add({ label: 'Refresh from Canvas', hint: 'Pull new assignments', icon: I.canvas, kind: 'Action', run: () => syncCanvas() });
  add({ label: 'Keyboard shortcuts', hint: 'Everything you can press', icon: I.settings, kind: 'Action', run: () => shortcutsSheet() });

  for (const n of NAV) add({ ...n, kind: 'Go to' });

  for (const c of (app.S.commitments || []).filter((x) => !x.archived)) {
    const p = weekProgress(c, app.S.checkins);
    add({ label: c.title, hint: `${p.label} this week · check in`, icon: KIND_ICON[c.kind] || I.star, kind: 'Commitment', color: c.color,
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
      <span class="ic" ${it.color ? `style="color:${it.color};background:color-mix(in srgb, ${it.color} 14%, var(--surface-2))"` : ''}>${svg(it.icon || I.right, 16)}</span>
      <span class="grow"><span class="t">${esc(it.label)}</span>${it.hint ? `<span class="m" style="display:block">${esc(it.hint)}</span>` : ''}</span>
      ${it.kind ? `<span class="pill">${it.kind}</span>` : ''}
    </button>`).join('') : '<div class="res"><span class="m">Nothing matches that.</span></div>';
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
      <input type="text" placeholder="Search assignments, commitments and commands…" aria-label="Search" autocomplete="off">
      <div class="results" role="listbox"></div>
      <div class="hintbar"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span><span class="grow"></span><span><kbd>?</kbd> shortcuts</span></div>`;
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
    ['⌘K / Ctrl K', 'Search and commands'],
    ['Q', 'Add homework'],
    ['C', 'Check in on a commitment'],
    ['T', 'Today'],
    ['P', 'Plan (week)'],
    ['S', 'School — assignments'],
    ['R', 'Crew'],
    ['Y', 'You'],
    ['←  →', 'Previous / next week'],
    ['N', 'Start the next block'],
    ['?', 'This list'],
    ['Esc', 'Close a sheet']
  ];
  return sheet(`<h2>Keyboard shortcuts</h2><p class="lead">Anywhere except while typing in a field.</p>
    <div class="keys">${keys.map(([k, v]) => `<div class="keyrow"><span>${esc(v)}</span><kbd>${esc(k)}</kbd></div>`).join('')}</div>
    <div class="actions"><button class="btn primary" value="cancel">Got it</button></div>`);
}

/** Global keys. Ignored while typing, and inside any open dialog. */
export function installShortcuts(actions) {
  document.addEventListener('keydown', (e) => {
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable;
    if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); return openPalette(); }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    if (!app.S?.profile?.onboarded) return;

    const k = e.key.toLowerCase();
    const nav = { t: 'today', p: 'plan', r: 'crew', y: 'you' };
    if (k === '?') { e.preventDefault(); return shortcutsSheet(); }
    if (k === 'q') { e.preventDefault(); app.planMode = 'school'; go('plan'); return setTimeout(() => $('.quickadd input')?.focus(), 60); }
    if (k === 'c') { e.preventDefault(); return actions.checkinPicker(); }
    if (k === 's') { e.preventDefault(); app.planMode = 'school'; return go('plan'); }
    if (k === 'n') {
      const cur = currentSession();
      if (cur) { e.preventDefault(); document.querySelector(`[data-act="start-session"][data-id="${cur.id}"]`)?.click(); }
      return;
    }
    if (nav[k]) { e.preventDefault(); if (k === 'p') app.planMode = 'week'; return go(nav[k]); }
    if (app.view === 'plan' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      app.weekOffset = Math.max(0, Math.min(1, app.weekOffset + (e.key === 'ArrowRight' ? 1 : -1)));
      app.planDay = null;
      go('plan');
    }
  });
}
