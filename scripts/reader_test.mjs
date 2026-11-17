// Tests for the assistant's offline sentence reader (src/lib/agent.js, and
// findItems in src/lib/agentops.js). They run in JavaScriptCore, the
// JavaScript shell that comes with macOS, so no Node is needed:
//
//   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc -m scripts/reader_test.mjs
//
// scripts/prelaunch_check.py runs them too.
//
// Each case is a sentence typed on a week, read at the homepage example's own
// moment (Monday, February 9 2026 at 3:15pm, src/site/evening.js), and the
// change the reply must list. Most are about what a sentence must not touch:
// something called off is only ever a thing of the kind that was said, a
// sentence marks done only an assignment every word of it fits, and when
// nothing fits, the reply says so instead of changing something else.
// Prints each failure and a count, and exits with an error when any fail.

// The shell has no console or structuredClone; the planner needs both.
const RealDate = Date;
const say = (...a) => print(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
globalThis.console = { log: say, info: say, warn: say, error: say, debug: () => {} };
function clone(x, seen = new Map()) {
  if (x === null || typeof x !== 'object') {
    if (typeof x === 'function') throw new Error('DataCloneError: function');
    return x;
  }
  if (seen.has(x)) return seen.get(x);
  if (x instanceof RealDate) return new RealDate(x.getTime());
  if (x instanceof Map) { const m = new Map(); seen.set(x, m); for (const [k, v] of x) m.set(clone(k, seen), clone(v, seen)); return m; }
  if (x instanceof Set) { const s = new Set(); seen.set(x, s); for (const v of x) s.add(clone(v, seen)); return s; }
  if (Array.isArray(x)) { const a = []; seen.set(x, a); x.forEach((v, i) => { a[i] = clone(v, seen); }); return a; }
  const o = {};
  seen.set(x, o);
  for (const k of Object.keys(x)) o[k] = clone(x[k], seen);
  return o;
}
globalThis.structuredClone = (x) => clone(x);

const E = await import('../src/site/evening.js');
const { respond } = await import('../src/lib/agent.js');
const { recomputeState } = await import('../src/lib/replanner.js');
const { newCommitment } = await import('../src/lib/habits.js');

// A time in the example's week: days after Monday, hours, minutes.
const at = (day, hh, mm = 0) => new Date(2026, 1, 9 + day, hh, mm);

// ------------------------------------------------------------------ weeks

// Sam's week from the homepage. Its robotics meeting came in by email, which
// the assistant never sees, so to the reader "robotics" is only the
// assignment "Robotics build log".
const sam = () => E.startingWeek();

// Sam's week after the homepage's "Coach moves Wednesday's practice to 6pm":
// that day's practice is off, and a 6pm event stands in for it.
const moved = () => E.change(E.startingWeek(), 'moved').after;

// Sam's week with no practice to call off, and an assignment that says practice.
const satPractice = () => E.atMoment(E.NOW, () => {
  const st = E.startingWeek();
  st.commitments = st.commitments.filter((c) => c.id !== 'practice');
  st.tasks.sat = { id: 'sat', source: 'manual', title: 'SAT practice', courseName: '', due: at(4, 23, 59).toISOString(), userEstimateMin: 45, category: 'study', status: 'todo', description: '' };
  return recomputeState(st);
});

// A busier week: names that share words, two practices, two dinners.
const busy = () => E.atMoment(E.NOW, () => {
  const st = E.startingWeek();
  st.sources.mail.events = [];
  const task = (id, title, courseName, due, minutes, category) => ({ id, source: 'manual', title, courseName, due: due.toISOString(), userEstimateMin: minutes, category, status: 'todo', description: '' });
  st.tasks = {
    lab: task('lab', 'Lab report', 'Chemistry', at(2, 8), 90, 'lab'),
    chemws: task('chemws', 'Chem worksheet 3', 'Chemistry', at(3, 23, 59), 30, 'worksheet'),
    pp: task('pp', 'Practice problems 3.1', 'Algebra 2', at(1, 23, 59), 40, 'problemset'),
    art: task('art', 'Article summary', 'English 10', at(3, 23, 59), 30, 'writing'),
    read: task('read', 'Read chapter 5', 'US History', at(2, 23, 59), 40, 'reading'),
    spanish: task('spanish', 'Spanish quiz', 'Spanish 3', at(3, 9), 45, 'quiz'),
    logw: task('logw', 'Logarithms worksheet', 'Precalculus', at(4, 23, 59), 30, 'worksheet'),
    build: task('build', 'Robotics build log', '', at(4, 23, 59), 60, 'project'),
    ch: task('ch', 'Ch 6 notes', 'US History', at(4, 23, 59), 30, 'reading'),
    unit: task('unit', 'Unit 2 review', 'AP Calculus', at(4, 23, 59), 45, 'review')
  };
  st.commitments = [
    newCommitment({ id: 'bball', kind: 'sport', title: 'Basketball practice', schedule: { mode: 'fixed', days: [1, 3], start: '15:30', end: '17:30' } }),
    newCommitment({ id: 'piano', kind: 'practice', title: 'Piano practice', target: { sessions: 4, minutes: 30 } }),
    newCommitment({ id: 'robo', kind: 'club', title: 'Robotics', schedule: { mode: 'fixed', days: [2, 4], start: '15:30', end: '17:00' } }),
    newCommitment({ id: 'artc', kind: 'club', title: 'Art club', schedule: { mode: 'fixed', days: [5], start: '15:30', end: '16:30' } })
  ];
  const ev = (id, title, start, end) => ({ id, title, source: 'manual', start: start.toISOString(), end: end.toISOString() });
  st.busy = [ev('dentist', 'Dentist', at(2, 16), at(2, 17)), ev('grandma', 'Dinner with grandma', at(4, 18), at(4, 20)),
    ev('game', 'Basketball game', at(5, 10), at(5, 12)), ev('team', 'Team dinner', at(3, 18, 30), at(3, 20))];
  return recomputeState(st);
});

// ------------------------------------------------------------------ cases

// [week, sentence, expected]. `does` lists the changes the reply shows, as
// its list says them ("Basketball practice · off Wednesday"), [] for none.
// `says` is part of the reply's text, `target` what a removal takes away,
// and `asks` the sentences its buttons send.
const NONE_FOR = (name) => `No activity or event you added matches “${name}”, so nothing was removed.`;
const CASES = [
  // The bug: a meeting called off is never the assignment that shares its first word.
  [sam, 'Robotics meeting is cancelled', { does: [], says: NONE_FOR('Robotics meeting') }],
  [sam, 'Robotics is cancelled', { does: [], says: NONE_FOR('Robotics') }],
  [sam, "Thursday's robotics meeting is cancelled", { does: [], says: NONE_FOR('robotics meeting') }],
  [sam, "I'm not going to the robotics meeting", { does: [], says: NONE_FOR('robotics meeting') }],
  [sam, 'No robotics meeting today', { does: [], says: NONE_FOR('robotics meeting') }],
  [sam, 'Move the robotics meeting to Friday', { does: [] }],
  [sam, 'Cancel dinner at 6', { does: [], says: NONE_FOR('dinner') }],
  // Other kinds that are not what is on the plan.
  [sam, 'Basketball game is cancelled Wednesday', { does: [], says: NONE_FOR('Basketball game') }],
  [sam, 'Spanish club is cancelled', { does: [], says: NONE_FOR('Spanish club') }],
  [sam, 'Chem class is cancelled', { does: [], says: NONE_FOR('Chem class') }],
  [sam, 'Spanish test is cancelled', { does: [], says: 'No assignment matches “Spanish test”, so nothing was removed.' }],
  [satPractice, 'Practice is cancelled', { does: [], says: NONE_FOR('Practice') }],
  // What still has to work.
  [sam, 'Practice is cancelled today', { does: ['Basketball practice · off today'] }],
  [sam, 'Practice is cancelled Wednesday', { does: ['Basketball practice · off Wednesday'], says: 'Done. Your plan is rebuilt around it and everything still fits.' }],
  [sam, "Tomorrow's practice is cancelled", { does: ['Basketball practice · off tomorrow'] }],
  [sam, 'Practice got canceled', { does: ['Basketball practice · off today'] }],
  [sam, 'Skip practice today', { does: ['Basketball practice · off today'] }],
  [sam, 'The Spanish quiz got cancelled', { does: ['Spanish quiz · removed'], target: 'task' }],
  [sam, 'Delete the robotics build log', { does: ['Robotics build log · removed'] }],
  [sam, 'Remove calc', { does: ['Calculus problem set 4.2 · removed'] }],
  [sam, 'Skip calc tonight', { does: ['Calculus problem set 4.2 · moved to tomorrow'] }],
  [sam, 'Skip the essay today', { does: ['College essay · off today'] }],
  [sam, 'Dinner at 6:30 tonight', { does: ['Dinner · 6:30pm to 7:30pm today'] }],
  [sam, 'Spanish quiz Thursday, 30 min', { does: ['Spanish quiz · due Thursday, about 30m'] }],
  [sam, "I'm tired, an hour of work tonight", { does: ['Tonight: up to 1h of work'] }],
  [sam, "I'm busy until 6:30", { does: ['Busy · 3:15pm to 6:30pm today'] }],
  [sam, 'Practice runs until 6:30', { does: ['Basketball practice runs late · 5:30pm to 6:30pm today'] }],
  // Finished: only an assignment that every word fits.
  [sam, 'I finished the robotics build log', { does: ['Robotics build log · marked done'] }],
  [sam, 'I turned in the robotics build log', { does: ['Robotics build log · marked done'] }],
  [sam, 'I finished my calc homework', { does: ['Calculus problem set 4.2 · marked done'] }],
  [sam, 'I got done with the robotics build log at 5', { does: ['Robotics build log · marked done'] }],
  [sam, 'I finished the spanish worksheet', { does: [], says: 'No assignment matches “spanish worksheet”, so nothing was marked done.' }],
  [sam, 'I did 2 hours of work', { does: ['Tonight: up to 2h of work'] }],
  [sam, "I'm done with robotics at 5", { does: ['Tonight: starting 5pm'] }],
  [sam, "I'll be done with the robotics build log by 9", { does: ['Tonight: starting 9pm'] }],
  // A busier week.
  [busy, 'Robotics meeting is cancelled Thursday', { does: ['Robotics · off Thursday'], target: 'activity' }],
  [busy, 'Spanish club is cancelled', { does: [], says: NONE_FOR('Spanish club') }],
  [busy, 'Chem is cancelled', { does: [], says: NONE_FOR('Chem') }],
  [busy, 'Piano lesson is cancelled', { does: [], says: NONE_FOR('Piano lesson') }],
  [busy, 'Basketball game is cancelled', { does: ['Basketball game · removed'], target: 'event' }],
  [busy, 'Practice is cancelled Wednesday', { does: ['Basketball practice · off Wednesday'] }],
  [busy, 'Cancel the dentist appointment', { does: ['Dentist · removed'] }],
  [busy, 'Dinner is cancelled', { does: [], says: 'Which one do you mean: Team dinner or Dinner with grandma?', asks: ['Team dinner is cancelled', 'Dinner with grandma is cancelled'] }],
  [busy, 'Team dinner is cancelled', { does: ['Team dinner · removed'] }],
  [busy, 'Skip the reading tonight', { does: ['Read chapter 5 · moved to tomorrow'] }],
  [busy, 'I finished the log', { does: ['Robotics build log · marked done'] }],
  [busy, 'I finished apush', { does: [] }],
  [busy, 'I finished chapter 6', { does: ['Ch 6 notes · marked done'] }],
  [busy, 'I finished the practice problems', { does: ['Practice problems 3.1 · marked done'] }],
  [busy, "I'm done with practice", { does: [] }],
  [busy, 'I finished chemistry', { does: [], says: 'Which one do you mean: ', asks: ['I finished Lab report', 'I finished Chem worksheet 3'] }],
  // Practice moved to an event: calling it off takes the event that is on that day.
  [moved, 'Practice is cancelled Wednesday', { does: ['Basketball practice · off Wednesday'], target: 'event' }]
];

// ------------------------------------------------------------------ run

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let failed = 0;
for (const [week, sentence, want] of CASES) {
  const r = E.atMoment(E.NOW, () => respond(sentence, week(), new Date()));
  const does = r.ops.map((op) => op.summary);
  const asks = (r.chips || []).map((c) => c.text);
  const wrong = [
    !same(does, want.does) && `changes ${JSON.stringify(does)}, wanted ${JSON.stringify(want.does)}`,
    want.says && !r.text.includes(want.says) && `says "${r.text}"`,
    want.target && r.ops[0]?.target !== want.target && `takes away a ${r.ops[0]?.target}, wanted a ${want.target}`,
    want.asks && !same([...asks].sort(), [...want.asks].sort()) && `offers ${JSON.stringify(asks)}, wanted ${JSON.stringify(want.asks)}`
  ].filter(Boolean);
  if (wrong.length) {
    failed++;
    print(`FAIL  ${week.name}: "${sentence}"\n      ${wrong.join('\n      ')}`);
  }
}
print(failed ? `${failed} of ${CASES.length} failed.` : `All ${CASES.length} reader cases pass.`);
if (failed) throw new Error(`${failed} reader cases failed`);
