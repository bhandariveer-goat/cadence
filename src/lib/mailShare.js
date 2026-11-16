// What the Chrome extension tells the Cadence website about the events it
// found in email, and the two things the website may ask it to do with them:
// delete one, or take a deletion back. The website is open in the same
// browser, and the messages go from that page to the extension inside Chrome,
// never through a server (manifest.json externally_connectable;
// src/panel/mailbridge.js is the website's side).
//
// The extension holds the events and the website shows a copy. So the
// extension answers only its own site, only these four messages, exactly as
// written, and only with what the website needs to draw the events: never a
// sign-in, an email address, a setting, or anything else in the plan.

import { deleteEvent, undoDelete, inLocalTime, dateOrder } from './mailEvents.js';

/** The messages the website may send, with the fields each must have and no others. */
export const SITE_MESSAGES = {
  'cadence:mail-ping': ['type'],
  'cadence:mail-events': ['type'],
  'cadence:mail-dismiss': ['type', 'id'],
  'cadence:mail-restore': ['type', 'id']
};
const EVENT_ID = /^mail_[A-Za-z0-9_-]{1,200}_\d{1,3}$/;

/** The website's origin from src/config.js's domain ("https://" + domain), or '' when that is not a plain domain. */
export function siteOrigin(domain) {
  const d = String(domain || '').trim().toLowerCase();
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d) ? `https://${d}` : '';
}

/** A message from the website, checked to the letter: {type, id?}, or null for anything else. */
export function readSiteMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || Object.getPrototypeOf(msg) !== Object.prototype) return null;
  const fields = Object.hasOwn(SITE_MESSAGES, msg.type) ? SITE_MESSAGES[msg.type] : null;
  if (!fields) return null;
  const got = Object.keys(msg);
  if (got.length !== fields.length || !got.every((k) => fields.includes(k))) return null;
  if (fields.includes('id') && (typeof msg.id !== 'string' || !EVENT_ID.test(msg.id))) return null;
  return fields.includes('id') ? { type: msg.type, id: msg.id } : { type: msg.type };
}

/** One event as the website gets it: what it needs to draw it and open it, nothing more. */
export function forSite(e) {
  const x = inLocalTime(e);
  const m = e.mail || {};
  return {
    id: x.id, title: x.title, start: x.start, end: x.end, allDay: !!x.allDay, busy: x.busy !== false,
    source: 'mail', calendarName: 'From email', url: null,
    mail: { kind: m.kind, quote: m.quote, from: String(m.from || '').replace(/\S+@\S+/g, (x) => x.split('@')[0]), subject: m.subject, date: m.date, startTime: m.startTime || '', endTime: m.endTime || '' }
  };
}

// Reading email for events is on: Gmail connected and the switch on.
const on = (st) => !!(st?.gmail?.enabled && st?.sources?.mail?.enabled);

/**
 * The extension's answer to a message from a web page, or null for no answer
 * at all: a message from anywhere but Cadence's own site, or one that is not
 * exactly one of the four. `deps` gives the extension's storage and planner:
 * { origin, version, loadState, update, recompute }.
 */
export async function answerSite(msg, sender, { origin, version = '', loadState, update, recompute = () => {}, now = () => new Date() } = {}) {
  if (!origin || sender?.origin !== origin) return null;
  const m = readSiteMessage(msg);
  if (!m) return null;
  if (m.type === 'cadence:mail-ping') return { ok: true, version: String(version), enabled: on(await loadState()) };
  if (m.type === 'cadence:mail-events') {
    const st = await loadState();
    const mail = st?.sources?.mail || {};
    const enabled = on(st);
    return { ok: true, enabled, updatedAt: mail.changedAt || mail.lastSync || null, events: enabled ? (mail.events || []).map(forSite) : [] };
  }
  if (m.type === 'cadence:mail-dismiss') {
    let removed = false;
    await update((st) => {
      if (on(st)) removed = !!deleteEvent(st.sources.mail, m.id, now());
      if (removed) recompute(st);
      return st;
    });
    return { ok: true, removed };
  }
  let result = { ok: false, why: 'gone' };
  await update((st) => {
    if (on(st)) result = undoDelete(st.sources.mail, m.id, now(), { order: dateOrder() });
    if (result.ok) recompute(st);
    return st;
  });
  return { ok: result.ok === true, ...(result.ok ? {} : { why: result.why }) };
}
