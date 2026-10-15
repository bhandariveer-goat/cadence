// POST /api/visit
//
// Counts a visit that arrived from a labelled link (utm_source, utm_medium,
// utm_campaign). It is only ever called when site.countVisits is true in
// src/config.js, which it is not by default; see site.js for the caller.
//
// What is kept is one row per label per day with a number in it (see
// count_visit() in supabase/schema.sql). What is deliberately not kept, and
// not read here at all: the IP address, cookies, the user agent, the page
// address, and any sign-in. There is nothing in a row that points at a person.
//
// Anyone can send this request, so the count is an estimate, not a meter.
// What stops it being abused is that it can only ever add one to a short
// label made of a-z, 0-9, _ and -, and the database caps how many different
// labels a day can have.
//
// Environment variables (Netlify > Project configuration > Environment
// variables), the same two the assistant uses:
//   SUPABASE_URL     required
//   SUPABASE_KEY     required: the project's publishable key (or, on an older
//                    project, its anon key). SUPABASE_ANON_KEY is read too.

const LABEL = /^[a-z0-9_-]{0,40}$/;
const done = (status) => new Response(null, { status, headers: { 'cache-control': 'no-store' } });

export default async (req) => {
  if (req.method !== 'POST') return done(405);

  // Same site only. A browser says where a request came from; a page on
  // another site is turned away, and gets no CORS headers to read a reply.
  const origin = req.headers.get('origin');
  if (origin) {
    let host = '';
    try { host = new URL(origin).host; } catch { /* "null", or not an address */ }
    if (host !== new URL(req.url).host) return done(403);
  }
  const fetchSite = req.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin') return done(403);

  const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const anon = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anon) return done(503);
  // A publishable key goes in the apikey header and nowhere else. The older
  // anon key is a token, and the database expects to see it as one as well.
  const asToken = anon.startsWith('eyJ') ? { authorization: `Bearer ${anon}` } : {};

  // The body is three short labels. Anything larger is not one of ours.
  let body;
  try {
    const text = await req.text();
    if (text.length > 400) return done(413);
    body = JSON.parse(text);
  } catch { return done(400); }
  // A label that is left out is empty; one that is there has to be text.
  const pick = (k) => (body?.[k] == null ? '' : body[k]);
  const source = pick('source'), medium = pick('medium'), campaign = pick('campaign');
  if (![source, medium, campaign].every((v) => typeof v === 'string' && LABEL.test(v))) return done(400);
  if (!source && !medium && !campaign) return done(400);

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/count_visit`, {
      method: 'POST',
      headers: { apikey: anon, ...asToken, 'content-type': 'application/json' },
      body: JSON.stringify({ p_source: source, p_medium: medium, p_campaign: campaign })
    });
    if (!res.ok) return done(502);
  } catch { return done(502); }
  return done(204);
};

export const config = { path: '/api/visit' };
