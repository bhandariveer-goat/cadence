// POST /api/metric
//
// Anonymous usage data, sent by src/lib/metrics.js only when site.countUsage
// is true in src/config.js. Three kinds of request, each with its own shape:
//
//   {id, event}            one of five words for a random install ID
//                          (active, onboarded, has_work, checked_in,
//                          connected), or 'forget' to delete every row for
//                          that ID. Stored by record_usage(), one row per ID,
//                          day and word.
//   {id, session, events}  up to 50 records of how the app is used, for the
//                          same ID and a random ID for the visit (see
//                          src/panel/insight.js). Each record is a kind from a
//                          fixed list, a name made of code characters, the
//                          screen, a number and its order in the visit; this
//                          function rebuilds each one from those fields alone
//                          and drops any that does not fit. Stored by
//                          record_events().
//   {steps}                up to four of the sign-up screen's four step names,
//                          with no ID at all. Added to a count per day by
//                          count_steps().
//
// What is deliberately not kept, and not read here at all: the IP address,
// cookies, the user agent, the page address, any sign-in, and anything from
// the plan or from email. Times come from the database, not from the browser.
// Nothing is logged here.
//
// Anyone can send this request, so the numbers are estimates, not a meter.
// What stops abuse is the fixed shapes and names, and that the database caps
// how much one ID, and everyone together, can add in a day.
//
// Environment variables (Netlify > Project configuration > Environment
// variables), the same two the assistant uses:
//   SUPABASE_URL     required
//   SUPABASE_KEY     required: the project's publishable key (or, on an older
//                    project, its anon key). SUPABASE_ANON_KEY is read too.

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENTS = new Set(['active', 'onboarded', 'has_work', 'checked_in', 'connected']);
const KINDS = new Set(['screen', 'click', 'dead_click', 'rage_click', 'step', 'error', 'timing', 'session', 'milestone']);
const STEPS = new Set(['signin:shown', 'signin:started', 'signin:submitted', 'signin:done']);
const NAME = /^[a-z0-9][a-z0-9_.:-]{0,79}$/;
const BATCH = 50;
const LIMIT = 12000;   // characters: 50 records with room to spare; anything larger is not one of ours

// The Chrome extension sends from its own address, so this has to be readable
// from there; nothing it answers is private (an empty reply with a status).
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-max-age': '86400'
};
const done = (status) => new Response(null, { status, headers: { ...CORS, 'cache-control': 'no-store' } });

const whole = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;

/** One record of how the app is used, rebuilt from its allowed fields, or null if it does not fit. */
export function cleanRecord(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  if (!whole(r.q, 100000) || !KINDS.has(r.k) || typeof r.n !== 'string' || !NAME.test(r.n)) return null;
  const out = { q: r.q, k: r.k, n: r.n };
  if (r.s !== undefined) { if (typeof r.s !== 'string' || !NAME.test(r.s)) return null; out.s = r.s; }
  if (r.v !== undefined) { if (!whole(r.v, 2000000000)) return null; out.v = r.v; }
  return out;
}

/** Which database function a body goes to, with what, or null when it is not one of the three shapes. */
export function route(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (Array.isArray(body.steps)) {
    const steps = body.steps;
    if (Object.keys(body).length !== 1 || steps.length < 1 || steps.length > 4 || !steps.every((s) => STEPS.has(s))) return null;
    return { fn: 'count_steps', args: { p_names: steps } };
  }
  const id = body.id;
  if (typeof id !== 'string' || !ID.test(id)) return null;
  // Exactly the fields of one shape: anything extra is not one of ours.
  const keys = Object.keys(body).sort().join(',');
  if (Array.isArray(body.events)) {
    if (keys !== 'events,id,session' || typeof body.session !== 'string' || !ID.test(body.session) || body.events.length > BATCH) return null;
    const events = body.events.map(cleanRecord).filter(Boolean);
    return events.length ? { fn: 'record_events', args: { p_id: id, p_session: body.session, p_events: events } } : { fn: null };
  }
  const event = body.event;
  if (keys !== 'event,id') return null;
  if (event === 'forget') return { fn: 'forget_usage', args: { p_id: id } };
  if (typeof event === 'string' && EVENTS.has(event)) return { fn: 'record_usage', args: { p_id: id, p_event: event } };
  return null;
}

export default async (req) => {
  if (req.method === 'OPTIONS') return done(204);
  if (req.method !== 'POST') return done(405);

  // Only Cadence's own pages and the Cadence extension. Another site's page is
  // turned away. (A script can still send anything, which is why the numbers
  // are estimates.)
  const origin = req.headers.get('origin');
  if (origin) {
    let host = '', protocol = '';
    try { const u = new URL(origin); host = u.host; protocol = u.protocol; } catch { /* "null", or not an address */ }
    if (host !== new URL(req.url).host && protocol !== 'chrome-extension:') return done(403);
  }

  const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const anon = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anon) return done(503);
  // A publishable key goes in the apikey header and nowhere else. The older
  // anon key is a token, and the database expects to see it as one as well.
  const asToken = anon.startsWith('eyJ') ? { authorization: `Bearer ${anon}` } : {};

  let body;
  try {
    const text = await req.text();
    if (text.length > LIMIT) return done(413);
    body = JSON.parse(text);
  } catch { return done(400); }
  const to = route(body);
  if (!to) return done(400);
  // A batch in which nothing fitted: accepted, and nothing to store.
  if (!to.fn) return done(204);

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${to.fn}`, {
      method: 'POST',
      headers: { apikey: anon, ...asToken, 'content-type': 'application/json' },
      body: JSON.stringify(to.args)
    });
    if (!res.ok) return done(502);
  } catch { return done(502); }
  return done(204);
};

export const config = { path: '/api/metric' };
