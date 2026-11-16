// Which company's AI answers on the site's server, and whether it may read
// email. Used by netlify/functions/agent.mjs; kept apart so it can be tested
// on its own and so the function file exports only its handler.

/**
 * Which model answers on this site, and whether it may read email.
 *
 * Only the company named in src/config.js (`assistant`) is used, and only
 * once its key is set. Gemini also needs GEMINI_TIER and Groq needs
 * GROQ_RETENTION=zero: what the privacy page says about each depends on
 * them, so running either is a decision the owner wrote down, not a default.
 *
 * Reading Gmail is offered only where what an email says is not used to
 * train a model: Claude, Groq (whose agreement forbids training on what it
 * receives, and which keeps nothing with zero retention on), or Gemini on a
 * paid plan. On Gemini's free plan Google may use what it receives to
 * improve its products, which Google's rules for Gmail data do not allow
 * (see EMAIL_TOOL in agentspec.js). All of that applies only once
 * src/config.js has emailToAssistant: true; until then no model reads email.
 */
export function pickProvider(assistant, { keys = {}, tier = '', retention = '', emailToAssistant = false } = {}) {
  const chosen = String(assistant || '').trim().toLowerCase();
  const plan = String(tier || '').trim().toLowerCase();
  const kept = String(retention || '').trim().toLowerCase();
  const provider = chosen === 'groq' ? (keys.groq && kept === 'zero' ? 'groq' : null)
    : chosen === 'gemini' ? (keys.gemini && (plan === 'free' || plan === 'paid') ? 'gemini' : null)
      : chosen === 'claude' ? (keys.anthropic ? 'anthropic' : null)
        : null;
  const email = provider === 'anthropic' || provider === 'groq' || (provider === 'gemini' && plan === 'paid');
  // And only when src/config.js switches it on (emailToAssistant), which it
  // does not until Google's verification covers it.
  return { provider, email: email && emailToAssistant === true };
}

