# Value proposition, first-time experience, and how Cadence measures them

Written 2026-11-09 from research (sources at the end) and from reading what a
new student sees in the code today. The research is mostly vendor and
practitioner writing, so this keeps to what several sources agree on. Nothing
here is proof that a particular wording works: the point of the numbers below
is to find out.

## 1. Value proposition

**What it is.** A short statement of what Cadence does, for whom, and why that
beats what they do now: two or three sentences, not a slogan. A common shape is
"We help [who] do [outcome] by [how]". Everyone who writes about it says it is a
hypothesis until real customers confirm it.

**What Cadence says now** (homepage, `index.html`):

> The planner that schedules your homework. Cadence pulls your assignments from
> Canvas and plans when you'll do each one, around school, practice and sleep.
> If your day changes, tell it what happened and it rearranges the rest.

That is specific, names the outcome and the mechanism, and avoids vague hero
text. It was left as it is: changing it on a guess would be worse than
measuring it. Candidates to test against it, in a student's own words, not
Cadence's:

- For the student: *"Cadence puts your homework, practice and sleep on one
  calendar and plans the time to do each assignment, so you stop deciding what
  to do next."*
- For the teacher or club leader: *(write after talking to some; there is no
  evidence yet for what they want.)*

**How to find out which works.**

1. Ask 5 to 10 students, after they have used it for a week, how they would
   describe Cadence to a friend. Write down their exact words. The words that
   repeat are the value proposition; the homepage should use them.
2. Ask what they did before Cadence for the same job (notes app, planner,
   nothing). That names the real alternative to beat.
3. Put the winning sentence in one place and reuse it: homepage, Web Store
   listing (`STORE.md`), first onboarding screen.
4. Do not use made-up numbers, reviews or counters as proof.

## 2. First-time experience (FTUE)

**What it is.** Everything from the first touchpoint (landing page, sign-up) to
the first meaningful success. Onboarding is the longer process that follows,
over days. The useful distinction: the *aha moment* is when the student sees
the value; *activation* is the measurable action that stands for it. Sources
warn against picking an easy one (finishing a profile) because it does not
predict who stays.

**What a new student goes through today** (read from the code):

1. Homepage, "Open Cadence".
2. Sign in: a name only, or an email, with the age and terms box.
3. Onboarding, screen 1: "What do you do outside class?" (activities).
4. Onboarding, screen 2: "When is school?" (school hours).
5. Optional: "Connect your calendars" (Canvas link and others).
6. Today, empty if nothing is in yet: "Your week starts here", with a button to
   bring in Canvas and a box to type what is on.
7. A six-stop tour, once.

**What Cadence treats as activation: a plan with work in it.** That is the
earliest thing that separates "I have a planner" from "my homework is planned".
In the code it is the `has_work` milestone: the plan has at least one
assignment or one activity. It is a hypothesis. The test of it is query 5 in
`supabase/usage_queries.sql`: do installs that reached it come back at day 7
more than installs that did not? If not, move the definition later (for
example, the first check-in).

**What to look at once there are numbers.** The funnel (query 4) shows how many
reached each step. The step where it drops most is where to work. The likely
places, as guesses to check, not findings:

- Step 6 for a student with no Canvas link to hand: an empty Today is a weak
  first impression, and the instruction is to type what is on.
- Step 5, if connecting a calendar is where people stop.

**Do not change the first run on a guess.** Measure first, change one thing,
and look again.

## 3. Measuring it: anonymous usage data

**What is measured.** Three things, all after the student has agreed to the
terms and seen the notice, except the first-screen counts, which carry no ID.

1. *Counts* (`usage_events`): a random ID made by the browser and one of five
   words: `active` (used Cadence on a day, at most once a day), `onboarded`,
   `has_work`, `checked_in`, `connected` (a calendar; never Gmail). The last
   four are sent once, ever.
2. *How the app is used* (`ux_events`, from `src/panel/insight.js`): with the
   same ID and a random ID for the visit, the time used on each screen (a
   screen left alone for a minute stops counting), presses by their code name,
   presses on things that are not controls, three quick presses on one thing,
   setup and tour steps and skips, errors (kind and place in the code), how
   long the app takes to open and its own requests take, and the seconds from
   agreeing to each first milestone (time to value).
3. *The sign-up screen* (`funnel_counts`): shown, typed in, sent, got in,
   counted per day with no ID at all.

Never: a name, email, anything typed, field contents, the words on a control,
where on the screen, mouse movement or scrolling, the plan, messages, calendar
contents, error messages, or anything from email.

**Time spent is measured as time in use.** An open tab is not use, so a screen
stops counting after a minute with no press or key, and while the tab is
hidden. Reading a long screen without touching anything for over a minute is
undercounted; treat screen times as a floor.

**Reading them as charts.** Open `/app?insights=1` on the website, signed in as an
account on the `owners` list (LAUNCH.md says how to add yours). It shows the
reports below as bars and figures for the last 7, 30 or 90 days. Nothing else
can read the records: the page asks `insights()`, which refuses anyone not on
the list and returns only totals.

**The reports** (`supabase/ux_reports.sql` and `supabase/usage_queries.sql`;
paste one at a time into the Supabase SQL editor; they change nothing):

| Question | Report | Read it carefully |
| --- | --- | --- |
| Where does sign-up lose people? | ux 1 | Counts visits to the screen, not people, and cannot be joined to anything else |
| Where does setup lose people, and how long does it take? | ux 2, 3 | A reload during setup restarts its clock |
| Is the tour too long? | ux 4, 5 | A skip at stop 1 means it was in the way; late skips mean it ran long |
| Where does time go? | ux 6 | Time in use, a floor (above) |
| What is used, and what is never found? | ux 7, 8 | A control missing from both lists was never pressed |
| What looks pressable but is not? | ux 9 | Named by element and style, such as `h2.empty` |
| What looks frozen? | ux 10 | Three presses within a second on one thing |
| Is the first impression broken? | ux 11, 12 | Errors in the first five minutes of an install |
| Is it slow? | ux 13 | `open` is the time to draw the app; `api:` and `db:` are its requests |
| How long until it is useful? | ux 14 | Seconds from agreeing to the first assignment (`has_work`) and so on |
| What is the "aha" moment? | ux 15 | First-day actions against coming back in week two; correlation, not proof, and needs installs at least 14 days old |
| Where does interest run out? | ux 16 | The last screen and action of installs not seen for a week |
| Do people come back? | ux 18; usage_queries 1 to 5 | D1, D7, D30, stickiness, activation, work vs retention |

Published benchmarks (for example "20 to 25 percent at day 30 is good") vary
widely between sources and come from other kinds of app. Compare Cadence with
Cadence over time, not with a number from a blog.

**What the numbers are not.** Anyone can send the request, so they are
estimates, not a meter. A student who signs out or deletes their data gets a new
ID next time, so retention is somewhat understated. Installs are browsers: one
student on a laptop and a phone counts twice, and the website and the extension
count separately. Students who turned usage data off are not in any of it.

**The student's say.** Recording waits until they have agreed to the terms and
seen the notice (`POLICY_CHANGE` in `src/lib/policy.js`, moved to 2026-11-12
for this change, so everyone who agreed earlier is told first). Account has a
switch, "Anonymous usage data": off deletes the ID in the browser and asks the
server to delete everything recorded with it. Sign out and Delete my data do the
same. Nothing is recorded in the demo.

**Switching it on or off for the whole site.** `site.countUsage` in
`src/config.js` (on now). Off means nothing is sent and the privacy page and the
homepage say Cadence uses no analytics, by themselves, after
`python3 scripts/stamp_pages.py`. On needs the SQL in `supabase/schema.sql`
applied first (and `supabase/usage_check.sql` and `supabase/ux_check.sql` run,
to check it), the two `SUPABASE_` variables on the server, and a deploy.

## Sources

- Value propositions: [Pipedrive](https://www.pipedrive.com/en/blog/value-proposition-in-marketing-and-sales), [Invesp](https://www.invespcro.com/blog/?p=10756), [Xero](https://xero.com/us/guides/value-proposition), [Strategyzer's Value Proposition Canvas](https://www.strategyzer.com/)
- FTUE, aha moment and activation: [Userpilot](https://userpilot.com/blog/first-time-user-experience-saas/), [UXMatters](https://uxmatters.com/mt/archives/2024/08/designing-aha-moments-for-better-product-activation.php)
- Retention, stickiness, activation definitions: [Adapty](https://adapty.io/blog/dau-wau-mau-active-users/), [Gainsight](https://www.gainsight.com/product-management-metrics/dau-mau/)
- Privacy-friendly analytics, for reference: [Umami](https://docs.umami.is/docs/)
- Under-13s and persistent identifiers: [FTC COPPA FAQ](https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions)
