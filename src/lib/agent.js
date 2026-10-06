// Reading what a student types.
//
// "I just got home, I'm really tired, I want to eat and then do an hour and a
// half of work and go to sleep" has to become: something to eat now, ninety
// minutes of work after it, done for the night once that is finished, and the
// rest of the week rebuilt around a short evening. This file turns sentences
// like that into the operations in lib/agentops.js, entirely offline.
//
// With an Anthropic key or a signed-in account, lib/agentllm.js asks Claude
// instead and gets the same operations back; this is what runs for everyone
// else, and what runs when that call fails.
//
// It never guesses at a number. "I'm tired" with no amount gets one question
// back, with the answers as buttons.

import { addDays, startOfDay, atTime, dateKey, uid, MIN } from './util.js';
import {
  describe, findItems, simulate, answer, clock as sayClock, clockOf, joinDays, dayWord
} from './agentops.js';
import { workWindows, isSchoolDay } from './daymodel.js';
import { allBusy } from './replanner.js';

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
 * Turn a clock fragment into "HH:MM", or null when it is not a real time.
 * `hint` decides what a bare number means when nobody said am or pm:
 *   'day'     1 to 7 is the afternoon, 8 to 11 the morning ("dentist at 10")
 *   'eve'     the evening ("dinner at 8"); 'eve?' is the same, as a guess
 *   'ahead'   whichever comes next today, given the time it is now
 *   'late'    staying up: "till 11" is tonight, "till 1" is past midnight
 *   'cutoff'  finishing: the next time the clock reads that
 *   'morning' as written
 */
function toClock(h, min, ampm, hint = 'day', nowMin = null) {
  let hour = Number(h);
  const m = Number(min || 0);
  if (!Number.isInteger(hour) || hour > 23 || m > 59) return null;
  const ap = (ampm || '').replace(/[.\s]/g, '').toLowerCase();
  if (ap.startsWith('p')) hour = hour >= 12 ? hour : hour + 12;
  else if (ap.startsWith('a')) hour = hour === 12 ? 0 : hour;
  else if (hour === 0 || hour >= 13) { /* already a 24-hour time */ }
  else if (hint === 'late') {
    if (hour === 12) return m ? `00:${pad(m)}` : '23:59';
    if (hour >= 5) hour += 12;                                   // 1 to 4 are past midnight
  } else if (hint === 'cutoff') {
    const am = (hour % 12) * 60 + m, pm = am + 720;
    if (nowMin == null) return hour === 12 ? (m ? `00:${pad(m)}` : '23:59') : fromMin(pm);
    if (am > nowMin) return fromMin(am);
    if (pm > nowMin) return fromMin(pm);
    return am === 0 ? '23:59' : fromMin(am);
  } else if (hint === 'eve' || hint === 'eve?') {
    if (hour <= 11) hour += 12;
  } else if (hint === 'ahead') {
    if (hour <= 7) hour += 12;
    else if (hour <= 11 && nowMin != null && hour * 60 + m <= nowMin) hour += 12;
  } else if (hint === 'day' && hour <= 7) hour += 12;             // "at 6" after school is 6pm
  return `${pad(hour)}:${pad(m)}`;
}

// A number is a clock time when it says so (am, pm, minutes, o'clock) or when
// the word in front of it does ("at 6", "by 9"). A bare number is not one:
// "oct 12", "3 assignments", "chapter 7" and "1.5 hours" are not times.
const TIME_G = /(?:\b(at|by|around|about|until|till|til|after|before|from|past)\s+|(@)\s*)?(\d{1,2})(?::(\d{2}))?(?!\d)\s*(a\.?m\.?|p\.?m\.?|o'?clock)?(?![a-z])/gi;
const NOT_A_TIME = /^\s*(?:\.\d|\/\d|-?\s*(?:hours?|hrs?|h|minutes?|mins?|m|times?|x|days?|nights?|weeks?|months?|pages?|problems?|questions?|chapters?|paragraphs?|assignments?|things?|more|st|nd|rd|th)\b|%)/i;
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const MONTH_BEFORE = new RegExp(`\\b${MONTH}\\.?\\s*$`, 'i');

/** The first clock time written in a piece of text. */
function readTime(text, hint = 'day', nowMin = null) {
  const t = String(text);
  if (/\bmidnight\b/i.test(t)) return '23:59';
  if (/\bnoon\b/i.test(t)) return '12:00';
  TIME_G.lastIndex = 0;
  let m;
  while ((m = TIME_G.exec(t))) {
    const [whole, prep, at, h, min, ap] = m;
    const before = t.slice(0, m.index), after = t.slice(m.index + whole.length);
    if (/[\d/.:]$/.test(before)) continue;                        // the tail of a longer number or a date
    if (!ap && NOT_A_TIME.test(after)) continue;
    if (!prep && !at && MONTH_BEFORE.test(before)) continue;
    if (!(ap || min || prep || at)) continue;
    const clock = toClock(h, min, /^o/i.test(ap || '') ? '' : ap, hint, nowMin);
    if (clock) return clock;
  }
  return null;
}

/** A fragment already known to be a time ("9", "9:30pm", "midnight"). */
function parseTime(fragment, hint = 'day', nowMin = null) {
  const t = String(fragment || '');
  if (/\bmidnight\b/i.test(t)) return '23:59';
  if (/\bnoon\b/i.test(t)) return '12:00';
  const m = t.match(/(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i);
  return m ? toClock(m[1], m[2], m[3], hint, nowMin) : null;
}

const RANGE_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:-|–|—|to|until|til|till|through|thru)\s*(\d{1,2})(?::(\d{2}))?(?!\d)\s*(a\.?m\.?|p\.?m\.?)?(?![a-z])/i;

/** "4-6", "from 4 to 5:30", "6pm until 8" -> {start, end} */
function readRange(text, hint = 'day', nowMin = null) {
  const t = String(text);
  const m = t.match(RANGE_RE);
  if (!m) return null;
  const before = t.slice(0, m.index), after = t.slice(m.index + m[0].length);
  // "3-4 hours", "pages 4-6 of 12", "oct 4-6" and "10/4-6" are not clock times.
  if ((!m[6] && NOT_A_TIME.test(after)) || /[\d/.:-]$/.test(before) || MONTH_BEFORE.test(before)) return null;
  const bare = !m[3] && !m[6];
  const endAp = m[6] || m[3];
  // "4-6pm" is 4pm; "11-1pm" and "9-12pm" start in the morning.
  const startAp = m[3] || (endAp && Number(m[1]) <= Number(m[4]) && Number(m[4]) !== 12 ? endAp : null);
  let start = toClock(m[1], m[2], startAp, hint, nowMin);
  if (!start) return null;
  // With no am or pm on the end, it is the next time the clock reads that.
  const endAfter = (from) => {
    if (m[6] || Number(m[4]) === 0 || Number(m[4]) > 12) return toClock(m[4], m[5], m[6]);
    if (Number(m[5] || 0) > 59) return null;
    const am = (Number(m[4]) % 12) * 60 + Number(m[5] || 0), pm = am + 720;
    return fromMin(am > toMin(from) ? am : pm > toMin(from) ? pm : am);
  };
  let end = endAfter(start);
  // A guessed evening that would run past midnight was a morning: "10 to 2".
  const h1 = Number(m[1]);
  if (bare && end && (hint === 'eve?' || hint === 'ahead') && h1 >= 8 && h1 <= 11 && toMin(start) >= 720 && toMin(end) <= toMin(start)) {
    start = toClock(m[1], m[2], 'am');
    end = endAfter(start);
  }
  return end ? { start, end } : null;
}

// Which side of noon a bare "at 9" is on, from what else the sentence says and
// what kind of day it is. On a school day the morning is spoken for.
const MORNING_CTX = /\b(morning|breakfast|brunch|before school|appointment|dentist|doctor|orthodontist|haircut|church)\b/;
const EVENING_CTX = /\b(tonight|night|evening|dinner|supper|party|movie|concert|show|sleepover|hang(?:ing)? ?out|go(?:ing)? out|after (?:school|practice|work|dinner|rehearsal|the game)|home|bed)\b/;
function hintFor(t, when, state, now) {
  if (MORNING_CTX.test(t)) return 'day';
  if (EVENING_CTX.test(t)) return 'eve';
  const school = state?.school?.days || [];
  if (when.repeats) return when.days.length && when.days.every((d) => school.includes(d)) ? 'eve?' : 'day';
  const d = when.dates[0] || now;
  if (state && isSchoolDay(state, d)) return 'eve?';
  return dateKey(d) === dateKey(now) ? 'ahead' : 'day';
}
const minuteOf = (now) => now.getHours() * 60 + now.getMinutes();
const TIME_SRC = '(\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)?|midnight|noon)';
const FREE_FROM = new RegExp(`\\b(?:get|getting|got|be|i'?m|i am|i'll be|will be)\\s+(?:out of|done with|finished with|back from|home from)\\s+[\\w' ]{1,30}?\\s+(?:at|by|around)\\s+${TIME_SRC}`);

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

// "SAT prep", "the SAT" and "I sat down" are not Saturday. Letters are added
// to the word so the day patterns pass over it; showSat() takes them out again.
const SAT_MARK = 'qzq';
const hideSat = (text) => String(text)
  .replace(/\bsat(?=\s+(?:prep|test|exam|scores?|class|tutor(?:ing)?|subject|math|reading|writing|essay|book|vocab|study|review|registration|down|there|here|through|with|next to)\b)/gi, (m) => m + SAT_MARK)
  .replace(/\b(?:the|my|take|taking|took|retake|i|we|just)\s+sat\b/gi, (m) => m + SAT_MARK);
const showSat = (text) => String(text).replace(/qzq/gi, '');

/**
 * Which days a clause is about.
 * @returns {{dates: Date[], days: number[], repeats: boolean, matched: string}}
 *   dates — specific calendar days;  days — weekday numbers, when it recurs
 */
function readDays(text, now = new Date()) {
  const t = hideSat(text).toLowerCase();
  const out = { dates: [], days: [], repeats: false, listed: false, matched: '' };
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
    // Several days named with no "every": true of each of them, and for an
    // exception ("no school Monday and Tuesday") it means the next of each.
    if (plural || every || found.length > 1) { out.days = found; out.repeats = true; out.listed = !plural && !every; return out; }
    let day = nextWeekday(now, found[0]);
    // "next Thursday" means the one after this week's, when this week has one.
    if (/\bnext\b/.test(t) && day < addDays(startOfDay(now), 7 - now.getDay())) day = addDays(day, 7);
    out.dates = [day];
    return out;
  }

  if (/\btonight\b|\btoday\b|\bthis (?:afternoon|evening)\b/.test(t)) { out.dates = [new Date(now)]; mark('today'); return out; }
  if (/\btomorrow\b|\btmrw?\b/.test(t)) { out.dates = [addDays(now, 1)]; mark('tomorrow'); return out; }

  // Whole month names only: "novel 3" and "decided 2" are not dates, and
  // neither is "I may 3...".
  const md = t.replace(/\b(i|we|you|it|that|they|he|she)\s+may\b/g, '$1 might').match(new RegExp(`\\b(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`));
  if (md) {
    const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(md[1].slice(0, 3));
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
  // A full stop ends a clause, except inside "1.5 hours" and "6 p.m.".
  const rough = String(text)
    .replace(/(\d)\.(\d)/g, '$1\u0001$2')
    .replace(/\b([ap])\.\s?m\.?(?=\s|$|[,;!?])/gi, '$1m')
    .split(/[\n.;!?]+|,\s*(?=(?:and\s+)?(?:i|i'?m|also|then|plus|but|it|that|which|should|like|so)\b)|\s+and\s+(?=(?:i|i'?m|also|then|my|we|just)\b)|\s+also\s+|\s+then\s+|\s+after that\s+/i)
    .map((s) => s.replace(/\u0001/g, '.').trim().replace(/^(?:(?:and|then|so|like|but|plus|ok|okay|um+|uh+|actually|well|wait|hm+|honestly|oh|hey|yeah|sorry)\b[\s,]*)+/i, '').trim())
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
    if (!WHEN_RE.test(hideSat(left)) || !WHEN_RE.test(hideSat(right)) || CONTINUES.test(right)) continue;
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
  let s = ' ' + hideSat(clause) + ' ';
  s = s.replace(/\b(from|at|on|starting|start|between)?\s*\d{1,2}(?::\d{2})?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:-|–|—|to|until|til|till)\s*\d{1,2}(?::\d{2})?\s*(a\.?m\.?|p\.?m\.?)?/gi, ' ');
  s = s.replace(/\b(?:at|by|around|about|from|after|before|until|til|till)\s+\d{1,2}(?::\d{2})?\s*(a\.?m\.?|p\.?m\.?)?/gi, ' ');
  s = s.replace(/\bfor\s+(?:about\s+)?[\w\s]{1,12}?(hours?|hrs?|minutes?|mins?)\b/gi, ' ');
  s = s.replace(/,?\s*(?:it|that|this)?\s*(?:should|will|might|takes?|'ll)\s+take[\w\s]{0,20}?(hours?|hrs?|minutes?|mins?)\b/gi, ' ');
  s = s.replace(/\b(every|each)\s+(day|night|morning|afternoon|evening|week)\b/gi, ' ');
  s = s.replace(/\b(every|each|next|this|coming|upcoming|daily)\b/gi, ' ');
  s = s.replace(new RegExp(`\\b(${DOW.join('|')}|${DOW_ABBR.join('|')})s?\\b`, 'gi'), ' ');
  s = s.replace(/\b(today|tonight|tomorrow|tmrw|this (?:afternoon|evening|morning)|weekdays|weekends?|school nights?|midnight|noon)\b/gi, ' ');
  s = s.replace(new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, 'gi'), ' ');
  for (const re of STRIP) s = s.replace(re, ' ');
  for (const re of STRIP) s = s.trim().replace(re, '');
  s = s.replace(/\b(nights?|evenings?|mornings?|afternoons?|after school)\b/gi, ' ');
  s = s.replace(/\s+/g, ' ').replace(/\s+([,;])/g, '$1').replace(/^[\s,–-]+|[\s,–-]+$/g, '');
  // Removing the day and time leaves joiners behind: "practice and", "with".
  const JOIN = /^(?:and|or|with|for|on|at|in|to|from|the|a|an|of|is|was|i|we|have|has|had|got|gotta|need)\b\s*/i;
  const TAIL = /\s*\b(?:and|or|with|for|on|at|in|to|from|the|a|an|of)$/i;
  for (let i = 0; i < 4 && JOIN.test(s); i++) s = s.replace(JOIN, '');
  for (let i = 0; i < 4 && TAIL.test(s); i++) s = s.replace(TAIL, '');
  s = showSat(s).trim();
  if (!s || s.length < 2) return matchedDay ? `Busy ${matchedDay}` : 'Busy';
  return titleCase(s.slice(0, 60));
}


// ------------------------------------------------------------------ spans

/** A length of time anywhere in the text: "an hour and a half", "90 min", "1.5 hrs". */
export function readSpan(text) {
  const t = String(text).toLowerCase();
  let m;
  if (/\b(?:an?|one|1)\s+hour\s+and\s+a\s+half\b/.test(t) || /\bhour\s+and\s+a\s+half\b/.test(t)) return 90;
  if ((m = t.match(/\b(two|three|four|five|2|3|4|5)\s+(?:and\s+a\s+half\s+hours|hours?\s+and\s+a\s+half)\b/))) return num(m[1]) * 60 + 30;
  if (/\bhalf\s+(?:an?\s+)?hour\b/.test(t)) return 30;
  if (/\ba\s+couple\s+(?:of\s+)?hours\b/.test(t)) return 120;
  if (/\ba\s+few\s+hours\b/.test(t)) return 180;
  if ((m = t.match(/\b(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?)\b(?:\s*(?:and\s*)?(\d{1,2})\s*(?:m|min|mins|minutes)?\b)?/))) return Math.round(Number(m[1]) * 60 + Number(m[2] || 0));
  if ((m = t.match(/\b(an?|one|two|three|four|five|six)\s+(?:more\s+)?hours?\b/))) return (num(m[1]) ?? 1) * 60;
  if ((m = t.match(/\b(\d{1,3})\s*(?:m|min|mins|minutes?)\b/))) return Number(m[1]);
  if ((m = t.match(/\b(ten|fifteen|twenty|thirty|forty[- ]five|forty|sixty|ninety)\s+(?:more\s+)?minutes?\b/))) return { ten: 10, fifteen: 15, twenty: 20, thirty: 30, 'forty-five': 45, 'forty five': 45, forty: 40, sixty: 60, ninety: 90 }[m[1]];
  return null;
}

const roundUp5 = (date) => new Date(Math.ceil(+date / (5 * MIN)) * 5 * MIN);
const hhmm = (date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

// ------------------------------------------------------------ vocabulary

const TIRED = /\b(tired|exhausted|wiped|drained|dead|beat|burn(?:t|ed)\s?out|fried|sick|not feeling (?:well|good|great)|headache|stressed|overwhelmed|worn out|no energy|can'?t focus|sleepy)\b/i;
const WORK_WORD = /\b(work|homework|hw|study|studying|school ?work|assignments?|stuff)\b/i;
const ACTIVITY_WORD = /\b(practice|rehearsal|training|lessons?|club|team|robotics|debate|mun|model un|band|orchestra|choir|theat(?:er|re)|drama|soccer|football|basketball|baseball|softball|volleyball|tennis|swim(?:ming)?|track|cross[- ]country|xc|lacrosse|hockey|wrestling|golf|dance|gymnastics|cheer|karate|taekwondo|piano|violin|guitar|cello|drums|job|shift|volunteer(?:ing)?|tutoring|youth group|scouts|newspaper|yearbook|student council|mock trial|science olympiad|math team|chess)\b/i;
const SCHOOLWORK = /\b(due|test|quiz|exam|midterm|final|essay|paper|assignment|homework|hw|project|problem set|pset|lab report|reading|worksheet|presentation|study guide)\b/i;
const SELF_CARE = [
  [/\b(eat|food|dinner|supper|snack|lunch)\b/, 'Eat', 30],
  [/\bshower\b/, 'Shower', 20],
  [/\b(nap|lie down|rest for a bit)\b/, 'Nap', 30],
  [/\b(break|chill|decompress|relax|unwind)\b/, 'Break', 20],
  [/\b(walk|walk the dog)\b/, 'Walk', 20]
];

function activityType(t) {
  if (/\b(soccer|football|basketball|baseball|softball|volleyball|tennis|swim|track|cross[- ]country|xc|lacrosse|hockey|wrestling|golf|gymnastics|cheer|karate|taekwondo|run|lift|workout|training)\b/.test(t)) return 'sport';
  if (/\b(piano|guitar|violin|cello|drums|sing|choir|band|orchestra|draw|paint|dance|theat(?:er|re)|drama|rehearsal|lesson)\b/.test(t)) return 'practice';
  if (/\b(volunteer|service|food bank|tutor)\b/.test(t)) return 'service';
  if (/\b(club|team|robotics|debate|mun|newspaper|yearbook|council|mock trial|olympiad|chess)\b/.test(t)) return 'club';
  if (/\b(job|shift|work)\b/.test(t)) return 'work';
  if (/\b(essay|application|portfolio|project|build)\b/.test(t)) return 'project';
  if (/\b(read|study|sat|act|review)\b/.test(t)) return 'study';
  return 'custom';
}

/** Strip the verbs around a name so "the lab report" is what's left to look up. */
function nameIn(text, drop) {
  let s = ` ${hideSat(text)} `;
  for (const re of drop) s = s.replace(re, ' ');
  s = s.replace(/\b(today|tonight|tomorrow|tmrw|this (?:afternoon|evening|morning|weekend)|the weekend|next week|instead|please|first|now|already|finally|just|all of|my|the|to|on|for|until|till)\b/gi, ' ');
  s = s.replace(new RegExp(`\\b(${DOW.join('|')}|${DOW_ABBR.join('|')})s?\\b`, 'gi'), ' ');
  s = s.replace(/\b(?:at|by)\s+\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?/gi, ' ');
  return showSat(s).replace(/\s+/g, ' ').trim();
}

// ------------------------------------------------------------ one clause

/**
 * Read one clause.
 * @returns {{op?:object, query?:object, signal?:string, ask?:object}|null}
 */
function readClause(clause, state, now) {
  const t = clause.toLowerCase().replace(/[’]/g, "'");
  const when = readDays(clause, now);
  const today = dateKey(now);
  const nowMin = minuteOf(now);
  // The dates a one-day change applies to. "Monday and Tuesday", or
  // "Tuesdays", with nothing that repeats to attach to, mean the next of each.
  const dates = when.dates.length ? when.dates.map((d) => dateKey(d))
    : (when.days.length && when.days.length < 5) ? when.days.map((d) => dateKey(nextWeekday(now, d))).sort()
    : [today];
  const hint = hintFor(t, when, state, now);

  // ---- questions: nothing changes, something gets answered
  const asks = /\?\s*$/.test(clause) || /^(what|when|how|am i|can i|could i|do i|is there|where|which|will i|should i)\b/.test(t);
  if (asks || /\bwhat'?s (?:next|left|due)\b/.test(t)) {
    if (/\b(what (?:should|do|can) i (?:do|work on|start)|what'?s next|what now|where (?:do|should) i start|what first)\b/.test(t)) return { query: { kind: 'now' } };
    if (/\b(how(?:'?s| is| does)? my week|what'?s due|due this week|this week look|what do i have this week|how much (?:work )?do i have this week)\b/.test(t)) return { query: { kind: 'week' } };
    if (/\b(am i free|when am i free|free time|do i have (?:any )?time|anything (?:going )?on|what am i doing)\b/.test(t)) {
      const part = (t.match(/\b(morning|afternoon|evening|night)\b/) || [])[1];
      return { query: { kind: 'free', date: dates[0], part: part || null } };
    }
    if (/\b(what'?s left|what do i have (?:left|today|tonight)|how much (?:is left|do i have left|more)|my (?:plan|schedule) for (?:today|tonight)|what'?s (?:the )?plan)\b/.test(t)) return { query: { kind: 'today' } };
    if (/\b(my activities|how am i doing|streak)\b/.test(t)) return { query: { kind: 'activities' } };
    const whenIs = t.match(/\bwhen(?:'?s| is| are| will| do| should)?\b(.+)/);
    if (whenIs) {
      const name = nameIn(whenIs[1], [/\b(i|we|do|doing|work(?:ing)? on|start(?:ing)?|finish(?:ing)?|is|are|be|due|gonna|going to|will|should)\b/gi, /\?/g]);
      const hit = findItems(state, name, { types: ['task'], now })[0];
      if (hit) return { query: { kind: 'when', taskId: hit.id } };
    }
    // "Can I go out Friday night?" is a what-if: try it, report, offer to add it.
    if (/\b(can i|could i|do i have time (?:to|for)|is there time (?:to|for)|would it work)\b/.test(t)) {
      const ev = eventFrom(clause.replace(/\b(can i|could i|do i have time (?:to|for)|is there time (?:to|for)|would it work(?: if i)?)\b/gi, ' ').replace(/\?/g, ''), t, when, now, { assume: true, hint });
      if (ev) return { query: { kind: 'fit', op: ev } };
    }
    if (asks && !readTime(clause) && !readSpan(clause)) return { query: { kind: 'today' } };
  }

  // ---- done for the night
  if (/\b(done|finished|through) for (?:today|tonight|the (?:day|night))\b/.test(t)
    || /\bno (?:more )?(?:work|homework|hw) (?:today|tonight)\b/.test(t)
    || /\b(?:skip|taking|take|need|want|give me|can i have|could i have) (?:tonight|today|tomorrow|a night|the night|a day|the day|the evening) off\b/.test(t)
    || /\b(?:can'?t|cannot|not going to|won'?t|don'?t want to) (?:do|work on|get to) (?:anything|any (?:work|homework|hw)) (?:else )?(?:today|tonight)\b/.test(t)
    || /\bnot doing (?:any(?:thing| ?(?:work|homework|hw))) (?:tonight|today)\b/.test(t)
    || /\b(?:push|move) everything (?:to|until|till) tomorrow\b/.test(t)
    || /\bclear (?:my |the )?(?:night|evening|tonight|today)\b/.test(t)) {
    return { op: { kind: 'day', dates, off: true } };
  }

  // ---- finished something
  const fin = t.match(/\b(?:i(?:'ve| have)?\s+)?(?:just\s+)?(?:finished|completed|turned in|submitted|handed in|am done with|i'?m done with|done with|did)\s+(.+)/);
  // "I'm not done with the essay" and "I did not do the lab" say the opposite.
  const notDone = /\b(?:not|never|almost|nearly|barely|half|halfway|kind of|kinda|sort of|still|yet|need to|have to|haven'?t|hasn'?t|didn'?t|couldn'?t|can'?t|cannot|won'?t|wasn'?t|isn'?t)\b|n't\b/.test(t);
  if (fin && !notDone && !/\b(for (?:today|tonight)|practice|rehearsal)\b/.test(fin[1])) {
    const hit = findItems(state, nameIn(fin[1], []), { types: ['task'], now })[0];
    if (hit) return { op: { kind: 'done', taskId: hit.id, title: hit.title } };
  }

  // ---- school
  if (/\b(no school|school(?:'s| is) (?:closed|cancell?ed|out)|day off (?:from )?school|don'?t have school|snow day|holiday|teacher (?:work|in-?service) day|no classes)\b/.test(t)
    || (/\bday off\b/.test(t) && !WORK_WORD.test(t))) {
    // "No school on Fridays" changes the week itself; anything else is dates.
    if (when.repeats && !when.listed && when.days.length < 5) {
      const days = (state.school?.days || []).filter((d) => !when.days.includes(d));
      if (days.length && days.length < (state.school?.days || []).length) return { op: { kind: 'school', days } };
    }
    return { op: { kind: 'school', offDates: dates } };
  }
  // "We get out at 12" is school. "Going out at 7" and "I get out of practice at 5" are not.
  const early = t.match(/\b(?:half day|early release|early dismissal|minimum day|out of school (?:early )?at|(?:get|gets|getting|got|let|lets|letting) out (?:of school )?(?:early )?at|out early at|school (?:ends|lets out|gets out) (?:early )?at)\b/);
  if (early) {
    const time = readTime(clause.slice(t.indexOf(early[0])), 'day') || (/\b(half day|early|minimum day)\b/.test(early[0]) ? '12:00' : null);
    const lasting = /\b(usually|always|every day|normally|from now on)\b/.test(t) || (/\bschool (?:ends|lets out|gets out) at\b/.test(t) && !when.dates.length && !/\b(early|today|tomorrow)\b/.test(t));
    if (time && lasting) return { op: { kind: 'school', end: time } };
    // Getting out "early" only makes sense before the usual bell.
    if (time && toMin(time) < toMin(state.school?.end || '15:30') && toMin(time) > toMin(state.school?.start || '08:30')) {
      return { op: { kind: 'school', early: [{ date: dates[0], time }] } };
    }
  }
  // "I get out of practice at 5", "I'm back from the game at 9": that is when
  // the evening starts, not something to put on the calendar.
  const freeFrom = t.match(FREE_FROM);
  if (freeFrom && !/\bdue\b/.test(t)) {
    const time = parseTime(freeFrom[1], hint, nowMin);
    if (time) return { op: { kind: 'day', dates, startAt: time } };
  }
  const starts = t.match(/\bschool starts? at\s+(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)/);
  if (starts) return { op: { kind: 'school', start: parseTime(starts[1].includes('m') ? starts[1] : `${starts[1]}am`, 'morning') } };

  // ---- habitual sleep
  const habit = /\b(usually|normally|always|every night|most nights|bedtime is|on school nights|generally)\b/.test(t);
  const bedAt = t.match(/\b(?:go to bed|bedtime(?: is)?|in bed|asleep|go to sleep|sleep)\s*(?:is\s+)?(?:at|by|around|before)\s+(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|midnight)/);
  const wakeAt = t.match(/\b(?:wake up|get up|i'?m up|up)\s*(?:at|by|around)\s+(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)/);
  if (habit && (bedAt || wakeAt)) {
    return { op: { kind: 'sleep', ...(bedAt ? { bed: parseTime(bedAt[1], 'late') } : {}), ...(wakeAt ? { wake: parseTime(/m/.test(wakeAt[1]) ? wakeAt[1] : `${wakeAt[1]}am`, 'morning') } : {}) } };
  }

  // ---- tonight's shape: a cut-off, a start, an amount
  // Staying up is always the night ("till 1" is 1am). Stopping is the next
  // time the clock reads that ("done by 3" on a Saturday morning is 3pm).
  const TIME = TIME_SRC;
  const stayUp = t.match(new RegExp(`\\b(?:stay(?:ing)? up|be up|up|awake)\\s*(?:un)?til+\\s+${TIME}`))
    || (bedAt && !SCHOOLWORK.test(t) ? bedAt : null);
  const stopBy = t.match(new RegExp(`\\b(?:work|study|go|keep going)\\s*(?:un)?til+\\s+${TIME}`))
    || t.match(new RegExp(`\\b(?:done|finished|stop(?:ping)?|wrap up|call it)\\s*(?:by|at|around)\\s+${TIME}`));
  if ((stayUp || stopBy) && !/\bdue\b/.test(t)) {
    const time = stayUp ? parseTime(stayUp[1], 'late') : parseTime(stopBy[1], 'cutoff', dates[0] === today ? nowMin : null);
    if (time) return { op: { kind: 'day', dates, until: time } };
  }
  // "...then go to sleep" ends the night when the work does. It often shares a
  // clause with the amount ("an hour and a half of work and go to sleep"), so
  // note it and keep reading rather than stopping here.
  const sleepAfter = /\b(?:go(?:ing)? to (?:sleep|bed)|sleep|crash|pass out|call it a night|knock out)\b/.test(t) && !readTime(clause) && !SCHOOLWORK.test(t);
  if (sleepAfter && !readSpan(clause)) return { signal: 'sleep-after' };
  const after = t.match(/\b(?:free|available|home|back|done|start(?:ing)?|can (?:work|study|start))\s*(?:from|after|at|starting|by|around)\s+(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|noon)/)
    || t.match(/\b(?:can'?t|won'?t be able to) (?:start|work|do anything) (?:un)?til+\s+(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|noon)/);
  if (after && !/\bdue\b/.test(t) && !ACTIVITY_WORD.test(t.replace(/\bwork\b/g, ''))) {
    const time = parseTime(after[1], hint, nowMin);
    if (time) return { op: { kind: 'day', dates, startAt: time } };
  }

  const span = readSpan(clause);
  const budgetish = span && (
    (WORK_WORD.test(t) && !/\b(takes?|will take|should take|is going to take|gonna take)\b/.test(t) && !SCHOOLWORK.test(t.replace(WORK_WORD, '')))
    || /\b(only|just|at most|max|tops|no more than)\b[^.]*\b(tonight|today)\b/.test(t)
    || /\b(tonight|today)\b[^.]*\b(only|just|at most|max|tops)\b/.test(t)
    || /^(?:i (?:can|could|have|got|want to|wanna|will|'ll)\s+)?(?:only\s+|just\s+|maybe\s+|like\s+|about\s+)?(?:do\s+|have\s+|manage\s+)?(?:an?\s+|\d|one\b|two\b|half\b)[\w\s.]*(?:hours?|hrs?|minutes?|mins?)(?:\s+(?:tonight|today|tomorrow|max|tops|more))?$/.test(t)
  );
  // "I can do 2 hours tonight", "maybe an hour today": an amount and a day, with
  // nothing saying it is how long some event lasts or some assignment takes.
  const amountForDay = !!span
    && /\b(tonight|today|tomorrow|this (?:afternoon|evening))\b/.test(t)
    && /\b(?:i|i'?ll|i'?ve|can|could|do|got|have|manage|only|just|maybe|about|like)\b/.test(t)
    && !/\bfor\s+(?:about\s+|like\s+)?(?:\d|an?\b|one\b|two\b|three\b|half\b)/.test(t)
    && !/\b(takes?|will take|should take|is going to take|gonna take)\b/.test(t)
    && !SCHOOLWORK.test(t.replace(WORK_WORD, ''));
  const nightly = /\b(a night|a day|per (?:day|night)|each (?:day|night)|every (?:day|night)|in general|on school nights)\b/.test(t);
  if (span && nightly && /\b(only|just|at most|max|tops|no more than|limit)\b/.test(t) && !ACTIVITY_WORD.test(t.replace(/\bwork\b/g, ''))) {
    return { op: { kind: 'limit', minutes: span } };
  }
  if ((budgetish || amountForDay) && !ACTIVITY_WORD.test(t.replace(/\bwork\b/g, ''))) {
    if (nightly || (when.repeats && when.days.length >= 5)) return { op: { kind: 'limit', minutes: span } };
    return { op: { kind: 'day', dates, budgetMin: span }, signal: sleepAfter ? 'sleep-after' : undefined };
  }

  // ---- looking after yourself first: "I want to eat", "gonna shower"
  if (!readTime(clause) && !readRange(clause) && !when.dates.length && !when.repeats) {
    const care = SELF_CARE.find(([re]) => re.test(t));
    if (care && /\b(i|gonna|going to|need to|want to|wanna|have to|gotta|let me|first)\b/.test(t) && !SCHOOLWORK.test(t)) {
      const minutes = readSpan(clause) || care[2];
      return { signal: 'care', care: { title: care[1], minutes } };
    }
  }

  if (TIRED.test(t) && !readTime(clause) && !span) return { signal: 'tired' };

  // ---- cancel, skip, remove
  const cancel = t.match(/\b(?:cancel|delete|remove|skip|skipping|drop|not doing|not going to|no)\s+(.+)/) || t.match(/(.+?)\s+(?:is|was|got|has been|'s)\s+cancell?ed\b/);
  if (cancel && !/^no (?:more )?(?:work|homework)/.test(t)) {
    const name = nameIn(cancel[1], [/\b(is|was|got|cancell?ed|it)\b/gi]);
    const hit = findItems(state, name, { now })[0];
    if (hit) {
      const dated = when.dates.length || /\b(today|tonight)\b/.test(t);
      // "Cancel" and "delete" mean for good. "Skipping it tonight" means not now.
      const forGood = /\b(cancel|delete|remove|drop)\b|\bcancell?ed\b/.test(t);
      if (hit.type === 'activity') return { op: { kind: 'remove', target: 'activity', id: hit.id, title: hit.title, date: dated || /\b(skip|skipping|cancell?ed|no)\b/.test(t) ? dates[0] : null } };
      if (hit.type === 'event') return { op: { kind: 'remove', target: 'event', id: hit.id, title: hit.title, date: dated ? dates[0] : null } };
      if (hit.type === 'task') {
        if (forGood && !dated) return { op: { kind: 'remove', target: 'task', id: hit.id, title: hit.title } };
        // Homework does not go away by skipping it: it moves to the next day.
        return { op: { kind: 'move', taskId: hit.id, title: hit.title, date: dateKey(addDays(new Date(`${dates[0]}T12:00:00`), 1)) } };
      }
    }
  }

  // ---- do it first, or on another day
  const firstly = t.match(/\b(?:start with|prioriti[sz]e|do)\s+(.+?)\s+first\b/) || t.match(/\b(?:start with|prioriti[sz]e|focus on)\s+(.+)/);
  if (firstly) {
    const hit = findItems(state, nameIn(firstly[1], []), { types: ['task'], now })[0];
    if (hit) return { op: { kind: 'first', taskId: hit.id, title: hit.title } };
  }
  const moving = t.match(/\b(?:move|push|shift|bump|reschedule|do|save)\s+(.+?)\s+(?:to|until|till|for|on)\s+(.+)/) || (when.dates.length ? t.match(/\b(?:do|work on|finish)\s+(.+)/) : null);
  if (moving && (when.dates.length || /\bweekend\b/.test(t))) {
    const hit = findItems(state, nameIn(moving[1], []), { types: ['task'], now })[0];
    const target = /\bweekend\b/.test(t) && !when.dates.length ? dateKey(nextWeekday(now, 6)) : dates[0];
    if (hit) return { op: { kind: 'move', taskId: hit.id, title: hit.title, date: target } };
  }

  // ---- how long something takes
  const takes = t.match(/(.+?)\s+(?:will|is going to|is gonna|should|might|'ll)?\s*takes?\b/) || t.match(/(.+?)\s+(?:is|will be)\s+(?:about|around|like)?\s*\d/);
  if (takes && span && !when.dates.length) {
    const hit = findItems(state, nameIn(takes[1], []), { types: ['task'], now })[0];
    if (hit) return { op: { kind: 'estimate', taskId: hit.id, title: hit.title, minutes: span } };
  }

  // ---- an activity with a weekly target: "piano 5 times a week for 30 minutes"
  const perWeek = t.match(/\b(\d+|once|twice|one|two|three|four|five|six|seven)\s*(?:x|times?)?\s*(?:a|per|each|every)\s*week\b/);
  if (perWeek) {
    const sessions = { once: 1, twice: 2 }[perWeek[1]] ?? num(perWeek[1]) ?? 3;
    const title = readTitle(clause.replace(perWeek[0], ' ').replace(/\b(i\s+)?(want|would like|wanna|need|try|trying|plan|planning)\s+to\b/gi, ' '), {});
    return { op: { kind: 'activity', title, type: activityType(t), mode: 'flexible', sessions, minutes: readDuration(clause) || span || 30, days: when.repeats ? when.days : [] } };
  }

  // ---- schoolwork with a date
  if (SCHOOLWORK.test(t) && !/\b(practice|rehearsal|dinner|lunch|appointment)\b/.test(t)) {
    const day = when.dates[0] || (when.days.length ? nextWeekday(now, when.days[0]) : null);
    if (day) {
      const time = readTime(clause.replace(/\b(?:take|takes|for)\s+[\w\s.]+?(?:hours?|minutes?|mins?|hrs?)\b/gi, ' '), 'day');
      const due = atTime(day, time || '23:59');
      const title = readTitle(clause.replace(/\bdue\b/gi, ' '), {});
      return { op: { kind: 'task', title, due: due.toISOString(), minutes: readDuration(clause) || (/\btakes?\b/.test(t) ? span : null) } };
    }
  }

  // ---- a standing activity at fixed times: "robotics Monday and Wednesday 3:45 to 5:30"
  const range = readRange(clause, hint, nowMin);
  if (when.repeats && range && (ACTIVITY_WORD.test(t) || /\bi work\b/.test(t))) {
    const title = readTitle(clause.replace(/\bi work\b/i, 'Work'), { matchedDay: when.matched });
    return { op: { kind: 'activity', title, type: activityType(t), mode: 'fixed', days: when.days, start: range.start, end: range.end } };
  }

  // ---- anything else with a time on it is an event
  const ev = eventFrom(clause, t, when, now, { hint });
  if (ev) return { op: ev };
  return null;
}

/** A calendar event out of a clause, or null when there is no time in it. */
function eventFrom(clause, t, when, now, { assume = false, hint = 'day' } = {}) {
  const nowMin = minuteOf(now);
  // "...should take about two hours" is an estimate, not a two o'clock event.
  if (/\b(?:should|will|might|would|takes?|'ll)\s+take\b/.test(t) && !when.dates.length && !when.repeats) return null;
  const range = readRange(clause, hint, nowMin);
  const PART = [[/\b(nights?|evenings?|tonight)\b/, '19:00'], [/\bafternoons?\b/, '14:00'], [/\bmornings?\b/, '09:00'], [/\bafter school\b/, '15:45']];
  const part = PART.find(([re]) => re.test(t));
  const exact = range?.start || readTime(clause, hint, nowMin);
  // "Tonight" alone can place an event ("movie Friday night"), but not when
  // the only number in the sentence is an amount of time.
  if (!exact && readSpan(clause) && !readDuration(clause)) return null;
  const start = exact || (part ? part[1] : null);
  if (!start) return null;
  const minutes = readDuration(clause) || (assume ? 180 : defaultDuration(t));
  const end = range?.end || fromMin(Math.min(toMin(start) + minutes, 23 * 60 + 59));
  const title = readTitle(clause, { matchedDay: when.matched });
  const dates = when.dates.length ? when.dates : (when.repeats ? [] : [new Date(now)]);
  return { kind: 'event', title, start, end, days: when.repeats ? when.days : [], dates: dates.map((d) => dateKey(d)) };
}

// ------------------------------------------------------------- interpret

/**
 * Read a whole message.
 * @returns {{ops:object[], queries:object[], ask:object|null}}
 */
export function read(text, state, now = new Date()) {
  const ops = [];
  const queries = [];
  const signals = [];
  let care = null;

  for (const c of clauses(text)) {
    const r = readClause(c, state, now);
    if (!r) {
      // "..., should take about two hours" is an estimate for what came before.
      const mins = readDuration(c) || (/\btakes?\b/i.test(c) ? readSpan(c) : null);
      const last = ops.at(-1);
      if (mins && last?.kind === 'task' && !last.minutes) last.minutes = mins;
      continue;
    }
    if (r.op) {
      // "half day tomorrow, we get out at 12": the second clause is the time for the first.
      const prev0 = ops.at(-1);
      if (r.op.kind === 'school' && r.op.early?.length && prev0?.kind === 'school' && prev0.early?.length && !readDays(c, now).dates.length) {
        prev0.early[0].time = r.op.early[0].time;
        continue;
      }
      // "...and I'm free after 3 that day" means the day the last thing was about.
      if (/\bthat (?:day|night|evening|afternoon)\b/i.test(c) && r.op.kind === 'day') {
        const prev = ops.at(-1);
        if (prev?.dates?.length) r.op.dates = prev.dates;
      }
      ops.push(r.op);
    }
    if (r.query) queries.push(r.query);
    if (r.signal === 'care') care = r.care;
    else if (r.signal) signals.push(r.signal);
  }

  const today = dateKey(now);
  const tonight = ops.find((o) => o.kind === 'day' && o.dates?.includes(today) && !o.off);

  // Eating (or a shower) first: it goes on the calendar now, and work starts
  // after it. "Now" can be before the day's work could begin anyway (a message
  // sent at lunch), so work starts at whichever is later.
  const opens = firstMoment(state, now);
  let begin = opens;
  if (care) {
    const start = roundUp5(now);
    const end = new Date(+start + care.minutes * MIN);
    ops.unshift({ kind: 'event', title: care.title, start: hhmm(start), end: hhmm(end), days: [], dates: [today] });
    if (+end > +opens) {
      begin = end;
      if (tonight && !tonight.startAt) tonight.startAt = hhmm(end);
    }
  }
  if (tonight?.startAt) begin = new Date(Math.max(+begin, +atTime(now, tonight.startAt)));

  // "...and then go to sleep": the night ends when the work does. That is
  // worked out from the time that is actually free, so practice from 4 to 6
  // pushes it later instead of leaving no room for the work at all.
  if (signals.includes('sleep-after') && tonight && Number.isFinite(tonight.budgetMin) && !tonight.until) {
    const end = nightEnd(state, now, begin, tonight.budgetMin);
    if (end) { tonight.until = hhmm(roundUp5(end)); tonight.untilAuto = true; }
    tonight.note = 'tired';
  }
  if (signals.includes('tired') && tonight) tonight.note = 'tired';

  // Tired, and no number: ask once rather than decide for her.
  let ask = null;
  if (signals.includes('tired') && !tonight && !ops.some((o) => o.kind === 'day' && o.off)) {
    const planned = (state.plan?.sessions || []).filter((s) => !s.done && dateKey(new Date(s.start)) === today && +new Date(s.end) > +now)
      .reduce((a, s) => a + s.minutes, 0);
    ask = {
      question: planned
        ? `There is ${Math.round(planned / 5) * 5 >= 60 ? `${Math.floor(planned / 60)}h${planned % 60 ? ` ${planned % 60}m` : ''}` : `${planned}m`} planned tonight. How much do you have in you?`
        : 'How much do you want to do tonight?',
      options: [
        { label: '30 minutes', text: 'I can do 30 minutes of work tonight' },
        { label: '1 hour', text: 'I can do 1 hour of work tonight' },
        { label: '1.5 hours', text: 'I can do an hour and a half of work tonight' },
        { label: 'Nothing tonight', text: 'I am done for tonight' }
      ]
    };
  }

  // opId names the operation itself. `id` is left alone: on a removal it is
  // the thing being removed.
  return { ops: ops.map((o) => ({ ...o, opId: uid('op') })), queries, ask };
}

/**
 * When `minutes` of work, with its breaks, would be finished tonight, starting
 * from `begin` and stepping over whatever is already on the calendar. Null when
 * it would run past the usual end of the day, which then stays the limit.
 */
function nightEnd(state, now, begin, minutes) {
  const usual = workWindows({ ...state, dayOverrides: {} }, now)[0];
  if (!usual) return null;
  let close = atTime(now, usual.end);
  if (+close <= +atTime(now, usual.start)) close = addDays(close, 1);
  const blocks = Math.max(1, Math.ceil(minutes / (state.settings?.sessionMaxMin || 45)));
  let need = minutes + (blocks - 1) * (state.settings?.breakMin ?? 10) + 10;
  const busy = allBusy(state)
    .map((b) => ({ start: +new Date(b.start), end: +new Date(b.end) }))
    .filter((b) => b.end > +begin && b.start < +close)
    .sort((a, b) => a.start - b.start);
  let cursor = +begin;
  for (const b of busy) {
    const room = (b.start - cursor) / MIN;
    if (room >= need) break;
    // A gap too short to sit down in is not counted; a block may start a
    // quarter of an hour into a longer one, which the slack above covers.
    if (room >= (state.settings?.sessionMinMin ?? 20)) need -= room;
    cursor = Math.max(cursor, b.end);
  }
  const end = cursor + need * MIN;
  return end <= +close ? new Date(end) : null;
}

/** The first moment work could start today: now, or when the day's window opens. */
function firstMoment(state, now) {
  const win = workWindows(state, now)[0];
  const opens = win ? atTime(now, win.start) : now;
  return roundUp5(new Date(Math.max(+now, +opens)));
}

// Kept for callers that only want operations.
export const interpret = (text, state, now = new Date()) => read(text, state, now).ops;
export { applyOps } from './agentops.js';

// ---------------------------------------------------------------- respond

const list = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0] || '');
const mins = (m) => { const r = Math.round(m); if (r < 60) return `${r} minutes`; const h = Math.floor(r / 60), x = r % 60; return x ? `${h}h ${x}m` : `${h} hour${h === 1 ? '' : 's'}`; };

/**
 * Carry out a message offline and say what happened.
 *
 * Returns the state to save (already replanned), the operations that took
 * effect, and a reply built from the difference between the old plan and the
 * new one, so the reply describes what actually moved rather than what was asked.
 */
export function respond(text, state, now = new Date()) {
  const { ops, queries, ask } = read(text, state, now);
  const out = { text: '', ops: [], moved: [], list: [], chips: [], next: null, changed: false };

  if (ask && !ops.length) {
    out.text = ask.question;
    out.chips = ask.options;
    return out;
  }

  if (ops.length) {
    const { next, applied, diff } = simulate(state, ops, now);
    out.ops = applied.map((op) => ({ ...op, summary: describe(op, next, now) }));
    if (applied.length) {
      out.next = next;
      out.changed = true;
      Object.assign(out, narrate(applied, diff, next, now));
    }
  }

  for (const q of queries) {
    if (q.kind === 'fit') {
      const { applied, diff, next } = simulate(out.next || state, [q.op], now);
      if (!applied.length) continue;
      const blocked = diff.newlyUnplaced.filter((u) => u.assigned);
      const what = describe(q.op, next, now);
      out.text = [out.text, blocked.length
        ? `That would be tight. With ${what}, ${list(blocked.map((u) => u.title))} would no longer fit before ${blocked.length === 1 ? 'it is' : 'they are'} due.`
        : `Yes, that works. ${diff.moved.length ? `${list(diff.moved.slice(0, 3).map((m) => m.title))} would move${diff.moved[0]?.to?.[0] ? ` to ${dayWord(diff.moved[0].to[0], now)}` : ''}, and everything still fits.` : 'Nothing else has to move.'}`].filter(Boolean).join(' ');
      out.chips.push({ label: 'Add it to my calendar', text: restate(q.op, now) });
      continue;
    }
    const a = answer(q, out.next || state, now);
    out.text = [out.text, a.text].filter(Boolean).join(' ');
    if (a.list) out.list.push(...a.list);
  }

  if (ask && ops.length) { out.text = `${out.text} ${ask.question}`.trim(); out.chips.push(...ask.options); }

  if (!out.text) {
    out.text = 'Nothing in that changed your plan. Try a sentence like “dinner at 6”, “robotics Monday and Wednesday 3:45 to 5:30”, “I am tired, an hour tonight” or “no school Friday”.';
    out.chips = [
      { label: 'What should I do now?', text: 'What should I do now?' },
      { label: 'How is my week?', text: 'How is my week?' }
    ];
  }
  return out;
}

/** Say an event back as a sentence the reader can send to add it for real. */
function restate(op, now) {
  const when = op.days?.length ? `every ${joinDays(op.days)}` : dayWord(op.dates[0], now);
  return `${op.title} ${when} ${sayClock(op.start)} to ${sayClock(op.end)}`;
}

/** The reply for a set of applied operations, written from what really changed. */
function narrate(applied, diff, next, now) {
  const today = dateKey(now);
  const night = applied.find((o) => o.kind === 'day' && o.dates?.includes(today));
  const parts = [];
  const lines = [];

  if (night?.off) {
    parts.push(diff.tonight.before ? 'Tonight is clear.' : 'Tonight was already clear.');
  } else if (night) {
    if (diff.tonight.after) {
      const end = diff.tonight.endsAt ? `, finished by ${clockOf(diff.tonight.endsAt)}` : '';
      parts.push(`Tonight is ${mins(diff.tonight.after)} of work${end}.`);
      lines.push(...diff.tonight.blocks.map((b) => `${clockOf(b.start)} ${b.title} (${mins(b.minutes)})`));
    } else {
      // Empty because there is nothing to do, or because none of it fits?
      parts.push(diff.tonight.before ? 'Nothing fits in the time left tonight, so it has moved to other days.' : 'Nothing needs doing tonight.');
    }
  } else {
    parts.push(applied.length === 1 ? 'Done.' : `Done, ${applied.length} changes.`);
  }

  const moved = diff.moved.filter((m) => m.to.length);
  if (moved.length) {
    const show = moved.slice(0, 3).map((m) => `${m.title} to ${dayWord(m.to[0], now)}`);
    parts.push(`I moved ${list(show)}${moved.length > 3 ? `, and ${moved.length - 3} more` : ''}.`);
  }

  const stuck = diff.unplaced.filter((u) => u.assigned);
  const practice = diff.newlyUnplaced.filter((u) => !u.assigned);
  const chips = [];
  if (stuck.length) {
    const s = stuck[0];
    const due = s.due ? ` before it is due ${dayWord(dateKey(new Date(s.due)), now)}` : '';
    parts.push(`${list(stuck.map((u) => u.title))} ${stuck.length === 1 ? 'does' : 'do'} not fully fit${due}: ${mins(stuck.reduce((a, u) => a + u.minutes, 0))} short.`);
    if (night && !night.off) chips.push({ label: `Add ${mins(Math.min(60, Math.ceil(s.minutes / 15) * 15))} tonight`, text: `I can do ${mins((night.budgetMin || 0) + Math.min(60, Math.ceil(s.minutes / 15) * 15))} of work tonight` });
    chips.push({ label: 'What is due first?', text: 'What is due this week?' });
  } else if (practice.length) {
    parts.push(`${list(practice.map((u) => u.title))} will be short a session this week. Everything with a due date still fits.`);
  } else if (applied.some((o) => ['day', 'event', 'school', 'sleep', 'move', 'limit', 'activity', 'task', 'remove', 'done', 'estimate'].includes(o.kind))) {
    parts.push(moved.length || night ? 'Everything due still fits.' : 'Your plan is rebuilt around it and everything still fits.');
  }

  return { text: parts.join(' '), list: lines, chips, moved: moved.map((m) => `${m.title}: ${m.to.map((k) => dayWord(k, now)).join(', ')}`) };
}
