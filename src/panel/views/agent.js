// The assistant panel — the website's front door.
//
// A student types the way they'd text a friend ("dinner at 6, practice Tue and
// Thu, I can stay up till midnight") and Cadence writes it into the week:
// events that block time, a later cutoff for one night, homework with a due
// date. Everything it does is listed and undoable in one click, because an
// agent that edits your calendar without showing its work is not trustworthy.

import { app, persist, restore, go } from '../core.js';
import { interpret, applyOps, opsFromSpec, agentEvents } from '../../lib/agent.js';
import { aiAvailable, planFromMessage } from '../../lib/ai.js';
import { svg, I, esc, toast, $ } from '../ui.js';
import { fmtDay, fmtTime } from '../../lib/util.js';

const KIND_LABEL = {
  event: 'On your calendar',
  window: 'When you’re free',
  task: 'Added to your work',
  commitment: 'New commitment',
  capacity: 'Daily limit'
};

const STARTERS = [
  'Dinner at 6, and I can stay up till midnight',
  'Practice Tuesday and Thursday 4–6',
  'Bio test Friday, should take 2 hours to study',
  'I want to run 4 times a week for 45 minutes'
];

export function ensureAgent() {
  app.agent ||= { open: false, thread: [], busy: false, draft: '' };
  return app.agent;
}

// ------------------------------------------------------------------ view

export function agentPanel() {
  const a = ensureAgent();
  const empty = !a.thread.length;
  return `
    <div class="ag-head">
      <div class="ag-title">
        <span class="ag-mark">${svg(I.sparkle, 16)}</span>
        <div>
          <b>Assistant</b>
          <small>${aiAvailable(app.S.settings) ? 'Powered by Claude' : 'Tell it about your week'}</small>
        </div>
      </div>
      <button class="icon-btn" data-act="agent-close" aria-label="Close assistant">${svg(I.x, 18)}</button>
    </div>

    <div class="ag-thread" id="ag-thread">
      ${empty ? `
        <div class="ag-intro">
          <p>Tell me what's going on this week and I'll put it in — the things that take time, when you're actually free, and what's due.</p>
          <div class="ag-starters">
            ${STARTERS.map((s) => `<button class="ag-starter" data-act="agent-starter" data-text="${esc(s)}">${esc(s)}</button>`).join('')}
          </div>
        </div>` : a.thread.map(bubble).join('')}
      ${a.busy ? '<div class="ag-msg from-agent"><div class="ag-bubble ag-thinking"><i></i><i></i><i></i></div></div>' : ''}
    </div>

    <form class="ag-compose" data-form="agent-send" autocomplete="off">
      <textarea name="text" id="ag-input" rows="1" placeholder="I have dinner at 6&hellip;" ${a.busy ? 'disabled' : ''}>${esc(a.draft || '')}</textarea>
      <button class="ag-send" type="submit" aria-label="Send" ${a.busy ? 'disabled' : ''}>${svg(I.up, 18)}</button>
    </form>`;
}

function bubble(m, i) {
  if (m.role === 'you') return `<div class="ag-msg you"><div class="ag-bubble">${esc(m.text)}</div></div>`;
  return `
    <div class="ag-msg from-agent">
      <div class="ag-bubble">${esc(m.text)}</div>
      ${m.ops?.length ? `<div class="ag-changes">
        ${m.ops.map(opRow).join('')}
        <div class="ag-actions">
          <button class="btn ghost small" data-act="agent-undo" data-i="${i}">Undo</button>
          <button class="btn soft small" data-act="agent-show">See it on the calendar</button>
        </div>
      </div>` : ''}
    </div>`;
}

const opRow = (op) => `
  <div class="ag-change">
    <span class="ag-dot ${op.kind}"></span>
    <div><b>${esc(op.summary)}</b><small>${esc(KIND_LABEL[op.kind] || '')}</small></div>
  </div>`;

// --------------------------------------------------------------- sending

async function send(text) {
  const a = ensureAgent();
  const clean = String(text || '').trim();
  if (!clean || a.busy) return;

  a.thread.push({ role: 'you', text: clean });
  a.draft = '';
  // Clear the box itself: render() reads it back before redrawing.
  const box = $('#ag-input');
  if (box) box.value = '';
  a.busy = true;
  render();

  const now = new Date();
  let ops = [];
  let note = '';
  try {
    if (aiAvailable(app.S.settings)) {
      const spec = await planFromMessage(app.S.settings, clean, { now, context: contextLine() });
      ops = opsFromSpec(spec.items, now);
      note = spec.note;
    }
  } catch {
    // The key can be missing, rate-limited or offline — the local reading
    // still works, so the student never hits a dead end.
  }
  if (!ops.length) ops = interpret(clean, app.S, now);

  if (!ops.length) {
    a.busy = false;
    a.thread.push({
      role: 'agent',
      text: note || "I couldn't find anything to schedule in that. Try naming a time or a day — “dinner at 6”, “practice Tue and Thu 4–6”, “I can stay up till midnight”."
    });
    return render();
  }

  const snapshot = structuredClone(app.S);
  await persist((st) => { applyOps(st, ops, now); });
  a.busy = false;
  a.thread.push({ role: 'agent', text: note || confirmation(ops), ops, snapshot });
  render();
}

function confirmation(ops) {
  if (ops.length === 1) return `Done — ${ops[0].summary.toLowerCase()}. I've rebuilt your plan around it.`;
  return `Done — ${ops.length} changes, and your plan is rebuilt around them.`;
}

/** A little context makes Claude's dates and wording match what she sees. */
function contextLine() {
  const S = app.S;
  const names = (S.commitments || []).filter((c) => !c.archived).map((c) => c.title).slice(0, 8);
  const next = (S.plan?.sessions || []).filter((s) => !s.done)[0];
  return [
    names.length ? `Existing commitments: ${names.join(', ')}.` : '',
    next ? `Next planned work: ${next.title} on ${fmtDay(next.start)} at ${fmtTime(next.start)}.` : '',
    `Homework capacity is ${S.settings.dailyCapacityMin} minutes a day.`
  ].filter(Boolean).join(' ');
}

// --------------------------------------------------------------- render

/** The panel re-renders on its own so typing isn't interrupted by app renders. */
export function render() {
  const el = $('#agent');
  if (!el) return;
  const a = ensureAgent();
  el.hidden = !a.open;
  document.body.classList.toggle('agent-open', a.open);
  if (!a.open) return;
  const input = el.querySelector('#ag-input');
  if (input) a.draft = input.value;
  el.innerHTML = agentPanel();
  const thread = el.querySelector('#ag-thread');
  if (thread) thread.scrollTop = thread.scrollHeight;
  const box = el.querySelector('#ag-input');
  if (box && !a.busy) { box.focus(); autosize(box); }
}

function autosize(box) {
  box.style.height = 'auto';
  box.style.height = `${Math.min(140, box.scrollHeight)}px`;
}

// -------------------------------------------------------------- actions

export const actions = {
  'agent-open': () => { ensureAgent().open = true; render(); },
  'agent-close': () => { ensureAgent().open = false; render(); },
  'agent-toggle': () => { const a = ensureAgent(); a.open = !a.open; render(); },
  'agent-starter': (el) => send(el.dataset.text),
  'agent-show': () => { go('calendar'); },
  'agent-undo': async (el) => {
    const a = ensureAgent();
    const msg = a.thread[Number(el.dataset.i)];
    if (!msg?.snapshot) return;
    await restore(msg.snapshot);
    a.thread.push({ role: 'agent', text: 'Undone. Your week is back the way it was.' });
    render();
    toast('Changes undone');
  }
};

export const submitActions = {
  'agent-send': (form, data) => { send(data.get('text')); }
};

/** Keeps the composer growing with the text, and Enter sends. */
export function installAgentInput() {
  document.addEventListener('input', (e) => {
    if (e.target.id === 'ag-input') { ensureAgent().draft = e.target.value; autosize(e.target); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.id !== 'ag-input' || e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    send(e.target.value);
  });
}

export { agentEvents };
