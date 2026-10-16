// POST /api/agent
//
// The assistant, for students who have not brought their own Anthropic key.
// It runs on Google's Gemini when GEMINI_API_KEY is set (lib/gemini.js
// translates the conversation both ways), and on Anthropic's Claude when only
// ANTHROPIC_API_KEY is. Either key lives in this function's environment and
// never reaches a browser.
//
// A request is accepted only when all of these hold:
//   1. it carries a Supabase session token that Supabase itself confirms;
//   2. that account, and the site as a whole, are under today's limits
//      (counted in Postgres by bump_agent_usage(), which an account cannot
//      reset and new accounts cannot get round; see schema.sql);
//   3. the body is a list of messages within the size limits.
// The model, the instructions and the tools are fixed here (lib/agentspec.js).
// A client sends messages and nothing else.
//
// Environment variables, set in Netlify > Project configuration > Environment
// variables (never in netlify.toml, which functions cannot read, and never in
// the repository):
//   GEMINI_API_KEY        the key from Google AI Studio. Used when set.
//   GEMINI_TIER           "free" or "paid": which Google plan the key is on.
//                         Must be set, so that using Gemini is a decision.
//                         On the free plan Google may use what students type
//                         to improve its products and people at Google may
//                         read it; the privacy page says so.
//   GEMINI_MODEL          optional, another Gemini model (default in lib/gemini.js)
//   ANTHROPIC_API_KEY     used instead when there is no GEMINI_API_KEY
//   SUPABASE_URL          required, same value as src/config.js
//   SUPABASE_KEY          required: the publishable key, same value as
//                         supabaseKey in src/config.js (SUPABASE_ANON_KEY is
//                         read too, for projects set up before the rename)
//   AGENT_DAILY_LIMIT     optional, requests per account per day (default 60)
//   AGENT_DAILY_TOTAL     optional, requests across all accounts per day
//                         (default 1500); the ceiling on what a day can cost

import { API_URL, API_VERSION, BETAS, requestBody, checkMessages } from '../../src/lib/agentspec.js';
import { GEMINI_MODEL, geminiUrl, geminiRequest, fromGemini } from '../../src/lib/gemini.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-max-age': '86400'
};

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' } });

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Use POST.' });

  const gemini = process.env.GEMINI_API_KEY;
  const anthropic = process.env.ANTHROPIC_API_KEY;
  const tier = String(process.env.GEMINI_TIER || '').trim().toLowerCase();
  const provider = gemini ? (tier === 'free' || tier === 'paid' ? 'gemini' : null) : anthropic ? 'anthropic' : null;
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
  const problem = checkMessages(body?.messages);
  if (problem) return json(400, { error: problem });

  const limit = Math.max(1, Number(process.env.AGENT_DAILY_LIMIT) || 60);
  const siteLimit = Math.max(1, Number(process.env.AGENT_DAILY_TOTAL) || 1500);
  let mine, total;
  try {
    const bump = await fetch(`${supabaseUrl}/rest/v1/rpc/bump_agent_usage`, {
      method: 'POST', headers: { ...identity, 'content-type': 'application/json' }, body: '{}'
    });
    if (!bump.ok) return json(502, { error: 'Could not check your usage. Try again.' });
    const counted = await bump.json();
    const row = Array.isArray(counted) ? counted[0] : counted;
    mine = Number(row?.mine);
    total = Number(row?.total);
  } catch {
    return json(502, { error: 'Could not check your usage. Try again.' });
  }
  // No count, no request: a check that cannot be read is treated as failed.
  if (!Number.isFinite(mine) || !Number.isFinite(total)) return json(502, { error: 'Could not check your usage. Try again.' });
  if (mine > limit) return json(429, { error: 'That is the assistant\'s limit for today. Plain sentences still work.' });
  if (total > siteLimit) return json(429, { error: 'The assistant has reached its limit for today. Plain sentences still work.' });

  return provider === 'gemini' ? askGemini(gemini, body.messages) : askClaude(anthropic, body.messages);
};

// "Busy" is worth telling apart from "broken", so the client can say which.
// The upstream error body is never passed on: it can describe the account.
const failed = (status) => {
  const busy = [429, 503, 529].includes(status);
  return json(busy ? 429 : 502, { error: busy ? 'The assistant is busy. Try again in a moment.' : 'The assistant had a problem. Try again.' });
};

async function askClaude(key, messages) {
  let upstream;
  try {
    upstream = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': API_VERSION, 'anthropic-beta': BETAS },
      body: JSON.stringify(requestBody(messages))
    });
  } catch {
    return json(502, { error: 'The assistant could not be reached. Try again.' });
  }
  const text = await upstream.text();
  if (!upstream.ok) return failed(upstream.status);
  return new Response(text, { status: 200, headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

async function askGemini(key, messages) {
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
      body: JSON.stringify(geminiRequest(messages, model)),
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

export const config = { path: '/api/agent' };
