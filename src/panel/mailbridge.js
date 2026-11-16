// The website's side of the events found in email.
//
// The Chrome extension reads email and keeps the events it finds
// (lib/mailEvents.js). The website, open in the same browser, asks the
// extension for them and shows a copy. The messages go from this page to the
// extension inside Chrome and never through a server; the extension answers
// only this site (lib/mailShare.js). The website never reads email itself.
// Off until src/config.js names the published extension (extensionId).
//
// The extension is the one that knows. Each answer replaces the copy here; an
// answer to an older question is ignored; and when the extension cannot be
// reached (not installed, switched off, another browser) the copy is cleared,
// since nothing here can say it is still right. The copy lives under
// sources, so it is never copied to the account either (cloud.js portable()).

import { CONFIG } from '../config.js';
import { app, persist } from './core.js';
import { blankMail, KINDS } from '../lib/mailEvents.js';

const EVERY = 5 * 60 * 1000;
let asked = 0;             // the number of the latest question; older answers are ignored
let timer = null;

/** Can this page ask the extension: the website (not the extension itself), with the extension named in src/config.js? */
const canAsk = () => !!CONFIG.extensionId && typeof chrome !== 'undefined'
  && typeof chrome.runtime?.sendMessage === 'function' && !chrome.storage?.local;

/** Send one message to the extension. Its answer, or null when it cannot be reached. */
function ask(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(CONFIG.extensionId, message, (reply) => {
        // Reading lastError is what tells Chrome it was expected: it is set when
        // the extension is not installed, is off, or did not answer.
        if (chrome.runtime.lastError || !reply || typeof reply !== 'object') resolve(null);
        else resolve(reply);
      });
    } catch { resolve(null); }
  });
}

const isClock = (v) => v === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const text = (v, max) => typeof v === 'string' && v.length <= max;

/** Is this an event the way the extension sends them? Anything else is left out. */
function valid(e) {
  const m = e?.mail;
  return !!e && e.source === 'mail' && /^mail_[A-Za-z0-9_-]{1,200}_\d{1,3}$/.test(e.id || '')
    && text(e.title, 80) && !Number.isNaN(+new Date(e.start)) && !Number.isNaN(+new Date(e.end))
    && !!m && KINDS.includes(m.kind) && text(m.quote, 300) && text(m.from || '', 200) && text(m.subject || '', 300)
    && /^\d{4}-\d{2}-\d{2}$/.test(m.date || '') && isClock(m.startTime ?? '') && isClock(m.endTime ?? '');
}

/** Only the fields the calendar draws, whatever else an answer carries. */
const pick = (e) => ({
  id: e.id, title: e.title, start: e.start, end: e.end, allDay: !!e.allDay, busy: e.busy !== false,
  source: e.source, calendarName: 'From email', url: null,
  mail: { kind: e.mail.kind, quote: e.mail.quote, from: e.mail.from || '', subject: e.mail.subject || '', date: e.mail.date, startTime: e.mail.startTime || '', endTime: e.mail.endTime || '' }
});

/** Ask the extension for its events and show them here; clear the copy when it cannot be reached. */
export async function syncFromExtension() {
  if (!canAsk()) return;
  const n = ++asked;
  const reply = await ask({ type: 'cadence:mail-events' });
  if (n !== asked) return;                       // a newer question, or a deletion, came after this one
  const mail = app.S?.sources?.mail || {};
  if (reply?.ok !== true || !Array.isArray(reply.events)) {
    if (mail.enabled || (mail.events || []).length) await persist((st) => { st.sources.mail = blankMail(); }, { edit: false });
    return;
  }
  const enabled = reply.enabled === true;
  const events = enabled ? reply.events.filter(valid).slice(0, 200).map(pick) : [];
  if (mail.enabled === enabled && JSON.stringify(mail.events || []) === JSON.stringify(events)) return;
  await persist((st) => {
    st.sources.mail = { ...blankMail(), enabled, events, fromExtension: true, lastSync: new Date().toISOString(), changedAt: reply.updatedAt || null };
  }, { edit: false });
}

/**
 * Delete an email event: from the copy here at once, and in the extension,
 * which keeps that email from adding it again. When the extension cannot be
 * reached the event is put back here and null returned, so the page never
 * says it was deleted when it was not.
 */
export async function dismissInExtension(id) {
  const event = (app.S?.sources?.mail?.events || []).find((e) => e.id === id);
  if (!event || !canAsk()) return null;
  asked++;                                       // an answer already on its way would bring it back
  await persist((st) => { st.sources.mail.events = (st.sources.mail.events || []).filter((e) => e.id !== id); }, { edit: false });
  const reply = await ask({ type: 'cadence:mail-dismiss', id });
  if (reply?.ok !== true) {
    await persist((st) => { if (!(st.sources.mail.events || []).some((e) => e.id === id)) st.sources.mail.events.push(event); }, { edit: false });
    return null;
  }
  return event;
}

/** Take back a deletion, in the extension, then show its events again. {ok, why} */
export async function restoreInExtension(id) {
  if (!canAsk()) return { ok: false, why: 'unreachable' };
  const reply = await ask({ type: 'cadence:mail-restore', id });
  if (!reply) return { ok: false, why: 'unreachable' };
  await syncFromExtension();
  return { ok: reply.ok === true, why: reply.why };
}

/** Keep the copy current while the page is open: now, when the page is shown again, and every 5 minutes while it is visible. */
export function startMailBridge() {
  if (timer || !canAsk()) return;
  const tick = () => { if (document.visibilityState === 'visible') syncFromExtension(); };
  timer = setInterval(tick, EVERY);
  document.addEventListener('visibilitychange', tick);
  tick();
}
