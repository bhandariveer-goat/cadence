// Seeds a signed-in plan with Gmail connected and a few events found in email,
// stands in for Gmail (an empty inbox) and for Chrome's model ("downloadable"),
// then starts the real panel. Test-only: see scripts/panel_preview.html.
import { DEFAULT_STATE, saveState } from '/src/lib/store.js';
import { validate } from '/src/lib/mailEvents.js';

// Test-only: refuses to run anywhere but a local dev server, so it can never
// touch a real site's storage (netlify.toml also keeps scripts/ off the live site).
if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) { document.body.textContent = 'This page runs only on a local dev server.'; throw new Error('Not a local dev server'); }
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url, location.href);
  if (url.hostname !== 'gmail.googleapis.com') return realFetch(input, init);
  const body = url.pathname.endsWith('/profile') ? { emailAddress: 'student@gmail.com' } : { messages: [] };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};
const mode = new URLSearchParams(location.search).get('ai') || 'downloadable';
if (mode !== 'none') globalThis.LanguageModel = { availability: async () => mode, create: async () => ({ prompt: async () => '{"events":[]}', destroy() {} }) };

const day = (n) => { const d = new Date(); d.setHours(8, 0, 0, 0); d.setDate(d.getDate() + n); return d; };
const name = (d) => d.toLocaleDateString('en-US', { weekday: 'long' });
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const msg = (id, text, from, fromKey, subject) => ({ id, text, subject, fromName: from, fromKey, receivedMs: +day(0) });
const events = [
  validate({ title: 'Practice moved to 5pm', date: ymd(day(1)), start: '17:00', end: '18:30', kind: 'practice', quote: `Practice on ${name(day(1))} is moved to 5pm in the gym.` },
    msg('p1', `Hi team, practice on ${name(day(1))} is moved to 5pm in the gym. Bring water.`, 'Coach Lee', 'coach.lee@school.org', 'Schedule change'), day(0), { engine: 'nano' }),
  validate({ title: 'Lab report due', date: ymd(day(3)), start: '', end: '', kind: 'due', quote: `The lab report is due ${name(day(3))}.` },
    msg('l1', `Reminder: the lab report is due ${name(day(3))}. Submit it on Canvas.`, 'Ms. Ortiz', 'ortiz@school.org', 'Chemistry'), day(0), { engine: 'nano' })
].filter(Boolean);

const st = structuredClone(DEFAULT_STATE);
st.account = { mode: 'local', id: null, email: '', name: 'Sam', createdAt: new Date().toISOString() };
st.profile = { ...st.profile, name: 'Sam', onboarded: true, consentedAt: new Date().toISOString(), policySeen: '2026-11-08' };
st.tourSeen = true;
st.gmail = { enabled: true, email: 'student@gmail.com', error: null, lastRead: null };
st.sources.google.clientId = 'test.apps.googleusercontent.com';
st.sources.mail = { ...st.sources.mail, enabled: true, events, lastSync: new Date(Date.now() - 4 * 60000).toISOString(), lastTry: new Date().toISOString(), engine: 'rules' };
await saveState(st);
window.__previewEvents = events.map((e) => e.id);
await import('/src/panel/app.js');
