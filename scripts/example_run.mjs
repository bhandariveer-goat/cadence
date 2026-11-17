// Run by scripts/copy_example.py in JavaScriptCore (macOS's own JavaScript
// shell, so no Node is needed): works out the homepage's example the way a
// visitor's browser does and prints, as JSON, everything index.html holds a
// copy of: Sam's starting week, what Sam has, why the week looks that way,
// and the assistant's real reply to the sentence the homepage shows.

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
const { KIND_LABEL } = await import('../src/lib/agentops.js');

// A stand-in for the example's section of the page: just the parts mount() fills in.
const part = () => ({ innerHTML: '', hidden: true, textContent: '', setAttribute() {}, addEventListener() {}, querySelectorAll: () => [] });
const parts = { '[data-ev-week]': part(), '[data-ev-have]': part(), '[data-ev-why]': part(), '[data-ev-changed]': part(), '[data-ev-status]': part(), '[data-ev-try]': part(), '[data-ev-reset]': part() };
const list = part();
parts['[data-ev-changed]'].querySelector = () => list;
E.mount({ querySelector: (s) => parts[s] || null, querySelectorAll: () => [] });

// The assistant's reply on the homepage, worked out by the reader that runs
// on the device, on Sam's week, at the example's own moment.
const SENTENCE = 'Practice is cancelled Wednesday';
const r = E.atMoment(E.NOW, () => respond(SENTENCE, E.startingWeek(), new Date()));

print(JSON.stringify({
  week: parts['[data-ev-week]'].innerHTML,
  have: parts['[data-ev-have]'].innerHTML,
  why: parts['[data-ev-why]'].innerHTML,
  reply: { sentence: SENTENCE, text: r.text, changes: r.ops.map((op) => ({ summary: op.summary, label: KIND_LABEL[op.kind] || '' })), moved: r.moved }
}));
