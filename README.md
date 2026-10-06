# Cadence

A planner for high-school students. Classes, activities and assignments go on
one calendar, Cadence plans the time to do the work, and when the day changes
you tell the assistant in a sentence and the week is rebuilt.

It runs in two places from the same code:

- **A Chrome extension on Canvas.** It reads assignments with the Canvas login
  the student already has, and opens as a panel on any Canvas page.
- **A website.** The same planner on a wider canvas, with the assistant docked
  beside it.

## Pages

| Address | File | What it is |
| --- | --- | --- |
| `/` | `index.html` | Homepage |
| `/app` | `app.html` | The planner. Opens on the sign-in screen. |
| `/demo` | `demo.html` | The planner with a sample week, in its own storage |
| `/privacy`, `/terms` | `privacy.html`, `terms.html` | Legal pages |
| `/api/agent` | `netlify/functions/agent.mjs` | The assistant, server side |

The demo and a real account never share storage. Earlier versions seeded sample
data into the same record as a person's own plan; `store.js` now keeps two
buckets, and `scrubDemo()` removes sample data from any plan that picked it up.

## Run it locally

```bash
python3 scripts/devserver.py --mock
```

Open <http://localhost:8123/app> or <http://localhost:8123/demo>. The server
sends `Cache-Control: no-store`, so an edited file is always the one that runs.
`--mock` also answers the Supabase and `/api/agent` endpoints in memory, which
is how sign-in and sync are tested without a real backend.

**Chrome extension:** `chrome://extensions` → Developer mode → Load unpacked →
this folder. Refresh Canvas; the Cadence button is bottom right.

## The tabs

- **Today.** The one thing to do next, the day as a timeline, and a ring per
  activity.
- **Calendar.** Everything with a time on it: school, events, activities, due
  dates, and the blocks Cadence planned for the work. Four kinds, four colours.
- **School.** A list of assignments. Open one for a summary of what it is, how
  long it takes, and the steps, each tied to the block it is planned for.
- **Activities.** What the student does outside class, with a weekly count,
  the activities record and last week's review.
- **Crew.** Accountability partners and clubs.

The account (school hours, sleep, connected calendars, sign out, delete my
data) is behind the avatar in the header.

## How planning works

Cadence does not ask when the student wants to work or how much a night.
`lib/daymodel.js` works it out per date:

- A day runs from waking to bed. School takes its hours on school days and
  nothing on days off, so a day with no school opens from the morning.
- One-off changes belong to a date and expire with it: `no school Friday`,
  `I'm tired, an hour tonight`, `I can stay up till midnight`.
- `lib/scheduler.js` tries the lightest daily load first and raises it one step
  at a time until every assignment lands before it is due. A day the student
  put a number on keeps that number; the rest of the week absorbs the
  difference.
- Ordering: what can only still be on time tonight, then anything late, then
  earliest deadline. Long work is paced across days, and after two blocks of
  the same thing there is a 30 minute break before a third.
- Work with no room left before its deadline is reported once, by name.

## The assistant

`lib/agentops.js` defines a small set of operations (add an event, add an
activity, add an assignment, change one day, change school or sleep, mark done,
move, remove). Everything the assistant does is one of these, which is what
makes every change listable and undoable in a single step.

There are two ways a sentence becomes operations:

1. **On the device** (`lib/agent.js`). Rules that read times, ranges, weekday
   lists, recurrence, amounts of work, "then go to sleep", cancellations,
   moves and questions. Always available, no network.
2. **With Claude** (`lib/agentllm.js`, model `claude-opus-5-5`). A tool-use
   loop: Claude calls tools, the browser runs each against a working copy of
   the plan and returns what actually changed, and nothing is saved until the
   turn ends. Used when the student adds their own Anthropic key, or is signed
   in with an email on a site that runs the server function. If the call fails
   for any reason the on-device reader answers instead.

What Claude is sent is listed in `privacy.html`. Events from Google Calendar
are sent as a time with no title.

### The server function

`netlify/functions/agent.mjs` holds the Anthropic key so it never reaches a
browser. It accepts a request only with a Supabase session that Supabase
confirms, counts it against a per-account daily limit and a site-wide daily
limit kept in Postgres, and forwards only `messages`: the model, the instructions and the tools are fixed
in `lib/agentspec.js`.

Set these in Netlify → Project configuration → Environment variables (never in
`netlify.toml`, which functions cannot read, and never in this repository):

| Variable | |
| --- | --- |
| `ANTHROPIC_API_KEY` | required |
| `SUPABASE_URL` | required, same as `src/config.js` |
| `SUPABASE_ANON_KEY` | required, same as `src/config.js` |
| `AGENT_DAILY_LIMIT` | optional, default 60 requests per account per day |
| `AGENT_DAILY_TOTAL` | optional, default 1500 requests per day across all accounts |

## Accounts and sync

Without any setup, an account is a name kept in the browser. To add email
sign-in, so the extension and the website show the same plan:

1. Create a Supabase project and run `supabase/schema.sql` in its SQL editor.
2. Authentication → Providers → Email: enabled. Edit the Magic Link email
   template to include `{{ .Token }}` so students get a six-digit code.
3. Put the project URL and the anon key in `src/config.js`. The anon key is
   public by design; row level security is what protects the data. Never put
   the `service_role` key anywhere in this repository.

Sync is one row per account holding the plan (`lib/cloud.js`). It leaves out
credentials and everything fetched from a connected calendar: the Anthropic
key, the Google connection and the Canvas feed link stay on the device where
they were set up.

Each device remembers which version of the row it last matched, and a save is
accepted only over that version. So a device that is behind loads the newer
plan instead of overwriting it, and if the same plan was changed in two places
before either could save, Cadence asks which to keep rather than choosing. An
open tab checks for changes when it comes back into view and once a minute.

## Connecting calendars

### Canvas calendar feed

1. Canvas → **Calendar** → **Calendar Feed** (bottom right) → copy the link.
2. Cadence → your account → **Calendars** → **Add feed link**.

That link works like a password, so it is only ever shown masked and is not
synced to the account. Inside Canvas the session-based sync also runs and adds
what the feed cannot carry: submission status, points, instructions, rubrics.
A downloaded `.ics` file can be imported instead from the account screen.

### Google Calendar: what you must do in Google Cloud Console

Google requires an OAuth client, and only you can create it:

1. **console.cloud.google.com** → create a project (e.g. "Cadence").
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen** → **External** → fill in app name,
   your email, developer email. Add yourself under **Test users**: while the app
   is unverified only test users can sign in (up to 100), which is fine for you
   and your classmates.
4. **Scopes**: add `.../auth/calendar.readonly` for reading, and
   `.../auth/calendar.events` if you want Cadence to add its blocks to your
   calendar. Both are *sensitive* scopes: fine in testing mode, but publishing
   to everyone would need Google's verification review.
5. **Credentials → Create credentials → OAuth client ID → Web application**.
   Under **Authorized redirect URIs** paste the URI Cadence shows you in
   your account → Calendars → Google → Connect. It looks like:
   `https://<extension-id>.chromiumapp.org/google`
6. Copy the **Client ID** and paste it into Cadence when it asks.

Then Cadence → Calendars → **Connect**, approve the consent screen, and pick
which calendars count as busy.

Two limits worth knowing:

- **Google sync only works in the Chrome extension.** On the hosted website the
  browser blocks these cross-origin requests; the manual `.ics` import still
  works there. Same for the Canvas feed fetch.
- **Tokens last about an hour.** Cadence renews silently in the background and
  only asks you to sign in again if that fails.

### Adding Cadence's blocks to Google Calendar

Off by default, and opt-in per item even when it's on: nothing appears on a
real calendar unless it's asked for.

1. Calendars → Google → **Add Cadence blocks to Google Calendar**. Google asks
   again, this time for `calendar.events` (incremental auth: the read grant is
   kept).
2. Pick which calendar to write to. A separate calendar is worth considering , 
   it makes Cadence's blocks easy to hide or delete in bulk.
3. Turn it on per item: the **Add to Google Calendar** toggle in an activity's
   editor, or the button on an assignment's guide. The Calendars screen lists
   everything currently syncing, with a **Stop** next to each.

Every event Cadence writes carries a private extended property
(`cadenceBlock=v1`) plus a stable key of `itemId|startTime`. Resync queries
Google for *only* events with that property, so:

- blocks that moved in a re-plan get patched to the new time,
- blocks Cadence no longer plans get deleted,
- everything else on the calendar is never read or touched,
- and running it twice changes nothing the second time.

**Remove Cadence events** takes every one of them back off, leaving the rest
alone. Turning the toggle off asks whether to remove or keep what's there.

### Autosync

A background alarm re-fetches every connected source (default every 20 minutes,
adjustable 15–60) and re-plans around the result. Each source is independent:
an expired Google token or an unreachable Canvas feed shows an error on that
one card while the others keep working, and the last good data stays on screen.
There's a **Refresh now** button for when you can't wait.

## Before launch

```bash
python3 scripts/prelaunch_check.py
```

It checks the launch gates (custom domain, favicon on every page, no "made
with" tag, privacy and terms pages that name who runs the site) and the house
style (no gradients, no pill-shaped controls, no em dashes or emoji in anything
a person reads, no scroll or cursor animation, nothing that looks like a
secret). `LAUNCH.md` has the steps only the owner can do.

## What has and has not been tested

Tested in a browser against the code in this repository:

- The planner, the day model, and every sentence in the assistant's on-device
  reader, including undo.
- Sign-in, sync between two devices, and what sync leaves out, against the mock
  backend in `scripts/devserver.py`.
- The server function's checks (auth, limit, body validation, what it forwards)
  with Anthropic stubbed out.
- The Claude tool loop with a scripted model: message order, echoing replies
  unchanged, tool results, rollback on failure.

Not yet run against the real services, because that needs accounts and keys
only the owner can create:

- A live Supabase project (sign-in emails, the SQL in `schema.sql`).
- A live Anthropic key (the assistant actually talking to Claude).
- A Netlify deploy of the function.
- Google Calendar with a real OAuth client.

## Files

```
index.html, site.css, site.js            homepage
DESIGN.md                               the design system: tokens and the rules behind them
app.html, demo.html                      the planner, and the planner with sample data
privacy.html, terms.html                 legal pages
netlify/functions/agent.mjs              the assistant's server side
netlify.toml                             clean addresses, headers, function settings
manifest.json, src/content, src/background   Chrome extension
src/config.js                            the values that belong to whoever runs this copy
src/panel/shell.js, app.js, core.js      frame, routing, state and sync
src/panel/views/                         signin, onboarding, today, calendar, week,
                                         plan (School), activities, account, agent,
                                         crew, commitments, guide, calendars, create
src/lib/daymodel.js                      free time and load, per date
src/lib/scheduler.js, priority.js        the planner
src/lib/agent.js                         reading sentences on the device
src/lib/agentops.js                      the operations, the plan diff, the answers
src/lib/agentspec.js, agentllm.js        Claude: instructions, tools, the loop
src/lib/cloud.js                         sign-in and sync
src/lib/sources/                         Canvas feed, Google Calendar, sync runner
supabase/schema.sql                      database tables and security policies
scripts/devserver.py                     local server with mock backends
scripts/prelaunch_check.py               launch gates and house style
```
