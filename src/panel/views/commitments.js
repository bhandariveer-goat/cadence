// Commitment sheets: check in, add or edit a commitment, and the detail view
// you get by tapping a ring.

import { app, checkIn, undoCheckin, persist, findSession, minutesSince, push, commitmentById, restore } from '../core.js';
import {
  newCommitment, weekProgress, weekStreak, sessionMinutes, targetSessions, isFixed, KINDS, FEELS, activityRecord
} from '../../lib/habits.js';
import { fmtMinutes, dateKey, uid } from '../../lib/util.js';
import {
  sheet, toast, svg, I, esc, KIND_ICON, timeSelect, WEEK_ORDER, DOW_TWO, DOW_SHORT, daysLabel, toMin, celebrate, ago, daysUntil, plural
} from '../ui.js';
import { weekDots, scheduleLabel } from './parts.js';

const FACE = {
  great: '<circle cx="12" cy="12" r="9.5"/><path d="M7.8 13.5a4.6 4.6 0 0 0 8.4 0M8.8 9.5h.01M15.2 9.5h.01"/>',
  good: '<circle cx="12" cy="12" r="9.5"/><path d="M8.5 14.5h7M8.8 9.5h.01M15.2 9.5h.01"/>',
  tough: '<circle cx="12" cy="12" r="9.5"/><path d="M8 16a4.6 4.6 0 0 1 8 0M8.8 9.5h.01M15.2 9.5h.01"/>'
};

// --------------------------------------------------------------- check in

export async function checkinFlow(commitmentId, { sessionId = null, day = null } = {}) {
  const c = commitmentById(commitmentId);
  if (!c) return;
  const s = sessionId ? findSession(app.S, sessionId) : null;
  const timed = s?.startedAt ? minutesSince(s.startedAt) : null;
  const base = timed && timed >= 3 ? timed : s?.minutes || sessionMinutes(c);
  const options = [...new Set([Math.round(base * 0.5 / 5) * 5, base, Math.round(base * 1.5 / 5) * 5].filter((m) => m >= 5))];
  const date = day ? new Date(`${day}T12:00:00`) : new Date();
  const p = weekProgress(c, app.S.checkins, date);

  const res = await sheet(`
    <div class="sheet-hero" style="--c:${c.color}">
      <span class="kind-ic">${svg(KIND_ICON[c.kind] || I.star)}</span>
      <div class="grow"><h2 style="margin:0">${esc(c.title)}</h2>
        <div class="muted small">${p.done} of ${p.target} this week${day && day !== dateKey(new Date()) ? ` · ${esc(day)}` : ''}</div></div>
    </div>

    <div class="q" style="margin-top:0">How did it go?</div>
    <div class="feel">${Object.entries(FEELS).map(([id, label]) =>
      `<button type="button" data-feel="${id}" aria-pressed="${id === 'good'}"><span class="face">${svg(FACE[id], 34)}</span>${label}</button>`).join('')}</div>
    <input type="hidden" name="feel" value="good">

    <div class="q">How long?</div>
    <div class="choices" data-mins>${options.map((m) =>
      `<button type="button" class="choice" data-min="${m}" aria-pressed="${m === base}">${fmtMinutes(m)}</button>`).join('')}
      <input type="number" name="custom" min="5" max="600" step="5" placeholder="Other" style="width:96px" aria-label="Other minutes">
    </div>
    <input type="hidden" name="minutes" value="${base}">

    <label class="field" style="margin-top:16px"><span>What did you work on? <span class="muted">(optional)</span></span>
      <input type="text" name="note" maxlength="120" placeholder="${esc(notePlaceholder(c))}" autocomplete="off"></label>
    <p class="hint" style="margin-top:-8px">Notes become highlights in your activities record.</p>

    <div class="actions">
      <button class="btn ghost" value="cancel">Cancel</button>
      <button class="btn primary" name="op" value="save">${svg(I.check, 16)} Check in</button>
    </div>`, {
    onMount(form) {
      form.querySelectorAll('[data-feel]').forEach((b) => b.addEventListener('click', () => {
        form.querySelectorAll('[data-feel]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        form.feel.value = b.dataset.feel;
      }));
      form.querySelectorAll('[data-min]').forEach((b) => b.addEventListener('click', () => {
        form.querySelectorAll('[data-min]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        form.minutes.value = b.dataset.min;
        form.custom.value = '';
      }));
      form.custom.addEventListener('input', () => {
        form.querySelectorAll('[data-min]').forEach((x) => x.setAttribute('aria-pressed', 'false'));
        form.minutes.value = form.custom.value;
      });
    }
  });
  if (!res) return;

  const result = await checkIn(c.id, {
    minutes: Number(res.get('minutes')) || base, feel: String(res.get('feel') || 'good'), note: String(res.get('note') || ''), sessionId, date
  });
  if (!result) return;
  const snap = null;
  const tile = document.querySelector(`[data-act="open-commit"][data-id="${c.id}"]`);
  if (result.ringClosed) {
    celebrate(tile);
    toast(`${c.title} ring closed — ${result.after.target} for ${result.after.target} this week!`, { label: 'Undo', run: () => undoCheckin(result.checkin.id) });
  } else {
    const streakBit = result.streak.days >= 2 ? ` · ${result.streak.days}-day streak` : '';
    const froze = result.settle?.usedFreezes?.length ? ' · a freeze saved your streak' : '';
    toast(`${c.title}: ${result.after.label} this week${streakBit}${froze}`, { label: 'Undo', run: () => undoCheckin(result.checkin.id) });
  }
}

function notePlaceholder(c) {
  return { practice: 'Bars 1–32 of the nocturne', sport: '5 mile tempo run', club: 'Finished the intake arm CAD', service: 'Sorted 400 lbs of produce', study: 'Drafted the opening paragraph', work: 'Trained a new hire', project: 'Shipped the first prototype' }[c.kind] || 'One sentence is plenty';
}

// ------------------------------------------------------------ add / edit

const PRESETS = {
  practice: { title: 'Instrument practice', schedule: { mode: 'flexible' }, target: { sessions: 5, minutes: 30 }, time: 'evening' },
  sport: { title: 'Team practice', schedule: { mode: 'fixed', days: [1, 2, 3, 4], start: '15:45', end: '17:45' }, target: { sessions: 4, minutes: 120 } },
  club: { title: 'Club meeting', schedule: { mode: 'fixed', days: [3], start: '15:45', end: '17:00' }, target: { sessions: 1, minutes: 75 } },
  service: { title: 'Volunteering', schedule: { mode: 'fixed', days: [6], start: '10:00', end: '13:00' }, target: { sessions: 1, minutes: 180 }, timing: 'all' },
  work: { title: 'Part-time job', schedule: { mode: 'fixed', days: [5, 6], start: '17:00', end: '21:00' }, target: { sessions: 2, minutes: 240 }, timing: 'all' },
  study: { title: 'College essays', schedule: { mode: 'flexible' }, target: { sessions: 2, minutes: 45 }, time: 'evening' },
  project: { title: 'Personal project', schedule: { mode: 'flexible' }, target: { sessions: 2, minutes: 60 } },
  wellness: { title: 'Workout', schedule: { mode: 'flexible' }, target: { sessions: 3, minutes: 30 } },
  custom: { title: '', schedule: { mode: 'flexible' }, target: { sessions: 3, minutes: 30 } }
};

export function presetCommitment(kind, extra = {}) {
  return newCommitment({ kind, ...structuredClone(PRESETS[kind] || PRESETS.custom), ...extra });
}

export async function commitmentEditor(existing = null, { kind = null, afterSave = null } = {}) {
  const c = existing ? structuredClone(existing) : presetCommitment(kind || 'practice');
  let draft = c;
  const body = () => `
    <h2>${existing ? 'Edit commitment' : 'New commitment'}</h2>
    <p class="lead">${existing ? 'Changes apply from this week on.' : 'Something you want to show up for, week after week.'}</p>

    <label class="field"><span>What is it?</span>
      <input type="text" name="title" value="${esc(draft.title)}" placeholder="Piano, robotics, running…" autocomplete="off" maxlength="40"></label>

    <div class="field"><span>Type</span>
      <div class="choices">${Object.entries(KINDS).map(([id, k]) =>
        `<button type="button" class="choice" data-kind="${id}" aria-pressed="${draft.kind === id}" style="padding:8px 12px;min-height:40px">${k.label}</button>`).join('')}</div></div>

    <div class="field"><span>When does it happen?</span>
      <div class="seg" style="margin-bottom:10px">
        <button type="button" data-mode="fixed" aria-pressed="${isFixed(draft)}">At set times</button>
        <button type="button" data-mode="flexible" aria-pressed="${!isFixed(draft)}">Whenever I fit it in</button>
      </div>
      ${isFixed(draft) ? `
        <div class="days" style="margin-bottom:10px">${WEEK_ORDER.map((d) => `<button type="button" class="day-toggle" data-day="${d}" aria-pressed="${(draft.schedule.days || []).includes(d)}">${DOW_TWO[d]}</button>`).join('')}</div>
        <div class="pair">${timeSelect('start', draft.schedule.start || '16:00')}<span class="to">to</span>${timeSelect('end', draft.schedule.end || '17:30')}</div>
        <p class="hint">Cadence keeps this time clear and asks how it went afterward.</p>`
      : `
        <div class="row between" style="margin-bottom:10px"><span class="small" style="font-weight:700">Times per week</span>
          <span class="stepper"><button type="button" data-step="-1" aria-label="Fewer">−</button><b>${draft.target.sessions}</b><button type="button" data-step="1" aria-label="More">+</button></span></div>
        <div class="choices" style="margin-bottom:10px">${[15, 20, 30, 45, 60, 90].map((m) =>
          `<button type="button" class="choice" data-mins="${m}" aria-pressed="${draft.target.minutes === m}" style="min-height:40px;padding:8px 12px">${fmtMinutes(m)}</button>`).join('')}</div>
        <div class="choices">${[['any', 'Any time'], ['morning', 'Mornings'], ['afternoon', 'Afternoons'], ['evening', 'Evenings']].map(([id, l]) =>
          `<button type="button" class="choice" data-time="${id}" aria-pressed="${draft.time === id}" style="min-height:40px;padding:8px 12px">${l}</button>`).join('')}</div>
        <p class="hint">Cadence spreads these through your week around homework.</p>`}
    </div>

    <label class="field"><span>Why does it matter to you? <span class="muted">(shown when you're tempted to skip)</span></span>
      <input type="text" name="why" value="${esc(draft.why)}" placeholder="First chair at the spring concert" maxlength="80" autocomplete="off"></label>

    <details class="card soft" style="padding:0 14px;margin-bottom:12px" ${draft.event ? 'open' : ''}>
      <summary style="min-height:48px;display:flex;align-items:center;font-weight:750">Working toward a date?</summary>
      <div class="two" style="padding-bottom:12px">
        <label class="field" style="margin:0"><span>Event</span><input type="text" name="eventLabel" value="${esc(draft.event?.label || '')}" placeholder="Regionals"></label>
        <label class="field" style="margin:0"><span>Date</span><input type="date" name="eventDate" value="${esc(draft.event?.date || '')}"></label>
      </div>
    </details>

    <details class="card soft" style="padding:0 14px;margin-bottom:12px">
      <summary style="min-height:48px;display:flex;align-items:center;font-weight:750">For your activities record</summary>
      <label class="field"><span>Your role</span><input type="text" name="role" value="${esc(draft.role)}" maxlength="50" placeholder="Mechanical sub-team lead"></label>
      <label class="field"><span>Organization</span><input type="text" name="org" value="${esc(draft.org)}" maxlength="100" placeholder="Nueva Robotics"></label>
      <div class="field"><span>Grades</span><div class="days">${[9, 10, 11, 12].map((g) =>
        `<button type="button" class="day-toggle" data-grade="${g}" aria-pressed="${(draft.grades || []).includes(g)}">${g}</button>`).join('')}</div></div>
      <div class="field"><span>When</span><div class="choices">${[['school', 'School year'], ['break', 'School break'], ['all', 'All year']].map(([id, l]) =>
        `<button type="button" class="choice" data-timing="${id}" aria-pressed="${draft.timing === id}" style="min-height:40px;padding:8px 12px">${l}</button>`).join('')}</div></div>
    </details>

    ${app.sync?.available ? `<label class="toggle" style="margin-bottom:6px"><input type="checkbox" name="share" ${draft.share ? 'checked' : ''}><i></i>
      <span>Share check-ins with my crew<small>Partners and clubs see that you showed up</small></span></label>` : ''}

    <div class="actions">
      ${existing ? '<button class="btn soft danger" name="op" value="archive" formnovalidate>Remove</button>' : '<button class="btn ghost" value="cancel" formnovalidate>Cancel</button>'}
      <button class="btn primary" name="op" value="save">Save</button>
    </div>`;

  const res = await sheet(`<div data-body>${body()}</div>`, {
    onMount(form) {
      const host = form.querySelector('[data-body]');
      const capture = () => {
        const f = form;
        draft.title = f.title?.value ?? draft.title;
        draft.why = f.why?.value ?? draft.why;
        draft.role = f.role?.value ?? draft.role;
        draft.org = f.org?.value ?? draft.org;
        const label = f.eventLabel?.value?.trim(), date = f.eventDate?.value;
        draft.event = label || date ? { label: label || 'Big day', date: date || '' } : null;
        if (isFixed(draft) && f.start) { draft.schedule.start = f.start.value; draft.schedule.end = f.end.value; }
      };
      host.addEventListener('click', (e) => {
        const b = e.target.closest('button[type=button]');
        if (!b) return;
        capture();
        if (b.dataset.kind) { draft.kind = b.dataset.kind; draft.color = existing ? draft.color : KINDS[b.dataset.kind].color; }
        if (b.dataset.mode === 'fixed' && !isFixed(draft)) draft.schedule = { mode: 'fixed', days: [], start: '16:00', end: '17:30' };
        if (b.dataset.mode === 'flexible' && isFixed(draft)) draft.schedule = { mode: 'flexible' };
        if (b.dataset.day) {
          const d = Number(b.dataset.day);
          const days = new Set(draft.schedule.days || []);
          days.has(d) ? days.delete(d) : days.add(d);
          draft.schedule.days = [...days];
        }
        if (b.dataset.step) draft.target.sessions = Math.min(14, Math.max(1, draft.target.sessions + Number(b.dataset.step)));
        if (b.dataset.mins) draft.target.minutes = Number(b.dataset.mins);
        if (b.dataset.time) draft.time = b.dataset.time;
        if (b.dataset.grade) {
          const g = Number(b.dataset.grade);
          const set = new Set(draft.grades || []);
          set.has(g) ? set.delete(g) : set.add(g);
          draft.grades = [...set].sort();
        }
        if (b.dataset.timing) draft.timing = b.dataset.timing;
        const openDetails = [...host.querySelectorAll('details')].map((d) => d.open);
        host.innerHTML = body();
        host.querySelectorAll('details').forEach((d, i) => { d.open = openDetails[i]; });
      });
    }
  });
  if (!res) return null;

  const form = document.getElementById('sheet-form');
  if (res.get('op') === 'archive') {
    const snap = structuredClone(app.S);
    await persist((st) => { const x = st.commitments.find((y) => y.id === existing.id); if (x) x.archived = true; });
    toast(`${existing.title} removed`, { label: 'Undo', run: () => restore(snap) });
    return null;
  }

  draft.title = String(res.get('title') || '').trim() || KINDS[draft.kind].label;
  draft.why = String(res.get('why') || '').trim();
  draft.role = String(res.get('role') || '').trim();
  draft.org = String(res.get('org') || '').trim();
  const eventLabel = String(res.get('eventLabel') || '').trim(), eventDate = String(res.get('eventDate') || '');
  draft.event = eventLabel || eventDate ? { label: eventLabel || 'Big day', date: eventDate } : null;
  if (form.share) draft.share = form.share.checked;
  if (isFixed(draft)) {
    draft.schedule.start = String(res.get('start') || draft.schedule.start);
    draft.schedule.end = String(res.get('end') || draft.schedule.end);
    if (!draft.schedule.days?.length) { toast('Pick at least one day'); return null; }
    if (toMin(draft.schedule.end) <= toMin(draft.schedule.start)) { toast('The end time needs to be after the start'); return null; }
    draft.target = { sessions: draft.schedule.days.length, minutes: toMin(draft.schedule.end) - toMin(draft.schedule.start) };
  }

  await persist((st) => {
    const i = st.commitments.findIndex((x) => x.id === draft.id);
    if (i >= 0) st.commitments[i] = draft; else st.commitments.push(draft);
  });
  toast(existing ? 'Saved' : `${draft.title} added — it's on your plan`);
  afterSave?.(draft);
  return draft;
}

// ------------------------------------------------------------------ detail

export async function commitmentDetail(id) {
  const c = commitmentById(id);
  if (!c) return;
  const S = app.S;
  const p = weekProgress(c, S.checkins);
  const streak = weekStreak(c, S.checkins);
  const rec = activityRecord(S, c);
  const recent = S.checkins.filter((k) => k.commitmentId === c.id).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 4);
  const doneToday = S.checkins.some((k) => k.commitmentId === c.id && k.date === dateKey(new Date()));
  const eventDays = c.event?.date ? daysUntil(c.event.date) : null;

  const res = await sheet(`
    <div class="sheet-hero" style="--c:${c.color}">
      <span class="kind-ic" style="width:52px;height:52px;border-radius:17px">${svg(KIND_ICON[c.kind] || I.star, 26)}</span>
      <div class="grow"><h2 style="margin:0">${esc(c.title)}</h2><div class="muted small">${esc(scheduleLabel(c, daysLabel))}</div></div>
    </div>
    ${c.why ? `<div class="card soft small" style="display:flex;gap:8px;align-items:center;margin-bottom:12px">${svg(I.heart, 16)}<span>${esc(c.why)}</span></div>` : ''}

    <div class="stats">
      <div class="stat"><b>${p.done}/${p.target}</b><span>this week</span></div>
      <div class="stat"><b>${streak}</b><span>${streak === 1 ? 'week' : 'weeks'} in a row</span></div>
      <div class="stat"><b>${Math.round(rec.totalHours)}</b><span>hours logged</span></div>
    </div>

    <div class="row between" style="margin:4px 2px 14px"><span class="small muted">Last 8 weeks</span>${weekDots(c)}</div>
    ${eventDays != null && eventDays >= 0 ? `<div class="card soft row small" style="margin-bottom:12px">${svg(I.flag, 16)}<span class="grow"><b>${esc(c.event.label)}</b> in ${plural(eventDays, 'day')}</span></div>` : ''}

    ${recent.length ? `<div class="q" style="margin-top:4px">Recent</div>
      <div class="card flush" style="margin-bottom:0">${recent.map((k) => `<div class="item"><div class="grow">
        <div class="t" style="font-weight:650">${esc(k.note || FEELS[k.feel] || 'Checked in')}</div>
        <div class="m">${ago(k.at)} · ${fmtMinutes(k.minutes)}</div></div></div>`).join('')}</div>` : ''}

    <div class="actions">
      <button class="btn soft" name="op" value="edit">${svg(I.edit, 16)} Edit</button>
      <button class="btn primary" name="op" value="checkin" ${doneToday && !isFixed(c) ? '' : ''}>${svg(I.check, 16)} ${doneToday ? 'Check in again' : 'Check in'}</button>
    </div>`);
  if (!res) return;
  if (res.get('op') === 'edit') return commitmentEditor(c);
  if (res.get('op') === 'checkin') return checkinFlow(c.id);
}

export const actions = {
  'add-commit': () => commitmentEditor(null, { kind: 'practice' }),
  'open-commit': (el) => commitmentDetail(el.dataset.id),
  'edit-commit': (el) => commitmentEditor(commitmentById(el.dataset.id)),
  checkin: (el) => checkinFlow(el.dataset.id, { day: el.dataset.day || null }),
  'undo-checkin': (el) => undoCheckin(el.dataset.id).then(() => toast('Check-in removed')),
  'checkin-session': (el) => {
    const s = findSession(app.S, el.dataset.id);
    if (s?.commitmentId) checkinFlow(s.commitmentId, { sessionId: s.id });
  }
};

/** "C" and the palette both need a quick "which one?" list. */
export async function checkinPicker() {
  const list = (app.S.commitments || []).filter((c) => !c.archived);
  if (!list.length) return commitmentEditor(null, { kind: 'practice' });
  if (list.length === 1) return checkinFlow(list[0].id);
  const res = await sheet(`<h2>Check in</h2><p class="lead">What did you just do?</p>
    <div class="choices stacked">${list.map((c) => {
      const p = weekProgress(c, app.S.checkins);
      return `<button class="choice" name="id" value="${c.id}" style="display:flex;align-items:center;gap:12px">
        <span class="kind-ic" style="--c:${c.color};width:34px;height:34px">${svg(KIND_ICON[c.kind] || I.star, 17)}</span>
        <span style="flex:1">${esc(c.title)}<small>${p.label} this week</small></span></button>`;
    }).join('')}</div>
    <div class="actions"><button class="btn ghost" value="cancel">Cancel</button></div>`);
  if (res?.get('id')) checkinFlow(String(res.get('id')));
}
