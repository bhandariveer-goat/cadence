// The assistant on Google's Gemini, for the site's server function.
//
// The rest of Cadence speaks one conversation format: user and assistant
// turns made of text, tool_use and tool_result blocks (the shape of
// Anthropic's Messages API, which lib/agentllm.js was written against).
// lib/agentllm.js runs the tools the same way whichever model answers. This
// file translates that conversation into a Gemini generateContent request,
// and Gemini's reply back, so only netlify/functions/agent.mjs needs to know
// which model is behind the assistant.
//
// Gemini attaches "thought signatures" to parts of its reply, and refuses a
// later request in which they do not come back unchanged. So each reply also
// carries Gemini's own parts, untouched, in a block of type "gemini". The
// browser echoes that block with the rest of the turn, and the next request
// sends those parts as they were instead of rebuilding them.
//
// generateContent rather than the newer Interactions API: Google's own
// documentation (October 2026) calls Interactions a beta whose schema may
// change, and generateContent "the recommended path for stable deployments".
// Reference: https://ai.google.dev/api/generate-content

import { SYSTEM, TOOLS } from './agentspec.js';

// Google's low-latency model, with tool calls. It answers in a few seconds,
// which matters because Netlify stops a free-plan function after 10, and its
// free-tier allowance is larger than gemini-3.8-flash's, which ran out after a
// handful of messages. A fixed name rather than an alias such as
// gemini-flash-latest, which Google moves to each new release on its own. The
// site can choose another with the GEMINI_MODEL environment variable.
export const GEMINI_MODEL = 'gemini-3.5-flash-lite';

/** How much the model thinks first. Flash-Lite allows "minimal" (fastest); full Flash refuses it. */
export const thinkingFor = (model) => (/flash-lite/.test(model) ? 'MINIMAL' : 'LOW');
export const geminiUrl = (model = GEMINI_MODEL) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

// The same tools, as Gemini function declarations. Their input schemas are
// plain JSON Schema already.
const DECLARATIONS = TOOLS.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.input_schema }));

/** The full request body. Only the conversation comes from a client. */
export function geminiRequest(messages, model = GEMINI_MODEL) {
  return {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: toContents(messages),
    tools: [{ functionDeclarations: DECLARATIONS }],
    // VALIDATED: the model may answer in words or call a tool, and a tool call
    // is held to its schema.
    toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } },
    generationConfig: { maxOutputTokens: 8192, thinkingConfig: { thinkingLevel: thinkingFor(model) } }
  };
}

// Ids Cadence makes up for a call that Gemini sent without one. Gemini is not
// sent these back. They only need to be unique within one conversation.
const LOCAL = 'local_';
const uniqueId = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

function toContents(messages) {
  const names = new Map();                       // tool_use id -> tool name
  return messages.map((m) => {
    if (m.role === 'assistant') {
      for (const b of m.content) if (b.type === 'tool_use') names.set(b.id, b.name);
      const own = m.content.find((b) => b.type === 'gemini');
      if (own) return { role: 'model', parts: own.parts };
      // A turn that did not come from Gemini, rebuilt from what it said and
      // did. It has no signatures to give back.
      return {
        role: 'model',
        parts: m.content.flatMap((b) => (b.type === 'text' && b.text ? [{ text: b.text }]
          : b.type === 'tool_use' ? [{ functionCall: { name: b.name, args: b.input || {} } }] : []))
      };
    }
    if (typeof m.content === 'string') return { role: 'user', parts: [{ text: m.content }] };
    return {
      role: 'user',
      parts: m.content.map((b) => {
        if (b.type === 'text') return { text: b.text };
        const name = names.get(b.tool_use_id) || 'unknown';
        const response = b.is_error ? { error: b.content } : { result: parsed(b.content) };
        return { functionResponse: { ...(b.tool_use_id.startsWith(LOCAL) ? {} : { id: b.tool_use_id }), name, response } };
      })
    };
  });
}

function parsed(text) {
  try { return JSON.parse(text); } catch { return text; }
}

// Why a reply can end. Anything not listed is a fault, not an answer.
const REFUSED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'LANGUAGE', 'ESCALATION']);

/**
 * Gemini's reply in the conversation's shape: { content, stop_reason }.
 * stop_reason is end_turn, tool_use, max_tokens, refusal, or error (which the
 * server function turns into a failure rather than passing on).
 */
export function fromGemini(data, makeId = uniqueId) {
  if (data?.promptFeedback?.blockReason) return { content: [], stop_reason: 'refusal' };
  const candidate = data?.candidates?.[0];
  if (!candidate) return { content: [], stop_reason: 'error' };
  const parts = (Array.isArray(candidate.content?.parts) ? candidate.content.parts : []).map(keep).filter(Boolean);

  const content = [];
  for (const p of parts) {
    if (p.thought) continue;                     // the model's working, not part of its answer
    if (typeof p.text === 'string' && p.text.trim()) content.push({ type: 'text', text: p.text });
    if (p.functionCall) {
      content.push({ type: 'tool_use', id: p.functionCall.id || `${LOCAL}${makeId()}`, name: p.functionCall.name, input: p.functionCall.args || {} });
    }
  }
  content.push({ type: 'gemini', parts });

  const reason = candidate.finishReason || 'STOP';
  const calls = content.some((b) => b.type === 'tool_use');
  const stop_reason = reason === 'STOP' ? (calls ? 'tool_use' : 'end_turn')
    : reason === 'MAX_TOKENS' ? 'max_tokens'
      : REFUSED.has(reason) ? 'refusal'
        : 'error';
  return { content, stop_reason };
}

/** The parts of a reply worth keeping, with only the fields Cadence knows. */
function keep(p) {
  if (!p || typeof p !== 'object') return null;
  const out = {};
  if (typeof p.text === 'string') out.text = p.text;
  if (p.thought === true) out.thought = true;
  if (typeof p.thoughtSignature === 'string') out.thoughtSignature = p.thoughtSignature;
  if (p.functionCall && typeof p.functionCall.name === 'string') {
    out.functionCall = { name: p.functionCall.name, args: p.functionCall.args && typeof p.functionCall.args === 'object' ? p.functionCall.args : {} };
    if (typeof p.functionCall.id === 'string') out.functionCall.id = p.functionCall.id;
  }
  return Object.keys(out).length ? out : null;
}
