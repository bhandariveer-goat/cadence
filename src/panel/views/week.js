// The desktop week grid: seven day columns over an hour ruler, with every
// planned block, fixed commitment and calendar event drawn in place.
//
// This is the view a wide screen earns — on a phone you get one day at a time,
// here you see the whole week's shape and where the empty evenings are.

import { app, dayAgenda, commitmentById } from '../core.js';
import { dateKey, addDays, startOfDay, atTime, fmtTime, fmtMinutes } from '../../lib/util.js';
import { weekStart } from '../../lib/habits.js';
import { esc, colorFor, DOW_SHORT } from '../ui.js';

const HOUR_PX = 56;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Lay overlapping blocks side by side, like a calendar app. */
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
    for (const it of cluster) { it.lanes = lanes.length; out.push(it); }
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

export function weekGrid() {
  const S = app.S;
  const start = addDays(weekStart(new Date()), app.weekOffset * 7);
  const days = [...Array(7)].map((_, i) => addDays(start, i));
  const todayKey = dateKey(new Date());

  // Only draw the hours that actually hold something, plus a little air.
  let first = 8 * 60, last = 21 * 60;
  const perDay = days.map((d) => {
    const k = dateKey(d);
    const items = dayAgenda(k).map((it) => {
      const from = (it.at - +startOfDay(new Date(it.at))) / 60000;
      const to = from + Math.max(20, ((it.end || it.at + 30 * 60000) - it.at) / 60000);
      return { ...it, k, from, to };
    });
    for (const w of S.availability[d.getDay()] || []) {
      const [sh, sm] = w.start.split(':').map(Number);
      const [eh, em] = w.end.split(':').map(Number);
      first = Math.min(first, sh * 60 + sm);
      last = Math.max(last, eh * 60 + em);
    }
    for (const it of items) { first = Math.min(first, it.from); last = Math.max(last, it.to); }
    return { d, k, items };
  });
  first = clamp(Math.floor(first / 60) * 60, 0, 22 * 60);
  last = clamp(Math.ceil(last / 60) * 60, first + 240, 24 * 60);
  const hours = (last - first) / 60;
  const y = (mins) => ((mins - first) / 60) * HOUR_PX;

  const cap = S.settings.dailyCapacityMin || 150;
  const nowMins = new Date().getHours() * 60 + new Date().getMinutes();

  return `<div class="weekgrid" style="--hour:${HOUR_PX}px">
    <div class="wg-head">
      <div></div>
      ${perDay.map(({ d, k, items }) => {
        const mins = items.filter((i) => i.type === 'session').reduce((a, i) => a + i.session.minutes, 0);
        return `<div class="wg-day ${k === todayKey ? 'today' : ''}">
          <span class="dow">${DOW_SHORT[d.getDay()]}</span>
          <span class="num">${d.getDate()}</span>
          <span class="load" title="${fmtMinutes(mins)} planned"><i style="width:${clamp(Math.round((mins / cap) * 100), 0, 100)}%"></i></span>
        </div>`;
      }).join('')}
    </div>

    <div class="wg-body">
      <div class="wg-gutter">${[...Array(hours)].map((_, i) =>
        `<div class="hr">${fmtTime(atTime(new Date(), `${String(first / 60 + i).padStart(2, '0')}:00`))}</div>`).join('')}</div>

      ${perDay.map(({ d, k, items }) => `
        <div class="wg-col ${[0, 6].includes(d.getDay()) ? 'weekend' : ''}">
          ${[...Array(hours)].map(() => '<div class="hr"></div>').join('')}
          ${k === todayKey && nowMins >= first && nowMins <= last ? `<div class="wg-now" style="top:${y(nowMins)}px"></div>` : ''}
          ${columns(items).map((it) => block(it, y)).join('')}
        </div>`).join('')}
    </div>

    <div class="wg-legend">
      <span><i style="background:color-mix(in srgb, var(--accent) 45%, var(--surface))"></i>Homework</span>
      <span><i style="background:color-mix(in srgb, var(--green) 55%, var(--surface))"></i>Commitments</span>
      <span><i style="background:color-mix(in srgb, var(--muted) 30%, var(--surface))"></i>Busy</span>
      <span class="grow"></span>
      <span>Tap a block to open it</span>
    </div>
  </div>`;
}

function block(it, y) {
  const top = y(it.from);
  const height = Math.max(22, y(it.to) - top);
  const width = `calc(${(100 / it.lanes).toFixed(2)}% - 6px)`;
  const left = `calc(${((it.lane / it.lanes) * 100).toFixed(2)}% + 3px)`;
  const style = `top:${top}px;height:${height}px;left:${left};width:${width}`;

  if (it.type === 'busy') {
    return `<div class="wg-block busy" style="${style};--c:var(--muted)"><b>${esc(it.title)}</b><span>${fmtTime(it.at)}</span></div>`;
  }
  if (it.type === 'fixed') {
    const c = it.commitment;
    return `<button class="wg-block ${it.checkin ? 'done' : ''}" style="${style};--c:${c.color}" data-act="open-commit" data-id="${c.id}">
      <b>${esc(c.title)}</b><span>${fmtTime(it.at)} – ${fmtTime(it.end)}</span></button>`;
  }
  if (it.type === 'checkin') {
    const c = it.commitment;
    return `<button class="wg-block done" style="${style};--c:${c.color}" data-act="open-commit" data-id="${c.id}">
      <b>${esc(c.title)}</b><span>${fmtMinutes(it.checkin.minutes)} logged</span></button>`;
  }
  const s = it.session;
  const c = it.commitment;
  return `<button class="wg-block ${s.done ? 'done' : ''}" style="${style};--c:${c?.color || colorFor(s)}"
    data-act="${c ? 'open-commit' : 'open-guide'}" data-id="${c ? c.id : s.taskId}">
    <b>${esc(s.title)}</b><span>${fmtTime(s.start)} · ${s.minutes}m</span></button>`;
}
