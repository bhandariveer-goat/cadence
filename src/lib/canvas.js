// Canvas LMS REST client.
//
// All requests go out through a pluggable transport. Inside a Canvas tab the
// panel proxies through the content script, so requests are same-origin and
// carry the student's existing session + CSRF token — no API token, no OAuth
// app to register with the school's IT department.

import { classify } from './estimator.js';
import { DAY } from './util.js';
import { isStale } from './priority.js';

let transport = null;

/** @param {(req:{path:string,method?:string,body?:any}) => Promise<{ok:boolean,status:number,data:any,link?:string}>} fn */
export function setTransport(fn) { transport = fn; }

async function api(path, opts = {}) {
  if (!transport) throw new Error('No Canvas connection. Open Cadence from a Canvas tab.');
  const res = await transport({ path, method: opts.method || 'GET', body: opts.body });
  if (!res.ok) {
    const msg = res.data?.errors?.[0]?.message || res.data?.message || `Canvas returned ${res.status}`;
    throw new Error(msg);
  }
  return res;
}

async function apiAll(path, { max = 4 } = {}) {
  let out = [];
  let next = path;
  for (let i = 0; i < max && next; i++) {
    const res = await api(next);
    out = out.concat(Array.isArray(res.data) ? res.data : []);
    const m = (res.link || '').match(/<([^>]+)>;\s*rel="next"/);
    next = m ? m[1] : null;
  }
  return out;
}

export async function whoAmI() {
  const res = await api('/api/v1/users/self');
  return res.data;
}

export async function listCourses() {
  const raw = await apiAll('/api/v1/courses?enrollment_state=active&per_page=50&include[]=term');
  return raw
    .filter((c) => c && c.id && !c.access_restricted_by_date)
    .map((c) => ({
      id: String(c.id),
      name: c.name || c.course_code || `Course ${c.id}`,
      code: c.course_code || '',
      // enrollments[].type tells us whether she's a student or teaching it
      role: c.enrollments?.[0]?.type || 'student'
    }));
}

/**
 * Planner items are the closest thing Canvas has to "everything on my plate":
 * assignments, quizzes, discussions, and calendar events in one feed.
 */
export async function fetchPlannerItems({ daysBack = 3, daysAhead = 30 } = {}) {
  const start = new Date(Date.now() - daysBack * DAY).toISOString();
  const end = new Date(Date.now() + daysAhead * DAY).toISOString();
  return apiAll(`/api/v1/planner/items?start_date=${start}&end_date=${end}&per_page=50`);
}

export async function fetchCourseAssignments(courseId) {
  return apiAll(`/api/v1/courses/${courseId}/assignments?per_page=50&order_by=due_at&include[]=submission`);
}

const TYPE_MAP = {
  assignment: 'assignment',
  quiz: 'quiz',
  discussion_topic: 'discussion_topic',
  wiki_page: 'page',
  calendar_event: 'event',
  planner_note: 'note'
};

/** Normalize a planner item into Cadence's task shape. */
export function taskFromPlannerItem(item, courseNameById = {}) {
  const p = item.plannable || {};
  const type = TYPE_MAP[item.plannable_type] || 'assignment';
  if (type === 'event' || type === 'page') return null;

  const due = p.due_at || p.todo_date || item.plannable_date || null;
  const override = item.planner_override || {};
  if (override.dismissed) return null;
  const submitted = !!(override.marked_complete
    || (item.submissions && (item.submissions.submitted || item.submissions.graded || item.submissions.excused)));
  const courseId = item.course_id ? String(item.course_id) : null;
  const title = p.title || p.name || 'Untitled assignment';

  if (!submitted && isStale({ due })) return null;

  const task = {
    id: `canvas_${item.plannable_type}_${p.id || item.plannable_id}`,
    source: 'canvas',
    canvasType: type,
    canvasId: String(p.id || item.plannable_id || ''),
    courseId,
    courseName: courseNameById[courseId] || item.context_name || '',
    title,
    description: p.message || p.description || '',
    due,
    points: p.points_possible ?? null,
    url: item.html_url || null,
    status: submitted ? 'done' : 'todo',
    completedAt: submitted ? (item.submissions?.submitted_at || null) : null
  };
  task.category = classify(task);
  return task;
}

/**
 * Course sweep. Returns null for anything that shouldn't be on a student's
 * plate: ungraded/no-submission placeholders, locked items, and work more than
 * a month past due (at that point it almost never still needs turning in).
 */
export function taskFromAssignment(a, course) {
  const types = a.submission_types || [];
  if (types.includes('not_graded')) return null;
  if (types.includes('none') && !a.points_possible) return null;
  if (a.locked_for_user && !a.unlock_at) return null;

  const sub = a.submission || {};
  const submitted = !!(sub.submitted_at || sub.workflow_state === 'graded' || sub.excused);
  if (isStale({ due: a.due_at })) return null;
  if (!a.due_at && submitted) return null;
  const task = {
    id: `canvas_assignment_${a.id}`,
    source: 'canvas',
    canvasType: a.is_quiz_assignment ? 'quiz' : 'assignment',
    canvasId: String(a.id),
    courseId: course ? String(course.id) : (a.course_id ? String(a.course_id) : null),
    courseName: course?.name || '',
    title: a.name || 'Untitled assignment',
    description: a.description || '',
    due: a.due_at || null,
    points: a.points_possible ?? null,
    url: a.html_url || null,
    status: submitted ? 'done' : 'todo'
  };
  task.category = classify(task);
  return task;
}

/** Teacher side: publish a drafted assignment back to Canvas. */
export async function createAssignment(courseId, draft) {
  const body = {
    assignment: {
      name: draft.title,
      description: draft.description || '',
      points_possible: draft.points ?? null,
      due_at: draft.due || null,
      submission_types: draft.submissionTypes || ['online_text_entry', 'online_upload'],
      published: !!draft.publish
    }
  };
  const res = await api(`/api/v1/courses/${courseId}/assignments`, { method: 'POST', body });
  return res.data;
}

// ------------------------------------------------------------ guide data

const MODULE_KIND = { File: 'file', Page: 'page', Discussion: 'discussion', Quiz: 'quiz', Assignment: 'assignment', ExternalUrl: 'link', ExternalTool: 'link' };
const GENERIC = new Set(['assignment', 'homework', 'worksheet', 'quiz', 'test', 'reading', 'essay', 'paper', 'draft', 'first', 'final', 'report', 'problem', 'problems', 'set', 'unit', 'chapter', 'chapters', 'discussion', 'project', 'with', 'from', 'your', 'the', 'and', 'for']);

const mapRubric = (r) => (r || []).map((c) => ({ title: c.description || 'Criterion', detail: c.long_description || '', points: c.points ?? null }));

/**
 * Everything needed to explain an assignment: full instructions, rubric, how
 * it's submitted, quiz details, and the module it sits in (whose neighbours
 * are almost always the readings, slides and videos it depends on).
 * Each lookup fails soft — a guide with less is better than no guide.
 */
export async function fetchGuideData(task) {
  const cid = task.courseId, id = task.canvasId;
  const out = { description: task.description || '', rubric: [], submission: null, quiz: null, module: null, attachments: [], related: [] };
  if (!cid || !id) return out;

  let assetType = 'Assignment';
  try {
    if (task.canvasType === 'quiz') {
      const q = (await api(`/api/v1/courses/${cid}/quizzes/${id}`)).data || {};
      out.description = q.description || out.description;
      out.quiz = { questions: q.question_count || null, timeLimit: q.time_limit || null, attempts: q.allowed_attempts > 0 ? q.allowed_attempts : null };
      out.submission = { types: ['online_quiz'], exts: [] };
      assetType = 'Quiz';
      if (q.assignment_id) {
        try { out.rubric = mapRubric((await api(`/api/v1/courses/${cid}/assignments/${q.assignment_id}`)).data?.rubric); } catch { /* no rubric */ }
      }
    } else if (task.canvasType === 'discussion_topic') {
      const d = (await api(`/api/v1/courses/${cid}/discussion_topics/${id}`)).data || {};
      out.description = d.message || out.description;
      out.attachments = (d.attachments || []).map((f) => ({ title: f.display_name, url: f.url }));
      out.submission = { types: ['discussion_topic'], exts: [] };
      out.rubric = mapRubric(d.assignment?.rubric);
      assetType = 'Discussion';
    } else {
      const a = (await api(`/api/v1/courses/${cid}/assignments/${id}`)).data || {};
      out.description = a.description || out.description;
      out.rubric = mapRubric(a.rubric);
      out.submission = { types: a.submission_types || [], exts: a.allowed_extensions || [] };
    }
  } catch { /* keep whatever we already had */ }

  try {
    const seq = (await api(`/api/v1/courses/${cid}/module_item_sequence?asset_type=${assetType}&asset_id=${id}`)).data;
    const current = seq?.items?.[0]?.current;
    if (current?.module_id) {
      const mod = (seq.modules || []).find((m) => String(m.id) === String(current.module_id));
      const items = await apiAll(`/api/v1/courses/${cid}/modules/${current.module_id}/items?per_page=50`, { max: 2 });
      out.module = {
        name: mod?.name || 'this unit',
        items: items
          .filter((it) => String(it.id) !== String(current.id) && it.type !== 'SubHeader')
          .map((it) => ({ title: it.title, url: it.html_url || null, external: it.external_url || '', kind: MODULE_KIND[it.type] || 'link' }))
          .slice(0, 12)
      };
    }
  } catch { /* course may not use modules */ }

  // No module context? Search the course for the assignment's key words.
  if (!out.module?.items?.length) {
    const term = (task.title || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
      .filter((w) => w.length >= 4 && !GENERIC.has(w)).sort((a, b) => b.length - a.length)[0];
    if (term) {
      try {
        const pages = (await api(`/api/v1/courses/${cid}/pages?search_term=${encodeURIComponent(term)}&per_page=4`)).data || [];
        pages.forEach((p) => out.related.push({ title: p.title, url: p.html_url || `/courses/${cid}/pages/${p.url}`, kind: 'page' }));
      } catch { /* pages may be disabled */ }
      try {
        const files = (await api(`/api/v1/courses/${cid}/files?search_term=${encodeURIComponent(term)}&per_page=4`)).data || [];
        files.forEach((f) => out.related.push({ title: f.display_name, url: `/courses/${cid}/files/${f.id}`, kind: 'file' }));
      } catch { /* files may be hidden from students */ }
    }
  }
  return out;
}
