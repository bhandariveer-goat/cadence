// How long is this going to take?
//
// Two layers:
//   1. A transparent heuristic over the assignment text (type, size signals,
//      points). It runs offline and always produces a rationale we can show.
//   2. A learned per-student correction: every time she logs an actual time we
//      nudge a multiplier for that (course, category) pair. Over a few weeks
//      the estimates stop being generic and start being *hers*.

import { clamp } from './util.js';

export const CATEGORIES = {
  reading:    { label: 'Reading',      base: 30, perPoint: 0.6 },
  problemset: { label: 'Problem set',  base: 45, perPoint: 1.4 },
  essay:      { label: 'Writing',      base: 60, perPoint: 1.8 },
  lab:        { label: 'Lab / report', base: 70, perPoint: 1.6 },
  project:    { label: 'Project',      base: 120, perPoint: 2.2 },
  quiz:       { label: 'Quiz / test',  base: 50, perPoint: 1.0 },
  discussion: { label: 'Discussion',   base: 25, perPoint: 0.8 },
  presentation: { label: 'Presentation', base: 90, perPoint: 2.0 },
  worksheet:  { label: 'Worksheet',    base: 35, perPoint: 1.0 },
  admin:      { label: 'Small task',   base: 15, perPoint: 0.4 }
};

const KEYWORDS = [
  [/\b(read|reading|chapter|pages?\s+\d|textbook|article|annotate)\b/i, 'reading'],
  [/\b(essay|paper|write|writing|write-?up|draft|thesis|reflection|journal|response|memoir|analysis|summari[sz]e|summary|insights?|\d{2,4}\s*words)\b/i, 'essay'],
  [/\b(quiz|test|exam|midterm|final\s+exam|assessment)\b/i, 'quiz'],
  [/\b(lab|experiment|data\s*table|procedure|observation)\b/i, 'lab'],
  [/\b(project|build|design|prototype|portfolio|final\s+deliverable)\b/i, 'project'],
  [/\b(discussion|discuss|forum|post|reply|peer\s+review)\b/i, 'discussion'],
  [/\b(present|presentation|slides|deck|talk|pitch)\b/i, 'presentation'],
  [/\b(problem\s*set|pset|homework|exercises?|problems?\s+\d|equations?|derive|solve)\b/i, 'problemset'],
  [/\b(worksheet|packet|handout|fill\s+in)\b/i, 'worksheet'],
  [/\b(form|survey|sign\s*up|permission\s+slip|submit\s+your\s+name|acknowledge)\b/i, 'admin']
];

/**
 * Guess a category from Canvas metadata + free text.
 *
 * Counts keyword hits rather than taking the first pattern that matches: a lab
 * report says "write" once but "lab", "procedure" and "data table" between
 * them several times, and the majority should win.
 */
export function classify(task) {
  const text = `${task.title || ''} ${task.description || ''}`.replace(/<[^>]+>/g, ' ');
  if (task.canvasType === 'quiz') return 'quiz';
  if (task.canvasType === 'discussion_topic') return 'discussion';

  let best = null, bestScore = 0;
  for (const [re, cat] of KEYWORDS) {
    const hits = (text.match(new RegExp(re.source, 'gi')) || []).length;
    if (hits > bestScore) { best = cat; bestScore = hits; }
  }
  return best || 'worksheet';
}

/** Pull explicit size signals out of the prompt: word counts, pages, problems. */
function sizeSignals(text) {
  const out = [];
  const words = text.match(/(\d{2,5})\s*(?:\+|-|to|–)?\s*(?:\d{2,5})?\s*words?/i);
  if (words) {
    const n = Number(words[1]);
    // ~250 words/hour of real drafting-and-revising for a high schooler.
    out.push({ minutes: (n / 250) * 60, why: `${n} words to write` });
  }
  const pagesWrite = text.match(/(\d{1,2})(?:\s*[-–]\s*\d{1,2})?\s*pages?\s*(?:paper|essay|double|single|long|minimum|min)?/i);
  if (pagesWrite && !words) {
    const n = Number(pagesWrite[1]);
    if (/read|chapter|textbook/i.test(text)) out.push({ minutes: n * 3.5, why: `${n} pages of reading` });
    else out.push({ minutes: n * 60, why: `${n}-page paper` });
  }
  const chapters = text.match(/(\d{1,2})\s*chapters?/i);
  if (chapters) out.push({ minutes: Number(chapters[1]) * 35, why: `${chapters[1]} chapter(s)` });
  const problems = text.match(/(\d{1,3})\s*(?:problems?|questions?|exercises?)/i);
  if (problems) {
    const n = Number(problems[1]);
    out.push({ minutes: n * 4.5, why: `${n} problems` });
  }
  const slides = text.match(/(\d{1,2})\s*slides?/i);
  if (slides) out.push({ minutes: Number(slides[1]) * 8, why: `${slides[1]} slides` });
  const mins = text.match(/(?:should take|takes?|about|roughly|approximately)\s*(?:about\s*)?(\d{1,3})\s*(?:minutes|mins?)/i);
  if (mins) out.push({ minutes: Number(mins[1]), why: 'teacher said how long', hard: true });
  const hrs = text.match(/(?:should take|takes?|about|roughly|approximately)\s*(?:about\s*)?(\d{1,2}(?:\.\d)?)\s*(?:hours?|hrs?)/i);
  if (hrs) out.push({ minutes: Number(hrs[1]) * 60, why: 'teacher said how long', hard: true });
  return out;
}

export function biasKey(courseId, category) {
  return `${courseId || 'any'}::${category}`;
}

/** Learned multiplier for this course+category, blended toward 1 when we have little data. */
export function learnedFactor(model, courseId, category) {
  const b = model?.biases?.[biasKey(courseId, category)];
  const g = model?.biases?.[biasKey(null, category)];
  const global = model?.globalFactor ?? 1;
  let factor = global, n = 0;
  if (g) { factor = g.factor; n = g.n; }
  if (b) {
    // Course-specific data outweighs the category-wide number once it exists.
    const w = clamp(b.n / (b.n + 2), 0, 0.85);
    factor = b.factor * w + factor * (1 - w);
    n = b.n + n;
  }
  return { factor: clamp(factor, 0.4, 3), samples: n };
}

/**
 * @returns {{minutes:number, low:number, high:number, confidence:number,
 *            category:string, rationale:string[]}}
 */
export function estimate(task, model = { biases: {}, globalFactor: 1 }) {
  const category = task.category || classify(task);
  const cat = CATEGORIES[category] || CATEGORIES.worksheet;
  const text = `${task.title || ''} ${(task.description || '').replace(/<[^>]+>/g, ' ')}`;
  const rationale = [];

  const signals = sizeSignals(text);
  const hard = signals.find((s) => s.hard);

  let minutes;
  if (hard) {
    minutes = hard.minutes;
    rationale.push(`Prompt says ~${Math.round(hard.minutes)} min`);
  } else if (signals.length) {
    minutes = signals.reduce((a, s) => a + s.minutes, 0);
    signals.forEach((s) => rationale.push(s.why));
    // A prompt that names its own size still carries setup/finishing overhead.
    minutes += cat.base * 0.35;
    rationale.push(`${cat.label} setup & review`);
  } else {
    minutes = cat.base;
    rationale.push(`Typical ${cat.label.toLowerCase()}`);
    if (task.points) {
      const fromPoints = task.points * cat.perPoint;
      minutes = (minutes + fromPoints) / 2;
      rationale.push(`${task.points} pts`);
    }
  }

  // Longer, more detailed prompts usually mean more moving parts.
  const bodyWords = (task.description || '').replace(/<[^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
  if (bodyWords > 180 && !hard) {
    minutes *= 1.15;
    rationale.push('detailed instructions');
  }
  if (/\b(group|partner|team)\b/i.test(text)) { minutes *= 1.1; rationale.push('group coordination'); }
  if (/\b(cite|sources?|bibliography|research|works cited)\b/i.test(text) && !hard) {
    minutes *= 1.2; rationale.push('research + citations');
  }

  const { factor, samples } = learnedFactor(model, task.courseId, category);
  if (samples >= 2 && Math.abs(factor - 1) > 0.08) {
    minutes *= factor;
    rationale.push(factor > 1
      ? `you run ${Math.round((factor - 1) * 100)}% over on these`
      : `you finish these ${Math.round((1 - factor) * 100)}% faster than average`);
  }

  minutes = clamp(Math.round(minutes / 5) * 5, 10, 8 * 60);
  const spread = samples >= 4 ? 0.25 : hard ? 0.2 : 0.4;
  const confidence = clamp(0.35 + (hard ? 0.3 : 0) + (signals.length ? 0.15 : 0) + Math.min(samples, 6) * 0.05, 0.2, 0.95);

  return {
    minutes,
    low: Math.round((minutes * (1 - spread)) / 5) * 5,
    high: Math.round((minutes * (1 + spread)) / 5) * 5,
    confidence,
    category,
    rationale
  };
}

/**
 * Fold a finished assignment back into the model.
 * Exponential moving average on the ratio actual/estimate, capped so one
 * disastrous night doesn't permanently skew everything.
 */
export function learn(model, { courseId, category, estimateMin, actualMin }) {
  if (!estimateMin || !actualMin) return model;
  const ratio = clamp(actualMin / estimateMin, 0.25, 4);
  const next = { biases: { ...(model.biases || {}) }, globalFactor: model.globalFactor ?? 1 };

  for (const key of [biasKey(courseId, category), biasKey(null, category)]) {
    const prev = next.biases[key] || { factor: 1, n: 0 };
    const alpha = clamp(0.45 / Math.sqrt(prev.n + 1), 0.12, 0.45);
    next.biases[key] = {
      factor: clamp(prev.factor * (1 - alpha) + ratio * alpha, 0.4, 3),
      n: prev.n + 1
    };
  }
  next.globalFactor = clamp(next.globalFactor * 0.9 + ratio * 0.1, 0.5, 2);
  return next;
}
