// Tests for anonymous usage counts: the browser side and the real server
// function, with fetch standing in for the network and the database.
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
const M = await import('/src/lib/metrics.js');
const { POLICY_CHANGE } = await import('/src/lib/policy.js');
const KEY = 'cadence.usage.v1';

// ------------------------------------------------------------ the network
const sent = [];
let reply = 204;
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url, location.href);
  if (url.pathname === '/api/metric') {
    sent.push({ url: url.href, method: init.method, body: init.body ? JSON.parse(init.body) : null, keepalive: !!init.keepalive });
    return new Response(null, { status: reply });
  }
  return realFetch(input, init);
};

const NOW = new Date('2026-11-09T10:00:00');
const plan = (o = {}) => ({
  profile: { onboarded: true, consentedAt: '2026-11-01T00:00:00.000Z', policySeen: POLICY_CHANGE.date, ...(o.profile || {}) },
  tasks: o.tasks || {}, commitments: o.commitments || [], checkins: o.checkins || [], sources: o.sources || {}
});
const slot = () => JSON.parse(localStorage.getItem(KEY) || 'null');
const reset = () => { localStorage.removeItem(KEY); sent.length = 0; reply = 204; };

ok(M.usageConfigured(), 'countUsage is on in src/config.js and the Supabase project is set (these tests need both)');

// ----------------------------------------------------------- what to send
log('What is counted');
await test('a new person who has finished setup sends one daily word and one milestone, each a bare word with a random ID', async () => {
  reset();
  await M.noteUsage(plan(), { now: NOW });
  eq(sent.map((s) => s.body.event), ['active', 'onboarded']);
  ok(sent.every((s) => Object.keys(s.body).sort().join() === 'event,id'), `only id and event: ${JSON.stringify(sent.map((s) => Object.keys(s.body)))}`);
  ok(sent.every((s) => /^[0-9a-f-]{36}$/.test(s.body.id) && s.body.id === sent[0].body.id), 'one random ID');
  ok(sent.every((s) => s.url.endsWith('/api/metric') && s.method === 'POST' && s.keepalive));
});
await test('the same day again sends nothing; a new day sends only "active"', async () => {
  sent.length = 0;
  await M.noteUsage(plan(), { now: NOW });
  eq(sent.length, 0);
  await M.noteUsage(plan(), { now: new Date('2026-11-10T09:00:00') });
  eq(sent.map((s) => s.body.event), ['active']);
});
await test('milestones follow the plan, once each: work, a check-in, a calendar', async () => {
  await M.noteUsage(plan({ commitments: [{ id: 'c', title: 'SECRET TITLE', archived: false }] }), { now: new Date('2026-11-10T11:00:00') });
  await M.noteUsage(plan({ commitments: [{ id: 'c', archived: false }], checkins: [{ id: 'k' }], sources: { canvasFeed: { enabled: true } } }), { now: new Date('2026-11-10T12:00:00') });
  await M.noteUsage(plan({ commitments: [{ id: 'c', archived: false }], checkins: [{ id: 'k' }], sources: { canvasFeed: { enabled: true } } }), { now: new Date('2026-11-10T13:00:00') });
  eq(sent.map((s) => s.body.event), ['active', 'has_work', 'checked_in', 'connected']);
  ok(!JSON.stringify(sent).includes('SECRET TITLE'), 'no title ever leaves');
});
await test('Gmail and the events found in email never count as a connection', () => {
  eq(M.milestones(plan({ sources: { mail: { enabled: true } } })), ['onboarded']);
  eq(M.milestones({ ...plan(), gmail: { enabled: true, email: 'a@b.c' } }), ['onboarded']);
  eq(M.milestones(plan({ sources: { google: { enabled: true } } })).includes('connected'), true);
  eq(M.milestones(plan({ commitments: [{ archived: true }] })).includes('has_work'), false);
});

// ---------------------------------------------------------------- consent
log('\nWhen it must not count');
for (const [what, state, opts] of [
  ['the demo', plan(), { demo: true }],
  ['before the terms were agreed', plan({ profile: { consentedAt: null } }), {}],
  ['before the notice was seen', plan({ profile: { policySeen: '2026-11-01' } }), {}]
]) {
  await test(`nothing is sent in ${what}`, async () => { reset(); await M.noteUsage(state, { now: NOW, ...opts }); eq([sent.length, slot()], [0, null]); });
}
await test('nothing is sent when src/config.js has counting off', async () => {
  reset();
  CONFIG.site.countUsage = false;
  try { await M.noteUsage(plan(), { now: NOW }); eq([sent.length, M.usageConfigured()], [0, false]); } finally { CONFIG.site.countUsage = true; }
});

// ------------------------------------------------------------- failures
log('\nFailures');
await test('a failed send is not marked sent, shows nothing and is tried again', async () => {
  reset();
  reply = 503;
  await M.noteUsage(plan(), { now: NOW });
  eq(Object.keys(slot().sent), [], 'nothing marked sent');
  reply = 204; sent.length = 0;
  await M.noteUsage(plan(), { now: NOW });
  eq(sent.map((s) => s.body.event), ['active', 'onboarded']);
});
await test('an unreachable server is dropped quietly', async () => {
  reset();
  const saved = window.fetch;
  window.fetch = async (input, init) => { if (String(input.url || input).includes('/api/metric')) throw new TypeError('offline'); return saved(input, init); };
  try { await M.noteUsage(plan(), { now: NOW }); eq(Object.keys(slot().sent), []); } finally { window.fetch = saved; }
});

// --------------------------------------------------------------- the switch
log('\nThe person\'s say');
await test('turning counts off asks the server to forget, deletes the ID, and stops counting', async () => {
  reset();
  await M.noteUsage(plan(), { now: NOW });
  const id = slot().id;
  sent.length = 0;
  eq(await M.setUsage(false), { forgotten: true });
  eq(sent.map((s) => s.body), [{ id, event: 'forget' }]);
  eq(slot(), { id: '', off: true, sent: {} });
  sent.length = 0;
  await M.noteUsage(plan(), { now: new Date('2026-11-12T10:00:00') });
  eq(sent.length, 0);
  eq(await M.usageIsOn(), false);
});
await test('turning off says so when the server could not be reached', async () => {
  reset();
  await M.noteUsage(plan(), { now: NOW });
  reply = 503;
  eq(await M.setUsage(false), { forgotten: false });
  eq(slot().off, true, 'still off here');
});
await test('turning back on starts with a new ID', async () => {
  reset();
  await M.noteUsage(plan(), { now: NOW });
  const before = slot().id;
  await M.setUsage(false); await M.setUsage(true);
  sent.length = 0;
  await M.noteUsage(plan(), { now: NOW });
  ok(sent.length && sent[0].body.id !== before, 'a different ID');
});
await test('sign out and Delete my data forget the rows and remove the slot', async () => {
  reset();
  await M.noteUsage(plan(), { now: NOW });
  const id = slot().id;
  sent.length = 0;
  await M.forgetUsage();
  eq([sent.map((s) => s.body), slot()], [[{ id, event: 'forget' }], null]);
});
await test('a damaged slot is read as empty, never trusted', async () => {
  reset();
  localStorage.setItem(KEY, JSON.stringify({ id: 'not-a-uuid', off: 'yes', sent: [1] }));
  await M.noteUsage(plan(), { now: NOW });
  ok(/^[0-9a-f-]{36}$/.test(slot().id), 'a new ID was made');
});


// ----------------------------------------------- how the app is used (records)
log('\nRecords of how the app is used');
const settle = () => new Promise((r) => setTimeout(r, 0));
const allow = async (st = plan()) => { M.allowDetail(st); await settle(); return M.allowDetail(st); };
await test('nothing is kept before the terms are agreed, before the notice, in the demo, or with the switch off', async () => {
  reset();
  eq(await allow(plan({ profile: { consentedAt: null } })), false, 'not agreed');
  eq(M.track('click', 'tab:today'), false);
  eq(await allow(plan({ profile: { policySeen: '2000-01-01' } })), false, 'notice not seen');
  M.allowDetail(plan(), { demo: true });
  eq(M.detailAllowed(), false, 'demo');
  localStorage.setItem(KEY, JSON.stringify({ id: '', off: true, sent: {} }));
  await M.usageIsOn();
  eq(M.allowDetail(plan()), false, 'switched off');
  reset();
  await M.usageIsOn();
  eq(M.allowDetail(plan()), true, 'agreed, seen, on');
});
await test('a record keeps only its order, kind, name, screen and a whole number, and goes in a batch with a visit ID', async () => {
  reset(); await M.usageIsOn(); M.allowDetail(plan());
  ok(M.track('click', 'tab:today', { screen: 'today', value: 12.6 }));
  eq(M.track('keystroke', 'x'), false, 'unknown kind');
  eq(M.track('click', 'Hello World'), false, 'a name with spaces or capitals');
  eq(M.track('click', 'ab@c.d'), false, 'a name with other characters');
  ok(M.track('screen', 'today', { screen: 'Not A Screen', value: -5 }));
  await M.flush();
  eq(sent.length, 1);
  const b = sent[0].body;
  eq(Object.keys(b).sort(), ['events', 'id', 'session']);
  ok(/^[0-9a-f-]{36}$/.test(b.id) && /^[0-9a-f-]{36}$/.test(b.session) && b.id !== b.session, 'two random IDs');
  eq(b.events.map(({ q, ...r }) => r), [{ k: 'click', n: 'tab:today', s: 'today', v: 13 }, { k: 'screen', n: 'today', v: 0 }]);
  ok(b.events[1].q > b.events[0].q, 'in order');
  eq(slot().id, b.id, 'the same ID as the counts');
});
await test('a batch that fails stays for the next try; one that works is not sent twice', async () => {
  sent.length = 0;
  M.track('click', 'complete', { screen: 'plan' });
  reply = 500; await M.flush(); reply = 204;
  eq(sent.length, 1);
  await M.flush(); await M.flush();
  eq(sent.length, 2);
  eq(sent[1].body.events.map((e) => e.n), ['complete']);
});
await test('turning usage data off drops what is waiting and keeps nothing more', async () => {
  sent.length = 0;
  M.track('click', 'week-shift');
  await M.setUsage(false);
  eq(M.track('click', 'week-today'), false);
  await M.flush();
  eq(sent.map((s) => s.body.event || 'batch'), ['forget']);
  eq(M.allowDetail(plan()), false);
  await M.setUsage(true);
});
await test('time to a milestone is measured in seconds from agreeing to the terms', async () => {
  reset(); await M.usageIsOn();
  const st = plan({ profile: { consentedAt: new Date(NOW - 90 * 1000).toISOString() } });
  M.allowDetail(st);
  await M.noteUsage(st, { now: NOW });
  await M.flush();
  const recs = sent.filter((s) => s.body.events).flatMap((s) => s.body.events);
  eq(recs.map(({ k, n, v }) => [k, n, v]), [['milestone', 'onboarded', 90]]);
});

log('\nThe sign-up screen (no ID)');
await test('a sign-up step goes with no ID at all, once per page load', async () => {
  reset();
  ok(await M.countStep('signin:shown'));
  eq(sent.map((s) => s.body), [{ steps: ['signin:shown'] }]);
  eq(await M.countStep('signin:shown'), false, 'once per load');
  eq(sent.length, 1);
});
await test('only the four steps, never in the demo, and not where usage data was turned off', async () => {
  reset();
  eq(await M.countStep('signin:email'), false);
  eq(await M.countStep('signin:started', { demo: true }), false);
  localStorage.setItem(KEY, JSON.stringify({ id: '', off: true, sent: {} }));
  eq(await M.countStep('signin:done'), false);
  eq(sent.length, 0);
  reset();
});

log('\nWhat a press is called (src/panel/insight.js)');
const I = await import('/src/panel/insight.js');
const el = (html) => { const d = document.createElement('div'); d.innerHTML = html.trim(); document.body.appendChild(d); return d.firstElementChild; };
await test('a control is named from the code, never from its words or what is in it', async () => {
  eq(I.controlName(el('<button data-act="tab" data-tab="calendar">My secret words</button>')), 'tab:calendar');
  eq(I.controlName(el('<button data-act="ob-pick" data-kind="sport">Soccer with Sam</button>')), 'ob-pick:sport');
  eq(I.controlName(el('<input name="email" value="kid@school.org">')), 'field:email');
  const form = el('<form data-form="quick-add"><input value="Essay on my family"><button type="submit">Add</button></form>');
  eq(I.controlName(form.querySelector('input')), 'field:quick-add');
  eq(I.controlName(form.querySelector('button')), 'button:quick-add');
  eq(I.controlName(el('<a href="/privacy.html">Read it</a>')), 'link:privacy');
  eq(I.controlName(el('<a href="https://example.com/x?name=Sam">x</a>')), 'link:external');
  eq(I.controlName(el('<span role="button">Something</span>')), 'span');
});
await test('nothing about email is ever named', async () => {
  for (const act of ['gmail-connect', 'gmail-disconnect', 'mail-toggle', 'open-mail-event', 'mail-check-now', 'mail-get-ai']) eq(I.controlName(el(`<button data-act="${act}">x</button>`)), '', act);
  // An email address field is not email, and is named like any other field.
  eq(I.controlName(el('<input name="email" value="kid@school.org">')), 'field:email');
  eq(I.controlName(el('<button data-act="account-add-email">Add</button>')), 'account-add-email');
});
await test("requests are timed by Cadence's own names only, and this data's own requests not at all", async () => {
  eq(I.requestName('/api/agent'), 'api:agent');
  eq(I.requestName('/api/canvas-feed?url=secret'), 'api:canvas-feed');
  eq(I.requestName('/api/metric'), '');
  eq(I.requestName('https://abc.supabase.co/rest/v1/rpc/bump_agent_usage'), 'db:rpc:bump_agent_usage');
  eq(I.requestName('https://abc.supabase.co/rest/v1/planner_state?select=*'), 'db:rest');
  eq(I.requestName('https://abc.supabase.co/auth/v1/token'), 'db:auth');
  eq(I.requestName('https://gmail.googleapis.com/gmail/v1/users/me/messages'), '');
  eq(I.requestName('https://canvas.example.edu/feeds/calendars/user_x.ics'), '');
});
await test('names are made of code characters only', async () => {
  eq(I.codeName('Hello World!'), 'hello-world');
  eq(I.codeName('setup:activities'), 'setup:activities');
  eq(I.codeName('---'), '');
});

// ------------------------------------------------- the real server function
log('\nThe server function (netlify/functions/metric.mjs, database stubbed)');
globalThis.process = { env: { SUPABASE_URL: 'https://db.example.test', SUPABASE_KEY: 'sb_publishable_testtesttesttesttest' } };
const fn = (await import('/netlify/functions/metric.mjs')).default;
const rpcCalls = [];
window.fetch = async (input, init = {}) => {
  const url = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url, location.href);
  if (url.hostname === 'db.example.test') { rpcCalls.push({ path: url.pathname, headers: init.headers, body: JSON.parse(init.body) }); return new Response(null, { status: reply === 502 ? 500 : 204 }); }
  return realFetch(input, init);
};
const ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
// A browser will not let a script set the Origin header on a Request, so the
// handler is given a plain request with the headers a server would see.
const call = (body, { method = 'POST', origin = 'https://cadenceaiplanning.netlify.app', raw = null, site = 'https://cadenceaiplanning.netlify.app/api/metric' } = {}) => {
  const headers = { 'content-type': 'application/json', ...(origin ? { origin } : {}) };
  return fn({ method, url: site, headers: { get: (k) => headers[String(k).toLowerCase()] ?? null }, text: async () => (raw ?? JSON.stringify(body)) });
};
await test('a good request calls record_usage with the ID and word and answers 204', async () => {
  rpcCalls.length = 0; reply = 204;
  const r = await call({ id: ID, event: 'has_work' });
  eq([r.status, rpcCalls.length, rpcCalls[0].path, rpcCalls[0].body], [204, 1, '/rest/v1/rpc/record_usage', { p_id: ID, p_event: 'has_work' }]);
  eq(rpcCalls[0].headers.apikey.startsWith('sb_publishable_'), true);
});
await test('forget calls forget_usage', async () => {
  rpcCalls.length = 0;
  eq([(await call({ id: ID, event: 'forget' })).status, rpcCalls[0].path, rpcCalls[0].body], [204, '/rest/v1/rpc/forget_usage', { p_id: ID }]);
});
await test('the extension may send; another site may not', async () => {
  rpcCalls.length = 0;
  eq((await call({ id: ID, event: 'active' }, { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' })).status, 204);
  eq((await call({ id: ID, event: 'active' }, { origin: 'https://evil.example' })).status, 403);
  eq((await call({ id: ID, event: 'active' }, { origin: 'null' })).status, 403);
  eq(rpcCalls.length, 1, 'only the allowed one reached the database');
});
await test('anything that is not an ID and one of the six words is refused before the database', async () => {
  rpcCalls.length = 0;
  for (const [body, status] of [
    [{ id: 'nope', event: 'active' }, 400], [{ id: ID, event: 'login' }, 400], [{ id: ID }, 400], [{ event: 'active' }, 400],
    [{ id: ID, event: ['active'] }, 400], [{ id: ID.toUpperCase(), event: 'active' }, 400], [{ id: ID, event: 'active', title: 'x'.repeat(300) }, 400],
    [{ id: ID, event: 'active', pad: 'x'.repeat(13000) }, 413]
  ]) eq((await call(body)).status, status, JSON.stringify(body).slice(0, 60));
  eq((await call(null, { raw: 'not json' })).status, 400);
  eq((await call(null, { method: 'GET' })).status, 405);
  eq(rpcCalls.length, 0);
});
await test('a batch is rebuilt field by field: extra fields and bad records are dropped before the database', async () => {
  rpcCalls.length = 0;
  const SID = '9b2f7c1e-1d2a-4b3c-8d4e-5f6a7b8c9d0e';
  const r = await call({ id: ID, session: SID, events: [
    { q: 0, k: 'click', n: 'tab', s: 'today', v: 5, text: 'what the student typed' },
    { q: 1, k: 'keystroke', n: 'x' }, { q: 2, k: 'click', n: 'Bad Name' }, { q: 3, k: 'click', n: 'tab', v: 1.5 }, 'text'
  ] });
  eq([r.status, rpcCalls.length, rpcCalls[0].path], [204, 1, '/rest/v1/rpc/record_events']);
  eq(rpcCalls[0].body, { p_id: ID, p_session: SID, p_events: [{ q: 0, k: 'click', n: 'tab', s: 'today', v: 5 }] });
});
await test('a batch with nothing that fits reaches nothing; a wrong shape is refused', async () => {
  rpcCalls.length = 0;
  const SID = '9b2f7c1e-1d2a-4b3c-8d4e-5f6a7b8c9d0e';
  eq((await call({ id: ID, session: SID, events: [{ q: 0, k: 'nope', n: 'x' }] })).status, 204);
  eq((await call({ id: ID, session: 'nope', events: [] })).status, 400);
  eq((await call({ id: ID, session: SID, events: [], name: 'Sam' })).status, 400);
  eq((await call({ id: ID, session: SID, events: Array.from({ length: 51 }, (_, q) => ({ q, k: 'click', n: 'tab' })) })).status, 400);
  eq(rpcCalls.length, 0);
});
await test('sign-up steps: up to four of the four names, with nothing else in the body', async () => {
  rpcCalls.length = 0;
  eq((await call({ steps: ['signin:shown', 'signin:started'] })).status, 204);
  eq(rpcCalls.map((c) => [c.path, c.body]), [['/rest/v1/rpc/count_steps', { p_names: ['signin:shown', 'signin:started'] }]]);
  for (const body of [{ steps: ['signin:shown'], id: ID }, { steps: ['signin:email'] }, { steps: [] }, { steps: Array(5).fill('signin:shown') }]) eq((await call(body)).status, 400, JSON.stringify(body));
  eq(rpcCalls.length, 1);
});
await test('a database error is a 502, and nothing about the request is logged', async () => {
  reply = 502;
  const logged = [];
  const saved = console.log; console.log = (...a) => logged.push(a);
  try { eq((await call({ id: ID, event: 'active' })).status, 502); } finally { console.log = saved; reply = 204; }
  eq(logged.length, 0);
});
await test('with no database configured it answers 503', async () => {
  const saved = globalThis.process.env.SUPABASE_URL; globalThis.process.env.SUPABASE_URL = '';
  try { eq((await call({ id: ID, event: 'active' })).status, 503); } finally { globalThis.process.env.SUPABASE_URL = saved; }
});

const failed = results.filter((r) => !r.ok);
log(`\n${results.length - failed.length} of ${results.length} passed${failed.length ? `; ${failed.length} failed` : ''}.`);
document.title = failed.length ? `FAIL ${failed.length}` : `PASS ${results.length}`;
window.__results = { total: results.length, failed };
