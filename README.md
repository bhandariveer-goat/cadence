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
| `/contact` | `contact.html` | A short form, received by Netlify Forms |
| `/thanks` | `thanks.html` | Where the form lands once a message is sent |
| anything else | `404.html` | "This page does not exist", with ways back |
| `/robots.txt`, `/sitemap.xml` | written by `scripts/stamp_pages.py` | What crawlers may fetch, and the pages to find |
| `/api/agent` | `netlify/functions/agent.mjs` | The assistant, server side |
| `/api/visit` | `netlify/functions/visit.mjs` | Counts visits from labelled links. Off unless `site.countVisits` is on |
| `/api/canvas-feed` | `netlify/functions/canvas-feed.mjs` | Fetches a Canvas feed or Google Calendar link for the website, keeping nothing |
| `/app?join=<code>`, `/app?partner=<code>` | | Invite links: kept through sign-up, then offered as one tap to join |

The demo and a real account never share storage. Earlier versions seeded sample
data into the same record as a person's own plan; `store.js` now keeps two
buckets, and `scrubDemo()` removes sample data from any plan that picked it up.

## Run it locally

```bash
python3 scripts/devserver.py --mock
```

Open <http://localhost:8123/app> or <http://localhost:8123/demo>. The server
sends `Cache-Control: no-store`, so an edited file is always the one that runs.
`--mock` also answers the Supabase, `/api/agent` and `/api/canvas-feed`
endpoints in memory, which is how sign-in, sync, the Canvas feed and invite
links are tested without a real backend. It serves
`src/config.js` with the Supabase project swapped for itself, in memory only,
so the file never has to be edited to test (and the launch check refuses a
test address in it). It also sends the same security headers as the live site
(`netlify.toml`), and collects anything the Content-Security-Policy blocks at
<http://localhost:8123/mock/csp-reports>.

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
2. **With a model** (`lib/agentllm.js`). A tool-use loop: the model calls
   tools, the browser runs each against a working copy of the plan and returns
   what actually changed, and nothing is saved until the turn ends. Signed in
   on a site that runs the server function, the model is Google's Gemini
   (`gemini-3.5-flash-lite`, chosen for speed: Netlify stops a free-plan function after 10 seconds); with the student's own Anthropic key, it is Claude
   (`claude-opus-5-5`), straight from the browser. Every message goes to the
   model when one is available. If the call fails for any reason the
   on-device reader answers instead.

What the model is sent is listed in `privacy.html`. Events from Google Calendar
are sent as a time with no title.

### The server function

`netlify/functions/agent.mjs` holds the model's key so it never reaches a
browser. It accepts a request only with a Supabase session that Supabase
confirms, counts it against a per-account daily limit and a site-wide daily
limit kept in Postgres, and forwards only `messages`: the model, the
instructions and the tools are fixed in `lib/agentspec.js` and
`lib/gemini.js`.

The browser speaks one conversation format whichever model answers.
`lib/gemini.js` turns it into a Gemini `generateContent` request and turns
the reply back. Gemini's reply also travels in its own block, untouched,
because Gemini attaches signatures to its tool calls and refuses a later
request that does not return them exactly; `checkMessages` refuses any such
block that holds something Cadence never sends (a file for Gemini to fetch,
say). `generateContent` rather than the newer Interactions API, which
Google's own documentation calls a beta whose schema may change.

Someone using Cadence with only a name reaches it through a hidden Supabase
anonymous account (`anonymousToken` in `lib/cloud.js`), kept in the browser
apart from the plan. Every table has a restrictive policy refusing anonymous
accounts, and the Crew functions refuse them too, so all one can do is be
counted by `bump_agent_usage()`, which also removes anonymous accounts unused
for 30 days.

Using Gemini for a site students use goes against Google's Gemini API terms,
which set a minimum age of 18; see `LAUNCH.md`, step 4.

Set these in Netlify → Project configuration → Environment variables (never in
`netlify.toml`, which functions cannot read, and never in this repository):

| Variable | |
| --- | --- |
| `GEMINI_API_KEY` | the key from Google AI Studio. When it is set, Gemini answers |
| `GEMINI_TIER` | `free` or `paid`: which Google plan the key is on. Must be set for Gemini to run. The privacy page is written for the free plan (Google may use and read messages) |
| `GEMINI_MODEL` | optional, another Gemini model; the default is in `lib/gemini.js` |
| `ANTHROPIC_API_KEY` | used instead when there is no `GEMINI_API_KEY` |
| `SUPABASE_URL` | required, same as `src/config.js` |
| `SUPABASE_KEY` | required: the publishable key, same as `supabaseKey` in `src/config.js` (`SUPABASE_ANON_KEY` is still read, for a set-up made before the rename) |
| `AGENT_DAILY_LIMIT` | optional, default 60 requests per account per day. The database stops counting an account at 61 (so one account cannot use up the day for everyone), so a higher limit also needs that number raised in `bump_agent_usage()` |
| `AGENT_DAILY_TOTAL` | optional, default 1500 requests per day across all accounts |

## Accounts and sync

Without any setup, an account is a name kept in the browser. With a Supabase
project behind it, people sign in with an email and their account, plan and
Crew are stored there, so the extension and the website show the same plan.
`LAUNCH.md`, step 3, is the full set-up. In short:

1. Create a Supabase project and run `supabase/schema.sql` in its SQL editor.
   The file can be run again at any time. It makes the tables, the row level
   security policies, a profile row for every new account, and the grants.
   Supabase projects differ in what they grant by default (many grant every
   table to everyone, people not signed in included), so the file takes all
   of that away and gives each table back only the actions its policies
   allow. Someone who is not signed in can reach nothing.
2. Put the project URL and the publishable key (`sb_publishable_...`, or the
   `anon` key on an older project) in `src/config.js`. That key is public by
   design. The secret key and the `service_role` key must never be anywhere
   in this repository; `cloudConfigured()` refuses one, and so does the
   pre-launch check.
3. An account is made with an emailed code (which proves the address) and a
   password the person chooses; after that they sign in with email and
   password (`signInWithPassword` and `setPassword` in `lib/cloud.js`). The
   code still works as a way in for a forgotten password. Should a project's
   email carry a link instead of a code, the link returns to `/app` with the
   session in the address, which is read and removed before anything else
   runs (`sessionFromLink` in `lib/cloud.js`). Supabase's built-in email only
   reaches the project's own team and is limited to two an hour, so signing
   in anyone else needs a custom SMTP service, and so does editing the
   templates to show the code (`{{ .Token }}`, in both Confirm signup and
   Magic Link). The extension can only use a code.

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
synced to the account. The extension fetches the feed itself; a browser will
not let the website read another site's calendar, so on the website
`netlify/functions/canvas-feed.mjs` fetches it and hands it straight back,
keeping nothing. That function needs a Supabase session (an email account or
the hidden anonymous one), only fetches https addresses whose path is
`/feeds/calendars/<name>.ics` on a named host, follows redirects only to
addresses that pass the same test, and returns only a calendar of at most
5 MB. An open website tab re-syncs on the Calendars setting (every 20 minutes
by default). Inside Canvas the session-based sync also runs and adds
what the feed cannot carry: submission status, points, instructions, rubrics.
A downloaded `.ics` file can be imported instead from the account screen.

### Google Calendar link (no setup)

1. Google Calendar on a computer → Settings → click the calendar →
   **Integrate calendar** → copy **Secret address in iCal format**.
2. Cadence → your account → **Calendars** → **Add Google Calendar link**.

Read only: events count as busy time; events marked free are left out, and
only titles and times are kept, on the device. The link goes through
`netlify/functions/canvas-feed.mjs` (website and extension alike), which
fetches the calendar and keeps nothing. Writing Cadence's blocks into Google
Calendar still needs the signed-in connection below, in the extension.

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

## What every page does

The things a site is expected to have, and where each one lives.

| | Public pages (`site.js`, `site.css`) | The app (`src/panel/`) |
| --- | --- | --- |
| Light and dark | Button in the header, and in the menu on a phone | Header button on a wide screen, Account > Appearance, the palette |
| Search | The magnifier in the header, or press `/`. Searches the public pages in the browser | The command palette: `Ctrl/Cmd K` or `/` |
| Small screens | A menu button that opens the page links. On the homepage the two main buttons follow in a bar at the bottom of a phone whenever the page's own are off screen | Tabs along the bottom |
| Where you are | Breadcrumbs on every page below the homepage, and the current page marked in the header | A back button on every screen that was opened from another |
| Skip link | "Skip to the page", first thing Tab reaches | The same |
| Storage notice | One sentence the first time, with a link to the privacy page | The sign-in screen says where the plan is kept |
| Back to top | A button that appears after a screen and a half | Pressing the tab you are on |
| Reading progress | A 2px line under the header | Not used: an app page is not read top to bottom |
| Questions | Eight, on the homepage, each opening in place | |
| Contact | The contact page: a form, a promise of when to expect a reply (`site.replyWithin`), and a thank-you page after sending. A Contact button in the corner leads to it | A Contact link under Account and on the sign-in screen |
| A page that is not there | `404.html`, with links back and the site search | Unknown screens fall back to Today |
| Last updated | In the footer (`SITE_UPDATED` in `site.js`), and at the top of the privacy and terms pages | "Synced" and "saved" times next to what they describe |
| Copy | Copy the contact address | Invite codes, the activities record, the Google redirect address |
| Forms | The contact form: an error under the field it is about, a ring on the button while it sends, and the message kept if sending fails | An error under the field it is about; a success line under the form; a ring on a button that is working; Show / Hide on the API key |
| Confirming | | A named question before anything that cannot be put back; Undo for everything else |
| Print | Documents: no header, links written out | The page that is showing, in full |

Cadence sets no cookies, so the notice is not a consent banner: there is
nothing to consent to. It says where the plan is stored and is dismissed once.

### Links with a label on them

A link shared in a newsletter can end in `?utm_source=newsletter`. The site
takes the label off the address as soon as the page opens, so a link copied
from the address bar is clean. By default that is all that happens.

If `site.countVisits` is set to `true` in `src/config.js`, the page also asks
`/api/visit` to add one to that label's count for the day. A row is a label, a
date and a number (`visit_counts` in `supabase/schema.sql`). There is no IP
address, cookie, account or browser detail in it, and one browser tab is
counted once. The privacy page, the homepage table and the storage notice
change their wording by themselves when the switch is on, so they never say
"no tracking" while a count is being kept. It is off in this repository.

## What is in the HTML, and what is not

The public pages (home, privacy, terms, contact, thank-you, 404) are plain
HTML. Every word on them, every link and every heading's id is in the file as
it is served, so a reader with scripts off and a crawler that does not run
them get the whole page. `site.js` only adds things that need a script to
exist at all: search, the theme button, the notice.

Three things on those pages come from `src/config.js` rather than being typed
into the page: who runs the site, the site's address, and the reply-time
promise. `scripts/stamp_pages.py` writes them into the HTML:

```bash
python3 scripts/stamp_pages.py           # after changing the site block in src/config.js
python3 scripts/stamp_pages.py --check   # changes nothing; says what is out of date
```

It also writes, for every page, the canonical address, the tags a shared link
is drawn from (one image, `icons/social.png`, 1200 by 630, made by
`scripts/make_social_image.py`), `noindex` on the pages that should stay out
of search results, breadcrumb data for search engines, and the two files
`robots.txt` and `sitemap.xml`. A page's title and description are written by
hand at the top of the page; the script reads them. Running it twice changes
nothing, and the pre-launch check fails if it has not been run.

Some sentences are only true in some set-ups: "there are no analytics" while
visit counting is off, a different sentence while it is on. Both wordings are
written in the page, each marked `data-needs="..."`, and the script puts the
one that does not apply inside an HTML comment (`<!--off ... off-->`). So the
page never says both, to a browser or to anything that only reads the HTML,
and the other wording is still there for the day the set-up changes.

The same goes for the few sentences a script decides when to show: the
storage notice and what the contact form says when a message will not send
are written in the page, hidden, and the script only reveals them.

The planner itself (`/app`, and `/demo`) is the exception, and cannot be
otherwise. It is an application: it draws a week from a plan that is stored in
the visitor's own browser, so there is nothing on the server to turn into HTML
ahead of time, and nothing in it that belongs in a search result. Both pages
say so with scripts off, link to the pages that are plain text, and ask search
engines not to index them.

Links between pages are ordinary `<a href>`, written from the root of the
site with the file name (`/privacy.html`), and so are the stylesheets and
scripts. That way a page still works when it is reached at its clean address
with a slash on the end (`/privacy/`), and the 404 page works at any depth.
The canonical address of each page is the clean one (`/privacy`), which
Netlify serves from the same file.

### The worked example on the homepage

"A sample week, worked through" is copied from the demo with the clock held
at a Sunday at 6:00pm: the assignments and activities are the sample data in
`src/panel/mock.js`, and every number in it (the total per day, when each
thing is finished, what did not fit) is what the planner produced. The
student is made up and the page says so. If the planner's rules change, the
example has to be copied again; nothing checks it automatically.

## Before launch

```bash
python3 scripts/prelaunch_check.py
```

It checks the launch gates (custom domain, favicon on every page, no "made
with" tag, privacy and terms pages that name who runs the site), the house
style (no gradients, no pill-shaped controls, no em dashes or emoji in anything
a person reads, no scroll or cursor animation beyond the two allowed by name,
nothing that looks like a secret), a few things that have to stay true as
the site changes (the theme script loads before the styles on every page, the
"site updated" date is not older than the pages, the visit counter and the
privacy page agree), and what it takes to be found and shared (a title, a
description and a canonical address of its own on every page, the sitemap and
`robots.txt`, the share image, text that is in the HTML, and every link from
one page to another going somewhere that exists). `LAUNCH.md` has the steps
only the owner can do.

## What has and has not been tested

Tested in a browser against the code in this repository:

- The planner, the day model, and every sentence in the assistant's on-device
  reader, including undo.
- Sign-in, sync between two devices, and what sync leaves out, against the mock
  backend in `scripts/devserver.py`. Sign-in by a code of six digits and of
  eight, a wrong code, and a code that has run out. Sign-in by a link: the
  session is taken out of the address, a new account is asked for a name, a
  link that has run out says so, a link for a different account is refused
  while someone else is signed in, and a link pasted into a page that is
  already open works. The two refusals a new Supabase project gives (an
  address it may not email yet, and too many emails) each show a sentence a
  person can act on. A secret key in `src/config.js` leaves accounts off.
- The server function's checks (auth, limit, body validation, what it forwards)
  with Anthropic stubbed out.
- The assistant on Gemini, end to end with Google and Supabase stood in for:
  the app's own loop, through the real server function, to a stand-in for
  Gemini that refuses a request whose signatures do not come back exactly, as
  Google's does. Two tool calls in one reply, the plan changed by both, the
  answer shown; a follow-up sending the whole history with every signature;
  the key only in a header; a busy, a broken and a malformed reply each
  falling back with a plain message and no detail from Google; the assistant
  staying off without `GEMINI_TIER`; and a block smuggling in a file part
  or an unknown tool refused.
- The Claude tool loop with a scripted model: message order, echoing replies
  unchanged, tool results, rollback on failure.
- The public pages and the app at phone and desktop widths, light and dark:
  text sizes, nothing wider than the screen, tap areas of 44px, no console
  errors. Search, the menu, the notice, back to top, copy, Show / Hide, the
  form error and success lines, resending a sign-in code, and Undo on the
  removals that have it.
- The visit counter end to end against the mock, and the server function's
  checks (wrong origin, bad labels, oversized bodies, a failing database) with
  the database stubbed out.
- Print, by switching the print rules on in a browser window. Not on paper.
- The public pages with scripts switched off (in a sandboxed frame): all the
  text, the links and the contact form are there, and no button is dead.
- The contact form against the local stand-in for Netlify Forms: errors under
  the fields, the sending state, a failed send keeping the message, a sent
  one landing on the thank-you page, and a plain form post with no script.
- The 404 page at a made-up address three folders deep, including its search.
- The header at widths from 320 to 1440 pixels on every public page, with
  the menu open where there is one, in light and dark.
- Pages reached at a clean address with a slash on the end (`/privacy/`,
  `/app/`), which is where relative links would have broken.
- The pre-launch check itself, against 42 deliberately altered copies of the
  site: 39 broken in one way each (a dead link, a missing canonical, a
  duplicate title, an em dash written as an entity, and so on), which it
  caught, and 3 changed harmlessly, which it let pass. Its database checks
  against 40 more: 36 broken (a table not granted, an action or a column
  missing from a grant, the app setting a column it may not, something
  granted to people who are not signed in, a secret key, a link between two
  tables not named, a policy that reads its own table, a policy, trigger or
  limit that would stop the file running twice), and 4 fine (the real
  project's key, an older anon key, the grants in another order, nothing set).
- The live Supabase project (October 2026). `schema.sql` was run on it
  twice, the second time over the first, and what the project holds was
  compared with the file byte for byte. Three test accounts then went
  through everything the app does and everything it must not allow, as the
  API would run it, in transactions that were rolled back: 43 checks, all
  passing (each plan private, saves refused over a newer version, invites
  working once, check-ins and nudges only within someone's crew, a stranger
  seeing nothing in any table, account deletion removing the account,
  profile and plan). Over HTTP with the public key, every table and account
  function refused someone who is not signed in, and the crew feed's old
  request failed on the live API exactly as the fix expected.
- Three independent reviewers then attacked the live database and the code
  that talks to it, each from one side (privacy, abuse, and whether every
  request returns what the code reads). What they found was fixed: a check-in
  meant for one club showed in every club its author was in; any member could
  post as the club; one leader could break Crew for all members with a bad
  weekly target; nothing limited size or how many a day; one account could
  use up the assistant for everyone; future-dated check-ins counted forever;
  an invite came back to life when its user deleted their account; the team
  ring left out the person looking; joining a club did not open it; and
  signing out on one device signed out every device. 40 further checks on the
  live database cover each fix, and the original 32 still pass.
- `scripts/stamp_pages.py` with an empty address, a name with an apostrophe,
  an accent and an ampersand in it, and a setting that was commented out.

Not yet run against the real services, because that needs accounts and keys
only the owner can create:

- A real sign-in email arriving in a real inbox, and a real session in the
  app. The database side of the live project is tested (above); the email
  side needs the owner's own inbox.
- A live Gemini key or a live Anthropic key: the assistant actually talking
  to Gemini or Claude. The Gemini request was written from Google's reference
  for `generateContent` (October 2026) but has only met the stand-in.
- A Netlify deploy of the functions.
- Google Calendar with a real OAuth client.
- `count_visit()` in a real Postgres (it has only been read, not run).
- A screen reader, and a real phone. The checks above are measurements in a
  desktop browser set to a phone's size.
- Netlify Forms. The contact form has only met the stand-in in
  `scripts/devserver.py`; whether a real message arrives depends on form
  detection being switched on in Netlify (see `LAUNCH.md`).
- Anything a search engine or a chat app does with the pages. The live site
  is behind Netlify's visitor access protection, so it could not be fetched
  the way a crawler would fetch it.

## Files

```
index.html, site.css, site.js            homepage, and what all the public pages share
contact.html, thanks.html, 404.html      the contact form, where it lands, and the page for a wrong address
robots.txt, sitemap.xml                  written by scripts/stamp_pages.py; do not edit by hand
icons/social.png                         the picture a shared link shows
src/panel/theme.js                       light or dark, decided before the page paints
DESIGN.md                               the design system: tokens and the rules behind them
app.html, demo.html                      the planner, and the planner with sample data
privacy.html, terms.html                 legal pages
netlify/functions/agent.mjs              the assistant's server side
netlify/functions/visit.mjs              counts visits from labelled links (off by default)
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
src/lib/agentspec.js, agentllm.js        the model's instructions, tools, the loop
src/lib/gemini.js                        the conversation in and out of Gemini
src/lib/cloud.js                         sign-in and sync
src/lib/sources/                         Canvas feed, Google Calendar, sync runner
supabase/schema.sql                      database tables and security policies
scripts/devserver.py                     local server with mock backends
scripts/stamp_pages.py                   writes config values, canonical and share tags, robots.txt and the sitemap
scripts/make_social_image.py             draws icons/social.png (needs Pillow; only when the picture should change)
scripts/prelaunch_check.py               launch gates, house style, and whether the site can be found and shared
```
