// Today: rings, the one thing to do now, the day as a path, and a glimpse of
// the crew. Nothing else. Every other detail is one tap deeper.

import {
  app, currentSession, runningSession, nextFutureSession, commitmentById, plannable, loadCrew, persist, go, push
} from '../core.js';
import { weekProgress, pendingCheckins, showUpStreak, sessionMinutes, weekStart } from '../../lib/habits.js';
import { dateKey, fmtTime, fmtMinutes, fmtDay, addDays } from '../../lib/util.js';
import { ringsDeck, timeline, ART, commitmentIcon } from './parts.js';
import { svg, I, esc, greeting, avatar, ago, colorFor, mmss, plural, KIND_ICON, dueLabel, isWide } from '../ui.js';
import { dayWord } from '../../lib/agentops.js';
import { composeGuide } from './guide.js';
import { stepsForSession, describeSteps } from '../../lib/guide.js';

export function viewToday() {
  const S = app.S;
  const hasAnything = (S.commitments || []).some((c) => !c.archived) || Object.values(S.tasks).some((t) => plannable(t));
  if (!hasAnything) return emptyToday();

  const k = dateKey(new Date());
  const cur = currentSession();
  const pending = pendingCheckins(S).filter((c) => !S.skipped?.[`${c.id}|${k}`]);
  const nudge = (app.crew.nudges || []).find((n) => !n.seen);
  const unplaced = S.plan?.unplaced || [];

  return `
    <section class="hello">
      <h1>${greeting(S.profile.name)}</h1>
      <p>${summaryLine()}</p>
    </section>

    ${nudge ? nudgeBanner(nudge) : ''}
    ${ringsDeck()}
    ${pending.length ? pendingCard(pending[0]) : ''}
    ${cur ? nowCard(cur) : restCard()}
    ${tiredLine()}

    <div class="section">
      <div class="section-head"><h2>Today</h2><button class="link" data-act="go" data-tab="calendar">Open the week</button></div>
      ${timeline(k, { emptyText: 'Nothing on the calendar today.' })}
    </div>

    ${unplaced.length ? roomCard(unplaced) : ''}
    ${isWide() ? '' : `${reviewCard()}${crewPeek()}`}
  `;
}

function summaryLine() {
  const S = app.S;
  const k = dateKey(new Date());
  const todays = (S.plan?.sessions || []).filter((s) => dateKey(new Date(s.start)) === k && !s.done);
  const mins = todays.reduce((a, s) => a + s.minutes, 0);
  const streak = showUpStreak(S);
  const dueToday = (S.commitments || []).filter((c) => !c.archived && weekProgress(c, S.checkins).left > 0).length;
  if (!todays.length && !dueToday) return 'Nothing planned today. A good day to rest or get ahead.';
  const bits = [todays.length ? `${plural(todays.length, 'block')} planned today, about ${fmtMinutes(mins)}.` : 'Your plan for today is clear.'];
  if (streak.days >= 2 && !streak.todayDone) bits.push(`Check in once to make it ${streak.days + 1} days in a row.`);
  return bits.join(' ');
}

function nudgeBanner(n) {
  return `<div class="nudge-banner">
    ${avatar(n.from, 40)}
    <div class="grow"><div class="card-title">${esc(n.from.name.split(' ')[0])} nudged you</div>
      <div class="card-sub mt0">${esc(n.message)}</div></div>
    <button class="btn small soft" data-act="seen-nudge" data-id="${n.id}">Mark as read</button>
  </div>`;
}

function pendingCard(c) {
  return `<div class="card k-activity">
    <div class="row">
      <span class="kind-ic">${commitmentIcon(c)}</span>
      <div class="grow"><div class="card-title">How was ${esc(c.title)}?</div>
        <div class="card-sub">Check in so it counts toward this week.</div></div>
    </div>
    <div class="row mt3 gap2">
      <button class="btn primary" data-act="checkin" data-id="${c.id}">${svg(I.check, 16)} Check in</button>
      <button class="btn soft" data-act="skip-fixed" data-id="${c.id}">Skip today</button>
    </div>
  </div>`;
}

function nowCard(s) {
  const running = !!s.startedAt && !s.done;
  const c = s.commitmentId ? commitmentById(s.commitmentId) : null;
  const t = c ? null : app.S.tasks[s.taskId];
  const color = c?.color || colorFor(s);
  const startsIn = +new Date(s.start) - Date.now();
  const isToday = dateKey(new Date(s.start)) === dateKey(new Date());
  const kicker = running ? '<span class="live"></span>In progress' : !isToday ? 'Head start' : startsIn <= 0 ? 'Now' : `Next, at ${fmtTime(s.start)}`;
  const left = running ? Math.max(0, s.minutes * 60 - Math.floor((Date.now() - +new Date(s.startedAt)) / 1000)) : 0;

  let detail = '';
  if (c) {
    const p = weekProgress(c, app.S.checkins);
    detail = `<div class="now-meta">${s.minutes} min · session ${Math.min(p.done + 1, p.target)} of ${p.target} this week</div>
      ${c.why ? `<div class="now-why">${svg(I.heart, 16)}<span>${esc(c.why)}</span></div>` : ''}`;
  } else if (t) {
    const g = composeGuide(t);
    const focus = describeSteps(stepsForSession(g.steps, app.S.plan?.sessions || [], s));
    const mats = g.materials.filter((m) => m.type !== 'textbook').slice(0, 2);
    detail = `<div class="now-meta">${esc(s.courseName || 'Homework')} · ${s.minutes} min${s.parts > 1 ? ` · part ${s.part} of ${s.parts}` : ''}</div>
      ${focus ? `<div class="now-why">${svg(I.target, 16)}<span>${esc(focus)}</span></div>` : ''}
      ${mats.length ? `<div class="mat-chips">${mats.map((m) => `<button class="mat-chip" data-act="open-material" data-task="${t.id}" data-mid="${m.id}">
          <span class="mat-ic">${svg(I.file, 12)}</span><span>${esc(m.title)}</span></button>`).join('')}</div>` : ''}`;
  }

  return `<div class="now">
    <div class="now-kicker">${kicker}</div>
    <div class="now-title">${esc(s.title)}</div>
    ${detail}
    ${running ? `<div class="clock" id="timer">${mmss(left)}</div>` : ''}
    <div class="now-actions">
      ${running
        ? `<button class="btn primary" data-act="${c ? 'checkin-session' : 'finish-session'}" data-id="${s.id}">${svg(I.check, 16)} Mark done</button>
           <button class="btn soft" data-act="stop-session" data-id="${s.id}">Stop timer</button>`
        : `<button class="btn primary" data-act="start-session" data-id="${s.id}">${svg(I.play, 14)} Start block</button>
           ${c ? `<button class="btn soft" data-act="checkin-session" data-id="${s.id}">Log it as done</button>` : ''}
           <button class="btn soft" data-act="skip-session" data-id="${s.id}">Move it later</button>`}
      <span class="grow"></span>
      ${t ? `<button class="btn ghost" data-act="open-guide" data-id="${t.id}">Open guide</button>` : ''}
    </div>
  </div>`;
}

function restCard() {
  const nxt = nextFutureSession();
  const S = app.S;
  const done = (S.plan?.sessions || []).some((s) => s.done && dateKey(new Date(s.start)) === dateKey(new Date()))
    || (S.checkins || []).some((k) => k.date === dateKey(new Date()));
  return `<div class="card ${done ? 'good' : 'soft'}">
    <div class="card-title">${done ? "You're done for today" : 'Nothing left right now'}</div>
    <div class="card-sub">${done ? 'That counts.' : 'Nothing is waiting on you.'}${nxt ? ' If you want a head start:' : ''}</div>
    ${nxt ? `<div class="row mt3">
      <div class="grow small"><b>${esc(nxt.title)}</b><div class="text-2">${esc(fmtDay(nxt.start))} · ${nxt.minutes} min</div></div>
      <button class="btn small soft" data-act="start-session" data-id="${nxt.id}">Start it early</button>
    </div>` : ''}
  </div>`;
}

function roomCard(unplaced) {
  const assigned = unplaced.filter((u) => !u.commitmentId);
  const names = (assigned.length ? assigned : unplaced).slice(0, 2).map((u) => `${esc(u.title)}${u.due && !u.commitmentId ? ` (due ${esc(dayWord(dateKey(new Date(u.due))))})` : ''}`).join(' and ');
  return `<div class="card warm">
    <div class="card-title">${assigned.length ? 'Something does not fit yet' : 'A session short this week'}</div>
    <div class="card-sub">${names}${unplaced.length > 2 ? `, and ${unplaced.length - 2} more` : ''}. ${assigned.length ? 'Tell Cadence a night you can do more, or which one can wait.' : 'Homework took the time. Nothing with a due date is at risk.'}</div>
    <div class="row mt3 gap2">
      <button class="btn small soft" data-act="agent-open" data-seed="${assigned.length ? 'I can do more on ' : ''}">Ask Cadence to fit it in</button>
    </div>
  </div>`;
}

/**
 * The one thing no other planner asks: how much do you have in you tonight?
 * Shown only when there is a real evening of work ahead.
 */
function tiredLine() {
  const now = new Date();
  if (now.getHours() < 15) return '';
  const k = dateKey(now);
  const left = (app.S.plan?.sessions || []).filter((s) => !s.done && dateKey(new Date(s.start)) === k && +new Date(s.end) > +now).reduce((a, s) => a + s.minutes, 0);
  if (left < 60 || app.S.dayOverrides?.[k]) return '';
  return `<button class="ask-line" data-act="agent-open" data-seed="I am tired tonight, ">Not up for ${fmtMinutes(left)} tonight? Tell Cadence how much you can do.</button>`;
}

/** Sunday evening through Tuesday: last week's review is waiting. */
function reviewCard() {
  const S = app.S;
  const dow = new Date().getDay();
  const thisWeek = dateKey(weekStart());
  if (![0, 1, 2].includes(dow) || S.lastReviewWeek === thisWeek || !(S.commitments || []).length) return '';
  if (dow === 0 && new Date().getHours() < 16) return '';
  return `<button class="card tap row" data-act="open-review">
    <span class="kind-ic">${svg(I.chart)}</span>
    <div class="grow"><div class="card-title">Your week in review</div><div class="card-sub">Two minutes: what worked, what to adjust.</div></div>
    ${svg(I.right, 18)}
  </button>`;
}

function crewPeek() {
  if (!app.sync?.available) return '';
  if (!app.crew.loaded) { loadCrew(); return ''; }
  const items = app.crew.feed.filter((f) => !f.mine).slice(0, 2);
  if (!items.length) return '';
  return `<div class="section">
    <div class="section-head"><h2>Your crew</h2><button class="link" data-act="go" data-tab="crew">Open crew</button></div>
    ${items.map(feedCardCompact).join('')}
  </div>`;
}

function feedCardCompact(f) {
  const mine = f.kudos.includes('me');
  return `<div class="feed-card k-activity">
    <div class="feed-head">
      ${avatar(f.who, 36)}
      <div class="grow"><div class="t">${esc(f.who.name.split(' ')[0])} · ${esc(f.title)}</div>
        <div class="m">${fmtMinutes(f.minutes)} · ${ago(f.at)}${f.note ? ` · ${esc(f.note)}` : ''}</div></div>
      <button class="kudos ${mine ? 'on' : ''}" data-act="kudos" data-id="${f.id}" aria-pressed="${mine}" aria-label="Give kudos">${svg(I.thumb, 18)}<span>${f.kudos.length || ''}</span></button>
    </div>
  </div>`;
}

function emptyToday() {
  return `<div class="empty">
    <div class="art">${ART}</div>
    <h2>Your week starts here</h2>
    <p>Tell Cadence what you have on, in your own words, and it builds the week around it.</p>
    <div class="mt4 stack">
      <button class="btn primary" data-act="agent-open">Tell Cadence about your week</button>
      <button class="btn soft" data-act="add-commit">Add an activity</button>
      <button class="btn soft" data-act="go" data-tab="plan">Add an assignment</button>
    </div>
  </div>`;
}

export const actions = {
  'seen-nudge': async (el) => {
    const n = app.crew.nudges.find((x) => x.id === el.dataset.id);
    if (n) n.seen = true;
    app.sync?.seenNudge?.(el.dataset.id);
    const { render } = await import('../core.js');
    render();
  },
  'skip-fixed': (el) => persist((st) => { (st.skipped ||= {})[`${el.dataset.id}|${dateKey(new Date())}`] = true; }, { recalc: false })
};

/** Right pane on wide screens: streak, what's coming, and the crew. */
export function side() {
  const S = app.S;
  const streak = showUpStreak(S);
  const k = dateKey(new Date());
  const upcoming = (S.plan?.days || []).filter((d) => d.date > k && d.sessions.some((s) => !s.done)).slice(0, 3);

  return `
    <div class="card row">
      <span class="kind-ic streak-ic">${svg(I.flame)}</span>
      <div class="grow">
        <div class="card-title num">${streak.days}-day streak</div>
        <div class="card-sub mt0">${streak.todayDone ? 'Today is counted.' : 'Check in once today to keep it.'}${streak.best > streak.days ? ` Best: ${streak.best}.` : ''}${streak.freezes ? ` ${plural(streak.freezes, 'freeze')} ready.` : ''}</div>
      </div>
    </div>

    ${reviewCard()}

    ${upcoming.length ? `<div class="section-head"><h2>Coming up</h2></div>
      <div class="card flush">${upcoming.map((d) => {
        const titles = [...new Set(d.sessions.filter((s) => !s.done).map((s) => s.title))];
        return `<div class="item tap" data-act="open-day" data-day="${d.date}" role="button" tabindex="0">
          <div class="grow"><div class="t">${esc(fmtDay(`${d.date}T12:00:00`))}</div>
            <div class="m">${esc(titles.slice(0, 2).join(', '))}${titles.length > 2 ? ` +${titles.length - 2}` : ''}</div></div>
          <span class="side">${fmtMinutes(d.minutes)}</span></div>`;
      }).join('')}</div>` : ''}

    ${crewPeek()}`;
}
