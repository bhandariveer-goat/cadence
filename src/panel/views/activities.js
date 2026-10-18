// Activities: the things nobody assigns. Each one is a commitment with a
// schedule or a weekly target, a ring that fills as you check in, and a record
// that builds itself out of those check-ins.
//
// School is the list of what you were given; this is the list of what you
// chose. The Calendar is where both of them get a time.

import { app, persist, push, go } from '../core.js';
import {
  showUpStreak, weekProgress, activityRecord, weeklyReview, weekStart, isFixed, pendingCheckins, COMMON_APP
} from '../../lib/habits.js';
import { fmtMinutes, dateKey } from '../../lib/util.js';
import { svg, I, esc, ring, toast, copyFrom, KIND_ICON, daysLabel, plural, activityColor } from '../ui.js';
import { scheduleLabel, ART } from './parts.js';
import { insights } from '../../lib/memory.js';

export function viewActivities() {
  const S = app.S;
  const active = (S.commitments || []).filter((c) => !c.archived);
  const streak = showUpStreak(S);
  const met = active.filter((c) => weekProgress(c, S.checkins).met).length;
  const pending = pendingCheckins(S).filter((c) => !S.skipped?.[`${c.id}|${dateKey(new Date())}`]);
  const totalHours = Math.round((S.checkins || []).reduce((a, k) => a + k.minutes, 0) / 60);

  if (!active.length) {
    return `
      <section class="hello"><h1>Activities</h1><p>Practice, teams, clubs, a job, college essays. The things that matter and that nobody else is tracking.</p></section>
      <div class="empty">
        <h2>No activities yet</h2>
        <p>Add what you do outside class. Cadence puts it on your calendar, plans homework around it, and keeps count each week.</p>
        <div class="mt4 stack gap2">
          <button class="btn primary" data-act="add-commit">${svg(I.plus, 16)} Add an activity</button>
          <button class="btn soft" data-act="agent-open" data-seed="I have ">Tell Cadence about it instead</button>
        </div>
      </div>`;
  }

  return `
    <section class="hello">
      <h1>Activities</h1>
      <p>${met} of ${plural(active.length, 'activity', 'activities')} on track this week${streak.days ? `, and a ${streak.days}-day streak of showing up` : ''}.</p>
    </section>

    ${pending.map((c) => `<div class="card k-activity" style="--c:${activityColor(c)}">
      <div class="row"><span class="kind-ic">${svg(KIND_ICON[c.kind] || I.star)}</span>
        <div class="grow"><div class="card-title">How was ${esc(c.title)}?</div><div class="card-sub">Check in so it counts toward this week.</div></div></div>
      <div class="row mt3 gap2">
        <button class="btn primary" data-act="checkin" data-id="${c.id}">${svg(I.check, 16)} Check in</button>
        <button class="btn soft" data-act="skip-fixed" data-id="${c.id}">Skip today</button></div>
    </div>`).join('')}

    <div class="section-head"><h2>This week</h2><button class="link" data-act="add-commit">Add an activity</button></div>
    <div class="card flush">
      ${active.map((c) => {
        const p = weekProgress(c, S.checkins);
        return `<div class="item tap k-activity" style="--c:${activityColor(c)}" data-act="open-commit" data-id="${c.id}" role="button" tabindex="0">
          ${ring({ pct: p.pct, color: activityColor(c), size: 40, stroke: 4, inner: svg(KIND_ICON[c.kind] || I.star), label: c.title })}
          <div class="grow"><div class="t">${esc(c.title)}</div><div class="m">${esc(scheduleLabel(c, daysLabel))}</div></div>
          <span class="small ${p.met ? 'ok' : 'muted'}">${p.met ? 'Done' : esc(p.label)}</span>
        </div>`;
      }).join('')}
    </div>

    <div class="section-head"><h2>Your record</h2></div>
    <button class="card row tap w100 left" data-act="open-record">
      <span class="kind-ic k-work">${svg(I.trophy)}</span>
      <div class="grow"><div class="card-title">${totalHours} hours across ${plural(active.length, 'activity', 'activities')}</div>
        <div class="card-sub">Hours per week, weeks per year and a short description for each, built from your check-ins.</div></div>${svg(I.right, 18)}
    </button>
    <button class="card row tap w100 left" data-act="open-review">
      <span class="kind-ic k-work">${svg(I.chart)}</span>
      <div class="grow"><div class="card-title">Last week in review</div><div class="card-sub">What you hit, what slipped, and whether a target should change.</div></div>${svg(I.right, 18)}
    </button>`;
}

// ------------------------------------------------------------ the record

export function viewRecord() {
  const S = app.S;
  const active = (S.commitments || []).filter((c) => !c.archived);
  const records = active.map((c) => ({ c, r: activityRecord(S, c) })).sort((a, b) => b.r.totalHours - a.r.totalHours);
  const timing = { school: 'School year', break: 'School break', all: 'All year' };

  return `
    <button class="back" data-act="back">${svg(I.left, 16)} Activities</button>
    <section class="hello">
      <h1>Activities record</h1>
      <p>Every check-in adds up. This is already in the shape the Common App asks for: up to ${COMMON_APP.maxActivities} activities, ${COMMON_APP.description}-character descriptions.</p>
    </section>
    <button class="btn soft mb4" data-act="copy-record">${svg(I.copy, 16)} Copy record as text</button>

    ${records.map(({ c, r }) => `
      <div class="card k-activity" style="--c:${activityColor(c)}">
        <div class="row top-align">
          <span class="kind-ic">${svg(KIND_ICON[c.kind] || I.star)}</span>
          <div class="grow">
            <div class="card-title">${esc(r.position)}</div>
            <div class="card-sub">${esc(r.organization || c.title)}${r.grades?.length ? ` · Grades ${r.grades.join(', ')}` : ''} · ${timing[r.timing] || 'School year'}</div>
          </div>
          <button class="icon-btn" data-act="edit-commit" data-id="${c.id}" data-tip="Edit details" aria-label="Edit details">${svg(I.edit, 18)}</button>
        </div>
        <div class="stats mt4 mb3">
          <div class="stat"><b>${r.hoursPerWeek}</b><span>hrs / week</span></div>
          <div class="stat"><b>${r.weeksPerYear}</b><span>weeks / year</span></div>
          <div class="stat"><b>${Math.round(r.totalHours)}</b><span>total hours</span></div>
        </div>
        <div class="card soft small m0">
          <div class="row between mb2"><b>Description</b><span class="muted">${r.description.length}/${COMMON_APP.description}</span></div>
          ${esc(r.description)}
        </div>
        ${r.notes.length ? `<div class="q">Highlights from your notes</div>
          <div class="small text-2">${r.notes.slice(0, 3).map((n) => `• ${esc(n.note)}`).join('<br>')}</div>` : ''}
        ${!c.role || !c.org ? `<button class="link small mt2" data-act="edit-commit" data-id="${c.id}">Add your role and organization</button>` : ''}
      </div>`).join('') || '<div class="card soft center muted">Add an activity and check in. Your record builds itself.</div>'}
  `;
}

function recordText() {
  const S = app.S;
  return (S.commitments || []).filter((c) => !c.archived).map((c) => {
    const r = activityRecord(S, c);
    return [
      `${r.position}${r.organization ? `, ${r.organization}` : ''}`,
      `Grades: ${r.grades?.join(', ') || 'not set'} · ${r.hoursPerWeek} hrs/week · ${r.weeksPerYear} weeks/year`,
      r.description
    ].join('\n');
  }).join('\n\n');
}


// ------------------------------------------------------------------ review

export function viewReview() {
  const S = app.S;
  const rv = weeklyReview(S);
  const weekLabel = new Date(`${rv.weekOf}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const note = S.reflections?.[rv.weekOf] || '';
  // The weekly moment to show that the plan has been adapting to them.
  const learned = insights(S).filter((x) => x.active).slice(0, 4);

  return `
    <button class="back" data-act="back">${svg(I.left, 16)} Go back</button>
    <section class="hello center">
      <div class="stack center-items mb3">
        ${ring({ pct: rv.showUpDays / 7, size: 112, stroke: 8, inner: `<b class="ring-num lg">${rv.showUpDays}</b>`, label: `${rv.showUpDays} of 7 days` })}
      </div>
      <h1>You showed up ${rv.showUpDays} of 7 days</h1>
      <p>Week of ${esc(weekLabel)}${rv.homework.finished ? ` · ${plural(rv.homework.finished, 'assignment')} finished` : ''}${rv.items.length ? ` · ${rv.hours} hours on your activities · ${rv.met} of ${rv.items.length} targets met` : ''}</p>
    </section>

    ${learned.length ? `<div class="section-head"><h2>What Cadence learned about you</h2><button class="link" data-act="open-memory">See everything</button></div>
    <div class="card flush">${learned.map((x) => `<div class="item"><div class="grow"><div class="t">${esc(x.text)}</div><div class="m">${esc(x.effect)}</div></div></div>`).join('')}</div>` : ''}

    ${rv.items.length ? `<div class="section-head${learned.length ? ' mt6' : ''}"><h2>Your activities</h2></div>` : ''}
    <div class="card flush" ${rv.items.length ? '' : 'hidden'}>
      ${rv.items.map(({ commitment: c, progress: p, previous, suggestion }) => `
        <div class="item top-align wrap k-activity" style="--c:${activityColor(c)}">
          ${ring({ pct: p.pct, color: activityColor(c), size: 40, stroke: 4, inner: svg(KIND_ICON[c.kind] || I.star), label: c.title })}
          <div class="grow">
            <div class="t">${esc(c.title)}</div>
            <div class="m">${p.done} of ${p.target}${p.done > previous.done ? ` · up from ${previous.done}` : p.done < previous.done ? ` · down from ${previous.done}` : ''}</div>
            ${suggestion ? `<div class="small mt2 text-2">${esc(suggestion.text)}</div>
              <button class="btn small soft mt2" data-act="apply-suggestion" data-id="${c.id}" data-to="${suggestion.to}">
                ${suggestion.type === 'lower' ? `Try ${suggestion.to}× a week` : `Go to ${suggestion.to}× a week`}</button>` : ''}
          </div>
          ${p.met ? `<span class="pill green">${svg(I.check, 12)} Met</span>` : ''}
        </div>`).join('') || '<div class="item"><div class="grow small muted">Your first full week is still in progress.</div></div>'}
    </div>

    <label class="field mt2"><span>One thing that helped, or got in the way</span>
      <textarea data-act="reflection" data-week="${rv.weekOf}" placeholder="Piano right after dinner worked. Tuesdays are too packed.">${esc(note)}</textarea></label>

    <button class="btn primary block" data-act="finish-review">Start the new week</button>
  `;
}


export const actions = {
  'open-record': () => push('record'),
  'open-review': () => push('review'),
  'copy-record': (el) => copyFrom(el, recordText()),
  'apply-suggestion': (el) => persist((st) => {
    const c = st.commitments.find((x) => x.id === el.dataset.id);
    if (c && !isFixed(c)) c.target.sessions = Number(el.dataset.to);
  }).then(() => toast('Target updated for this week')),
  'finish-review': () => persist((st) => { st.lastReviewWeek = dateKey(weekStart()); }, { recalc: false })
    .then(() => { go((app.S.commitments || []).some((c) => !c.archived) ? 'activities' : 'today'); toast('Review saved. A new week has started.'); })
};

export const changeActions = {
  reflection: (el) => persist((st) => { (st.reflections ||= {})[el.dataset.week] = el.value; }, { recalc: false })
};
