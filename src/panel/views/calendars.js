// Connect and manage calendar sources: the Canvas feed, Google Calendar, and
// how often Cadence checks them.

import { app, persist, refreshSources, pushGoogleBlocks, back, insideCanvas } from '../core.js';
import { pushedItems } from '../../lib/replanner.js';
import { SOURCE_META, canvasFeed, google } from '../../lib/sources/sources.js';
import { fmtMinutes } from '../../lib/util.js';
import { svg, I, esc, sheet, toast, ago, plural } from '../ui.js';

export function viewCalendars() {
  const S = app.S;
  const cf = S.sources.canvasFeed;
  const g = S.sources.google;
  const auto = S.autoSync || {};

  return `
    <button class="back" data-act="back">${svg(I.left, 16)} Back</button>
    <section class="hello" style="padding-top:2px">
      <h1>Calendars</h1>
      <p>Cadence plans around everything it can see. Connect a source once and it stays current on its own.</p>
    </section>

    ${sourceCard({
      id: 'canvasFeed', icon: I.canvas, color: '#e8664f', cfg: cf,
      title: 'Canvas calendar feed',
      sub: cf.enabled ? `${plural((cf.assignments || []).length, 'assignment')} · ${plural((cf.events || []).length, 'event')}`
        : 'Assignment due dates and class events, without signing in again',
      primary: cf.enabled ? 'Change link' : 'Add feed link',
      action: 'canvas-feed-sheet'
    })}

    ${sourceCard({
      id: 'google', icon: I.cal, color: '#3b82f6', cfg: g,
      title: 'Google Calendar',
      sub: g.enabled ? `${esc(g.email || 'Connected')} · ${plural((g.events || []).length, 'event')} · ${plural((g.selected || []).length || (g.calendars || []).length, 'calendar')}`
        : 'Games, shifts, appointments — the things that make a plan wrong when Cadence can’t see them',
      primary: g.enabled ? 'Calendars' : 'Connect',
      action: g.enabled ? 'google-calendars-sheet' : 'google-connect'
    })}

    ${!google.available() ? `<div class="card soft small">
      <b>Google sync needs the Chrome extension.</b> On the website the browser blocks these requests. Your plan, commitments and manual <code>.ics</code> imports all still work here.
    </div>` : ''}

    ${g.enabled ? pushCard(g) : ''}

    <div class="section-head" style="margin-top:20px"><h2>Keeping up to date</h2></div>
    <div class="card flush">
      <label class="integration toggle" style="cursor:pointer">
        <span class="ic" style="color:var(--accent)">${svg(I.repeat, 19)}</span>
        <span class="grow"><span class="t" style="display:block">Sync automatically</span>
          <small>${auto.lastRun ? `Last checked ${ago(auto.lastRun)}` : 'Checks in the background'}</small></span>
        <input type="checkbox" data-act="autosync-toggle" ${auto.enabled ? 'checked' : ''}><i></i>
      </label>
      <div class="integration">
        <span class="ic">${svg(I.clock, 19)}</span>
        <div class="grow"><div class="t">How often</div><div class="m">More often uses a little more battery</div></div>
        <div class="choices" style="gap:6px">${[15, 20, 30, 60].map((m) =>
          `<button class="choice" style="min-height:34px;padding:6px 10px" data-act="autosync-every" data-min="${m}" aria-pressed="${(auto.everyMinutes || 20) === m}">${m}m</button>`).join('')}</div>
      </div>
      <div class="integration" style="cursor:pointer" data-act="refresh-sources" role="button" tabindex="0">
        <span class="ic" style="color:var(--green)">${svg(I.check, 19)}</span>
        <div class="grow"><div class="t">Refresh now</div><div class="m">${app.sourcesSyncing ? 'Checking…' : 'Pull everything again right now'}</div></div>
        ${svg(I.right, 16)}
      </div>
    </div>

    <div class="card soft small" style="margin-top:16px">
      <b>What leaves your device:</b> nothing. Cadence reads these calendars straight from your browser and keeps the results here. Your Canvas feed link and Google token are stored in the extension's own storage.
    </div>`;
}

/** Writing back to Google — off by default, and opt-in per item even then. */
function pushCard(g) {
  const items = pushedItems(app.S);
  const target = (g.calendars || []).find((c) => c.id === (g.pushCalendarId || 'primary'));
  return `<div class="card" style="--c:#3b82f6">
    <label class="toggle" style="align-items:flex-start">
      <input type="checkbox" data-act="google-push-toggle" ${g.push ? 'checked' : ''}><i></i>
      <span class="grow"><span class="card-title" style="display:block">Add Cadence blocks to Google Calendar</span>
        <small>Off by default. Even with this on, only the commitments and assignments you pick get added — everything else stays inside Cadence.</small></span>
    </label>

    ${g.push ? `
      <div class="integration" style="padding:12px 0 0">
        <span class="ic">${svg(I.cal, 18)}</span>
        <div class="grow"><div class="t">Writes to</div><div class="m">${esc(target?.name || 'Your main calendar')}</div></div>
        <button class="btn small soft" data-act="google-push-calendar">Change</button>
      </div>

      <div class="section-head" style="margin:14px 0 8px"><h2 style="font-size:14px">Syncing ${items.length ? `(${items.length})` : ''}</h2></div>
      ${items.length ? `<div class="card flush" style="margin:0;box-shadow:none;border-color:var(--line)">
          ${items.map((i) => `<div class="item"><span class="dot" style="--c:${i.color || 'var(--accent)'}"></span>
            <div class="grow"><div class="t">${esc(i.title)}</div><div class="m">${i.kind === 'commitment' ? 'Commitment' : 'Assignment'}</div></div>
            <button class="btn small ghost" data-act="push-item-off" data-id="${i.id}" data-kind="${i.kind}">Stop</button></div>`).join('')}
        </div>`
        : `<div class="card soft small" style="margin:0">Nothing opted in yet. Open a commitment or an assignment and turn on <b>Add to Google Calendar</b>.</div>`}

      ${g.pushError ? `<div class="card warm small" style="margin:12px 0 0">${esc(g.pushError)}</div>` : ''}
      <div class="row" style="margin-top:12px;gap:8px">
        <button class="btn small soft" data-act="google-push-now">${svg(I.repeat, 14)} Sync now</button>
        <span class="grow"></span>
        <button class="btn small ghost danger" data-act="google-remove-blocks">Remove Cadence events</button>
      </div>
      ${g.lastPush ? `<p class="hint">Last updated ${ago(g.lastPush)}. Cadence only ever edits events it created.</p>` : ''}`
    : ''}
  </div>`;
}

function sourceCard({ id, icon, color, cfg, title, sub, primary, action }) {
  const status = cfg.error
    ? `<span class="pill amber">${svg(I.flag, 12)} Needs attention</span>`
    : cfg.enabled ? `<span class="status">${cfg.lastSync ? `Synced ${ago(cfg.lastSync)}` : 'Connected'}</span>`
      : '<span class="muted small">Not connected</span>';

  return `<div class="card" style="--c:${color}">
    <div class="row" style="align-items:flex-start">
      <span class="kind-ic">${svg(icon)}</span>
      <div class="grow"><div class="card-title">${esc(title)}</div><div class="card-sub">${sub}</div></div>
      ${status}
    </div>
    ${cfg.error ? `<div class="card warm small" style="margin:12px 0 0">${esc(cfg.error)}</div>` : ''}
    <div class="row" style="margin-top:12px;gap:8px">
      <button class="btn small ${cfg.enabled ? 'soft' : 'primary'}" data-act="${action}">${esc(primary)}</button>
      ${cfg.enabled ? `<button class="btn small ghost" data-act="source-refresh" data-id="${id}">Refresh</button>
        <span class="grow"></span>
        <button class="btn small ghost danger" data-act="source-disconnect" data-id="${id}">Disconnect</button>` : ''}
    </div>
  </div>`;
}

// ------------------------------------------------------------------ Canvas

async function canvasFeedSheet() {
  const cfg = app.S.sources.canvasFeed;
  const res = await sheet(`
    <h2>Canvas calendar feed</h2>
    <p class="lead">This brings in every assignment due date, and it keeps working when you're not on Canvas — on your phone, for instance.</p>
    <div class="card soft small" style="margin:0 0 14px">
      <b>Where to find it</b>
      <div class="muted">${esc(canvasFeed.FEED_HELP)}. It's at the bottom right of the Canvas calendar page.</div>
    </div>
    <label class="field"><span>Feed link</span>
      <input type="text" name="url" value="${esc(cfg.url || '')}" placeholder="https://school.instructure.com/feeds/calendars/user_….ics" autocomplete="off" spellcheck="false"></label>
    <p class="hint" style="margin-top:-8px">Treat this like a password — anyone with the link can read your Canvas calendar.</p>
    <div class="actions">
      ${cfg.url ? '<button class="btn soft danger" name="op" value="remove">Remove</button>' : '<button class="btn ghost" value="cancel">Cancel</button>'}
      <button class="btn primary" name="op" value="save">Save &amp; sync</button>
    </div>`);
  if (!res) return;

  if (res.get('op') === 'remove') {
    await persist((st) => { st.sources.canvasFeed = { ...st.sources.canvasFeed, enabled: false, url: '', events: [], assignments: [], error: null }; });
    return toast('Canvas feed removed');
  }
  const url = String(res.get('url') || '').trim();
  if (!url) return toast('Paste the feed link first');
  if (!canvasFeed.looksLikeFeedUrl(url)) {
    const go = await sheet(`<h2>That doesn't look like a feed link</h2>
      <p class="lead">Canvas links end in <code>.ics</code> and contain <code>/feeds/calendars/</code>. Try it anyway?</p>
      <div class="actions"><button class="btn ghost" value="cancel">Go back</button><button class="btn primary" name="op" value="yes">Try it</button></div>`);
    if (!go) return;
  }
  await persist((st) => { st.sources.canvasFeed = { ...st.sources.canvasFeed, url, enabled: true, error: null }; }, { recalc: false });
  await refreshSources({ only: 'canvasFeed' });
}

// ------------------------------------------------------------------ Google

async function googleConnect() {
  if (!google.available()) return toast('Google sync needs the Chrome extension');
  const cfg = app.S.sources.google;

  if (!cfg.clientId) {
    const res = await sheet(`
      <h2>Connect Google Calendar</h2>
      <p class="lead">One-time setup: Cadence needs a Google OAuth client ID. Create one free in Google Cloud Console — the README has the exact steps.</p>
      <div class="card soft small" style="margin:0 0 14px">
        <b>Redirect URI to paste into Google</b>
        <div class="muted" style="word-break:break-all;margin-top:4px">${esc(google.redirectUri())}</div>
      </div>
      <label class="field"><span>Client ID</span>
        <input type="text" name="clientId" placeholder="1234-abc.apps.googleusercontent.com" autocomplete="off" spellcheck="false"></label>
      <div class="actions"><button class="btn ghost" value="cancel">Cancel</button><button class="btn primary" name="op" value="save">Continue</button></div>`);
    if (!res) return;
    const clientId = String(res.get('clientId') || '').trim();
    if (!clientId.endsWith('.apps.googleusercontent.com')) return toast('That should end in .apps.googleusercontent.com');
    await persist((st) => { st.sources.google.clientId = clientId; }, { recalc: false });
  }

  try {
    const token = await google.authorize(app.S.sources.google.clientId, { scopes: [google.SCOPES.read], interactive: true });
    const me = await google.whoAmI(token.accessToken);
    const calendars = await google.listCalendars(token.accessToken);
    await persist((st) => {
      Object.assign(st.sources.google, token, {
        enabled: true, email: me.email, calendars,
        selected: calendars.filter((c) => c.primary || c.selected).map((c) => c.id),
        error: null
      });
    }, { recalc: false });
    toast(`Connected ${me.email || 'Google Calendar'}`);
    await refreshSources({ only: 'google' });
  } catch (e) {
    toast(e.message);
  }
}

async function googleCalendarsSheet() {
  const g = app.S.sources.google;
  const cals = g.calendars || [];
  const res = await sheet(`
    <h2>Which calendars?</h2>
    <p class="lead">Cadence treats events on these as busy time and plans around them.</p>
    ${cals.map((c) => `<label class="toggle" style="padding:6px 0">
      <input type="checkbox" name="cal" value="${esc(c.id)}" ${(g.selected || []).includes(c.id) ? 'checked' : ''}><i></i>
      <span>${esc(c.name)}${c.primary ? ' <span class="pill">Main</span>' : ''}</span></label>`).join('') || '<p class="muted small">No calendars found.</p>'}
    <div class="actions"><button class="btn ghost" value="cancel">Cancel</button><button class="btn primary" name="op" value="save">Save</button></div>`);
  if (!res) return;
  const selected = res.getAll('cal').map(String);
  await persist((st) => { st.sources.google.selected = selected; }, { recalc: false });
  await refreshSources({ only: 'google' });
}

async function enablePush() {
  const g = app.S.sources.google;
  try {
    // Incremental auth: ask for the write scope on top of what's already granted.
    const token = await google.authorize(g.clientId, { scopes: [google.SCOPES.read, google.SCOPES.write], interactive: true, loginHint: g.email });
    const calendars = await google.listCalendars(token.accessToken);
    await persist((st) => {
      Object.assign(st.sources.google, token, { calendars, push: true, pushError: null });
      if (!st.sources.google.pushCalendarId) st.sources.google.pushCalendarId = (calendars.find((c) => c.primary) || {}).id || 'primary';
    }, { recalc: false });
    toast('Cadence can now add blocks. Pick which ones on a commitment or assignment.');
    pushGoogleBlocks({ quiet: true });
  } catch (e) {
    toast(e.message);
  }
}

async function disablePush() {
  const res = await sheet(`<h2>Stop adding blocks?</h2>
    <p class="lead">Cadence will stop writing to Google Calendar. Blocks it already added can stay or go.</p>
    <div class="actions"><button class="btn soft" name="op" value="keep">Leave them</button>
      <button class="btn primary" name="op" value="remove">Remove them</button></div>`);
  if (!res) return;
  const g = app.S.sources.google;
  if (res.get('op') === 'remove') await removeBlocks({ quiet: true });
  await persist((st) => { st.sources.google.push = false; }, { recalc: false });
  toast('Stopped');
}

async function removeBlocks({ quiet = false } = {}) {
  const g = app.S.sources.google;
  try {
    const token = await google.freshToken(g, {
      save: (t) => persist((st) => { Object.assign(st.sources.google, t); }, { recalc: false }),
      scopes: [google.SCOPES.read, google.SCOPES.write]
    });
    const n = await google.removeAllBlocks(token, g.pushCalendarId || 'primary');
    await persist((st) => { st.sources.google.pushed = {}; }, { recalc: false });
    if (!quiet) toast(n ? `Removed ${n} Cadence event${n === 1 ? '' : 's'}` : 'Nothing of Cadence\u2019s was on the calendar');
  } catch (e) {
    if (!quiet) toast(e.message);
  }
}

async function pickPushCalendar() {
  const g = app.S.sources.google;
  const writable = (g.calendars || []).filter((c) => c.canWrite !== false);
  const res = await sheet(`<h2>Where should blocks go?</h2>
    <p class="lead">A separate calendar keeps Cadence's blocks easy to hide or delete in bulk.</p>
    <div class="choices stacked">${writable.map((c) => `<button class="choice" name="id" value="${esc(c.id)}"
      aria-pressed="${(g.pushCalendarId || 'primary') === c.id}">${esc(c.name)}${c.primary ? '<small>Your main calendar</small>' : ''}</button>`).join('')}</div>
    <div class="actions"><button class="btn ghost" value="cancel">Cancel</button></div>`);
  if (!res?.get('id')) return;
  await persist((st) => { st.sources.google.pushCalendarId = String(res.get('id')); }, { recalc: false });
  pushGoogleBlocks();
}

export const actions = {
  'google-push-now': () => pushGoogleBlocks(),
  'google-push-calendar': () => pickPushCalendar(),
  'google-remove-blocks': () => removeBlocks(),
  'push-item-off': (el) => persist((st) => {
    const { id, kind } = el.dataset;
    if (kind === 'commitment') { const c = st.commitments.find((x) => x.id === id); if (c) c.pushToGoogle = false; }
    else if (st.tasks[id]) st.tasks[id].pushToGoogle = false;
  }, { recalc: false }).then(() => pushGoogleBlocks({ quiet: true })),
  'open-calendars': async () => { const { push } = await import('../core.js'); push('calendars'); },
  'canvas-feed-sheet': () => canvasFeedSheet(),
  'google-connect': () => googleConnect(),
  'google-calendars-sheet': () => googleCalendarsSheet(),
  'source-refresh': (el) => refreshSources({ only: el.dataset.id }),
  'source-disconnect': async (el) => {
    const id = el.dataset.id;
    const res = await sheet(`<h2>Disconnect ${esc(SOURCE_META[id]?.short || 'this calendar')}?</h2>
      <p class="lead">Cadence stops reading it and forgets what it cached. Your plan stays; it just won't schedule around those events any more.</p>
      <div class="actions"><button class="btn ghost" value="cancel">Keep it</button><button class="btn primary" name="op" value="yes">Disconnect</button></div>`);
    if (!res) return;
    await persist((st) => {
      const keep = id === 'google' ? { clientId: st.sources.google.clientId } : {};
      st.sources[id] = { ...st.sources[id], ...keep, enabled: false, events: [], assignments: [], error: null, accessToken: null, expiresAt: 0 };
    });
    toast('Disconnected');
  },
  'autosync-every': (el) => persist((st) => { st.autoSync.everyMinutes = Number(el.dataset.min); }, { recalc: false })
    .then(() => { chrome?.runtime?.sendMessage?.({ type: 'cadence:arm-autosync' }); toast('Updated'); })
};

export const changeActions = {
  'google-push-toggle': (el) => (el.checked ? enablePush() : disablePush()),
  'autosync-toggle': (el) => persist((st) => { st.autoSync.enabled = el.checked; }, { recalc: false })
    .then(() => chrome?.runtime?.sendMessage?.({ type: 'cadence:arm-autosync' }))
};
