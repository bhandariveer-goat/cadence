// Insights: how Cadence is used, for the person who runs it. The anonymous
// usage records (lib/metrics.js, panel/insight.js) are locked away from
// everyone, so this page asks the database for totals with insights() in
// supabase/schema.sql, which answers only an account listed in its owners
// table. Nobody else gets anything: they are told this page is not theirs.
//
// Opened at /app?insights=1 on the website, after signing in with an email.
// It is not linked from anywhere, is not in the extension, and keeps nothing:
// the totals are held in memory while this screen is open.

import { app, render, push } from '../core.js';
import { svg, I, esc } from '../ui.js';

// Where the screen is: idle, loading, ready, signin (not signed in with an
// email), denied (signed in, but not an owner) or failed.
const state = { status: 'idle', days: 30, data: null, error: '', at: null };
const RANGES = [7, 30, 90];

const num = (v) => Number(v) || 0;
const fmt = (v) => num(v).toLocaleString();
const share = (a, b) => (num(b) ? `${Math.round((100 * num(a)) / num(b))}%` : 'none yet');
const mins = (v) => (v == null ? 'none yet' : `${num(v)} min`);
const secs = (v) => {
  if (v == null) return 'none yet';
  const s = Math.round(num(v));
  return s >= 90 ? `${Math.round(s / 60)} min` : `${s} sec`;
};
const ms = (v) => (v == null ? 'none yet' : num(v) >= 1000 ? `${(num(v) / 1000).toFixed(1)} sec` : `${Math.round(num(v))} ms`);

// Names in the code, in words. A name not listed is shown as it is.
const WORDS = {
  'signin:shown': 'Saw the sign-up screen',
  'signin:started': 'Started typing',
  'signin:submitted': 'Sent the form',
  'signin:done': 'Got in',
  'setup:start': 'Started setup',
  'setup:activities:next': 'Picked activities and went on',
  'setup:activities:skip': 'Skipped the activities screen',
  'setup:activities:typed': 'Typed what they do',
  'setup:back': 'Went back a screen',
  'setup:done': 'Finished setup',
  onboarded: 'Finished setup',
  has_work: 'Added a first assignment or activity',
  checked_in: 'Made a first check-in',
  connected: 'Connected a calendar'
};
const words = (name) => WORDS[name] || String(name);

/** Opens the page and asks for the totals. */
export function openInsights() {
  push('insights');
  if (state.status === 'idle' || state.status === 'signin' || state.status === 'failed') load();
}

async function load() {
  if (!app.cloud?.signedIn || app.S?.account?.mode !== 'cloud') {
    state.status = 'signin';
    return render();
  }
  state.status = 'loading';
  render();
  try {
    state.data = await app.cloud.rest('rpc/insights', { method: 'POST', body: { p_days: state.days } });
    state.status = state.data ? 'ready' : 'failed';
    state.error = state.data ? '' : 'The database sent nothing back.';
    state.at = new Date();
  } catch (e) {
    // The database refuses anyone who is not an owner with the same words for every kind of refusal.
    state.status = /not allowed/i.test(e.message) ? 'denied' : 'failed';
    state.error = e.offline ? e.message : 'Cadence could not read the totals. Try again in a minute.';
    state.data = null;
  }
  render();
}

// ------------------------------------------------------------------ drawing

/** Horizontal bars, one row each: a label, a bar as wide as its value, and a figure. */
function bars(rows, { label, value, note, max }) {
  if (!rows.length) return '<p class="m">Nothing recorded yet.</p>';
  const top = max || Math.max(1, ...rows.map((r) => num(value(r))));
  return `<div class="ix-bars" role="list">${rows.map((r) => {
    const w = Math.min(100, Math.round((100 * num(value(r))) / top));
    return `<div class="ix-row" role="listitem">
      <span class="ix-label">${esc(label(r))}</span>
      <span class="ix-track" aria-hidden="true"><i style="width:${num(value(r)) > 0 ? Math.max(2, w) : 0}%"></i></span>
      <span class="ix-num num">${esc(note(r))}</span></div>`;
  }).join('')}</div>`;
}

/** The people who opened Cadence each day, as columns. */
function daily(rows) {
  if (!rows.length) return '<p class="m">Nothing recorded yet.</p>';
  const W = 600, H = 120, base = 104;
  const top = Math.max(1, ...rows.map((r) => num(r.active)));
  const step = W / rows.length;
  const total = rows.reduce((a, r) => a + num(r.active), 0);
  const cols = rows.map((r, i) => {
    const h = Math.round((88 * num(r.active)) / top);
    const day = new Date(`${r.day}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
    return `<rect class="ix-col" x="${(i * step + step * 0.15).toFixed(1)}" y="${base - h}" width="${(step * 0.7).toFixed(1)}" height="${Math.max(h, num(r.active) ? 1 : 0)}"><title>${esc(day)}: ${fmt(r.active)}</title></rect>`;
  }).join('');
  const first = new Date(`${rows[0].day}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const last = new Date(`${rows[rows.length - 1].day}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `<svg class="ix-daily" viewBox="0 0 ${W} ${H}" role="img" aria-label="Installs active each day, ${esc(first)} to ${esc(last)}. Busiest day ${fmt(top)}, ${fmt(total)} in all.">
    <line class="ix-axis" x1="0" x2="${W}" y1="${base + 0.5}" y2="${base + 0.5}"/>
    ${cols}
    <text class="ix-tick" x="0" y="${H - 2}">${esc(first)}</text>
    <text class="ix-tick" x="${W}" y="${H - 2}" text-anchor="end">${esc(last)}</text>
    <text class="ix-tick" x="0" y="10">${fmt(top)}</text></svg>`;
}

const stat = (label, value) => `<div class="ix-stat"><div class="ix-big num">${esc(value)}</div><div class="m">${esc(label)}</div></div>`;
const section = (title, lead, body) => `<section class="ix-section">
  <div class="section-head"><h2>${esc(title)}</h2></div>
  ${lead ? `<p class="m ix-lead">${esc(lead)}</p>` : ''}
  <div class="card">${body}</div></section>`;

function report(d) {
  const o = d.overview || {};
  const signup = d.signup || [];
  const shown = num(signup.find((s) => s.name === 'signin:shown')?.times);
  const tour = d.tour || {};
  const early = d.early_errors || {};
  const visits = d.visits || {};
  const st = d.setup_time || {};

  return `
    <div class="ix-stats">${stat('Installs, ever', fmt(o.installs))}${stat('Active today', fmt(o.active_today))}${stat('Active in 7 days', fmt(o.active_7_days))}${stat('Active in 30 days', fmt(o.active_30_days))}</div>

    ${section('Opened Cadence each day', `Installs that used the app on each of the last ${d.days} days.`, daily(d.daily || []))}

    ${section('Coming back', 'Of the installs old enough to tell, how many were back exactly 1, 7 and 30 days after their first day.',
      bars(d.retention || [], {
        label: (r) => `Back after ${r.after_days} ${num(r.after_days) === 1 ? 'day' : 'days'}`,
        value: (r) => (num(r.installs) ? (100 * num(r.came_back)) / num(r.installs) : 0), max: 100,
        note: (r) => (num(r.installs) ? `${share(r.came_back, r.installs)} (${fmt(r.came_back)} of ${fmt(r.installs)})` : 'too early')
      }))}

    ${section('The sign-up screen', 'Visits to the screen, counted with no ID, so these are visits and not people.',
      bars(signup, { label: (r) => words(r.name), value: (r) => r.times, max: Math.max(1, shown, ...signup.map((r) => num(r.times))),
        note: (r) => `${fmt(r.times)}${shown && r.name !== 'signin:shown' ? `, ${share(r.times, shown)} of those who saw it` : ''}` }))}

    ${section('Setup', `Installs that reached each step. Finishing took ${secs(st.median_seconds)} for the middle student, and ${secs(st.slowest_tenth_seconds)} for the slowest tenth.`,
      bars(d.setup || [], { label: (r) => words(r.name), value: (r) => r.installs, note: (r) => `${fmt(r.installs)} installs` }))}

    ${section('The tour', `Shown to ${fmt(tour.shown)}, finished by ${fmt(tour.finished)}, skipped by ${fmt(tour.skipped)} (${share(tour.skipped, tour.shown)} of those who saw it). Skipping early means it is in the way.`,
      bars(d.tour_skips || [], { label: (r) => `Skipped on stop ${r.stop} of 6`, value: (r) => r.times, note: (r) => `${fmt(r.times)}` }))}

    ${section('Where the time goes', 'Time in use on each screen. A screen left alone for a minute stops counting, so these are a floor.',
      bars(d.screens || [], { label: (r) => r.screen, value: (r) => r.total_minutes,
        note: (r) => `${num(r.total_minutes)} min, ${fmt(r.stays)} stays, middle stay ${secs(r.median_stay_seconds)}` }))}

    ${section('What gets pressed', 'The controls pressed most, by their name in the code.',
      bars(d.most_pressed || [], { label: (r) => r.control, value: (r) => r.presses, note: (r) => `${fmt(r.presses)}, ${fmt(r.installs)} installs` }))}

    ${section('What hardly gets pressed', 'The least used controls that were pressed at all. A control missing from both lists was never pressed.',
      bars(d.least_pressed || [], { label: (r) => r.control, value: (r) => r.presses, note: (r) => `${fmt(r.presses)}, ${fmt(r.installs)} installs` }))}

    ${section('Pressed but not a button', 'Presses on things that do nothing: where the design looks pressable and is not.',
      bars(d.dead_clicks || [], { label: (r) => `${r.pressed_on} on ${r.screen}`, value: (r) => r.presses, note: (r) => `${fmt(r.presses)}, ${fmt(r.installs)} installs` }))}

    ${section('Pressed again and again', 'Three or more presses within a second on one thing: something looked frozen or did not answer.',
      bars(d.rage_clicks || [], { label: (r) => `${r.control} on ${r.screen}`, value: (r) => r.bursts, note: (r) => `${fmt(r.bursts)}, ${fmt(r.installs)} installs` }))}

    ${section('Errors', `${fmt(early.with_error)} of ${fmt(early.new_installs)} new installs (${share(early.with_error, early.new_installs)}) hit an error in their first five minutes.`,
      bars(d.errors || [], { label: (r) => r.error, value: (r) => r.times, note: (r) => `${fmt(r.times)}, ${fmt(r.in_first_5_minutes)} in the first five minutes, ${fmt(r.installs)} installs` }))}

    ${section('Speed', 'How long Cadence takes to open, and how long its own requests take. The slowest tenth is what the unluckiest students wait.',
      bars(d.speed || [], { label: (r) => r.what, value: (r) => r.median_ms, note: (r) => `middle ${ms(r.median_ms)}, slowest tenth ${ms(r.slowest_tenth_ms)}, ${fmt(r.times)} times` }))}

    ${section('Time to a first win', 'From agreeing to the terms to each first milestone, for the middle student.',
      bars(d.value || [], { label: (r) => words(r.milestone), value: (r) => r.median_minutes, note: (r) => `${mins(r.median_minutes)}, ${fmt(r.installs)} installs` }))}

    ${section('Where interest ran out', 'For installs not seen for a week: the screen they were last on and the last thing they did.',
      bars(d.stops || [], { label: (r) => `${r.last_thing} on ${r.last_screen}`, value: (r) => r.installs, note: (r) => `${fmt(r.installs)} installs` }))}

    ${section('Visits', 'A visit is each time Cadence is opened.',
      `<div class="ix-stats flat">${stat('Visits', fmt(visits.visits))}${stat('Installs', fmt(visits.installs))}${stat('Middle visit', mins(visits.median_minutes))}</div>`)}

    <p class="hint ix-foot">These are estimates. Anyone can send these records, students who turned usage data off are not in them, and one student on two devices counts twice. Nothing here can say who anyone is.</p>`;
}

/** The Insights screen. */
export function viewInsights() {
  const head = `
    <button class="back" data-act="back">${svg(I.left, 16)} Go back</button>
    <section class="hello">
      <h1>Insights</h1>
      <p>How Cadence is being used, from the anonymous usage records. Totals only: nothing here names a student or shows what anyone typed.</p>
    </section>`;

  if (state.status === 'signin') {
    return `${head}<div class="card"><p class="card-title">Sign in with your email first</p><p class="card-sub">This page opens for the account of the person who runs Cadence. Sign in with your email, then open this address again.</p></div>`;
  }
  if (state.status === 'denied') {
    return `${head}<div class="card"><p class="card-title">This page is for the person who runs Cadence</p><p class="card-sub">Your account is not on its list.</p></div>`;
  }
  if (state.status === 'failed') {
    return `${head}<div class="card"><p class="card-title">The totals did not load</p><p class="card-sub">${esc(state.error)}</p><button class="btn soft small" data-act="insights-refresh">Try again</button></div>`;
  }
  if (state.status !== 'ready' || !state.data) {
    return `${head}<div class="card"><p class="m" role="status">Loading the totals.</p></div>`;
  }
  const when = state.at ? state.at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  return `${head}
    <div class="ix-bar">
      <div class="seg" role="group" aria-label="Time range">${RANGES.map((d) => `<button type="button" data-act="insights-days" data-days="${d}" aria-pressed="${state.days === d}">${d} days</button>`).join('')}</div>
      <span class="m">Updated ${esc(when)}</span>
      <button class="btn small ghost" data-act="insights-refresh">Refresh</button>
    </div>
    ${report(state.data)}`;
}

export const actions = {
  'insights-days': (el) => {
    const d = Number(el.dataset.days);
    if (!RANGES.includes(d) || d === state.days) return;
    state.days = d;
    load();
  },
  'insights-refresh': () => load()
};
