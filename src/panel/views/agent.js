// The assistant panel.
//
// A student says what is going on ("I just got home, I'm tired, I want to eat
// and do an hour and a half and go to sleep") and the week is rebuilt around
// it. Every reply shows exactly what changed and what moved because of it, and
// one tap puts everything back. An assistant that edits a calendar without
// showing its work is not one to trust with a week.
//
// It always works: sentences are read offline (lib/agent.js). On a site that
// runs the server function, a model does the reading instead (Gemini or
// Claude, whichever the site is set up with), for a student with an email
// account or with only a name (through a hidden anonymous account), or
// Claude does when the student has added their own Anthropic key
// (lib/agentllm.js). The offline reader is the fallback if that call fails.

import { app, restore, go, push, DEMO } from '../core.js';
import { respond } from '../../lib/agent.js';
import { converse, directTransport, proxyTransport } from '../../lib/agentllm.js';
import { diffPlans, KIND_LABEL, dayWord } from '../../lib/agentops.js';
import { aiAvailable } from '../../lib/ai.js';
import { CONFIG, cloudConfigured } from '../../config.js';
import { anonymousToken } from '../../lib/cloud.js';
import { svg, I, esc, toast, $ } from '../ui.js';

export function ensureAgent() {
  app.agent ||= { open: false, thread: [], busy: false, draft: '', messages: [], listening: false };
  return app.agent;
}

/** Suggestions that fit the moment: evenings are about tonight, mornings about the week. */
function starters() {
  const h = new Date().getHours();
  if (h >= 15 || h < 4) return ['I am tired tonight', 'What should I do now?', 'I have dinner at 6', 'No school Friday'];
  return ['How is my week?', 'Robotics Monday and Wednesday 3:45 to 5:30', 'Bio test Friday, takes 2 hours', 'Am I free Thursday evening?'];
}

/** Which way to reach a model, if any. `kind` says which, so a conversation never mixes the two. */
function transport() {
  const S = app.S;
  if (DEMO) return null;
  if (aiAvailable(S.settings)) return Object.assign(directTransport(S.settings.apiKey), { kind: 'own key' });
  const endpoint = /^https?:/.test(CONFIG.agentEndpoint) ? CONFIG.agentEndpoint
    : /^https?:$/.test(location.protocol) ? new URL(CONFIG.agentEndpoint, location.origin).href
      : CONFIG.site.domain ? `https://${CONFIG.site.domain}${CONFIG.agentEndpoint}` : null;
  if (!endpoint) return null;
  if (S.account?.mode === 'cloud' && app.cloud?.signedIn) return Object.assign(proxyTransport(endpoint, () => app.cloud.token()), { kind: 'site' });
  // With only a name: a hidden anonymous account lets the server count requests.
  if (cloudConfigured()) return Object.assign(proxyTransport(endpoint, anonymous()), { kind: 'site' });
  return null;
}

let anonymousTokens = null;
const anonymous = () => (anonymousTokens ||= anonymousToken({ url: CONFIG.supabaseUrl, key: CONFIG.supabaseKey }));

// ------------------------------------------------------------------ view

export function agentPanel() {
  const a = ensureAgent();
  const mic = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  return `
    <div class="ag-head">
      <label class="ag-title" for="ag-input"><b>Ask Cadence</b><small>Say what is going on. The plan changes to match.</small></label>
      <button class="icon-btn" data-act="agent-close" data-tip="Close assistant" data-kbd="Esc" aria-label="Close assistant">${svg(I.x, 18)}</button>
    </div>

    <div class="ag-thread" id="ag-thread" aria-live="polite">
      ${a.thread.length ? a.thread.map(bubble).join('') : `
        <div class="ag-intro">
          <p>Describe your day or your week in your own words. It goes on the calendar and the plan is rebuilt around it. Every change is listed and can be undone.</p>
          <p>It remembers lasting things you tell it, like how long you like to work or a class you find hard. <button class="link" data-act="agent-memory">See what it knows</button></p>
          <div class="ag-starters">
            ${starters().map((s) => `<button class="ag-starter" data-act="agent-say" data-text="${esc(s)}">${esc(s)}</button>`).join('')}
          </div>
        </div>`}
      ${a.busy ? '<div class="ag-msg from-agent"><div class="ag-bubble ag-thinking" role="status" aria-label="Working on it…"><i></i><i></i><i></i></div></div>' : ''}
    </div>

    ${Number.isFinite(a.remaining) && a.remaining <= 5 ? `<p class="hint ag-left" role="status">${a.remaining === 0 ? 'That was your last AI question for today. Plain sentences still work, read on your device.' : `${a.remaining} AI question${a.remaining === 1 ? '' : 's'} left today.`}${app.S.account?.mode !== 'cloud' ? ' Add an email to your account for more.' : ''}</p>` : ''}
    <form class="ag-compose" data-form="agent-send" autocomplete="off">
      <textarea name="text" id="ag-input" rows="1" placeholder="${a.listening ? 'Listening…' : 'I just got home and I am tired'}">${esc(a.draft || '')}</textarea>
      ${mic ? `<button class="ag-mic ${a.listening ? 'on' : ''}" type="button" data-act="agent-mic" data-tip="${a.listening ? 'Stop listening' : 'Speak instead of typing'}" aria-label="${a.listening ? 'Stop listening' : 'Speak instead of typing'}" aria-pressed="${a.listening}">${svg(I.mic, 18)}</button>` : ''}
      <button class="ag-send" type="submit" data-tip="Send message" data-kbd="Enter" aria-label="Send message" ${a.busy ? 'aria-busy="true"' : ''}>${svg(I.up, 18)}</button>
    </form>`;
}

function bubble(m, i) {
  if (m.role === 'you') return `<div class="ag-msg you"><div class="ag-bubble">${esc(m.text)}</div></div>`;
  const last = i === ensureAgent().thread.length - 1;
  return `
    <div class="ag-msg from-agent">
      <div class="ag-bubble">${esc(m.text)}</div>
      ${m.list?.length ? `<ul class="ag-list">${m.list.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${m.ops?.length ? `<div class="ag-changes">
        ${m.ops.map((op) => `<div class="ag-change"><span class="ag-dot ${esc(op.kind)}"></span>
          <div><b>${esc(op.summary)}</b><small>${esc(KIND_LABEL[op.kind] || '')}</small></div></div>`).join('')}
        ${m.moved?.length ? `<div class="ag-moved"><small>Moved because of this</small>${m.moved.map((x) => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
        <div class="ag-actions">
          ${m.undone ? '<span class="muted small">Undone</span>' : `<button class="btn ghost small" data-act="agent-undo" data-i="${i}">Undo this</button>`}
          ${m.ops.every((op) => op.kind === 'memory')
    ? '<button class="btn soft small" data-act="agent-memory">See what it knows</button>'
    : '<button class="btn soft small" data-act="agent-show">Open calendar</button>'}
        </div>
      </div>` : ''}
      ${last && m.chips?.length ? `<div class="ag-chips">${m.chips.map((c) => `<button class="ag-chip" data-act="agent-say" data-text="${esc(c.text)}">${esc(c.label)}</button>`).join('')}</div>` : ''}
    </div>`;
}

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
  const before = app.S;
  let result = null;

  const via = transport();
  let fellBack = '';
  if (via) {
    try {
      // A long conversation is restarted rather than trimmed, and so is one
      // that was with the other model: each keeps parts the other cannot read.
      if (a.messages.length > 30 || a.via !== via.kind) a.messages = [];
      a.via = via.kind;
      const r = await converse({ text: clean, state: before, messages: a.messages, send: via, now });
      const diff = r.next ? diffPlans(before, r.next, now) : null;
      if (Number.isFinite(r.remaining)) a.remaining = r.remaining;
      result = {
        text: r.text, ops: r.ops, next: r.next, chips: r.chips, list: [],
        moved: diff ? diff.moved.filter((m) => m.to.length).map((m) => `${m.title}: ${m.to.map((k) => dayWord(k, now)).join(', ')}`) : []
      };
    } catch (e) {
      // A spent limit, a slow answer, a network drop: the sentence still gets
      // read on the device, and the reply says so.
      result = null;
      const why = String(e?.message || '');
      // The day's limit is said as it is, not as "busy".
      fellBack = /limit for today/i.test(why) ? why
        : /busy|limit/i.test(why) ? 'The AI is busy right now.'
          : /too long/i.test(why) ? 'The AI took too long to answer.'
            : 'The AI could not be reached.';
    }
  }
  if (!result) {
    result = respond(clean, before, now);
    if (fellBack) result = { ...result, text: `${result.text}\n\n${fellBack}${/limit for today/i.test(fellBack) ? '' : ' This was read on your device instead, so try again in a minute for a fuller answer.'}` };
  }

  const snapshot = result.next ? structuredClone(before) : null;
  if (result.next) await restore(result.next);
  a.busy = false;
  a.thread.push({ role: 'agent', text: result.text, ops: result.ops || [], moved: result.moved || [], list: result.list || [], chips: result.chips || [], snapshot });
  render();
}

// --------------------------------------------------------------- render

/** The panel re-renders on its own so typing isn't interrupted by app renders. */
export function render() {
  const el = $('#agent');
  if (!el) return;
  const a = ensureAgent();
  el.hidden = !a.open;
  document.body.classList.toggle('agent-open', a.open);
  // On a narrow screen the assistant covers the page, so the page behind it
  // is taken out of the tab order and away from screen readers while it is up.
  const covers = a.open && matchMedia('(max-width: 767.98px)').matches;
  for (const id of ['top', 'view', 'tabs']) { const node = $(`#${id}`); if (node) node.inert = covers; }
  const btn = $('#btn-agent');
  if (btn) btn.setAttribute('aria-pressed', String(a.open));
  if (!a.open) return;
  const input = el.querySelector('#ag-input');
  const hadFocus = document.activeElement === input;
  if (input) a.draft = input.value;
  el.innerHTML = agentPanel();
  const thread = el.querySelector('#ag-thread');
  if (thread) thread.scrollTop = thread.scrollHeight;
  const box = el.querySelector('#ag-input');
  if (box) {
    autosize(box);
    if (!a.busy && (hadFocus || a.focusNext)) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
  }
  a.focusNext = false;
}

function autosize(box) {
  box.style.height = 'auto';
  box.style.height = `${Math.min(140, box.scrollHeight)}px`;
}

// ----------------------------------------------------------------- voice

let recog = null;
function toggleMic() {
  const a = ensureAgent();
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Rec) return;
  if (recog) { recog.stop(); return; }
  recog = new Rec();
  recog.continuous = false;
  recog.interimResults = true;
  recog.lang = navigator.language || 'en-US';
  const base = a.draft ? `${a.draft.trim()} ` : '';
  recog.onresult = (e) => {
    let said = '';
    for (const r of e.results) said += r[0].transcript;
    const box = $('#ag-input');
    a.draft = (base + said).trim();
    if (box) { box.value = a.draft; autosize(box); }
  };
  recog.onerror = (e) => { if (e.error === 'not-allowed') toast('Allow the microphone for this site in your browser, then try again.'); };
  recog.onend = () => { recog = null; a.listening = false; a.focusNext = true; render(); };
  a.listening = true;
  render();
  try { recog.start(); } catch { recog = null; a.listening = false; render(); }
}

// -------------------------------------------------------------- actions

export const actions = {
  'agent-open': (el) => { const a = ensureAgent(); a.open = true; a.focusNext = true; if (el?.dataset?.seed && !a.draft) a.draft = el.dataset.seed; render(); },
  'agent-close': () => { ensureAgent().open = false; render(); $('#btn-agent')?.focus(); },
  'agent-toggle': () => { const a = ensureAgent(); a.open = !a.open; a.focusNext = a.open; render(); },
  'agent-say': (el) => { const a = ensureAgent(); if (!a.open) { a.open = true; } send(el.dataset.text); },
  'agent-mic': () => toggleMic(),
  'agent-memory': () => { if (matchMedia('(max-width: 767px)').matches) { ensureAgent().open = false; render(); } if (app.view !== 'memory') push('memory'); },
  'agent-show': () => { if (matchMedia('(max-width: 767px)').matches) ensureAgent().open = false; go('calendar'); },
  'agent-undo': async (el) => {
    const a = ensureAgent();
    const msg = a.thread[Number(el.dataset.i)];
    if (!msg?.snapshot || msg.undone) return;
    await restore(msg.snapshot);
    msg.undone = true;
    // Claude is told the plan afresh on every message, so nothing else to rewind.
    render();
    toast('Undone. Your plan is back the way it was.');
  }
};

export const submitActions = {
  'agent-send': (form, data) => { ensureAgent().focusNext = true; send(data.get('text')); }
};

/** Keeps the composer growing with the text, and Enter sends. */
export function installAgentInput() {
  document.addEventListener('input', (e) => {
    if (e.target.id === 'ag-input') { ensureAgent().draft = e.target.value; autosize(e.target); }
  });
  // Escape closes the assistant from anywhere inside it, and focus goes back
  // to the button that opened it.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !ensureAgent().open || !e.target.closest?.('#agent')) return;
    e.preventDefault();
    actions['agent-close']();
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.id !== 'ag-input' || e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    ensureAgent().focusNext = true;
    send(e.target.value);
  });
}
