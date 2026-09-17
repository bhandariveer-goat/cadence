// Teacher tools: say an assignment out loud, review the draft, create it in
// Canvas. Club leaders get the same shortcut to Crew.

import { app, persist, insideCanvas, go } from '../core.js';
import * as canvas from '../../lib/canvas.js';
import * as ai from '../../lib/ai.js';
import { parseAssignmentText } from '../../lib/parse.js';
import { estimate, CATEGORIES } from '../../lib/estimator.js';
import { svg, I, esc, sheet, toast, greeting, toLocalInput } from '../ui.js';

export function viewCreate() {
  const S = app.S;
  const draft = S.draft || null;
  const teaching = app.courses.filter((c) => /teacher|ta/i.test(c.role));
  const list = teaching.length ? teaching : app.courses;
  const placeholder = 'Try: “For AP Bio, cell respiration lab report, due next Friday, worth 50 points, should take about two hours.”';

  return `
    <section class="hello"><h1>${greeting(S.profile.name)}</h1><p>Say an assignment the way you'd tell your class. Cadence drafts it for Canvas.</p></section>

    <div class="card center">
      <button class="mic" id="mic" data-act="mic" aria-label="Start dictation">${svg(I.mic)}</button>
      <div class="small muted" id="mic-status">Tap to start talking</div>
      <div class="transcript" id="transcript" data-placeholder="${esc(placeholder)}" style="margin-top:12px;text-align:left">${esc(S.draftTranscript || '')}</div>
      <details style="margin-top:10px;text-align:left">
        <summary class="link small" style="cursor:pointer">Or type it instead</summary>
        <textarea id="typed" style="margin-top:8px" placeholder="Worksheet on chapter 3, due Thursday, 20 points"></textarea>
        <button class="btn small soft" data-act="parse-typed" style="margin-top:8px">Make a draft</button>
      </details>
    </div>

    ${draft ? `
    <div class="section-head" style="margin-top:18px"><h2>Review before it goes out</h2></div>
    <form class="card" data-form="save-draft">
      <label class="field"><span>Title</span><input type="text" name="title" value="${esc(draft.title || '')}" required></label>
      <label class="field"><span>Course</span><select name="courseId"><option value="">Choose a course</option>
        ${list.map((c) => `<option value="${c.id}" ${draft.courseId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <div class="two">
        <label class="field"><span>Due</span><input type="datetime-local" name="due" value="${toLocalInput(draft.due)}"></label>
        <label class="field"><span>Points</span><input type="number" name="points" min="0" step="1" value="${draft.points ?? ''}"></label>
      </div>
      <label class="field"><span>Instructions for students</span><textarea name="description">${esc(draft.description || draft.transcript || '')}</textarea></label>
      <div class="two">
        <label class="field"><span>Expected time (min)</span><input type="number" name="estimateMin" min="5" step="5" value="${draft.estimateMin ?? ''}"
          placeholder="${estimate({ title: draft.title, description: draft.description || draft.transcript }, S.model).minutes}"></label>
        <label class="field"><span>Type</span><select name="category">${Object.entries(CATEGORIES).map(([id, v]) =>
          `<option value="${id}" ${draft.category === id ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>
      </div>
      <p class="hint" style="margin:-4px 0 12px">Sharing the expected time helps every student plan it properly.</p>
      <label class="toggle"><input type="checkbox" name="publish"><i></i><span>Publish right away<small>Otherwise it's saved as an unpublished draft</small></span></label>
      <div class="row" style="margin-top:16px;gap:8px">
        <button class="btn ghost" type="button" data-act="discard-draft">Discard</button><span class="grow"></span>
        <button class="btn primary" type="submit" ${insideCanvas ? '' : 'disabled title="Open Cadence from Canvas to create assignments"'}>Create in Canvas</button>
      </div>
    </form>` : ''}

    <button class="card row" data-act="go" data-tab="crew" style="width:100%;text-align:left;cursor:pointer;margin-top:14px">
      <span class="kind-ic" style="--c:var(--green)">${svg(I.users)}</span>
      <div class="grow"><div class="card-title">Clubs & classes</div><div class="card-sub">Set a weekly goal and see who's keeping up</div></div>${svg(I.right, 18)}
    </button>`;
}

let recog = null;

function toggleMic() {
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Rec) return toast("Voice isn't available in this browser — type it instead");
  if (recog) { recog.stop(); return; }
  recog = new Rec();
  recog.continuous = true;
  recog.interimResults = true;
  recog.lang = navigator.language || 'en-US';
  let finalText = '';
  recog.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += `${r[0].transcript} `; else interim += r[0].transcript;
    }
    const node = document.getElementById('transcript');
    if (node) node.textContent = (finalText + interim).trim();
  };
  recog.onerror = (e) => { toast(e.error === 'not-allowed' ? 'Cadence needs microphone access for this' : "Didn't catch that — try again"); stopMic(); };
  recog.onend = () => { const text = (document.getElementById('transcript')?.textContent || '').trim(); stopMic(); if (text) parseDraft(text); };
  recog.start();
  document.getElementById('mic')?.classList.add('rec');
  const st = document.getElementById('mic-status');
  if (st) st.textContent = "Listening… tap again when you're done";
}

function stopMic() {
  recog = null;
  document.getElementById('mic')?.classList.remove('rec');
  const st = document.getElementById('mic-status');
  if (st) st.textContent = 'Tap to start talking';
}

async function parseDraft(text) {
  text = String(text || '').trim();
  if (!text) return toast('Say or type the assignment first');
  const offline = parseAssignmentText(text, { courses: app.courses });
  let draft = { title: offline.title, courseId: offline.courseId, due: offline.due, points: offline.points, estimateMin: offline.estimateMin, category: offline.category, description: '', transcript: text };
  if (ai.aiAvailable(app.S.settings)) {
    try {
      const better = await ai.parseDictation(app.S.settings, text, { courses: app.courses });
      if (better?.title) {
        const match = app.courses.find((c) => better.courseName && c.name.toLowerCase().includes(better.courseName.toLowerCase()));
        draft = { ...draft, title: better.title, description: better.description || '', due: better.dueISO ? new Date(better.dueISO).toISOString() : draft.due,
          points: better.points ?? draft.points, estimateMin: better.estimateMin ?? draft.estimateMin, category: better.category || draft.category, courseId: match?.id || draft.courseId };
      }
    } catch { /* offline parse is already good */ }
  }
  await persist((st) => { st.draft = draft; st.draftTranscript = text; }, { recalc: false });
}

async function saveDraft(form, fd) {
  const draft = {
    title: String(fd.get('title') || '').trim(),
    courseId: String(fd.get('courseId') || '') || null,
    due: fd.get('due') ? new Date(String(fd.get('due'))).toISOString() : null,
    points: fd.get('points') !== '' ? Number(fd.get('points')) : null,
    description: String(fd.get('description') || ''),
    estimateMin: fd.get('estimateMin') !== '' ? Number(fd.get('estimateMin')) : null,
    category: String(fd.get('category') || 'worksheet'),
    publish: fd.get('publish') === 'on'
  };
  if (!draft.title) return toast('Give it a title first');
  if (!draft.courseId) return toast('Choose which course it belongs to');
  const course = app.courses.find((c) => c.id === draft.courseId);
  const ok = await sheet(`
    <h2>Create this assignment?</h2>
    <p class="lead">It'll be added to <b>${esc(course?.name || 'your course')}</b> ${draft.publish ? 'and <b>published to students right away</b>' : 'as an unpublished draft'}.</p>
    <div class="card soft small" style="margin:0"><b>${esc(draft.title)}</b><div class="muted">${draft.due ? esc(new Date(draft.due).toLocaleString([], { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })) : 'No due date'}${draft.points != null ? ` · ${draft.points} points` : ''}</div></div>
    <div class="actions"><button class="btn ghost" value="cancel">Go back</button><button class="btn primary" name="op" value="create">${draft.publish ? 'Create & publish' : 'Create draft'}</button></div>`);
  if (!ok) return;
  try {
    const desc = draft.estimateMin ? `${draft.description}\n\n<p><em>Expected time: about ${draft.estimateMin} minutes.</em></p>` : draft.description;
    const created = await canvas.createAssignment(draft.courseId, { ...draft, description: desc });
    await persist((st) => { st.draft = null; st.draftTranscript = ''; }, { recalc: false });
    toast(created?.published ? 'Created and published in Canvas' : 'Draft created in Canvas');
  } catch (e) {
    toast(`Canvas couldn't create it: ${e.message}`);
  }
}

export const actions = {
  mic: () => toggleMic(),
  'parse-typed': () => parseDraft(document.getElementById('typed')?.value),
  'discard-draft': () => persist((st) => { st.draft = null; st.draftTranscript = ''; }, { recalc: false })
};

export const submitActions = { 'save-draft': saveDraft };
