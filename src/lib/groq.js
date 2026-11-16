// The assistant on Groq, for the site's server function.
//
// Groq runs open AI models on its own chips and answers in the shape of
// OpenAI's Chat Completions API. Like lib/gemini.js, this file translates the
// one conversation format the rest of Cadence speaks (Anthropic-shaped turns
// of text, tool_use and tool_result blocks; see lib/agentllm.js) into a Groq
// request, and Groq's reply back, so only netlify/functions/agent.mjs needs to
// know which model is behind the assistant.
//
// Why Groq: its Services Agreement (section 4.2, June 2026) does not permit it
// to use what it receives to train or fine-tune any model, and its zero data
// retention setting stops it logging what it receives. Google's rules for
// Gmail data need exactly that, so the assistant may read a student's email
// here. The server runs Groq only once the site's owner has said that setting
// is on (GROQ_RETENTION=zero in Netlify). Groq's free plan allows 8,000 tokens
// a minute, less than one Cadence question, so a site needs its paid
// Developer plan (charged per token) for the assistant to answer at all.
// Reference: https://console.groq.com/docs/api-reference#chat-create

import { SYSTEM, toolsFor } from './agentspec.js';

// The model, by its exact id: OpenAI's open-weight gpt-oss-120b, Groq's
// strongest production model for calling tools (November 2026). Production
// matters: Groq's agreement treats preview models as beta services outside
// its data processing terms, so a student's email never goes to one. The site
// can choose another with the GROQ_MODEL environment variable.
export const GROQ_MODEL = 'openai/gpt-oss-120b';
// Groq's production models (November 2026), the only ones a student's email
// may go to; any other model the site chooses runs without reading email.
export const GROQ_PRODUCTION_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'];
export const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

/** The tools as Chat Completions functions. Their input schemas are plain JSON Schema already. */
const functions = (email) => toolsFor({ email }).map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema }
}));

/** The full request body. Only the conversation comes from a client. `email`
    adds the tool that reads Gmail, which the server decides (see EMAIL_TOOL
    in agentspec.js). */
export function groqRequest(messages, model = GROQ_MODEL, { email = false } = {}) {
  return {
    model,
    // The instructions and the tools come first and never change, so Groq's
    // automatic prompt caching can reuse them on every step of a question.
    messages: [{ role: 'system', content: SYSTEM }, ...toChat(messages)],
    tools: functions(email),
    tool_choice: 'auto',
    // gpt-oss calls one tool at a time; Cadence runs them in order anyway.
    parallel_tool_calls: false,
    // Low, so the same message gets the same tools; the replies are short.
    temperature: 0.2,
    // Counted against the plan's tokens per minute along with the prompt, so
    // kept to what a reply and a few tool calls need.
    max_completion_tokens: 1500,
    ...reasoningFor(model)
  };
}

/** For gpt-oss, a little thinking first, and none of it sent back (it is not part of the answer). */
export const reasoningFor = (model) => (/^openai\/gpt-oss/.test(model) ? { reasoning_effort: 'low', include_reasoning: false } : {});

// Ids Cadence makes up for a call that came without one. They only need to be
// unique within one conversation.
const LOCAL = 'local_';
const uniqueId = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

/**
 * The conversation, kept in Anthropic's shape, as Chat Completions messages.
 * An assistant turn becomes its words plus its tool calls; each tool result
 * becomes a "tool" message for the call it answers. Blocks that belong to
 * another model (Gemini's own parts, thinking) are left out: the words and
 * tool calls next to them say the same thing.
 */
function toChat(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const blocks = Array.isArray(m.content) ? m.content : [];
      const text = blocks.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n');
      const calls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) }
      }));
      if (!text && !calls.length) continue;           // nothing said and nothing done
      out.push(calls.length ? { role: 'assistant', content: text || null, tool_calls: calls } : { role: 'assistant', content: text });
      continue;
    }
    if (typeof m.content === 'string') { out.push({ role: 'user', content: m.content }); continue; }
    const words = [];
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `Error: ${b.content}` : String(b.content) });
      else if (b.type === 'text' && b.text) words.push(b.text);
    }
    if (words.length) out.push({ role: 'user', content: words.join('\n') });
  }
  return out;
}

/** Reasoning some models write into their answer, which is not part of it. */
const withoutThinking = (text) => String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

/**
 * Groq's reply in the conversation's shape: { content, stop_reason }.
 * stop_reason is end_turn, tool_use, max_tokens, refusal, or error (which the
 * server function turns into a failure rather than passing on). A tool call
 * whose arguments are not a JSON object is passed on with no input, so the
 * tool answers with what is missing and the model can try again.
 */
export function fromGroq(data, makeId = uniqueId) {
  const choice = data?.choices?.[0];
  const message = choice?.message;
  if (!message || typeof message !== 'object') return { content: [], stop_reason: 'error' };

  const content = [];
  const text = typeof message.content === 'string' ? withoutThinking(message.content) : '';
  if (text) content.push({ type: 'text', text });
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const name = call?.function?.name;
    if (typeof name !== 'string' || !name) continue;
    let input = {};
    try {
      const v = JSON.parse(call.function.arguments || '{}');
      if (v && typeof v === 'object' && !Array.isArray(v)) input = v;
    } catch { /* left empty: the tool says what is missing */ }
    content.push({ type: 'tool_use', id: typeof call.id === 'string' && call.id ? call.id : `${LOCAL}${makeId()}`, name, input });
  }

  const calls = content.some((b) => b.type === 'tool_use');
  const reason = choice.finish_reason;
  const stop_reason = reason === 'tool_calls' ? (calls ? 'tool_use' : 'error')
    : reason === 'stop' ? (calls ? 'tool_use' : 'end_turn')
      : reason === 'length' ? 'max_tokens'
        : reason === 'content_filter' ? 'refusal'
          : 'error';
  return { content, stop_reason };
}
