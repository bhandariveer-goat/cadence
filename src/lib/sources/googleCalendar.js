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
    color: c.backgroundColor || null, selected: c.selected !== false
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

// ------------------------------------------------------- write (phase 2)

export async function insertBlock(token, calendarId, block) {
  return api(`/calendars/${encodeURIComponent(calendarId)}/events`, token, { method: 'POST', body: toGoogleEvent(block) });
}

export async function updateBlock(token, calendarId, googleId, block) {
  return api(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(googleId)}`, token, { method: 'PATCH', body: toGoogleEvent(block) });
}

export async function deleteBlock(token, calendarId, googleId) {
  return api(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(googleId)}`, token, { method: 'DELETE' });
}

/** Everything Cadence writes carries its tag, so cleanup never touches other events. */
export function toGoogleEvent(block) {
  return {
    summary: block.title,
    description: block.description || 'Scheduled by Cadence',
    start: { dateTime: new Date(block.start).toISOString() },
    end: { dateTime: new Date(block.end).toISOString() },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 5 }] },
    extendedProperties: { private: { [CADENCE_TAG.key]: CADENCE_TAG.value, cadenceId: block.id || '' } }
  };
}

/** Cadence-created events only — used to update or clean up after a re-plan. */
export async function listOwnBlocks(token, calendarId, { daysAhead = 30 } = {}) {
  const data = await api(`/calendars/${encodeURIComponent(calendarId)}/events`, token, {
    query: {
      timeMin: new Date().toISOString(),
      timeMax: new Date(Date.now() + daysAhead * 864e5).toISOString(),
      singleEvents: 'true', maxResults: 250,
      privateExtendedProperty: `${CADENCE_TAG.key}=${CADENCE_TAG.value}`
    }
  });
  return (data.items || []).map((ev) => ({ googleId: ev.id, cadenceId: ev.extendedProperties?.private?.cadenceId || '', start: ev.start?.dateTime, title: ev.summary }));
}
