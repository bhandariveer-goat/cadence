// Natural-language parsing for the voice / quick-add box.
//
// "AP Bio: cell respiration lab report, due next Friday, worth 50 points,
//  should take about two hours"
//        -> {course, title, due, points, estimateMin, category}
//
// Runs entirely offline. If an API key is configured, ai.js can re-parse the
// same string for better titles — but this always produces something usable.

import { addDays, startOfDay, atTime } from './util.js';
import { classify } from './estimator.js';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];
const NUMWORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  ninety: 90, hundred: 100, half: 0.5, 'a half': 0.5, an: 1, a: 1
};

const num = (s) => {
  if (s == null) return null;
  const t = String(s).trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  return NUMWORDS[t] ?? null;
};

/** Parse a time-of-day phrase; returns "HH:MM" or null. */
function parseClock(text) {
  const m = text.match(/\b(?:at|by|before)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/i);
  if (m) {
    let h = Number(m[1]);
    const mi = m[2] ? Number(m[2]) : 0;
    const ap = (m[3] || '').toLowerCase();
    if (ap.startsWith('p') && h < 12) h += 12;
    if (ap.startsWith('a') && h === 12) h = 0;
    if (!ap && h <= 7) h += 12;             // "by 3" on a school night means 3pm
    return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
  }
  if (/\bmidnight\b/i.test(text)) return '23:59';
  if (/\bnoon\b/i.test(text)) return '12:00';
  if (/\bend of (?:the )?day\b/i.test(text)) return '23:59';
  return null;
}

/**
 * Find a due date in free text.
 * @returns {{date: Date, matched: string} | null}
 */
export function parseDate(text, now = new Date()) {
  const t = text.toLowerCase();
  const clock = parseClock(t) || '23:59';
  const at = (d) => atTime(d, clock);

  let m;
  if ((m = t.match(/\btoday\b/))) return { date: at(now), matched: m[0] };
  if ((m = t.match(/\btomorrow\b/))) return { date: at(addDays(now, 1)), matched: m[0] };
  if ((m = t.match(/\bin\s+(\d+|a|two|three|four|five|six|seven|ten)\s+(day|week)s?\b/))) {
    const n = num(m[1]) ?? 1;
    return { date: at(addDays(now, m[2] === 'week' ? n * 7 : n)), matched: m[0] };
  }
  if ((m = t.match(/\b(next|this|coming)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/))) {
    const target = WEEKDAYS.indexOf(m[2]);
    let delta = (target - now.getDay() + 7) % 7;
    if (delta === 0) delta = 7;                       // "friday" said on Friday = next one
    if (m[1] === 'next' && delta < 7) delta += 7;
    return { date: at(addDays(now, delta)), matched: m[0].trim() };
  }
  if ((m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/))) {
    const mi = MONTHS.findIndex((x) => x.startsWith(m[1]));
    const d = new Date(now.getFullYear(), mi, Number(m[2]));
    if (d < startOfDay(now)) d.setFullYear(d.getFullYear() + 1);
    return { date: at(d), matched: m[0] };
  }
  if ((m = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : now.getFullYear();
    const d = new Date(y, Number(m[1]) - 1, Number(m[2]));
    if (!m[3] && d < startOfDay(now)) d.setFullYear(d.getFullYear() + 1);
    return { date: at(d), matched: m[0] };
  }
  if ((m = t.match(/\bend of (?:the )?week\b/))) {
    const delta = (5 - now.getDay() + 7) % 7 || 7;
    return { date: at(addDays(now, delta)), matched: m[0] };
  }
  if ((m = t.match(/\bnext week\b/))) return { date: at(addDays(now, 7)), matched: m[0] };
  return null;
}

const FILLER = /\b(?:create|add|make|new|an?|the|assignment|homework|hw|task|for|please|called|titled|named|entitled|to do|todo)\b/gi;
const DANGLING = /\b(?:by|at|before|on|due|turn in|submit|deadline)\s*(?:night|morning|afternoon|evening|midnight|noon)?\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi;

/** Remove a matched phrase regardless of how it was capitalized. */
function strip(text, phrase) {
  if (!phrase) return text;
  return text.replace(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ');
}

/**
 * @returns {{title, courseHint, due, points, estimateMin, category, description, confidence}}
 */
export function parseAssignmentText(raw, { courses = [], now = new Date() } = {}) {
  const text = String(raw || '').trim().replace(/\s+/g, ' ');
  let rest = text;
  const notes = [];

  // --- course -------------------------------------------------------------
  let courseHint = null;
  for (const c of courses) {
    for (const n of [c.name, c.code].filter(Boolean)) {
      // Spoken course names drift from the Canvas spelling: "Design and
      // Engineering" for "Design & Engineering", extra spaces, missing hyphens.
      const body = n.trim()
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\s*&\s*/g, '\\s+(?:&|and)\\s+')
        .replace(/[\s_-]+/g, '[\\s_-]+');
      const re = new RegExp(`\\b${body}\\b`, 'i');
      if (re.test(text)) { courseHint = c; rest = rest.replace(re, ' '); break; }
    }
    if (courseHint) break;
  }
  if (!courseHint) {
    const m = text.match(/\b(?:for|in)\s+((?:[A-Z][\w-]*|AP|IB|Honors)(?:\s+[A-Z]?[\w-]+){0,3})\s*[:,]/);
    if (m) { courseHint = { id: null, name: m[1].trim() }; rest = rest.replace(m[0], ' '); }
  }
  const colon = rest.match(/^([^:]{2,40}):\s*(.+)$/);
  if (!courseHint && colon && colon[1].split(' ').length <= 5) {
    courseHint = { id: null, name: colon[1].trim() };
    rest = colon[2];
  } else if (colon && courseHint) {
    rest = colon[2];
  }

  // Points and effort come out before the date: a phrase like "due 9/18 worth
  // 10 points" would otherwise get swallowed whole by the due clause.

  // --- points -------------------------------------------------------------
  let points = null;
  const pm = rest.match(/\b(?:worth\s+)?(\d{1,3}|one|two|three|five|ten|twenty|thirty|fifty|hundred)\s*(?:points?|pts?|marks?)\b/i);
  if (pm) { points = num(pm[1]); rest = strip(rest, pm[0]); notes.push(`${points} points`); }

  // --- explicit effort ----------------------------------------------------
  let estimateMin = null;
  const hm = rest.match(
    /\b(?:should\s+)?(?:takes?|taking\s+)?\s*(?:about|around|roughly|approximately)?\s*(\d{1,2}(?:\.\d)?|one|two|three|four|five|half|an?)\s*(?:and a half\s*)?(hours?|hrs?|minutes?|mins?)\b/i);
  if (hm) {
    const n = num(hm[1]) ?? 1;
    const half = /and a half/i.test(hm[0]) ? 0.5 : 0;
    estimateMin = /^h/i.test(hm[2]) ? Math.round((n + half) * 60) : Math.round(n);
    rest = strip(rest, hm[0]);
    notes.push(`~${estimateMin} min`);
  }

  // --- due date -----------------------------------------------------------
  let due = null;
  // Read from the "due"/"turn in" keyword onward when there is one, but only
  // delete the date phrase itself — the rest of that clause is often the title.
  const dueIdx = rest.search(/\b(?:due|deadline|turn in|submit)\b/i);
  const parsed = parseDate(dueIdx >= 0 ? rest.slice(dueIdx) : rest, now);
  if (parsed) {
    due = parsed.date.toISOString();
    rest = strip(rest, parsed.matched);
    notes.push(`due ${parsed.date.toLocaleString()}`);
  }

  // --- title --------------------------------------------------------------
  let title = rest
    .replace(/\b(?:should|it|that|which|will|is|be|and|with|worth|about|approximately)\b/gi, ' ')
    .replace(FILLER, ' ')
    .replace(DANGLING, ' ')
    .replace(/[,;.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:;,\-–—]+|[\s:;,\-–—]+$/g, '')
    .trim();
  if (title.length < 3) title = text.slice(0, 80);
  title = title.charAt(0).toUpperCase() + title.slice(1);

  const draft = { title, description: text, canvasType: 'assignment' };
  const category = classify(draft);

  return {
    title,
    courseHint,
    courseId: courseHint?.id || null,
    courseName: courseHint?.name || '',
    due,
    points,
    estimateMin,
    category,
    description: '',
    transcript: text,
    notes,
    confidence: (due ? 0.3 : 0) + (courseHint ? 0.3 : 0) + (title.length > 4 ? 0.3 : 0) + (points ? 0.1 : 0)
  };
}
