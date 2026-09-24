// Google Calendar (read now, write in phase 2).
//
// Auth uses chrome.identity.launchWebAuthFlow with a *Web application* OAuth
// client, rather than getAuthToken, for two reasons: it works with an unpacked
// extension without pinning the extension id, and the same implicit flow can
// later serve the hosted web app. Tokens are short-lived (about an hour) and
// there is no refresh token in this flow, so renewal is a silent re-auth
// (prompt=none) that falls back to an interactive prompt.
//
// Nothing here writes to the user's calendar yet; write support is gated behind
// a separate scope and an explicit opt-in.

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const API = 'https://www.googleapis.com/calendar/v3';
const TOKENINFO = 'https://oauth2.googleapis.com/tokeninfo';

export const SCOPES = {
  read: 'https://www.googleapis.com/auth/calendar.readonly',
  write: 'https://www.googleapis.com/auth/calendar.events'
};

/** Cadence tags everything it creates, so resync only ever touches its own events. */
export const CADENCE_TAG = { key: 'cadenceBlock', value: 'v1' };

export const available = () => typeof chrome !== 'undefined' && !!chrome.identity?.launchWebAuthFlow;

export const redirectUri = () => (typeof chrome !== 'undefined' && chrome.identity?.getRedirectURL
  ? chrome.identity.getRedirectURL('google')
  : `${location.origin}/oauth.html`);

function parseFragment(url) {
  const frag = String(url || '').split('#')[1] || '';
  const p = new URLSearchParams(frag);
  return { accessToken: p.get('access_token'), expiresIn: Number(p.get('expires_in') || 0), error: p.get('error'), scope: p.get('scope') || '' };
}

/**
 * Ask Google for an access token.
 * @param {string} clientId  OAuth client id from Google Cloud Console
 * @param {object} opts      scopes[], interactive, loginHint
 * @returns {{accessToken, expiresAt, scopes}}
 */
export async function authorize(clientId, { scopes = [SCOPES.read], interactive = true, loginHint = '' } = {}) {
  if (!available()) throw new Error('Google sign-in needs the Cadence Chrome extension');
  if (!clientId) throw new Error('No Google client ID configured yet');

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'token',
    redirect_uri: redirectUri(),
    scope: scopes.join(' '),
    include_granted_scopes: 'true',
    prompt: interactive ? 'consent' : 'none'
  });
  if (loginHint) params.set('login_hint', loginHint);

  const responseUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: `${AUTH}?${params}`, interactive }, (r) => {
      const err = chrome.runtime.lastError;
      if (err || !r) reject(new Error(err?.message || 'Google sign-in was cancelled'));
      else resolve(r);
    });
  });

  const { accessToken, expiresIn, error, scope } = parseFragment(responseUrl);
  if (error || !accessToken) throw new Error(error === 'interaction_required' ? 'Google sign-in expired' : error || 'Google did not return a token');
  return { accessToken, expiresAt: Date.now() + (expiresIn || 3600) * 1000 - 60000, scopes: scope ? scope.split(' ') : scopes };
}

/** A valid token, renewed silently when possible. `save` persists the new one. */
export async function freshToken(cfg, { save = () => {}, scopes } = {}) {
  const want = scopes || cfg.scopes || [SCOPES.read];
  if (cfg.accessToken && Date.now() < (cfg.expiresAt || 0) && want.every((s) => (cfg.scopes || []).includes(s))) return cfg.accessToken;
  try {
    const t = await authorize(cfg.clientId, { scopes: want, interactive: false, loginHint: cfg.email });
    save(t);
    return t.accessToken;
  } catch {
    const t = await authorize(cfg.clientId, { scopes: want, interactive: true, loginHint: cfg.email });
    save(t);
    return t.accessToken;
  }
}

async function api(path, token, { method = 'GET', body, query } = {}) {
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) { const e = new Error('Google session expired'); e.code = 401; throw e; }
  if (res.status === 403) { const e = new Error('Google denied that request — check the scopes you granted'); e.code = 403; throw e; }
  if (!res.ok && res.status !== 204) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error?.message || `Google Calendar error ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

export async function whoAmI(token) {
  const info = await fetch(`${TOKENINFO}?access_token=${encodeURIComponent(token)}`).then((r) => r.json()).catch(() => ({}));
  return { email: info.email || '', scopes: (info.scope || '').split(' ').filter(Boolean) };
}

export async function listCalendars(token) {
  const data = await api('/users/me/calendarList', token, { query: { maxResults: 50, minAccessRole: 'reader' } });
  return (data.items || []).map((c) => ({
    id: c.id, name: c.summaryOverride || c.summary, primary: !!c.primary,
    color: c.backgroundColor || null, selected: c.selected !== false,
    canWrite: ['owner', 'writer'].includes(c.accessRole)
  }));
}

/** An event that shouldn't block homework time: declined, or marked "free". */
function isBusy(ev) {
  if (ev.transparency === 'transparent') return false;
  const me = (ev.attendees || []).find((a) => a.self);
  if (me?.responseStatus === 'declined') return false;
  if (ev.eventType === 'workingLocation' || ev.eventType === 'focusTime') return ev.eventType === 'focusTime';
  return true;
}

function normalize(ev, calendar) {
  const allDay = !!ev.start?.date;
  const start = allDay ? new Date(`${ev.start.date}T00:00:00`) : new Date(ev.start.dateTime);
  const end = allDay ? new Date(`${ev.end.date}T00:00:00`) : new Date(ev.end.dateTime);
  return {
    id: `gcal_${calendar.id}_${ev.id}`,
    title: ev.summary || '(no title)',
    start: start.toISOString(),
    end: end.toISOString(),
    allDay,
    source: 'google',
    calendarId: calendar.id,
    calendarName: calendar.name,
    color: calendar.color,
    url: ev.htmlLink || null,
    location: ev.location || '',
    mine: ev.extendedProperties?.private?.[CADENCE_TAG.key] === CADENCE_TAG.value,
    busy: isBusy(ev)
  };
}

/**
 * Events across the chosen calendars, expanded (recurring events become
 * instances) and normalized to Cadence's busy shape.
 */
export async function fetchEvents(token, { calendarIds = ['primary'], daysBack = 1, daysAhead = 30 } = {}) {
  const timeMin = new Date(Date.now() - daysBack * 864e5).toISOString();
  const timeMax = new Date(Date.now() + daysAhead * 864e5).toISOString();
  const out = [];
  const errors = [];

  for (const id of calendarIds) {
    try {
      let pageToken;
      const calendar = { id, name: id === 'primary' ? 'Calendar' : id, color: null };
      do {
        const data = await api(`/calendars/${encodeURIComponent(id)}/events`, token, {
          query: { timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: 250, showDeleted: 'false', pageToken }
        });
        for (const ev of data.items || []) {
          if (ev.status === 'cancelled') continue;
          out.push(normalize(ev, { ...calendar, name: data.summary || calendar.name }));
        }
        pageToken = data.nextPageToken;
      } while (pageToken);
    } catch (e) {
      if (e.code === 401) throw e;           // token problem: let the caller re-auth
      errors.push(`${id}: ${e.message}`);
    }
  }
  return { events: out, errors };
}

// ------------------------------------------------------------------ write
//
// Cadence only ever touches events it created. Every write carries a private
// extended property (cadenceBlock=v1) plus a stable key, so a resync can match
// what it wrote last time even though re-planning gives blocks new ids.

export async function insertBlock(token, calendarId, block) {
  return api(`/calendars/${encodeURIComponent(calendarId)}/events`, token, { method: 'POST', body: toGoogleEvent(block) });
}

export async function updateBlock(token, calendarId, googleId, block) {
  return api(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(googleId)}`, token, { method: 'PATCH', body: toGoogleEvent(block) });
}

export async function deleteBlock(token, calendarId, googleId) {
  return api(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(googleId)}`, token, { method: 'DELETE' });
}

export function toGoogleEvent(block) {
  return {
    summary: block.title,
    description: block.description || 'Scheduled by Cadence',
    start: { dateTime: new Date(block.start).toISOString() },
    end: { dateTime: new Date(block.end).toISOString() },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 5 }] },
    extendedProperties: {
      private: { [CADENCE_TAG.key]: CADENCE_TAG.value, cadenceKey: block.key || '', cadenceItem: block.itemId || '' }
    }
  };
}

/** Only events Cadence wrote, found by its private tag. */
export async function listOwnBlocks(token, calendarId, { daysAhead = 21, daysBack = 1 } = {}) {
  const out = [];
  let pageToken;
  do {
    const data = await api(`/calendars/${encodeURIComponent(calendarId)}/events`, token, {
      query: {
        timeMin: new Date(Date.now() - daysBack * 864e5).toISOString(),
        timeMax: new Date(Date.now() + daysAhead * 864e5).toISOString(),
        singleEvents: 'true', maxResults: 250, pageToken,
        privateExtendedProperty: `${CADENCE_TAG.key}=${CADENCE_TAG.value}`
      }
    });
    for (const ev of data.items || []) {
      if (ev.status === 'cancelled') continue;
      out.push({
        googleId: ev.id,
        key: ev.extendedProperties?.private?.cadenceKey || '',
        itemId: ev.extendedProperties?.private?.cadenceItem || '',
        title: ev.summary || '',
        start: ev.start?.dateTime || ev.start?.date || null,
        end: ev.end?.dateTime || ev.end?.date || null
      });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

const sameTime = (a, b) => Math.abs(+new Date(a) - +new Date(b)) < 60000;

/**
 * Make the calendar match `desired`: add what's missing, move what shifted,
 * remove what Cadence no longer plans. Untagged events are never read or
 * touched here — the query itself only returns Cadence's own.
 * @param {{key, itemId, title, start, end, description}[]} desired
 */
export async function reconcileBlocks(token, calendarId, desired, { daysAhead = 21 } = {}) {
  const existing = await listOwnBlocks(token, calendarId, { daysAhead });
  const byKey = new Map();
  const orphans = [];
  for (const e of existing) (e.key && !byKey.has(e.key) ? byKey.set(e.key, e) : orphans.push(e));

  const wanted = new Map(desired.map((b) => [b.key, b]));
  const result = { created: 0, updated: 0, deleted: 0, map: {}, errors: [] };

  for (const [key, block] of wanted) {
    const prev = byKey.get(key);
    try {
      if (!prev) {
        const ev = await insertBlock(token, calendarId, block);
        result.created++;
        result.map[key] = ev.id;
      } else {
        result.map[key] = prev.googleId;
        if (!sameTime(prev.start, block.start) || !sameTime(prev.end, block.end) || prev.title !== block.title) {
          await updateBlock(token, calendarId, prev.googleId, block);
          result.updated++;
        }
      }
    } catch (e) {
      if (e.code === 401) throw e;
      result.errors.push(`${block.title}: ${e.message}`);
    }
  }

  for (const e of [...byKey.values(), ...orphans]) {
    if (wanted.has(e.key)) continue;
    try { await deleteBlock(token, calendarId, e.googleId); result.deleted++; } catch { /* already gone */ }
  }
  return result;
}

/** Take every Cadence event back off the calendar, leaving everything else alone. */
export async function removeAllBlocks(token, calendarId, { daysAhead = 400 } = {}) {
  const mine = await listOwnBlocks(token, calendarId, { daysAhead, daysBack: 400 });
  let removed = 0;
  for (const e of mine) {
    try { await deleteBlock(token, calendarId, e.googleId); removed++; } catch { /* already gone */ }
  }
  return removed;
}
