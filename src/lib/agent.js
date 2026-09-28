// The planning agent: plain sentences in, real changes to the week out.
//
// "I have dinner at 6 and I can stay up till midnight" becomes a busy block
// tonight and a later cutoff for tonight only — then the scheduler moves the
// homework itself. Everything here is offline. With an access key, ai.js can
// read the same sentence and hand back the same ops, which is better at odd
// phrasing; this file is what makes the agent work for everyone else.
//
// Nothing writes to state directly: interpret() returns ops, the caller shows
// them, applyOps() performs them. That split is what makes undo one snapshot.

import { addDays, startOfDay, atTime, dateKey, uid, fmtDay } from './util.js';
import { newCommitment, KINDS } from './habits.js';
import { classify } from './estimator.js';

const DOW = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DOW_ABBR = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const NUMWORD = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40,
  fortyfive: 45, 'forty five': 45, forty_five: 45, sixty: 60, ninety: 90, half: 0.5
};

// How long things take when nobody says. Better than defaulting everything to
// an hour: a dinner that eats two hours of the evening makes the plan wrong.
const DURATIONS = [
  [/\b(dinner|supper)\b/, 60], [/\blunch\b/, 45], [/\bbreakfast\b/, 30],
  [/\b(practice|rehearsal|training|lesson)\b/, 90], [/\b(game|match|meet|tournament|concert|recital)\b/, 120],
  [/\b(shift|work)\b/, 180], [/\b(class|club|meeting|tutoring|therapy|session)\b/, 60],
  [/\b(appointment|dentist|doctor|orthodontist|haircut)\b/, 60],
  [/\b(drive|driving|commute)\b/, 30], [/\b(dinner with|party|hangout|hang out)\b/, 120]
];

const pad = (n) => String(n).padStart(2, '0');
const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };
const fromMin = (m) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
const titleCase = (s) => s.replace(/^\s*[a-z]/, (c) => c.toUpperCase());
const num = (w) => {
  if (w == null) return null;
  const t = String(w).trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  return NUMWORD[t] ?? null;
};

// ------------------------------------------------------------------ time

/**
 * Turn a clock fragment into "HH:MM".
 * `hint` decides what a bare number means: 'late' for "up until 11" (pm),
 * 'morning' for "free after 9" on a weekend, 'day' for everything else.
 */
function clock(h, min, ampm, hint = 'day') {
  let hour = Number(h);
  const m = Number(min || 0);
  const ap = (ampm || '').replace(/[.\s]/g, '').toLowerCase();
  if (ap.startsWith('p')) hour = hour === 12 ? 12 : hour + 12;
  else if (ap.startsWith('a')) hour = hour === 12 ? 0 : hour;
  else if (hint === 'late') hour = hour <= 11 ? hour + 12 : hour;      // "till 11" is at night
  else if (hint === 'day' && hour <= 7) hour += 12;                     // "at 6" after school is 6pm
  if (hour >= 24) hour -= 24;
  return `${pad(hour)}:${pad(m)}`;
}

const TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\b/i;

function readTime(text, hint = 'day') {
  const t = String(text);
  if (/\bmidnight\b/i.test(t)) return '23:59';
  if (/\bnoon\b/i.test(t)) return '12:00';
  const m = t.match(TIME_RE);
  return m ? clock(m[1], m[2], m[3], hint) : null;
}

/** "4-6", "from 4 to 5:30", "6pm until 8" -> {start, end} */
function readRange(text) {
  const m = String(text).match(
    /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:-|–|—|to|until|til|till|through|thru)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\b/i
  );
  if (!m) return null;
  const endAp = m[6] || m[3];
  let start = clock(m[1], m[2], m[3] || (endAp && Number(m[1]) <= Number(m[4]) ? endAp : null));
  let end = clock(m[4], m[5], m[6], 'day');
  // "4 to 6" in the afternoon: keep the pair on the same side of noon.
  if (toMin(end) <= toMin(start)) {
    const bumped = toMin(end) + 12 * 60;
    if (bumped < 24 * 60 && bumped > toMin(start)) end = fromMin(bumped);
  }
  return { start, end };
}

/** "for an hour and a half", "for 90 minutes" -> minutes */
function readDuration(text) {
  const t = String(text).toLowerCase();
  let m = t.match(/\bfor\s+(?:about\s+)?(\d+(?:\.\d+)?|a|an|one|two|three|four|half)\s*(?:and\s+a\s+half\s*)?(hours?|hrs?|h)\b/);
  if (m) {
    const n = num(m[1]) ?? 1;
    return Math.round((n + (/and\s+a\s+half/.test(t) ? 0.5 : 0)) * 60);
  }
  m = t.match(/\bfor\s+(?:about\s+)?(\d+|ten|fifteen|twenty|thirty|forty|forty five|sixty|ninety)\s*(minutes?|mins?|m)\b/);
  if (m) return num(m[1]) ?? 60;
  if (/\bfor\s+half\s+an\s+hour\b/.test(t)) return 30;
  m = t.match(/\btakes?\s+(?:me\s+)?(?:about|like|around|roughly)?\s*(\d+(?:\.\d+)?|a|an|one|two|three|half)\s*(hours?|hrs?|minutes?|mins?)\b/);
  if (m) { const n = num(m[1]) ?? 1; return /h/i.test(m[2]) ? Math.round(n * 60) : Math.round(n); }
  if (/\ball\s+(?:day|afternoon|evening)\b/.test(t)) return 240;
  return null;
}

function defaultDuration(text) {
  for (const [re, min] of DURATIONS) if (re.test(text)) return min;
  return 60;
}

// ------------------------------------------------------------------ days

/**
 * Which days a clause is about.
 * @returns {{dates: Date[], days: number[], repeats: boolean, matched: string}}
 *   dates — specific calendar days;  days — weekday numbers, when it recurs
 */
function readDays(text, now = new Date()) {
  const t = String(text).toLowerCase();
  const out = { dates: [], days: [], repeats: false, matched: '' };
  const mark = (s) => { out.matched = out.matched || s; };

  if (/\bevery\s*day|\bdaily\b|\beach day\b/.test(t)) { out.days = [0, 1, 2, 3, 4, 5, 6]; out.repeats = true; mark('day'); return out; }
  if (/\b(weekdays|school nights|school days|every school night)\b/.test(t)) { out.days = [1, 2, 3, 4, 5]; out.repeats = true; mark('weekdays'); return out; }
  if (/\bweekends?\b/.test(t)) { out.days = [0, 6]; out.repeats = true; mark('weekends'); return out; }

  // Named weekdays, singly or in a list: "tue and thu", "mon/wed/fri", "Tuesdays"
  const found = [];
  for (let i = 0; i < 7; i++) {
    const re = new RegExp(`\\b(${DOW[i]}|${DOW_ABBR[i]})s?\\b`, 'i');
    if (re.test(t)) found.push(i);
  }
  if (found.length) {
    const plural = new RegExp(`\\b(?:${DOW.join('|')}|${DOW_ABBR.join('|')})s\\b`, 'i').test(t);
    const every = /\bevery\b|\beach\b/.test(t);
    mark(joinDays(found));
    if (plural || every || found.length > 1) { out.days = found; out.repeats = true; return out; }
    let day = nextWeekday(now, found[0]);
    // "next Thursday" means the one after this week's, when this week has one.
    if (/\bnext\b/.test(t) && day < addDays(startOfDay(now), 7 - now.getDay())) day = addDays(day, 7);
    out.dates = [day];
    return out;
  }

  if (/\btonight\b|\btoday\b|\bthis (?:afternoon|evening)\b/.test(t)) { out.dates = [new Date(now)]; mark('today'); return out; }
  if (/\btomorrow\b|\btmrw?\b/.test(t)) { out.dates = [addDays(now, 1)]; mark('tomorrow'); return out; }

  const md = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/);
  if (md) {
    const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(md[1]);
    const d = new Date(now.getFullYear(), month, Number(md[2]));
    if (d < startOfDay(now)) d.setFullYear(d.getFullYear() + 1);
    out.dates = [d];
    mark(md[0]);
    return out;
  }
  const slash = t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (slash) {
    const d = new Date(now.getFullYear(), Number(slash[1]) - 1, Number(slash[2]));
    if (d < startOfDay(now)) d.setFullYear(d.getFullYear() + 1);
    out.dates = [d];
    mark(slash[0]);
  }
  return out;
}

/** "Mon, Wed & Fri" — how a person would say a list of days. */
function joinDays(days) {
  const names = days.map((d) => titleCase(DOW_ABBR[d]));
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} & ${names.at(-1)}` : names[0];
}

function nextWeekday(now, dow) {
  const d = startOfDay(now);
  const delta = (dow - d.getDay() + 7) % 7;
  return addDays(d, delta === 0 ? 7 : delta);
}

// --------------------------------------------------------------- clauses

/**
 * Split a message into the separate things being asked for, without breaking
 * "tuesday and thursday" apart.
 */
export function clauses(text) {
  const rough = String(text)
    .split(/[\n.;]+|,\s*(?=(?:and\s+)?(?:i|i'?m|also|then|plus|but|it|that|which|should)\b)|\s+and\s+(?=(?:i|i'?m|also|then|my|we)\b)|\s+also\s+/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
  return rough.flatMap(splitCompound);
}

// "dinner at 6, practice Tue and Thu 4-6" is two plans; "Tuesday and
// Thursday" is one list. Split only where both sides carry their own when,
// and never where the right side is continuing a list of days.
const WHEN_RE = /\b(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|midnight|noon|today|tonight|tomorrow|weekdays?|weekends?|every day|sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)\b/i;
const CONTINUES = /^(?:sun|mon|tue|wed|thu|fri|sat|\d|then\b|the\b|a\b|an\b)/i;
const SEP = /,\s*(?:and\s+)?|\s+and\s+/gi;

function splitCompound(piece) {
  SEP.lastIndex = 0;
  let m;
  while ((m = SEP.exec(piece))) {
    const left = piece.slice(0, m.index).trim();
    const right = piece.slice(m.index + m[0].length).trim();
    if (!left || !right) continue;
    if (!WHEN_RE.test(left) || !WHEN_RE.test(right) || CONTINUES.test(right)) continue;
    return [left, ...splitCompound(right)];
  }
  return [piece];
}

const STRIP = [
  /^(?:hey|hi|ok|okay|so|um|uh|well|please|can you|could you|i need you to|i want you to|add|put in|schedule|block off|block out)\b[\s,:]*/i,
  /^(?:i|we)\s+(?:have|has|have got|'ve got|ve got|got|gotta|have to|need to|hafta)\s+(?:a|an|my|the)?\s*/i,
  /^(?:there(?:'s| is)|its|it's)\s+(?:a|an)?\s*/i,
  /^my\s+/i,
  /^(?:i'?m|im|we're|were)\s+/i
];

/** What to call the thing, once the scheduling words are taken out. */
function readTitle(clause, { matchedDay = '' } = {}) {
  let s = ' ' + clause + ' ';
  s = s.replace(/\b(from|at|on|starting|start|between)?\s*\d{1,2}(?::\d{2})?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:-|–|—|to|until|til|till)\s*\d{1,2}(?::\d{2})?\s*(a\.?m\.?|p\.?m\.?)?/gi, ' ');
  s = s.replace(/\b(?:at|by|around|about|from|after|before|until|til|till)\s+\d{1,2}(?::\d{2})?\s*(a\.?m\.?|p\.?m\.?)?/gi, ' ');
  s = s.replace(/\bfor\s+(?:about\s+)?[\w\s]{1,12}?(hours?|hrs?|minutes?|mins?)\b/gi, ' ');
  s = s.replace(/,?\s*(?:it|that|this)?\s*(?:should|will|might|takes?|'ll)\s+take[\w\s]{0,20}?(hours?|hrs?|minutes?|mins?)\b/gi, ' ');
  s = s.replace(/\b(every|each)\s+(day|night|morning|afternoon|evening|week)\b/gi, ' ');
  s = s.replace(/\b(every|each|next|this|coming|upcoming|daily)\b/gi, ' ');
  s = s.replace(new RegExp(`\\b(${DOW.join('|')}|${DOW_ABBR.join('|')})s?\\b`, 'gi'), ' ');
  s = s.replace(/\b(today|tonight|tomorrow|tmrw|this (?:afternoon|evening|morning)|weekdays|weekends?|school nights?|midnight|noon)\b/gi, ' ');
  s = s.replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/gi, ' ');
  for (const re of STRIP) s = s.replace(re, ' ');
  for (const re of STRIP) s = s.trim().replace(re, '');
  s = s.replace(/\b(nights?|evenings?|mornings?|afternoons?|after school)\b/gi, ' ');
  s = s.replace(/\s+/g, ' ').replace(/\s+([,;])/g, '$1').replace(/^[\s,–-]+|[\s,–-]+$/g, '');
  // Removing the day and time leaves joiners behind: "practice and", "with".
  const JOIN = /^(?:and|or|with|for|on|at|in|to|from|the|a|an|of|is|was|i|we|have|has|had|got|gotta|need)\b\s*/i;
  const TAIL = /\s*\b(?:and|or|with|for|on|at|in|to|from|the|a|an|of)$/i;
  for (let i = 0; i < 4 && JOIN.test(s); i++) s = s.replace(JOIN, '');
  for (let i = 0; i < 4 && TAIL.test(s); i++) s = s.replace(TAIL, '');
  s = s.trim();
  if (!s || s.length < 2) return matchedDay ? `Busy ${matchedDay}` : 'Busy';
  return titleCase(s.slice(0, 60));
}

// ------------------------------------------------------------ the reading

/**
 * Read one clause into an op, or null when there's nothing schedulable in it.
 * Order matters: a sentence about when she's free is not an event, and a
 * sentence about a test is not a dinner.
 */
function readClause(clause, state, now) {
  const t = clause.toLowerCase();
  const when = readDays(clause, now);

  // 1. "I can stay up till midnight", "I have to be in bed by 10"
  const lateRe = /\b(?:stay|be|stay|am|i'?m)?\s*(?:up|awake|working|studying|free|available)?\s*(?:un)?til+\s+(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|midnight|noon)\b/i;
  const bedRe = /\b(?:in bed|asleep|sleep|go to bed|bed)\s*(?:by|at|before)\s+(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|midnight)\b/i;
  const stayUp = /\bstay\s+up\b|\bstay\s+awake\b|\bup\s+(?:un)?til\b|\bawake\b/i.test(t);
  if ((stayUp || /\b(?:free|available|can work|can study|work|study)\b/.test(t)) && lateRe.test(t) && !/\bdue\b/.test(t)) {
    const end = readTime(lateRe.exec(t)[1], 'late');
    if (end) return windowOp(state, when, { end }, now);
  }
  if (bedRe.test(t)) {
    const end = readTime(bedRe.exec(t)[1], 'late');
    if (end) return windowOp(state, when, { end }, now);
  }

  // 2. "I'm free after 4", "I can't start until 7"
  const afterRe = /\b(?:free|available|around|home|done|start(?:ing)?|can (?:work|study|start))\s*(?:from|after|at|starting)\s+(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|noon)\b/i;
  if (afterRe.test(t) && !/\bdue\b/.test(t)) {
    const start = readTime(afterRe.exec(t)[1], 'day');
    if (start) return windowOp(state, when, { start }, now);
  }

  // 3. "I can only do an hour of homework tonight"
  const capRe = /\b(?:only|just|at most|max)\b[^.]*?\b(\d+|an?|one|two|three|thirty|forty five|ninety)\s*(hours?|hrs?|minutes?|mins?)\b/i;
  if (capRe.test(t) && /\b(homework|work|studying|study)\b/.test(t)) {
    const m = capRe.exec(t);
    const n = num(m[1]) ?? 1;
    const minutes = /h/i.test(m[2]) ? Math.round(n * 60) : Math.round(n);
    return { kind: 'capacity', minutes, summary: `Homework capped at ${minutes >= 60 ? `${Math.round(minutes / 60 * 10) / 10}h` : `${minutes}m`} a day` };
  }

  // 4. "I want to practice piano 5 times a week for 30 minutes"
  const perWeek = t.match(/\b(\d+|once|twice|one|two|three|four|five|six|seven)\s*(?:x|times?)?\s*(?:a|per|each)\s*week\b/);
  if (perWeek && /\b(want|try|goal|aim|practice|keep|start)\b/.test(t)) {
    const sessions = { once: 1, twice: 2 }[perWeek[1]] ?? num(perWeek[1]) ?? 3;
    const minutes = readDuration(clause) || 30;
    const title = readTitle(clause.replace(perWeek[0], ' ').replace(/\b(i\s+)?(want|would like|wanna)\s+to\b/i, ' '), {});
    return {
      kind: 'commitment',
      commitment: { title, kind: guessKind(t), target: { sessions, minutes }, schedule: { mode: 'flexible' }, days: when.days },
      summary: `${title} — ${sessions}× a week, ${minutes}m`
    };
  }

  // 5. "Bio test Friday", "essay due next Thursday"
  const workRe = /\b(due|test|quiz|exam|midterm|final|essay|paper|assignment|homework|hw|project|problem set|pset|lab report|reading|read)\b/i;
  if (workRe.test(t) && !/\b(practice|rehearsal|dinner|lunch|appointment)\b/.test(t)) {
    const day = when.dates[0] || (when.days.length ? nextWeekday(now, when.days[0]) : null);
    if (day) {
      const time = readTime(clause, 'day');
      const due = atTime(day, time && !/\bdue\b.*\bnext\b/.test(t) ? time : '23:59');
      const title = readTitle(clause.replace(/\bdue\b/gi, ' '), {});
      const minutes = readDuration(clause);
      return {
        kind: 'task',
        task: { title, due: due.toISOString(), minutes },
        summary: `${title} — due ${fmtDay(due)}`
      };
    }
  }

  // 6. Anything else with a clock on it is an event that blocks time.
  // "…should take about two hours" is an estimate, not a two o'clock event.
  if (/\b(?:should|will|might|would|takes?|'ll)\s+take\b/.test(t) && !when.dates.length && !when.repeats) return null;

  const range = readRange(clause);
  // "Saturday night" has no clock in it, but it's still a plan.
  const PART = [[/\b(nights?|evenings?|tonight)\b/, '19:00'], [/\bafternoons?\b/, '14:00'], [/\bmornings?\b/, '09:00'], [/\bafter school\b/, '15:45']];
  const part = PART.find(([re]) => re.test(t));
  const start = range?.start || readTime(clause, 'day') || (part ? part[1] : null);
  if (!start) return null;
  const minutes = readDuration(clause) || defaultDuration(t);
  const end = range?.end || fromMin(Math.min(toMin(start) + minutes, 23 * 60 + 59));
  const title = readTitle(clause, { matchedDay: when.matched });
  const dates = when.dates.length ? when.dates : (when.repeats ? [] : [new Date(now)]);
  return {
    kind: 'event',
    event: { title, start, end, days: when.repeats ? when.days : [], dates: dates.map((d) => dateKey(d)) },
    summary: `${title} · ${label(start)}–${label(end)} ${when.repeats ? `every ${when.matched}` : whenLabel(dates[0], now)}`.trim()
  };
}

function guessKind(t) {
  if (/\b(run|cross country|track|soccer|basketball|swim|tennis|lift|workout|practice game)\b/.test(t)) return 'sport';
  if (/\b(piano|guitar|violin|sing|choir|band|orchestra|draw|paint|dance)\b/.test(t)) return 'practice';
  if (/\b(volunteer|service|food bank|tutor)\b/.test(t)) return 'service';
  if (/\b(club|team|robotics|debate|mun|newspaper)\b/.test(t)) return 'club';
  if (/\b(job|shift|work)\b/.test(t)) return 'work';
  if (/\b(essay|application|portfolio|project|build)\b/.test(t)) return 'project';
  if (/\b(read|study|sat|act|review)\b/.test(t)) return 'study';
  if (/\b(sleep|meditate|journal|walk|rest)\b/.test(t)) return 'wellness';
  return 'custom';
}

const label = (hhmm) => {
  if (hhmm === '23:59' || hhmm === '00:00') return 'midnight';
  const [h, m] = hhmm.split(':').map(Number);
  const ap = h >= 12 ? 'pm' : 'am';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return m ? `${hr}:${pad(m)}${ap}` : `${hr}${ap}`;
};

const whenLabel = (d, now) => (d ? fmtDay(d).toLowerCase() : '');

/**
 * An availability change. Without a named day it means tonight only, stored
 * against the date — Cadence shouldn't quietly move every Tuesday because of
 * one late night.
 */
function windowOp(state, when, { start, end }, now) {
  const scope = when.repeats ? 'weekly' : 'date';
  const win = {
    scope,
    days: when.repeats ? when.days : null,
    dates: when.repeats ? [] : (when.dates.length ? when.dates : [new Date(now)]).map((d) => dateKey(d)),
    start: start || null,
    end: end || null,
    matched: when.matched
  };
  return { kind: 'window', window: win, summary: windowSummary(win, now) };
}

export function windowSummary(win, now = new Date()) {
  const { scope, start, end, dates, matched } = win;
  const which = scope === 'weekly'
    ? `every ${matched}`
    : (dates[0] === dateKey(now) ? 'tonight' : fmtDay(new Date(`${dates[0]}T12:00`)).toLowerCase());
  const what = start && end ? `${label(start)}–${label(end)}` : start ? `from ${label(start)}` : `until ${label(end)}`;
  return `Free ${what} ${which}`;
}

// ------------------------------------------------------------- interpret

/**
 * Read a message into ops. Offline and deterministic — ai.js can replace this
 * when a key is configured, but the shape it returns is the same.
 */
export function interpret(text, state, now = new Date()) {
  const ops = [];
  for (const c of clauses(text)) {
    const op = readClause(c, state, now);
    if (op) {
      // "…and I'm free after 3 that day" means the day the last op was about.
      if (/\bthat (?:day|night|evening|afternoon)\b/i.test(c) && op.kind === 'window' && op.window.scope === 'date') {
        const prev = ops.at(-1);
        const borrowed = prev?.event?.dates?.length ? prev.event.dates : (prev?.window?.dates || []);
        if (borrowed.length) { op.window.dates = borrowed; op.summary = windowSummary(op.window, now); }
      }
      ops.push({ ...op, id: uid('op'), said: c });
      continue;
    }
    // "…, should take about two hours" is an estimate for what came before it.
    const mins = readDuration(c);
    const last = ops.at(-1);
    if (mins && last?.kind === 'task' && !last.task.minutes) {
      last.task.minutes = mins;
      last.summary += ` · ${mins >= 60 ? `${Math.round(mins / 6) / 10}h` : `${mins}m`}`;
    }
  }
  return ops;
}

/**
 * Normalize what ai.js returns into the ops applyOps() understands, so the
 * Claude path and the offline path stay interchangeable.
 */
export function opsFromSpec(items = [], now = new Date()) {
  const ops = [];
  for (const i of items) {
    const title = String(i.title || '').trim() || 'Busy';
    const dates = i.date ? [i.date] : [];
    const days = (i.weekdays || []).filter((d) => d >= 0 && d <= 6);

    if (i.type === 'window' && (i.start || i.end)) {
      const win = {
        scope: days.length ? 'weekly' : 'date',
        days: days.length ? days : null,
        dates: days.length ? [] : (dates.length ? dates : [dateKey(now)]),
        start: i.start || null,
        end: i.end || null,
        matched: joinDays(days)
      };
      ops.push({ kind: 'window', window: win, summary: windowSummary(win, now) });
      continue;
    }
    if (i.type === 'task' && i.due) {
      const due = new Date(i.due);
      if (isNaN(due)) continue;
      ops.push({
        kind: 'task', task: { title, due: due.toISOString(), minutes: i.minutes || null },
        summary: `${title} — due ${fmtDay(due)}`
      });
      continue;
    }
    if (i.type === 'commitment') {
      const sessions = i.sessionsPerWeek || 3;
      const minutes = i.minutes || 30;
      ops.push({
        kind: 'commitment',
        commitment: { title, kind: guessKind(title.toLowerCase()), target: { sessions, minutes }, schedule: { mode: 'flexible' }, days },
        summary: `${title} — ${sessions}\u00d7 a week, ${minutes}m`
      });
      continue;
    }
    if (i.type === 'capacity' && i.minutes) {
      ops.push({ kind: 'capacity', minutes: i.minutes, summary: `Homework capped at ${i.minutes}m a day` });
      continue;
    }
    if (!i.start) continue;
    const end = i.end || fromMin(Math.min(toMin(i.start) + (i.minutes || defaultDuration(title.toLowerCase())), 23 * 60 + 59));
    const when = days.length ? `every ${joinDays(days)}` : (dates[0] ? fmtDay(new Date(`${dates[0]}T12:00`)).toLowerCase() : 'today');
    ops.push({
      kind: 'event',
      event: { title, start: i.start, end, days, dates: days.length ? [] : (dates.length ? dates : [dateKey(now)]) },
      summary: `${title} \u00b7 ${label(i.start)}\u2013${label(end)} ${when}`
    });
  }
  return ops.map((o) => ({ ...o, id: uid('op') }));
}

// ----------------------------------------------------------------- apply

const HORIZON_WEEKS = 8;

/** Perform ops against state. Mutates; the caller snapshots first for undo. */
export function applyOps(state, ops, now = new Date()) {
  const done = [];
  for (const op of ops) {
    try {
      if (op.kind === 'event') applyEvent(state, op, now);
      else if (op.kind === 'window') applyWindow(state, op);
      else if (op.kind === 'task') applyTask(state, op);
      else if (op.kind === 'commitment') state.commitments.push(newCommitment(op.commitment));
      else if (op.kind === 'capacity') state.settings.dailyCapacityMin = Math.max(20, Math.min(600, op.minutes));
      else continue;
      done.push(op);
    } catch { /* one bad op shouldn't lose the rest of the message */ }
  }
  return done;
}

function applyEvent(state, op, now) {
  const { title, start, end, days, dates } = op.event;
  const rule = uid('rule');
  const stamps = [];
  if (days?.length) {
    for (let i = 0; i < HORIZON_WEEKS * 7; i++) {
      const d = addDays(startOfDay(now), i);
      if (days.includes(d.getDay())) stamps.push(d);
    }
  } else {
    for (const k of dates) stamps.push(new Date(`${k}T12:00`));
  }
  for (const day of stamps) {
    const s = atTime(day, start);
    let e = atTime(day, end);
    if (e <= s) e = addDays(e, 1);
    if (e < now) continue;
    state.busy.push({
      id: uid('agent'), title, start: s.toISOString(), end: e.toISOString(),
      source: 'agent', rule, allDay: false
    });
  }
}

function applyWindow(state, op) {
  const { scope, days, dates, start, end } = op.window;
  const keys = scope === 'weekly' ? days.map(String) : dates;
  for (const key of keys) {
    const dow = scope === 'weekly' ? Number(key) : new Date(`${key}T12:00`).getDay();
    const current = state.availability[key] || state.availability[dow] || [];
    const next = (current.length ? current : [{ start: start || '15:45', end: end || '21:30' }]).map((w) => ({ ...w }));
    if (start) next[0].start = start;
    if (end) next[next.length - 1].end = end;
    // A window that ends before it starts would block the day entirely.
    state.availability[key] = next.filter((w) => toMin(w.end) > toMin(w.start));
  }
}

function applyTask(state, op) {
  const id = uid('you');
  const t = {
    id, source: 'manual', title: op.task.title, due: op.task.due, status: 'todo',
    courseName: '', description: '', points: null, url: null,
    userEstimateMin: op.task.minutes || null, createdAt: new Date().toISOString()
  };
  t.category = classify(t);
  state.tasks[id] = t;
}

// ------------------------------------------------------------- reporting

/** What the agent says back, given what it actually did. */
export function reply(ops, text) {
  if (!ops.length) {
    return {
      text: "I didn't catch anything to schedule in that. Try a time or a day — \"dinner at 6\", \"practice Tue and Thu 4–6\", \"I can stay up till midnight\".",
      ok: false
    };
  }
  const kinds = new Set(ops.map((o) => o.kind));
  const lead = kinds.has('window') && kinds.size === 1 ? 'Updated when you’re free' : 'Done';
  return { text: `${lead} — ${ops.length === 1 ? ops[0].summary : `${ops.length} changes`}. Your plan has been rebuilt around it.`, ok: true };
}

/** Events this agent created, newest first — for the "what did you add" list. */
export function agentEvents(state) {
  return (state.busy || []).filter((b) => b.source === 'agent').sort((a, b) => new Date(a.start) - new Date(b.start));
}
