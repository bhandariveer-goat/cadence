// The sync runner: fetches every connected calendar source, caches what it
// gets, and keeps one source's failure from affecting the others.
//
// Each source returns normalized data — busy-shaped events and task-shaped
// assignments — so neither the calendar UI nor the scheduler needs to know
// where anything came from.

import * as canvasFeed from './canvasFeed.js';
import * as google from './googleCalendar.js';

export const SOURCE_META = {
  canvasFeed: { label: 'Canvas calendar feed', short: 'Canvas' },
  google: { label: 'Google Calendar', short: 'Google' }
};

export function emptySource() {
  return { enabled: false, events: [], assignments: [], lastSync: null, error: null, syncing: false };
}

const ok = (state, id) => !!state.sources?.[id]?.enabled;

/**
 * Run one source. Throws on failure; the caller records the error so the
 * cached data from the last good run stays on screen.
 * @param {object} deps  { saveGoogle } persists refreshed Google tokens
 */
export async function runSource(id, state, deps = {}) {
  const cfg = state.sources?.[id] || {};
  const horizon = (state.settings?.lookaheadDays ?? 14) + 30;

  if (id === 'canvasFeed') {
    if (!cfg.url) throw new Error('No Canvas feed URL saved');
    const { assignments, events } = await canvasFeed.fetchCanvasFeed(cfg.url, { horizonDays: horizon });
    return { assignments, events };
  }

  if (id === 'google') {
    if (!google.available()) throw new Error('Google sync needs the Chrome extension');
    const token = await google.freshToken(cfg, { save: deps.saveGoogle || (() => {}) });
    const calendars = cfg.calendars?.length ? cfg.calendars : await google.listCalendars(token);
    const chosen = (cfg.selected?.length ? cfg.selected : calendars.filter((c) => c.selected).map((c) => c.id)) || ['primary'];
    const { events, errors } = await google.fetchEvents(token, { calendarIds: chosen, daysAhead: horizon });
    return { assignments: [], events, calendars, warning: errors.length ? errors.join('; ') : null };
  }

  throw new Error(`Unknown source ${id}`);
}

/**
 * Refresh every enabled source. Never throws: each result carries its own
 * error, and callers merge whatever succeeded.
 * @returns {{[id]: {ok, events, assignments, error, at, calendars?, warning?}}}
 */
export async function runAll(state, deps = {}, { only = null } = {}) {
  const ids = (only ? [only] : Object.keys(SOURCE_META)).filter((id) => only === id || ok(state, id));
  const results = {};
  await Promise.all(ids.map(async (id) => {
    try {
      const data = await runSource(id, state, deps);
      results[id] = { ok: true, at: new Date().toISOString(), error: null, ...data };
    } catch (e) {
      results[id] = { ok: false, at: new Date().toISOString(), error: e.message || String(e) };
    }
  }));
  return results;
}

/** Fold results into state, keeping the previous cache when a source failed. */
export function applyResults(state, results) {
  state.sources ||= {};
  for (const [id, r] of Object.entries(results || {})) {
    const prev = state.sources[id] || emptySource();
    state.sources[id] = {
      ...prev,
      syncing: false,
      error: r.ok ? (r.warning || null) : r.error,
      lastSync: r.ok ? r.at : prev.lastSync,
      lastTry: r.at,
      events: r.ok ? (r.events || []) : prev.events,
      assignments: r.ok ? (r.assignments || prev.assignments) : prev.assignments,
      ...(r.calendars ? { calendars: r.calendars } : {})
    };
  }
  return state;
}

/** Cached events from every enabled source, in Cadence's busy shape. */
export function sourceEvents(state) {
  const out = [];
  for (const [id, s] of Object.entries(state.sources || {})) {
    if (!s?.enabled) continue;
    for (const e of s.events || []) out.push({ ...e, source: e.source || id });
  }
  return out;
}

/** Assignments the feed knows about — merged into tasks by the replanner. */
export function sourceAssignments(state) {
  const out = [];
  for (const [, s] of Object.entries(state.sources || {})) {
    if (!s?.enabled) continue;
    for (const a of s.assignments || []) out.push(a);
  }
  return out;
}

/**
 * Mirror opted-in Cadence blocks onto Google Calendar.
 *
 * Needs the write scope, which is requested only when the student turns this
 * on. Returns what changed so callers can report it; throws only when the
 * whole run fails (auth), never for a single event.
 */
export async function pushGoogle(state, deps = {}, { daysAhead = 21 } = {}) {
  const g = state.sources?.google;
  if (!g?.enabled || !g.push) return null;
  const { pushableBlocks } = await import('../replanner.js');
  const token = await google.freshToken(g, { save: deps.saveGoogle || (() => {}), scopes: [google.SCOPES.read, google.SCOPES.write] });
  const desired = pushableBlocks(state, { daysAhead });
  const result = await google.reconcileBlocks(token, g.pushCalendarId || 'primary', desired, { daysAhead });
  return { ...result, desired: desired.length };
}

export { canvasFeed, google };
