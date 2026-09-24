// Background worker: reminders and the toolbar button.
//
// The panel owns all the planning logic; this file only makes sure a plan that
// was made yesterday still pokes her at 4:15pm today, even with Canvas closed.

import { loadState, saveState, update } from '../lib/store.js';
import { MIN } from '../lib/util.js';
import { runAll, applyResults, pushGoogle } from '../lib/sources/sources.js';
import { recomputeState } from '../lib/replanner.js';

const PREFIX = 'cadence:session:';
const DAILY = 'cadence:daily';
const SYNC = 'cadence:autosync';

chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create(DAILY, { periodInMinutes: 60 * 24, when: nextAt(7, 30) });
  await armAutoSync();
  await syncReminders();
});
chrome.runtime.onStartup.addListener(async () => { await armAutoSync(); await syncReminders(); });

/** Polling, not webhooks: there's no server to receive a push. */
async function armAutoSync() {
  const state = await loadState();
  const every = Math.max(15, state.autoSync?.everyMinutes ?? 20);
  if (state.autoSync?.enabled === false) return chrome.alarms.clear(SYNC);
  chrome.alarms.create(SYNC, { periodInMinutes: every, delayInMinutes: 1 });
}

/**
 * Fetch every connected calendar and re-plan around whatever came back.
 * Runs headless, so it uses the shared replanner rather than the panel.
 */
async function autoSync() {
  const state = await loadState();
  if (!state.profile?.onboarded) return;
  const enabled = Object.values(state.sources || {}).some((s) => s?.enabled);
  if (!enabled) return;
  try {
    const results = await runAll(state, {
      saveGoogle: (t) => update((st) => { Object.assign(st.sources.google, t); return st; })
    });
    const fresh = await loadState();
    applyResults(fresh, results);
    fresh.autoSync.lastRun = new Date().toISOString();
    recomputeState(fresh);
    await saveState(fresh);

    // Mirror opted-in blocks, if the student turned that on.
    if (fresh.sources?.google?.push) {
      try {
        const push = await pushGoogle(fresh, { saveGoogle: (t) => update((st) => { Object.assign(st.sources.google, t); return st; }) });
        if (push) await update((st) => {
          st.sources.google.pushed = push.map;
          st.sources.google.lastPush = new Date().toISOString();
          st.sources.google.pushError = push.errors[0] || null;
          return st;
        });
      } catch (e) {
        await update((st) => { st.sources.google.pushError = String(e.message || e); return st; });
      }
    }
  } catch (e) {
    // Never let a sync failure take down the worker; the panel shows the error.
    await update((st) => { st.autoSync.lastError = String(e.message || e); return st; });
  }
}

function nextAt(hour, minute) {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  if (d < new Date()) d.setDate(d.getDate() + 1);
  return +d;
}

// Toolbar click: open Cadence on the active Canvas tab, or in its own tab.
chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.id && /instructure\.com|canvaslms\.com/.test(tab.url || '')) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'cadence:open' });
      return;
    } catch { /* content script not present — fall through */ }
  }
  chrome.tabs.create({ url: chrome.runtime.getURL('src/panel/panel.html?standalone=1') });
});

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type === 'cadence:sync-reminders') {
    syncReminders().then(() => respond({ ok: true }));
    return true;                                  // async response
  }
  if (msg?.type === 'cadence:autosync') {
    autoSync().then(() => respond({ ok: true }));
    return true;
  }
  if (msg?.type === 'cadence:arm-autosync') {
    armAutoSync().then(() => respond({ ok: true }));
    return true;
  }
  return false;
});

/** Rebuild the alarm set from whatever the current plan says. */
export async function syncReminders() {
  const state = await loadState();
  const existing = await chrome.alarms.getAll();
  await Promise.all(existing.filter((a) => a.name.startsWith(PREFIX)).map((a) => chrome.alarms.clear(a.name)));
  if (!state.settings.remindersEnabled) return;

  const lead = (state.settings.remindLeadMin ?? 5) * MIN;
  const upcoming = (state.plan?.sessions || [])
    .filter((s) => !s.done && +new Date(s.start) - lead > Date.now())
    .sort((a, b) => new Date(a.start) - new Date(b.start))
    .slice(0, 20);                                // Chrome caps active alarms

  for (const s of upcoming) {
    chrome.alarms.create(PREFIX + s.id, { when: +new Date(s.start) - lead });
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === SYNC) return autoSync();
  if (alarm.name === DAILY) return dailyNudge();
  if (!alarm.name.startsWith(PREFIX)) return;

  const state = await loadState();
  const session = (state.plan?.sessions || []).find((s) => PREFIX + s.id === alarm.name);
  if (!session || session.done) return;

  notify(alarm.name, {
    title: `Time to start: ${session.title}`,
    message: `${session.courseName || 'Work block'} · ${session.minutes} min`
      + (session.parts > 1 ? ` · part ${session.part} of ${session.parts}` : ''),
    buttons: [{ title: 'Started' }, { title: 'Snooze 15m' }]
  });
});

function dailyNudge() {
  loadState().then((state) => {
    const today = new Date().toDateString();
    const mins = (state.plan?.sessions || [])
      .filter((s) => !s.done && new Date(s.start).toDateString() === today)
      .reduce((a, s) => a + s.minutes, 0);
    if (!mins) return;
    const h = Math.floor(mins / 60), m = mins % 60;
    notify('cadence:today', {
      title: "Today's plan is ready",
      message: `${h ? `${h}h ` : ''}${m ? `${m}m` : ''} of work, broken into blocks. Open Cadence to see the order.`
    });
  });
}

function notify(id, opts) {
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    priority: 1,
    ...opts
  });
}

chrome.notifications.onButtonClicked.addListener(async (id, idx) => {
  chrome.notifications.clear(id);
  if (!id.startsWith(PREFIX)) return;
  const sessionId = id.slice(PREFIX.length);

  if (idx === 1) {                                 // Snooze
    chrome.alarms.create(id, { when: Date.now() + 15 * MIN });
    return;
  }
  await update((state) => {                        // Started -> mark in progress
    const s = (state.plan?.sessions || []).find((x) => x.id === sessionId);
    if (s) {
      s.startedAt = new Date().toISOString();
      const t = state.tasks[s.taskId];
      if (t && t.status === 'todo') t.status = 'in_progress';
    }
    return state;
  });
});

chrome.notifications.onClicked.addListener((id) => {
  chrome.notifications.clear(id);
  chrome.tabs.create({ url: chrome.runtime.getURL('src/panel/panel.html?standalone=1') });
});

// Any change to the stored plan re-arms the alarms.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['cadence.state.v1']) syncReminders();
});
