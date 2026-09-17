// You: your streak, your commitments, the activities record your check-ins
// are building, last week's review, and the settings that matter.

import { app, persist, push, back, restore, allBusy, insideCanvas, DEMO, go, loadCrew } from '../core.js';
import {
  showUpStreak, weekProgress, activityRecord, weeklyReview, weekStart, isFixed, KINDS, COMMON_APP, targetSessions
} from '../../lib/habits.js';
import { resetState } from '../../lib/store.js';
import { parseICS, freeMinutesBetween } from '../../lib/calendar.js';
import { aiAvailable } from '../../lib/ai.js';
import { createSync } from '../../lib/sync.js';
import { fmtMinutes, dateKey, addDays, uid, atTime } from '../../lib/util.js';
import {
  svg, I, esc, avatar, ring, sheet, toast, KIND_ICON, timeSelect, WEEK_ORDER, DOW_SHORT, DOW_LONG, daysLabel, range,
  toMin, shift, clock, ago, plural, longDay
} from '../ui.js';
import { weekDots, scheduleLabel } from './parts.js';
import { commitmentEditor } from './commitments.js';

// ---------------------------------------------------------------- main page

export function viewYou() {
  const S = app.S;
  const teacher = S.settings.role === 'teacher';
  const streak = showUpStreak(S);
  const monthAgo = dateKey(addDays(new Date(), -30));
  const monthHours = Math.round((S.checkins || []).filter((k) => k.date >= monthAgo).reduce((a, k) => a + k.minutes, 0) / 60);
  const active = (S.commitments || []).filter((c) => !c.archived);
  const metThisWeek = active.filter((c) => weekProgress(c, S.checkins).met).length;
  const totalHours = Math.round((S.checkins || []).reduce((a, k) => a + k.minutes, 0) / 60);

  return `
    <section class="profile">
      ${avatar({ name: S.profile.name || 'You', color: '#f0712b' }, 58)}
      <div class="grow"><h1>${esc(S.profile.name || 'You')}</h1>
        <p class="muted small">${teacher ? 'Teacher & club leader' : streak.days ? `${streak.days}-day streak · best ${streak.best}` : 'Every streak starts with one check-in'}</p></div>
      <button class="icon-btn" data-act="open-settings" aria-label="Settings">${svg(I.settings, 22)}</button>
    </section>

    ${teacher ? '' : `
    <div class="stats">
      <div class="stat"><b style="color:var(--amber)">${svg(I.flame)} ${streak.days}</b><span>day streak${streak.freezes ? ` · ${streak.freezes} ${svg(I.snow)}` : ''}</span></div>
      <div class="stat"><b>${monthHours}</b><span>hours this month</span></div>
      <div class="stat"><b>${metThisWeek}/${active.length}</b><span>rings closed</span></div>
    </div>

    <div class="section-head" style="margin-top:18px"><h2>Your commitments</h2><button class="link" data-act="add-commit">Add</button></div>
    <div class="card flush">
      ${active.length ? active.map((c) => {
        const p = weekProgress(c, S.checkins);
        return `<div class="item tap" data-act="open-commit" data-id="${c.id}" style="--c:${c.color}">
          ${ring({ pct: p.pct, color: c.color, size: 44, stroke: 5, inner: svg(KIND_ICON[c.kind] || I.star), label: c.title })}
          <div class="grow"><div class="t">${esc(c.title)}</div><div class="m">${esc(scheduleLabel(c, daysLabel))}</div></div>
          ${weekDots(c, 6)}
        </div>`;
      }).join('') : `<div class="item"><div class="grow small muted">Nothing yet. What do you want to stay consistent with?</div></div>`}
    </div>

    <button class="record" data-act="open-record" style="width:100%;border:0;text-align:left;cursor:pointer">
      <div class="row"><span style="opacity:.8">${svg(I.trophy, 22)}</span><div class="grow">
        <div class="t">Your activities record</div>
        <div class="m">Built from your check-ins — ready when college applications are</div></div>${svg(I.right, 18)}</div>
      <div class="nums"><div><b>${active.length}</b><span>activities</span></div><div><b>${totalHours}</b><span>hours logged</span></div><div><b>${(S.checkins || []).length}</b><span>check-ins</span></div></div>
    </button>

    <button class="card row" data-act="open-review" style="width:100%;text-align:left;cursor:pointer">
      <span class="kind-ic" style="--c:var(--accent)">${svg(I.chart)}</span>
      <div class="grow"><div class="card-title">Week in review</div><div class="card-sub">What worked last week, and what to adjust</div></div>${svg(I.right, 18)}
    </button>`}

    ${settingsList()}
  `;
}

function settingsList() {
  const S = app.S;
  const teacher = S.settings.role === 'teacher';
  const icsCount = (S.busy || []).filter((b) => b.source === 'ics').length;
  const crew = app.sync?.mode === 'demo' ? '<span class="muted small">Demo</span>'
    : app.sync?.mode === 'supabase' ? '<span class="status">Connected</span>' : '<span class="muted small">Not connected</span>';
  const row = (act, icon, title, sub, right = svg(I.right, 16), color = 'var(--text-2)') => `
    <div class="integration" style="cursor:pointer" data-act="${act}" role="button" tabindex="0">
      <span class="ic" style="color:${color}">${svg(icon, 19)}</span>
      <div class="grow"><div class="t">${title}</div><div class="m">${sub}</div></div>${right}</div>`;

  return `
    <div class="section-head" style="margin-top:22px" id="settings"><h2>Settings</h2></div>
    <div class="card flush">
      ${teacher ? '' : row('open-availability', I.clock, "When you're free", 'Homework and practice only land in these times', undefined, 'var(--accent)')}
      ${teacher ? '' : row('open-pace', I.target, 'Your pace', `${fmtMinutes(S.settings.dailyCapacityMin)} of focused time a day`, undefined, '#8b5cf6')}
      ${teacher ? '' : row('ics-sheet', I.cal, 'Calendar', icsCount ? `${icsCount} events kept clear` : 'Import from Google or Apple Calendar', undefined, '#3b82f6')}
      ${row('crew-account', I.users, 'Crew account', 'Partners, clubs and kudos', crew, '#1c9d68')}
      ${row('ai-sheet', I.sparkle, 'Cadence Intelligence', 'Assignment guides and estimates, powered by Claude', aiAvailable(S.settings) ? '<span class="status">On</span>' : svg(I.right, 16), 'var(--accent)')}
      <div class="integration"><span class="ic" style="color:#e8664f">${svg(I.canvas, 19)}</span>
        <div class="grow"><div class="t">Canvas</div><div class="m">Assignments come in automatically</div></div>
        ${insideCanvas ? `<span class="status">${S.lastSync ? `Synced ${ago(S.lastSync)}` : 'Connected'}</span>` : `<span class="muted small">${DEMO ? 'Demo data' : 'Via the Chrome extension'}</span>`}</div>
      <label class="integration toggle" style="cursor:pointer"><span class="ic" style="color:var(--amber)">${svg(I.bell, 19)}</span>
        <span class="grow"><span class="t" style="display:block">Reminders</span><small>A nudge before each block and check-in</small></span>
        <input type="checkbox" data-act="set-toggle" data-key="remindersEnabled" ${S.settings.remindersEnabled ? 'checked' : ''}><i></i></label>
      ${row('role', I.swap, teacher ? 'Switch to student view' : 'Teacher & leader tools', teacher ? 'Plan your own week' : 'Create assignments by voice, run a club', svg(I.right, 16))}
      ${row('reset', I.reset, 'Start over', 'Clears Cadence on this device', '')}
    </div>
    <p class="center muted small" style="margin:14px 0 4px">Your data stays on this device unless you connect a crew account.</p>`;
}

// ------------------------------------------------------------ the record

export function viewRecord() {
  const S = app.S;
  const active = (S.commitments || []).filter((c) => !c.archived);
  const records = active.map((c) => ({ c, r: activityRecord(S, c) })).sort((a, b) => b.r.totalHours - a.r.totalHours);
  const timing = { school: 'School year', break: 'School break', all: 'All year' };

  return `
    <button class="back" data-act="back">${svg(I.left, 16)} You</button>
    <section class="hello" style="padding-top:2px">
      <h1>Activities record</h1>
      <p>Every check-in adds up. This is already in the shape the Common App asks for — up to ${COMMON_APP.maxActivities} activities, ${COMMON_APP.description}-character descriptions.</p>
    </section>
    <button class="btn soft block" data-act="copy-record" style="margin-bottom:14px">${svg(I.copy, 16)} Copy all as text</button>

    ${records.map(({ c, r }) => `
      <div class="card" style="--c:${c.color}">
        <div class="row" style="align-items:flex-start">
          <span class="kind-ic">${svg(KIND_ICON[c.kind] || I.star)}</span>
          <div class="grow">
            <div class="card-title">${esc(r.position)}</div>
            <div class="card-sub">${esc(r.organization || c.title)}${r.grades?.length ? ` · Grades ${r.grades.join(', ')}` : ''} · ${timing[r.timing] || 'School year'}</div>
          </div>
          <button class="icon-btn" data-act="edit-commit" data-id="${c.id}" aria-label="Edit details">${svg(I.edit, 18)}</button>
        </div>
        <div class="stats" style="margin:14px 0 10px">
          <div class="stat"><b>${r.hoursPerWeek}</b><span>hrs / week</span></div>
          <div class="stat"><b>${r.weeksPerYear}</b><span>weeks / year</span></div>
          <div class="stat"><b>${Math.round(r.totalHours)}</b><span>total hours</span></div>
        </div>
        <div class="card soft small" style="margin:0">
          <div class="row between" style="margin-bottom:4px"><b>Description</b><span class="muted">${r.description.length}/${COMMON_APP.description}</span></div>
          ${esc(r.description)}
        </div>
        ${r.notes.length ? `<div class="q" style="margin:12px 0 6px;font-size:13px">Highlights from your notes</div>
          <div class="small" style="color:var(--text-2)">${r.notes.slice(0, 3).map((n) => `• ${esc(n.note)}`).join('<br>')}</div>` : ''}
        ${!c.role || !c.org ? `<button class="link small" data-act="edit-commit" data-id="${c.id}" style="margin-top:8px">Add your role and organization</button>` : ''}
      </div>`).join('') || '<div class="card soft center muted">Add a commitment and check in — your record builds itself.</div>'}
  `;
}

function recordText() {
  const S = app.S;
  return (S.commitments || []).filter((c) => !c.archived).map((c) => {
    const r = activityRecord(S, c);
    return [
      `${r.position}${r.organization ? ` — ${r.organization}` : ''}`,
      `Grades: ${r.grades?.join(', ') || '—'} · ${r.hoursPerWeek} hrs/week · ${r.weeksPerYear} weeks/year`,
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

  return `
    <button class="back" data-act="back">${svg(I.left, 16)} Back</button>
    <section class="hello" style="padding-top:2px;text-align:center">
      <div style="display:grid;place-items:center;margin-bottom:10px">
        ${ring({ pct: rv.showUpDays / 7, color: 'var(--accent)', size: 110, stroke: 12, inner: `<b style="font-size:30px;font-weight:850;color:var(--text)">${rv.showUpDays}</b>`, label: `${rv.showUpDays} of 7 days` })}
      </div>
      <h1>You showed up ${rv.showUpDays} of 7 days</h1>
      <p>Week of ${esc(weekLabel)} · ${rv.hours} hours on your commitments · ${rv.met} of ${rv.items.length} targets met</p>
    </section>

    <div class="card flush">
      ${rv.items.map(({ commitment: c, progress: p, previous, suggestion }) => `
        <div class="item" style="--c:${c.color};align-items:flex-start;flex-wrap:wrap">
          ${ring({ pct: p.pct, color: c.color, size: 40, stroke: 5, inner: svg(KIND_ICON[c.kind] || I.star), label: c.title })}
          <div class="grow">
            <div class="t">${esc(c.title)}</div>
            <div class="m">${p.done} of ${p.target}${p.done > previous.done ? ` · up from ${previous.done}` : p.done < previous.done ? ` · down from ${previous.done}` : ''}</div>
            ${suggestion ? `<div class="small" style="margin-top:6px;color:var(--text-2)">${esc(suggestion.text)}</div>
              <button class="btn small soft" style="margin-top:8px" data-act="apply-suggestion" data-id="${c.id}" data-to="${suggestion.to}">
                ${suggestion.type === 'lower' ? `Try ${suggestion.to}× a week` : `Go to ${suggestion.to}× a week`}</button>` : ''}
          </div>
          ${p.met ? `<span class="pill green">${svg(I.check, 12)} Met</span>` : ''}
        </div>`).join('') || '<div class="item"><div class="grow small muted">Your first full week is still in progress.</div></div>'}
    </div>

    <label class="field" style="margin-top:6px"><span>One thing that helped — or got in the way</span>
      <textarea data-act="reflection" data-week="${rv.weekOf}" placeholder="Doing piano right after dinner worked. Tuesdays are too packed.">${esc(note)}</textarea></label>

    <button class="btn primary block" data-act="finish-review">Start this week</button>
  `;
}

// ------------------------------------------------------------ availability

export function viewAvailability() {
  const S = app.S;
  const free = Math.round(freeMinutesBetween(new Date(), addDays(new Date(), 7), S.availability, allBusy(), S.settings) / 60);
  return `
    <button class="back" data-act="back">${svg(I.left, 16)} Back</button>
    <section class="hello" style="padding-top:2px">
      <h1>When you're free</h1>
      <p>Homework and flexible practice only get planned inside these times. About <b>${free} hours</b> free this week after your set commitments.</p>
    </section>
    <button class="btn soft block" data-act="routine-sheet" style="margin-bottom:12px">${svg(I.sparkle, 16)} Quick setup</button>
    <div class="card flush">
      <div class="hours" style="display:grid;grid-template-columns:40px 1fr;gap:10px;padding:4px 16px"><span></span>
        <div class="row between small muted" style="font-size:11px"><span>6a</span><span>noon</span><span>6p</span><span>12a</span></div></div>
      ${WEEK_ORDER.map(weekRow).join('')}
      <div class="row small muted" style="gap:14px;padding:6px 16px 10px">
        <span><i style="display:inline-block;width:12px;height:8px;border-radius:3px;background:color-mix(in srgb, var(--accent) 35%, var(--surface));margin-right:5px"></i>Free time</span>
        <span><i style="display:inline-block;width:12px;height:8px;border-radius:3px;background:color-mix(in srgb, var(--green) 50%, var(--surface));margin-right:5px"></i>Set commitments</span>
      </div>
    </div>
    <p class="hint center">Tap a day to change it.</p>`;
}

function weekRow(dow) {
  const S = app.S;
  const wins = S.availability[dow] || [];
  const fixed = (S.commitments || []).filter((c) => !c.archived && isFixed(c) && c.schedule.days.includes(dow));
  const seg = (color, a, b) => {
    const l = Math.max(0, Math.min(1, (toMin(a) - 360) / 1080)), r = Math.max(0, Math.min(1, (toMin(b) - 360) / 1080));
    return r > l ? `<span style="position:absolute;top:0;bottom:0;left:${(l * 100).toFixed(1)}%;width:${((r - l) * 100).toFixed(1)}%;border-radius:6px;background:${color}"></span>` : '';
  };
  return `<div data-act="edit-day" data-dow="${dow}" role="button" tabindex="0" style="display:grid;grid-template-columns:40px 1fr;gap:4px 10px;align-items:center;padding:8px 16px;cursor:pointer">
    <b style="font-size:13.5px">${DOW_SHORT[dow]}</b>
    <div style="position:relative;height:24px;border-radius:8px;background:var(--surface-2);overflow:hidden">
      ${wins.map((w) => seg('color-mix(in srgb, var(--accent) 35%, var(--surface))', w.start, w.end)).join('')}
      ${fixed.map((c) => seg(`repeating-linear-gradient(135deg, ${c.color} 0 5px, color-mix(in srgb, ${c.color} 55%, var(--surface)) 5px 10px)`, c.schedule.start, c.schedule.end)).join('')}
    </div>
    <span></span><span class="small muted">${wins.length ? wins.map((w) => range(w.start, w.end)).join(' and ') : 'Day off'}${fixed.length ? ` · ${esc(fixed.map((c) => c.title).join(', '))}` : ''}</span>
  </div>`;
}

const ROUTINES = {
  'after-school': { label: 'Right after school', sub: (e) => range(shift(e, 15), '18:30'), windows: (e) => [{ start: shift(e, 15), end: '18:30' }] },
  'afternoon-evening': { label: 'Afternoon & evening', sub: (e) => range(shift(e, 15), '21:30'), windows: (e) => [{ start: shift(e, 15), end: '21:30' }] },
  evening: { label: 'After dinner', sub: () => range('18:30', '22:00'), windows: () => [{ start: '18:30', end: '22:00' }] },
  'night-owl': { label: 'Night owl', sub: () => range('20:00', '23:30'), windows: () => [{ start: '20:00', end: '23:30' }] },
  'early-bird': { label: 'Early bird', sub: (e) => `${range('06:30', '07:45')} + ${range(shift(e, 15), '19:00')}`, windows: (e) => [{ start: '06:30', end: '07:45' }, { start: shift(e, 15), end: '19:00' }] }
};
const WEEKENDS = {
  relaxed: { label: 'Keep it light', sub: 'Afternoons, 1–6 PM', sat: [{ start: '13:00', end: '18:00' }], sun: [{ start: '13:00', end: '18:00' }] },
  productive: { label: 'Get ahead', sub: '10 AM – 6 PM', sat: [{ start: '10:00', end: '18:00' }], sun: [{ start: '10:00', end: '18:00' }] },
  sunday: { label: 'Sundays only', sub: 'Saturdays stay free', sat: [], sun: [{ start: '13:00', end: '19:00' }] },
  off: { label: 'Weekends off', sub: 'Rest days', sat: [], sun: [] }
};
export { ROUTINES, WEEKENDS };

export function applyRoutine(st, { schoolEnd, routine, weekend }) {
  if (ROUTINES[routine]) for (const d of [1, 2, 3, 4, 5]) st.availability[d] = ROUTINES[routine].windows(schoolEnd).map((x) => ({ ...x }));
  if (WEEKENDS[weekend]) {
    st.availability[6] = WEEKENDS[weekend].sat.map((x) => ({ ...x }));
    st.availability[0] = WEEKENDS[weekend].sun.map((x) => ({ ...x }));
  }
  Object.assign(st.profile, { schoolEnd, routine, weekend });
}

export function routineChoices(draft, attr = 'data-routine') {
  return `
    <div class="q" style="margin-top:0">School gets out at</div>
    ${timeSelect('schoolEnd', draft.schoolEnd, 'data-school')}
    <div class="q">On school days, homework happens…</div>
    <div class="choices stacked">${Object.entries(ROUTINES).map(([id, r]) =>
      `<button type="button" class="choice" ${attr}="${id}" aria-pressed="${draft.routine === id}">${r.label}<small>${r.sub(draft.schoolEnd)}</small></button>`).join('')}</div>
    <div class="q">On weekends</div>
    <div class="choices grid2">${Object.entries(WEEKENDS).map(([id, w]) =>
      `<button type="button" class="choice" data-weekend="${id}" aria-pressed="${draft.weekend === id}">${w.label}<small>${w.sub}</small></button>`).join('')}</div>`;
}

async function routineSheet() {
  const draft = { schoolEnd: app.S.profile.schoolEnd || '15:30', routine: app.S.profile.routine, weekend: app.S.profile.weekend };
  const res = await sheet(`<h2>Quick setup</h2><p class="lead">Pick what's closest. You can still tweak single days.</p>
    <div data-body>${routineChoices(draft)}</div>
    <div class="actions"><button class="btn ghost" value="cancel">Cancel</button><button class="btn primary" name="op" value="save">Apply</button></div>`, {
    onMount(form) {
      const host = form.querySelector('[data-body]');
      host.addEventListener('click', (e) => {
        const r = e.target.closest('[data-routine]'), w = e.target.closest('[data-weekend]');
        if (r) draft.routine = r.dataset.routine;
        if (w) draft.weekend = w.dataset.weekend;
        if (r || w) host.innerHTML = routineChoices(draft);
      });
      host.addEventListener('change', (e) => { if (e.target.matches('[data-school]')) { draft.schoolEnd = e.target.value; host.innerHTML = routineChoices(draft); } });
    }
  });
  if (!res) return;
  await persist((st) => applyRoutine(st, draft));
  toast('Your week is updated');
}

async function daySheet(dow) {
  const weekday = dow >= 1 && dow <= 5;
  const winRow = (w) => `<div class="row" data-win style="margin-bottom:8px;gap:6px">
    <div class="pair grow">${timeSelect('s', w.start)}<span class="to">to</span>${timeSelect('e', w.end)}</div>
    <button type="button" class="icon-btn" data-remove aria-label="Remove">${svg(I.x, 18)}</button></div>`;
  const wins = app.S.availability[dow] || [];
  const res = await sheet(`
    <h2>${DOW_LONG[dow]}</h2><p class="lead">When can you work on homework and practice?</p>
    <div data-wins>${wins.map(winRow).join('')}</div>
    <p class="muted small" data-none ${wins.length ? 'hidden' : ''}>A day off.</p>
    <button type="button" class="btn small soft" data-add>${svg(I.plus, 14)} Add a time</button>
    <label class="toggle" style="margin-top:14px"><input type="checkbox" name="all"><i></i><span>${weekday ? 'Use for every school day' : 'Use for both weekend days'}</span></label>
    <div class="actions"><button class="btn soft" name="op" value="off">Day off</button><button class="btn primary" name="op" value="save">Save</button></div>`, {
    onMount(form) {
      const list = form.querySelector('[data-wins]');
      const none = form.querySelector('[data-none]');
      list.addEventListener('click', (e) => { if (e.target.closest('[data-remove]')) { e.target.closest('[data-win]').remove(); none.hidden = !!list.children.length; } });
      form.querySelector('[data-add]').addEventListener('click', () => {
        const last = list.lastElementChild?.querySelectorAll('select');
        const start = last ? shift(last[1].value, 60) : (weekday ? shift(app.S.profile.schoolEnd || '15:30', 15) : '13:00');
        list.insertAdjacentHTML('beforeend', winRow({ start, end: shift(start, 120) }));
        none.hidden = true;
      });
    }
  });
  if (!res) return;
  const rows = [...document.querySelectorAll('#sheet-form [data-win]')].map((r) => { const [a, b] = r.querySelectorAll('select'); return { start: a.value, end: b.value }; })
    .filter((w) => toMin(w.end) > toMin(w.start)).sort((a, b) => toMin(a.start) - toMin(b.start));
  const next = res.get('op') === 'off' ? [] : rows;
  const targets = res.get('all') === 'on' ? (weekday ? [1, 2, 3, 4, 5] : [0, 6]) : [dow];
  await persist((st) => { for (const d of targets) st.availability[d] = next.map((w) => ({ ...w })); st.profile.routine = 'custom'; });
  toast(`${targets.length > 1 ? 'Days' : DOW_LONG[dow]} updated`);
}

function paceLabel(min) { return min <= 75 ? 'Light' : min <= 135 ? 'Balanced' : min <= 195 ? 'Focused' : 'Intense'; }

export const STYLES = {
  sprint: { label: 'Short sprints', sub: '25 minutes on, 5 off', max: 25, brk: 5 },
  steady: { label: 'Steady', sub: '45 minutes on, 10 off', max: 45, brk: 10 },
  deep: { label: 'Deep focus', sub: '75 minutes on, 15 off', max: 75, brk: 15 }
};

export function paceControls(src) {
  const cap = src.cap ?? src.dailyCapacityMin;
  const style = src.style ?? (Object.entries(STYLES).find(([, v]) => v.max === src.sessionMaxMin)?.[0] || 'steady');
  return `
    <div class="card-title">Focused time on a school night</div>
    <div class="card-sub">Homework plus flexible practice. Cadence only goes over when a deadline needs it.</div>
    <div class="row" style="margin-top:10px;align-items:baseline;gap:8px"><span class="range-value" data-cap-label>${fmtMinutes(cap)}</span><span class="muted small" data-cap-word>${paceLabel(cap)}</span></div>
    <input type="range" name="cap" min="45" max="360" step="15" value="${cap}" data-cap aria-label="Daily focused time">
    <div class="range-scale"><span>45m</span><span>2h</span><span>4h</span><span>6h</span></div>
    <div class="q">How do you like to work?</div>
    <div class="choices stacked">${Object.entries(STYLES).map(([id, v]) =>
      `<button type="button" class="choice" data-style="${id}" aria-pressed="${style === id}">${v.label}<small>${v.sub}</small></button>`).join('')}</div>`;
}

export function applyPace(st, { cap, style }) {
  st.settings.dailyCapacityMin = Number(cap);
  if (STYLES[style]) { st.settings.sessionMaxMin = STYLES[style].max; st.settings.breakMin = STYLES[style].brk; }
  st.settings.sessionMinMin = Math.min(20, st.settings.sessionMaxMin);
}

async function paceSheet() {
  const draft = { cap: app.S.settings.dailyCapacityMin, style: Object.entries(STYLES).find(([, v]) => v.max === app.S.settings.sessionMaxMin)?.[0] || 'steady' };
  const res = await sheet(`<h2>Your pace</h2><div data-body>${paceControls(draft)}</div>
    <div class="actions"><button class="btn ghost" value="cancel">Cancel</button><button class="btn primary" name="op" value="save">Save</button></div>`, {
    onMount(form) {
      const host = form.querySelector('[data-body]');
      host.addEventListener('input', (e) => {
        if (!e.target.matches('[data-cap]')) return;
        draft.cap = Number(e.target.value);
        host.querySelector('[data-cap-label]').textContent = fmtMinutes(draft.cap);
        host.querySelector('[data-cap-word]').textContent = paceLabel(draft.cap);
      });
      host.addEventListener('click', (e) => { const b = e.target.closest('[data-style]'); if (b) { draft.style = b.dataset.style; host.innerHTML = paceControls(draft); } });
    }
  });
  if (!res) return;
  await persist((st) => applyPace(st, draft));
  toast('Pace updated — your plan adjusted');
}

async function icsSheet() {
  const count = (app.S.busy || []).filter((b) => b.source === 'ics').length;
  const res = await sheet(`
    <h2>Import your calendar</h2>
    <p class="lead">Appointments, games and trips get kept clear, so nothing lands on top of them.</p>
    <div class="card soft small" style="margin:0">
      <b>Google Calendar</b><div class="muted" style="margin-bottom:6px">Settings → Import &amp; export → Export, then unzip</div>
      <b>Apple Calendar</b><div class="muted">File → Export → Export…</div></div>
    <label class="btn soft block" style="margin-top:12px">Choose calendar file (.ics)<input type="file" accept=".ics,text/calendar" hidden data-file></label>
    <div class="small muted center" data-filename style="margin-top:6px"></div>
    <div class="actions">${count ? '<button class="btn soft danger" name="op" value="clear">Remove imported</button>' : '<button class="btn ghost" value="cancel">Cancel</button>'}
      <button class="btn primary" name="op" value="import" data-import disabled>Import</button></div>`, {
    onMount(form) {
      form.querySelector('[data-file]').addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        form.dataset.ics = await file.text();
        form.querySelector('[data-filename]').textContent = file.name;
        form.querySelector('[data-import]').disabled = false;
      });
    }
  });
  if (!res) return;
  const form = document.getElementById('sheet-form');
  if (res.get('op') === 'clear') { await persist((st) => { st.busy = st.busy.filter((b) => b.source !== 'ics'); }); return toast('Imported events removed'); }
  const text = form.dataset.ics || '';
  delete form.dataset.ics;
  if (!text.includes('BEGIN:VEVENT')) return toast("That file doesn't look like a calendar");
  const events = parseICS(text, { horizonDays: (app.S.settings.lookaheadDays ?? 14) + 30 });
  if (!events.length) return toast('No upcoming events in that file');
  await persist((st) => { const seen = new Set(st.busy.map((b) => b.id)); for (const e of events) if (!seen.has(e.id)) st.busy.push(e); });
  toast(`${events.length} events imported`);
}

async function aiSheet() {
  const s = app.S.settings;
  const res = await sheet(`
    <div class="sheet-hero"><span class="kind-ic" style="--c:var(--accent);width:48px;height:48px">${svg(I.sparkle, 24)}</span>
      <div><h2 style="margin:0">Cadence Intelligence</h2><div class="muted small">Powered by Claude</div></div></div>
    <p class="lead">Reads the full instructions of each assignment for sharper estimates and step-by-step guides, and turns spoken assignments into polished drafts.</p>
    <label class="field"><span>Access key</span><input type="password" name="key" value="${esc(s.apiKey || '')}" placeholder="Paste the key from your school" autocomplete="off"></label>
    <p class="hint" style="margin-top:-8px">Your school or teacher provides this. It stays on this device.</p>
    <label class="toggle"><input type="checkbox" name="on" ${s.useAI || !s.apiKey ? 'checked' : ''}><i></i><span>Use Cadence Intelligence</span></label>
    <div class="actions"><button class="btn ghost" value="cancel">Cancel</button><button class="btn primary" name="op" value="save">Save</button></div>`);
  if (!res) return;
  const key = String(res.get('key') || '').trim();
  const on = res.get('on') === 'on' && !!key;
  await persist((st) => { st.settings.apiKey = key; st.settings.useAI = on; if (on) for (const t of Object.values(st.tasks)) { t.aiEstimatedAt = null; t.guideAI = null; } }, { recalc: false });
  toast(on ? 'Cadence Intelligence is on' : 'Cadence Intelligence is off');
}

export async function crewAccountSheet() {
  const cfg = app.S.sync || {};
  if (app.sync?.mode === 'demo') {
    return sheet(`<h2>Crew account</h2><p class="lead">You're in the demo, so your crew is simulated. In the real app, you sign in with your school email and partners and clubs sync across your phone and laptop.</p>
      <div class="actions"><button class="btn primary" value="cancel">Got it</button></div>`);
  }
  if (app.sync?.mode === 'supabase' && app.sync.signedIn) {
    const res = await sheet(`<h2>Crew account</h2><p class="lead">Signed in as <b>${esc(app.sync.me()?.email || 'you')}</b>. Only check-ins you choose to share leave this device.</p>
      <div class="actions"><button class="btn soft danger" name="op" value="out">Sign out</button><button class="btn primary" value="cancel">Done</button></div>`);
    if (res?.get('op') === 'out') { await app.sync.signOut(); rebuildSync(); toast('Signed out'); }
    return;
  }
  const res = await sheet(`
    <h2>Connect your crew</h2>
    <p class="lead">Partners and clubs need a shared account so progress can reach the people keeping you accountable. Your school sets this up once.</p>
    <label class="field"><span>Crew server URL</span><input type="text" name="url" value="${esc(cfg.url || '')}" placeholder="https://yourschool.supabase.co" autocomplete="off"></label>
    <label class="field"><span>Public key</span><input type="text" name="anonKey" value="${esc(cfg.anonKey || '')}" placeholder="Provided by your school" autocomplete="off"></label>
    <label class="field"><span>Your school email</span><input type="email" name="email" placeholder="you@school.org" autocomplete="email"></label>
    <label class="field"><span>Your name</span><input type="text" name="name" value="${esc(app.S.profile.name || '')}" autocomplete="name"></label>
    <div class="actions"><button class="btn ghost" value="cancel">Cancel</button><button class="btn primary" name="op" value="send">Email me a code</button></div>`);
  if (!res) return;
  const url = String(res.get('url') || '').trim(), anonKey = String(res.get('anonKey') || '').trim(), email = String(res.get('email') || '').trim();
  if (!/^https:\/\//.test(url) || !anonKey || !email) return toast('Fill in all three fields');
  await persist((st) => { st.sync = { ...st.sync, mode: 'supabase', url, anonKey }; }, { recalc: false });
  rebuildSync();
  try {
    await app.sync.signIn(email);
  } catch (e) { return toast(e.message); }
  const code = await sheet(`<h2>Check your email</h2><p class="lead">We sent a 6-digit code to <b>${esc(email)}</b>.</p>
    <label class="field"><span>Code</span><input type="text" name="code" inputmode="numeric" maxlength="8" autocomplete="one-time-code"></label>
    <div class="actions"><button class="btn ghost" value="cancel">Cancel</button><button class="btn primary" name="op" value="verify">Sign in</button></div>`);
  if (!code) return;
  try {
    await app.sync.verify(email, String(code.get('code') || '').trim(), String(res.get('name') || '').trim());
    toast("You're connected");
    loadCrew({ force: true });
  } catch (e) { toast(e.message); }
}

export function rebuildSync() {
  app.sync = createSync(app.S, { demo: DEMO, saveSession: (session) => persist((st) => { st.sync.session = session; }, { recalc: false }) });
  app.crew = { feed: [], partners: [], clubs: [], nudges: [], loaded: false, loading: false, error: null };
}

async function startOver() {
  const res = await sheet(`<h2>Start over?</h2><p class="lead">This clears your plan, commitments, check-ins and record on this device. Nothing in Canvas changes.</p>
    <div class="actions"><button class="btn soft" value="cancel">Keep everything</button><button class="btn primary" name="op" value="reset">Start over</button></div>`);
  if (res?.get('op') !== 'reset') return;
  app.S = await resetState();
  app.ob = null;
  go('today');
}

async function settingsSheet() {
  document.getElementById('settings')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export const actions = {
  'open-record': () => push('record'),
  'open-review': () => push('review'),
  'open-availability': () => push('availability'),
  'open-pace': () => paceSheet(),
  'open-settings': () => settingsSheet(),
  'routine-sheet': () => routineSheet(),
  'edit-day': (el) => daySheet(Number(el.dataset.dow)),
  'ics-sheet': () => icsSheet(),
  'ai-sheet': () => aiSheet(),
  'crew-account': () => crewAccountSheet(),
  reset: () => startOver(),
  role: () => {
    const next = app.S.settings.role === 'teacher' ? 'student' : 'teacher';
    app.stack = [];
    app.view = next === 'teacher' ? 'create' : 'today';
    return persist((st) => { st.settings.role = next; }, { recalc: false });
  },
  'copy-record': async () => {
    try { await navigator.clipboard.writeText(recordText()); toast('Copied — paste it anywhere'); }
    catch { toast("Couldn't copy on this device"); }
  },
  'apply-suggestion': (el) => persist((st) => {
    const c = st.commitments.find((x) => x.id === el.dataset.id);
    if (c && !isFixed(c)) c.target.sessions = Number(el.dataset.to);
  }).then(() => toast('Target updated for this week')),
  'finish-review': () => persist((st) => { st.lastReviewWeek = dateKey(weekStart()); }, { recalc: false }).then(() => { go('today'); toast('New week, fresh rings'); })
};

export const changeActions = {
  'set-toggle': (el) => persist((st) => { st.settings[el.dataset.key] = el.checked; }, { recalc: false }),
  reflection: (el) => persist((st) => { (st.reflections ||= {})[el.dataset.week] = el.value; }, { recalc: false })
};
