// POST /api/canvas-feed   { "url": "https://school.instructure.com/feeds/calendars/user_….ics" }
//
// Browsers do not let a website read another site's files, so the website
// cannot fetch a student's Canvas calendar feed itself (the Chrome extension
// can, and does not use this for Canvas). This function fetches it and hands
// the calendar straight back. It keeps nothing: not the link, not the
// calendar. It also fetches a Google Calendar "secret address in iCal
// format", for the website and the extension alike.
//
// So that it is not an open relay for the internet, a request is accepted only
//   1. with a Supabase session that Supabase confirms (an email account, or the
//      hidden anonymous account a name-only student gets), and
//   2. for an https address whose path is a Canvas calendar feed
//      (/feeds/calendars/<name>.ics) on a named host, never a bare IP
//      address or localhost, or a Google Calendar iCal address
//      (calendar.google.com/calendar/ical/<calendar>/private-<key>/basic.ics). Redirects are followed only to addresses that
//      pass the same test.
// What comes back must be a calendar, and at most 5 MB.
//
// Environment variables (Netlify > Project configuration > Environment
// variables): SUPABASE_URL and SUPABASE_KEY, the same two the assistant uses.

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-max-age': '86400'
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' } });
const MAX_BYTES = 5 * 1024 * 1024;

/** The feed address, cleaned up, or null when it is not one this will fetch. */
export function feedAddress(raw) {
  let u;
  try { u = new URL(String(raw || '').trim().replace(/^webcal:/i, 'https:')); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (/^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) return null;   // no bare IP addresses
  const canvas = /^\/feeds\/calendars\/[A-Za-z0-9_.-]+\.ics$/.test(u.pathname);
  const googleCal = host === 'calendar.google.com' && /^\/calendar\/ical\/[A-Za-z0-9%._@+-]+\/(private-[a-z0-9]+|public)\/basic\.ics$/.test(u.pathname);
  if (!canvas && !googleCal) return null;
  return u.href;
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Use POST.' });

  const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !key) return json(503, { error: 'Canvas syncing is not set up on this site yet.' });

  const auth = req.headers.get('authorization') || '';
  if (!/^Bearer\s+\S+/.test(auth)) return json(401, { error: 'Open Cadence again to sync Canvas.' });
  try {
    const who = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: key, authorization: auth } });
    if (!who.ok) return json(401, { error: 'Open Cadence again to sync Canvas.' });
  } catch {
    return json(502, { error: 'Could not reach Canvas syncing. Try again.' });
  }

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'Send JSON.' }); }
  let address = feedAddress(body?.url);
  if (!address) return json(400, { error: "That isn't a calendar link Cadence can use. A Canvas feed contains /feeds/calendars/; a Google one is the secret address in iCal format and ends in basic.ics." });

  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 8000);
  try {
    let res;
    for (let hops = 0; ; hops++) {
      res = await fetch(address, { redirect: 'manual', signal: stop.signal, headers: { accept: 'text/calendar' } });
      if (![301, 302, 303, 307, 308].includes(res.status)) break;
      const next = feedAddress(new URL(res.headers.get('location') || '', address).href);
      if (!next || hops >= 3) return json(502, { error: 'Canvas sent the feed somewhere Cadence will not follow.' });
      address = next;
    }
    const from = new URL(address).hostname === 'calendar.google.com' ? 'Google Calendar' : 'Canvas';
    if (res.status === 404 || res.status === 401 || res.status === 403) return json(404, { error: `${from} did not recognise that link. Copy it again from ${from}.` });
    if (!res.ok) return json(502, { error: `${from} answered ${res.status}. Try again later.` });
    if (Number(res.headers.get('content-length') || 0) > MAX_BYTES) return json(502, { error: 'That calendar is too large to sync.' });
    const text = await res.text();
    if (text.length > MAX_BYTES) return json(502, { error: 'That calendar is too large to sync.' });
    if (!text.includes('BEGIN:VCALENDAR')) return json(502, { error: "That link didn't return a calendar." });
    return new Response(text, { status: 200, headers: { ...CORS, 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-store' } });
  } catch {
    return stop.signal.aborted ? json(504, { error: 'The calendar took too long to answer. Try again.' }) : json(502, { error: 'Could not reach the calendar. Try again.' });
  } finally {
    clearTimeout(timer);
  }
};

export const config = { path: '/api/canvas-feed' };
