// Persistence layer. Uses chrome.storage.local inside the extension and falls
// back to localStorage so demo/index.html runs as a plain web page.

const HAS_CHROME = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

// Two buckets, never mixed. The demo used to be seeded into the same record as
// a person's real plan, which is how sample assignments ended up in real
// accounts. Now the demo has its own record and the real one is never touched
// while it is open.
const KEYS = { real: 'cadence.state.v1', demo: 'cadence.demo.v1' };
let KEY = KEYS.real;

export function useBucket(name) {
  KEY = KEYS[name] || KEYS.real;
}
export const currentBucket = () => (KEY === KEYS.demo ? 'demo' : 'real');

export const DEFAULT_STATE = {
  profile: {
    name: '',
    onboarded: false
  },

  // Who this plan belongs to. 'none' until someone signs in; 'local' is an
  // account that lives in this browser; 'cloud' is an email sign-in that
  // syncs between the extension and the website.
  account: { mode: 'none', id: null, email: '', name: '', createdAt: null },
  // seenAt is the version of the account's copy this device last matched;
  // conflict is false, or why the person is being asked which plan to keep.
  cloud: { session: null, pulledAt: null, pushedAt: null, seenAt: null, error: null, conflict: false },
  updatedAt: null,              // any save
  editedAt: null,               // the last change a person made; what sync compares

  // The shape of a day. Nobody is asked when or how much they want to work:
  // free time is whatever school, sleep and the calendar leave, worked out
  // separately for every date.
  school: {
    days: [1, 2, 3, 4, 5],
    start: '08:30',
    end: '15:30',
    off: {},                      // 'YYYY-MM-DD' -> true: no school that day
    early: {}                     // 'YYYY-MM-DD' -> 'HH:MM': out early that day
  },
  sleep: { bed: '22:30', wake: '07:00' },
  // One-off changes to a single date, almost always written by the assistant:
  // { budgetMin, startAt, until, off, note }
  dayOverrides: {},

  // Legacy recurring activities — migrated into fixed-schedule commitments on load.
  activities: [],

  // The things nobody assigns: see lib/habits.js for the shape.
  commitments: [],
  checkins: [],                   // {id, commitmentId, date, at, minutes, feel, note}
  activeDays: [],                 // 'YYYY-MM-DD' days that count toward the streak (lib/habits.js)
  streak: { freezes: 1, frozenDays: [], best: 0, lastAward: null },
  lastReviewWeek: null,

  // Connected calendars. Each keeps its own cache so one failing source never
  // blanks the others; see lib/sources/sources.js.
  sources: {
    canvasFeed: { enabled: false, url: '', events: [], assignments: [], lastSync: null, lastTry: null, error: null },
    // Google Calendar's "secret address in iCal format": read-only busy time,
    // fetched through Cadence's server (netlify/functions/canvas-feed.mjs).
    googleFeed: { enabled: false, url: '', events: [], assignments: [], lastSync: null, lastTry: null, error: null },
    // The same, for an Outlook published calendar and an iCloud public calendar.
    outlookFeed: { enabled: false, url: '', events: [], assignments: [], lastSync: null, lastTry: null, error: null },
    icloudFeed: { enabled: false, url: '', events: [], assignments: [], lastSync: null, lastTry: null, error: null },
    google: {
      enabled: false, clientId: '', email: '', accessToken: null, expiresAt: 0, scopes: [],
      calendars: [], selected: [], push: false, pushCalendarId: 'primary', pushed: {},
      events: [], assignments: [], lastSync: null, lastTry: null, error: null
    }
  },
  autoSync: { enabled: true, everyMinutes: 20, lastRun: null },
  dismissed: {},                  // taskId -> true when she says "not doing this"
  prompts: {},                    // suggestion cards put away: key -> when (ms)

  settings: {
    role: 'student',            // 'student' | 'teacher'
    maxDailyMin: null,          // a ceiling the student stated; null = none
    sessionMaxMin: 45,          // longest single work block before a break
    sessionMinMin: 20,          // don't bother scheduling slivers shorter than this
    bufferHours: 12,            // finish this far before the deadline
    breakMin: 10,
    lookaheadDays: 14,
    remindersEnabled: true,
    remindLeadMin: 5,
    useAI: false,
    apiKey: '',
    model: 'claude-opus-5-5',
    canvasHost: ''              // auto-filled from the tab Cadence is opened on
  },

  // Retired: weekly "when I'm free" windows the student used to fill in. Kept
  // only so an older saved plan still loads; lib/daymodel.js replaces it.
  availability: {},

  // Calendar events that block time: imported .ics, or added by hand.
  busy: [],                     // {id, title, start ISO, end ISO, source}

  tasks: {},                    // id -> task
  plan: null,                   // {generatedAt, sessions:[], unplaced:[]}
  logs: [],                     // {taskId, category, courseId, estimateMin, actualMin, at}
  model: { biases: {}, globalFactor: 1 },  // learned per-course/category speed
  // What Cadence remembers about this student and has noticed about how they
  // work: see lib/memory.js. Part of the plan, so it syncs with it.
  memory: { learn: true, notes: [], prefs: {}, seen: { starts: [], focus: [], pushes: [] }, ignore: {} },
  lastSync: null
};

function deepMerge(base, patch) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return patch ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? deepMerge(base[k] ?? {}, v) : v;
  }
  return out;
}

export async function loadState() {
  let raw = null;
  if (HAS_CHROME) {
    raw = (await chrome.storage.local.get(KEY))[KEY] ?? null;
  } else {
    try { raw = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { raw = null; }
  }
  return migrate(raw ? deepMerge(DEFAULT_STATE, raw) : structuredClone(DEFAULT_STATE));
}

const DEMO_COMMITMENTS = new Set(['piano', 'robotics', 'xc', 'essays', 'foodbank']);
const DEMO_COURSES = new Set(['101', '102', '103', '104', '105', '106']);

/**
 * Take sample data back out of a real plan.
 *
 * Earlier versions seeded the demo into the same record as the person's own
 * plan, so anyone who opened the demo kept Fiona's assignments and activities
 * afterwards. Everything the seed wrote has an id only the seed uses, so it can
 * be removed without touching anything the person added themselves.
 */
export function scrubDemo(state) {
  const seeded = state.demo || state.demoSeed || Object.keys(state.tasks || {}).some((id) => /^demo_\d+$/.test(id));
  if (!seeded) return false;

  for (const id of Object.keys(state.tasks || {})) if (/^demo_\d+$/.test(id)) delete state.tasks[id];
  state.commitments = (state.commitments || []).filter((c) => !DEMO_COMMITMENTS.has(c.id));
  const kept = new Set(state.commitments.map((c) => c.id));
  state.checkins = (state.checkins || []).filter((k) => kept.has(k.commitmentId));
  state.logs = (state.logs || []).filter((l) => l.taskId && state.tasks[l.taskId]);
  if (!state.logs.length) state.model = { biases: {}, globalFactor: 1 };
  state.memory = { learn: true, notes: [], prefs: {}, seen: { starts: [], focus: [], pushes: [] }, ignore: {} };
  if ((state.courses || []).every((c) => DEMO_COURSES.has(String(c.id)))) state.courses = [];
  if (state.profile?.name === 'Fiona') state.profile.name = '';
  state.streak = { freezes: 1, frozenDays: [], best: 0, lastAward: null };
  state.activeDays = [];
  state.plan = null;
  state.ranked = [];
  delete state.demo;
  delete state.demoSeed;
  return true;
}

/** Bring an older saved plan up to the current shape. */
function migrate(state) {
  // Practices used to be "activities"; they are commitments now.
  if (state.activities?.length && !state.commitments?.length) {
    state.commitments = state.activities.map((a) => ({
      id: a.id, title: a.title, kind: /practice|lesson|music|piano|violin/i.test(a.title) ? 'practice' : /job|work/i.test(a.title) ? 'work' : 'sport',
      color: '#10b981', why: '', schedule: { mode: 'fixed', days: a.days, start: a.start, end: a.end },
      target: { sessions: a.days.length, minutes: 60 }, days: [], time: 'any', event: null,
      org: '', role: '', grades: [], timing: 'school', clubId: null, share: true,
      createdAt: new Date().toISOString(), archived: false
    }));
    state.activities = [];
  }

  if (currentBucket() === 'real') scrubDemo(state);

  // "School gets out at" was the one useful answer in the old setup questions.
  if (state.profile?.schoolEnd && /^\d\d:\d\d$/.test(state.profile.schoolEnd) && !state.school.migrated) {
    state.school.end = state.profile.schoolEnd;
  }
  state.school.migrated = true;
  delete state.profile.schoolEnd;
  delete state.profile.routine;
  delete state.profile.weekend;

  // Someone who set Cadence up before accounts existed keeps their plan and
  // gets an account on this device, named the way they named themselves.
  if (state.account.mode === 'none' && state.profile.onboarded && state.profile.name) {
    state.account = { mode: 'local', id: null, email: '', name: state.profile.name, createdAt: new Date().toISOString() };
  }

  // A block length other than the default was picked by the student, before
  // Cadence started noticing how long their blocks really last.
  if (!('styleChosen' in state.settings)) state.settings.styleChosen = state.settings.sessionMaxMin !== 45;

  // One model everywhere; the setting was never exposed in the interface.
  state.settings.model = 'claude-opus-5-5';
  return state;
}

export async function saveState(state) {
  state.updatedAt = new Date().toISOString();
  if (HAS_CHROME) await chrome.storage.local.set({ [KEY]: state });
  else localStorage.setItem(KEY, JSON.stringify(state));
  return state;
}

/** Read-modify-write. `fn` may mutate the state or return a new one. */
export async function update(fn) {
  const state = await loadState();
  const next = (await fn(state)) || state;
  return saveState(next);
}

export async function resetState() {
  if (HAS_CHROME) await chrome.storage.local.remove(KEY);
  else localStorage.removeItem(KEY);
  return structuredClone(DEFAULT_STATE);
}
