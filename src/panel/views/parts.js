// Pieces more than one screen draws: the rings deck, the day timeline, and
// the shared illustration.

import { app, dayAgenda, schoolWeek, commitmentById } from '../core.js';
import { weekProgress, weekStreak, KINDS, isFixed } from '../../lib/habits.js';
import { fmtTime, fmtMinutes, dateKey, startOfDay, fmtClock } from '../../lib/util.js';
import { ring, svg, I, KIND_ICON, esc, colorFor, range, fromMin, plural, activityColor } from '../ui.js';
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
 * The whole day as one bar, from waking to bed: school, events, activities
 * and homework in their colours, and where now is. It is the first thing on
 * Today so a day reads in one look; the timeline below it has the detail.
 */
export function dayStrip(k) {
  const S = app.S;
  const day = new Date(`${k}T00:00:00`);
  const now = Date.now();
  // Wall-clock minutes from this day's midnight (1500 is 1am tomorrow), so
  // the bar reads right on the two days a year the clocks change.
  const wall = (ms) => {
    const d = new Date(ms);
    return Math.round((+startOfDay(d) - +day) / 86400000) * 1440 + d.getHours() * 60 + d.getMinutes();
  };
  const at = (m) => fmtClock(fromMin(((Math.round(m) % 1440) + 1440) % 1440));
  const hm = (t) => { const [h, m] = String(t || '').split(':').map(Number); return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0); };
  const wake = hm(S.sleep?.wake || '07:00');
  let bed = hm(S.sleep?.bed || '22:30');
  if (bed <= wake + 60) bed += 1440;           // a bedtime after midnight is still tonight

  const order = { school: 0, event: 1, activity: 2, work: 3 };
  const segs = [];
  for (const it of dayAgenda(k)) {
    if (it.allDay) continue;
    let a = it.at, b = it.end, kind, title, c = it.commitment || null, done = false;
    if (it.type === 'busy') { kind = it.source === 'school' ? 'school' : 'event'; title = it.title; }
    else if (it.type === 'fixed') { kind = 'activity'; title = c.title; done = !!it.checkin; }
    else if (it.type === 'checkin') { b = it.at; a = it.at - (it.checkin.minutes || 30) * 60000; kind = 'activity'; title = c.title; done = true; }
    else { kind = c ? 'activity' : 'work'; title = it.session.title; done = !!it.session.done; }
    if (!(b > a)) continue;
    segs.push({ a: wall(a), b: wall(b), kind, title, c, done, past: b <= now });
  }

  // Something just before waking or just after bed widens the bar to fit it.
  // Something that runs for days (a trip) does not: it is cut to the bar.
  let start = wake, end = bed;
  for (const g of segs) {
    if (g.a < start && g.a >= wake - 240) start = Math.floor(g.a / 60) * 60;
    if (g.b > end && g.b <= bed + 240) end = Math.ceil(g.b / 60) * 60;
  }
  // Up early or still up tonight: the same stretch keeps "now" on the bar.
  const today = dateKey(new Date()) === k;
  const nowMin = wall(now);
  if (today && nowMin < start && nowMin >= wake - 240) start = Math.floor((nowMin - 15) / 60) * 60;
  if (today && nowMin > end && nowMin <= bed + 240) end = Math.ceil((nowMin + 15) / 60) * 60;
  start = Math.max(0, start);
  const span = Math.max(60, end - start);
  const pct = (m) => Math.min(100, Math.max(0, ((m - start) / span) * 100));
  const shown = segs
    .map((g) => ({ ...g, a: Math.max(g.a, start), b: Math.min(g.b, end) }))
    .filter((g) => g.b > g.a);

  // School is the backdrop: anything during school hours (class periods from
  // a calendar, a dentist visit) sits on top of it, and School keeps its name
  // only where nothing covers it. Everything else that overlaps shares the
  // height in rows, so nothing hides another or cuts its name short.
  const overlaps = (x, y) => x.a < y.b && y.a < x.b;
  const rest = shown.filter((g) => g.kind !== 'school').sort((x, y) => x.a - y.a || order[x.kind] - order[y.kind]);
  const folds = [];
  let cluster = [], clusterEnd = -Infinity;
  const flush = () => {
    const lanes = [];
    for (const g of cluster) {
      let i = lanes.findIndex((endAt) => endAt <= g.a);
      if (i < 0) { lanes.push(g.b); i = lanes.length - 1; } else lanes[i] = g.b;
      g.lane = i;
    }
    if (lanes.length <= 2) { for (const g of cluster) g.lanes = lanes.length; return; }
    // Three or more at once: the first row stays, the rest fold into one
    // "+N" block in the second row, as on the week grid.
    const others = cluster.filter((g) => g.lane >= 1);
    for (const g of cluster) { g.lanes = 2; if (g.lane >= 1) g.folded = true; }
    folds.push({ a: Math.min(...others.map((g) => g.a)), b: Math.max(...others.map((g) => g.b)), kind: others[0].kind, title: `+${others.length}`, lane: 1, lanes: 2, past: others.every((g) => g.past) });
  };
  for (const g of rest) {
    if (cluster.length && g.a >= clusterEnd) { flush(); cluster = []; clusterEnd = -Infinity; }
    cluster.push(g); clusterEnd = Math.max(clusterEnd, g.b);
  }
  if (cluster.length) flush();

  const seg = (g, extra = '', named = true) => {
    const left = pct(g.a), width = Math.max(0.6, pct(g.b) - left);
    const colour = g.c ? `;--c:${activityColor(g.c)}` : '';
    const rows = g.lanes > 1 ? `;top:calc(4px + (100% - 8px) * ${g.lane} / ${g.lanes});bottom:auto;height:calc((100% - 8px) / ${g.lanes} - 2px)` : '';
    return `<span class="ds-seg k-${g.kind}${g.past || g.done ? ' past' : ''}${g.lanes > 1 ? ' row' : ''}${extra}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%${colour}${rows}">${named ? `<span>${esc(g.title)}</span>` : ''}</span>`;
  };
  const bars = [
    ...shown.filter((g) => g.kind === 'school').map((g) => seg(g, ' backdrop', !rest.some((o) => overlaps(o, g)))),
    ...rest.filter((g) => !g.folded).map((g) => seg(g)),
    ...folds.map((g) => seg(g))
  ].join('');

  const marker = today && nowMin >= start && nowMin <= end
    ? `<span class="ds-now" style="left:${pct(nowMin).toFixed(2)}%"></span>` : '';
  const ticks = [`<span style="left:0">${esc(at(start))}</span>`];
  const noon = pct(720);
  if (noon > 18 && noon < 82) ticks.push(`<span class="mid" style="left:${noon.toFixed(2)}%">noon</span>`);
  ticks.push(`<span class="end" style="left:100%">${esc(at(end))}</span>`);

  const said = shown.slice().sort((x, y) => x.a - y.a).slice(0, 10).map((g) => `${g.title} ${at(g.a)} to ${at(g.b)}`).join(', ');
  const label = `${today ? 'Today' : 'This day'} from ${at(start)} to ${at(end)}${said ? `: ${said}` : ', nothing planned'}`;

  return `<div class="day-strip" role="img" aria-label="${esc(label)}">
    <div class="ds-bar">${bars}${marker}</div>
    <div class="ds-axis" aria-hidden="true">${ticks.join('')}</div>
  </div>`;
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
