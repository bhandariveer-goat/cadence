// The assistant, when Claude is doing the reading.
//
// Claude gets the student's message with the current plan attached, and a set
// of tools (lib/agentspec.js) that map one to one onto the operations in
// lib/agentops.js. It calls tools; this file runs each one against a working
// copy of the plan and hands back what actually changed, so what Claude says
// is grounded in the real result. Nothing is saved until the turn ends, and
// then it is saved once, which keeps undo a single step.
//
// Two ways to reach the model, same code after that:
//   direct  the student's own Anthropic key, sent from this browser
//   proxy   netlify/functions/agent.mjs, which holds the site's key and
//           accepts only a signed-in account
//
// The conversation is append-only. Earlier turns are never edited or trimmed;
// when it gets long a new one is started. Each reply is echoed back exactly as
// it arrived (including thinking blocks), which is what the API requires.

import { API_URL, API_VERSION, BETAS, LIMITS, requestBody, checkMessages } from './agentspec.js';
import { simulate, describe, planView, freeOn, clockOf, dayWord } from './agentops.js';
import { dateKey } from './util.js';
import { KINDS } from './habits.js';

export class AssistantUnavailable extends Error {}

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const isTime = (v) => /^\d{1,2}:\d{2}$/.test(String(v || ''));
const pad2 = (v) => { const [h, m] = String(v).split(':'); return `${String(h).padStart(2, '0')}:${m}`; };
const days = (v) => (Array.isArray(v) ? v.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : []);
const dur = (m) => { const r = Math.round(m); if (r < 60) return `${r}m`; const h = Math.floor(r / 60), x = r % 60; return x ? `${h}h ${x}m` : `${h}h`; };

function guessType(title) {
  const t = String(title).toLowerCase();
  if (/soccer|football|basketball|baseball|softball|volleyball|tennis|swim|track|cross|lacrosse|hockey|wrestl|golf|gym|cheer|karate|run|lift|workout/.test(t)) return 'sport';
  if (/piano|guitar|violin|cello|drum|sing|choir|band|orchestra|draw|paint|dance|theat|drama|rehears|lesson/.test(t)) return 'practice';
  if (/volunteer|service|food bank|tutor/.test(t)) return 'service';
  if (/club|team|robotics|debate|mun|newspaper|yearbook|council|trial|olympiad|chess/.test(t)) return 'club';
  if (/job|shift|work/.test(t)) return 'work';
  return KINDS.custom ? 'custom' : 'custom';
}

/**
 * Turn one tool call into operations (or a read-only answer).
 * @returns {{ops?:object[], reply?:object, chips?:string[], error?:string}}
 */
export function toOps(name, input, state, now) {
  const i = input || {};
  const title = String(i.title || '').trim().slice(0, 60);
  switch (name) {
    case 'add_event': {
      if (!isTime(i.start) || !isTime(i.end)) return { error: 'start and end must be HH:MM' };
      const w = days(i.weekdays);
      if (!w.length && i.date && !isDate(i.date)) return { error: 'date must be YYYY-MM-DD' };
      return { ops: [{ kind: 'event', title: title || 'Busy', start: pad2(i.start), end: pad2(i.end), days: w, dates: w.length ? [] : [i.date || dateKey(now)] }] };
    }
    case 'add_activity': {
      const w = days(i.weekdays);
      const fixed = w.length && isTime(i.start) && isTime(i.end);
      return { ops: [{ kind: 'activity', title: title || 'Activity', type: guessType(title), mode: fixed ? 'fixed' : 'flexible', days: w, start: fixed ? pad2(i.start) : null, end: fixed ? pad2(i.end) : null, sessions: i.times_per_week || (w.length || 3), minutes: i.minutes || 30 }] };
    }
    case 'add_assignment': {
      // A bare date would be read as midnight UTC, which is the evening
      // before in most of the Americas. No time given means end of that day.
      const due = new Date(isDate(i.due) ? `${i.due}T23:59` : i.due);
      if (isNaN(due)) return { error: 'due must be YYYY-MM-DDTHH:MM' };
      return { ops: [{ kind: 'task', title: title || 'Assignment', due: due.toISOString(), minutes: i.minutes || null, course: i.course || '' }] };
    }
    case 'set_day': {
      if (!isDate(i.date)) return { error: 'date must be YYYY-MM-DD' };
      const op = { kind: 'day', dates: [i.date] };
      if (i.clear) op.clear = true;
      if (i.off) op.off = true;
      if (Number.isFinite(i.budget_minutes)) op.budgetMin = i.budget_minutes;
      if (isTime(i.start_at)) op.startAt = pad2(i.start_at);
      if (isTime(i.until)) op.until = pad2(i.until);
      if (Object.keys(op).length === 2) return { error: 'nothing to change: give budget_minutes, start_at, until, off or clear' };
      return { ops: [op] };
    }
    case 'set_school': {
      const op = { kind: 'school' };
      const off = (i.no_school_dates || []).filter(isDate);
      const early = (i.early_release || []).filter((e) => isDate(e?.date) && isTime(e?.time)).map((e) => ({ date: e.date, time: pad2(e.time) }));
      if (off.length) op.offDates = off;
      if (early.length) op.early = early;
      if (isTime(i.usual_start)) op.start = pad2(i.usual_start);
      if (isTime(i.usual_end)) op.end = pad2(i.usual_end);
      if (Object.keys(op).length === 1) return { error: 'nothing to change' };
      return { ops: [op] };
    }
    case 'set_sleep': {
      const op = { kind: 'sleep' };
      if (isTime(i.bed)) op.bed = pad2(i.bed);
      if (isTime(i.wake)) op.wake = pad2(i.wake);
      if (Object.keys(op).length === 1) return { error: 'nothing to change' };
      return { ops: [op] };
    }
    case 'update_assignment': {
      const t = state.tasks?.[i.id];
      if (!t) return { error: `no assignment with id ${i.id}. Use an id from the plan.` };
      if (i.action === 'done') return { ops: [{ kind: 'done', taskId: t.id, title: t.title }] };
      if (i.action === 'do_first') return { ops: [{ kind: 'first', taskId: t.id, title: t.title }] };
      if (i.action === 'remove') return { ops: [{ kind: 'remove', target: 'task', id: t.id, title: t.title }] };
      if (i.action === 'move_to_date') return isDate(i.date) ? { ops: [{ kind: 'move', taskId: t.id, title: t.title, date: i.date }] } : { error: 'move_to_date needs a date' };
      if (i.action === 'set_minutes') return i.minutes > 0 ? { ops: [{ kind: 'estimate', taskId: t.id, title: t.title, minutes: i.minutes }] } : { error: 'set_minutes needs minutes' };
      return { error: 'unknown action' };
    }
    case 'remove_item': {
      if (i.kind === 'activity') {
        const c = (state.commitments || []).find((x) => x.id === i.id && !x.archived);
        if (!c) return { error: `no activity with id ${i.id}` };
        return { ops: [{ kind: 'remove', target: 'activity', id: c.id, title: c.title, date: isDate(i.date) ? i.date : null }] };
      }
      const b = (state.busy || []).find((x) => x.id === i.id);
      if (!b) return { error: `no removable event with id ${i.id}. School and events from a connected calendar cannot be removed here.` };
      return { ops: [{ kind: 'remove', target: 'event', id: b.id, title: b.title, date: isDate(i.date) ? i.date : null }] };
    }
    case 'what_if': {
      if (!isDate(i.date) || !isTime(i.start) || !isTime(i.end)) return { error: 'date, start and end are required' };
      const op = { kind: 'event', title: title || 'Busy', start: pad2(i.start), end: pad2(i.end), days: [], dates: [i.date] };
      const { diff } = simulate(state, [op], now);
      return { reply: { applied: false, would: outcome(diff, now) } };
    }
    case 'check_free': {
      if (!isDate(i.date)) return { error: 'date must be YYYY-MM-DD' };
      let slots = freeOn(state, i.date, now);
      if (i.part) {
        const [lo, hi] = { morning: [0, 720], afternoon: [720, 1020], evening: [1020, 1440] }[i.part] || [0, 1440];
        slots = slots.filter((s) => { const m = s.start.getHours() * 60 + s.start.getMinutes(); return m + s.minutes > lo && m < hi; });
      }
      return { reply: { date: i.date, free: slots.map((s) => ({ from: clockOf(s.start), to: clockOf(s.end), minutes: s.minutes })) } };
    }
    case 'offer_choices':
      return { reply: { shown: true }, chips: (i.options || []).map((o) => String(o).trim().slice(0, 80)).filter(Boolean).slice(0, 4) };
    default:
      return { error: `unknown tool ${name}` };
  }
}

/** What a change did, in the words the model should repeat back. */
function outcome(diff, now) {
  return {
    tonight: {
      minutes_of_work: diff.tonight.after,
      was: diff.tonight.before,
      finished_by: diff.tonight.endsAt ? clockOf(diff.tonight.endsAt) : null,
      blocks: diff.tonight.blocks.map((b) => `${clockOf(b.start)} ${b.title} (${dur(b.minutes)})`)
    },
    moved: diff.moved.filter((m) => m.to.length).map((m) => `${m.title} to ${m.to.map((k) => dayWord(k, now)).join(', ')}`),
    does_not_fit: diff.unplaced.map((u) => `${u.title}: ${dur(u.minutes)} short${u.due ? `, due ${dayWord(dateKey(new Date(u.due)), now)}` : ''}${u.assigned ? '' : ' (an activity session, not homework)'}`)
  };
}

// ------------------------------------------------------------- transport

async function parse(res) {
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new AssistantUnavailable(data?.error?.message || data?.error || `The assistant returned ${res.status}`);
  return data;
}

/** Straight to Anthropic with the student's own key. */
export const directTransport = (apiKey) => async (messages) => parse(await fetch(API_URL, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': API_VERSION,
    'anthropic-beta': BETAS,
    'anthropic-dangerous-direct-browser-access': 'true'
  },
  body: JSON.stringify(requestBody(messages))
}));

/** Through the site's function, which holds the key and checks the account. */
export const proxyTransport = (endpoint, getToken) => async (messages) => parse(await fetch(endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${await getToken()}` },
  body: JSON.stringify({ messages })
}));

// ------------------------------------------------------------------ loop

/**
 * One student message, start to finish.
 * @param {object}   o
 * @param {string}   o.text      what the student typed
 * @param {object}   o.state     the plan as it is now (not modified)
 * @param {object[]} o.messages  this conversation so far; appended to in place
 * @param {Function} o.send      a transport from above
 * @returns {{text:string, ops:object[], next:object|null, chips:object[], diff:object|null}}
 */
export async function converse({ text, state, messages, send, now = new Date() }) {
  const start = messages.length;
  let working = state;
  const applied = [];
  let chips = [];

  messages.push({ role: 'user', content: `<plan>${JSON.stringify(planView(working, now))}</plan>\n\n${String(text).slice(0, 2000)}` });

  try {
    for (let turn = 0; turn < LIMITS.maxTurns; turn++) {
      const problem = checkMessages(messages);
      if (problem) throw new AssistantUnavailable(problem);

      const res = await send(messages);
      if (!res || !Array.isArray(res.content)) throw new AssistantUnavailable('The assistant sent an empty reply');
      if (res.stop_reason === 'refusal') throw new AssistantUnavailable('The assistant declined that one');

      // Echoed back whole and unchanged, thinking blocks included.
      messages.push({ role: 'assistant', content: res.content });

      const calls = res.content.filter((b) => b.type === 'tool_use');
      // Cut off mid-thought, or stopped for any reason other than "run these
      // tools" while tool calls are pending: the turn is unusable. Leaving it
      // in the conversation would make every later request invalid, so it is
      // thrown away and the on-device reader answers instead.
      if (res.stop_reason === 'max_tokens' || (calls.length && res.stop_reason !== 'tool_use')) {
        throw new AssistantUnavailable('The assistant was cut off');
      }
      if (!calls.length) {
        const said = res.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
        if (!said && !applied.length) throw new AssistantUnavailable('The assistant had nothing to say');
        const changed = working !== state;
        return {
          text: tidy(said) || 'Done.',
          ops: applied,
          next: changed ? working : null,
          chips: chips.map((c) => ({ label: c, text: c })),
          diff: null
        };
      }

      // Every call gets an answer, in one message, in the order they were made.
      const results = [];
      for (const call of calls) {
        const r = toOps(call.name, call.input, working, now);
        if (r.error) { results.push({ type: 'tool_result', tool_use_id: call.id, content: r.error, is_error: true }); continue; }
        if (r.chips) chips = r.chips;
        if (r.reply) { results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(r.reply) }); continue; }
        const { next, applied: did, diff } = simulate(working, r.ops, now);
        if (!did.length) { results.push({ type: 'tool_result', tool_use_id: call.id, content: 'Nothing changed: that could not be applied as given.', is_error: true }); continue; }
        working = next;
        for (const op of did) applied.push({ ...op, summary: describe(op, working, now) });
        results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify({ applied: did.map((op) => describe(op, working, now)), ...outcome(diff, now) }) });
      }
      messages.push({ role: 'user', content: results });
    }
    throw new AssistantUnavailable('The assistant took too many steps');
  } catch (e) {
    // Leave the conversation as it was before this message, so a half-finished
    // exchange is never sent again and the offline reader can take over.
    messages.length = start;
    throw e;
  }
}

/** The model is asked for plain text; this enforces it. */
function tidy(text) {
  return String(text || '')
    .replace(/\s*\u2014\s*/g, ', ')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
