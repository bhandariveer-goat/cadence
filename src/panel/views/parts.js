// Pieces more than one screen draws: the rings deck, the day timeline, and
// the shared illustration.

import { app, dayAgenda, schoolWeek, commitmentById } from '../core.js';
import { weekProgress, weekStreak, KINDS, isFixed } from '../../lib/habits.js';
import { fmtTime, fmtMinutes, dateKey } from '../../lib/util.js';
import { ring, svg, I, KIND_ICON, esc, colorFor, range, plural, activityColor } from '../ui.js';
import { MARK } from '../shell.js';

// The Cadence mark, for the few places that need to say whose screen this is
// (sign-in, the first run). It replaced a drawn illustration: an empty screen
// should point at what to do, not decorate the fact that it is empty.
export const ART = `<span class="mark">${MARK.replace('width="18" height="18"', 'width="24" height="24"')}</span>`;

export function commitmentIcon(c, size) {
  return svg(KIND_ICON[c?.kind] || I.star, size);
}

/** One ring per commitment plus School — the first thing you see. */
export function ringsDeck({ withAdd = true } = {}) {
  const S = app.S;
  const tiles = [];
  const school = schoolWeek();
  if (school.hasWork) {
    tiles.push(`<button class="ring-tile ${school.pct >= 1 ? 'done' : ''}" data-act="go" data-tab="plan" aria-label="School this week">
      ${ring({ pct: school.pct, color: 'var(--k-work)', size: 40, stroke: 4, inner: svg(I.school), label: 'School' })}
      <div class="t">School</div>
      <div class="m">${school.pct >= 1 ? 'All caught up' : school.todayLeft ? `${plural(school.todayLeft, 'block')} today` : `${Math.round(school.pct * 100)}% this week`}</div>
    </button>`);
  }
  for (const c of (S.commitments || []).filter((x) => !x.archived)) {
    const p = weekProgress(c, S.checkins);
    tiles.push(`<button class="ring-tile ${p.met ? 'done' : ''}" data-act="open-commit" data-id="${c.id}" aria-label="${esc(c.title)}: ${p.label} this week">
      ${ring({ pct: p.pct, color: activityColor(c), size: 40, stroke: 4, inner: commitmentIcon(c), label: c.title })}
      <div class="t">${esc(c.title)}</div>
      <div class="m">${p.met ? 'Done this week' : `${p.label} this week`}</div>
    </button>`);
  }
  if (withAdd) {
    tiles.push(`<button class="ring-tile add" data-act="add-commit" aria-label="Add an activity">
      <span class="plus">${svg(I.plus, 16)}</span><div class="t">Add activity</div></button>`);
  }
  return `<div class="rings">${tiles.join('')}</div>`;
}

/**
 * The day as one continuous path. Activities wear their own colour, except
 * under the calendar's legend (byKind), which names only the four kinds.
 */
export function timeline(k, { emptyText = 'Nothing planned.', byKind = false } = {}) {
  const items = dayAgenda(k).filter((it) => !it.allDay);
  const tint = (c) => (byKind ? '' : ` style="--c:${activityColor(c)}"`);
  if (!items.length) return `<div class="card soft center small muted">${emptyText}</div>`;
  const today = dateKey(new Date()) === k;
  const now = Date.now();

  return `<div class="timeline">${items.map((it) => {
    const future = it.at > now;
    if (it.type === 'busy') {
      return `<div class="tl-item busy k-${it.source === 'school' ? 'school' : 'event'}"><div class="tl-time">${fmtTime(it.at)}</div><div class="tl-node"><span class="node-dot"></span></div>
        <div class="tl-card"><div class="grow"><div class="t">${esc(it.title)}</div><div class="m">until ${fmtTime(it.end)}</div></div></div></div>`;
    }
    if (it.type === 'fixed') {
      const c = it.commitment;
      const done = !!it.checkin;
      const canCheck = !future || !today ? true : false;
      return `<div class="tl-item k-activity ${done ? 'done' : ''}"${tint(c)}>
        <div class="tl-time">${fmtTime(it.at)}</div>
        <div class="tl-node">${canCheck || done
          ? `<button class="check ${done ? 'on' : ''}" data-act="${done ? 'undo-checkin' : 'checkin'}" data-id="${done ? it.checkin.id : c.id}" data-day="${k}" aria-label="${done ? 'Undo check-in' : `Check in: ${esc(c.title)}`}">${svg(I.check)}</button>`
          : '<span class="node-dot"></span>'}</div>
        <button class="tl-card tap" data-act="open-commit" data-id="${c.id}">
          <span class="kind">${commitmentIcon(c)}</span>
          <div class="grow"><div class="t">${esc(c.title)}</div><div class="m">${fmtTime(it.at)} to ${fmtTime(it.end)}${done ? ` · ${fmtMinutes(it.checkin.minutes)} logged` : ''}</div></div>
        </button></div>`;
    }
    if (it.type === 'checkin') {
      const c = it.commitment;
      return `<div class="tl-item k-activity done"${tint(c)}><div class="tl-time">${fmtTime(it.at)}</div>
        <div class="tl-node"><button class="check on" data-act="undo-checkin" data-id="${it.checkin.id}" aria-label="Undo check-in">${svg(I.check)}</button></div>
        <button class="tl-card tap" data-act="open-commit" data-id="${c.id}"><span class="kind">${commitmentIcon(c)}</span>
          <div class="grow"><div class="t">${esc(c.title)}</div><div class="m">${fmtMinutes(it.checkin.minutes)} logged</div></div></button></div>`;
    }
    // planned block
    const s = it.session;
    const c = it.commitment;
    const running = s.startedAt && !s.done;
    const act = s.done ? 'undo-session' : c ? 'checkin-session' : 'finish-session';
    return `<div class="tl-item k-${c ? 'activity' : 'work'} ${s.done ? 'done' : ''} ${running ? 'now-line' : ''}"${c ? tint(c) : ''}>
      <div class="tl-time">${fmtTime(s.start)}</div>
      <div class="tl-node"><button class="check ${s.done ? 'on' : ''}" data-act="${act}" data-id="${s.id}" aria-label="${s.done ? 'Mark not done' : `Done: ${esc(s.title)}`}">${svg(I.check)}</button></div>
      <button class="tl-card tap" data-act="${c ? 'open-commit' : 'open-guide'}" data-id="${c ? c.id : s.taskId}">
        <span class="kind">${c ? commitmentIcon(c) : svg(I.school)}</span>
        <div class="grow">
          <div class="t">${esc(s.title)}</div>
          <div class="m">${running ? 'In progress · ' : ''}${s.minutes} min${c ? '' : ` · ${esc(s.courseName || 'Homework')}`}${!c && s.parts > 1 ? ` · part ${s.part} of ${s.parts}` : ''}</div>
        </div>
      </button>
    </div>`;
  }).join('')}</div>`;
}

/** Eight little dots: the last eight weeks, filled when the target was met. */
/**
 * One dot per week, filled when that week's goal was met. It sits next to a
 * "2 of 5 this week" count, so it has to say that it's a different number —
 * weeks, not sessions.
 */
export function weekDots(c, weeks = 8) {
  const S = app.S;
  const out = [];
  let hit = 0;
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 7 * 86400000);
    const met = weekProgress(c, S.checkins, d).met;
    if (met) hit++;
    out.push(`<i class="${met ? 'on' : ''}"></i>`);
  }
  const label = `${hit} of the last ${weeks} weeks hit`;
  return `<span class="week-dots" role="img" data-tip="${label}" aria-label="${label}">${out.join('')}</span>`;
}

export function scheduleLabel(c, daysLabel) {
  if (isFixed(c)) return `${daysLabel(c.schedule.days)} · ${range(c.schedule.start, c.schedule.end)}`;
  const t = { morning: ' · mornings', afternoon: ' · afternoons', evening: ' · evenings' }[c.time] || '';
  return `${c.target.sessions}× a week · ${fmtMinutes(c.target.minutes)}${t}`;
}

export { weekStreak, KINDS, commitmentById };
