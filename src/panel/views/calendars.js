// Connect and manage calendar sources: the Canvas feed, Google Calendar, and
// how often Cadence checks them.

import { app, persist, render, refreshSources, pushGoogleBlocks, back, insideCanvas, undoTo, refreshMail, watchMail } from '../core.js';
import { nanoState, startNanoDownload, blankMail } from '../../lib/mailEvents.js';
import { pushedItems } from '../../lib/replanner.js';
import { SOURCE_META, LINK_FEEDS, canvasFeed, google, looksLikeGoogleIcs } from '../../lib/sources/sources.js';
import * as gmail from '../../lib/sources/gmail.js';
import { CONFIG } from '../../config.js';
import { fmtMinutes } from '../../lib/util.js';
import { svg, I, esc, sheet, toast, ago, plural } from '../ui.js';

/** The Calendars screen: one card per source (the Canvas feed, the Google,
    Outlook and iCloud links, and Google Calendar through the extension), then
    how often everything is checked again. */
export function viewCalendars() {
  const S = app.S;
  const cf = S.sources.canvasFeed;
  const g = S.sources.google;
  const gf = S.sources.googleFeed || {};
  const of = S.sources.outlookFeed || {};
  const icf = S.sources.icloudFeed || {};
  const auto = S.autoSync || {};

  return `
    <button class="back" data-act="back">${svg(I.left, 16)} Back</button>
    <section class="hello">
      <h1>Calendars</h1>
      <p>Cadence plans around everything it can see. Connect a source once and it stays current on its own.</p>
      <button class="btn primary mt3" data-act="calendar-setup">Connect calendars</button>
    </section>

    ${sourceCard({
      id: 'canvasFeed', icon: I.canvas, color: '#e8664f', cfg: cf,
      title: 'Canvas calendar feed',
      sub: cf.enabled ? `${plural((cf.assignments || []).length, 'assignment')} · ${plural((cf.events || []).length, 'event')}${cf.fromFile && !cf.url ? ' · from a file' : ''}`
        : 'Assignment due dates and class events, without signing in again',
      primary: cf.enabled ? 'Change link' : 'Add feed link',
      action: 'canvas-feed-sheet'
    })}

    ${cf.fromFile && !cf.url ? `<div class="card soft small">
      <b>Imported from a file.</b> These stay put, but they won't update on their own. Add the feed link, or import a fresh export when your assignments change.
    </div>` : ''}

    ${sourceCard({
      id: 'googleFeed', icon: I.cal, color: '#3b82f6', cfg: gf,
      title: 'Google Calendar link',
      sub: gf.enabled ? `${plural((gf.events || []).length, 'event')} · read only` : 'Paste one link and your Google events count as busy time. Works on the website and on phones',
      primary: gf.enabled ? 'Change link' : 'Add Google Calendar link',
      action: 'google-feed-sheet'
    })}

    ${sourceCard({
      id: 'outlookFeed', icon: I.cal, color: '#3b82f6', cfg: of,
      title: 'Outlook calendar link',
      sub: of.enabled ? `${plural((of.events || []).length, 'event')} · read only` : 'A published Outlook or school Microsoft calendar, as busy time',
      primary: of.enabled ? 'Change link' : 'Add Outlook link',
      action: 'calendar-setup', data: 'outlookFeed'
    })}

    ${sourceCard({
      id: 'icloudFeed', icon: I.cal, color: '#3b82f6', cfg: icf,
      title: 'iCloud calendar link',
      sub: icf.enabled ? `${plural((icf.events || []).length, 'event')} · read only` : 'A public iCloud calendar from your iPhone or Mac, as busy time',
      primary: icf.enabled ? 'Change link' : 'Add iCloud link',
      action: 'calendar-setup', data: 'icloudFeed'
    })}

    ${sourceCard({
      id: 'google', icon: I.cal, color: '#3b82f6', cfg: g,
      title: 'Google Calendar',
      sub: g.enabled ? `${esc(g.email || 'Connected')} · ${plural((g.events || []).length, 'event')} · ${plural((g.selected || []).length || (g.calendars || []).length, 'calendar')}`
        : 'Games, shifts, appointments: the things that make a plan wrong when Cadence cannot see them',
      primary: g.enabled ? 'Calendars' : 'Connect',
      action: g.enabled ? 'google-calendars-sheet' : 'google-connect'
    })}

    ${!google.available() ? `<div class="card soft small">
      <b>Signing in to Google needs the Chrome extension,</b> and is only needed to add Cadence's blocks to your Google Calendar. To plan around your Google events here, use the Google Calendar link above.
    </div>` : ''}

    ${g.enabled ? pushCard(g) : ''}

    ${google.available() ? gmailCard(S.gmail || {}, S.sources.mail || {}) : ''}

    <div class="section-head mt6"><h2>Keeping up to date</h2></div>
    <div class="card flush">
      <label class="integration toggle">
        <span class="ic">${svg(I.repeat, 18)}</span>
        <span class="grow"><span class="t block">Sync automatically</span>
          <small>${auto.lastRun ? `Last checked ${ago(auto.lastRun)}` : 'Checks in the background'}</small></span>
        <input type="checkbox" data-act="autosync-toggle" ${auto.enabled ? 'checked' : ''}><i></i>
      </label>
      <div class="integration">
        <span class="ic">${svg(I.clock, 19)}</span>
        <div class="grow"><div class="t">How often</div><div class="m">More often uses a little more battery</div></div>
        <div class="choices">${[15, 20, 30, 60].map((m) =>
          `<button class="choice" data-act="autosync-every" data-min="${m}" aria-pressed="${(auto.everyMinutes || 20) === m}">${m}m</button>`).join('')}</div>
      </div>
      <div class="integration" data-act="refresh-sources" role="button" tabindex="0">
        <span class="ic ok">${svg(I.check, 18)}</span>
        <div class="grow"><div class="t">Refresh now</div><div class="m">${app.sourcesSyncing ? 'Checking…' : 'Pull everything again right now'}</div></div>
        ${svg(I.right, 16)}
      </div>
    </div>

    <div class="card soft small mt4">
      <b>Where this goes:</b> Your Canvas feed link and your Google Calendar events stay on this device and are not saved to your account. Google's sign-ins are not stored at all: they are held in memory while Cadence is open. On the website, Cadence's server fetches the Canvas feed for you each time it updates and keeps nothing. Assignments that come from Canvas become part of your plan. With Gmail connected, your email is read on this computer to find events: no email is sent anywhere, and the events found stay in this browser, not in your account.
    </div>`;
}

/** Gmail, read on this computer to find events (lib/mailEvents.js). Its own
    card, since it is not a calendar: connect it; once connected, what was
    found and when, which way it reads, the switch, a manual check, and
    disconnect. */
function gmailCard(gm, m) {
  if (gm.enabled && !app.mailNano) {
    app.mailNano = { state: 'checking', progress: 0 };
    nanoState().then((state) => { app.mailNano = { state, progress: 0 }; render(); });
  }
  const status = !gm.enabled ? '<span class="muted small">Not connected</span>'
    : m.error ? `<span class="pill amber">${svg(I.flag, 12)} Needs attention</span>`
      : `<span class="status">${app.mailRunning ? 'Checking now' : !m.enabled ? 'Off' : m.lastSync ? `Checked ${ago(m.lastSync)}` : 'Connected'}</span>`;
  const found = (m.events || []).length;
  const detail = gm.enabled ? `
    ${m.error ? `<div class="card warm small mt3">${esc(m.error)}</div>` : ''}
    <div class="small mt3">
      ${m.enabled && m.lastSync && !m.error ? `<p class="muted">${plural(found, 'event')} from email on your calendar.${m.partial ? ' Some long emails were only partly read.' : ''}</p>` : ''}
      ${engineLine()}
    </div>
    <label class="toggle top-align mt3">
      <input type="checkbox" data-act="mail-toggle" ${m.enabled ? 'checked' : ''}><i></i>
      <span class="grow"><span class="block">Add events from email automatically</span>
        <small>${m.enabled ? 'Cadence checks your inbox about every 30 minutes while it is open, and labels what it adds From email.' : 'Off: Cadence does not read your email, and the events it found are hidden.'}</small></span>
    </label>` : '';
  return `<div class="card">
    <div class="row top-align">
      <span class="kind-ic">${svg(I.mail)}</span>
      <div class="grow"><div class="card-title">Gmail, to find events</div>
        <div class="card-sub">${gm.enabled
    ? `${esc(gm.email || 'Connected')} · read only`
    : 'Cadence reads your recent email on this computer, finds practices, games, deadlines and changes, and adds them to your calendar. Your email is not sent anywhere.'}</div></div>
      ${status}
    </div>
    ${detail}
    <div class="row mt3 gap2">
      ${gm.enabled
    ? `<button class="btn small soft" data-act="mail-check-now" ${app.mailRunning || !m.enabled ? 'disabled' : ''}>${app.mailRunning ? 'Checking now' : 'Check email now'}</button><span class="grow"></span>
         <button class="btn small ghost danger" data-act="gmail-disconnect">Disconnect</button>`
    : '<button class="btn small primary" data-act="gmail-connect">Connect Gmail</button>'}
    </div>
  </div>`;
}

/** Which way Cadence reads email on this computer, said plainly, with the
    one-time download where Chrome offers it. */
function engineLine() {
  const n = app.mailNano || {};
  if (n.state === 'checking') return '';
  if (n.state === 'available') return '<p class="muted mt1">Reading with Chrome\'s on-device AI, on this computer.</p>';
  if (n.state === 'downloading') return `<p class="muted mt1">Getting Chrome's on-device AI ready${n.progress ? `, ${Math.round(n.progress * 100)}%` : ''}. Until then Cadence uses simpler matching.</p>`;
  if (n.state === 'downloadable') return '<p class="muted mt1">Using simpler matching on this computer. Chrome\'s on-device AI reads email more accurately, after a one-time download by Chrome. <button class="link" data-act="mail-get-ai">Get on-device AI</button></p>';
  return '<p class="muted mt1">This computer can\'t run Chrome\'s on-device AI, so Cadence uses simpler matching.</p>';
}

/** Start Chrome's one-time download of its on-device AI. Chrome allows that
    only right after a click, so this runs from one, and the card shows how far
    the download has got. */
function getOnDeviceAI() {
  startNanoDownload({
    onProgress: (p) => {
      if (Math.round(p * 100) === Math.round((app.mailNano?.progress || 0) * 100)) return;
      app.mailNano = { state: 'downloading', progress: p };
      render();
    },
    onDone: (state) => { app.mailNano = { state, progress: 0 }; render(); }
  }).then((state) => {
    if (state !== 'downloading') return;
    app.mailNano = { state, progress: app.mailNano?.progress || 0 };
    render();
  });
}

/** Writing back to Google: off by default, and opt-in per item even then. */
function pushCard(g) {
  const items = pushedItems(app.S);
  const target = (g.calendars || []).find((c) => c.id === (g.pushCalendarId || 'primary'));
  return `<div class="card k-activity">
    <label class="toggle top-align">
      <input type="checkbox" data-act="google-push-toggle" ${g.push ? 'checked' : ''}><i></i>
      <span class="grow"><span class="card-title block">Add Cadence blocks to Google Calendar</span>
        <small>Off by default. Even with this on, only the activities and assignments you pick get added. Everything else stays inside Cadence.</small></span>
    </label>

    ${g.push ? `
      <div class="integration bare">
        <span class="ic">${svg(I.cal, 18)}</span>
        <div class="grow"><div class="t">Writes to</div><div class="m">${esc(target?.name || 'Your main calendar')}</div></div>
        <button class="btn small soft" data-act="google-push-calendar">Change</button>
      </div>

      <div class="section-head mt4 mb2"><h2>Syncing ${items.length ? `(${items.length})` : ''}</h2></div>
      ${items.length ? `<div class="card flush m0">
          ${items.map((i) => `<div class="item"><span class="dot k-work"></span>
            <div class="grow"><div class="t">${esc(i.title)}</div><div class="m">${i.kind === 'commitment' ? 'Activity' : 'Assignment'}</div></div>
            <button class="btn small ghost" data-act="push-item-off" data-id="${i.id}" data-kind="${i.kind}">Stop</button></div>`).join('')}
        </div>`
        : `<div class="card soft small m0">Nothing opted in yet. Open an activity or an assignment and turn on <b>Add to Google Calendar</b>.</div>`}

      ${g.pushError ? `<div class="card warm small mt3">${esc(g.pushError)}</div>` : ''}
      <div class="row mt3 gap2">
        <button class="btn small soft" data-act="google-push-now">${svg(I.repeat, 14)} Sync now</button>
        <span class="grow"></span>
        <button class="btn small ghost danger" data-act="google-remove-blocks">Remove Cadence events</button>
      </div>
      ${g.lastPush ? `<p class="hint">Last updated ${ago(g.lastPush)}. Cadence only ever edits events it created.</p>` : ''}`
    : ''}
  </div>`;
}

/** One source's card: what it is, whether it is connected and when it last
    synced, any error it hit, and its buttons (connect or change, refresh,
    disconnect). `action` is the data-act of the main button. */
function sourceCard({ id, icon, color, cfg, title, sub, primary, action, data = '' }) {
  const status = cfg.error
    ? `<span class="pill amber">${svg(I.flag, 12)} Needs attention</span>`
    : cfg.enabled ? `<span class="status">${cfg.lastSync ? `Synced ${ago(cfg.lastSync)}` : 'Connected'}</span>`
      : '<span class="muted small">Not connected</span>';

  return `<div class="card">
    <div class="row top-align">
      <span class="kind-ic">${svg(icon)}</span>
      <div class="grow"><div class="card-title">${esc(title)}</div><div class="card-sub">${sub}</div></div>
      ${status}
    </div>
    ${cfg.error ? `<div class="card warm small mt3">${esc(cfg.error)}</div>` : ''}
    <div class="row mt3 gap2">
      <button class="btn small ${cfg.enabled ? 'soft' : 'primary'}" data-act="${action}"${data ? ` data-id="${esc(data)}"` : ''}>${esc(primary)}</button>
      ${cfg.enabled ? `<button class="btn small ghost" data-act="source-refresh" data-id="${id}">Refresh</button>
        <span class="grow"></span>
        <button class="btn small ghost danger" data-act="source-disconnect" data-id="${id}">Disconnect</button>` : ''}
    </div>
  </div>`;
}

// ------------------------------------------------------------------ Canvas

/** The sheet for adding, changing or removing the Canvas feed link. A link
    without /feeds/calendars/ and .ics is still allowed after a second "Try
    it", in case a school's link is shaped differently. Removing can be undone. */
async function canvasFeedSheet() {
  const cfg = app.S.sources.canvasFeed;
  const res = await sheet(`
    <h2>Canvas calendar feed</h2>
    <p class="lead">This brings in every assignment due date, and it keeps working when you are not on Canvas.</p>
    <div class="card soft small mb4">
      <b>Where to find it</b>
      <div class="muted">${esc(canvasFeed.FEED_HELP)}. It's at the bottom right of the Canvas calendar page.</div>
    </div>
    <label class="field"><span>Feed link</span>
      <input type="text" name="url" value="${esc(cfg.url || '')}" placeholder="https://school.instructure.com/feeds/calendars/user_….ics" autocomplete="off" spellcheck="false"></label>
    <p class="hint up">Treat this like a password. Anyone with the link can read your Canvas calendar.</p>
    <p class="hint">It updates on its own about every 20 minutes while Cadence is open.</p>
    <div class="actions">
      ${cfg.url ? '<button class="btn soft danger" name="op" value="remove">Remove feed</button>' : '<button class="btn ghost" value="cancel">Cancel</button>'}
      <button class="btn primary" name="op" value="save">Save and sync</button>
    </div>`);
  if (!res) return;

  if (res.get('op') === 'remove') {
    const snap = structuredClone(app.S);
    await persist((st) => { st.sources.canvasFeed = { ...st.sources.canvasFeed, enabled: false, url: '', events: [], assignments: [], error: null }; });
    return toast('Canvas feed removed', undoTo(snap));
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

// --------------------------------------------------------- Google link

/** The sheet for the Google Calendar secret iCal link. Unlike the Canvas link,
    this one has to match Google's own format exactly: a wrong link would fail
    every sync, so it is refused up front. A webcal: link is read as https:. */
async function googleFeedSheet() {
  const cfg = app.S.sources.googleFeed || {};
  const res = await sheet(`
    <h2>Google Calendar link</h2>
    <p class="lead">Your Google events count as busy time, and Cadence plans your work around them. It can read your calendar, not change it.</p>
    <div class="card soft small mb4">
      <b>Where to find it</b>
      <div class="muted">On a computer, open Google Calendar → Settings (the gear) → click your calendar on the left → Integrate calendar → copy <b>Secret address in iCal format</b>.</div>
    </div>
    <label class="field"><span>Google Calendar link</span>
      <input type="text" name="url" value="${esc(cfg.url || '')}" placeholder="https://calendar.google.com/calendar/ical/…/private-…/basic.ics" autocomplete="off" spellcheck="false"></label>
    <p class="hint up">Treat this like a password. Anyone with the link can see your calendar.</p>
    <p class="hint">It updates on its own about every 20 minutes while Cadence is open. Cadence's server fetches it for you and keeps nothing.</p>
    <div class="actions">
      ${cfg.url ? '<button class="btn soft danger" name="op" value="remove">Remove link</button>' : '<button class="btn ghost" value="cancel">Cancel</button>'}
      <button class="btn primary" name="op" value="save">Save and sync</button>
    </div>`);
  if (!res) return;

  if (res.get('op') === 'remove') {
    const snap = structuredClone(app.S);
    await persist((st) => { st.sources.googleFeed = { ...st.sources.googleFeed, enabled: false, url: '', events: [], assignments: [], error: null }; });
    return toast('Google Calendar link removed', undoTo(snap));
  }
  const url = String(res.get('url') || '').trim().replace(/^webcal:/i, 'https:');
  if (!url) return toast('Paste the link first');
  if (!looksLikeGoogleIcs(url)) {
    return toast('That isn\'t the secret iCal address. It starts with https://calendar.google.com/calendar/ical/ and ends in basic.ics');
  }
  await persist((st) => { st.sources.googleFeed = { ...(st.sources.googleFeed || {}), url, enabled: true, error: null }; }, { recalc: false });
  await refreshSources({ only: 'googleFeed' });
}

// ------------------------------------------------------------------ Google

/** Signs in to Google Calendar through the Chrome extension (read only). The
    first time, it asks for the OAuth client ID the student made in Google
    Cloud, then picks their main calendar and any shown ones to read. */
async function googleConnect() {
  if (!google.available()) return toast('Google sync needs the Chrome extension');
  if (!(await haveClientId('Connect Google Calendar', 'Connect Google Calendar'))) return;
  await connectGoogleCalendar();
}

/**
 * The Google OAuth client ID, asked for once and shared by Google Calendar and
 * Gmail. True when there is one. The client ID is not a secret: it names the
 * app to Google, and only this extension's redirect address may use it.
 */
async function haveClientId(title, button) {
  if (google.clientIdFor(app.S.sources.google)) return true;
  const res = await sheet(`
      <h2${/mail/i.test(title) ? ' data-about="email"' : ''}>${esc(title)}</h2>
      <p class="lead">One-time setup: Cadence needs a Google OAuth client ID. Create one free in Google Cloud Console. The README has the exact steps.</p>
      <div class="card soft small mb4">
        <b>Redirect URI to paste into Google</b>
        <div class="muted mt1 break">${esc(google.redirectUri())}</div>
        <button type="button" class="btn small soft mt2" data-copy="${esc(google.redirectUri())}" aria-live="polite">Copy the redirect URI</button>
      </div>
      <label class="field"><span>Client ID</span>
        <input type="text" name="clientId" placeholder="1234-abc.apps.googleusercontent.com" autocomplete="off" spellcheck="false"></label>
      <div class="actions"><button class="btn ghost" value="cancel">Cancel</button><button class="btn primary" name="op" value="save">${esc(button)}</button></div>`);
  if (!res) return false;
  const clientId = String(res.get('clientId') || '').trim();
  if (!clientId.endsWith('.apps.googleusercontent.com')) { toast('That should end in .apps.googleusercontent.com'); return false; }
  await persist((st) => { st.sources.google.clientId = clientId; }, { recalc: false });
  return true;
}

/** Sign in to Google for reading calendars, then pick up the student's calendars. */
async function connectGoogleCalendar() {
  try {
    const token = await google.authorize(google.clientIdFor(app.S.sources.google), { scopes: [google.SCOPES.read], interactive: true });
    const me = await google.whoAmI(token.accessToken);
    const calendars = await google.listCalendars(token.accessToken);
    google.hold(token);                   // in memory only; never written to storage
    await persist((st) => {
      Object.assign(st.sources.google, {
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

// ------------------------------------------------------------------- Gmail

/**
 * Connect Gmail to find events: say exactly what is read, where, and what is
 * kept (Google asks for this right before its own consent screen), then ask
 * Google for a read-only token. The inbox is read straight away. Chrome's
 * one-time model download, where this computer can run it, starts from the
 * same click, since Chrome allows that only after one.
 */
async function gmailConnect() {
  if (!gmail.available()) return toast('Reading Gmail needs the Chrome extension');
  const res = await sheet(`
    <h2 data-about="email">Find events in your Gmail?</h2>
    <p class="lead">Cadence reads your recent email on this computer, finds practices, games, deadlines and changes, and adds them to your calendar.</p>
    <div class="card soft small mb4">
      <p><b>What it reads:</b> the text of emails in your inbox from the last two weeks, up to 25 at a time. Spam, trash, drafts, promotions and social mail are skipped, and attachments, images and links are never opened.</p>
      <p class="mt2"><b>Where:</b> on this computer, while Cadence is open. Chrome's on-device AI reads them inside Chrome, or simpler matching does where this computer can't run it. Your email is not sent to Cadence or to any AI company.</p>
      <p class="mt2"><b>What it keeps:</b> the events it finds, each with the sentence it came from, in this browser only. They are not saved to your account.</p>
      <p class="mt2">Events are added for you and labelled From email. Delete any that are wrong, turn this off, or disconnect at any time. It is read only: Cadence cannot send, delete or change anything in Gmail.</p>
    </div>
    <p class="small muted mb4">Cadence's use and transfer of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements. The <a href="https://${esc(CONFIG.site?.domain || location.host)}/privacy#gmail" target="_blank" rel="noopener">privacy policy</a> has the details.</p>
    <div class="actions"><button class="btn ghost" value="cancel">Not now</button><button class="btn primary" name="op" value="yes">Continue to Google</button></div>`);
  if (!res) return;
  getOnDeviceAI();
  if (!(await haveClientId('Connect Gmail', 'Continue to Google'))) return;
  try {
    const t = await gmail.authorize(google.clientIdFor(app.S.sources.google), { interactive: true, loginHint: app.S.gmail?.email || '' });
    if (!(t.scopes || []).includes(gmail.SCOPE)) throw new Error('Google did not allow reading Gmail. Try again and tick the box to allow it.');
    const email = await gmail.account(t.accessToken);
    if (!email) throw new Error('Google did not say which Gmail account this is. Try again.');
    gmail.hold(t);                        // in memory only; never written to storage
    await persist((st) => {
      // Events found in another account's email never carry over.
      const same = String(st.gmail?.email || '').toLowerCase() === email.toLowerCase();
      st.gmail = { ...st.gmail, enabled: true, email, error: null };
      st.sources.mail = { ...(same ? st.sources.mail : blankMail()), enabled: true, error: null, scanStartedAt: null };
    }, { recalc: false, edit: false });
    toast(`Connected ${email}`);
    watchMail();
    refreshMail({ quiet: false });
  } catch (e) {
    toast(e.message);
  }
}

/**
 * Disconnect Gmail. The sign-in is forgotten at once, and everything found in
 * email is removed from this device. The token is also taken back from Google
 * unless Google Calendar is connected too: Google can treat that as taking
 * back the whole sign-in, Calendar included.
 */
async function gmailDisconnect() {
  const both = !!app.S.sources.google?.enabled;
  const res = await sheet(`<h2 data-about="email">Disconnect Gmail?</h2>
    <p class="lead">Cadence stops reading your email, this device forgets the Gmail sign-in, and the events found in your email are removed from this device.${both ? ' To remove Cadence\'s access completely, also remove it at myaccount.google.com/permissions.' : ''}</p>
    <div class="actions"><button class="btn soft" value="cancel">Keep it connected</button><button class="btn danger-solid" name="op" value="yes">Disconnect Gmail</button></div>`);
  if (!res) return;
  const account = app.S.gmail?.email || '';
  let token = gmail.drop();
  await persist((st) => {
    st.gmail = { ...st.gmail, enabled: false, email: '', error: null, lastRead: null };
    st.sources.mail = blankMail();
  }, { edit: false });
  let cancelled = false;
  if (!both) {
    // No working sign-in held (after a reload, or an hour on): ask Google for
    // one quietly, only to cancel it.
    if (!token && google.clientIdFor(app.S.sources.google)) {
      try { token = (await gmail.authorize(google.clientIdFor(app.S.sources.google), { interactive: false, loginHint: account })).accessToken; } catch { /* signed out of Google: nothing to cancel from here */ }
    }
    cancelled = await gmail.revoke(token);
  }
  // Said as it is: when Google did not confirm, Cadence's access may remain until removed there.
  toast(both || cancelled ? 'Gmail disconnected, and the events found in your email were removed from this device.'
    : 'Gmail disconnected here, and the events found in your email were removed. Google did not confirm it, so remove Cadence at myaccount.google.com/permissions too.');
}

/** Which of the student's Google calendars count as busy time. */
async function googleCalendarsSheet() {
  const g = app.S.sources.google;
  const cals = g.calendars || [];
  const res = await sheet(`
    <h2>Which calendars?</h2>
    <p class="lead">Cadence treats events on these as busy time and plans around them.</p>
    ${cals.map((c) => `<label class="toggle">
      <input type="checkbox" name="cal" value="${esc(c.id)}" ${(g.selected || []).includes(c.id) ? 'checked' : ''}><i></i>
      <span>${esc(c.name)}${c.primary ? ' <span class="pill">Main</span>' : ''}</span></label>`).join('') || '<p class="muted small">No calendars found.</p>'}
    <div class="actions"><button class="btn ghost" value="cancel">Cancel</button><button class="btn primary" name="op" value="save">Save changes</button></div>`);
  if (!res) return;
  const selected = res.getAll('cal').map(String);
  await persist((st) => { st.sources.google.selected = selected; }, { recalc: false });
  await refreshSources({ only: 'google' });
}

/** Turns on adding Cadence's blocks to Google Calendar: asks Google for write
    access as well, and picks the main calendar unless one was chosen before.
    Nothing is written until the student opts an activity or assignment in. */
async function enablePush() {
  const g = app.S.sources.google;
  try {
    // Incremental auth: ask for the write scope on top of what's already granted.
    const token = await google.authorize(google.clientIdFor(g), { scopes: [google.SCOPES.read, google.SCOPES.write], interactive: true, loginHint: g.email });
    const calendars = await google.listCalendars(token.accessToken);
    google.hold(token);
    await persist((st) => {
      Object.assign(st.sources.google, { calendars, push: true, pushError: null });
      if (!st.sources.google.pushCalendarId) st.sources.google.pushCalendarId = (calendars.find((c) => c.primary) || {}).id || 'primary';
    }, { recalc: false });
    toast('Cadence can now add blocks. Pick which ones on an activity or assignment.');
    pushGoogleBlocks({ quiet: true });
  } catch (e) {
    toast(e.message);
  }
}

/** Turns adding blocks off, and asks whether the blocks already added should
    stay on the calendar or be removed. */
async function disablePush() {
  const res = await sheet(`<h2>Stop adding blocks?</h2>
    <p class="lead">Cadence will stop writing to Google Calendar. Blocks it already added can stay or go.</p>
    <div class="actions"><button class="btn soft" name="op" value="keep">Leave the blocks</button>
      <button class="btn danger-solid" name="op" value="remove">Remove the blocks</button></div>`);
  if (!res) return;
  const g = app.S.sources.google;
  if (res.get('op') === 'remove') await removeBlocks({ quiet: true });
  await persist((st) => { st.sources.google.push = false; }, { recalc: false });
  toast('Stopped');
}

/** Deletes every event Cadence added to the Google calendar it writes to.
    Only events tagged as Cadence's are touched, never the student's own. */
async function removeBlocks({ quiet = false } = {}) {
  const g = app.S.sources.google;
  try {
    const token = await google.freshToken(g, { scopes: [google.SCOPES.read, google.SCOPES.write] });
    const n = await google.removeAllBlocks(token, g.pushCalendarId || 'primary');
    await persist((st) => { st.sources.google.pushed = {}; }, { recalc: false });
    if (!quiet) toast(n ? `Removed ${n} Cadence event${n === 1 ? '' : 's'}` : 'Nothing of Cadence\u2019s was on the calendar');
  } catch (e) {
    if (!quiet) toast(e.message);
  }
}

/** Chooses which Google calendar Cadence writes its blocks to. Only calendars
    the student can edit are offered. */
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

// Buttons on this screen and its sheets, by data-act.
export const actions = {
  'google-push-now': () => pushGoogleBlocks(),
  'google-push-calendar': () => pickPushCalendar(),
  'google-remove-blocks': async () => {
    const res = await sheet(`<h2>Remove Cadence's events from Google Calendar?</h2>
      <p class="lead">Every block Cadence added is deleted from that calendar. Events you made yourself are not touched. Cadence adds its blocks again the next time it syncs, if adding is still on.</p>
      <div class="actions"><button class="btn soft" value="cancel">Keep the events</button><button class="btn danger-solid" name="op" value="yes">Remove events</button></div>`);
    if (res) removeBlocks();
  },
  'push-item-off': (el) => persist((st) => {
    const { id, kind } = el.dataset;
    if (kind === 'commitment') { const c = st.commitments.find((x) => x.id === id); if (c) c.pushToGoogle = false; }
    else if (st.tasks[id]) st.tasks[id].pushToGoogle = false;
  }, { recalc: false }).then(() => pushGoogleBlocks({ quiet: true })),
  'open-calendars': async () => { const { push } = await import('../core.js'); push('calendars'); },
  'canvas-feed-sheet': () => canvasFeedSheet(),
  'google-feed-sheet': () => googleFeedSheet(),
  'google-connect': () => googleConnect(),
  'gmail-connect': () => gmailConnect(),
  'gmail-disconnect': () => gmailDisconnect(),
  'mail-check-now': () => refreshMail({ quiet: false }),
  'mail-get-ai': () => getOnDeviceAI(),
  'google-calendars-sheet': () => googleCalendarsSheet(),
  'source-refresh': (el) => refreshSources({ only: el.dataset.id }),
  // Disconnecting forgets the cached events and any token, but keeps the Google
  // client ID so connecting again does not mean setting it up again.
  'source-disconnect': async (el) => {
    const id = el.dataset.id;
    const res = await sheet(`<h2>Disconnect ${esc(SOURCE_META[id]?.short || 'this calendar')}?</h2>
      <p class="lead">Cadence stops reading it and forgets what it cached. Your plan stays; it just won't schedule around those events any more.</p>
      <div class="actions"><button class="btn soft" value="cancel">Keep it connected</button><button class="btn danger-solid" name="op" value="yes">Disconnect ${esc(SOURCE_META[id]?.short || 'calendar')}</button></div>`);
    if (!res) return;
    if (id === 'google') google.drop();   // the sign-in, held in memory, goes too
    await persist((st) => {
      const keep = id === 'google' ? { clientId: st.sources.google.clientId } : {};
      const link = LINK_FEEDS[id] ? { url: '' } : {};
      st.sources[id] = { ...st.sources[id], ...keep, ...link, enabled: false, events: [], assignments: [], error: null };
    });
    toast('Disconnected');
  },
  'autosync-every': (el) => persist((st) => { st.autoSync.everyMinutes = Number(el.dataset.min); }, { recalc: false })
    .then(() => { chrome?.runtime?.sendMessage?.({ type: 'cadence:arm-autosync' }); toast('Updated'); })
};

// Checkboxes on this screen, by data-act. Both auto-sync changes tell the
// extension, which owns the background timer, to set it again.
export const changeActions = {
  'google-push-toggle': (el) => (el.checked ? enablePush() : disablePush()),
  // Off stops the reading and hides the events found; on reads the inbox again now.
  'mail-toggle': (el) => persist((st) => { st.sources.mail.enabled = el.checked; st.sources.mail.error = null; }, { edit: false })
    .then(() => (el.checked ? refreshMail({ quiet: false }) : toast('Off. Cadence stopped reading your email and hid the events it found.'))),
  'autosync-toggle': (el) => persist((st) => { st.autoSync.enabled = el.checked; }, { recalc: false })
    .then(() => chrome?.runtime?.sendMessage?.({ type: 'cadence:arm-autosync' }))
};
