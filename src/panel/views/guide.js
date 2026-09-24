// Assignment guides: what you're doing, what to turn in, the steps (tied to
// your planned blocks), and where the materials are.

import { app, persist, push, back, render, insideCanvas, DEMO, learnedNotes } from '../core.js';
import * as canvas from '../../lib/canvas.js';
import * as ai from '../../lib/ai.js';
import { buildGuide, fitSteps } from '../../lib/guide.js';
import { fmtMinutes, fmtDay, fmtTime, MIN } from '../../lib/util.js';
import { svg, I, esc, toast, colorFor, dueLabel } from '../ui.js';

const MAT_ICON = { file: I.file, page: I.page, video: I.video, link: I.link, discussion: I.chat, quiz: I.quiz, assignment: I.list, textbook: I.book };
const MAT_WORD = { file: 'File', page: 'Page', video: 'Video', link: 'Website', discussion: 'Discussion', quiz: 'Quiz', assignment: 'Assignment', textbook: 'Textbook' };
const loading = new Set();

const origin = () => app.S.settings.canvasHost || app.ctx.origin || '';

/** The offline guide, upgraded by Cadence Intelligence when it's on. */
export function composeGuide(t) {
  const base = buildGuide(t, t.guideData || {}, { origin: origin() });
  const a = t.guideAI;
  if (!a) return { ...base, keyIdeas: [], watchOut: '', ai: false };
  const byId = Object.fromEntries(base.materials.map((m) => [m.id, m]));
  const picked = (a.materials || []).map((x) => byId[x.id] && { ...byId[x.id], why: x.why }).filter(Boolean);
  const steps = (a.steps || []).map((x) => ({ title: x.title, weight: x.minutes, detail: x.how }));
  return {
    ...base,
    headline: a.summary || base.headline,
    deliverables: a.deliverables?.length ? [...a.deliverables.map((text) => ({ text, kind: 'include' })), ...base.deliverables.filter((d) => d.kind === 'submit')] : base.deliverables,
    steps: steps.length ? fitSteps(steps, t.estimateMin || 30) : base.steps,
    materials: [...picked, ...base.materials.filter((m) => !picked.some((x) => x.id === m.id))],
    keyIdeas: a.keyIdeas || [],
    watchOut: a.watchOut || '',
    ai: true
  };
}

export async function ensureGuide(id) {
  const t = app.S.tasks[id];
  if (!t || loading.has(id)) return;
  const fresh = t.guideData && Date.now() - +new Date(t.guideData.fetchedAt || 0) < 6 * 60 * MIN;
  const wantAI = ai.aiAvailable(app.S.settings) && !t.guideAI;
  if (fresh && !wantAI) return;
  loading.add(id);
  if (app.view === 'guide') render();
  try {
    if (!fresh) {
      let data;
      if (DEMO && id.startsWith('demo_')) data = (await import('../mock.js')).mockGuideData(t);
      else if (insideCanvas && t.source === 'canvas') data = await canvas.fetchGuideData(t);
      else data = { description: t.description || '' };
      data.fetchedAt = new Date().toISOString();
      const had = !!t.description;
      await persist((st) => { const x = st.tasks[id]; if (!x) return; x.guideData = data; if (!x.description && data.description) x.description = data.description; },
        { recalc: !had && !!data.description });
    }
    if (ai.aiAvailable(app.S.settings) && !app.S.tasks[id]?.guideAI) {
      const task = app.S.tasks[id];
      const base = buildGuide(task, task.guideData || {}, { origin: origin() });
      const result = await ai.guideAssignment(app.S.settings, {
        title: task.title, course: task.courseName, due: task.due, points: task.points,
        instructions: base.instructions, rubric: base.rubric,
        materials: base.materials.map((m) => ({ id: m.id, title: m.title, type: m.type, where: m.source })),
        estimateMin: task.estimateMin, notes: learnedNotes()
      });
      if (result) await persist((st) => { if (st.tasks[id]) st.tasks[id].guideAI = result; }, { recalc: false });
    }
  } catch { /* the offline guide is already on screen */ }
  finally {
    loading.delete(id);
    if (app.view === 'guide' || app.view === 'today') render();
  }
}

export function viewGuide() {
  const t = app.S.tasks[app.guideId];
  if (!t) return `<button class="back" data-act="back">${svg(I.left, 16)} Back</button><div class="card soft">That assignment is gone.</div>`;
  const g = composeGuide(t);
  const isLoading = loading.has(t.id);
  const isDone = t.status === 'done';
  const sessions = (app.S.plan?.sessions || []).filter((s) => s.taskId === t.id).sort((a, b) => new Date(a.start) - new Date(b.start));
  const doneMin = sessions.filter((s) => s.done).reduce((a, s) => a + s.minutes, 0);
  const upcoming = sessions.filter((s) => !s.done);

  let acc = 0;
  const steps = g.steps.map((st) => {
    const a = acc, b = acc + st.minutes;
    acc = b;
    let offset = 0, when = null;
    for (const s of sessions) {
      const s0 = offset, s1 = offset + s.minutes;
      offset = s1;
      if (!s.done && s1 > a && s0 < b) { when = s; break; }
    }
    return { ...st, done: isDone || doneMin >= b, when };
  });
  const rubricTotal = g.rubric.reduce((x, r) => x + (Number(r.points) || 0), 0);
  const paragraphs = g.instructions.split(/\n+/).map((x) => x.trim()).filter(Boolean);

  return `<div style="--c:${colorFor(t)}">
    <button class="back" data-act="back">${svg(I.left, 16)} Back</button>
    <header class="guide-head">
      <div class="kicker"><span class="dot"></span>${esc(t.courseName || 'Personal')}${g.moduleName ? ` · ${esc(g.moduleName)}` : ''}</div>
      <h1>${esc(t.title)}</h1>
      <div class="guide-meta"><span>${esc(dueLabel(t.due))}</span>${t.points ? `<span>${t.points} points</span>` : ''}
        <span>~${fmtMinutes(t.estimateMin || 0)}${upcoming.length ? ` · ${upcoming.length} block${upcoming.length === 1 ? '' : 's'}` : ''}</span></div>
    </header>

    <div class="card explain">
      <div class="label">${svg(I.target, 15)} What you're doing</div>
      <p class="headline">${esc(g.headline)}</p>
      ${!g.ai && g.teacherSays && g.teacherSays !== g.headline ? `<p class="teacher">Your teacher's words: “${esc(g.teacherSays)}”</p>` : ''}
      ${g.keyIdeas.length ? `<div class="ideas"><span class="muted small">Key ideas</span>${g.keyIdeas.map((k) => `<span class="pill">${esc(k)}</span>`).join('')}</div>` : ''}
      ${g.ai ? `<div class="ai-note">${svg(I.sparkle, 12)} Explained by Cadence Intelligence</div>` : ''}
    </div>

    ${g.deliverables.length ? `<div class="section"><div class="section-head"><h2>What to turn in</h2></div>
      <div class="card flush">${g.deliverables.map((d) => `<div class="item req ${d.kind === 'submit' ? 'submit' : ''}">
        <span class="req-ic">${svg(d.kind === 'submit' ? I.flag : I.check, 13)}</span><div class="grow t">${esc(d.text)}</div></div>`).join('')}</div></div>` : ''}

    <div class="section"><div class="section-head"><h2>How to tackle it</h2><span class="muted">${fmtMinutes(t.estimateMin || 0)}</span></div>
      <div class="card flush">${steps.map((st, i) => `<div class="step ${st.done ? 'done' : ''}">
        <span class="num">${st.done ? svg(I.check, 13) : i + 1}</span>
        <div class="grow"><div class="t">${esc(st.title)}</div>${st.detail ? `<div class="m">${esc(st.detail)}</div>` : ''}
          ${st.when && !st.done ? `<div class="when">${svg(I.cal, 12)} ${esc(fmtDay(st.when.start))} · ${fmtTime(st.when.start)}</div>` : ''}</div>
        <span class="mins">${fmtMinutes(st.minutes)}</span></div>`).join('')}</div></div>

    ${g.watchOut ? `<div class="card warm small"><b>Heads up:</b> ${esc(g.watchOut)}</div>` : ''}

    <div class="section"><div class="section-head"><h2>Where to find what you need</h2></div>
      <div class="card flush">
        ${g.materials.length ? g.materials.map((m) => `<div class="item tap" data-act="open-material" data-task="${t.id}" data-mid="${m.id}" role="button" tabindex="0">
            <span class="mat-ic big t-${m.type}">${svg(MAT_ICON[m.type] || I.link, 18)}</span>
            <div class="grow"><div class="t">${esc(m.title)}</div><div class="m">${esc(m.why || `${MAT_WORD[m.type] || 'Link'} · ${m.source}`)}</div></div>
            ${m.type === 'textbook' ? '' : `<span class="muted">${svg(I.external, 16)}</span>`}</div>`).join('')
          : isLoading ? '<div class="item"><div class="grow"><div class="skeleton" style="width:70%"></div><div class="skeleton" style="width:45%;margin-top:8px"></div></div></div>'
            : '<div class="item"><div class="grow small muted">No linked materials. Your class notes and this unit\'s module in Canvas are the best place to start.</div></div>'}
      </div></div>

    ${g.rubric.length ? `<div class="section"><div class="section-head"><h2>How it's graded</h2><span class="muted">${rubricTotal ? `${rubricTotal} pts` : ''}</span></div>
      <div class="card flush">${g.rubric.map((r) => `<div class="item"><div class="grow"><div class="t">${esc(r.title)}</div>${r.detail ? `<div class="m">${esc(r.detail)}</div>` : ''}</div>
        ${r.points != null ? `<span class="side"><b>${r.points}</b> pts</span>` : ''}</div>`).join('')}</div></div>` : ''}

    ${paragraphs.length ? `<details class="card instructions" style="margin-top:14px"><summary><span>Full instructions from your teacher</span>${svg(I.right, 16)}</summary>
      <div class="body">${paragraphs.map((x) => `<p>${esc(x)}</p>`).join('')}</div></details>` : ''}

    <div class="guide-actions">
      ${t.url ? `<button class="btn soft" data-act="open-url" data-url="${esc(t.url)}">${svg(I.external, 15)} Canvas</button>` : ''}
      ${isDone ? `<button class="btn soft" data-act="reopen" data-id="${t.id}">Mark not done</button>`
        : `<button class="btn primary" data-act="complete" data-id="${t.id}">${svg(I.check, 15)} Mark done</button>`}
    </div>
    ${isDone || !app.S.sources?.google?.push ? '' : `<div class="row" style="margin-top:10px">
      <button class="btn small ${t.pushToGoogle ? 'soft' : 'ghost'} block" data-act="push-item-toggle" data-id="${t.id}" data-kind="assignment">
        ${svg(I.cal, 14)} ${t.pushToGoogle ? 'On your Google Calendar' : 'Add its blocks to Google Calendar'}</button></div>`}
    ${isDone ? '' : `<div class="row wrap" style="justify-content:center;gap:4px;margin-top:8px">
      <button class="btn small ghost" data-act="edit" data-id="${t.id}">Change time</button>
      <button class="btn small ghost" data-act="pin" data-id="${t.id}">${t.pinned ? 'Unpin' : 'Do this first'}</button>
      <button class="btn small ghost" data-act="dismiss" data-id="${t.id}">${t.source === 'manual' ? 'Delete' : 'Not doing this'}</button></div>`}
  </div>`;
}

function openMaterial(taskId, mid) {
  const t = app.S.tasks[taskId];
  if (!t) return;
  const m = composeGuide(t).materials.find((x) => x.id === mid);
  if (!m) return;
  if (m.type === 'textbook') return toast(`${m.title} — in your textbook or class notes`);
  if (!m.url) return toast(DEMO ? `In Canvas, this opens “${m.title}”` : `Find “${m.title}” in your course on Canvas`);
  let url = m.url;
  try { url = new URL(m.url, origin() || undefined).href; } catch { /* already absolute */ }
  if (/^https?:/i.test(url)) window.open(url, '_blank', 'noopener');
}

export const actions = {
  'push-item-toggle': async (el) => {
    const { persist, pushGoogleBlocks } = await import('../core.js');
    const { id, kind } = el.dataset;
    let on = false;
    await persist((st) => {
      if (kind === 'commitment') { const c = st.commitments.find((x) => x.id === id); if (c) { c.pushToGoogle = !c.pushToGoogle; on = c.pushToGoogle; } }
      else if (st.tasks[id]) { st.tasks[id].pushToGoogle = !st.tasks[id].pushToGoogle; on = st.tasks[id].pushToGoogle; }
    }, { recalc: false });
    toast(on ? 'Adding its blocks to Google Calendar…' : 'Removing its blocks from Google Calendar…');
    pushGoogleBlocks({ quiet: true });
  },
  'open-guide': (el) => {
    if (!app.S.tasks[el.dataset.id]) return;
    push('guide', { guideId: el.dataset.id });
    ensureGuide(el.dataset.id);
  },
  'open-material': (el) => openMaterial(el.dataset.task, el.dataset.mid),
  'open-url': (el) => { if (/^https?:/i.test(el.dataset.url)) window.open(el.dataset.url, '_blank', 'noopener'); }
};
