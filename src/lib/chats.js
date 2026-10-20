// Separate chats with the assistant, kept in this browser only.
//
// Each chat keeps what was said, so it is still there after a reload. They are
// never saved to the account or synced: a chat can hold a copy of the week
// (every message to the model starts with one), and the account copy of the
// plan is the only thing that leaves the device. The demo keeps its own chats.
//
// What the model needs to carry on a chat (its messages, each with the week)
// is large, so it is kept for the chat that is open only. Going back to an
// older chat after a reload starts the model's side of it afresh; what was
// said is still shown. Undo snapshots (a copy of the plan) are never stored,
// so older replies have no Undo after a reload.

import { currentBucket } from './store.js';

export const MAX_CHATS = 30;
// Kept small: on the website the plan shares this browser's storage.
const MAX_BYTES = 300000;
const TITLE_CHARS = 60;

// The browser storage key for a bucket of chats: the real app's and the demo's are kept apart.
const keyFor = (bucket) => `cadence.chats.${bucket}.v1`;
export const CHAT_KEYS = [keyFor('real'), keyFor('demo')];

// A new chat's id, unique enough for one browser.
export const newChatId = () => `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

/** A chat's name: the first thing the student said in it. */
export function titleFor(thread = []) {
  const first = thread.find((m) => m.role === 'you');
  let text = String(first?.text || 'New chat').replace(/\s+/g, ' ').trim();
  if (/^\/secret\b/i.test(text)) text = 'Outline mode';
  return text.length > TITLE_CHARS ? `${text.slice(0, TITLE_CHARS).replace(/\s+\S*$/, '')}…` : text;
}

/** { current, list } from this browser, or an empty set. Never throws. */
export function loadChats() {
  try {
    const raw = JSON.parse(localStorage.getItem(keyFor(currentBucket())) || 'null');
    if (!raw || !Array.isArray(raw.list)) return { current: null, list: [] };
    const list = raw.list.filter((c) => c && typeof c.id === 'string' && Array.isArray(c.thread)).slice(0, MAX_CHATS);
    return { current: list.some((c) => c.id === raw.current) ? raw.current : null, list };
  } catch {
    return { current: null, list: [] };
  }
}

/** What is written down: no undo snapshots, and model messages for the open chat only. */
function storable(list, current, withMessages = true) {
  return list.slice(0, MAX_CHATS).map((c) => ({
    id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, via: c.via || null,
    thread: c.thread.map(({ snapshot, ...m }) => (snapshot ? { ...m, undoable: false } : m)),
    messages: withMessages && c.id === current ? (c.messages || []) : []
  }));
}

/** Save the chats. Too big, or storage full: the open chat's model messages go first, then the oldest chats. */
export function saveChats({ current, list }) {
  const sorted = [...list].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const attempts = [
    () => storable(sorted, current, true),
    () => storable(sorted, current, false),
    () => storable(sorted.slice(0, 10), current, false)
  ];
  for (const make of attempts) {
    const text = JSON.stringify({ current, list: make() });
    if (text.length > MAX_BYTES) continue;
    try {
      localStorage.setItem(keyFor(currentBucket()), text);
      return true;
    } catch { /* full, or storage is off (a private window): try smaller */ }
  }
  return false;
}

/** For "Download my data": the chats as they are stored. */
export function exportChats() {
  return loadChats().list.map(({ messages, ...c }) => c);
}

/** On sign-out and account deletion: this person's chats leave the browser too. */
export function clearChats() {
  for (const key of CHAT_KEYS) {
    try { localStorage.removeItem(key); } catch { /* nothing stored */ }
  }
}
