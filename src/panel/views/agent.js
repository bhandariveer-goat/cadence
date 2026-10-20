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
//
// Chats: a student can keep separate chats, start a new one, go back to an
// old one and delete one. They are kept in this browser only (lib/chats.js).
//
// "/secret" opens outline mode: pick an assignment and get an outline of how
// to do it yourself, never the work itself (lib/outline.js).

import { app, restore, go, push, DEMO, rankedTasks } from '../core.js';
import { respond } from '../../lib/agent.js';
import { converse, directTransport, proxyTransport } from '../../lib/agentllm.js';
import { diffPlans, KIND_LABEL, dayWord } from '../../lib/agentops.js';
import { aiAvailable } from '../../lib/ai.js';
import { CONFIG, cloudConfigured } from '../../config.js';
import { anonymousToken } from '../../lib/cloud.js';
import { svg, I, esc, toast, $, ago, plural } from '../ui.js';
import { loadChats, saveChats, newChatId, titleFor, MAX_CHATS } from '../../lib/chats.js';
import { offlineOutline, assignmentPayload, requestOutline } from '../../lib/outline.js';
import { composeGuide } from './guide.js';

/** The assistant's state for this page, set up the first time it is needed,
    with the chat that was open last time opened again. */
export function ensureAgent() {
  if (!app.agent) {
    // The chat that was open last time is open again; the rest are in the list.
    const saved = loadChats();
    const cur = saved.list.find((c) => c.id === saved.current);
    app.agent = {
      open: false, busy: false, draft: '', listening: false, showChats: false,
      chats: saved.list, chatId: cur?.id || null,
      thread: cur?.thread || [], messages: cur?.messages || [], via: cur?.via || undefined
    };
  }
  return app.agent;
}

/** Write the open chat down, after anything in it changes. */
function saveChat() {
  const a = ensureAgent();
  if (!a.thread.length) return;
  const now = new Date().toISOString();
  if (!a.chatId) { a.chatId = newChatId(); a.chats.unshift({ id: a.chatId, createdAt: now }); }
  const c = a.chats.find((x) => x.id === a.chatId);
  if (!c) return;
  Object.assign(c, { title: titleFor(a.thread), updatedAt: now, thread: a.thread, messages: a.messages, via: a.via || null });
  a.chats.sort((x, y) => String(y.updatedAt).localeCompare(String(x.updatedAt)));
  if (a.chats.length > MAX_CHATS) a.chats.length = MAX_CHATS;
  saveChats({ current: a.chatId, list: a.chats });
}

/** Show one chat (or a new, empty one when id is null). */
function openChat(id) {
  const a = ensureAgent();
  const c = id ? a.chats.find((x) => x.id === id) : null;
  a.chatId = c?.id || null;
  a.thread = c?.thread || [];
  a.messages = c?.messages || [];
  a.via = c?.via || undefined;
  a.showChats = false;
  a.focusNext = true;
  saveChats({ current: a.chatId, list: a.chats });
  render();
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
  const endpoint = siteEndpoint();
  if (!endpoint) return null;
  // `token` is kept too, for outline mode, which asks the same server differently.
  if (S.account?.mode === 'cloud' && app.cloud?.signedIn) {
    const token = () => app.cloud.token();
    return Object.assign(proxyTransport(endpoint, token), { kind: 'site', token });
  }
  // With only a name: a hidden anonymous account lets the server count requests.
  if (cloudConfigured()) {
    const token = anonymous();
    return Object.assign(proxyTransport(endpoint, token), { kind: 'site', token });
  }
  return null;
}

/** Cadence's own assistant endpoint, for the website and the extension alike. */
function siteEndpoint() {
  return /^https?:/.test(CONFIG.agentEndpoint) ? CONFIG.agentEndpoint
    : /^https?:$/.test(location.protocol) ? new URL(CONFIG.agentEndpoint, location.origin).href
      : CONFIG.site.domain ? `https://${CONFIG.site.domain}${CONFIG.agentEndpoint}` : null;
}

let anonymousTokens = null;
// The token for a student without an email account, made once per page and
// shared by every message.
const anonymous = () => (anonymousTokens ||= anonymousToken({ url: CONFIG.supabaseUrl, key: CONFIG.supabaseKey }));

// ------------------------------------------------------------------ view

/** The assistant panel: its header (chats, new chat, close), the
    conversation or the list of chats, and the box to type or speak in. */
export function agentPanel() {
  const a = ensureAgent();
  const mic = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  return `
    <div class="ag-head">
      <label class="ag-title" for="ag-input"><b>Ask Cadence</b><small>${a.chatId ? esc(a.chats.find((c) => c.id === a.chatId)?.title || 'This chat') : 'Say what is going on. The plan changes to match.'}</small></label>
      <button class="icon-btn" data-act="agent-chats" data-tip="${a.showChats ? 'Back to this chat' : 'Your chats'}" aria-label="${a.showChats ? 'Back to this chat' : 'Your chats'}" aria-expanded="${a.showChats}" aria-controls="ag-thread">${svg(I.chat, 18)}</button>
      <button class="icon-btn" data-act="agent-new" data-tip="New chat" aria-label="New chat">${svg(I.edit, 18)}</button>
      <button class="icon-btn" data-act="agent-close" data-tip="Close assistant" data-kbd="Esc" aria-label="Close assistant">${svg(I.x, 18)}</button>
    </div>

    ${a.showChats ? chatList(a) : `<div class="ag-thread" id="ag-thread" aria-live="polite">
      ${a.thread.length ? a.thread.map(bubble).join('') : `
        <div class="ag-intro">
          <p>Describe your day or your week in your own words. It goes on the calendar and the plan is rebuilt around it. Every change is listed and can be undone.</p>
          <p>It remembers lasting things you tell it, like how long you like to work or a class you find hard. <button class="link" data-act="agent-memory">See what it knows</button></p>
          <div class="ag-starters">
            ${starters().map((s) => `<button class="ag-starter" data-act="agent-say" data-text="${esc(s)}">${esc(s)}</button>`).join('')}
          </div>
        </div>`}
      ${a.busy ? '<div class="ag-msg from-agent"><div class="ag-bubble ag-thinking" role="status" aria-label="Working on it…"><i></i><i></i><i></i></div></div>' : ''}
    </div>`}

    ${Number.isFinite(a.remaining) && a.remaining <= 5 ? `<p class="hint ag-left" role="status">${a.remaining === 0 ? 'That was your last AI question for today. Plain sentences still work, read on your device.' : `${a.remaining} AI question${a.remaining === 1 ? '' : 's'} left today.`}${app.S.account?.mode !== 'cloud' ? ' Add an email to your account for more.' : ''}</p>` : ''}
    <form class="ag-compose" data-form="agent-send" autocomplete="off">
      <textarea name="text" id="ag-input" rows="1" placeholder="${a.listening ? 'Listening…' : 'I just got home and I am tired'}">${esc(a.draft || '')}</textarea>
      ${mic ? `<button class="ag-mic ${a.listening ? 'on' : ''}" type="button" data-act="agent-mic" data-tip="${a.listening ? 'Stop listening' : 'Speak instead of typing'}" aria-label="${a.listening ? 'Stop listening' : 'Speak instead of typing'}" aria-pressed="${a.listening}">${svg(I.mic, 18)}</button>` : ''}
      <button class="ag-send" type="submit" data-tip="Send message" data-kbd="Enter" aria-label="Send message" ${a.busy ? 'aria-busy="true"' : ''}>${svg(I.up, 18)}</button>
    </form>`;
}

/** The list of chats, in place of the conversation. */
function chatList(a) {
  return `<div class="ag-thread ag-chats" id="ag-thread">
    <div class="ag-chats-head"><b>Your chats</b><button class="btn small soft" data-act="agent-new">${svg(I.edit, 14)} New chat</button></div>
    ${a.chats.length ? `<ul class="ag-chat-list">${a.chats.map((c) => `<li class="${c.id === a.chatId ? 'on' : ''}">
      <button class="ag-chat" data-act="agent-chat" data-id="${esc(c.id)}" ${c.id === a.chatId ? 'aria-current="true"' : ''}>
        <b>${esc(c.title || 'New chat')}</b><small>${esc(ago(c.updatedAt))}, ${plural(c.thread.filter((m) => m.role === 'you').length, 'message')}</small></button>
      <button class="icon-btn" data-act="agent-chat-delete" data-id="${esc(c.id)}" data-tip="Delete chat" aria-label="Delete chat: ${esc(c.title || 'New chat')}">${svg(I.x, 16)}</button>
    </li>`).join('')}</ul>` : '<p class="ag-chats-empty">No chats yet. What you ask is kept here, one chat per conversation.</p>'}
    <p class="hint ag-chats-note">Chats stay in this browser until you delete them. They are not saved to your account.</p>
  </div>`;
}

/** An outline from "/secret": what it asks, the steps, the skeleton, what to look over, what to think about. */
function outlineCard(o) {
  const list = (items, ordered) => `<${ordered ? 'ol' : 'ul'}>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`;
  return `<div class="ag-outline">
    ${o.asks ? `<h4>What it asks</h4><p>${esc(o.asks)}</p>` : ''}
    ${o.steps?.length ? `<h4>Steps</h4>${list(o.steps, true)}` : ''}
    ${o.structure?.length ? `<h4>What you hand in</h4>${list(o.structure)}` : ''}
    ${o.review?.length ? `<h4>Look over first</h4>${list(o.review)}` : ''}
    ${o.questions?.length ? `<h4>Think about</h4>${list(o.questions)}` : ''}
    <p class="ag-outline-foot">A plan for the work, not the work.</p>
  </div>`;
}

/** One message in the conversation. The assistant's own say what it changed
    on the plan, with Undo, and the newest one shows its suggested replies;
    an outline mode message has its own frame. */
function bubble(m, i) {
  if (m.role === 'you') return `<div class="ag-msg you"><div class="ag-bubble">${esc(m.text)}</div></div>`;
  const last = i === ensureAgent().thread.length - 1;
  if (m.secret) {
    return `<div class="ag-msg from-agent">
      <div class="ag-secret"><b>You found outline mode.</b><p>${esc(m.text)}</p></div>
      ${last && m.picks?.length ? `<div class="ag-chips">${m.picks.map((p) => `<button class="ag-chip" data-act="agent-outline" data-id="${esc(p.id)}">${esc(p.label)}</button>`).join('')}</div>` : ''}
    </div>`;
  }
  return `
    <div class="ag-msg from-agent">
      <div class="ag-bubble">${esc(m.text)}</div>
      ${m.outline ? outlineCard(m.outline) : ''}
      ${m.list?.length ? `<ul class="ag-list">${m.list.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${m.ops?.length ? `<div class="ag-changes">
        ${m.ops.map((op) => `<div class="ag-change"><span class="ag-dot ${esc(op.kind)}"></span>
          <div><b>${esc(op.summary)}</b><small>${esc(KIND_LABEL[op.kind] || '')}</small></div></div>`).join('')}
        ${m.moved?.length ? `<div class="ag-moved"><small>Moved because of this</small>${m.moved.map((x) => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
        <div class="ag-actions">
          ${m.undone ? '<span class="muted small">Undone</span>' : m.snapshot ? `<button class="btn ghost small" data-act="agent-undo" data-i="${i}">Undo this</button>` : ''}
          ${m.ops.every((op) => op.kind === 'memory')
    ? '<button class="btn soft small" data-act="agent-memory">See what it knows</button>'
    : '<button class="btn soft small" data-act="agent-show">Open calendar</button>'}
        </div>
      </div>` : ''}
      ${last && m.chips?.length ? `<div class="ag-chips">${m.chips.map((c) => `<button class="ag-chip" data-act="agent-say" data-text="${esc(c.text)}">${esc(c.label)}</button>`).join('')}</div>` : ''}
    </div>`;
}

// --------------------------------------------------------------- sending

/** Sends what the student wrote. "/secret" opens outline mode. Otherwise the
    model answers when one can be reached; if it cannot (a spent limit, a slow
    answer, no network), the sentence is read on the device instead and the
    reply says why. Any change to the plan is applied and kept for Undo, and
    the chat is saved. */
async function send(text) {
  const a = ensureAgent();
  const clean = String(text || '').trim();
  if (!clean || a.busy) return;

  a.thread.push({ role: 'you', text: clean });
  a.draft = '';
  a.showChats = false;
  // Clear the box itself: render() reads it back before redrawing.
  const box = $('#ag-input');
  if (box) box.value = '';
  if (/^\/secret\b/i.test(clean)) return secret(clean.replace(/^\/secret\b/i, '').trim());
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
  saveChat();
  render();
}

// ------------------------------------------------------------ outline mode

/** Open assignments, the ones due soonest first: what an outline can be for. */
const openWork = () => rankedTasks()
  .filter((t) => t.status !== 'done' && !app.S.dismissed?.[t.id])
  .sort((x, y) => (+new Date(x.due || 8.64e15)) - (+new Date(y.due || 8.64e15)));

/** "/secret", with or without words after it. */
function secret(words) {
  const a = ensureAgent();
  const work = openWork();
  const wanted = words.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const scored = wanted.length ? work.map((t) => ({ t, n: wanted.filter((w) => t.title.toLowerCase().includes(w)).length })).filter((x) => x.n).sort((x, y) => y.n - x.n) : [];
  // One clear match goes straight to its outline.
  if (scored.length && (scored.length === 1 || scored[0].n > scored[1].n)) return outline(scored[0].t.id, { said: false });
  a.thread.push({
    role: 'agent', secret: true,
    text: work.length
      ? `Pick an assignment and Cadence lays out how to do it yourself: what it asks, the steps, the parts to hand in, and what to look over first. A plan for the work, not the work.${wanted.length ? ' Nothing matched those words, so here are the ones due soonest.' : ''}`
      : 'It outlines an assignment so you can do it yourself. There are no open assignments yet: add one, then type /secret again.',
    picks: work.slice(0, 6).map((t) => ({ id: t.id, label: t.title }))
  });
  saveChat();
  a.focusNext = true;
  render();
}

/** The outline for one assignment: from the model when there is one, from Cadence's guide when not. */
async function outline(id, { said = true } = {}) {
  const a = ensureAgent();
  const t = app.S.tasks?.[id];
  if (!t || a.busy) return;
  if (said) a.thread.push({ role: 'you', text: `Outline: ${t.title}` });
  a.busy = true;
  render();
  let guide = {};
  try { guide = composeGuide(t); } catch { /* no guide yet: the outline says to open it in Canvas */ }
  const via = transport();
  let result = null, why = '';
  if (via?.kind === 'site') {
    try {
      const r = await requestOutline(siteEndpoint(), via.token, assignmentPayload(t, guide));
      if (Number.isFinite(r.remaining)) a.remaining = r.remaining;
      result = { text: `An outline for ${t.title}.`, outline: r.outline };
    } catch (e) {
      const m = String(e?.message || '');
      why = /limit for today/i.test(m) ? m : /busy|limit/i.test(m) ? 'The AI is busy right now.' : /too long/i.test(m) ? 'The AI took too long to answer.' : 'The AI could not be reached.';
    }
  }
  if (!result) {
    const o = offlineOutline(t, guide);
    const ownKey = via?.kind === 'own key' ? ' Outlines use Cadence\'s own assistant, not your key.' : '';
    result = { text: `An outline for ${t.title}, from what Cadence already knows about it.${why ? ` ${why}` : ''}${ownKey}`, outline: o };
  }
  a.busy = false;
  a.thread.push({ role: 'agent', text: result.text, outline: result.outline });
  saveChat();
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
    if (!a.busy && (hadFocus || a.focusNext)) { box.focus({ preventScroll: true }); box.setSelectionRange(box.value.length, box.value.length); }
  }
  a.focusNext = false;
}

/** Grows the message box with what is typed, up to 140 pixels tall. */
function autosize(box) {
  box.style.height = 'auto';
  box.style.height = `${Math.min(140, box.scrollHeight)}px`;
}

// ----------------------------------------------------------------- voice

let recog = null;
/** Starts dictation into the message box, or stops it. What was said is
    added after anything already typed. */
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
  'agent-close': () => { ensureAgent().open = false; render(); $('#btn-agent')?.focus({ preventScroll: true }); },
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
    saveChat();
    // Claude is told the plan afresh on every message, so nothing else to rewind.
    render();
    toast('Undone. Your plan is back the way it was.');
  },
  'agent-chats': () => { const a = ensureAgent(); if (a.busy) return; a.showChats = !a.showChats; render(); },
  'agent-new': () => {
    const a = ensureAgent();
    if (a.busy) return;
    if (!a.thread.length) { a.showChats = false; a.focusNext = true; return render(); }
    openChat(null);
  },
  'agent-chat': (el) => { if (!ensureAgent().busy) openChat(el.dataset.id); },
  'agent-chat-delete': (el) => {
    const a = ensureAgent();
    if (a.busy) return;
    const at = a.chats.findIndex((c) => c.id === el.dataset.id);
    if (at < 0) return;
    const [gone] = a.chats.splice(at, 1);
    const wasOpen = a.chatId === gone.id;
    if (wasOpen) { a.chatId = null; a.thread = []; a.messages = []; a.via = undefined; }
    saveChats({ current: a.chatId, list: a.chats });
    render();
    $('#agent [data-act="agent-new"]')?.focus();
    toast(`Deleted "${gone.title || 'New chat'}"`, {
      label: 'Undo',
      run: () => {
        if (a.busy || app.agent !== a) return toast('Finish this question first, then undo from Your chats.');
        a.chats.splice(Math.min(at, a.chats.length), 0, gone);
        if (wasOpen) { a.chatId = gone.id; a.thread = gone.thread; a.messages = gone.messages || []; a.via = gone.via || undefined; }
        saveChats({ current: a.chatId, list: a.chats });
        render();
      }
    });
  },
  'agent-outline': (el) => outline(el.dataset.id)
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
