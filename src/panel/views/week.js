// The week grid: seven day columns over an hour ruler, with school, events,
// activities and planned work all drawn in place.
//
// Four kinds of block, four colours, and the legend names exactly those four.
// It used to colour by course and by activity, which made a week look like
// confetti and left the legend describing three colours out of nine.

import { app, dayAgenda } from '../core.js';
import { dateKey, addDays, startOfDay, fmtMinutes } from '../../lib/util.js';
import { weekStart } from '../../lib/habits.js';
import { clock, clockOf } from '../../lib/agentops.js';
import { plannable } from '../../lib/replanner.js';
import { esc, DOW_SHORT } from '../ui.js';

const HOUR_PX = 56;
const SHORT_PX = 38;      // under this a block shows its title only
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Which of the four kinds a calendar item is. */
export function kindOf(it) {
  if (it.type === 'busy') return it.source === 'school' ? 'school' : 'event';
  if (it.type === 'fixed' || it.type === 'checkin') return 'activity';
  return it.commitment ? 'activity' : 'work';
}

export const LEGEND = [
  ['school', 'School'],
  ['event', 'Events'],
  ['activity', 'Activities'],
  ['work', 'Planned work']
];

/**
 * Lay overlapping blocks side by side, at most two across. A third thing in
 * the same slot would make all three unreadable, so anything past the second
 * column is folded into one "+N" marker that opens the day.
 */
function columns(items) {
  const sorted = [...items].sort((a, b) => a.from - b.from || b.to - a.to);
  const out = [];
  let cluster = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    if (!cluster.length) return;
    const lanes = [];
    for (const it of cluster) {
      let lane = lanes.findIndex((end) => end <= it.from);
      if (lane < 0) { lanes.push(it.to); lane = lanes.length - 1; } else lanes[lane] = it.to;
      it.lane = lane;
    }
    if (lanes.length <= 2) {
      for (const it of cluster) { it.lanes = lanes.length; out.push(it); }
    } else {
      // Three or more at once: keep the first column, fold the rest into one marker.
      const rest = cluster.filter((it) => it.lane >= 1);
      for (const it of cluster.filter((x) => x.lane === 0)) { it.lanes = 2; out.push(it); }
      out.push({
        more: rest.length, k: rest[0].k, lane: 1, lanes: 2,
        from: Math.min(...rest.map((x) => x.from)), to: Math.max(...rest.map((x) => x.to)),
        titles: rest.map((x) => x.title || x.session?.title || x.commitment?.title || '').filter(Boolean)
      });
    }
    cluster = [];
  };
  for (const it of sorted) {
    if (it.from >= clusterEnd && cluster.length) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.to);
  }
  flush();
  return out;
}

/** The Monday-to-Sunday week the grid is showing. */
export function shownWeek() {
  const start = addDays(weekStart(new Date()), (app.weekOffset || 0) * 7);
  return [...Array(7)].map((_, i) => addDays(start, i));
}

/** Assignments due on a date, for the markers above each column. */
export function dueOn(k) {
  return Object.values(app.S.tasks || {})
    .filter((t) => plannable(t, app.S) && t.due && dateKey(new Date(t.due)) === k)
    .sort((a, b) => new Date(a.due) - new Date(b.due));
}

export function weekGrid() {
  const S = app.S;
  const days = shownWeek();
  const todayKey = dateKey(new Date());

  // Only draw the hours that actually hold something, plus a little air.
  let first = 8 * 60, last = 21 * 60;
  const perDay = days.map((d) => {
    const k = dateKey(d);
    const items = dayAgenda(k).filter((it) => !it.allDay).map((it) => {
      const from = (it.at - +startOfDay(new Date(it.at))) / 60000;
      const to = from + Math.max(20, ((it.end || it.at + 30 * 60000) - it.at) / 60000);
      return { ...it, k, from, to: Math.min(to, 24 * 60) };
    });
    for (const it of items) { first = Math.min(first, it.from); last = Math.max(last, it.to); }
    return { d, k, items };
  });
  first = clamp(Math.floor(first / 60) * 60, 0, 22 * 60);
  last = clamp(Math.ceil(last / 60) * 60, first + 240, 24 * 60);
  const hours = (last - first) / 60;
  const y = (mins) => ((mins - first) / 60) * HOUR_PX;

  const planDay = Object.fromEntries((S.plan?.days || []).map((d) => [d.date, d]));
  const nowMins = new Date().getHours() * 60 + new Date().getMinutes();

  return `<div class="weekgrid" style="--hour:${HOUR_PX}px">
    <div class="wg-head">
      <div></div>
      ${perDay.map(({ d, k }) => {
        const due = dueOn(k);
        const pd = planDay[k];
        return `<button class="wg-day ${k === todayKey ? 'today' : ''}" data-act="open-day" data-day="${k}" aria-label="Open ${esc(d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }))}">
          <span class="dow">${DOW_SHORT[d.getDay()]}</span>
          <span class="num">${d.getDate()}</span>
          <span class="wg-due" data-tip="${esc(due.map((t) => t.title).join(', '))}">${due.length ? `${due.length} due` : pd?.minutes ? fmtMinutes(pd.minutes) : ''}</span>
        </button>`;
      }).join('')}
    </div>

    <div class="wg-body">
      <div class="wg-gutter">${[...Array(hours)].map((_, i) =>
        `<div class="hr">${clock(`${String(first / 60 + i).padStart(2, '0')}:00`)}</div>`).join('')}</div>

      ${perDay.map(({ d, k, items }) => `
        <div class="wg-col ${[0, 6].includes(d.getDay()) ? 'weekend' : ''}">
          ${[...Array(hours)].map(() => '<div class="hr"></div>').join('')}
          ${k === todayKey && nowMins >= first && nowMins <= last ? `<div class="wg-now" style="top:${y(nowMins)}px"></div>` : ''}
          ${columns(items).map((it) => block(it, y)).join('')}
        </div>`).join('')}
    </div>

    <div class="wg-legend">
      ${LEGEND.map(([id, label]) => `<span><i class="k-${id}"></i>${label}</span>`).join('')}
    </div>
  </div>`;
}

function block(it, y) {
  const top = y(it.from);
  const height = Math.max(20, y(it.to) - top - 2);
  const width = `calc(${(100 / it.lanes).toFixed(2)}% - 4px)`;
  const left = `calc(${((it.lane / it.lanes) * 100).toFixed(2)}% + 2px)`;
  const style = `top:${top}px;height:${height}px;left:${left};width:${width}`;
  const short = height < SHORT_PX ? 'short' : '';

  if (it.more) {
    return `<button class="wg-block more" style="${style}" data-act="open-day" data-day="${it.k}" data-tip="${esc(it.titles.join(', '))}"><b>+${it.more}</b></button>`;
  }
  const kind = kindOf(it);
  const cls = `wg-block k-${kind} ${short}`;

  if (it.type === 'busy') {
    const tip = `${it.title}, ${clockOf(it.at)} to ${clockOf(it.end)}`;
    return `<div class="${cls}" style="${style}" data-tip="${esc(tip)}"><b>${esc(it.title)}</b><span>${clockOf(it.at)}</span></div>`;
  }
  if (it.type === 'fixed') {
    const c = it.commitment;
    const tip = `${c.title}, ${clockOf(it.at)} to ${clockOf(it.end)}${it.checkin ? ', checked in' : ''}`;
    return `<button class="${cls} ${it.checkin ? 'done' : ''}" style="${style}" data-act="open-commit" data-id="${c.id}" data-tip="${esc(tip)}">
      <b>${esc(c.title)}</b><span>${clockOf(it.at)} to ${clockOf(it.end)}</span></button>`;
  }
  if (it.type === 'checkin') {
    const c = it.commitment;
    return `<button class="${cls} done" style="${style}" data-act="open-commit" data-id="${c.id}" data-tip="${esc(`${c.title}, ${fmtMinutes(it.checkin.minutes)} logged`)}">
      <b>${esc(c.title)}</b><span>${fmtMinutes(it.checkin.minutes)}</span></button>`;
  }
  const s = it.session;
  const c = it.commitment;
  const tip = `${s.title}, ${clockOf(s.start)}, ${fmtMinutes(s.minutes)}${s.parts > 1 ? `, part ${s.part} of ${s.parts}` : ''}`;
  return `<button class="${cls} ${s.done ? 'done' : ''}" style="${style}" data-tip="${esc(tip)}"
    data-act="${c ? 'open-commit' : 'open-guide'}" data-id="${c ? c.id : s.taskId}">
    <b>${esc(s.title)}</b><span>${clockOf(s.start)} · ${fmtMinutes(s.minutes)}</span></button>`;
}
