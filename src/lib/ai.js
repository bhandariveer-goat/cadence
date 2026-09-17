// Cadence Intelligence — the optional Claude layer.
//
// Everything in Cadence works without this file: estimator.js, priority.js,
// guide.js and parse.js carry the whole product offline. With an access key,
// these calls sharpen four things:
//   1. effort estimates that come from actually reading the prompt
//   2. assignment guides in plain language, with steps and the right materials
//   3. messy teacher dictation -> clean assignment fields
//   4. a short, specific note about the week
//
// Raw fetch rather than the Anthropic SDK on purpose: this is a no-build-step
// browser extension, so there's no bundler to pull the SDK through. Direct
// browser calls need the dangerous-direct-browser-access header, and the key
// lives only in the user's own extension storage.
//
// Schemas avoid numeric/length/size keywords (minimum, maxLength, maxItems),
// which structured outputs doesn't accept; limits are stated in descriptions
// and enforced after parsing instead.

const API = 'https://api.anthropic.com/v1/messages';
export const DEFAULT_MODEL = 'claude-opus-5';

const CATEGORY_ENUM = ['reading', 'problemset', 'essay', 'lab', 'project', 'quiz', 'discussion', 'presentation', 'worksheet', 'admin'];
const clampInt = (v, lo, hi, fallback) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : fallback);
const str = (v, max) => String(v ?? '').trim().slice(0, max);

export function aiAvailable(settings) {
  return !!(settings?.useAI && settings?.apiKey);
}

async function callClaude(settings, { system, user, schema, maxTokens = 2048, effort = 'low' }) {
  const body = {
    model: settings.model || DEFAULT_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { effort, ...(schema ? { format: { type: 'json_schema', schema } } : {}) }
  };

  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(body)
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message || `Claude API error ${res.status}`);
  if (data.stop_reason === 'refusal') throw new Error('Request was declined.');

  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (!schema) return text;
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Could not read a structured answer.');
  }
}

// ------------------------------------------------------------- estimates

const ESTIMATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'minutes', 'category', 'reason', 'steps'],
        properties: {
          id: { type: 'string' },
          minutes: { type: 'integer', description: 'Realistic total minutes, between 5 and 600' },
          category: { type: 'string', enum: CATEGORY_ENUM },
          reason: { type: 'string', description: 'One short sentence on what drives the time' },
          steps: { type: 'array', description: 'For work over 90 minutes, 2-5 short ordered steps; otherwise empty', items: { type: 'string' } }
        }
      }
    }
  }
};

export async function refineEstimates(settings, tasks, history = {}) {
  if (!aiAvailable(settings) || !tasks.length) return {};
  const payload = tasks.slice(0, 25).map((t) => ({
    id: t.id,
    course: t.courseName,
    title: t.title,
    points: t.points,
    heuristicMinutes: t.estimateMin,
    prompt: (t.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 900)
  }));

  const system = [
    'You estimate how long high school assignments take a specific student.',
    'Be realistic, not optimistic: include reading the prompt, gathering materials, and revising.',
    'A heuristic estimate is provided; only move it when the assignment text justifies it.',
    history.notes ? `What we know about this student: ${history.notes}` : ''
  ].filter(Boolean).join(' ');

  const out = await callClaude(settings, { system, user: JSON.stringify({ assignments: payload }), schema: ESTIMATE_SCHEMA, maxTokens: 4000, effort: 'medium' });
  const byId = {};
  for (const item of out.items || []) {
    byId[item.id] = {
      minutes: clampInt(item.minutes, 5, 600, 30),
      category: CATEGORY_ENUM.includes(item.category) ? item.category : null,
      reason: str(item.reason, 160),
      steps: (item.steps || []).slice(0, 6).map((s) => str(s, 90))
    };
  }
  return byId;
}

// ---------------------------------------------------------------- guides

const GUIDE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'deliverables', 'steps', 'keyIdeas', 'materials', 'watchOut'],
  properties: {
    summary: { type: 'string', description: 'Two short sentences in plain language, speaking to the student: what they are doing and why it matters.' },
    deliverables: { type: 'array', description: 'Up to 8 concrete things to include or turn in, each a short phrase taken from the instructions', items: { type: 'string' } },
    steps: {
      type: 'array',
      description: '3 to 7 ordered steps whose minutes add up to the target total',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'minutes', 'how'],
        properties: {
          title: { type: 'string', description: 'Short action, e.g. "Draft the discussion section"' },
          minutes: { type: 'integer' },
          how: { type: 'string', description: 'One sentence on how to do this step well, pointing to a specific material when useful' }
        }
      }
    },
    keyIdeas: { type: 'array', description: 'Up to 6 terms or concepts the student needs to understand for this', items: { type: 'string' } },
    materials: {
      type: 'array',
      description: 'The most useful items from the provided materials list, most important first, referenced by id',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'why'],
        properties: { id: { type: 'string' }, why: { type: 'string', description: 'Under 12 words: what to use it for' } }
      }
    },
    watchOut: { type: 'string', description: 'The most common way students lose points here, or what to ask the teacher if the instructions are unclear. Empty string if nothing stands out.' }
  }
};

/**
 * @param {{title, course, due, points, instructions, rubric, materials, estimateMin, notes}} input
 */
export async function guideAssignment(settings, input) {
  if (!aiAvailable(settings)) return null;
  const ids = new Set((input.materials || []).map((m) => m.id));
  const system = [
    'You help a high school student understand an assignment and get started on it.',
    'Write at about a 9th-grade reading level: warm, direct, no jargon unless you explain it.',
    'Only state requirements that are actually in the instructions or rubric — never invent any.',
    `The student already has ${input.estimateMin} minutes scheduled for this, so the step minutes must add up to about that.`,
    'Only reference material ids that appear in the provided list.',
    input.notes ? `What we know about how this student works: ${input.notes}` : ''
  ].filter(Boolean).join(' ');

  const out = await callClaude(settings, {
    system,
    user: JSON.stringify({ ...input, instructions: String(input.instructions || '').slice(0, 5000) }),
    schema: GUIDE_SCHEMA,
    maxTokens: 4000,
    effort: 'medium'
  });

  return {
    summary: str(out.summary, 400),
    deliverables: (out.deliverables || []).map((d) => str(d, 90)).filter(Boolean).slice(0, 8),
    steps: (out.steps || []).slice(0, 7).map((s) => ({ title: str(s.title, 80), minutes: clampInt(s.minutes, 5, 300, 15), how: str(s.how, 180) })).filter((s) => s.title),
    keyIdeas: (out.keyIdeas || []).map((k) => str(k, 40)).filter(Boolean).slice(0, 6),
    materials: (out.materials || []).filter((m) => ids.has(m.id)).slice(0, 6).map((m) => ({ id: m.id, why: str(m.why, 90) })),
    watchOut: str(out.watchOut, 240)
  };
}

// ------------------------------------------------------------- dictation

const PARSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'courseName', 'description', 'dueISO', 'points', 'estimateMin', 'category'],
  properties: {
    title: { type: 'string' },
    courseName: { type: 'string', description: 'Empty string if not mentioned' },
    description: { type: 'string', description: 'Clear student-facing instructions, a few sentences' },
    dueISO: { type: 'string', description: 'ISO 8601 local datetime, or empty string if not stated' },
    points: { type: 'number', description: '-1 if not stated' },
    estimateMin: { type: 'integer', description: '-1 if not stated' },
    category: { type: 'string', enum: CATEGORY_ENUM }
  }
};

export async function parseDictation(settings, transcript, { courses = [], now = new Date() } = {}) {
  if (!aiAvailable(settings)) return null;
  const system = [
    "Convert a teacher's spoken assignment into structured fields.",
    `Today is ${now.toDateString()} (${now.toISOString()}).`,
    'Resolve relative dates like "next Friday" to a real datetime; if no time is given, use 23:59 local.',
    courses.length ? `Known courses: ${courses.map((c) => c.name).join('; ')}. Match one if it fits.` : '',
    'Write clear, student-facing instructions. Do not invent requirements.'
  ].filter(Boolean).join(' ');

  const out = await callClaude(settings, { system, user: transcript, schema: PARSE_SCHEMA, maxTokens: 1500, effort: 'low' });
  return {
    title: str(out.title, 120),
    courseName: str(out.courseName, 80),
    description: str(out.description, 1200),
    dueISO: str(out.dueISO, 40),
    points: Number(out.points) >= 0 ? Number(out.points) : null,
    estimateMin: Number(out.estimateMin) > 0 ? clampInt(out.estimateMin, 5, 600, null) : null,
    category: CATEGORY_ENUM.includes(out.category) ? out.category : null
  };
}

// ----------------------------------------------------------------- coach

export async function reviewPlan(settings, summary) {
  if (!aiAvailable(settings)) return null;
  return callClaude(settings, {
    system: 'You are a calm, concrete academic coach for a high school student. '
      + 'Two sentences at most. Name the specific thing to focus on next and why. No pep-talk filler.',
    user: JSON.stringify(summary),
    maxTokens: 400,
    effort: 'low'
  });
}
