// Free-time model: weekly availability minus real calendar events.
// Also contains a small .ics parser so a Google/Apple/Outlook calendar export
// can be dropped in without any OAuth setup.

import { atTime, addDays, startOfDay, dateKey, overlap, MIN } from './util.js';

/**
 * Free slots between `from` and `to`, already trimmed by busy events.
 * @returns {{start:Date,end:Date}[]} sorted, non-overlapping
 */
export function freeSlots(from, to, availability, busy = [], opts = {}) {
  const minLen = (opts.sessionMinMin ?? 20) * MIN;
  const out = [];
  const busyRanges = busy
    .map((b) => ({ start: new Date(b.start), end: new Date(b.end) }))
    .filter((b) => b.end > from && b.start < to)
    .sort((a, b) => a.start - b.start);

  for (let day = startOfDay(from); day <= to; day = addDays(day, 1)) {
    const windows = availability?.[day.getDay()] || [];
    for (const w of windows) {
      let start = atTime(day, w.start);
      let end = atTime(day, w.end);
      if (end <= start) end = addDays(end, 1);         // window crosses midnight
      if (end <= from || start >= to) continue;
      // Blocks that start "now" snap to the next quarter hour — 3:30, not 3:21.
      if (start < from) start = new Date(Math.ceil(+from / (15 * MIN)) * 15 * MIN);
      if (end > to) end = new Date(to);

      // Subtract every busy block that intersects this window.
      let pieces = [{ start, end }];
      for (const b of busyRanges) {
        const next = [];
        for (const p of pieces) {
          if (!overlap(p.start, p.end, b.start, b.end)) { next.push(p); continue; }
          if (b.start > p.start) next.push({ start: p.start, end: new Date(Math.min(+b.start, +p.end)) });
          if (b.end < p.end) next.push({ start: new Date(Math.max(+b.end, +p.start)), end: p.end });
        }
        pieces = next;
      }
      for (const p of pieces) if (p.end - p.start >= minLen) out.push(p);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Total free minutes in a window — the number priority scoring leans on. */
export function freeMinutesBetween(from, to, availability, busy, opts) {
  if (to <= from) return 0;
  const cap = (opts?.dailyCapacityMin ?? 180);
  const byDay = new Map();
  for (const s of freeSlots(from, to, availability, busy, opts)) {
    const k = dateKey(s.start);
    byDay.set(k, (byDay.get(k) || 0) + (s.end - s.start) / MIN);
  }
  // Free time on the calendar isn't the same as homework capacity.
  let total = 0;
  for (const mins of byDay.values()) total += Math.min(mins, cap);
  return total;
}

// ---------------------------------------------------------------- ICS import

function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

function parseIcsDate(value, params = '') {
  // 20260910T153000Z | 20260910T153000 | 20260910 (all-day)
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (!h) return { date: new Date(Number(y), Number(mo) - 1, Number(d)), allDay: true };
  if (z || /TZID=UTC/i.test(params)) {
    return { date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)), allDay: false };
  }
  return { date: new Date(+y, +mo - 1, +d, +h, +mi, +s), allDay: false };
}

/**
 * Parse an .ics file into busy blocks. Handles the common case (VEVENT with
 * DTSTART/DTEND) plus weekly RRULEs, which is what class schedules use.
 */
export function parseICS(text, { horizonDays = 60 } = {}) {
  const events = [];
  const lines = unfold(text).split('\n');
  let cur = null;
  const horizon = addDays(new Date(), horizonDays);

  for (const line of lines) {
    if (/^BEGIN:VEVENT/i.test(line)) { cur = {}; continue; }
    if (/^END:VEVENT/i.test(line)) {
      if (cur?.start && cur?.end) events.push(...expand(cur, horizon));
      cur = null;
      continue;
    }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const rawKey = line.slice(0, idx);
    const value = line.slice(idx + 1).trim();
    const key = rawKey.split(';')[0].toUpperCase();
    const params = rawKey.slice(key.length);

    if (key === 'DTSTART') { const p = parseIcsDate(value, params); if (p) { cur.start = p.date; cur.allDay = p.allDay; } }
    else if (key === 'DTEND') { const p = parseIcsDate(value, params); if (p) cur.end = p.date; }
    else if (key === 'SUMMARY') cur.title = value.replace(/\\,/g, ',').replace(/\\n/gi, ' ');
    else if (key === 'RRULE') cur.rrule = value;
    else if (key === 'UID') cur.uid = value;
    else if (key === 'URL') cur.url = value.replace(/\\/g, '');
    else if (key === 'LOCATION') cur.location = value.replace(/\\,/g, ',');
    else if (key === 'DESCRIPTION') cur.description = value.replace(/\\,/g, ',').replace(/\\n/gi, '\n');
    else if (key === 'TRANSP') cur.transparent = value.toUpperCase() === 'TRANSPARENT';
  }
  return events;
}

function expand(ev, horizon) {
  const base = {
    title: ev.title || 'Busy',
    source: 'ics',
    allDay: !!ev.allDay,
    uid: ev.uid || '',
    url: ev.url || '',
    description: ev.description || '',
    transparent: !!ev.transparent
  };
  const dur = ev.end - ev.start;
  const out = [];
  const push = (start) => out.push({
    ...base,
    id: `ics_${ev.uid || base.title}_${+start}`,
    start: new Date(start).toISOString(),
    end: new Date(+start + dur).toISOString()
  });

  if (!ev.rrule || !/FREQ=(WEEKLY|DAILY)/i.test(ev.rrule)) {
    if (ev.end > new Date(Date.now() - 24 * 3600e3)) push(ev.start);
    return out;
  }
  const freq = /FREQ=DAILY/i.test(ev.rrule) ? 1 : 7;
  const untilM = ev.rrule.match(/UNTIL=(\d{8})/i);
  const until = untilM ? new Date(+untilM[1].slice(0, 4), +untilM[1].slice(4, 6) - 1, +untilM[1].slice(6, 8)) : horizon;
  const byDay = (ev.rrule.match(/BYDAY=([^;]+)/i)?.[1] || '').split(',').filter(Boolean);
  const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  const stop = new Date(Math.min(+until, +horizon));

  for (let d = new Date(ev.start); d <= stop; d = addDays(d, freq === 1 ? 1 : 1)) {
    if (freq === 7) {
      const days = byDay.length ? byDay.map((x) => DOW[x.slice(-2)]) : [ev.start.getDay()];
      if (!days.includes(d.getDay())) continue;
    }
    const start = new Date(d);
    start.setHours(ev.start.getHours(), ev.start.getMinutes(), 0, 0);
    if (start < new Date(Date.now() - 24 * 3600e3)) continue;
    push(start);
    if (out.length > 400) break;
  }
  return out;
}

// ------------------------------------------------------------ activities

/**
 * Recurring activities ("Soccer, Tue & Thu, 4–6pm") become concrete busy
 * blocks for the planning window. Stored as a rule so the student sets it once.
 * @param {{id,title,days:number[],start:string,end:string}[]} activities
 */
export function expandActivities(activities = [], from = new Date(), days = 21) {
  const out = [];
  for (let i = -1; i <= days; i++) {
    const day = addDays(startOfDay(from), i);
    for (const a of activities) {
      if (!a.days?.includes(day.getDay())) continue;
      const start = atTime(day, a.start);
      let end = atTime(day, a.end);
      if (end <= start) end = addDays(end, 1);
      out.push({ id: `act_${a.id}_${dateKey(day)}`, title: a.title, start: start.toISOString(), end: end.toISOString(), source: 'activity' });
    }
  }
  return out;
}
