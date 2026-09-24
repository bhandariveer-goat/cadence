// Canvas calendar feed (read-only).
//
// Every Canvas user has a personal ICS URL: Calendar → "Calendar Feed". It
// needs no token and carries every assignment due date and course event, which
// makes it the one Canvas source that works outside a logged-in Canvas tab.
// It is a secret URL — anyone holding it can read the student's schedule — so
// it is stored with the rest of the user's settings and never logged.
//
// Richer data (submission status, points, instructions, rubrics) still comes
// from the session-based API client in ../canvas.js when Cadence runs inside
// Canvas. Assignment ids are derived to match that client's ids, so the two
// sources merge into one task rather than duplicating.

import { parseICS } from '../calendar.js';
import { classify } from '../estimator.js';
import { DAY } from '../util.js';

export const FEED_HELP = 'Canvas → Calendar → "Calendar Feed" (bottom right) → copy the link';

/** Canvas hands out .../feeds/calendars/user_<token>.ics */
export function looksLikeFeedUrl(url) {
  return /^https?:\/\/[^\s]+\/feeds\/calendars\/[^\s]+\.ics/i.test(String(url || '').trim());
}

/** Never show the whole thing back to the user — it's a credential. */
export function maskFeedUrl(url) {
  const s = String(url || '');
  const m = s.match(/^(https?:\/\/[^/]+).*?([^/]{6})\.ics$/i);
  return m ? `${m[1]}/…${m[2]}.ics` : s.slice(0, 28) + (s.length > 28 ? '…' : '');
}

/** "Essay 2 [ENG-11]" → { title: 'Essay 2', course: 'ENG-11' } */
function splitSummary(summary = '') {
  const m = summary.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
  return m ? { title: m[1].trim(), course: m[2].trim() } : { title: summary.trim(), course: '' };
}

/** Canvas UIDs look like event-assignment-118985@school.instructure.com */
function canvasIds(ev) {
  const from = `${ev.uid || ''} ${ev.url || ''}`;
  const assignment = from.match(/assignment[-_/](\d+)/i);
  const calendarEvent = from.match(/calendar_event[-_/](\d+)/i);
  const course = (ev.url || '').match(/\/courses\/(\d+)/);
  return { assignmentId: assignment?.[1] || null, eventId: calendarEvent?.[1] || null, courseId: course?.[1] || null };
}

/**
 * @returns {{assignments: object[], events: object[], count: number}}
 *   assignments — task-shaped, ids matching the API client's
 *   events — busy-shaped course events (lectures, labs, office hours)
 */
export function parseCanvasFeed(text, { horizonDays = 120 } = {}) {
  const raw = parseICS(text, { horizonDays });
  const assignments = [];
  const events = [];

  for (const ev of raw) {
    const { assignmentId, eventId, courseId } = canvasIds(ev);
    const { title, course } = splitSummary(ev.title);
    // An assignment in the feed is a zero-length event at its due time.
    const zeroLength = +new Date(ev.end) - +new Date(ev.start) < 60 * 1000;

    if (assignmentId || (zeroLength && !ev.allDay)) {
      const task = {
        id: assignmentId ? `canvas_assignment_${assignmentId}` : `feed_${ev.id}`,
        source: 'canvas-feed',
        canvasType: 'assignment',
        canvasId: assignmentId || '',
        courseId,
        courseName: course,
        title: title || 'Assignment',
        description: ev.description || '',
        due: ev.start,
        points: null,
        url: ev.url || null,
        status: 'todo'
      };
      task.category = classify(task);
      assignments.push(task);
    } else {
      events.push({
        id: `canvasfeed_${eventId || ev.id}`,
        title: course ? `${title} · ${course}` : title || 'Canvas event',
        start: ev.start,
        end: ev.end,
        allDay: !!ev.allDay,
        url: ev.url || null,
        source: 'canvas-feed'
      });
    }
  }
  return { assignments, events, count: assignments.length + events.length };
}

/**
 * Fetch and parse the feed. Only works where cross-origin fetch is allowed —
 * the extension (host permissions) or a proxy; on the plain website the
 * browser blocks it and the caller should fall back to file import.
 */
export async function fetchCanvasFeed(url, { horizonDays = 120, fetchImpl = fetch } = {}) {
  if (!url) throw new Error('No Canvas feed URL saved yet');
  const res = await fetchImpl(url.replace(/^webcal:/i, 'https:'), { credentials: 'omit' });
  if (!res.ok) throw new Error(`Canvas feed returned ${res.status}`);
  const text = await res.text();
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error("That URL didn't return a calendar");
  return parseCanvasFeed(text, { horizonDays });
}

/**
 * Does this .ics text come from Canvas? A downloaded Canvas feed has to go
 * through parseCanvasFeed instead of the generic parser, or every assignment
 * lands as busy time rather than as work to schedule.
 */
export function looksLikeCanvasIcs(text) {
  const s = String(text || '');
  return /PRODID:[^\n]*(instructure|canvas)/i.test(s)
    || /UID:[^\n]*event-assignment[-_]/i.test(s)
    || /\/feeds\/calendars\//i.test(s);
}
