// Connect and manage calendar sources: the Canvas feed, Google Calendar, and
// how often Cadence checks them.

import { app, persist, refreshSources, back, insideCanvas } from '../core.js';
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

export const actions = {
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
  'autosync-toggle': (el) => persist((st) => { st.autoSync.enabled = el.checked; }, { recalc: false })
    .then(() => chrome?.runtime?.sendMessage?.({ type: 'cadence:arm-autosync' }))
};
