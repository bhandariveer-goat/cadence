// First run, after signing in: where your homework comes from, what you do
// outside class, and when is school. Three screens, or two inside Canvas,
// where assignments come in on their own.
//
// The homework screen comes first because a plan with nobody's homework in it
// is a plan nobody comes back to. On the website the Canvas calendar feed is
// one pasted link (fetched through Cadence's server, see
// netlify/functions/canvas-feed.mjs), and it keeps bringing in new work.
//
// It used to be five, and two of them asked when you like to work and how much
// a night. Nobody knows the answer to either, and the answers made every
// Tuesday identical whether or not Tuesday had a meet. Cadence works both out
// from the calendar now (lib/daymodel.js), so the questions are gone.

import { app, persist, render, insideCanvas, syncCanvas, loadCrew, refreshSources, keepStorage } from '../core.js';
import { svg, I, esc, KIND_ICON, daysLabel, range, plural } from '../ui.js';
import { looksLikeFeedUrl } from '../../lib/sources/canvasFeed.js';
import { CONFIG } from '../../config.js';
import { ART, scheduleLabel } from './parts.js';
import { presetCommitment } from './commitments.js';
import { interpret, applyOps } from '../../lib/agent.js';

const TILES = [
  { kind: 'practice', label: 'Music or art', sub: 'Instrument, voice, drawing', title: 'Instrument practice' },
  { kind: 'sport', label: 'A sport', sub: 'Practice, training, meets', title: 'Team practice' },
  { kind: 'club', label: 'A club or team', sub: 'Robotics, debate, MUN', title: 'Club meeting' },
  { kind: 'service', label: 'Volunteering', sub: 'Service hours', title: 'Volunteering' },
  { kind: 'work', label: 'A job', sub: 'Shifts and hours', title: 'Part-time job' },
  { kind: 'study', label: 'College apps', sub: 'Essays, applications', title: 'College essays' },
  { kind: 'project', label: 'A personal project', sub: 'Coding, writing, making', title: 'Personal project' },
  { kind: 'wellness', label: 'Health and fitness', sub: 'Workouts, running', title: 'Workout' }
];

function draft() {
  app.ob ||= { step: 0, picks: [], said: '', feedUrl: '', feedError: '', feedBusy: false };
  return app.ob;
}

/** The screens, in order. Inside Canvas the extension reads assignments itself. */
const steps = () => (insideCanvas ? ['activities', 'school'] : ['homework', 'activities', 'school']);
const stepName = () => steps()[Math.min(draft().step, steps().length - 1)];

const foot = (next, back, style = 'primary') => `<div class="foot">
  ${back ? '<button class="btn ghost" data-act="ob-back">Go back</button>' : ''}
  <button class="btn ${style}" data-act="ob-next">${next}</button></div>`;

export function viewOnboarding() {
  const o = draft();
  const S = app.S;
  const first = String(S.account?.name || S.profile.name || '').split(' ')[0];
  const list = (S.commitments || []).filter((c) => !c.archived);
  const name = stepName();

  if (name === 'homework') return homeworkStep(o, first);

  if (name === 'activities') {
    const greet = o.step === 0 ? `${first ? `Hi ${esc(first)}.` : 'Welcome.'} ` : '';
    return `<div class="ob">
      <h1>${greet}What do you do outside class?</h1>
      <p class="lead">Homework has due dates and teachers. These don't, which is why they are the first thing to slip. Pick what is part of your week and Cadence will plan around it and keep count.</p>
      <div class="tiles">${TILES.map((t) => `<button class="tile k-activity" data-act="ob-pick" data-kind="${t.kind}" aria-pressed="${o.picks.includes(t.kind)}">
        <span class="kind-ic">${svg(KIND_ICON[t.kind])}</span><div><b>${t.label}</b><small>${t.sub}</small></div></button>`).join('')}</div>
      <label class="field mt4"><span>Or say it in your own words</span>
        <textarea data-ob-said rows="2" placeholder="Robotics Monday and Wednesday 3:45 to 5:30">${esc(o.said)}</textarea></label>
      ${foot(o.picks.length || o.said.trim() ? 'Add these to my week' : 'Skip for now', o.step > 0)}
    </div>`;
  }

  const sc = S.school;
  return `<div class="ob">
    <h1>${list.length ? 'Check the details' : 'One last thing'}</h1>
    <p class="lead">${list.length ? 'These are guesses. Tap one to set its days and times.' : 'When is school? Cadence keeps those hours clear and plans work after the last bell.'}</p>
    ${list.length ? `<div class="card flush">
      ${list.map((c) => `<div class="item tap k-activity" data-act="edit-commit" data-id="${c.id}" role="button" tabindex="0">
        <span class="kind-ic">${svg(KIND_ICON[c.kind] || I.star)}</span>
        <div class="grow"><div class="t">${esc(c.title)}</div><div class="m">${esc(scheduleLabel(c, daysLabel))}</div></div>
        ${svg(I.edit, 18)}</div>`).join('')}
      <div class="item tap" data-act="add-commit" role="button" tabindex="0"><span class="kind-ic">${svg(I.plus)}</span>
        <div class="grow"><div class="t">Add another activity</div></div></div>
    </div>` : ''}
    <div class="card flush">
      <div class="item tap" data-act="school-sheet" role="button" tabindex="0">
        <span class="kind-ic k-school">${svg(I.school)}</span>
        <div class="grow"><div class="t">School</div><div class="m">${esc(daysLabel(sc.days))}, ${esc(range(sc.start, sc.end))}</div></div>
        ${svg(I.edit, 18)}</div>
    </div>
    <p class="hint">${insideCanvas
      ? 'Your assignments come in from Canvas on their own.'
      : S.sources?.canvasFeed?.enabled
        ? 'Your Canvas assignments are in, and new ones arrive on their own.'
        : 'You can connect Canvas any time from Calendars in your account, or add assignments yourself.'}</p>
    ${foot('Show me my week', true)}
  </div>`;
}

function homeworkStep(o, first) {
  const cf = app.S.sources?.canvasFeed || {};
  const connected = !!(cf.enabled && cf.url && !cf.error && cf.lastSync);
  const found = (cf.assignments || []).length;
  return `<div class="ob">
    <h1>${first ? `Hi ${esc(first)}.` : 'Welcome.'} Let's bring in your homework.</h1>
    <p class="lead">Cadence plans around what is due. Your Canvas calendar feed is a single link: every due date comes in, and new assignments keep arriving on their own.</p>
    <div class="card soft small m0">
      <b>Where to find it</b>
      <ol class="ob-how">
        <li>Open Canvas in a browser and go to Calendar.</li>
        <li>At the bottom right, choose Calendar Feed and copy the link.</li>
        <li>Paste it below.</li>
      </ol>
      <div class="muted">On a phone, use Canvas in your browser. The Canvas app does not show the feed.</div>
    </div>
    <form class="mt4" data-form="ob-feed" autocomplete="off" novalidate>
      <label class="field"><span>Canvas feed link</span>
        <input type="text" name="url" value="${esc(o.feedUrl || cf.url || '')}" placeholder="https://school.instructure.com/feeds/calendars/user_….ics" spellcheck="false" inputmode="url"></label>
      <p class="hint up">Treat it like a password: anyone with the link can read your Canvas calendar.</p>
      ${o.feedError ? `<p class="field-error" role="alert">${esc(o.feedError)}</p>` : ''}
      <p class="form-success" role="status">${connected ? `Connected. ${found ? `${plural(found, 'assignment')} found, and Cadence is planning them.` : 'Nothing is due right now; new assignments will come in on their own.'}` : ''}</p>
      <button class="btn ${connected ? 'soft' : 'primary'}" type="submit" ${o.feedBusy ? 'aria-busy="true"' : ''}>${o.feedBusy ? 'Connecting…' : connected ? 'Use a different link' : 'Connect Canvas'}</button>
    </form>
    <p class="hint mt4">No Canvas at your school? Skip this. You can add assignments yourself, or tell the assistant something like “bio test Friday”.</p>
    ${extensionOffer()}
    ${foot(connected ? 'Next' : 'Skip for now', false, connected ? 'primary' : 'ghost')}
  </div>`;
}

/** On a computer with Chrome, the extension reads more of Canvas than the feed. Only once it is published. */
function extensionOffer() {
  const url = /^https:\/\/chromewebstore\.google\.com\//.test(CONFIG.site?.extensionUrl || '') ? CONFIG.site.extensionUrl : '';
  if (typeof chrome !== 'undefined' && chrome.runtime?.id) return '';     // this is the extension
  const desktopChrome = /Chrome\//.test(navigator.userAgent) && !/Mobile|Android|CrOS/.test(navigator.userAgent);
  const chromebook = /CrOS/.test(navigator.userAgent);
  if (!url || !(desktopChrome || chromebook)) return '';
  return `<p class="hint">Using Chrome on this computer? <a href="${esc(url)}" target="_blank" rel="noopener">Add the Cadence extension</a> and it reads Canvas for you, with points and what you have already submitted.</p>`;
}

/** Save the feed link and fetch it once, so the student sees their own work come in. */
async function connectFeed(raw) {
  const o = draft();
  if (o.feedBusy) return;
  const url = String(raw || '').trim().replace(/^webcal:/i, 'https:');
  o.feedUrl = url;
  o.feedError = '';
  if (!url) { o.feedError = 'Paste the link from Canvas first.'; return render(); }
  if (!looksLikeFeedUrl(url)) { o.feedError = 'That is not a Canvas feed link. It contains /feeds/calendars/ and ends in .ics.'; return render(); }
  o.feedBusy = true;
  render();
  try {
    await persist((st) => { st.sources.canvasFeed = { ...st.sources.canvasFeed, url, enabled: true, error: null }; }, { recalc: false });
    const results = await refreshSources({ only: 'canvasFeed', quiet: true });
    const r = results?.canvasFeed;
    if (r?.ok) keepStorage();
    if (!r?.ok) {
      o.feedError = r?.error || 'Cadence could not reach Canvas. Check the link and try again.';
      // A link that does not work is not left switched on.
      await persist((st) => { st.sources.canvasFeed = { ...st.sources.canvasFeed, enabled: false, url: '' }; }, { recalc: false });
    }
  } catch (e) {
    o.feedError = e?.message || 'Cadence could not reach Canvas. Try again.';
  } finally {
    o.feedBusy = false;
    render();
  }
}

async function finish() {
  app.ob = null;
  app.stack = [];
  app.view = 'today';
  await persist((st) => { st.profile.onboarded = true; st.settings.role = st.settings.role || 'student'; });
  // Not quiet: the first sync says how many assignments came in.
  if (insideCanvas) syncCanvas();
  if (app.sync?.available) loadCrew();
}

async function next() {
  const o = draft();
  const name = stepName();
  if (name === 'homework') {
    // A link pasted but not yet connected is connected now rather than lost.
    const typed = String(document.querySelector('[data-form="ob-feed"] input[name="url"]')?.value || '').trim();
    const cf = app.S.sources?.canvasFeed || {};
    // A link that already failed is not tried again: the button says Skip.
    const failed = o.feedError && typed === o.feedUrl;
    if (typed && !failed && !(cf.enabled && cf.url === typed.replace(/^webcal:/i, 'https:') && !cf.error)) {
      await connectFeed(typed);
      if (draft().feedError) return;
    }
    o.feedError = '';
    o.step += 1;
    document.getElementById('view').scrollTop = 0;
    return render();
  }
  if (name === 'activities') {
    const said = o.said.trim();
    await persist((st) => {
      for (const kind of o.picks) {
        if (st.commitments.some((c) => c.kind === kind && !c.archived)) continue;
        const tile = TILES.find((t) => t.kind === kind);
        st.commitments.push(presetCommitment(kind, { title: tile?.title }));
      }
      if (said) applyOps(st, interpret(said, st, new Date()), new Date());
    });
    o.picks = [];
    o.said = '';
    o.step += 1;
    document.getElementById('view').scrollTop = 0;
    return render();
  }
  return finish();
}

export const actions = {
  'ob-pick': (el) => {
    const o = draft();
    const k = el.dataset.kind;
    o.picks = o.picks.includes(k) ? o.picks.filter((x) => x !== k) : [...o.picks, k];
    el.setAttribute('aria-pressed', String(o.picks.includes(k)));
    const btn = document.querySelector('[data-act="ob-next"]');
    if (btn) btn.textContent = o.picks.length || o.said.trim() ? 'Add these to my week' : 'Skip for now';
  },
  'ob-next': () => next(),
  'ob-back': () => { const o = draft(); o.step = Math.max(0, o.step - 1); render(); }
};

export const submitActions = {
  'ob-feed': (form, data) => connectFeed(data.get('url'))
};

/** The free-text box keeps its value across renders without a round trip. */
export function handleOnboardingInput(ev) {
  if (app.S.profile.onboarded || !app.ob || !ev.target.matches('[data-ob-said]')) return false;
  app.ob.said = ev.target.value;
  const btn = document.querySelector('[data-act="ob-next"]');
  if (btn) btn.textContent = app.ob.picks.length || app.ob.said.trim() ? 'Add these to my week' : 'Skip for now';
  return true;
}
