// POST /api/canvas-feed   { "url": "https://school.instructure.com/feeds/calendars/user_….ics" }
//
// Browsers do not let a website read another site's files, so the website
// cannot fetch a student's Canvas calendar feed itself (the Chrome extension
// can, and does not use this for Canvas). This function fetches it and hands
// the calendar straight back. It keeps nothing: not the link, not the
// calendar. It also fetches the read-only calendar links of Google Calendar
// (the "secret address in iCal format"), Outlook (a published calendar's ICS
// link) and Apple iCloud (a public calendar's link), for the website and the
// extension alike.
//
// So that it is not an open relay for the internet, a request is accepted only
//   1. with a Supabase session that Supabase confirms (an email account, or the
//      hidden anonymous account a name-only student gets), and
//   2. for an https address whose path is a Canvas calendar feed
//      (/feeds/calendars/<name>.ics) on a named host, never a bare IP
//      address or localhost, or one of these exact calendar addresses:
//        Google   calendar.google.com/calendar/ical/<calendar>/private-<key>/basic.ics
//        Outlook  outlook.office365.com, outlook.office.com or outlook.live.com
//                 /owa/calendar/<id>/<key>[/cid-<id>]/calendar.ics (or reachcalendar.ics)
//        iCloud   p<n>-caldav.icloud.com or p<n>-calendars.icloud.com /published/<n>/<key>
//      Redirects are followed only to addresses that pass the same test.
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
const OUTLOOK_HOSTS = new Set(['outlook.office365.com', 'outlook.office.com', 'outlook.live.com']);

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
  const outlook = OUTLOOK_HOSTS.has(host) && /^\/owa\/calendar\/[A-Za-z0-9%._@+-]+\/[A-Za-z0-9%._+-]+(\/cid-[A-Za-z0-9]+)?\/(reach)?calendar\.ics$/.test(u.pathname);
  const icloud = /^p\d{1,3}-(caldav|calendars)\.icloud\.com$/.test(host) && /^\/published\/\d{1,2}\/[A-Za-z0-9_-]{16,}$/.test(u.pathname);
  if (!canvas && !googleCal && !outlook && !icloud) return null;
  return u.href;
}

/** Who a checked address belongs to, for messages. */
export function sourceName(address) {
  const host = new URL(address).hostname;
  if (host === 'calendar.google.com') return 'Google Calendar';
  if (OUTLOOK_HOSTS.has(host)) return 'Outlook';
  if (host.endsWith('.icloud.com')) return 'iCloud';
  return 'Canvas';
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
  if (!address) return json(400, { error: "That isn't a calendar link Cadence can use. A Canvas feed contains /feeds/calendars/; a Google one is the secret address in iCal format; an Outlook one is a published calendar's ICS link; an iCloud one is a public calendar's link." });

  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 8000);
  try {
    let res;
    for (let hops = 0; ; hops++) {
      res = await fetch(address, { redirect: 'manual', signal: stop.signal, headers: { accept: 'text/calendar' } });
      if (![301, 302, 303, 307, 308].includes(res.status)) break;
      const next = feedAddress(new URL(res.headers.get('location') || '', address).href);
      if (!next || hops >= 3) return json(502, { error: `${sourceName(address)} sent the calendar somewhere Cadence will not follow.` });
      address = next;
    }
    const from = sourceName(address);
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
