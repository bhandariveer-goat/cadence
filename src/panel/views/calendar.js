// The Calendar tab: one merged timeline of everything — Cadence's own blocks,
// Canvas due dates, and any calendar the student has connected.
//
// It's the same renderer the Plan tab's week view uses, so the two never drift.

import { app, refreshSources, dayAgenda, sessionsOn, go, push } from '../core.js';
import { SOURCE_META } from '../../lib/sources/sources.js';
import { dateKey, addDays, startOfDay, fmtMinutes, fmtTime, fmtDay } from '../../lib/util.js';
import { svg, I, esc, ago, longDay, plural, DOW_SHORT, isDesktop } from '../ui.js';
import { timeline, ART } from './parts.js';
import { weekGrid } from './week.js';

export function viewCalendar() {
  const S = app.S;
  const mode = app.calMode === 'day' || !isDesktop() ? 'day' : 'week';
  const connected = Object.entries(S.sources || {}).filter(([, s]) => s.enabled);

  const start = addDays(startOfDay(new Date()), app.weekOffset * 7);
  const days = [...Array(7)].map((_, i) => addDays(start, i));
  const keys = days.map(dateKey);
  if (!keys.includes(app.planDay)) app.planDay = keys[0];

  return `
    <section class="hello" style="padding-bottom:10px">
      <div class="row between" style="align-items:flex-start">
        <div class="grow"><h1>Calendar</h1><p>${subtitle(connected)}</p></div>
        <button class="icon-btn ${app.sourcesSyncing ? 'spin' : ''}" data-act="refresh-sources" title="Refresh calendars" aria-label="Refresh calendars">
          ${svg('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>', 19)}
        </button>
      </div>
    </section>

    ${sourceChips(connected)}

    ${isDesktop() ? `<div class="seg" role="tablist">
      <button data-act="cal-mode" data-mode="week" aria-pressed="${mode === 'week'}">Week</button>
      <button data-act="cal-mode" data-mode="day" aria-pressed="${mode === 'day'}">Day</button>
    </div>` : ''}

    ${mode === 'week' ? `
      <div class="row between" style="margin:-2px 0 10px">
        <span class="small muted" style="font-weight:700">${app.weekOffset ? 'Next week' : 'This week'}</span>
        <span class="row" style="gap:4px">
          <button class="icon-btn" data-act="week-shift" data-dir="-1" ${app.weekOffset ? '' : 'disabled style="opacity:.3"'} aria-label="Previous week">${svg(I.left, 18)}</button>
          <button class="icon-btn" data-act="week-shift" data-dir="1" ${app.weekOffset ? 'disabled style="opacity:.3"' : ''} aria-label="Next week">${svg(I.right, 18)}</button>
        </span>
      </div>
      ${weekGrid()}`
    : `
      <div class="strip">${days.map((d, i) => {
        const k = keys[i];
        const items = dayAgenda(k);
        const dots = [...new Set(items.filter((x) => x.type !== 'busy').map((x) => x.commitment?.color || 'var(--accent)'))].slice(0, 3);
        return `<button class="daychip ${k === dateKey(new Date()) ? 'today' : ''}" data-act="pick-day" data-day="${k}" aria-current="${k === app.planDay}">
          <span class="dow">${k === dateKey(new Date()) ? 'Today' : DOW_SHORT[d.getDay()]}</span><span class="num">${d.getDate()}</span>
          <span class="dots">${dots.map((c) => `<i style="--c:${c}"></i>`).join('')}</span></button>`;
      }).join('')}</div>
      <div class="section-head"><h2>${esc(longDay(app.planDay))}</h2><span class="muted">${dayLoad(app.planDay)}</span></div>
      ${allDayRow(app.planDay)}
      ${timeline(app.planDay, { emptyText: 'Nothing on the calendar. A rare free day.' })}
      <div class="row" style="margin-top:12px;gap:8px">
        <button class="btn small soft" data-act="block-time" data-day="${app.planDay}">${svg(I.plus, 14)} Block off time</button>
        <button class="btn small ghost" data-act="open-availability">When I'm free</button>
      </div>`}

    ${connected.length ? '' : connectPrompt()}
  `;
}

function subtitle(connected) {
  if (!connected.length) return 'Your plan and your commitments. Connect Canvas or Google to see everything in one place.';
  const names = connected.map(([id]) => SOURCE_META[id]?.short || id);
  const last = connected.map(([, s]) => s.lastSync).filter(Boolean).sort().at(-1);
  return `Cadence + ${names.join(' + ')}${last ? ` · updated ${ago(last)}` : ''}`;
}

function sourceChips(connected) {
  const chip = (label, colorVar, extra = '') => `<span class="pill" style="gap:6px">${extra}<i style="width:9px;height:9px;border-radius:50%;background:${colorVar};display:inline-block"></i>${esc(label)}</span>`;
  const errors = connected.filter(([, s]) => s.error);
  return `<div class="row wrap" style="gap:6px;margin-bottom:12px">
    ${chip('Cadence', 'var(--accent)')}
    ${connected.map(([id, s]) => chip(SOURCE_META[id]?.short || id, id === 'google' ? 'var(--blue, #3b82f6)' : 'var(--green)',
      s.error ? `<span style="color:var(--amber)">${svg(I.flag, 12)}</span>` : '')).join('')}
    <button class="pill" data-act="open-calendars" style="border:1px dashed var(--line);background:transparent">${svg(I.plus, 12)} Connect</button>
    ${errors.length ? `<button class="pill amber" data-act="open-calendars">${esc(SOURCE_META[errors[0][0]]?.short || 'A calendar')} needs attention</button>` : ''}
  </div>`;
}

function dayLoad(k) {
  const mins = sessionsOn(k).reduce((a, s) => a + s.minutes, 0);
  return mins ? `${fmtMinutes(mins)} planned` : 'Nothing planned';
}

/** All-day events (trips, holidays) sit above the timeline, as in every calendar app. */
function allDayRow(k) {
  const all = dayAgenda(k).filter((it) => it.type === 'busy' && it.allDay);
  if (!all.length) return '';
  return `<div class="row wrap" style="gap:6px;margin-bottom:10px">${all.map((it) =>
    `<span class="pill" title="${esc(it.calendarName || '')}">${svg(I.cal, 12)} ${esc(it.title)}</span>`).join('')}</div>`;
}

function connectPrompt() {
  return `<div class="card soft" style="margin-top:16px">
    <div class="row" style="align-items:flex-start">
      <span class="kind-ic" style="--c:var(--accent)">${svg(I.cal)}</span>
      <div class="grow">
        <div class="card-title">Bring your other calendars in</div>
        <div class="card-sub">Cadence schedules around whatever it can see. Add your Canvas feed and Google Calendar so practice never lands on top of a game or a shift.</div>
      </div>
    </div>
    <button class="btn primary block" style="margin-top:12px" data-act="open-calendars">Connect a calendar</button>
  </div>`;
}

export const actions = {
  'cal-mode': (el) => { app.calMode = el.dataset.mode; go('calendar'); },
  'refresh-sources': () => refreshSources()
};
