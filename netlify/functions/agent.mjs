// POST /api/agent
//
// The assistant, for students who have not brought their own Anthropic key.
// The key lives in this function's environment and never reaches a browser.
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
//   ANTHROPIC_API_KEY     required
//   SUPABASE_URL          required, same value as src/config.js
//   SUPABASE_ANON_KEY     required, same value as src/config.js
//   AGENT_DAILY_LIMIT     optional, requests per account per day (default 60)
//   AGENT_DAILY_TOTAL     optional, requests across all accounts per day
//                         (default 1500); the ceiling on what a day can cost

import { API_URL, API_VERSION, BETAS, requestBody, checkMessages } from '../../src/lib/agentspec.js';

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

  const key = process.env.ANTHROPIC_API_KEY;
  const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!key || !supabaseUrl || !anon) return json(503, { error: 'The assistant is not set up on this site yet.' });

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

  let upstream;
  try {
    upstream = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': API_VERSION, 'anthropic-beta': BETAS },
      body: JSON.stringify(requestBody(body.messages))
    });
  } catch {
    return json(502, { error: 'The assistant could not be reached. Try again.' });
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    // Pass the status through so the client can tell "busy" from "broken",
    // but not the upstream error body, which can describe the account.
    const status = [429, 529].includes(upstream.status) ? 429 : 502;
    return json(status, { error: status === 429 ? 'The assistant is busy. Try again in a moment.' : 'The assistant had a problem. Try again.' });
  }
  return new Response(text, { status: 200, headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' } });
};

export const config = { path: '/api/agent' };
