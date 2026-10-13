// Your account: who is signed in, how your days are shaped, what is connected,
// and the way out. Reached from the avatar in the header.
//
// There is deliberately no "when do you want to work" or "how much a night"
// here. Those are worked out from school, sleep, the calendar and how much is
// due (lib/daymodel.js). What is here is only what Cadence cannot know without
// being told: when school runs and roughly when you sleep.

import { app, persist, push, back, render, insideCanvas, DEMO, signOut, syncDown, STANDALONE, undoTo } from '../core.js';
import { parseICS } from '../../lib/calendar.js';
import { parseCanvasFeed, looksLikeCanvasIcs } from '../../lib/sources/canvasFeed.js';
import { applyImported } from '../../lib/sources/sources.js';
import { aiAvailable } from '../../lib/ai.js';
import { cloudConfigured } from '../../config.js';
import { showUpStreak } from '../../lib/habits.js';
import { fmtMinutes } from '../../lib/util.js';
import {
  svg, I, esc, avatar, sheet, toast, timeSelect, DOW_SHORT, WEEK_ORDER, daysLabel, range, toMin, ago, plural
} from '../ui.js';
import { pageUrl } from './signin.js';

export const STYLES = {
  sprint: { label: 'Short sprints', sub: '25 minutes on, 5 off', max: 25, brk: 5 },
  steady: { label: 'Steady', sub: '45 minutes on, 10 off', max: 45, brk: 10 },
  deep: { label: 'Deep focus', sub: '75 minutes on, 15 off', max: 75, brk: 15 }
};

export function viewAccount() {
  const S = app.S;
  const a = S.account || {};
  const teacher = S.settings.role === 'teacher';
  const streak = showUpStreak(S);
  const style = Object.entries(STYLES).find(([, v]) => v.max === S.settings.sessionMaxMin)?.[1] || STYLES.steady;
  const sc = S.school;
  const row = (act, icon, title, sub, right = svg(I.right, 16), cls = '') => `
    <div class="integration tap ${cls}" data-act="${act}" role="button" tabindex="0">
      <span class="ic">${svg(icon, 18)}</span>
      <div class="grow"><div class="t">${title}</div><div class="m">${sub}</div></div>${right}</div>`;

  return `
    <button class="back" data-act="back">${svg(I.left, 16)} Go back</button>
    <section class="profile">
      ${avatar({ name: a.name || S.profile.name || 'You' }, 56)}
      <div class="grow"><h1>${esc(a.name || S.profile.name || 'You')}</h1>
        <p class="text-2 small">${accountLine(S)}</p></div>
    </section>

    ${DEMO ? '' : a.mode === 'local' && cloudConfigured() ? `<div class="card soft">
      <div class="card-title">Use the same week everywhere</div>
      <div class="card-sub">Right now your plan lives in this browser only. Add an email and the Chrome extension and the website stay in step.</div>
      <button class="btn primary small mt3" data-act="account-add-email">Add an email</button></div>` : ''}
    ${!DEMO && a.mode === 'cloud' && app.cloud && !app.cloud.signedIn ? `<div class="card warm">
      <div class="card-title">You have been signed out on this device</div>
      <div class="card-sub">Your plan is still here, but changes are not being saved to your account. Sign in again with ${esc(a.email || 'your email')} to pick up where you left off.</div>
      <button class="btn primary small mt3" data-act="account-add-email">Sign in again</button></div>`
    : S.cloud?.error ? `<div class="card warm small" role="status">Your latest changes are saved on this device but have not reached your account. ${esc(S.cloud.error)} <button class="link" data-act="account-sync">Try again</button></div>` : ''}

    ${teacher ? '' : `
    <div class="section-head"><h2>Your days</h2></div>
    <div class="card flush">
      ${row('school-sheet', I.school, 'School', `${esc(daysLabel(sc.days))}, ${esc(range(sc.start, sc.end))}`)}
      ${row('sleep-sheet', I.clock, 'Sleep', `Up around ${esc(clockOf(S.sleep.wake))}, in bed around ${esc(clockOf(S.sleep.bed))}`)}
      ${row('style-sheet', I.target, 'How you work', `${esc(style.label)}: ${esc(style.sub)}`)}
    </div>
    <p class="hint">Cadence plans work in the time these leave, day by day. For a one-off change, tell the assistant: “no school Friday” or “I’m tired, an hour tonight”.</p>`}

    <div class="section-head"><h2>Connected</h2></div>
    <div class="card flush">
      ${row('open-calendars', I.cal, 'Calendars', calendarsSummary())}
      ${teacher ? '' : row('ics-sheet', I.file, 'Import a calendar file', importSummary(S))}
      <div class="integration"><span class="ic">${svg(I.canvas, 18)}</span>
        <div class="grow"><div class="t">Canvas</div><div class="m">${insideCanvas ? 'Assignments come in automatically' : 'Comes in through the Chrome extension'}</div></div>
        ${insideCanvas ? `<span class="status">${S.lastSync ? `Synced ${ago(S.lastSync)}` : 'Connected'}</span>` : `<span class="text-2 small">${DEMO ? 'Sample data' : 'Not on this page'}</span>`}</div>
      ${row('ai-sheet', I.chat, 'Assistant', assistantLine(S), aiAvailable(S.settings) ? '<span class="status">Own key</span>' : svg(I.right, 16))}
    </div>

    <div class="section-head"><h2>Preferences</h2></div>
    <div class="card flush">
      <label class="integration toggle"><span class="ic">${svg(I.bell, 18)}</span>
        <span class="grow"><span class="t block">Reminders</span><small>A nudge before each block and check-in</small></span>
        <input type="checkbox" data-act="set-toggle" data-key="remindersEnabled" ${S.settings.remindersEnabled ? 'checked' : ''}><i></i></label>
      ${window.CadenceTheme ? row('theme-sheet', window.CadenceTheme.current() === 'dark' ? I.moon : I.sun, 'Appearance', themeLine()) : ''}
      ${row('role', I.swap, teacher ? 'Switch to student view' : 'Teacher and club leader tools', teacher ? 'Plan your own week' : 'Draft assignments by voice, run a club')}
    </div>

    ${DEMO ? '' : `<div class="section-head"><h2>Account</h2></div>
    <div class="card flush">
      ${row('account-signout', I.left, 'Sign out', a.mode === 'cloud' ? 'Your plan stays saved to your account' : 'Removes your plan from this browser')}
    </div>
    <div class="card flush danger-zone">
      ${row('account-delete', I.x, a.mode === 'cloud' ? 'Delete account' : 'Delete my data', a.mode === 'cloud' ? 'Erases your account and everything saved to it' : 'Erases everything Cadence holds in this browser', svg(I.right, 16), 'danger')}
    </div>`}

    <p class="page-foot">
      <a href="${esc(pageUrl('privacy.html'))}" target="_blank" rel="noopener">Privacy</a>
      <a href="${esc(pageUrl('terms.html'))}" target="_blank" rel="noopener">Terms</a>
      ${contactLink()}</p>`;
}

/** The way to reach whoever runs this copy of Cadence: the contact page. */
export const contactLink = () => `<a href="${esc(pageUrl('contact.html'))}" target="_blank" rel="noopener">Contact</a>`;

const THEMES = {
  light: { label: 'Light', sub: '' },
  dark: { label: 'Dark', sub: '' },
  system: { label: 'Match this device', sub: 'Follows the light or dark setting of your computer or phone' }
};

function themeLine() {
  const T = window.CadenceTheme;
  const pref = T.preference();
  return pref === 'system' ? `Matching this device, which is ${T.current()} right now` : THEMES[pref].label;
}

async function themeSheet() {
  const T = window.CadenceTheme;
  if (!T) return;
  const pref = T.preference();
  const res = await sheet(`
    <h2>Appearance</h2>
    <p class="lead">This choice is kept in this browser. It is not part of your plan and is not saved to your account.</p>
    <div class="choices stacked">${Object.entries(THEMES).map(([id, v]) =>
      `<button class="choice" name="theme" value="${id}" aria-pressed="${pref === id}">${v.label}${v.sub ? `<small>${v.sub}</small>` : ''}</button>`).join('')}</div>
    <div class="actions"><button class="btn ghost" value="cancel">Cancel</button></div>`);
  const pick = res?.get('theme');
  if (!THEMES[pick]) return;
  T.set(pick);
  render();
}

const clockOf = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); const ap = h >= 12 ? 'pm' : 'am'; const hr = h % 12 || 12; return m ? `${hr}:${String(m).padStart(2, '0')}${ap}` : `${hr}${ap}`; };

function accountLine(S) {
  const a = S.account || {};
  if (DEMO) return 'Demo account with sample data';
  if (a.mode === 'cloud') return `${esc(a.email)}${S.cloud?.pushedAt ? ` · saved ${ago(S.cloud.pushedAt)}` : ''}`;
  return 'This browser only';
}

function assistantLine(S) {
  if (aiAvailable(S.settings)) return 'Using your own Anthropic key';
  if (S.account?.mode === 'cloud') return 'Included with your account';
  return 'Understands plain sentences. Add a key or sign in with email for the full assistant.';
}

/** One line summarising which calendars are connected. */
function calendarsSummary() {
  const src = app.S.sources || {};
  const on = Object.entries(src).filter(([, s]) => s.enabled);
  if (!on.length) return 'Connect Canvas and Google Calendar';
  const broken = on.find(([, s]) => s.error);
  if (broken) return 'One calendar needs attention';
  const last = on.map(([, s]) => s.lastSync).filter(Boolean).sort().at(-1);
  return `${on.length === 1 ? '1 calendar' : `${on.length} calendars`} connected${last ? ` · synced ${ago(last)}` : ''}`;
}


// ------------------------------------------------------------ day shape

async function schoolSheet() {
  const sc = app.S.school;
  const res = await sheet(`
    <h2>School</h2>
    <p class="lead">Cadence keeps these hours clear and starts planning work after the last bell. Days without school open up from the morning.</p>
    <div class="q mt0">School days</div>
    <div class="daypick">${WEEK_ORDER.map((d) => `<label><input type="checkbox" name="day" value="${d}" ${sc.days.includes(d) ? 'checked' : ''}><span>${DOW_SHORT[d]}</span></label>`).join('')}</div>
    <div class="field mt4"><span>Hours</span><div class="pair">${timeSelect('start', sc.start)}<span class="to">to</span>${timeSelect('end', sc.end)}</div></div>
    <div class="actions"><button class="btn ghost" value="cancel">Cancel</button><button class="btn primary" name="op" value="save">Save changes</button></div>`);
  if (!res) return;
  const days = res.getAll('day').map(Number);
  const start = String(res.get('start')), end = String(res.get('end'));
  if (toMin(end) <= toMin(start)) return toast('School has to end after it starts');
  await persist((st) => { Object.assign(st.school, { days, start, end }); });
  toast('Updated. Your plan moved with it.');
}

async function sleepSheet() {
  const sl = app.S.sleep;
  const res = await sheet(`
    <h2>Sleep</h2>
    <p class="lead">Roughly when you are up and when you are in bed. Nothing gets planned in the last half hour before bed.</p>
    <div class="field"><span>Up around</span>${timeSelect('wake', sl.wake)}</div>
    <div class="field"><span>In bed around</span>${timeSelect('bed', sl.bed)}</div>
    <div class="actions"><button class="btn ghost" value="cancel">Cancel</button><button class="btn primary" name="op" value="save">Save changes</button></div>`);
  if (!res) return;
  await persist((st) => { st.sleep = { wake: String(res.get('wake')), bed: String(res.get('bed')) }; });
  toast('Updated. Your plan moved with it.');
}

async function styleSheet() {
  const current = Object.entries(STYLES).find(([, v]) => v.max === app.S.settings.sessionMaxMin)?.[0] || 'steady';
  const res = await sheet(`
    <h2>How you work</h2>
    <p class="lead">How long a block runs before a break.</p>
    <div class="choices stacked">${Object.entries(STYLES).map(([id, v]) =>
      `<button class="choice" name="style" value="${id}" aria-pressed="${current === id}">${v.label}<small>${v.sub}</small></button>`).join('')}</div>
    <div class="actions"><button class="btn ghost" value="cancel">Cancel</button></div>`);
  const pick = res?.get('style');
  if (!STYLES[pick]) return;
  await persist((st) => {
    st.settings.sessionMaxMin = STYLES[pick].max;
    st.settings.breakMin = STYLES[pick].brk;
    st.settings.sessionMinMin = Math.min(20, STYLES[pick].max);
  });
  toast('Updated. Your plan moved with it.');
}

// ---------------------------------------------------------------- imports

/** What the settings row says under "Import a calendar file". */
function importSummary(S) {
  const events = (S.busy || []).filter((b) => b.source === 'ics').length;
  const cf = S.sources?.canvasFeed;
  const canvas = cf?.fromFile ? (cf.assignments?.length || 0) : 0;
  if (canvas) return `${plural(canvas, 'Canvas assignment')} from a file${events ? `, ${events} events` : ''}`;
  if (events) return `${events} events from a file`;
  return 'Canvas export, or a one-off .ics';
}

async function icsSheet() {
  const count = (app.S.busy || []).filter((b) => b.source === 'ics').length;
  const canvasCount = (app.S.sources?.canvasFeed?.fromFile && app.S.sources.canvasFeed.assignments?.length) || 0;
  const res = await sheet(`
    <h2>Import your calendar</h2>
    <p class="lead">Canvas exports come in as assignments to schedule. Everything else (appointments, games, trips) is kept clear so nothing lands on top of it.</p>
    <div class="card soft small m0">
      <b>Canvas</b><div class="muted mb2">Calendar → Calendar Feed → open the link, then save the page</div>
      <b>Google Calendar</b><div class="muted mb2">Settings → Import &amp; export → Export, then unzip</div>
      <b>Apple Calendar</b><div class="muted">File → Export → Export…</div></div>
    <label class="btn soft block mt3">Choose calendar file (.ics)<input type="file" accept=".ics,text/calendar" hidden data-file></label>
    <div class="small muted center mt2" data-filename></div>
    <div class="actions">${count || canvasCount ? '<button class="btn soft danger" name="op" value="clear">Remove imported events</button>' : '<button class="btn ghost" value="cancel">Cancel</button>'}
      <button class="btn primary" name="op" value="import">Import calendar</button></div>`, {
    onMount(form) {
      form.querySelector('[data-file]').addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        form.dataset.ics = await file.text();
        form.querySelector('[data-filename]').textContent = file.name;
      });
    }
  });
  if (!res) return;
  const form = document.getElementById('sheet-form');
  if (res.get('op') === 'clear') {
    const snap = structuredClone(app.S);
    await persist((st) => {
      st.busy = st.busy.filter((b) => b.source !== 'ics');
      if (st.sources?.canvasFeed?.fromFile && !st.sources.canvasFeed.url) st.sources.canvasFeed.enabled = false;
    });
    return toast('Imported events removed', undoTo(snap));
  }
  const text = form.dataset.ics || '';
  delete form.dataset.ics;
  if (!text) return toast('Choose a calendar file first, then import it.');
  if (!text.includes('BEGIN:VEVENT')) return toast('No events were found in that file. Export it again as .ics and try once more.');
  const horizonDays = (app.S.settings.lookaheadDays ?? 14) + 30;

  // A Canvas export needs the Canvas parser: its assignments are zero-length
  // events at the due time, which the generic parser would file as busy time.
  if (looksLikeCanvasIcs(text)) {
    const { assignments, events } = parseCanvasFeed(text, { horizonDays: Math.max(horizonDays, 120) });
    if (!assignments.length && !events.length) return toast('No upcoming Canvas items in that file');
    await persist((st) => applyImported(st, 'canvasFeed', { assignments, events }));
    return toast(assignments.length
      ? `${plural(assignments.length, 'assignment')} imported. Scheduling them now.`
      : `${plural(events.length, 'Canvas event')} imported`);
  }

  const events = parseICS(text, { horizonDays });
  if (!events.length) return toast('No upcoming events in that file');
  await persist((st) => { const seen = new Set(st.busy.map((b) => b.id)); for (const e of events) if (!seen.has(e.id)) st.busy.push(e); });
  toast(`${events.length} events imported`);
}

async function aiSheet() {
  const s = app.S.settings;
  const res = await sheet(`
    <h2>Assistant</h2>
    <p class="lead">The assistant already reads plain sentences on its own. With an Anthropic API key it uses Claude for messier ones, and writes the summary and steps on each assignment from the full instructions.</p>
    <div class="field"><label for="ai-key">Anthropic API key</label>
      <div class="with-btn"><input type="password" id="ai-key" name="key" value="${esc(s.apiKey || '')}" placeholder="Starts with sk-ant-" autocomplete="off" spellcheck="false">
        <button type="button" class="btn soft" data-reveal="ai-key" data-what="the key" aria-label="Show the key">Show</button></div></div>
    <p class="hint up">Kept on this device and sent only to Anthropic. It is not saved to your Cadence account. Using it is billed to whoever owns the key.</p>
    <label class="toggle"><input type="checkbox" name="on" ${s.useAI || !s.apiKey ? 'checked' : ''}><i></i><span>Use Claude with this key</span></label>
    <div class="actions"><button class="btn ghost" value="cancel">Cancel</button><button class="btn primary" name="op" value="save">Save changes</button></div>`);
  if (!res) return;
  const key = String(res.get('key') || '').trim();
  const on = res.get('on') === 'on' && !!key;
  await persist((st) => { st.settings.apiKey = key; st.settings.useAI = on; if (on) for (const t of Object.values(st.tasks)) { t.aiEstimatedAt = null; t.guideAI = null; } }, { recalc: false });
  toast(on ? 'Claude is on for the assistant' : 'Back to reading sentences on this device');
}


// ----------------------------------------------------------------- leaving

async function signOutFlow() {
  const cloud = app.S.account?.mode === 'cloud';
  const res = await sheet(`<h2>${cloud ? `Sign out of ${esc(app.S.account.email || 'your account')}?` : 'Sign out and erase this plan?'}</h2>
    <p class="lead">${cloud
      ? 'Your plan stays saved to your account. This browser forgets it until you sign back in.'
      : 'This account only exists in this browser, so signing out erases the plan, activities and check-ins stored here. There is no copy to sign back in to.'}</p>
    <div class="actions"><button class="btn soft" value="cancel">Stay signed in</button>
      <button class="btn ${cloud ? 'primary' : 'danger-solid'}" name="op" value="out">${cloud ? 'Sign out' : 'Sign out and erase'}</button></div>`);
  if (res?.get('op') !== 'out') return;
  try {
    await signOut({ wipe: true });
  } catch (e) {
    if (!e.unsaved) return toast(e.message);
    // The account does not have the latest changes, and signing out erases
    // this browser's copy. Say so before anything is lost.
    const again = await sheet(`<h2>Your latest changes are not saved yet</h2>
      <p class="lead">Cadence could not save your most recent changes to your account, so right now they exist only in this browser. Signing out erases them.</p>
      <div class="actions"><button class="btn soft" value="cancel">Stay signed in</button>
        <button class="btn danger-solid" name="op" value="out">Sign out and lose them</button></div>`);
    if (again?.get('op') !== 'out') return;
    await signOut({ wipe: true, force: true });
  }
  toast('Signed out');
}

async function deleteFlow() {
  const cloud = app.S.account?.mode === 'cloud';
  // Named, with what goes and that it is final. The way out has focus when
  // it opens, so Enter on a slip of the hand keeps everything.
  const res = await sheet(`<h2>${cloud ? `Delete the account for ${esc(app.S.account.email || 'this email')}?` : 'Delete your plan in this browser?'}</h2>
    <p class="lead">${cloud
      ? 'This permanently erases the saved plan, your check-ins, and anything shared with partners or clubs. It cannot be undone.'
      : 'This permanently erases every assignment, activity and check-in Cadence holds here. There is no other copy. It cannot be undone.'}</p>
    <div class="actions"><button class="btn soft" value="cancel">Keep my data</button><button class="btn danger-solid" name="op" value="delete">${cloud ? 'Delete account' : 'Delete my data'}</button></div>`);
  if (res?.get('op') !== 'delete') return;
  if (cloud) {
    // The account itself can only be erased while signed in to it. Wiping
    // this browser and saying "Deleted" would leave the account in place.
    if (!app.cloud?.signedIn) return toast('Sign in again first. Cadence has to reach your account to delete it.');
    try { await app.cloud.rest('rpc/delete_my_account', { method: 'POST', body: {} }); }
    catch (e) { return toast(`Nothing was deleted. ${e.message} Try again in a moment.`); }
  }
  await signOut({ wipe: true, force: true });
  toast('Deleted');
}

function addEmail() {
  // Keep the plan on this device and attach it to an email account. The
  // account that is here stays signed in until the new sign-in succeeds, so
  // backing out, or a code that fails, leaves everything as it was.
  app.signin = { step: 'start', name: app.S.account?.name || '', email: app.S.account?.email || '', upgrading: true };
  render();
}

export const actions = {
  'open-account': () => { if (app.view !== 'account') push('account'); },
  'school-sheet': () => schoolSheet(),
  'sleep-sheet': () => sleepSheet(),
  'style-sheet': () => styleSheet(),
  'ics-sheet': () => icsSheet(),
  'ai-sheet': () => aiSheet(),
  'theme-sheet': () => themeSheet(),
  'account-signout': () => signOutFlow(),
  'account-delete': () => deleteFlow(),
  'account-add-email': () => addEmail(),
  'account-sync': () => syncDown().then(() => toast(app.S.cloud?.error ? 'Still not reaching your account. Check your connection and try again.' : 'Saved to your account')),
  role: () => {
    const next = app.S.settings.role === 'teacher' ? 'student' : 'teacher';
    app.stack = [];
    app.view = next === 'teacher' ? 'create' : 'today';
    return persist((st) => { st.settings.role = next; }, { recalc: false });
  }
};

export const changeActions = {
  'set-toggle': (el) => persist((st) => { st.settings[el.dataset.key] = el.checked; }, { recalc: false })
};
