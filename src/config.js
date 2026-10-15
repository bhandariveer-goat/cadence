// The few values that belong to whoever runs this copy of Cadence, in one
// place. Everything here is public by design: a Supabase project URL and its
// publishable key are meant to ship in front-end code (the grants and
// row-level security in supabase/schema.sql are what protect the data), and
// nothing secret is ever read from this file. Secrets such as the Anthropic
// API key live in the host's environment variables and are only read by
// netlify/functions/agent.mjs.
//
// Leave the Supabase fields empty and Cadence still works: people get an
// account that lives in their browser, with no email sign-in and no sync
// between the extension and the website. Fill both in (LAUNCH.md, step 3)
// and accounts, sign-in and every plan are kept in that Supabase project.

export const CONFIG = {
  // https://<project>.supabase.co  (Supabase > Project settings > Data API,
  // or the Connect button at the top of the project)
  supabaseUrl: 'https://bfflfqtgqdlhtvwspynv.supabase.co',
  // The PUBLISHABLE key from Project settings > API keys. It starts with
  // sb_publishable_. On an older project it is the "anon" key instead, a long
  // string starting with eyJ.
  //
  // Never the secret key (sb_secret_...) and never the service_role key:
  // those can read and change everyone's data, and this file is public.
  // Cadence refuses to start its accounts with one of those here.
  supabaseKey: 'sb_publishable_t8_eRCeul71LRLpSFMmwyA_KLGJNmHU',

  // Where the assistant sends requests when the student has no key of their
  // own. Served by netlify/functions/agent.mjs on the website; the extension
  // needs the full https:// address of the deployed site here.
  agentEndpoint: '/api/agent',

  // Shown on the privacy policy and terms pages. Fill these in before launch;
  // the pages say so plainly while they are empty.
  //
  // After changing anything in this block, run
  //     python3 scripts/stamp_pages.py
  // It writes these values into the HTML itself (and into robots.txt and
  // sitemap.xml), so the pages are complete before any script runs.
  site: {
    name: 'Cadence',
    // Where the site lives, with no https:// and no slash. The Netlify
    // address for now; replace it with the custom domain when there is one.
    domain: 'cadenceaiplanning.netlify.app',
    operator: '',
    contactEmail: '',
    // The promise on the contact page: "We reply within ___." Written so it
    // finishes that sentence. Leave it empty to make no promise.
    replyWithin: 'a week',
    // Count visits that arrive from a labelled link (utm_source and friends):
    // one number per label per day, nothing about the visitor. Off unless you
    // turn it on, because the privacy page says "no tracking" while it is off
    // and changes its wording by itself when it is on. Needs the Supabase
    // project and the two SUPABASE_ variables on the server (see LAUNCH.md).
    countVisits: false
  }
};

/**
 * Is this key one that must never be in a browser? Supabase's secret keys
 * start with sb_secret_; the older kind is a token whose contents name the
 * role "service_role". Either one bypasses every rule that keeps one
 * person's plan from another's.
 */
export function isSecretKey(key) {
  const k = String(key || '').trim();
  if (/^sb_secret_/i.test(k)) return true;
  const parts = k.split('.');
  if (parts.length !== 3 || !k.startsWith('eyJ')) return false;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.role !== 'anon';
  } catch { return true; }               // a token that cannot be read is not trusted
}

// https everywhere, except a local mock (scripts/devserver.py --mock) while developing.
export const cloudConfigured = () => /^(https:\/\/.+|http:\/\/localhost(:\d+)?\/.+)/.test(CONFIG.supabaseUrl)
  && String(CONFIG.supabaseKey || '').length > 20
  && !isSecretKey(CONFIG.supabaseKey);
