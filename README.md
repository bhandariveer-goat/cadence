# Cadence — show up for what matters

Canvas tells students what's due. Nothing keeps them accountable for
everything else: piano, the robotics build, cross-country, a job, college
essays. Cadence does. It plans that time around homework (pulled in from
Canvas automatically), keeps a daily streak, brings in friends and clubs for
accountability, and turns every check-in into an activities record for
college applications.

Runs two ways, from the same code:

- **Web app** (installable on a phone — check-ins happen right after practice)
- **Chrome extension** inside Canvas (homework syncs in, plus a launcher button)

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
index.html, manifest.webmanifest, sw.js   web app entry + offline shell
manifest.json, src/content, src/background Chrome extension
src/panel/app.js                           shell: routing, tabs, events
src/panel/core.js                          state, merged plan, Canvas, crew, check-ins
src/panel/ui.js                            icons, rings, sheets, formatting
src/panel/views/                           today, plan, crew, you, commitments,
                                           guide, create, onboarding, parts
src/lib/habits.js                          commitments, streaks, record, review
src/lib/sync.js                            crew adapters (local / demo / Supabase)
src/lib/scheduler.js, priority.js, …       planning engine
supabase/schema.sql                        crew database + security policies
```

## Not built yet

- Live Supabase sync is written against the documented REST API but hasn't been
  run against a real project.
- Push notifications on phones need a server; reminders currently come from the
  Chrome extension.
- Live "study together" sessions (Focusmate-style body doubling).
