// Demo data — a realistic junior-year week. Loaded only with ?demo=1 so the
// panel can be shown (and tested) without a Canvas account.

import { addDays, atTime } from '../lib/util.js';

const at = (days, hhmm) => atTime(addDays(new Date(), days), hhmm).toISOString();

export function mockTasks() {
  const t = [
    {
      title: 'Cell respiration lab report',
      courseName: 'AP Biology', courseId: '101', points: 50, due: at(4, '23:59'),
      description: 'Write a full lab report on the cellular respiration experiment. '
        + 'Include hypothesis, procedure, a data table, two graphs, and a 500 word discussion section. '
        + 'Cite at least 3 sources.'
    },
    {
      title: 'Problem set 7 — related rates',
      courseName: 'AP Calculus BC', courseId: '102', points: 20, due: at(1, '08:00'),
      description: 'Complete 14 problems from section 3.9. Show all work.'
    },
    {
      title: 'The Great Gatsby — chapters 4-6',
      courseName: 'American Literature', courseId: '103', points: 15, due: at(2, '23:59'),
      description: 'Read 3 chapters and annotate for symbolism. Post one discussion response.'
    },
    {
      title: 'Research paper — first draft',
      courseName: 'American Literature', courseId: '103', points: 100, due: at(9, '23:59'),
      description: 'Submit a complete first draft of your research paper, 8 pages, '
        + 'with a works cited page. Draft should include your full argument.'
    },
    {
      title: 'Vocab quiz — unit 4',
      courseName: 'Spanish 3', courseId: '104', points: 25, due: at(3, '10:30'),
      description: 'Quiz covers 60 vocabulary terms and the imperfect subjunctive.'
    },
    {
      title: 'Momentum worksheet',
      courseName: 'Physics', courseId: '105', points: 10, due: at(0, '23:59'),
      description: '8 problems on conservation of momentum.'
    },
    {
      title: 'User interview writeup',
      courseName: 'Design & Engineering', courseId: '106', points: 30, due: at(5, '15:00'),
      description: 'Summarize your two user interviews and identify three insights. About 400 words.'
    },
    {
      title: 'Museum trip permission slip',
      courseName: 'American Literature', courseId: '103', points: 0, due: at(2, '08:00'),
      description: 'Return the signed form.'
    },
    // Should be filtered out: more than a month past due.
    {
      title: 'Summer reading reflection',
      courseName: 'American Literature', courseId: '103', points: 20, due: at(-45, '23:59'),
      description: 'One page reflection on your summer book.'
    }
  ];
  return t.map((x, i) => ({
    id: `demo_${i}`, source: 'canvas', canvasType: 'assignment', status: 'todo', ...x
  }));
}

/**
 * Fiona's commitments — the part of her week Canvas can't see.
 * Robotics, cross-country and volunteering happen at fixed times; piano and
 * college essays are flexible targets Cadence schedules around homework.
 */
export function mockCommitments() {
  const created = addDays(new Date(), -30).toISOString();
  return [
    {
      id: 'piano', title: 'Piano', kind: 'practice', color: '#8b5cf6', why: 'First chair at the spring concert',
      schedule: { mode: 'flexible' }, target: { sessions: 5, minutes: 30 }, days: [], time: 'evening',
      event: { label: 'Spring concert', date: isoDay(200) }, org: 'Nueva Music Department', role: 'Pianist, Chamber Ensemble',
      grades: [9, 10, 11], timing: 'all', clubId: null, share: true, createdAt: created, archived: false
    },
    {
      id: 'robotics', title: 'Robotics build nights', kind: 'club', color: '#3b82f6', why: 'Get the intake arm working before Regionals',
      schedule: { mode: 'fixed', days: [1, 3], start: '15:45', end: '17:30' }, target: { sessions: 2, minutes: 105 }, days: [], time: 'any',
      event: { label: 'Regionals', date: isoDay(146) }, org: 'Nueva Robotics (FRC)', role: 'Mechanical sub-team lead',
      grades: [10, 11], timing: 'school', clubId: 'robotics', share: true, createdAt: created, archived: false
    },
    {
      id: 'xc', title: 'Cross-country', kind: 'sport', color: '#10b981', why: 'Break 22 minutes at league finals',
      schedule: { mode: 'fixed', days: [2, 4], start: '16:00', end: '17:45' }, target: { sessions: 2, minutes: 105 }, days: [], time: 'any',
      event: null, org: 'Nueva Varsity Cross-Country', role: 'Varsity runner', grades: [11], timing: 'school', clubId: null, share: true,
      createdAt: created, archived: false
    },
    {
      id: 'essays', title: 'College essays', kind: 'study', color: '#6366f1', why: 'Personal statement done before early deadlines',
      schedule: { mode: 'flexible' }, target: { sessions: 2, minutes: 45 }, days: [0, 3], time: 'evening',
      event: { label: 'Early deadline', date: isoDay(48) }, org: '', role: '', grades: [11], timing: 'all', clubId: null, share: false,
      createdAt: created, archived: false
    },
    {
      id: 'foodbank', title: 'Food bank shifts', kind: 'service', color: '#ec4899', why: '',
      schedule: { mode: 'fixed', days: [6], start: '10:00', end: '13:00' }, target: { sessions: 1, minutes: 180 }, days: [], time: 'any',
      event: null, org: 'Second Harvest Food Bank', role: 'Volunteer, weekend distribution', grades: [10, 11], timing: 'all', clubId: null,
      share: true, createdAt: created, archived: false
    }
  ];
}

function isoDay(offset) {
  const d = addDays(new Date(), offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Four weeks of believable history: mostly consistent, a few misses, notes on
 * the sessions that mattered. Today is left open so there's something to check in.
 */
export function mockCheckins() {
  let seed = 7;
  const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const out = [];
  const notes = {
    piano: ['Chopin nocturne bars 1–32 memorized', 'Slow practice on the left hand run', '', 'Played it through for Mom', '', 'Metronome at 72 now'],
    robotics: ['Intake arm CAD done', 'Cut the aluminum for the arm', '', 'Arm lifts the game piece!', ''],
    xc: ['5 mile tempo', 'Hill repeats x6', '', 'Ran 22:40 at the invitational', ''],
    essays: ['Brainstormed 3 topics', 'Drafted opening paragraph', 'Rewrote the ending', ''],
    foodbank: ['Sorted 400 lbs of produce', 'Trained two new volunteers', '']
  };
  const minutes = { piano: 30, robotics: 105, xc: 105, essays: 45, foodbank: 180 };
  for (let back = 27; back >= 1; back--) {
    const d = addDays(new Date(), -back);
    const dow = d.getDay();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const add = (id, p) => {
      if (rand() > p) return;
      const list = notes[id];
      out.push({
        id: `k_${id}_${date}`, commitmentId: id, date, at: new Date(`${date}T19:00:00`).toISOString(),
        minutes: Math.round(minutes[id] * (0.85 + rand() * 0.35) / 5) * 5,
        feel: rand() > 0.75 ? 'tough' : rand() > 0.4 ? 'great' : 'good',
        note: list[Math.floor(rand() * list.length)]
      });
    };
    if (back !== 9) add('piano', dow === 6 ? 0.3 : 0.8);   // a skipped day covered by a streak freeze
    if (dow === 1 || dow === 3) add('robotics', 0.9);
    if (dow === 2 || dow === 4) add('xc', 0.88);
    if (dow === 0 || dow === 3) add('essays', 0.7);
    if (dow === 6) add('foodbank', 0.85);
  }
  return out;
}

export const mockCourses = [
  { id: '101', name: 'AP Biology', code: 'BIO-AP', role: 'StudentEnrollment' },
  { id: '102', name: 'AP Calculus BC', code: 'CALC-BC', role: 'StudentEnrollment' },
  { id: '103', name: 'American Literature', code: 'ENG-11', role: 'StudentEnrollment' },
  { id: '104', name: 'Spanish 3', code: 'SPA-3', role: 'StudentEnrollment' },
  { id: '105', name: 'Physics', code: 'PHY-1', role: 'StudentEnrollment' },
  { id: '106', name: 'Design & Engineering', code: 'DES-1', role: 'StudentEnrollment' }
];

/** A few logged assignments so "what Cadence has learned" isn't empty. */
export const mockLogs = [
  { category: 'essay', courseId: '103', estimateMin: 90, actualMin: 135 },
  { category: 'essay', courseId: '103', estimateMin: 60, actualMin: 85 },
  { category: 'problemset', courseId: '102', estimateMin: 60, actualMin: 45 },
  { category: 'problemset', courseId: '102', estimateMin: 45, actualMin: 40 },
  { category: 'lab', courseId: '101', estimateMin: 90, actualMin: 120 }
];

// ------------------------------------------------------------ guide data
// What canvas.fetchGuideData would return for each demo assignment: the
// teacher's full instructions (with links), rubric, how it's submitted, and
// the other items in the module it belongs to. Canvas-internal links have no
// real URL in the demo; public ones point somewhere real.

const MOCK_GUIDES = {
  demo_0: {
    description: `<p>Write a full lab report on the cellular respiration experiment we ran in class on Tuesday.</p>
      <p>Include a hypothesis, procedure, a data table, two graphs, and a 500 word discussion section. Cite at least 3 sources in APA format.</p>
      <p>Use the <a href="/courses/101/files/501">lab report template</a> and your <a href="/courses/101/files/502">Lab 3 data sheet</a>.
      If you need a refresher, review <a href="https://www.khanacademy.org/science/biology/cellular-respiration-and-fermentation">Khan Academy: cellular respiration</a>.</p>`,
    submission: { types: ['online_upload'], exts: ['pdf', 'docx'] },
    rubric: [
      { title: 'Hypothesis & procedure', detail: 'Testable hypothesis; procedure someone else could repeat', points: 10 },
      { title: 'Data table & graphs', detail: 'Labeled axes, units, and titles', points: 15 },
      { title: 'Discussion & analysis', detail: 'Explains results using what we know about respiration', points: 15 },
      { title: 'Citations (APA)', detail: '', points: 5 },
      { title: 'Clarity & formatting', detail: '', points: 5 }
    ],
    module: {
      name: 'Unit 3 · Cellular Respiration',
      items: [
        { title: 'Cellular respiration — lecture slides', kind: 'file' },
        { title: 'Glycolysis & the Krebs cycle (12 min video)', kind: 'link', external: 'https://youtube.com' },
        { title: 'Lab 3 procedure', kind: 'page' },
        { title: 'Example of a strong lab report', kind: 'file' },
        { title: 'APA citation quick guide', kind: 'page' }
      ]
    }
  },
  demo_1: {
    description: `<p>Complete 14 problems from section 3.9 (related rates). Show all your work — answers without work get half credit.</p>
      <p>Problems: #3, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35, 38, 41. Upload a photo or scan of your work.</p>
      <p>Stuck? Watch a <a href="https://www.youtube.com/results?search_query=related+rates+calculus">related rates walkthrough</a>.</p>`,
    submission: { types: ['online_upload'], exts: ['pdf', 'jpg', 'png'] },
    module: {
      name: 'Unit 3 · Applications of Derivatives',
      items: [
        { title: '3.9 Related rates — class notes', kind: 'file' },
        { title: '3.9 Worked examples (the ladder and the cone)', kind: 'file' },
        { title: 'Derivative rules formula sheet', kind: 'file' },
        { title: 'Quiz 3.8–3.9 review', kind: 'page' }
      ]
    }
  },
  demo_2: {
    description: `<p>Read chapters 4–6 of <em>The Great Gatsby</em> and annotate for symbolism (colors, the green light, weather).</p>
      <p>Then post one discussion response (150+ words) answering: <strong>What does Gatsby want, and what does it cost him?</strong> Reply to two classmates.</p>
      <p>Use the <a href="/courses/103/files/701">symbolism annotation guide</a>.</p>`,
    submission: { types: ['discussion_topic'], exts: [] },
    module: {
      name: 'The Great Gatsby',
      items: [
        { title: 'Gatsby reading schedule', kind: 'page' },
        { title: 'Chapters 4–6 audiobook', kind: 'link', external: 'https://youtube.com' },
        { title: 'Discussion: What does Gatsby want?', kind: 'discussion' }
      ]
    }
  },
  demo_3: {
    description: `<p>Submit a complete first draft of your research paper: 8 pages, double-spaced, MLA format, with a works cited page.</p>
      <p>Your draft should include a clear thesis in the first paragraph, at least 5 credible sources, and your full argument. It doesn't need to be polished yet.</p>
      <p>See the <a href="/courses/103/files/702">research paper assignment sheet</a> and the <a href="/courses/103/pages/mla-guide">MLA guide</a>.
      Library databases: <a href="https://www.jstor.org">JSTOR</a>.</p>`,
    submission: { types: ['online_upload'], exts: ['docx', 'pdf'] },
    rubric: [
      { title: 'Thesis & argument', detail: 'Arguable thesis, developed throughout', points: 30 },
      { title: 'Use of sources', detail: 'Credible sources, integrated and analyzed — not just quoted', points: 25 },
      { title: 'Organization', detail: '', points: 20 },
      { title: 'MLA & works cited', detail: '', points: 15 },
      { title: 'Conventions', detail: '', points: 10 }
    ],
    module: {
      name: 'Junior Research Paper',
      items: [
        { title: 'Research paper assignment sheet', kind: 'file' },
        { title: 'Strong thesis statement examples', kind: 'page' },
        { title: 'How to tell if a source is credible', kind: 'page' },
        { title: 'Peer review checklist', kind: 'file' }
      ]
    }
  },
  demo_4: {
    description: `<p>Quiz on Unidad 4: 60 vocabulary terms (la salud, el cuerpo) and the imperfect subjunctive.</p>
      <p>You'll take it at the start of class. Study with the <a href="https://quizlet.com">Unit 4 Quizlet set</a>.</p>`,
    submission: { types: ['online_quiz'], exts: [] },
    quiz: { questions: 30, timeLimit: 20, attempts: 1 },
    module: {
      name: 'Unidad 4 · La salud',
      items: [
        { title: 'Unit 4 vocabulary list', kind: 'file' },
        { title: 'Imperfect subjunctive notes', kind: 'page' },
        { title: 'Practice: subjunctive worksheet', kind: 'file' }
      ]
    }
  },
  demo_5: {
    description: `<p>8 problems on conservation of momentum. Show your work and include units in every answer.</p>
      <p>Download the <a href="/courses/105/files/901">momentum worksheet (PDF)</a>, complete it, and upload a scan.</p>`,
    submission: { types: ['online_upload'], exts: ['pdf'] },
    module: {
      name: 'Unit 2 · Momentum',
      items: [
        { title: 'Momentum & impulse notes', kind: 'file' },
        { title: 'Collision demo video', kind: 'link', external: 'https://youtube.com' }
      ]
    }
  },
  demo_6: {
    description: `<p>Summarize your two user interviews and identify three insights. About 400 words.</p>
      <p>Write each insight using the <a href="/courses/106/pages/insight-statements">insight statement format</a>: "[User] needs [need] because [insight]."</p>`,
    submission: { types: ['online_text_entry'], exts: [] },
    module: {
      name: 'Empathy phase',
      items: [
        { title: 'Interview notes template', kind: 'page' },
        { title: 'Example insight statements', kind: 'page' }
      ]
    }
  },
  demo_7: {
    description: `<p>Print, sign, and return the <a href="/courses/103/files/999">museum trip permission slip</a> by Monday morning.</p>`,
    submission: { types: ['on_paper'], exts: [] }
  }
};

export function mockGuideData(task) {
  const g = MOCK_GUIDES[task.id];
  return g ? structuredClone(g) : { description: task.description || '' };
}
