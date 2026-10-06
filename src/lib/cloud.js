// Accounts and sync.
//
// Signing in is an email and a six-digit code (Supabase's one-time passcode),
// so there is no password to forget or leak. Once signed in, the plan is kept
// in one row that only its owner can read (see supabase/schema.sql), which is
// what lets the Chrome extension and the website show the same week: the
// extension can read Canvas, the website can't, and the row is how what one
// learns reaches the other.
//
// Raw fetch against Supabase's documented REST endpoints rather than their
// SDK: this project has no build step, and an extension can't load remote code.

import { DEFAULT_STATE } from './store.js';

const OFFLINE = 'Could not reach your account. Check your connection.';

/** The account's copy is not the version this device last saw. */
export class PlanChanged extends Error {
  constructor() { super('Your plan was changed somewhere else.'); this.changed = true; }
}

export function createCloud({ url, anonKey, session = null, onSession = () => {} }) {
  const base = String(url || '').replace(/\/+$/, '');
  let current = session;

  const headers = (auth = true) => ({
    apikey: anonKey,
    'content-type': 'application/json',
    ...(auth && current?.access_token ? { authorization: `Bearer ${current.access_token}` } : {})
  });

  async function authCall(path, body) {
    let res;
    try { res = await fetch(`${base}/auth/v1/${path}`, { method: 'POST', headers: headers(false), body: JSON.stringify(body) }); }
    catch { throw Object.assign(new Error(OFFLINE), { offline: true }); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.msg || data.error_description || data.message || `Sign-in failed (${res.status})`), { status: res.status });
    return data;
  }

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

    /** Step one: email a six-digit code. */
    sendCode: (email) => authCall('otp', { email, create_user: true }).then(() => ({ sent: true })),

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

    async signOut() {
      const token = current?.access_token;
      current = null;
      onSession(null);
      if (token) {
        try { await fetch(`${base}/auth/v1/logout`, { method: 'POST', headers: { apikey: anonKey, authorization: `Bearer ${token}` } }); } catch { /* already signed out locally */ }
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
  return next;
}

/** Does this plan hold anything a person made, as opposed to an empty start? */
export function hasSubstance(state) {
  return Object.keys(state.tasks || {}).length > 0
    || (state.commitments || []).length > 0
    || (state.busy || []).length > 0
    || (state.checkins || []).length > 0;
}
