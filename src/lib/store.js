// Persistence layer. Uses chrome.storage.local inside the extension and falls
// back to localStorage so demo/index.html runs as a plain web page.

const HAS_CHROME = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
const KEY = 'cadence.state.v1';

export const DEFAULT_STATE = {
  profile: {
    name: '',
    onboarded: false,
    schoolEnd: '15:30',
    routine: 'afternoon-evening',   // preset last chosen for school days
    weekend: 'relaxed'
  },

  // Legacy recurring activities — migrated into fixed-schedule commitments on load.
  activities: [],

  // The things nobody assigns: see lib/habits.js for the shape.
  commitments: [],
  checkins: [],                   // {id, commitmentId, date, at, minutes, feel, note}
  streak: { freezes: 1, frozenDays: [], best: 0, lastAward: null },
  sync: { mode: 'local', url: '', anonKey: '', session: null },
  lastReviewWeek: null,

  // Connected calendars. Each keeps its own cache so one failing source never
  // blanks the others; see lib/sources/sources.js.
  sources: {
    canvasFeed: { enabled: false, url: '', events: [], assignments: [], lastSync: null, lastTry: null, error: null },
    google: {
      enabled: false, clientId: '', email: '', accessToken: null, expiresAt: 0, scopes: [],
      calendars: [], selected: [], push: false, pushCalendarId: 'primary', pushed: {},
      events: [], assignments: [], lastSync: null, lastTry: null, error: null
    }
  },
  autoSync: { enabled: true, everyMinutes: 20, lastRun: null },
  dismissed: {},                  // taskId -> true when she says "not doing this"

  settings: {
    role: 'student',            // 'student' | 'teacher'
    dailyCapacityMin: 150,      // how much homework feels right on a school night
    sessionMaxMin: 45,          // longest single work block before a break
    sessionMinMin: 20,          // don't bother scheduling slivers shorter than this
    bufferHours: 12,            // finish this far before the deadline
    breakMin: 10,
    lookaheadDays: 14,
    remindersEnabled: true,
    remindLeadMin: 5,
    useAI: false,
    apiKey: '',
    model: 'claude-sonnet-5',
    canvasHost: ''              // auto-filled from the tab Cadence is opened on
  },

  // Weekly recurring free time, local clock. 0 = Sunday.
  availability: {
    0: [{ start: '13:00', end: '18:00' }],
    1: [{ start: '15:45', end: '21:30' }],
    2: [{ start: '15:45', end: '21:30' }],
    3: [{ start: '15:45', end: '21:30' }],
    4: [{ start: '15:45', end: '21:30' }],
    5: [{ start: '15:45', end: '21:30' }],
    6: [{ start: '13:00', end: '18:00' }]
  },

  // Calendar events that block time: imported .ics, or added by hand.
  busy: [],                     // {id, title, start ISO, end ISO, source}

  tasks: {},                    // id -> task
  plan: null,                   // {generatedAt, sessions:[], unplaced:[]}
  logs: [],                     // {taskId, category, courseId, estimateMin, actualMin, at}
  model: { biases: {}, globalFactor: 1 },  // learned per-course/category speed
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

/** Older installs stored practices as "activities"; they're commitments now. */
function migrate(state) {
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
  return state;
}

export async function saveState(state) {
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
