# Cadence — show up for what matters

Canvas tells students what's due. Nothing keeps them accountable for
everything else: piano, the robotics build, cross-country, a job, college
essays. Cadence does. It plans that time around homework (pulled in from
Canvas automatically), keeps a daily streak, brings in friends and clubs for
accountability, and turns every check-in into an activities record for
college applications.

Runs three ways, from the same code:

- **Website** — a marketing homepage at `index.html` explaining the product
- **Web app** — installable on a phone, and a full desktop layout on a laptop
- **Chrome extension** inside Canvas (homework syncs in, plus a launcher button)

The app adapts by width rather than shipping two codebases: below 768px (phone
and the 440px extension panel) it's one column with a bottom tab bar; from
768px it becomes a 240px nav rail beside a wide canvas; from 1180px a right
pane appears; the Plan tab switches from a day timeline to a full week grid.
That split follows the desktop conventions the big planners share — see
`reports/` if you kept the research report.

---

## Try the demo

```bash
cd cadence && python3 -m http.server 8123
```

Open <http://localhost:8123/src/panel/panel.html?standalone=1&demo=1> (a phone-sized
window looks best). Fiona's week: five commitments with a month of history, eight
assignments, two accountability partners, a club she's in and a club she leads.

## Install

**Chrome extension:** `chrome://extensions` → Developer mode → Load unpacked →
this folder. Refresh Canvas; the Cadence button is bottom-right.

**Web app:** serve this folder over HTTPS (GitHub Pages, Netlify, Vercel — it's
static files) and open it on a phone → Share → Add to Home Screen.

---

## What's in it

**Today** — rings for each commitment plus School (Apple's close-your-rings),
the one thing to do now with its *why* ("First chair at the spring concert"),
and the day as a single timeline. Set-time commitments ask "How was
cross-country?" once they're over.

**Check-ins** — how it felt, how long, one optional note. Fills the ring,
extends the daily streak, and adds to the record. Miss a day and a streak freeze
covers it; every 7 days earns another (max 2) — forgiveness, not shame.

**Desktop** — nav rail, week grid with every block in place, a right pane
(streak, what's coming, crew), a ⌘K command palette that searches assignments
and commitments, and keyboard shortcuts (`Q` add homework, `C` check in,
`T`/`P`/`R`/`Y` to move around, `?` for the list).

**Plan** — the week as day chips and timelines; *School* is every assignment
grouped by when to start it, each with a guide: what you're doing, what to turn
in, the steps tied to planned blocks, and where the course materials are.

**Crew** — accountability partners (see each other's weekly rings, send a
nudge), clubs and classes (a shared team ring toward the big event, leaders see
who's on track and can post updates), and a feed with one-tap kudos.

**You** — streak and hours, your commitments, **the activities record** (hours
per week, weeks per year, and a 150-character description per activity — the
Common App's format, built from your check-ins), and a two-minute **week in
review** that suggests smaller or bigger targets based on what actually happened.

**Teachers & club leaders** — dictate an assignment into Canvas, and run clubs
or classes from the same Crew screen.

## How planning works

Homework and flexible commitments go into one schedule. Flexible commitments
("piano 5× a week, evenings") become sessions pinned to specific days and
time-of-day windows; set-time commitments block their slots. The scheduler
packs earliest-deadline-first inside free time and a daily ceiling, spreads big
assignments across days, and bends its own limits one at a time before
declaring anything won't fit. Assignments more than a month past due are
dropped automatically.

## Connecting calendars (Canvas feed + Google Calendar)

Cadence's **Calendar** tab is the merged view: its own blocks, Canvas due
dates, and any calendar you connect. Whatever it can see, it plans around —
`lib/replanner.js` folds every source into the busy list the scheduler uses.

### Canvas calendar feed (no setup needed)

1. Canvas → **Calendar** → **Calendar Feed** (bottom right) → copy the link.
2. Cadence → **Calendar → Connect**, or You → Settings → Calendars → **Add feed link**.

That link is a credential — anyone holding it can read your Canvas calendar, so
Cadence stores it in extension storage and only ever shows it masked. Inside
Canvas the existing session-based sync still runs and adds what the feed can't
carry: submission status, points, instructions and rubrics.

### Google Calendar — what you must do in Google Cloud Console

Google requires an OAuth client, and only you can create it:

1. **console.cloud.google.com** → create a project (e.g. "Cadence").
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen** → **External** → fill in app name,
   your email, developer email. Add yourself under **Test users** — while the app
   is unverified only test users can sign in (up to 100), which is fine for you
   and your classmates.
4. **Scopes**: add `.../auth/calendar.readonly` for reading, and
   `.../auth/calendar.events` if you want Cadence to add its blocks to your
   calendar. Both are *sensitive* scopes: fine in testing mode, but publishing
   to everyone would need Google's verification review.
5. **Credentials → Create credentials → OAuth client ID → Web application**.
   Under **Authorized redirect URIs** paste the URI Cadence shows you in
   Calendars → Google → Connect. It looks like:
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

Off by default, and opt-in per item even when it's on — nothing appears on a
real calendar unless it's asked for.

1. Calendars → Google → **Add Cadence blocks to Google Calendar**. Google asks
   again, this time for `calendar.events` (incremental auth: the read grant is
   kept).
2. Pick which calendar to write to. A separate calendar is worth considering —
   it makes Cadence's blocks easy to hide or delete in bulk.
3. Turn it on per item: the **Add to Google Calendar** toggle in a commitment's
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

## Crew backend

Everything works on-device with no account. Partners, clubs, kudos and
cross-device sync need a shared database:

1. Create a Supabase project and run `supabase/schema.sql` in its SQL editor
   (tables, row-level security, and the invite/club functions).
2. Authentication → Email: enable, and put `{{ .Token }}` in the magic-link
   template so students get a 6-digit code.
3. In Cadence: You → Settings → Crew account → paste the project URL and anon key.

Students only ever see check-ins from their partners and clubs, and only for
commitments they chose to share.

## Cadence Intelligence (optional)

With a Claude API key (You → Settings), assignment guides are written from the
full instructions, estimates get sharper, and dictation turns into polished
drafts. Model: `claude-opus-5`.

## Files

```
index.html                                 marketing homepage
manifest.webmanifest, sw.js                installable web app + offline shell
manifest.json, src/content, src/background Chrome extension
src/panel/app.js                           shell: routing, tabs, events
src/panel/core.js                          state, merged plan, Canvas, crew, check-ins
src/panel/ui.js                            icons, rings, sheets, formatting
src/panel/views/                           today, plan, week (desktop grid),
                                           crew, you, commitments, guide,
                                           palette, create, onboarding, parts
src/lib/habits.js                          commitments, streaks, record, review
src/lib/sync.js                            crew adapters (local / demo / Supabase)
src/lib/sources/canvasFeed.js              Canvas ICS feed → assignments + events
src/lib/sources/googleCalendar.js          OAuth, events.list, and tagged writes
src/lib/sources/sources.js                 sync runner: per-source cache + errors
src/lib/replanner.js                       DOM-free merge + re-plan pipeline
src/lib/scheduler.js, priority.js, …       planning engine
supabase/schema.sql                        crew database + security policies
```

## Not built yet

- Gmail import — see the notes below on why the Apps Script route beats the API.

- Live Supabase sync is written against the documented REST API but hasn't been
  run against a real project.
- Push notifications on phones need a server; reminders currently come from the
  Chrome extension.
- Live "study together" sessions (Focusmate-style body doubling).
