// What Cadence knows about you: the notes and preferences you (or the
// assistant) saved, and the patterns it noticed from how you actually work,
// each with what it changes in the plan. Everything here can be switched off
// or deleted. The logic lives in lib/memory.js.

import { app, persist, undoTo } from '../core.js';
import { memoryOf, addNote, forgetNote, setPrefs, insights, clearNoticed } from '../../lib/memory.js';
import { svg, I, esc, sheet, toast, timeSelect, ago } from '../ui.js';
import { fmtClock } from '../../lib/util.js';

export function viewMemory() {
  const S = app.S;
  const m = memoryOf(S);
  const found = insights(S);
  const p = m.prefs;
  const courses = courseNames(S);

  const pref = (act, title, value, clear) => `
    <div class="integration">
      <div class="grow"><div class="t">${title}</div><div class="m">${value ? esc(value) : 'Not set'}</div></div>
      ${value && clear ? `<button class="btn small ghost" data-act="memory-clear-pref" data-key="${clear}">Clear</button>` : ''}
      <button class="btn small soft" data-act="${act}">${value ? 'Change' : 'Set'}</button></div>`;

  return `
    <button class="back" data-act="back">${svg(I.left, 16)} Go back</button>
    <section class="hello">
      <h1>What Cadence knows about you</h1>
      <p>Cadence plans your weeks with this, and the assistant reads it with every message. It is saved with your plan: in this browser, and in your account if you signed in with an email.</p>
    </section>

    <div class="section-head"><h2>Things you told Cadence</h2></div>
    <div class="card flush">
      ${m.notes.length ? m.notes.slice().reverse().map((n) => `
        <div class="integration">
          <div class="grow"><div class="t">${esc(n.text)}</div>
            <div class="m">${n.by === 'assistant' ? 'Saved by the assistant' : 'Added by you'} ${esc(ago(n.at))}</div></div>
          <button class="btn small ghost" data-act="memory-forget" data-id="${esc(n.id)}" aria-label="Forget: ${esc(n.text)}">Forget</button>
        </div>`).join('') : `
        <div class="integration"><div class="grow"><div class="m">Nothing yet. Tell the assistant things like “practice runs late on Tuesdays” or “I focus best right after dinner” and it will remember them.</div></div></div>`}
      <form class="integration" data-form="memory-add" autocomplete="off">
        <div class="grow with-btn">
          <input name="note" maxlength="160" placeholder="Add something, like: chem takes me longer than people think" aria-label="Something for Cadence to remember">
          <button class="btn soft" type="submit">Add</button>
        </div>
      </form>
    </div>

    <div class="section-head mt6"><h2>Your preferences</h2></div>
    <div class="card flush">
      ${pref('memory-start-school', 'Earliest start on school days', p.startSchool ? fmtClock(p.startSchool) : '', 'school_day_start')}
      ${pref('memory-start-free', 'Earliest start on days off', p.startFree ? fmtClock(p.startFree) : '', 'free_day_start')}
      ${pref('memory-first', 'Class to do first', p.firstCourse || '', 'first_class')}
    </div>
    <p class="hint">These are preferences, not rules. If following one would leave something without room before it is due, Cadence plans without it that week.${courses.length ? '' : ' A class to do first can be picked once you have assignments.'}</p>

    <div class="section-head mt6"><h2>What Cadence has noticed</h2></div>
    <div class="card flush">
      <label class="integration toggle">
        <span class="grow"><span class="t block">Learn from how I work</span>
          <small>When you start, how long your blocks last, which classes get moved, and how long assignments really take</small></span>
        <input type="checkbox" data-act="memory-learn" ${m.learn ? 'checked' : ''}><i></i></label>
      ${found.length ? found.map((x) => `
        <label class="integration toggle">
          <span class="grow"><span class="t block">${esc(x.text)}</span><small>${esc(x.effect)}</small></span>
          <input type="checkbox" data-act="memory-use" data-id="${esc(x.id)}" ${!m.ignore[x.id] ? 'checked' : ''} ${m.learn ? '' : 'disabled'} aria-label="Use this: ${esc(x.text)}"><i></i></label>`).join('')
    : `<div class="integration"><div class="grow"><div class="m">${m.learn
      ? 'Nothing yet. As you start, finish and move blocks, Cadence works out when you usually begin, how long you focus and which classes slip. It waits for about a week of evidence before changing anything.'
      : 'Learning is off, so nothing new is noticed and nothing noticed changes your plan.'}</div></div></div>`}
    </div>
    ${found.length || (S.model?.biases && Object.keys(S.model.biases).length) ? `<button class="btn soft danger mt3" data-act="memory-clear-noticed">Clear what Cadence noticed</button>` : ''}
  `;
}

/** The class names in the plan, for "do this class first". */
function courseNames(S) {
  const set = new Set();
  for (const t of Object.values(S.tasks || {})) if (t.courseName && t.status !== 'done') set.add(t.courseName.trim());
  return [...set].sort((a, b) => a.localeCompare(b));
}

async function startSheet(field, title) {
  const now = memoryOf(app.S).prefs[field];
  const res = await sheet(`
    <h2>${title}</h2>
    <p class="lead">Cadence will plan your first block from this time when the week has room. Telling the assistant “I can start at 4 today” still changes a single day.</p>
    <div class="field"><span>Start from</span>${timeSelect('at', now || (field === 'startSchool' ? '16:30' : '10:00'))}</div>
    <div class="actions"><button class="btn ghost" value="cancel">Cancel</button><button class="btn primary" name="op" value="save">Save</button></div>`);
  if (res?.get('op') !== 'save') return;
  const at = String(res.get('at'));
  await persist((st) => { setPrefs(st, field === 'startSchool' ? { startSchool: at } : { startFree: at }); });
  toast('Saved. Your plan moved with it.');
}

async function firstSheet() {
  const courses = courseNames(app.S);
  if (!courses.length) return toast('Add or sync some assignments first, then pick a class.');
  const cur = memoryOf(app.S).prefs.firstCourse;
  const res = await sheet(`
    <h2>Class to do first</h2>
    <p class="lead">When two things are due the same day, this class goes first. Something due sooner still comes before it.</p>
    <div class="choices stacked">${courses.map((c) => `<button class="choice" name="course" value="${esc(c)}" aria-pressed="${cur === c}">${esc(c)}</button>`).join('')}</div>
    <div class="actions"><button class="btn ghost" value="cancel">Cancel</button></div>`);
  const pick = res?.get('course');
  if (!pick || !courses.includes(pick)) return;
  await persist((st) => { setPrefs(st, { firstCourse: pick }); });
  toast(`${pick} goes first now.`);
}

async function clearNoticedFlow() {
  const res = await sheet(`<h2>Clear what Cadence noticed?</h2>
    <p class="lead">This forgets when you usually start, how long your blocks last, which classes get moved, and how long assignments take you, so estimates go back to typical ones. Things you told Cadence stay.</p>
    <div class="actions"><button class="btn soft" value="cancel">Keep it</button><button class="btn danger-solid" name="op" value="clear">Clear it</button></div>`);
  if (res?.get('op') !== 'clear') return;
  const snap = structuredClone(app.S);
  await persist((st) => clearNoticed(st));
  toast('Cleared. Cadence starts learning again from here.', undoTo(snap));
}

export const actions = {
  'memory-forget': async (el) => {
    const snap = structuredClone(app.S);
    await persist((st) => { forgetNote(st, el.dataset.id); }, { recalc: false });
    toast('Forgotten', undoTo(snap));
  },
  'memory-clear-pref': async (el) => {
    const snap = structuredClone(app.S);
    await persist((st) => { setPrefs(st, { clear: [el.dataset.key] }); });
    toast('Cleared. Your plan moved with it.', undoTo(snap));
  },
  'memory-start-school': () => startSheet('startSchool', 'Earliest start on school days'),
  'memory-start-free': () => startSheet('startFree', 'Earliest start on days off'),
  'memory-first': () => firstSheet(),
  'memory-clear-noticed': () => clearNoticedFlow()
};

export const changeActions = {
  'memory-learn': (el) => persist((st) => { memoryOf(st).learn = el.checked; }),
  'memory-use': (el) => persist((st) => {
    const m = memoryOf(st);
    if (el.checked) delete m.ignore[el.dataset.id]; else m.ignore[el.dataset.id] = true;
  })
};

export const submitActions = {
  'memory-add': async (form, data) => {
    // Tried on a copy first, so a note that is refused changes nothing.
    const tried = addNote(structuredClone(app.S), data.get('note'), 'you');
    if (tried.error) return toast(tried.error);
    await persist((st) => { addNote(st, data.get('note'), 'you'); }, { recalc: false });
    toast(tried.refreshed ? 'Cadence already knew that. Updated.' : 'Cadence will remember that.');
  }
};
