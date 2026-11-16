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

  // Which company's AI answers on the site's server, for students without a
  // key of their own: 'groq', 'gemini' or 'claude'. The server function uses
  // this one and no other, and only once its key is set in Netlify (LAUNCH.md,
  // step 4). The privacy page names the same company from this setting, so
  // after changing it run python3 scripts/stamp_pages.py.
  assistant: 'gemini',

  // The Google OAuth client ID that Google Calendar and Gmail sign in with: a
  // "Web application" client in Cadence's Google Cloud project, whose
  // authorized redirect is https://<extension id>.chromiumapp.org/google for
  // the published extension (docs/GOOGLE_VERIFICATION.md, step 2). Public by
  // design, like the Supabase publishable key: it names the app to Google and
  // only that redirect can use it. While it is empty, Cadence asks whoever
  // connects for an ID of their own, which suits a copy someone runs themselves.
  googleClientId: '659538769348-0c9lvldu27lq5bopm3oht6or86ee12vb.apps.googleusercontent.com',

  // Whether the assistant may read email itself (its read_email tool). Off:
  // true only after Google's verification covers sending email to an AI
  // company. With it off, email is read only on the student's computer, by
  // the extension, to find events (lib/mailEvents.js), and nothing from email
  // reaches the assistant's AI company.
  emailToAssistant: false,

  // The published Chrome extension's ID, from the Chrome Web Store. The
  // website asks the extension in the same browser for the events it found in
  // email (src/panel/mailbridge.js). Empty: the website does not ask. An
  // unpacked copy has a different ID on every computer.
  extensionId: 'famiefaacigiakfkdaogbmmgcjgpgjen',

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
    operator: 'Veer Bhandari',
    contactEmail: 'cadenceaiplanner@gmail.com',
    // The promise on the contact page: "We reply within ___." Written so it
    // finishes that sentence. Leave it empty to make no promise.
    replyWithin: 'a week',
    // The extension's page on the Chrome Web Store, once it is published
    // (STORE.md). While empty, nothing offers to install it.
    extensionUrl: '',
    // Count visits that arrive from a labelled link (utm_source and friends):
    // one number per label per day, nothing about the visitor. Off unless you
    // turn it on, because the privacy page says "no tracking" while it is off
    // and changes its wording by itself when it is on. Needs the Supabase
    // project and the two SUPABASE_ variables on the server (see LAUNCH.md).
    countVisits: false,
    // Anonymous counts of use: a random ID, a daily "active" word and four
    // yes/no milestones, so you can see whether people come back and whether
    // they get as far as having work in a plan. No names, emails, plans,
    // titles, times or anything from email, and the person can turn it off in
    // Account (src/lib/metrics.js). Needs the database changes in
    // supabase/schema.sql applied first, and the two SUPABASE_ variables on the
    // server (LAUNCH.md). The privacy page and the homepage change their
    // wording by themselves when this is on: run python3 scripts/stamp_pages.py.
    countUsage: true
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
