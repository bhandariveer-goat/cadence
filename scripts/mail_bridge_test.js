// The website's side of the email events (src/panel/mailbridge.js) talking to
// a stand-in extension that runs the real lib/mailShare.js. See
// scripts/fake_site_chrome.js.
// Test-only: refuses to run anywhere but a local dev server, so it can never
// touch a real site's storage (netlify.toml also keeps scripts/ off the live site).
if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) { document.body.textContent = 'This page runs only on a local dev server.'; throw new Error('Not a local dev server'); }
const out = document.getElementById('out');
out.textContent = '';
const results = [];
const log = (s) => { out.textContent += `${s}\n`; };
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); log(`  ok    ${name}`); }
  catch (e) { results.push({ name, ok: false, why: String(e?.message || e) }); log(`  FAIL  ${name}: ${e?.message || e}`); }
}
const eq = (a, b, what = '') => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${what} expected ${y}, got ${x}`); };
const ok = (v, what = 'expected true') => { if (!v) throw new Error(what); };

const { CONFIG } = await import('/src/config.js');
CONFIG.extensionId = 'testextensionid';                 // the bridge is off without one
const store = await import('/src/lib/store.js');
const core = await import('/src/panel/core.js');
const bridge = await import('/src/panel/mailbridge.js');
const Share = await import('/src/lib/mailShare.js');
const M = await import('/src/lib/mailEvents.js');

// ------------------------------------------------- the stand-in extension
const NOW = new Date();
const tomorrow = M.laterDay(M.ymd(NOW), 1);
const wd = (s) => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][M.dayOf(s).getDay()];
const make = (id, start, quote = `Practice on ${wd(tomorrow)} at ${start}pm in the gym.`) => M.validate(
  { title: `Practice ${id}`, date: tomorrow, start: `${12 + Number(start)}:00`, end: '', kind: 'practice', quote },
  { id, text: quote, subject: 'Schedule', fromName: 'Coach Lee', fromKey: 'coach.lee@school.org', receivedMs: +NOW - 3600000 }, NOW, { engine: 'nano' });
let ext;
const resetExt = () => {
  ext = structuredClone(store.DEFAULT_STATE);
  ext.gmail = { enabled: true, email: 'student@gmail.com', error: null, lastRead: null };
  ext.sources.mail = { ...M.blankMail(), enabled: true, events: [make('e1', 4), make('e2', 5)], changedAt: NOW.toISOString() };
};
resetExt();
window.__ext.handler = (msg, sender) => Share.answerSite(msg, sender, {
  origin: 'https://cadenceaiplanning.netlify.app', version: '0.3.0',
  loadState: async () => structuredClone(ext), update: async (fn) => { const s = structuredClone(ext); ext = fn(s) || s; return ext; }
});

// --------------------------------------------------------------- the site
async function seedSite() {
  const st = structuredClone(store.DEFAULT_STATE);
  st.account = { mode: 'local', id: null, email: '', name: 'Sam', createdAt: NOW.toISOString() };
  st.profile.onboarded = true;
  await store.saveState(st);
  core.app.S = await store.loadState();
  window.__ext.reachable = true;
  window.__ext.delays = [];
  window.__ext.calls.length = 0;
}
const siteMail = () => JSON.parse(localStorage.getItem('cadence.state.v1')).sources.mail;

await test('this page is the website: no extension storage, so it asks rather than reads', () => {
  eq([core.inExtension(), typeof chrome.storage], [false, 'undefined']);
});
await test('the website shows the events the extension found', async () => {
  await seedSite();
  await bridge.syncFromExtension();
  const m = siteMail();
  eq([m.enabled, m.fromExtension, m.events.map((e) => e.id)], [true, true, ['mail_e1_0', 'mail_e2_0']]);
  ok(!JSON.stringify(m).includes('coach.lee@school.org'), 'no sender address on the website');
  eq(window.__ext.calls[0], { extensionId: 'testextensionid', message: { type: 'cadence:mail-events' } });
});
await test('an answer to an older question never overwrites a newer one', async () => {
  await seedSite();
  window.__ext.delays = [150, 0];
  const first = bridge.syncFromExtension();             // slow, answered with the old events
  await new Promise((r) => setTimeout(r, 20));
  ext.sources.mail.events = [make('e3', 6)];
  await bridge.syncFromExtension();                     // fast, answered with the new
  await first;
  eq(siteMail().events.map((e) => e.id), ['mail_e3_0']);
  resetExt();
});
await test('when the extension cannot be reached, the copy here is cleared', async () => {
  await seedSite();
  await bridge.syncFromExtension();
  window.__ext.reachable = false;
  await bridge.syncFromExtension();
  eq([siteMail().enabled, siteMail().events.length], [false, 0]);
});
await test('switched off, disconnected or reinstalled: the website shows none', async () => {
  for (const change of [(s) => { s.sources.mail.enabled = false; }, (s) => { s.gmail.enabled = false; }, (s) => { s.sources.mail = M.blankMail(); }]) {
    await seedSite();
    resetExt();
    await bridge.syncFromExtension();
    change(ext);
    await bridge.syncFromExtension();
    eq(siteMail().events.length, 0);
  }
  resetExt();
});
await test('a deletion on the website reaches the extension and stays deleted', async () => {
  await seedSite();
  await bridge.syncFromExtension();
  const gone = await core.deleteMailEvent('mail_e1_0');
  ok(gone?.id === 'mail_e1_0', 'deleted');
  ok(ext.sources.mail.dismissed.mail_e1_0, 'the extension remembers it');
  await bridge.syncFromExtension();
  eq(siteMail().events.map((e) => e.id), ['mail_e2_0']);
});
await test('Undo on the website puts it back in both places', async () => {
  eq(await core.undoMailEvent('mail_e1_0'), { ok: true });
  eq(siteMail().events.map((e) => e.id).sort(), ['mail_e1_0', 'mail_e2_0']);
  eq(ext.sources.mail.events.map((e) => e.id).sort(), ['mail_e1_0', 'mail_e2_0']);
});
await test('a deletion the extension never got is put back, and the page is told', async () => {
  await seedSite();
  resetExt();
  await bridge.syncFromExtension();
  window.__ext.reachable = false;
  eq(await bridge.dismissInExtension('mail_e2_0'), null);
  ok(siteMail().events.some((e) => e.id === 'mail_e2_0'), 'still shown here');
  ok(!ext.sources.mail.dismissed?.mail_e2_0, 'not deleted in the extension');
});
await test('an event that is not the shape the extension sends is left out', async () => {
  await seedSite();
  const saved = window.__ext.handler;
  window.__ext.handler = async () => ({ ok: true, enabled: true, updatedAt: null, events: [{ id: 'mail_x_0', source: 'mail', title: '<img src=x onerror=alert(1)>'.repeat(20), start: 'x', end: 'y', mail: {} }, { id: 'gcal_1', source: 'google' }] });
  await bridge.syncFromExtension();
  eq(siteMail().events.length, 0);
  window.__ext.handler = saved;
});
await test('the website keeps only the fields it draws, whatever else an answer carries', async () => {
  await seedSite();
  resetExt();
  const saved = window.__ext.handler;
  window.__ext.handler = async (msg, sender) => {
    const r = await saved(msg, sender);
    if (r?.events) r.events = r.events.map((e) => ({ ...e, extra: 'x', mail: { ...e.mail, fromKey: 'leak@school.org', messageId: 'e1' } }));
    return r;
  };
  await bridge.syncFromExtension();
  window.__ext.handler = saved;
  const s = JSON.stringify(siteMail());
  ok(siteMail().events.length === 2 && !s.includes('leak@school.org') && !s.includes('"extra"') && !s.includes('messageId'), s.slice(0, 300));
});
await test('without an extension ID in src/config.js the website never asks', async () => {
  await seedSite();
  CONFIG.extensionId = '';
  await bridge.syncFromExtension();
  eq(window.__ext.calls.length, 0);
  CONFIG.extensionId = 'testextensionid';
});

const failed = results.filter((r) => !r.ok);
log(`\n${results.length - failed.length} of ${results.length} passed${failed.length ? `; ${failed.length} failed` : ''}.`);
document.title = failed.length ? `FAIL ${failed.length}` : `PASS ${results.length}`;
window.__results = { total: results.length, failed };
