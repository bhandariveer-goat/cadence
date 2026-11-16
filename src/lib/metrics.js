// Anonymous usage data.
//
// So that whoever runs Cadence can see whether people come back, where they
// get stuck and what they never find, a copy of Cadence with site.countUsage
// set in src/config.js sends three things to its own server
// (netlify/functions/metric.mjs):
//
// 1. Counts. One of five words, with a random ID:
//      active      the app was opened and used on a new day (sent at most daily)
//      onboarded   setup was finished
//      has_work    the plan has an assignment or an activity in it
//      checked_in  the first check-in
//      connected   a calendar was connected
//    Each of the last four is sent once, ever.
//
// 2. How the app is used, with the same random ID and a random ID for the
//    visit: records made by src/panel/insight.js, each a kind from KINDS, a
//    name made of code characters only (a screen, or a control's name in
//    Cadence's code), the screen it happened on, and a number (milliseconds,
//    a count or a step). Never what was typed, never a title or anything from
//    the plan, never where on the screen, and nothing from Gmail or email.
//    Held in memory only, and sent in batches.
//
// 3. The sign-up screen, before anyone has agreed to anything, so with no ID
//    at all: one of four step names (STEPS), at most once each per page load.
//
// The ID is made by this browser and is not the account; it is kept in its
// own storage slot, outside the plan, so it is never copied to an account and
// is gone with "Delete my data" and sign out. Turning usage data off in
// Account deletes the ID and asks the server to forget every row for it.
// Times are the server's, not this browser's, except how long things took.
//
// Nothing with the ID is sent in the demo, before the person has agreed to the
// policy that says so (policySeen has reached POLICY_CHANGE.date), or when this
// is off. A failed send is dropped or tried again later, and never shows an
// error.

import { CONFIG, cloudConfigured } from '../config.js';
import { POLICY_CHANGE } from './policy.js';
import { dateKey } from './util.js';

const KEY = 'cadence.usage.v1';
const HAS_CHROME = typeof chrome !== 'undefined' && !!chrome.storage?.local;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const EVENTS = ['active', 'onboarded', 'has_work', 'checked_in', 'connected'];
export const KINDS = ['screen', 'click', 'dead_click', 'rage_click', 'step', 'error', 'timing', 'session', 'milestone'];
export const STEPS = ['signin:shown', 'signin:started', 'signin:submitted', 'signin:done'];
export const NAME = /^[a-z0-9][a-z0-9_.:-]{0,79}$/;
const MAX_VALUE = 2000000000;
const BATCH = 40;      // records per request (the server takes up to 50)
const HOLD = 400;      // records kept waiting at most; beyond that new ones are dropped
const PER_VISIT = 3000;

/** Is counting switched on for this copy of Cadence (src/config.js) and possible (a server to send to)? */
export const usageConfigured = () => !!CONFIG.site?.countUsage && cloudConfigured();

/** Where usage data is sent: this site's own server, whether from the website or the extension. */
function endpoint() {
  if (/^https?:$/.test(location.protocol)) return new URL('/api/metric', location.origin).href;
  return CONFIG.site?.domain ? `https://${CONFIG.site.domain}/api/metric` : null;
}

// ------------------------------------------------------------ the local slot

/** What this browser has recorded: {id, off, sent}. Nothing is created by reading it. */
async function read() {
  let v = null;
  try {
    v = HAS_CHROME ? (await chrome.storage.local.get(KEY))[KEY] : JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch { v = null; }
  const rec = {
    id: typeof v?.id === 'string' && UUID.test(v.id) ? v.id : '',
    off: v?.off === true,
    sent: v?.sent && typeof v.sent === 'object' && !Array.isArray(v.sent) ? v.sent : {},
  };
  known = { id: rec.id, off: rec.off };
  return rec;
}

async function write(v) {
  known = { id: v.id, off: v.off };
  try {
    if (HAS_CHROME) await chrome.storage.local.set({ [KEY]: v });
    else localStorage.setItem(KEY, JSON.stringify(v));
  } catch { /* storage refused: nothing is counted */ }
}

async function clear() {
  known = { id: '', off: false };
  try {
    if (HAS_CHROME) await chrome.storage.local.remove(KEY);
    else localStorage.removeItem(KEY);
  } catch { /* nothing to clear */ }
}

// The slot as last read or written, so a send while the page is closing does
// not have to wait for storage. null until the first read.
let known = null;

// One change to the slot at a time, so two parts of the app can never each
// make an ID at the same moment.
let lock = Promise.resolve();
function locked(fn) {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

/** The slot, with an ID made if there was none yet. Call inside locked(). */
async function withId() {
  const rec = await read();
  if (rec.id) return rec;
  const made = { id: crypto.randomUUID(), off: false, sent: {} };
  await write(made);
  return made;
}

// -------------------------------------------------------------- what to send

/** Which of the one-time words are true of this plan. Only yes or no, read from the plan and sent as a bare word. */
export function milestones(state) {
  const out = [];
  if (state?.profile?.onboarded) out.push('onboarded');
  if (Object.keys(state?.tasks || {}).length || (state?.commitments || []).some((c) => !c.archived)) out.push('has_work');
  if ((state?.checkins || []).length) out.push('checked_in');
  // Calendars only. Gmail is never part of this, whatever it is connected to.
  if (Object.entries(state?.sources || {}).some(([id, s]) => id !== 'mail' && s?.enabled)) out.push('connected');
  return out;
}

/** May this person be counted: configured, not the demo, and they have agreed to the policy that says so? */
export function eligible(state, { demo = false } = {}) {
  return usageConfigured() && !demo && !!state?.profile?.consentedAt
    && String(state.profile.policySeen || '') >= POLICY_CHANGE.date;
}

async function send(body) {
  const url = endpoint();
  if (!url) return false;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), keepalive: true });
    return res.ok;
  } catch { return false; }
}

/**
 * Count today's use and any new milestones. Safe to call as often as you
 * like: the daily word goes once a day and each milestone once, and a call
 * while another is running is skipped.
 * @param {object} state  the plan (read for yes/no facts only)
 * @param {{demo?: boolean, now?: Date}} o
 */
let running = false;
export async function noteUsage(state, { demo = false, now = new Date() } = {}) {
  if (running || !eligible(state, { demo })) return;
  running = true;
  try {
    await locked(async () => {
      if ((await read()).off) return;
      const rec = await withId();
      const today = dateKey(now);
      const due = [];
      if (rec.sent.active !== today) due.push(['active', today]);
      for (const m of milestones(state)) if (!rec.sent[m]) due.push([m, today]);
      if (!due.length) return;
      const sent = { ...rec.sent };
      for (const [event, day] of due) {
        if (!(await send({ id: rec.id, event }))) continue;
        sent[event] = day;
        // How long the first of each milestone took, in seconds from agreeing to
        // the terms (the time agreed is read here, never sent).
        const from = Date.parse(state.profile.consentedAt);
        if (event !== 'active' && from) track('milestone', event, { value: Math.max(0, Math.round((now - from) / 1000)) });
      }
      await write({ id: rec.id, off: false, sent });
    });
  } finally { running = false; }
}

// ------------------------------------------------------ how the app is used

let allowed = false;   // agreed, seen the change, not the demo, and not turned off (allowDetail)
let buffer = [];       // records waiting to be sent, in memory only
let seq = 0;           // each record's order in this visit
let visit = '';        // a random ID for this visit, made when the first record is kept
let flushing = false;

/**
 * Whether records of how the app is used may be kept from now on. Called on
 * every render (src/panel/app.js). Until the Account switch has been read from
 * storage, and whenever it is off, nothing is kept.
 */
export function allowDetail(state, { demo = false } = {}) {
  const ok = () => eligible(state, { demo }) && known !== null && !known.off;
  allowed = ok();
  if (!allowed) buffer = [];
  // The first time, the switch is read from storage and the answer applies as soon as it is in.
  if (known === null) read().then(() => { allowed = ok(); }).catch(() => {});
  return allowed;
}

/** Are records being kept right now? */
export const detailAllowed = () => allowed;

const clean = (s) => (typeof s === 'string' && NAME.test(s) ? s : '');

/**
 * Keeps one record of how the app is used, to be sent with the next batch.
 * Dropped unless allowDetail() says so, or when the kind, name or screen is
 * not one that fits.
 */
export function track(kind, name, { screen = '', value } = {}) {
  if (!allowed || !KINDS.includes(kind) || !clean(name)) return false;
  if (buffer.length >= HOLD || seq >= PER_VISIT) return false;
  const rec = { q: seq++, k: kind, n: name };
  if (clean(screen)) rec.s = screen;
  if (Number.isFinite(value)) rec.v = Math.min(MAX_VALUE, Math.max(0, Math.round(value)));
  visit ||= crypto.randomUUID();
  buffer.push(rec);
  return true;
}

/**
 * Sends what is waiting, in batches. A batch that fails stays for the next
 * try. With nothing waiting, or when not allowed, it does nothing.
 */
export async function flush() {
  if (flushing || !allowed || !buffer.length) return;
  flushing = true;
  try {
    // The ID as last seen, so a send while the page closes does not wait on storage.
    let id = known?.id;
    if (!id) id = (await locked(() => withId())).id;
    for (let tries = 0; tries < 5 && buffer.length && allowed; tries++) {
      const batch = buffer.slice(0, BATCH);
      if (!(await send({ id, session: visit, events: batch }))) break;
      buffer = buffer.slice(batch.length);
    }
  } catch { /* tried again with the next flush */ } finally { flushing = false; }
}

// --------------------------------------------------- the sign-up screen

const stepsSent = new Set();

/**
 * Counts one step of the sign-up screen (STEPS), with no ID: at most once per
 * page load for each step, never in the demo, and not where usage data was
 * turned off in this browser.
 */
export async function countStep(name, { demo = false } = {}) {
  if (!usageConfigured() || demo || !STEPS.includes(name) || stepsSent.has(name)) return false;
  stepsSent.add(name);
  if ((await read()).off) return false;
  return send({ steps: [name] });
}

// ------------------------------------------------------------- the person's say

/** Is this browser counted at all (on in config, and not turned off here)? */
export async function usageIsOn() {
  return usageConfigured() && !(await read()).off;
}

/**
 * Turn usage data off or on from Account. Off asks the server to forget every
 * row for this browser's ID, then deletes the ID; on starts again with a new
 * one, so nothing links the two. Returns {forgotten}: whether the server
 * confirmed deleting the earlier rows.
 */
export async function setUsage(on) {
  return locked(async () => {
    const rec = await read();
    let forgotten = true;
    buffer = [];
    if (!on) {
      allowed = false;
      // True when the server said it forgot the rows (or there were none to forget).
      if (rec.id) forgotten = await send({ id: rec.id, event: 'forget' });
      await write({ id: '', off: true, sent: {} });
    } else {
      await write({ id: '', off: false, sent: {} });
    }
    return { forgotten };
  });
}

/** Forget this browser's rows on the server and delete the local record (sign out, Delete my data). */
export async function forgetUsage() {
  return locked(async () => {
    allowed = false;
    buffer = [];
    const rec = await read();
    if (rec.id && usageConfigured()) await send({ id: rec.id, event: 'forget' });
    await clear();
  });
}
