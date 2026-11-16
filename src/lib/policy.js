// The last change to the privacy policy that changed what Cadence collects or
// who receives it.
//
// The privacy page promises that people are told about such a change in the
// app ("Changes to this policy"), and Google asks for agreement before its
// users' data is used in a new way. So it is shown once, when the app is next
// opened (and before the assistant next sends anything to an AI company), and
// waits for an OK (views/agent.js). Usage counts (lib/metrics.js) wait for it
// too. Someone who agrees to the terms after this date has already seen it.
//
// scripts/prelaunch_check.py fails while what Cadence collects (claims.lock.json)
// changed after this date, so a change like that cannot ship unannounced: move
// the date and say what changed.

import { CONFIG } from '../config.js';
const GMAIL = 'The Chrome extension can now read your Gmail on your computer, only if you choose to, and add the events it finds to your calendar. Your email is not sent to Cadence or to any AI company.';
const USAGE = ' Cadence now also records, with a random ID and no name, which screens you use and for how long, which buttons you press, and where setup and the tour are skipped, so it can be made easier to use. Never what you type, your plan or anything from email. You can turn it off in Account.';

export const POLICY_CHANGE = {
  date: '2026-11-12',
  what: CONFIG.site?.countUsage ? GMAIL + USAGE : GMAIL
};
