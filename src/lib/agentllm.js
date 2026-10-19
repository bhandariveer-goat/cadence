// The assistant, when a model is doing the reading.
//
// The model (Claude, or Gemini through the site's server function) gets the
// student's message with the current plan attached, and a set
// of tools (lib/agentspec.js) that map one to one onto the operations in
// lib/agentops.js. It calls tools; this file runs each one against a working
// copy of the plan and hands back what actually changed, so what the model says
// is grounded in the real result. Nothing is saved until the turn ends, and
// then it is saved once, which keeps undo a single step.
//
// Two ways to reach the model, same code after that:
//   direct  the student's own Anthropic key, sent from this browser
//   proxy   netlify/functions/agent.mjs, which holds the site's key (Gemini,
//           or Claude) and accepts only a signed-in account. For Gemini it
//           translates both ways (lib/gemini.js), so replies arrive here in
//           the same shape either way.
//
// The conversation is append-only. Earlier turns are never edited or trimmed;
// when it gets long a new one is started. Each reply is echoed back exactly as
// it arrived (including thinking blocks), which is what the API requires.

import { API_URL, API_VERSION, BETAS, LIMITS, requestBody, checkMessages } from './agentspec.js';
import { simulate, describe, planView, freeOn, clockOf, dayWord } from './agentops.js';
import { dateKey, addDays, startOfDay } from './util.js';
import { KINDS } from './habits.js';
import { workWindows, overrideFor } from './daymodel.js';
import { addNote } from './memory.js';
import { atRisk } from './scheduler.js';

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
      if (i.keep_limit === true) op.kept = true;
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
    case 'remember': {
      const note = String(i.note || '').trim();
      // Tried on a copy, so the model hears why a note was refused.
      const tried = addNote({ memory: structuredClone(state.memory || {}) }, note);
      if (tried.error) return { error: tried.error };
      return { ops: [{ kind: 'memory', note }] };
    }
    case 'forget': {
      const n = (state.memory?.notes || []).find((x) => x.id === i.id);
      if (!n) return { error: `no saved note with id ${i.id}. Use an id from memory.notes.` };
      return { ops: [{ kind: 'memory', forget: n.id, title: n.text }] };
    }
    case 'set_preferences': {
      const op = { kind: 'memory', prefs: {} };
      if (Number.isFinite(i.block_minutes)) op.prefs.blockMin = i.block_minutes;
      if (isTime(i.school_day_start)) op.prefs.startSchool = pad2(i.school_day_start);
      if (isTime(i.free_day_start)) op.prefs.startFree = pad2(i.free_day_start);
      if (typeof i.first_class === 'string' && i.first_class.trim()) op.prefs.firstCourse = i.first_class.trim().slice(0, 60);
      const clear = (Array.isArray(i.clear) ? i.clear : []).filter((k) => ['block_minutes', 'school_day_start', 'free_day_start', 'first_class'].includes(k));
      if (clear.length) op.prefs.clear = clear;
      if (!Object.keys(op.prefs).length) return { error: 'nothing to change: give a preference or clear' };
      return { ops: [op] };
    }
    case 'offer_choices':
      return { reply: { shown: true }, chips: (i.options || []).map((o) => String(o).trim().slice(0, 80)).filter(Boolean).slice(0, 4) };
    default:
      return { error: `unknown tool ${name}` };
  }
}

/**
 * Schoolwork due by the end of tomorrow that does not fit before the point
 * where the student said they would stop tonight. Returns null when there is
 * none; otherwise the latest time they would need to work until for it to fit
 * (tried in 15-minute steps up to 2am), or stay_up_until null when even that
 * is not enough. The planner never works past a time the student set to
 * stop (it books what is left after the due date instead, listed as late);
 * this is what lets the assistant tell them honestly what it would take.
 */
export function stayUpOption(state, now = new Date()) {
  const today = dateKey(now);
  const endOfTomorrow = +addDays(startOfDay(now), 2);
  const dueSoon = (st) => atRisk(st.plan).filter((u) => !u.commitmentId && u.due && +new Date(u.due) < endOfTomorrow);
  const short = dueSoon(state);
  if (!short.length) return null;
  const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
  // A Date, not the YYYY-MM-DD key: these read a bare key as midnight UTC,
  // which is the evening before across the Americas.
  const o = overrideFor(state, now) || {};
  const win = workWindows(state, now)[0];
  const nowMin = now.getHours() * 60 + now.getMinutes();
  let from = Math.max(nowMin, win ? (toMin(win.end) <= 300 ? toMin(win.end) + 1440 : toMin(win.end)) : nowMin);
  from = Math.ceil((from + 1) / 15) * 15;
  const missing = short.reduce((a, u) => a + (u.missingMin || 0), 0);
  for (let m = from; m <= 26 * 60; m += 15) {
    const until = `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const op = { kind: 'day', dates: [today], until, ...(Number.isFinite(o.budgetMin) ? { budgetMin: o.budgetMin + missing } : {}) };
    const { next } = simulate(state, [op], now);
    if (!dueSoon(next).length) {
      return { stay_up_until: until, to_finish: short.map((u) => u.title), limit_now: win?.end || null, ...(op.budgetMin ? { minutes_tonight: op.budgetMin } : {}) };
    }
  }
  return { stay_up_until: null, to_finish: short.map((u) => u.title), limit_now: win?.end || null, note: 'Does not fit even working until 2am' };
}

const INSISTS = /\b(keep (my|the|it|that)|stick (to|with)|no later|not later|nothing later|i have to (sleep|be in bed|go to bed)|i need to (sleep|be in bed) by|must (sleep|be in bed)|can'?t stay up|cannot stay up|not allowed|parents?|mom|dad|mum|curfew|sick|ill|hard (limit|stop)|my limit|that'?s final|no matter what)\b/i;

/** "23:30" as "11:30pm", for reply buttons. */
function twelve(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  const suffix = h >= 12 && h < 24 ? 'pm' : 'am';
  const hour = h % 12 || 12;
  return m ? `${hour}:${String(m).padStart(2, '0')}${suffix}` : `${hour}${suffix}`;
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
    does_not_fit: diff.unplaced.map((u) => `${u.title}: ${dur(u.minutes)} ${u.late ? 'planned after it is due' : 'short'}${u.due ? `, due ${dayWord(dateKey(new Date(u.due)), now)}` : ''}${u.assigned ? '' : ' (an activity session, not homework)'}`)
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

/**
 * Through the site's function, which holds the key and checks the account.
 * It says how many questions are left today; that rides along on the reply
 * as `remaining` and is never sent back.
 */
export const proxyTransport = (endpoint, getToken) => async (messages) => {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await getToken()}` },
    body: JSON.stringify({ messages })
  });
  const data = await parse(res);
  const left = res.headers.get('x-cadence-remaining');
  if (data && left != null && /^\d+$/.test(left)) data.remaining = Number(left);
  return data;
};

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
  // Whether the student, in their own words, insists on their time tonight.
  // The model's keep_limit counts only then: left to itself it sets it on
  // any stated bedtime, which made the assistant a yes-man again.
  const insists = INSISTS.test(String(text));
  const applied = [];
  let chips = [];
  let ownChips = null;          // set when Cadence moved tonight later: always offer to keep the student's time
  let remaining = null;         // questions left today, when the site's server says

  const tonight = stayUpOption(working, now);
  messages.push({ role: 'user', content: `<plan>${JSON.stringify({ ...planView(working, now), ...(tonight ? { if_staying_up: tonight } : {}) })}</plan>\n\n${String(text).slice(0, 2000)}` });

  try {
    for (let turn = 0; turn < LIMITS.maxTurns; turn++) {
      const problem = checkMessages(messages);
      if (problem) throw new AssistantUnavailable(problem);

      const res = await send(messages);
      if (!res || !Array.isArray(res.content)) throw new AssistantUnavailable('The assistant sent an empty reply');
      if (Number.isFinite(res.remaining)) remaining = res.remaining;
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
          chips: (ownChips || chips).map((c) => ({ label: c, text: c })),
          diff: null,
          remaining
        };
      }

      // Every call gets an answer, in one message, in the order they were made.
      const results = [];
      for (const call of calls) {
        const r = toOps(call.name, call.input, working, now);
        if (!insists) for (const op of r.ops || []) delete op.kept;
        if (r.error) { results.push({ type: 'tool_result', tool_use_id: call.id, content: r.error, is_error: true }); continue; }
        if (r.chips) chips = r.chips;
        if (r.reply) { results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(r.reply) }); continue; }
        const { next, applied: did, diff } = simulate(working, r.ops, now);
        if (!did.length) { results.push({ type: 'tool_result', tool_use_id: call.id, content: 'Nothing changed: that could not be applied as given.', is_error: true }); continue; }
        working = next;
        for (const op of did) applied.push({ ...op, summary: describe(op, working, now) });

        // Not a yes-man: a time to stop tonight that leaves schoolwork due
        // tomorrow undone is moved later, unless the student insisted on it.
        let moved = null;
        let finalDiff = diff;
        const tonight = dateKey(now);
        const limitsTonight = did.some((op) => op.kind === 'day' && (op.dates || []).includes(tonight) && !op.clear && !op.kept);
        if (limitsTonight && !overrideFor(working, now)?.kept) {
          const opt = stayUpOption(working, now);
          if (opt?.stay_up_until) {
            const later = { kind: 'day', dates: [tonight], until: opt.stay_up_until, ...(opt.minutes_tonight ? { budgetMin: opt.minutes_tonight } : {}) };
            const again = simulate(working, [later], now);
            if (again.applied.length) {
              working = again.next;
              finalDiff = again.diff;
              applied.push({ ...later, summary: describe(later, working, now) });
              const asked = did.find((op) => op.kind === 'day')?.until || opt.limit_now;
              const names = opt.to_finish.join(' and ');
              moved = {
                asked_until: asked || null, planned_until: opt.stay_up_until, because: opt.to_finish,
                what_happened: `The student asked to stop at ${asked ? twelve(asked) : 'their usual time'}. ${names} ${opt.to_finish.length > 1 ? 'are' : 'is'} due by tomorrow and would not fit, so Cadence moved tonight's stop time to ${twelve(opt.stay_up_until)}, and the plan now fits ${opt.to_finish.length > 1 ? 'them' : 'it'}. Their limit was NOT kept. Tell them this kindly, and that they can keep ${asked ? twelve(asked) : 'their time'} instead with the button.`
              };
              ownChips = [`OK, until ${twelve(opt.stay_up_until)}`, 'Only do the most urgent one', asked ? `Keep my ${twelve(asked)} limit` : 'Keep my limit'];
            }
          }
        }
        const realistic = moved ? null : stayUpOption(working, now);
        results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify({
          applied: did.map((op) => describe(op, working, now)), ...outcome(finalDiff, now),
          ...(moved ? { moved_later: moved } : {}), ...(realistic ? { if_staying_up: realistic } : {})
        }) });
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
