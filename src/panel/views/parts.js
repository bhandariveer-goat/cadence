// Pieces more than one screen draws: the rings deck, the day timeline, and
// the shared illustration.

import { app, dayAgenda, schoolWeek, commitmentById } from '../core.js';
import { weekProgress, weekStreak, KINDS, isFixed } from '../../lib/habits.js';
import { fmtTime, fmtMinutes, dateKey } from '../../lib/util.js';
import { ring, svg, I, KIND_ICON, esc, colorFor, range, fromMin, plural } from '../ui.js';

export const ART = `<svg width="176" height="116" viewBox="0 0 176 116" aria-hidden="true">
  <defs><linearGradient id="sunG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffc46b"/><stop offset="1" stop-color="#f0712b"/></linearGradient></defs>
  <circle cx="88" cy="66" r="50" fill="none" stroke="#ffb347" stroke-opacity=".28" stroke-width="7" stroke-linecap="round" stroke-dasharray="240 400" transform="rotate(-200 88 66)"/>
  <circle cx="88" cy="66" r="38" fill="none" stroke="#1c9d68" stroke-opacity=".35" stroke-width="7" stroke-linecap="round" stroke-dasharray="170 400" transform="rotate(-160 88 66)"/>
  <circle cx="88" cy="66" r="24" fill="url(#sunG)"/>
  <path d="M0 92 Q44 70 88 88 T176 84 V116 H0z" style="fill:var(--surface-3)"/>
  <path d="M0 102 Q56 86 106 100 T176 96 V116 H0z" fill="#7cc4a0" opacity=".8"/>
</svg>`;

export function commitmentIcon(c, size) {
  return svg(KIND_ICON[c?.kind] || I.star, size);
}

/** One ring per commitment plus School — the first thing you see. */
export function ringsDeck({ withAdd = true } = {}) {
  const S = app.S;
  const tiles = [];
  const school = schoolWeek();
  if (school.hasWork) {
    tiles.push(`<button class="ring-tile ${school.pct >= 1 ? 'done' : ''}" data-act="go" data-tab="plan" data-mode="school" aria-label="School this week">
      ${ring({ pct: school.pct, color: 'var(--accent)', size: 66, stroke: 8, inner: svg(I.school), label: 'School' })}
      <div class="t">School</div>
      <div class="m">${school.pct >= 1 ? 'All caught up' : school.todayLeft ? `${plural(school.todayLeft, 'block')} today` : `${Math.round(school.pct * 100)}% this week`}</div>
    </button>`);
  }
  for (const c of (S.commitments || []).filter((x) => !x.archived)) {
    const p = weekProgress(c, S.checkins);
    tiles.push(`<button class="ring-tile ${p.met ? 'done' : ''}" data-act="open-commit" data-id="${c.id}" aria-label="${esc(c.title)}: ${p.label} this week">
      ${ring({ pct: p.pct, color: c.color, size: 66, stroke: 8, inner: commitmentIcon(c), label: c.title })}
      <div class="t">${esc(c.title)}</div>
      <div class="m">${p.met ? 'Done this week' : `${p.label} this week`}</div>
    </button>`);
  }
  if (withAdd) {
    tiles.push(`<button class="ring-tile add" data-act="add-commit" aria-label="Add a commitment">
      <span class="plus">${svg(I.plus, 24)}</span><div class="t">Add</div></button>`);
  }
  return `<div class="rings">${tiles.join('')}</div>`;
}

/** The day as one continuous path. */
export function timeline(k, { emptyText = 'Nothing planned. Enjoy it.' } = {}) {
  const items = dayAgenda(k);
  if (!items.length) return `<div class="card soft center small muted">${emptyText}</div>`;
  const today = dateKey(new Date()) === k;
  const now = Date.now();

  return `<div class="timeline">${items.map((it) => {
    const future = it.at > now;
    if (it.type === 'busy') {
      return `<div class="tl-item busy"><div class="tl-time">${fmtTime(it.at)}</div><div class="tl-node"><span class="node-dot"></span></div>
        <div class="tl-card"><div class="grow"><div class="t">${esc(it.title)}</div><div class="m">until ${fmtTime(it.end)}</div></div></div></div>`;
    }
    if (it.type === 'fixed') {
      const c = it.commitment;
      const done = !!it.checkin;
      const canCheck = !future || !today ? true : false;
      return `<div class="tl-item ${done ? 'done' : ''}" style="--c:${c.color}">
        <div class="tl-time">${fmtTime(it.at)}</div>
        <div class="tl-node">${canCheck || done
          ? `<button class="check ${done ? 'on' : ''}" data-act="${done ? 'undo-checkin' : 'checkin'}" data-id="${done ? it.checkin.id : c.id}" data-day="${k}" aria-label="${done ? 'Undo check-in' : `Check in: ${esc(c.title)}`}">${svg(I.check)}</button>`
          : '<span class="node-dot"></span>'}</div>
        <button class="tl-card tap" data-act="open-commit" data-id="${c.id}">
          <span class="kind">${commitmentIcon(c)}</span>
          <div class="grow"><div class="t">${esc(c.title)}</div><div class="m">${fmtTime(it.at)} – ${fmtTime(it.end)}${done ? ` · ${fmtMinutes(it.checkin.minutes)} logged` : ''}</div></div>
        </button></div>`;
    }
    if (it.type === 'checkin') {
      const c = it.commitment;
      return `<div class="tl-item done" style="--c:${c.color}"><div class="tl-time">${fmtTime(it.at)}</div>
        <div class="tl-node"><button class="check on" data-act="undo-checkin" data-id="${it.checkin.id}" aria-label="Undo check-in">${svg(I.check)}</button></div>
        <button class="tl-card tap" data-act="open-commit" data-id="${c.id}"><span class="kind">${commitmentIcon(c)}</span>
          <div class="grow"><div class="t">${esc(c.title)}</div><div class="m">${fmtMinutes(it.checkin.minutes)} logged</div></div></button></div>`;
    }
    // planned block
    const s = it.session;
    const c = it.commitment;
    const color = c?.color || colorFor(s);
    const running = s.startedAt && !s.done;
    const act = s.done ? 'undo-session' : c ? 'checkin-session' : 'finish-session';
    return `<div class="tl-item ${s.done ? 'done' : ''} ${running ? 'now-line' : ''}" style="--c:${color}">
      <div class="tl-time">${fmtTime(s.start)}</div>
      <div class="tl-node"><button class="check ${s.done ? 'on' : ''}" data-act="${act}" data-id="${s.id}" aria-label="${s.done ? 'Mark not done' : `Done: ${esc(s.title)}`}">${svg(I.check)}</button></div>
      <button class="tl-card tap" data-act="${c ? 'open-commit' : 'open-guide'}" data-id="${c ? c.id : s.taskId}">
        <span class="kind">${c ? commitmentIcon(c) : svg(I.school)}</span>
        <div class="grow">
          <div class="t">${esc(s.title)}</div>
          <div class="m">${running ? 'In progress · ' : ''}${s.minutes} min${c ? ' · practice' : ` · ${esc(s.courseName || 'Homework')}`}${!c && s.parts > 1 ? ` · part ${s.part}/${s.parts}` : ''}</div>
        </div>
      </button>
    </div>`;
  }).join('')}</div>`;
}

/** Eight little dots: the last eight weeks, filled when the target was met. */
export function weekDots(c, weeks = 8) {
  const S = app.S;
  const out = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 7 * 86400000);
    out.push(`<i class="${weekProgress(c, S.checkins, d).met ? 'on' : ''}"></i>`);
  }
  return `<span class="week-dots" style="--c:${c.color}" aria-label="Last ${weeks} weeks">${out.join('')}</span>`;
}

export function scheduleLabel(c, daysLabel) {
  if (isFixed(c)) return `${daysLabel(c.schedule.days)} · ${range(c.schedule.start, c.schedule.end)}`;
  const t = { morning: ' · mornings', afternoon: ' · afternoons', evening: ' · evenings' }[c.time] || '';
  return `${c.target.sessions}× a week · ${fmtMinutes(c.target.minutes)}${t}`;
}

export { weekStreak, KINDS, commitmentById };
