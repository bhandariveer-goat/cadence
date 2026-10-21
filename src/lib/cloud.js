// Accounts and sync.
//
// Signing in is an email and the code Supabase sends to it (a one-time
// passcode), so there is no password to forget or leak. Where a project's
// email carries a link instead of a code, opening the link signs in too (see
// sessionFromLink). Once signed in, the plan is kept
// in one row that only its owner can read (see supabase/schema.sql), which is
// what lets the Chrome extension and the website show the same week: the
// extension can read Canvas, the website can't, and the row is how what one
// learns reaches the other.
//
// Raw fetch against Supabase's documented REST endpoints rather than their
// SDK: this project has no build step, and an extension can't load remote code.

import { DEFAULT_STATE } from './store.js';

const OFFLINE = 'Could not reach your account. Check your connection.';

// What Supabase's sign-in service says when it refuses, in words for the
// person at the screen. Keyed by its error_code; anything not listed is shown
// as the service worded it.
const AUTH_ERRORS = {
  over_email_send_rate_limit: 'Too many sign-in emails were asked for just now. Wait a few minutes, then try again.',
  over_request_rate_limit: 'Too many tries in a row. Wait a minute, then try again.',
  email_address_not_authorized: 'This copy of Cadence cannot send email to that address yet. Whoever runs it has to finish setting up its email. Until then, start with just a name below.',
  email_address_invalid: 'That email address was not accepted. Check it for a typo.',
  otp_expired: 'That code is wrong or has run out. Check it, or send a new one.',
  otp_disabled: 'Email sign-in is switched off for this copy of Cadence.',
  signup_disabled: 'New accounts are switched off for this copy of Cadence.',
  email_provider_disabled: 'Email sign-in is switched off for this copy of Cadence.'
};
// A sign-in error in plain words: ours for the codes we know, else what the server said.
const authMessage = (data, status) => AUTH_ERRORS[data.error_code]
  || (status === 429 ? AUTH_ERRORS.over_request_rate_limit : '')
  || data.msg || data.error_description || data.message || `Sign-in failed (${status})`;

/**
 * What a sign-in link leaves in the address when it is opened: either a
 * session, or the reason there is none. Returns null when the address holds
 * neither, which is every ordinary visit.
 */
export function sessionFromLink(hash) {
  const q = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  if (q.get('access_token') && q.get('refresh_token')) {
    return { access_token: q.get('access_token'), refresh_token: q.get('refresh_token'), expires_in: Number(q.get('expires_in')) || 3600 };
  }
  if (q.get('error') || q.get('error_code')) {
    // A link can be used once and lasts an hour; either way the fix is the same.
    return { error: 'That sign-in link has run out or was already used. Ask for a new email.' };
  }
  return null;
}

/** The account's copy is not the version this device last saw. */
export class PlanChanged extends Error {
  constructor() { super('Your plan was changed somewhere else.'); this.changed = true; }
}

/** The connection to the account (Supabase): signing in with an emailed code,
    keeping the session fresh, and reading and writing the saved plan.
    `onSession` is told whenever the session changes, so it can be kept. */
export function createCloud({ url, anonKey, session = null, onSession = () => {} }) {
  const base = String(url || '').replace(/\/+$/, '');
  let current = session;

  const headers = (auth = true) => ({
    apikey: anonKey,
    'content-type': 'application/json',
    ...(auth && current?.access_token ? { authorization: `Bearer ${current.access_token}` } : {})
  });

  /** A call to the sign-in service, with errors in plain words and a clear one when offline. */
  async function authCall(path, body) {
    let res;
    try { res = await fetch(`${base}/auth/v1/${path}`, { method: 'POST', headers: headers(false), body: JSON.stringify(body) }); }
    catch { throw Object.assign(new Error(OFFLINE), { offline: true }); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(authMessage(data, res.status)), { status: res.status, code: data.error_code || '' });
    return data;
  }

  /** Keeps a new session (and passes it to onSession). */
  function keep(data) {
    current = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000,
      user: data.user ? { id: data.user.id, email: data.user.email } : current?.user
    };
    onSession(current);
    return current;
  }

  /** A token that is good for at least another minute, refreshing if needed. */
  let refreshing = null;
  /** Makes sure the session is good for at least another minute, renewing it if not. */
  async function fresh() {
    if (!current) throw new Error('Sign in first');
    if (Date.now() > (current.expires_at || 0) - 60000) {
      // One refresh at a time: a refresh token can be used once, so two calls
      // racing to use it would sign the second one out.
      refreshing ||= authCall('token?grant_type=refresh_token', { refresh_token: current.refresh_token })
        .then(keep)
        .finally(() => { refreshing = null; });
      try {
        await refreshing;
      } catch (e) {
        // Only the service saying "this token is no good" ends the session.
        // Being offline, or the service having a bad minute, does not: the
        // session is kept and the next attempt tries again.
        if (e.status >= 400 && e.status < 500 && e.status !== 429) {
          current = null;
          onSession(null);
          throw new Error('Your session ended. Sign in again.');
        }
        throw Object.assign(new Error(OFFLINE), { offline: true });
      }
    }
    if (!current) throw new Error('Sign in first');
    return current.access_token;
  }

  /** A database call as the signed-in student. */
  async function rest(path, { method = 'GET', body, prefer } = {}) {
    await fresh();
    let res;
    try {
      res = await fetch(`${base}/rest/v1/${path}`, {
        method,
        headers: { ...headers(), ...(prefer ? { prefer } : {}) },
        body: body == null ? undefined : JSON.stringify(body)
      });
    } catch { throw Object.assign(new Error(OFFLINE), { offline: true }); }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) throw new Error(data?.message || `Sync failed (${res.status})`);
    return data;
  }

  return {
    get signedIn() { return !!current; },
    get session() { return current; },
    user: () => (current?.user ? { id: current.user.id, email: current.user.email } : null),
    token: fresh,
    rest,

    /**
     * Step one: email a code. `returnTo` is where a sign-in link should come
     * back to, for projects whose email carries a link; it has to be on the
     * project's list of allowed addresses or Supabase uses its own default.
     */
    sendCode: (email, returnTo = '') => authCall(`otp${returnTo ? `?redirect_to=${encodeURIComponent(returnTo)}` : ''}`, { email, create_user: true })
      .then(() => ({ sent: true })),

    /** Step two: trade the code for a session. */
    async verify(email, code, name) {
      keep(await authCall('verify', { type: 'email', email, token: String(code).trim() }));
      if (name) {
        // The profile row is what partners and clubs see; failing to write it
        // shouldn't undo a successful sign-in.
        try { await rest('profiles', { method: 'POST', body: { id: current.user.id, name }, prefer: 'resolution=merge-duplicates' }); } catch { /* retried on next save */ }
      }
      return current;
    },

    /**
     * The other way in: a session handed over by a sign-in link. The link
     * says nothing about whose it is, so the account is asked before the
     * session is kept; a token that Supabase does not vouch for is dropped.
     */
    async adoptLink(link, { onlyFor = null } = {}) {
      let res;
      try { res = await fetch(`${base}/auth/v1/user`, { headers: { apikey: anonKey, authorization: `Bearer ${link.access_token}` } }); }
      catch { throw Object.assign(new Error(OFFLINE), { offline: true }); }
      const user = await res.json().catch(() => ({}));
      if (!res.ok || !user.id) throw new Error('That sign-in link did not work. Ask for a new email.');
      // A link for one account must not quietly take over a browser that is
      // signed in to another: the plan on screen would be saved over theirs.
      if (onlyFor && user.id !== onlyFor) throw new Error('This browser is signed in to a different account. Sign out here first, then open the link again.');
      return keep({ ...link, user });
    },

    /** The name partners and clubs see. */
    setName: (name) => rest('profiles', { method: 'POST', body: { id: current.user.id, name }, prefer: 'resolution=merge-duplicates' }),

    async signOut() {
      const token = current?.access_token;
      current = null;
      onSession(null);
      if (token) {
        // scope=local: signing out here leaves the person's other devices signed in.
        try { await fetch(`${base}/auth/v1/logout?scope=local`, { method: 'POST', headers: { apikey: anonKey, authorization: `Bearer ${token}` } }); } catch { /* already signed out locally */ }
      }
    },

    /** The saved plan for this account, or null when there isn't one yet. */
    async pull() {
      if (!current) throw new Error('Sign in first');
      const rows = await rest(`planner_state?select=data,updated_at&user_id=eq.${current.user.id}`);
      const row = Array.isArray(rows) ? rows[0] : null;
      return row ? { data: row.data, editedAt: row.updated_at } : null;
    },

    /** When the account's copy was last saved, without downloading it. */
    async head() {
      if (!current) throw new Error('Sign in first');
      const rows = await rest(`planner_state?select=updated_at&user_id=eq.${current.user.id}`);
      return Array.isArray(rows) && rows[0] ? rows[0].updated_at : null;
    },

    /**
     * Save the plan, but only over the version this device last saw.
     *
     * `expect` is that version's timestamp, or null when the account had no
     * plan. The check and the write are one statement on the server, so two
     * devices saving at the same moment cannot both win; the loser gets
     * PlanChanged and has to look at what is there before trying again.
     * `force` skips the check, for when the person has chosen this plan.
     */
    async push(state, { expect = null, force = false } = {}) {
      if (!current) throw new Error('Sign in first');
      const id = current.user.id;
      const at = new Date(state.editedAt || Date.now()).toISOString();
      const data = portable(state);
      if (force) {
        await rest('planner_state', { method: 'POST', body: { user_id: id, data, updated_at: at }, prefer: 'resolution=merge-duplicates,return=minimal' });
        return at;
      }
      const rows = expect
        ? await rest(`planner_state?user_id=eq.${id}&updated_at=eq.${encodeURIComponent(new Date(expect).toISOString())}&select=updated_at`,
          { method: 'PATCH', body: { data, updated_at: at }, prefer: 'return=representation' })
        : await rest('planner_state?select=updated_at',
          { method: 'POST', body: { user_id: id, data, updated_at: at }, prefer: 'resolution=ignore-duplicates,return=representation' });
      if (!Array.isArray(rows) || !rows.length) throw new PlanChanged();
      return at;
    }
  };
}

/**
 * A hidden anonymous account for someone using Cadence with only a name, so
 * the assistant's server function (netlify/functions/agent.mjs) can count
 * their requests. It has a random id and nothing else: the database refuses it
 * everything but being counted (supabase/schema.sql). It is kept in this
 * browser only, apart from the plan, and is never used for sync.
 * @returns {() => Promise<string>} a function that gives a current access token
 */
export function anonymousToken({ url, key, storage = globalThis.localStorage }) {
  const base = String(url || '').replace(/\/+$/, '');
  const SLOT = 'cadence.assistant-session';
  const read = () => { try { return JSON.parse(storage?.getItem(SLOT) || 'null'); } catch { return null; } };
  const write = (s) => { try { storage?.setItem(SLOT, JSON.stringify(s)); } catch { /* private window: kept for this page only */ } };
  let held = null;
  const keep = (data) => {
    if (!data?.access_token || !data?.refresh_token) throw new Error('No session came back');
    held = { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
    write(held);
    return held.access_token;
  };
  const post = async (path, body) => {
    const res = await fetch(`${base}/auth/v1/${path}`, { method: 'POST', headers: { apikey: key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.msg || data?.error_description || `The assistant could not start (${res.status})`);
    return data;
  };
  let pending = null;
  return () => (pending ||= (async () => {
    const s = held || read();
    if (s?.access_token && s.expires_at - 60000 > Date.now()) return s.access_token;
    if (s?.refresh_token) {
      try { return keep(await post('token?grant_type=refresh_token', { refresh_token: s.refresh_token })); } catch { /* removed or expired: start a new one */ }
    }
    return keep(await post('signup', { data: {} }));
  })().finally(() => { pending = null; }));
}

/**
 * The part of a plan that should follow someone between devices.
 *
 * Left behind on purpose: the session itself, anything that is a credential
 * or a link that works like one (the assistant key, Google's access token, the
 * Canvas feed link), everything fetched from a connected calendar, and the
 * computed plan, which is rebuilt on load anyway. Connections to other
 * services are made per device and stay on that device; the privacy policy
 * says so, and this function is what makes it true.
 */
export function portable(state) {
  const out = structuredClone(state);
  delete out.cloud;
  delete out.plan;
  delete out.ranked;
  delete out.sync;
  out.sources = structuredClone(DEFAULT_STATE.sources);
  if (out.settings) { delete out.settings.apiKey; out.settings.useAI = false; }
  for (const t of Object.values(out.tasks || {})) { delete t.guideData; delete t.pushToGoogle; }
  for (const c of out.commitments || []) delete c.pushToGoogle;
  return out;
}

/** Lay a plan from the cloud over this device, keeping what belongs to the device. */
export function adopt(local, remote) {
  const next = structuredClone(remote);
  next.cloud = local.cloud;
  next.sources = structuredClone(local.sources || DEFAULT_STATE.sources);
  next.settings = { ...remote.settings, apiKey: local.settings?.apiKey || '', useAI: !!local.settings?.useAI && !!local.settings?.apiKey };
  // A tour already seen on this device is not shown again because the account's copy was older.
  if (local.tourSeen === true) next.tourSeen = true;
  return next;
}

/** Does this plan hold anything a person made, as opposed to an empty start? */
export function hasSubstance(state) {
  return Object.keys(state.tasks || {}).length > 0
    || (state.commitments || []).length > 0
    || (state.busy || []).length > 0
    || (state.checkins || []).length > 0;
}
