// The few values that belong to whoever runs this copy of Cadence, in one
// place. Everything here is public by design: a Supabase project URL and its
// "anon" key are meant to ship in front-end code (row-level security is what
// protects the data), and nothing secret is ever read from this file. Secrets
// such as the Anthropic API key live in the host's environment variables and
// are only read by netlify/functions/agent.mjs.
//
// Leave the Supabase fields empty and Cadence still works: people get an
// account that lives in their browser, with no email sign-in and no sync
// between the extension and the website.

export const CONFIG = {
  // https://<project>.supabase.co  (Supabase > Project settings > API)
  supabaseUrl: '',
  // The public anon key from the same page. Never the service_role key.
  supabaseAnonKey: '',

  // Where the assistant sends requests when the student has no key of their
  // own. Served by netlify/functions/agent.mjs on the website; the extension
  // needs the full https:// address of the deployed site here.
  agentEndpoint: '/api/agent',

  // Shown on the privacy policy and terms pages. Fill these in before launch;
  // the pages say so plainly while they are empty.
  site: {
    name: 'Cadence',
    domain: '',
    operator: '',
    contactEmail: ''
  }
};

// https everywhere, except a local mock (scripts/devserver.py --mock) while developing.
export const cloudConfigured = () => /^(https:\/\/.+|http:\/\/localhost(:\d+)?\/.+)/.test(CONFIG.supabaseUrl) && CONFIG.supabaseAnonKey.length > 20;
