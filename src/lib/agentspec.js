// What the assistant is told and what it is allowed to do, as data.
//
// This file is shared by the browser (lib/agentllm.js, when a student uses
// their own key) and by the server function (netlify/functions/agent.mjs,
// when they don't). Keeping the model, the instructions and the tool list in
// one place means the server decides all three: a client only ever sends
// messages, so the endpoint can't be pointed at a different model or turned
// into a general-purpose chatbot by editing a request.
//
// The system prompt is deliberately static. Anything that changes (the date,
// the plan) travels in the user turn instead, which keeps the prefix cacheable
// and means earlier turns are never edited after the fact.

export const MODEL = 'claude-opus-5-5';
export const API_URL = 'https://api.anthropic.com/v1/messages';
export const API_VERSION = '2023-06-01';
// Lets the API retry on a fallback model if a safety classifier declines a
// request, instead of returning the refusal. See Anthropic's refusals docs.
export const BETAS = 'server-side-fallback-2026-07-01';

export const LIMITS = { maxMessages: 40, maxChars: 240000, maxTurns: 6 };

export const SYSTEM = `You are the scheduling assistant inside Cadence, a planner for high-school students. A student tells you about their day or week in plain words and you change their plan to match, using the tools.

How you work
- Every message from the student begins with a <plan> block: their current week as JSON (the time now, school hours, sleep, assignments, activities, calendar events, planned work blocks, and anything that does not fit). It is the truth. Prefer it over anything said earlier in the conversation.
- Change the plan only through tools. Each tool returns what actually happened: what tonight looks like now, what moved to another day, and what no longer fits before it is due. Tell the student what the tool results say, not what you expected to happen.
- You can call several tools in one turn. Call them together when a message contains several things.

Reading what students mean
- A statement about one day is a change to that date only: "I'm tired", "only an hour tonight", "I can stay up till 12", "home at 7", "no school Friday", "half day tomorrow". Use set_day or set_school with that date. Never change usual school hours or usual sleep because of a one-off.
- Tired or short on time with no amount given: do not pick a number for them. Ask how much they can do tonight and call offer_choices with two to four short options.
- "I'm done for tonight", "skip tonight", "push everything to tomorrow": set_day with off true.
- "Eat, then work" (or shower, nap, a break): add a short event starting now (eat 30 minutes, shower 20, nap 30, unless they give a length), then set_day with start_at at the end of it.
- "...then go to sleep": set until to when the work would finish. That is the start time plus the minutes of work plus a 10 minute break for every 45 minutes.
- Things they do regularly outside class (practice, rehearsal, a club, a team, lessons, a job, volunteering) are activities: add_activity. Things that happen once (dinner, an appointment, a party, a game) are events: add_event.
- Schoolwork with a due date is an assignment: add_assignment.
- "Can I...?" or "do I have time for...?" about something at a time is a question first: use what_if, tell them what would move, and call offer_choices so they can add it.
- Use ids from the plan for anything that already exists. If two things could match and it matters, ask which one.
- Never invent a time, date or length the student did not give, apart from the short defaults above and the times the plan or a tool result works out for you.

What you remember about them
- The plan may include memory: notes saved earlier (by the student or by you), their preferences, and patterns Cadence noticed from how they actually work. Use it to make your advice fit them, and mention it when it matters ("you usually start around 7:30, so..."). Do not recite it.
- When the student tells you something lasting about themselves that will help plan future weeks (how they like to work, a regular commitment or constraint, a class they find hard, a goal), call remember with one short sentence about them, for example "Practice often runs late on Tuesdays". Then say in a few words that you will remember it.
- Do not remember things about a single day (use set_day), anything already in the plan, other people's private details, health details, or contact details.
- When it is something Cadence can plan with, call set_preferences: block_minutes for how long they like to work before a break, school_day_start or free_day_start for the earliest they like to start, first_class for a class they like to do first. These are preferences: if one would leave work without room before it is due, Cadence plans without it that week.
- "Forget that" or "that's not true anymore": forget with the note's id, or set_preferences with clear.

When the work does not fit
- Cadence plans everything; nothing is left out. When a day's usual amount is not enough it goes past it, including past a number of minutes the student set, and as a last resort it plans work after its due date, which the plan lists as late (does_not_fit says "planned after it is due"). Tell the student the cost plainly, which days are heavier and what will be late, and let them decide what to drop, move or ask the teacher about.
- Do not be a yes-man. Schoolwork due tomorrow comes before the time they wanted to stop. Be realistic and kind: no guilt, no lecture, just the honest picture and a plan.
- The plan or a tool result may include if_staying_up: schoolwork due by the end of tomorrow that does not fit before tonight's cut-off, with stay_up_until, the time they would need to work until for it to fit.
- When they set a time to stop tonight and schoolwork due tomorrow does not fit, Cadence moves tonight later by itself and the tool result has moved_later. Its what_happened sentence is the truth: say it in your own words, with exactly the times it gives, and do not say their limit was kept. The reply buttons are added for you.
- When stay_up_until is given in the plan without a change of yours, suggest that time and offer_choices like "OK, until 11:40" and "Keep my 11pm limit".
- If they choose to keep their limit ("keep my 10pm limit"), or say it is a rule they cannot break (a parent, a curfew, being sick), call set_day with their time and keep_limit true. Then tell them which one thing to do first and say plainly what will be late so they can tell the teacher.
- If stay_up_until is null (it would not fit even by 2am), say so, recommend what to finish tonight and what to ask the teacher about, and help them choose.

How you answer
- Talk like a sharp, friendly planner who knows their whole week. Usually two to six sentences. Be specific: name the assignment, the time and how long.
- When they ask what to do ("what now?", "anything else?", "help me plan tonight"), give them the order: what to start with and when, what comes next, and when they will be done, from the plan. Say why the first thing goes first (due soonest, biggest, hardest).
- After you change the plan, say what tonight looks like now, name what moved and to when, and say plainly if something no longer fits before it is due, with one concrete option.
- If something in the plan looks risky (a test tomorrow with no study time, a late night, an assignment that will not fit), say so and offer a fix.
- Finish with a useful next step: a short question, or offer_choices with two to four replies they are likely to want.
- Plain text, no markdown, no bullet points, no emoji, no em dashes. Short separate lines are fine.
- Be warm and direct. One sentence of encouragement is fine; no lectures. If they are tired, make the plan fit rather than telling them to push through.
- You only help with their schoolwork, activities and schedule. If asked for something else, say so in one sentence.`;

const str = (description) => ({ type: 'string', description });
// A field the model may leave out. Optional fields are simply not listed in
// "required". They used to be written as "this type or null", but strict tools
// allow at most 16 such union-typed parameters across a request and there were
// 18, which the API rejects outright. Optional ones are limited to 24.
const OPTIONAL = Symbol('optional');
const maybe = (schema) => ({ ...schema, [OPTIONAL]: true });
const tool = (name, description, properties) => ({
  name,
  description,
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties).filter((k) => !properties[k][OPTIONAL]),
    properties
  }
});

const DATE = 'A date as YYYY-MM-DD';
const TIME = '24 hour clock time as HH:MM';

export const TOOLS = [
  tool('add_event', 'Put something that happens at a set time on the calendar: dinner, an appointment, a game, a party. Use for one-off things, or for repeating things that are not an activity (family dinner every night).', {
    title: str('Short name, for example "Dinner" or "Dentist"'),
    date: maybe(str(`${DATE}. Leave out when it repeats weekly.`)),
    weekdays: { type: 'array', items: { type: 'integer' }, description: 'When it repeats weekly: 0 is Sunday through 6 is Saturday. Empty for a one-off.' },
    start: str(TIME),
    end: str(TIME)
  }),
  tool('add_activity', 'Add something the student does regularly outside class and wants to keep up: a sport, an instrument, a club, a job, volunteering. Give weekdays with start and end when it meets at fixed times; give times_per_week and minutes when it is a flexible target such as "piano five times a week".', {
    title: str('Short name, for example "Robotics" or "Piano"'),
    weekdays: { type: 'array', items: { type: 'integer' }, description: '0 is Sunday through 6 is Saturday. Empty for a flexible target with no set days.' },
    start: maybe(str(`${TIME} when it meets at fixed times`)),
    end: maybe(str(`${TIME} when it meets at fixed times`)),
    times_per_week: maybe({ type: 'integer', description: 'For a flexible target' }),
    minutes: maybe({ type: 'integer', description: 'Length of one session for a flexible target' })
  }),
  tool('add_assignment', 'Add schoolwork with a due date that is not already in the plan.', {
    title: str('Short name'),
    course: maybe(str('Class name if they said it')),
    due: str('Local date and time as YYYY-MM-DDTHH:MM. Use 23:59 when no time was given.'),
    minutes: maybe({ type: 'integer', description: 'How long they said it will take' })
  }),
  tool('set_day', 'Change the shape of one date only. Use for "I am tired", "only an hour tonight", "I can stay up until midnight", "I am home at 7", "I am done for tonight". Leave out any field they did not mention.', {
    date: str(DATE),
    budget_minutes: maybe({ type: 'integer', description: 'Total minutes of work they are willing to do that day, from now on' }),
    start_at: maybe(str(`${TIME}: earliest they can start working that day`)),
    until: maybe(str(`${TIME}: when they want to be finished that day`)),
    off: { type: 'boolean', description: 'True for no work at all that day' },
    clear: { type: 'boolean', description: 'True to remove an earlier change to this date and go back to a normal day' },
    keep_limit: maybe({ type: 'boolean', description: 'True only when the student insists on this time after hearing what it costs ("keep my 10pm limit"), or it is a rule they cannot break (a parent, a curfew, being sick). Leave it out otherwise: if schoolwork due tomorrow then does not fit, Cadence moves tonight later on its own and tells you.' })
  }),
  tool('set_school', 'Days without school, early release, or a change to usual school hours.', {
    no_school_dates: { type: 'array', items: { type: 'string' }, description: `Dates (${DATE}) with no school` },
    early_release: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['date', 'time'], properties: { date: str(DATE), time: str(TIME) } },
      description: 'Dates when school ends early, with the time it ends'
    },
    usual_start: maybe(str(`${TIME}: only when they say school usually starts at this time`)),
    usual_end: maybe(str(`${TIME}: only when they say school usually ends at this time`))
  }),
  tool('set_sleep', 'Change when the student usually wakes or goes to bed. Only for a lasting habit; for one night use set_day.', {
    bed: maybe(str(TIME)),
    wake: maybe(str(TIME))
  }),
  tool('update_assignment', 'Act on an assignment already in the plan, by its id.', {
    id: str('The assignment id from the plan'),
    action: { type: 'string', enum: ['done', 'do_first', 'move_to_date', 'set_minutes', 'remove'], description: 'done: mark finished. do_first: start with this. move_to_date: do not start before the given date. set_minutes: change how long it takes. remove: take it off the plan.' },
    date: maybe(str(`${DATE} for move_to_date`)),
    minutes: maybe({ type: 'integer', description: 'For set_minutes' })
  }),
  tool('remove_item', 'Remove a calendar event, or cancel an activity for one date (practice is cancelled today) or entirely, by its id.', {
    id: str('The event or activity id from the plan'),
    kind: { type: 'string', enum: ['event', 'activity'] },
    date: maybe(str(`${DATE}: cancel only on this date. Leave out to remove it entirely.`))
  }),
  tool('what_if', 'See what would happen to the plan if an event were added, without adding it. Use for "can I go to..." and "do I have time for..." questions.', {
    title: str('Short name'),
    date: str(DATE),
    start: str(TIME),
    end: str(TIME)
  }),
  tool('check_free', 'Find when the student is free on a date. Use for "am I free Thursday?" and "when can I...".', {
    date: str(DATE),
    part: maybe({ type: 'string', enum: ['morning', 'afternoon', 'evening'], description: 'Limit to part of the day' })
  }),
  tool('remember', 'Save one lasting thing about the student, so you and Cadence know it in later conversations. Not for one-off things about a single day.', {
    note: str('One short sentence about the student, at most 160 characters, for example "Finds chemistry harder than other classes"')
  }),
  tool('forget', 'Delete a saved note, by its id from memory in the plan.', {
    id: str('The note id from memory.notes')
  }),
  tool('set_preferences', 'Set or clear how the student likes to work, which Cadence uses for every future plan. Leave out anything they did not mention.', {
    block_minutes: maybe({ type: 'integer', description: 'How many minutes they like to work before a break, 15 to 90' }),
    school_day_start: maybe(str(`${TIME}: the earliest they like to start homework on school days`)),
    free_day_start: maybe(str(`${TIME}: the earliest they like to start on days without school`)),
    first_class: maybe(str('A class they like to do first, as named in the plan')),
    clear: { type: 'array', items: { type: 'string', enum: ['block_minutes', 'school_day_start', 'free_day_start', 'first_class'] }, description: 'Preferences to remove. Empty when setting.' }
  }),
  tool('offer_choices', 'Show the student up to four short replies as buttons they can tap. Use when you have asked a question with a few likely answers.', {
    options: { type: 'array', items: { type: 'string' }, description: 'Each option is what the student would say, for example "I can do 1 hour tonight"' }
  })
];

/** The full request body. Only `messages` ever comes from a client. */
export function requestBody(messages) {
  return {
    model: MODEL,
    max_tokens: 16000,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    tools: TOOLS,
    output_config: { effort: 'low' },
    fallbacks: 'default',
    messages
  };
}

// What a conversation with this assistant can legitimately contain. A student's
// turn is text or tool results; the model's turn is whatever the API returned
// (for Gemini, also its own parts, kept for their signatures: lib/gemini.js).
// Anything else (an image or document fetched from a URL, say) is refused, so
// the endpoint cannot be used to run up cost on things the assistant never does.
const USER_BLOCKS = {
  text: ['type', 'text'],
  tool_result: ['type', 'tool_use_id', 'content', 'is_error']
};
const ASSISTANT_BLOCKS = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use', 'fallback', 'gemini']);
const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

/** Is this a list of messages we are willing to forward? Returns a reason when it is not. */
export function checkMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) return 'messages must be a non-empty list';
  if (messages.length > LIMITS.maxMessages) return 'This conversation is too long. Start a new one.';
  let chars = 0;
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return 'each message needs a role of user or assistant';
    if (Object.keys(m).some((k) => k !== 'role' && k !== 'content')) return 'messages may only have a role and content';
    if (typeof m.content === 'string') {
      if (m.role !== 'user') return 'assistant content must be a list of blocks';
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (!b || typeof b !== 'object' || typeof b.type !== 'string') return 'each content block needs a type';
        if (m.role === 'user') {
          const allowed = USER_BLOCKS[b.type];
          if (!allowed) return `content of type ${b.type} is not accepted`;
          if (Object.keys(b).some((k) => !allowed.includes(k))) return `unexpected field on a ${b.type} block`;
          if (b.type === 'text' && typeof b.text !== 'string') return 'text must be a string';
          if (b.type === 'tool_result' && (typeof b.content !== 'string' || typeof b.tool_use_id !== 'string')) return 'a tool result needs an id and text content';
        } else if (!ASSISTANT_BLOCKS.has(b.type)) {
          return `content of type ${b.type} is not accepted`;
        } else if (b.type === 'gemini') {
          const bad = checkGeminiBlock(b);
          if (bad) return bad;
        }
      }
    } else {
      return 'each message needs content';
    }
    chars += JSON.stringify(m.content).length;
  }
  if (chars > LIMITS.maxChars) return 'This conversation is too long. Start a new one.';
  if (messages[0].role !== 'user') return 'the first message must be from the user';
  return null;
}

/**
 * Is this "gemini" block, sent back by a browser, one Cadence could have made?
 * Returns a reason when it is not. It stops a request from smuggling in parts
 * the assistant never uses, such as a file for Gemini to fetch.
 */
function checkGeminiBlock(b) {
  if (Object.keys(b).some((k) => k !== 'type' && k !== 'parts') || !Array.isArray(b.parts)) return 'a gemini block has only parts';
  for (const p of b.parts) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return 'each part must be an object';
    for (const k of Object.keys(p)) {
      if (!['text', 'thought', 'thoughtSignature', 'functionCall'].includes(k)) return `a part may not have ${k}`;
    }
    if ('text' in p && typeof p.text !== 'string') return 'text must be a string';
    if ('thought' in p && p.thought !== true) return 'thought must be true';
    if ('thoughtSignature' in p && typeof p.thoughtSignature !== 'string') return 'a signature must be a string';
    if ('functionCall' in p) {
      const c = p.functionCall;
      if (!c || typeof c !== 'object' || Object.keys(c).some((k) => !['id', 'name', 'args'].includes(k))) return 'a function call has only an id, a name and args';
      if (!TOOL_NAMES.has(c.name)) return `there is no tool called ${c.name}`;
      if ('id' in c && typeof c.id !== 'string') return 'a function call id must be a string';
      if (!c.args || typeof c.args !== 'object' || Array.isArray(c.args)) return 'function call args must be an object';
    }
  }
  return null;
}
