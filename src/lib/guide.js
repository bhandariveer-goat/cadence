// Assignment guides: what am I actually doing, what do I turn in, how do I
// break it down, and where is the stuff I need?
//
// Works entirely offline from the assignment's own instructions plus whatever
// Canvas can tell us (rubric, submission type, the module it lives in). The
// optional Cadence Intelligence layer rewrites the summary and steps, but this
// file is what makes a guide appear for every student.

import { classify } from './estimator.js';

const WORDNUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const toNum = (s) => (s == null ? null : /^\d+$/.test(s) ? Number(s) : WORDNUM[String(s).toLowerCase()] ?? null);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const aOr = (n) => (/^(8|11|18|8\d)$/.test(String(n)) ? 'an' : 'a');
const idOf = (s) => `m_${Math.abs([...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)).toString(36)}`;

// ------------------------------------------------------------ text helpers

/** Canvas HTML -> readable text with paragraph breaks. Never rendered as HTML. */
export function plainText(html = '') {
  if (!html) return '';
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
    doc.querySelectorAll('script,style').forEach((n) => n.remove());
    doc.querySelectorAll('br').forEach((n) => n.replaceWith('\n'));
    doc.querySelectorAll('li').forEach((n) => n.prepend('• '));
    doc.querySelectorAll('p,div,li,h1,h2,h3,h4,h5,tr,blockquote').forEach((n) => n.append('\n'));
    return doc.body.textContent.replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  return html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').trim();
}

function firstSentences(text, max = 190) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const m = clean.match(/^(.+?[.!?])(\s|$)/);
  let s = m ? m[1] : clean;
  if (s.length > max) s = `${s.slice(0, max).replace(/\s+\S*$/, '')}…`;
  return s;
}

// --------------------------------------------------------------- materials

/** Best guess at what kind of thing a link is, for its icon and wording. */
export function materialType(title = '', url = '', kind = '') {
  const k = String(kind).toLowerCase();
  const s = `${title} ${url}`.toLowerCase();
  if (k === 'quiz') return 'quiz';
  if (k === 'discussion') return 'discussion';
  if (k === 'assignment') return 'assignment';
  if (/youtube|youtu\.be|vimeo|edpuzzle|loom\.com|\bvideo\b|lecture recording/.test(s)) return 'video';
  if (k === 'page') return 'page';
  if (k === 'file' || /\.(pdf|docx?|pptx?|xlsx?|png|jpe?g)\b|\/files\/|docs\.google|drive\.google/.test(s)) return 'file';
  if (/\/pages\//.test(s)) return 'page';
  return 'link';
}

/** Links a teacher put in the instructions. Relative Canvas links resolve against `origin`. */
export function extractLinks(html = '', origin = '') {
  if (!html || typeof DOMParser === 'undefined') return [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = [];
  const seen = new Set();
  for (const a of doc.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    if (/^(mailto|javascript|#)/i.test(href)) continue;
    let url = null;
    if (/^https?:\/\//i.test(href)) url = href;
    else if (origin) { try { url = new URL(href, origin).href; } catch { url = null; } }
    const title = (a.textContent || a.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    if (title.length < 2) continue;
    const key = (url || title).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: idOf(key), title: cap(title.slice(0, 90)), url, type: materialType(title, href), source: 'Linked in the instructions' });
  }
  return out;
}

/** "Chapters 4–6", "Section 3.9", "pages 112–130" — pointers into the textbook. */
export function textbookRefs(text = '') {
  const out = [];
  const add = (title) => { if (!out.some((o) => o.title === title)) out.push({ id: idOf(title), title, url: null, type: 'textbook', source: 'Your textbook or class notes' }); };
  const ch = text.match(/\bch(?:apters?|s?\.)\s*(\d{1,2})(?:\s*(?:-|–|to|through)\s*(\d{1,2}))?/i);
  if (ch) add(ch[2] ? `Chapters ${ch[1]}–${ch[2]}` : `Chapter ${ch[1]}`);
  const sec = text.match(/\bsections?\s*(\d{1,2}(?:\.\d{1,2})+)(?:\s*(?:-|–|to|and)\s*(\d{1,2}(?:\.\d{1,2})+))?/i);
  if (sec) add(sec[2] ? `Sections ${sec[1]}–${sec[2]}` : `Section ${sec[1]}`);
  const pg = text.match(/\b(?:pages?|pp?\.)\s*(\d{1,4})\s*(?:-|–|to)\s*(\d{1,4})/i);
  if (pg) add(`Pages ${pg[1]}–${pg[2]}`);
  return out;
}

export function submissionLabel(types = [], exts = []) {
  if (!types?.length) return null;
  const ext = exts?.length ? ` (${exts.map((e) => `.${e}`).join(', ')})` : '';
  if (types.includes('online_quiz')) return 'Take the quiz in Canvas';
  if (types.includes('discussion_topic')) return 'Post in the Canvas discussion';
  if (types.includes('online_upload') && types.includes('online_text_entry')) return `Upload a file${ext} or type it into Canvas`;
  if (types.includes('online_upload')) return `Upload a file in Canvas${ext}`;
  if (types.includes('online_text_entry')) return 'Type or paste your answer into Canvas';
  if (types.includes('online_url')) return 'Submit a link in Canvas';
  if (types.includes('media_recording')) return 'Record and submit in Canvas';
  if (types.includes('on_paper')) return 'Turn it in on paper';
  if (types.includes('external_tool')) return 'Submit through the linked tool';
  if (types.includes('none')) return 'Nothing to submit online';
  return null;
}

// ----------------------------------------------------------------- signals

function signals(text) {
  const n = (re) => { const m = text.match(re); return m ? toNum(m[1]) : null; };
  const ch = text.match(/\bch(?:apters?|s?\.)\s*(\d{1,2})(?:\s*(?:-|–|to|through)\s*(\d{1,2}))?/i);
  const chapters = [];
  if (ch) for (let i = Number(ch[1]); i <= Math.min(Number(ch[2] || ch[1]), Number(ch[1]) + 8); i++) chapters.push(i);
  const reading = /\bread\b/i.test(text);
  return {
    words: n(/(\d{2,5})\s*\+?\s*(?:-|–|to)?\s*(?:\d{2,5})?\s*words?\b/i),
    pages: reading ? null : n(/\b(\d{1,2})(?:\s*[-–]\s*\d{1,2})?[- ]pages?\b/i),
    problems: n(/(\d{1,3})\s*(?:practice\s+)?(?:problems?|questions?|exercises?)\b/i),
    slides: n(/(\d{1,2})\s*slides?\b/i),
    sources: n(/(\d{1,2}|two|three|four|five|six)\s*(?:credible\s+|scholarly\s+|outside\s+|different\s+|reliable\s+)?(?:sources?|references?|citations?)\b/i),
    graphs: n(/(\d|one|two|three|four)\s*graphs?\b/i),
    table: /\bdata tables?\b|\btables?\b/i.test(text),
    citations: /\b(cite|citations?|works cited|bibliography|sources?|references)\b/i.test(text),
    format: (text.match(/\b(MLA|APA|Chicago)\b/) || [])[1] || null,
    showWork: /show (?:all )?(?:of )?(?:your )?work/i.test(text),
    group: /\b(group|partner|team)\b/i.test(text),
    annotate: /\bannotat/i.test(text),
    post: /\b(discussion (?:post|response)|post (?:one|a|your)|respond in the discussion)\b/i.test(text),
    reply: /\brepl(?:y|ies)\b/i.test(text),
    thesis: /\b(thesis|argument)\b/i.test(text),
    section: (text.match(/\bsections?\s*(\d{1,2}(?:\.\d{1,2})+)/i) || [])[1] || null,
    chapters
  };
}

function includeItems(text) {
  const m = text.match(/\b(?:include|including|must have|should have|be sure to (?:include|add)|make sure (?:to include|you include))\b:?\s*([^.\n]{6,320})/i);
  if (!m) return [];
  return m[1]
    .split(/,|;|\band\b|—/)
    .map((s) => s.replace(/^\s*(?:also\s+)?(?:a|an|the|your)\s+/i, '').trim())
    .filter((s) => s.length > 2 && s.length < 70 && !/^(it|this|that)\b/i.test(s))
    .slice(0, 8)
    .map(cap);
}

function topicOf(task) {
  const title = task.title || '';
  const parts = title.split(/\s+[—–-]\s+|:\s+/);
  const scope = /^(ch(?:apters?)?|pages?|sections?|unit|part|week|problems?|first draft|draft|final)\b/i;
  let t = parts.length > 1 ? (scope.test(parts[1].trim()) ? parts[0] : parts.slice(1).join(' ')) : title;
  t = t.replace(/\b(lab report|lab|report|essay|paper|worksheet|problem set|pset|quiz|test|exam|reading|discussion|presentation|project|writeup|write-up|first draft|draft|assignment|homework|hw|vocab(?:ulary)?|research|final|rough)\b/gi, ' ')
    .replace(/\b(?:unit|set|#)?\s*\d+\b/gi, ' ').replace(/\s+/g, ' ').trim();
  if (t.length < 3) return '';
  // Keep proper nouns ("The Great Gatsby"); soften generic ones ("Cell respiration").
  const caps = t.split(' ').filter((w) => /^[A-Z]/.test(w)).length;
  return caps > 1 ? t : t.charAt(0).toLowerCase() + t.slice(1);
}

// ----------------------------------------------------------------- summary

function headlineFor(task, sig, data) {
  const topic = topicOf(task);
  const on = topic ? ` on ${topic}` : '';
  switch (task.category) {
    case 'reading': {
      const what = sig.chapters.length > 1 ? `chapters ${sig.chapters[0]}–${sig.chapters.at(-1)}`
        : sig.chapters.length ? `chapter ${sig.chapters[0]}` : 'the assigned reading';
      return `Read ${what}${topic ? ` of ${topic}` : ''}${sig.annotate ? ', marking up the text as you go' : ''}${sig.post ? ', then share a response with the class' : ''}.`;
    }
    case 'problemset':
      return `Practice ${topic || 'this topic'} by working through ${sig.problems ? `${sig.problems} problems` : 'a set of problems'}${sig.section ? ` from section ${sig.section}` : ''}${sig.showWork ? ', showing every step' : ''}.`;
    case 'essay':
      return `Write ${sig.pages ? `${aOr(sig.pages)} ${sig.pages}-page paper` : sig.words ? `about ${sig.words} words` : 'a piece'}${on}${sig.thesis ? ' that makes a clear argument' : ''}${sig.citations ? ' and backs it up with sources' : ''}.`;
    case 'lab':
      return `Write up your lab${on}: what you tested, what your data shows, and what it means.`;
    case 'quiz':
      return `Get ready for ${topic ? `a quiz on ${topic}` : task.courseName ? `your ${task.courseName} quiz` : 'a quiz'}${data?.quiz?.questions ? ` — ${data.quiz.questions} questions` : ''}${data?.quiz?.timeLimit ? ` in ${data.quiz.timeLimit} minutes` : ''}.`;
    case 'discussion':
      return `Share your thinking${on} in the class discussion${sig.reply ? ', then respond to classmates' : ''}.`;
    case 'presentation':
      return `Build ${sig.slides ? `${aOr(sig.slides)} ${sig.slides}-slide presentation` : 'a presentation'}${on} and practice giving it.`;
    case 'project':
      return `Make real progress on your project${on}${sig.group ? ' with your group' : ''}.`;
    case 'admin':
      return `A quick one — ${task.title.charAt(0).toLowerCase()}${task.title.slice(1)}.`;
    default:
      return `Complete the ${topic ? `${topic} ` : ''}worksheet${sig.problems ? ` (${sig.problems} problems)` : ''}${sig.showWork ? ', showing your work' : ''}.`;
  }
}

function deliverablesFor(task, sig, text, data) {
  const items = [];
  const add = (t, kind = 'req') => {
    if (t && !items.some((i) => i.text.toLowerCase() === t.toLowerCase())) items.push({ text: t, kind });
  };
  const inc = includeItems(text);
  inc.forEach((x) => add(x, 'include'));
  const mentioned = (re) => inc.some((x) => re.test(x));

  if (sig.words && !mentioned(/word/i)) add(`About ${sig.words} words`);
  if (sig.pages && !mentioned(/page/i)) add(`${sig.pages} pages`);
  if (sig.problems && !['quiz'].includes(task.category)) add(`All ${sig.problems} ${/questions/i.test(text) ? 'questions' : 'problems'}`);
  if (sig.slides && !mentioned(/slide/i)) add(`${sig.slides} slides`);
  if (sig.sources && !mentioned(/source/i)) add(`At least ${sig.sources} sources${sig.format ? `, cited in ${sig.format}` : ''}`);
  else if (sig.citations && !mentioned(/source|cit/i) && task.category !== 'reading') add(`Cite your sources${sig.format ? ` in ${sig.format}` : ''}`);
  if (sig.format && !items.some((i) => i.text.includes(sig.format))) add(`${sig.format} format`);
  if (/works cited/i.test(text) && !items.some((i) => /works cited/i.test(i.text))) add('A works cited page');
  if (/double[- ]spaced/i.test(text)) add('Double-spaced');
  if (sig.showWork) add('Show all your work');
  if (task.category === 'reading' && sig.post) add('One discussion post');
  if (sig.reply) add('Replies to classmates');
  if (sig.group) add('Done with your group or partner');

  const sub = submissionLabel(data?.submission?.types, data?.submission?.exts);
  if (sub) add(sub, 'submit');
  if (data?.quiz) {
    const q = data.quiz;
    const bits = [q.questions && `${q.questions} questions`, q.timeLimit && `${q.timeLimit}-minute time limit`,
      q.attempts && (q.attempts === 1 ? 'one attempt' : `${q.attempts} attempts`)].filter(Boolean);
    if (bits.length) add(cap(bits.join(' · ')), 'submit');
  }
  return items.slice(0, 10);
}

// ------------------------------------------------------------------- steps

function stepsFor(task, sig, hasRubric) {
  const S = [];
  const p = (title, weight, detail = '') => S.push({ title, weight, detail });
  switch (task.category) {
    case 'reading':
      if (sig.chapters.length > 1) sig.chapters.forEach((c) => p(`Read chapter ${c}${sig.annotate ? ' and annotate' : ''}`, 3));
      else { p('Skim the headings and any questions first', 1, 'So you know what to look for'); p(sig.annotate ? 'Read closely and annotate' : 'Read and take notes', 6); }
      if (sig.post) p('Write your discussion response', 2, 'Answer the prompt with a quote or two as evidence');
      else p('Write a 3-sentence summary from memory', 1, 'The fastest way to lock in what you read');
      break;
    case 'problemset': {
      p(`Review notes and worked examples${sig.section ? ` for section ${sig.section}` : ''}`, 2, 'Find one example that matches each type of problem');
      if (sig.problems && sig.problems > 8) {
        const chunks = Math.ceil(sig.problems / 7);
        const size = Math.ceil(sig.problems / chunks);
        for (let i = 0; i < chunks; i++) {
          const a = i * size + 1, b = Math.min(sig.problems, (i + 1) * size);
          p(`Problems ${a}–${b}`, (b - a + 1) * 0.6, i === 0 ? 'Start with the ones that look most like the examples' : '');
        }
      } else p(sig.problems ? `Work all ${sig.problems} problems` : 'Work through the problems', 8);
      p(sig.showWork ? 'Check answers and make sure your work is shown' : 'Check your answers', 1);
      break;
    }
    case 'essay':
      p(`Re-read the prompt${hasRubric ? ' and rubric' : ''}`, 0.6, 'Underline exactly what it asks you to do');
      p(sig.sources ? `Find ${sig.sources} sources and pull quotes` : sig.citations ? 'Find sources and pull quotes' : 'Brainstorm and gather evidence', 2);
      p(sig.thesis ? 'Write your thesis and outline' : 'Outline your main points', 1.4, 'One sentence per paragraph is enough');
      p(`Write the draft${sig.words ? ` (~${sig.words} words)` : sig.pages ? ` (${sig.pages} pages)` : ''}`, 4.5, "Don't edit while drafting — get it all down first");
      p(sig.citations ? 'Revise and add citations' : 'Revise', 1.5);
      p('Proofread and submit', 0.5);
      break;
    case 'lab':
      p('Organize your data and observations', 1.2);
      if (sig.table || sig.graphs) {
        const bits = [sig.table && 'data table', sig.graphs && (sig.graphs > 1 ? `${sig.graphs} graphs` : 'graph')].filter(Boolean);
        p(`Make the ${bits.join(' and ')}`, 1.8, 'Label axes and include units');
      }
      p('Write the hypothesis and procedure', 1.5);
      p(`Write the discussion${sig.words ? ` (~${sig.words} words)` : ''}`, 3, 'What your results show, and why');
      if (sig.citations) p(sig.sources ? `Cite your ${sig.sources} sources${sig.format ? ` (${sig.format})` : ''}` : 'Add citations', 1);
      p('Proofread and submit', 0.5);
      break;
    case 'quiz':
      p('Gather your notes and study materials', 1);
      p('Quiz yourself with flashcards', 4, 'Say the answer out loud before you flip');
      p('Do practice questions', 3);
      p('Review what you got wrong', 2);
      break;
    case 'discussion':
      p('Read the prompt and any linked material', 3);
      p('Write your post', 5, 'Make one clear point and support it');
      if (sig.reply) p('Reply to classmates', 2);
      break;
    case 'presentation':
      p('Outline your key points', 1.5);
      p(`Build the slides${sig.slides ? ` (${sig.slides})` : ''}`, 4.5, 'Fewer words per slide than you think');
      p('Rehearse out loud', 3);
      p('Final polish', 1);
      break;
    case 'project':
      p('Break it into pieces and plan', 1.5);
      p('Build the main part', 5.5);
      p('Test it or get feedback', 1.5);
      p('Finish and submit', 1.5);
      break;
    case 'admin':
      p(cap(task.title), 1);
      break;
    default:
      p('Look over your notes on this topic', 2);
      p(sig.problems ? `Complete all ${sig.problems} problems` : 'Complete the worksheet', 7);
      p('Check it over and turn it in', 1);
  }
  return S;
}

/** Spread `total` minutes across weighted steps, in 5-minute units, summing exactly. */
export function fitSteps(steps, total) {
  const list = steps.filter((s) => s.title);
  if (!list.length) return [];
  total = Math.max(5, Math.round(total / 5) * 5);
  const sum = list.reduce((a, s) => a + (s.weight ?? s.minutes ?? 1), 0) || 1;
  let out = list.map((s) => ({
    title: s.title,
    detail: s.detail || '',
    minutes: Math.max(5, Math.round(((s.weight ?? s.minutes ?? 1) / sum) * total / 5) * 5)
  }));
  // Very short tasks: don't pretend a 15-minute task has six 5-minute steps.
  while (out.length > 1 && out.length * 5 > total) {
    const i = out.reduce((m, s, k) => (s.minutes < out[m].minutes ? k : m), 0);
    const j = i === out.length - 1 ? i - 1 : i + 1;
    out[j].minutes += out[i].minutes;
    out.splice(i, 1);
  }
  let diff = total - out.reduce((a, s) => a + s.minutes, 0);
  const order = [...out.keys()].sort((a, b) => out[b].minutes - out[a].minutes);
  for (let k = 0; diff !== 0 && k < 200; k++) {
    const i = order[k % order.length];
    const step = diff > 0 ? 5 : -5;
    if (out[i].minutes + step >= 5) { out[i].minutes += step; diff -= step; }
  }
  return out;
}

/**
 * Which steps a given work block covers, based on the blocks before it. A step
 * only counts if the block spends real time on it (10+ minutes, or half the
 * step), so a block that brushes the start of the next step doesn't claim it.
 */
export function stepsForSession(steps, sessions, session) {
  if (!steps?.length || !session) return [];
  const mine = sessions.filter((s) => s.taskId === session.taskId).sort((a, b) => new Date(a.start) - new Date(b.start));
  let from = 0;
  for (const s of mine) { if (s.id === session.id) break; from += s.minutes; }
  const to = from + session.minutes;
  let acc = 0, best = null, bestOverlap = 0;
  const covered = [];
  for (const st of steps) {
    const a = acc, b = acc + st.minutes;
    acc = b;
    const overlap = Math.max(0, Math.min(b, to) - Math.max(a, from));
    if (overlap > bestOverlap) { best = st; bestOverlap = overlap; }
    if (overlap >= Math.min(10, st.minutes * 0.5)) covered.push(st);
  }
  if (covered.length) return covered;
  return best ? [best] : [steps.at(-1)];
}

export function describeSteps(covered) {
  if (!covered.length) return '';
  const lower = (t) => t.charAt(0).toLowerCase() + t.slice(1);
  if (covered.length === 1) return covered[0].title;
  if (covered.length === 2) return `${covered[0].title}, then ${lower(covered[1].title)}`;
  return `${covered[0].title}, ${lower(covered[1].title)}, then ${lower(covered.at(-1).title)}`;
}

// -------------------------------------------------------------------- main

/**
 * @param {object} task
 * @param {object} data from canvas.fetchGuideData (or mock): description,
 *   rubric, submission, quiz, module, attachments, related
 */
export function buildGuide(task, data = {}, { origin = '' } = {}) {
  const html = data.description || task.description || '';
  const text = plainText(html);
  const full = `${task.title || ''}\n${text}`;
  const t = { ...task, category: task.category || classify({ ...task, description: text }) };
  const sig = signals(full);

  const materials = [];
  const push = (m) => {
    const key = (m.url || m.title).toLowerCase();
    const titleKey = m.title.toLowerCase();
    if (materials.some((x) => (x.url || x.title).toLowerCase() === key || x.title.toLowerCase() === titleKey)) return;
    materials.push({ id: m.id || idOf(key), ...m });
  };
  (data.attachments || []).forEach((f) => push({ title: f.title, url: f.url, type: materialType(f.title, f.url, 'file'), source: 'Attached to the assignment' }));
  extractLinks(html, origin).forEach(push);
  (data.module?.items || []).forEach((it) => push({
    title: it.title, url: it.url || null,
    type: materialType(it.title, it.external || it.url || '', it.kind),
    source: `In your “${data.module.name}” module`
  }));
  (data.related || []).forEach((r) => push({ title: r.title, url: r.url, type: materialType(r.title, r.url, r.kind), source: 'Found in your course' }));
  textbookRefs(full).forEach(push);

  return {
    category: t.category,
    headline: headlineFor(t, sig, data),
    teacherSays: firstSentences(text),
    deliverables: deliverablesFor(t, sig, text, data),
    steps: fitSteps(stepsFor(t, sig, !!data.rubric?.length), task.estimateMin || 30),
    materials: materials.slice(0, 14),
    rubric: data.rubric || [],
    instructions: text,
    quiz: data.quiz || null,
    moduleName: data.module?.name || null
  };
}
