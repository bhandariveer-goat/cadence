// POST /api/agent
//
// The assistant, for students who have not brought their own Anthropic key.
// It runs on the company named by `assistant` in src/config.js, and on no
// other: Groq ("groq", lib/groq.js translates the conversation both ways),
// Google's Gemini ("gemini", lib/gemini.js), or Anthropic's Claude ("claude").
// The privacy page names the company from that same setting, so the page and
// the server cannot disagree. Keys live in this function's environment and
// never reach a browser.
//
// A request is accepted only when all of these hold:
//   1. it carries a Supabase session token that Supabase itself confirms;
//   2. that account, and the site as a whole, are under today's limits
//      (counted in Postgres by bump_agent_usage(), which an account cannot
//      reset and new accounts cannot get round; see schema.sql);
//   3. the body is a list of messages within the size limits, or, for outline
//      mode ("/secret" in the assistant), one assignment within its limits.
// The model, the instructions and the tools are fixed here (lib/agentspec.js,
// lib/outline.js). A client sends messages, or an assignment, and nothing else.
//
// Environment variables, set in Netlify > Project configuration > Environment
// variables (never in netlify.toml, which functions cannot read, and never in
// the repository):
//   GROQ_API_KEY          for assistant: 'groq', the key from console.groq.com
//   GROQ_RETENTION        must be "zero": the owner's word that Groq's zero
//                         data retention setting is on (console.groq.com >
//                         Settings > Data Controls). The privacy page says
//                         Groq keeps nothing; without it Groq is not used.
//   GROQ_MODEL            optional, another Groq model (default in lib/groq.js)
//   GEMINI_API_KEY        for assistant: 'gemini', the key from Google AI Studio
//   GEMINI_TIER           "free" or "paid": which Google plan the key is on.
//                         Must be set, so that using Gemini is a decision.
//                         On the free plan Google may use what students type
//                         to improve its products and people at Google may
//                         read it; the privacy page says so.
//   GEMINI_MODEL          optional, another Gemini model (default in lib/gemini.js)
//   ANTHROPIC_API_KEY     for assistant: 'claude'
//   SUPABASE_URL          required, same value as src/config.js
//   SUPABASE_KEY          required: the publishable key, same value as
//                         supabaseKey in src/config.js (SUPABASE_ANON_KEY is
//                         read too, for projects set up before the rename)
//   AGENT_DAILY_LIMIT     optional, questions per account per day (default 60;
//                         the database also stops an email account at 60 and
//                         an anonymous one at 15, see bump_agent_usage)
//   AGENT_DAILY_TOTAL     optional, questions across all accounts per day
//                         (default 1500). Anonymous accounts together get at
//                         most 30% of it, so throwaway accounts cannot use up
//                         everyone's day. A question can take a few model
//                         requests while tools run; those are capped per
//                         account in the database, not counted here.

import { CONFIG } from '../../src/config.js';
import { API_URL, API_VERSION, BETAS, MODEL, requestBody, checkMessages, usesEmail } from '../../src/lib/agentspec.js';
import { GEMINI_MODEL, geminiUrl, geminiRequest, fromGemini, thinkingFor } from '../../src/lib/gemini.js';
import { GROQ_MODEL, GROQ_PRODUCTION_MODELS, GROQ_URL, groqRequest, fromGroq, reasoningFor } from '../../src/lib/groq.js';
import { pickProvider } from '../../src/lib/providers.js';
import { OUTLINE_SYSTEM, GEMINI_OUTLINE_SCHEMA, OUTLINE_TOOL, sanitizeOutline, checkAssignment, outlinePrompt } from '../../src/lib/outline.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-expose-headers': 'x-cadence-remaining',
  'access-control-max-age': '86400'
};

// A JSON reply that is never cached.
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** The assistant's server. Checks the student's sign-in, checks the request
    (a conversation, or outline mode for one assignment), counts it against
    the day's limits (per account, per site, and a share for accounts without
    an email), then asks the model this site names in src/config.js.
    Anything refused or failed is given back from the day's count. */
export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Use POST.' });

  const keys = { groq: process.env.GROQ_API_KEY, gemini: process.env.GEMINI_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY };
  const picked = pickProvider(CONFIG.assistant, {
    keys, tier: process.env.GEMINI_TIER, retention: process.env.GROQ_RETENTION, emailToAssistant: CONFIG.emailToAssistant
  });
  const provider = picked.provider;
  // On Groq, email goes only to a production model: Groq's agreement treats
  // preview models as beta services outside its data processing terms.
  const email = picked.email && (provider !== 'groq' || GROQ_PRODUCTION_MODELS.includes(groqModel()));
  const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const anon = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!provider || !supabaseUrl || !anon) return json(503, { error: 'The assistant is not set up on this site yet.' });

  const auth = req.headers.get('authorization') || '';
  if (!/^Bearer\s+\S+/.test(auth)) return json(401, { error: 'Sign in to use the assistant.' });
  const identity = { apikey: anon, authorization: auth };

  let who;
  try {
    who = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: identity });
  } catch {
    return json(502, { error: 'Could not check your sign-in. Try again.' });
  }
  if (!who.ok) return json(401, { error: 'Your session ended. Sign in again.' });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'Send JSON.' }); }
  // Two kinds of request: the conversation (messages), or outline mode, which
  // sends one assignment and gets back an outline (src/lib/outline.js). The
  // mode is one of these two words; its instructions live here, not in the request.
  const outline = body?.mode === 'outline';
  if (body?.mode !== undefined && !outline) return json(400, { error: 'Unknown mode.' });
  const problem = outline ? checkAssignment(body.assignment) : checkMessages(body?.messages);
  if (problem) return json(400, { error: problem });
  // The model here is never offered read_email when email is not allowed, so
  // a conversation that read email cannot have come from this server. Refused
  // before it is counted, and before anything in it reaches a model.
  if (!outline && !email && usesEmail(body.messages)) return json(403, { error: 'Reading email is not available with this site\'s assistant. Start a new chat.' });

  // A question starts from something the student typed (or an outline asked
  // for). The requests that follow while the model uses tools end with tool
  // results instead.
  const last = outline ? null : body.messages[body.messages.length - 1];
  const isStep = !outline && last.role === 'user' && Array.isArray(last.content) && last.content.length > 0 && last.content.every((b) => b.type === 'tool_result');

  const limit = Math.max(1, Number(process.env.AGENT_DAILY_LIMIT) || 60);
  const siteLimit = Math.max(1, Number(process.env.AGENT_DAILY_TOTAL) || 1500);
  let row;
  try {
    const bump = await fetch(`${supabaseUrl}/rest/v1/rpc/bump_agent_usage`, {
      method: 'POST', headers: { ...identity, 'content-type': 'application/json' }, body: JSON.stringify({ is_step: isStep })
    });
    if (!bump.ok) return json(502, { error: 'Could not check your usage. Try again.' });
    const counted = await bump.json();
    row = Array.isArray(counted) ? counted[0] : counted;
  } catch {
    return json(502, { error: 'Could not check your usage. Try again.' });
  }
  const mine = Number(row?.mine), total = Number(row?.total);
  // No count, no request: a check that cannot be read is treated as failed.
  if (!Number.isFinite(mine) || !Number.isFinite(total)) return json(502, { error: 'Could not check your usage. Try again.' });
  // The lower of the database's limit for this kind of account and AGENT_DAILY_LIMIT.
  const cap = Math.min(limit, Number(row.cap) || limit);
  const remaining = Math.max(0, cap - mine);

  // Whatever the database counted is given back when the request goes no
  // further: refused here, or failed upstream (refund_agent_usage). A refused
  // request moving the day's totals would let throwaway accounts push the
  // total over for everyone.
  const refund = () => (row.ticket ? fetch(`${supabaseUrl}/rest/v1/rpc/refund_agent_usage`, {
    method: 'POST', headers: { ...identity, 'content-type': 'application/json' }, body: JSON.stringify({ ticket_id: row.ticket })
  }).catch(() => {}) : Promise.resolve());
  const refuse = async (body) => { await refund(); return json(429, body); };

  if (isStep) {
    // A question already under way may finish; steps beyond six for each
    // question asked today are refused (bump_agent_usage).
    if (row.steps_ok === false) return refuse({ error: 'That is the assistant\'s limit for today. Plain sentences still work.', limit: true });
  } else {
    if (mine > cap) return refuse({ error: `That is the assistant's limit for today${row.anon_account ? ' without an email account. Add an email for more' : ''}. It resets overnight, and plain sentences still work.`, limit: true });
    if (total > siteLimit) return refuse({ error: 'The assistant has reached its limit for today. Plain sentences still work.', limit: true });
    if (row.anon_account && Number(row.anon_total) > siteLimit * 0.3) return refuse({ error: 'The assistant is busy right now. Add an email to your account to keep using it, or try again later.' });
  }

  const res = outline
    ? (provider === 'groq' ? await outlineGroq(keys.groq, body.assignment)
      : provider === 'gemini' ? await outlineGemini(keys.gemini, body.assignment) : await outlineClaude(keys.anthropic, body.assignment))
    : provider === 'groq' ? await askGroq(keys.groq, body.messages, email)
      : provider === 'gemini' ? await askGemini(keys.gemini, body.messages, email) : await askClaude(keys.anthropic, body.messages, email);
  if (!res.ok) { await refund(); return res; }
  res.headers.set('x-cadence-remaining', String(remaining));
  return res;
};

// "Busy" is worth telling apart from "broken", so the client can say which.
// The upstream error body is never passed on: it can describe the account.
const failed = (status) => {
  const busy = [429, 503, 529].includes(status);
  return json(busy ? 429 : 502, { error: busy ? 'The assistant is busy. Try again in a moment.' : 'The assistant had a problem. Try again.' });
};

/** One turn of the conversation with Claude, with the site's model, instructions and tools. */
async function askClaude(key, messages, email) {
  let upstream;
  try {
    upstream = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': API_VERSION, 'anthropic-beta': BETAS },
      body: JSON.stringify(requestBody(messages, { email }))
    });
  } catch {
    return json(502, { error: 'The assistant could not be reached. Try again.' });
  }
  const text = await upstream.text();
  if (!upstream.ok) return failed(upstream.status);
  return new Response(text, { status: 200, headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

/** One turn of the conversation with Gemini, translated to and from the
    conversation's own shape (src/lib/gemini.js), giving up before Netlify's
    ten-second limit. */
async function askGemini(key, messages, email) {
  const wanted = String(process.env.GEMINI_MODEL || '').trim();
  const model = /^gemini-[a-z0-9.-]+$/.test(wanted) ? wanted : GEMINI_MODEL;
  // Netlify stops a free-plan function after 10 seconds and sends the browser
  // a page of HTML. Giving up just before that sends a reason instead.
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 9000);
  let upstream;
  try {
    // The key goes in a header, not the address, so it never appears in a log of URLs.
    upstream = await fetch(geminiUrl(model), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(geminiRequest(messages, model, { email })),
      signal: stop.signal
    });
  } catch {
    clearTimeout(timer);
    return stop.signal.aborted
      ? json(504, { error: 'The assistant took too long to answer.' })
      : json(502, { error: 'The assistant could not be reached. Try again.' });
  }
  clearTimeout(timer);
  if (!upstream.ok) return failed(upstream.status);
  const data = await upstream.json().catch(() => null);
  const reply = fromGemini(data);
  if (reply.stop_reason === 'error') return failed(502);
  return json(200, reply);
}

/** The Groq model: GROQ_MODEL when it looks like a model id, else the default in lib/groq.js. */
const groqModel = () => {
  const wanted = String(process.env.GROQ_MODEL || '').trim();
  return /^[a-z0-9][a-z0-9._/-]{0,100}$/i.test(wanted) ? wanted : GROQ_MODEL;
};

/**
 * One request to Groq, giving up before Netlify's ten-second limit. A reply
 * whose tool call the model wrote badly (Groq's "tool_use_failed") is asked
 * for once more while there is time. A request bigger than the plan's tokens
 * per minute (413) is refused by Groq every time, however long anyone waits:
 * on Groq's free plan that is every question (its cap is 8,000 tokens and a
 * question is more), so it is reported as unavailable, not busy.
 */
async function groqCall(key, body) {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 9000);
  const started = Date.now();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      let upstream;
      try {
        // The key goes in a header, never in the address, so it is never in a log of URLs.
        upstream = await fetch(GROQ_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal: stop.signal
        });
      } catch {
        return { error: stop.signal.aborted
          ? json(504, { error: 'The assistant took too long to answer.' })
          : json(502, { error: 'The assistant could not be reached. Try again.' }) };
      }
      if (upstream.ok) return { data: await upstream.json().catch(() => null) };
      const info = await upstream.json().catch(() => null);
      const code = String(info?.error?.code || ''), message = String(info?.error?.message || '');
      if (upstream.status === 400 && code === 'tool_use_failed' && attempt === 0 && Date.now() - started < 4500) continue;
      if (upstream.status === 413 || /request too large|reduce your message size/i.test(message)) {
        return { error: json(503, { error: 'The assistant cannot answer on this site right now.' }) };
      }
      return { error: failed(upstream.status) };
    }
    return { error: failed(502) };
  } finally {
    clearTimeout(timer);
  }
}

/** One turn of the conversation with Groq, translated both ways by lib/groq.js. */
async function askGroq(key, messages, email) {
  const { data, error } = await groqCall(key, groqRequest(messages, groqModel(), { email }));
  if (error) return error;
  const reply = fromGroq(data);
  if (reply.stop_reason === 'error') return failed(502);
  return json(200, reply);
}

// ------------------------------------------------------------ outline mode

/** The outline as Cadence sends it on: cut to size here, whatever the model wrote. */
const outlineReply = (raw) => {
  const out = sanitizeOutline(raw);
  return out ? json(200, { outline: out }) : failed(502);
};

/** An outline for one assignment from Gemini, cut to size and checked (src/lib/outline.js). */
async function outlineGemini(key, assignment) {
  const wanted = String(process.env.GEMINI_MODEL || '').trim();
  const model = /^gemini-[a-z0-9.-]+$/.test(wanted) ? wanted : GEMINI_MODEL;
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 9000);
  let upstream;
  try {
    upstream = await fetch(geminiUrl(model), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: OUTLINE_SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: outlinePrompt(assignment) }] }],
        generationConfig: {
          maxOutputTokens: 1500,
          responseMimeType: 'application/json',
          responseSchema: GEMINI_OUTLINE_SCHEMA,
          thinkingConfig: { thinkingLevel: thinkingFor(model) }
        }
      }),
      signal: stop.signal
    });
  } catch {
    clearTimeout(timer);
    return stop.signal.aborted ? json(504, { error: 'The assistant took too long to answer.' }) : json(502, { error: 'The assistant could not be reached. Try again.' });
  }
  clearTimeout(timer);
  if (!upstream.ok) return failed(upstream.status);
  const data = await upstream.json().catch(() => null);
  const text = (data?.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON: refused below */ }
  return outlineReply(parsed);
}

/** An outline for one assignment from Groq, cut to size and checked (src/lib/outline.js).
    The model is made to answer with the outline tool, and only that. */
async function outlineGroq(key, assignment) {
  const { data, error } = await groqCall(key, {
    model: groqModel(),
    messages: [
      { role: 'system', content: `${OUTLINE_SYSTEM}\n\nAlways answer by calling the outline tool, once.` },
      { role: 'user', content: outlinePrompt(assignment) }
    ],
    tools: [{ type: 'function', function: { name: OUTLINE_TOOL.name, description: OUTLINE_TOOL.description, parameters: OUTLINE_TOOL.input_schema } }],
    tool_choice: { type: 'function', function: { name: OUTLINE_TOOL.name } },
    parallel_tool_calls: false,
    temperature: 0.2,
    max_completion_tokens: 1500,
    ...reasoningFor(groqModel())
  });
  if (error) return error;
  const call = fromGroq(data).content.find((b) => b.type === 'tool_use' && b.name === OUTLINE_TOOL.name);
  return outlineReply(call?.input);
}

/** An outline for one assignment from Claude, cut to size and checked (src/lib/outline.js). */
async function outlineClaude(key, assignment) {
  // This model does not take a forced tool choice, so it is told to answer
  // with the tool and anything else comes back as no outline (refunded).
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 9000);
  let upstream;
  try {
    upstream = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': API_VERSION },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        system: `${OUTLINE_SYSTEM}\n\nAlways answer by calling the outline tool, once.`,
        tools: [OUTLINE_TOOL],
        tool_choice: { type: 'auto' },
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: outlinePrompt(assignment) }]
      }),
      signal: stop.signal
    });
  } catch {
    clearTimeout(timer);
    return stop.signal.aborted ? json(504, { error: 'The assistant took too long to answer.' }) : json(502, { error: 'The assistant could not be reached. Try again.' });
  }
  clearTimeout(timer);
  if (!upstream.ok) return failed(upstream.status);
  const data = await upstream.json().catch(() => null);
  const call = (data?.content || []).find((b) => b.type === 'tool_use' && b.name === OUTLINE_TOOL.name);
  return outlineReply(call?.input);
}

export const config = { path: '/api/agent' };
