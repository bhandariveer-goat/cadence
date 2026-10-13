// The Calendar: everything, with a time on it.
//
// School, events, activities, and the blocks Cadence has planned for the work
// itself, on one grid. Assignments show twice on purpose: as a "due" marker on
// the day they are due, and as the blocks where the work actually happens.
// The School tab is the list of what there is to do; this is when.

import { app, refreshSources, dayAgenda, sessionsOn, go, render } from '../core.js';
import { SOURCE_META } from '../../lib/sources/sources.js';
import { dateKey, fmtMinutes } from '../../lib/util.js';
import { svg, I, esc, ago, longDay, DOW_SHORT, isDesktop } from '../ui.js';
import { timeline } from './parts.js';
import { weekGrid, shownWeek, dueOn, LEGEND } from './week.js';

const monthDay = (d) => d.toLocaleDateString([], { month: 'short', day: 'numeric' });

export function viewCalendar() {
  const S = app.S;
  const mode = app.calMode === 'day' || !isDesktop() ? 'day' : 'week';
  const connected = Object.entries(S.sources || {}).filter(([, s]) => s.enabled);
  const days = shownWeek();
  const keys = days.map(dateKey);
  const today = dateKey(new Date());
  if (!keys.includes(app.planDay)) app.planDay = keys.includes(today) ? today : keys[0];
  const range = `${monthDay(days[0])} to ${monthDay(days[6])}`;
  const errors = connected.filter(([, s]) => s.error);

  return `
    <section class="hello">
      <div class="row between top-align">
        <div class="grow"><h1>Calendar</h1><p>${subtitle(connected)}</p></div>
        ${connected.length ? `<button class="icon-btn ${app.sourcesSyncing ? 'spin' : ''}" data-act="refresh-sources" data-tip="Refresh connected calendars" aria-label="Refresh connected calendars">
          ${svg('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>', 18)}</button>` : ''}
      </div>
    </section>

    <label class="quickadd-label" for="calendar-add">Add to your calendar</label>
    <form class="quickadd" data-form="calendar-add">
      <input type="text" id="calendar-add" name="text" placeholder="Dentist Thursday at 3" autocomplete="off" required data-error="Type what to add first, for example: Dentist Thursday at 3.">
      <button class="btn primary" type="submit">Add to calendar</button>
    </form>

    <div class="cal-bar">
      <div class="cal-nav">
        <button class="icon-btn" data-act="week-shift" data-dir="-1" ${app.weekOffset ? '' : 'disabled'} data-tip="Previous week" aria-label="Previous week">${svg(I.left, 18)}</button>
        <button class="icon-btn" data-act="week-shift" data-dir="1" ${app.weekOffset >= 3 ? 'disabled' : ''} data-tip="Next week" aria-label="Next week">${svg(I.right, 18)}</button>
      </div>
      <button class="btn small soft" data-act="week-today">Go to today</button>
      <span class="cal-range">${esc(range)}</span>
      <span class="text-2 small">${app.weekOffset === 0 ? 'This week' : app.weekOffset === 1 ? 'Next week' : `In ${app.weekOffset} weeks`}</span>
      ${isDesktop() ? `<div class="seg" role="group" aria-label="View">
        <button data-act="cal-mode" data-mode="week" aria-pressed="${mode === 'week'}">Week</button>
        <button data-act="cal-mode" data-mode="day" aria-pressed="${mode === 'day'}">Day</button>
      </div>` : ''}
    </div>

    ${errors.length ? `<button class="card warm small tap w100 left" data-act="open-calendars">${esc(SOURCE_META[errors[0][0]]?.label || 'A calendar')} is not syncing. Open calendars to fix it.</button>` : ''}

    ${mode === 'week' ? weekGrid() : `
      <div class="strip">${days.map((d, i) => {
        const k = keys[i];
        const kinds = [...new Set(dayAgenda(k).map((x) => (x.type === 'busy' ? (x.source === 'school' ? 'school' : 'event') : (x.type === 'session' && !x.commitment ? 'work' : 'activity'))))];
        return `<button class="daychip ${k === today ? 'today' : ''}" data-act="pick-day" data-day="${k}" aria-current="${k === app.planDay}">
          <span class="dow">${k === today ? 'Today' : DOW_SHORT[d.getDay()]}</span><span class="num">${d.getDate()}</span>
          <span class="dots">${kinds.slice(0, 4).map((c) => `<i class="k-${c}"></i>`).join('')}</span></button>`;
      }).join('')}</div>
      <div class="section-head"><h2>${esc(longDay(app.planDay))}</h2><span class="muted">${dayLoad(app.planDay)}</span></div>
      ${markers(app.planDay)}
      ${timeline(app.planDay, { emptyText: 'Nothing on the calendar this day.' })}
      <div class="wg-legend plain">${LEGEND.map(([id, label]) => `<span><i class="k-${id}"></i>${label}</span>`).join('')}</div>`}

    <p class="cal-foot">
      <button class="link" data-act="block-time" data-day="${app.planDay}">Add an event with a form</button>
      <button class="link" data-act="open-calendars">${connected.length ? 'Manage connected calendars' : 'Connect Canvas or Google Calendar'}</button>
    </p>`;
}

function subtitle(connected) {
  const base = 'School, activities, events and the time planned for your work, in one place.';
  if (!connected.length) return base;
  const last = connected.map(([, s]) => s.lastSync).filter(Boolean).sort().at(-1);
  return `${base} ${connected.map(([id]) => SOURCE_META[id]?.short || id).join(' and ')} synced${last ? ` ${ago(last)}` : ''}.`;
}

function dayLoad(k) {
  const mins = sessionsOn(k).filter((s) => !s.done).reduce((a, s) => a + s.minutes, 0);
  return mins ? `${fmtMinutes(mins)} of work planned` : 'No work planned';
}

/** What is due that day, and anything that lasts all day. */
function markers(k) {
  const due = dueOn(k);
  const all = dayAgenda(k).filter((it) => it.type === 'busy' && it.allDay);
  if (!due.length && !all.length) return '';
  return `<div class="cal-markers">
    ${due.map((t) => `<button class="marker due" data-act="open-guide" data-id="${t.id}">Due: ${esc(t.title)}</button>`).join('')}
    ${all.map((it) => `<span class="marker">${esc(it.title)}</span>`).join('')}
  </div>`;
}

export const actions = {
  'cal-mode': (el) => { app.calMode = el.dataset.mode; render(); },
  'week-today': () => { app.weekOffset = 0; app.planDay = dateKey(new Date()); render(); },
  'refresh-sources': () => refreshSources()
};

// Whatever is typed here goes to the assistant, which shows what it understood
// and can undo it. One way of adding things, not two that behave differently.
export const submitActions = {
  'calendar-add': (form, data) => {
    const text = String(data.get('text') || '').trim();
    if (!text) return;
    form.reset();
    document.dispatchEvent(new CustomEvent('cadence:act', { detail: { act: 'agent-say', text } }));
  }
};
