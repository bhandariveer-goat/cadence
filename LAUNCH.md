# Launching Cadence

The site does not launch until every line of this passes:

```bash
python3 scripts/prelaunch_check.py
```

Most of it already does. What is left needs accounts, a purchase, or a decision
that only the owner can make.

## 0. Let people in

Right now the site at `cadenceaiplanning.netlify.app` answers "This site is
private" to anyone who is not signed in to your Netlify team. That is
Netlify's visitor access protection, and while it is on nobody else can open
the site: not a classmate, not a search engine, not the preview a chat app
draws when a link is pasted.

Netlify → your site → Site configuration → Access & security → Visitor
access (if it is not there, it is set for the whole team under Team settings
→ Access & security). Turn the protection off when you are ready for other
people to see the site. Until then everything below can still be set up.

## 1. A custom domain

1. Buy a domain (Netlify sells them, or use any registrar).
2. Netlify → your site → Domain management → Add a domain. Follow its DNS
   steps and wait for the certificate (HTTPS) to show as active.
3. In `src/config.js` set `site.domain` to the domain, with no `https://`.
   It holds the Netlify address for now, which works but is not the launch
   address.
4. Run `python3 scripts/stamp_pages.py` and commit what it changes. The
   address is written into every page's canonical tag, the share tags,
   `robots.txt` and `sitemap.xml`, and none of those follow the config by
   themselves.

## 2. Who runs it

In `src/config.js` fill in:

- `site.operator`: the name that should appear on the privacy and terms pages.
- `site.contactEmail`: an address people can write to about their data. Use
  one you are happy to publish; it is shown on a public page. Setting it also
  turns on the Contact button in the corner of the public pages and the
  Contact link inside the app.

Run `python3 scripts/stamp_pages.py` after filling these in, so the pages say
them without waiting for a script.

Then read `privacy.html` and `terms.html` from top to bottom. They were written
to match what the code does, but they are a draft: have an adult you trust (a
parent, a teacher, ideally someone who knows the law where you live) read them
before they go live, especially the age section and the liability section.

## 3. Accounts in Supabase: sign-in, and every plan saved

Without this step an account is a name kept in one browser. With it, people
sign in with an email, and their account, their plan and everything in Crew
are stored in a Supabase project that you own, so the extension and the
website show the same week.

**Done on 2026-10-13:** the project exists and the database is set up. It
is called `cadence` (`bfflfqtgqdlhtvwspynv`, region West US, free plan) in
your Supabase organization, `supabase/schema.sql` has been run on it, and
its address and publishable key are in `src/config.js`. What is left is 3b and
3c. The steps below say how it was done, for setting up another copy.

### 3a. The project and the database

1. Create a project at supabase.com. The free plan is enough to start. Pick
   the region closest to your users. It asks for a database password: save it
   in a password manager; Cadence never needs it.
2. SQL editor → New query → paste all of `supabase/schema.sql` → Run. If it
   asks you to confirm because the query drops things, confirm: it only drops
   and remakes its own policies and trigger, never a table or anything
   saved. It should end with "Success. No rows returned". The file makes the tables,
   the rules that keep one person's plan from another's, and the permissions
   the app needs. Supabase projects differ in what they allow by default, so
   the file's last section sets that exactly. It is safe to run again
   whenever the file changes.
3. Connect (top of the project) or Project settings → API keys. Copy two
   things into `src/config.js`:
   - the Project URL (`https://xxxx.supabase.co`) into `supabaseUrl`
   - the **publishable** key (starts with `sb_publishable_`) into
     `supabaseKey`. On an older project the same thing is called the `anon`
     key and starts with `eyJ`.

   Never copy the **secret** key (`sb_secret_`) or the `service_role` key
   anywhere in this folder. `src/config.js` is public. Cadence refuses to
   turn accounts on if it finds one of those there, and the pre-launch check
   fails.
4. Run `python3 scripts/stamp_pages.py`. The homepage has a sentence about
   signing in that is only shown once accounts exist.

### 3b. Where a sign-in may return to

Authentication → URL Configuration:

- Site URL: `https://cadenceaiplanning.netlify.app/app` (your own domain
  instead, once you have one).
- Redirect URLs: add `https://cadenceaiplanning.netlify.app/**`. While you
  test on this computer also add `http://localhost:8123/**`.

When you move to a custom domain (step 1), change both. A sign-in link that
points anywhere not on this list is sent to the Site URL instead.

### 3c. The sign-in email

**Decided:** until launch, Supabase's built-in email, which only you can
receive. At launch, Resend, sending from your own domain, with a code in
every email. Resend's free plan is 3,000 emails a month and 100 a day, which
is far more than sign-ins need: a person gets an email only when they sign
in on a new device or after signing out.

Authentication → Sign In / Providers → Email must be enabled (it is by
default). A new account is made with a code Supabase emails to the person,
then a password they choose; after that they sign in with the email and the
password, or ask for a code if they forgot it. A code works once and for an
hour, and a person can ask for a new email once a minute.

In the same Email settings, set **Minimum password length** to 8 (Cadence asks
for at least 8, and Supabase's default is 6), and leave **Confirm email** as
it is: the code already proves the address. **Secure password change** can be
on or off; with it on, changing a password later asks for an emailed code,
which Cadence handles. The **Reauthentication** email template should show
the code with `{{ .Token }}` (its default does).

**Out of the box, only you can sign in.** Supabase's built-in email is for
testing. It delivers only to the email addresses of people in your Supabase
organization (at first, just the address you signed up to Supabase with),
and sends at most two emails an hour. Anyone else who tries is told, in
Cadence, that the project cannot email their address yet. That is enough to
try everything yourself, on the website, by pressing the link in the email.

**For anyone else to sign in, connect Resend.** Do step 1 (the domain) first;
Resend will only send from a domain you have proved you own.

1. Make an account at resend.com. Domains → Add Domain → use a part of your
   domain just for this, such as `mail.yourdomain.com`. Add the DNS records it
   shows at the place you bought the domain, then Verify.
2. Resend → Integrations → Supabase → connect, and pick the `cadence` project
   and that domain. It fills in Supabase's SMTP settings for you. (By hand
   instead: Supabase → Authentication → Emails → SMTP Settings → Enable
   custom SMTP; host `smtp.resend.com`, port 465, user `resend`, and a Resend
   API key as the password. That key goes only into Supabase, never into
   this folder. Sender: `Cadence <signin@mail.yourdomain.com>`.)

Then, in Supabase:

1. Authentication → Emails → Templates. Two templates are used, and both
   need changing: **Confirm signup** goes to someone signing in for the first
   time, **Magic Link** to someone who has signed in before. In each, make
   the body say the code, for example:

   ```
   <h2>Your Cadence sign-in code</h2>
   <p>{{ .Token }}</p>
   <p>Type it into Cadence. It works once.</p>
   ```

   `{{ .Token }}` is the six-digit code. You can keep the link
   (`{{ .ConfirmationURL }}`) as well; Cadence accepts either. On the free
   plan the templates can only be edited once custom SMTP is on.
2. Authentication → Rate Limits. With your own email service the limit
   starts at 30 emails an hour, which is enough to begin with. Raise it
   before a whole class signs in during the same lesson.
3. Add Resend to the table of other companies in `privacy.html` (it is
   given each person's email address and the email, so it can deliver it),
   change that page's "Last updated" date, and do step 9.

**What is set up now (2026-10-15):** sign-in emails go out through a Gmail
account made for Cadence (Supabase → Authentication → Emails → SMTP Settings:
`smtp.gmail.com`, port 587, an app password). The privacy page says so. A
free Gmail sends about 500 emails a day, and some may land in spam. When you
have a domain, switch to Resend as above and update the privacy page again.

**The extension needs the code.** A link opens the website and signs in
there; it cannot sign in the panel inside Canvas. Until the emails carry a
code, sign in on the website, and use the extension with a name only.

### 3d. Check it

1. Open `/app` on the site, enter your own email, and sign in with what
   arrives. Add an assignment.
2. Supabase → Table editor → `planner_state`: one row, yours. Authentication
   → Users: you.
3. Open the site in a different browser, sign in with the same email, and
   the assignment should be there.
4. Account → Delete my data, then look again: the row and the user are gone.

If signing in works but the plan does not save, and the browser's console
shows "permission denied for table", step 2 was skipped or failed part of
the way: run `schema.sql` again and read its output.

Supabase → Advisors → Security Advisor lists some warnings, and they are
expected:

- "Signed-In Users Can Execute SECURITY DEFINER Function" for
  `accept_invite`, `create_club`, `join_club`, `club_members_progress`,
  `my_club_overview`, `bump_agent_usage`, `delete_my_account`, `is_connected`
  and `my_club_ids`, and "Public Can Execute" for `count_visit`. These are
  the functions the app calls on purpose; each checks who is asking.
- "RLS Enabled No Policy" for `agent_usage` and `visit_counts`. Nobody may
  touch those tables except through their functions; no policy is the point.

Anything else there is new and worth reading.

### What is and is not kept in Supabase

Kept: the email address, the name, the plan (assignments, activities, times
you are busy, settings, check-ins), and Crew (partners, clubs, shared
check-ins, kudos, nudges, posts). Supabase also keeps its own log of
sign-ins with the IP address and browser of each (Authentication → Audit
Logs); the privacy page says so.

Never sent there, on purpose: an Anthropic key someone adds, their Google
Calendar connection and its events, and their Canvas feed link. Those are
credentials or other people's data, and they stay on the device where they
were set up. `portable()` in `src/lib/cloud.js` is what leaves them out.

## 4. The assistant (optional)

Without this the assistant still reads plain sentences on the device. With it,
anyone signed in gets an AI model that understands whatever they type and
changes the plan through the same steps they could take themselves.

`assistant` in `src/config.js` names the company that answers: `groq`,
`gemini` or `claude`. The server function uses that one and no other, and
the privacy page names the same company (run `python3 scripts/stamp_pages.py`
after changing it). It is set to `groq`.

### Groq (the setting now)

Groq may not train on what it receives (its Services Agreement, section 4.2)
and stores nothing once zero data retention is on. That is what would let the
assistant read a student's Gmail under Google's rules if `emailToAssistant` in
`src/config.js` were switched on; it is off, and Cadence finds events in email
on the student's computer instead, with no AI company involved
(`docs/GOOGLE_VERIFICATION.md`). Groq also allows apps used
by people under 18 (the app's owner answers for the law), unlike Gemini's
terms. Its agreement does say the person who holds the Groq account must be 18
or older.

**It is not free to run.** Signing up costs nothing, but Groq's free plan
allows 8,000 tokens a minute per model, counting the reply, and one Cadence
question is more than that (below), so on the free plan the assistant cannot
answer at all. Move the Groq account to the **Developer plan** (pay per token,
roughly a cent or so a question at Groq's prices; set a spend limit there).
Students with their own Anthropic key are not affected by any of this.

1. console.groq.com → **Settings → Data Controls** → turn on **Zero Data
   Retention**. Without it Groq may keep messages for up to 30 days to
   troubleshoot and check for abuse, and the privacy page would be wrong.
2. console.groq.com → **API Keys** → create a key.
3. Check it before deploying, from this folder:
   `read -s GROQ_API_KEY && export GROQ_API_KEY && python3 scripts/groq_check.py`
   (`read -s` takes the key without showing it or saving it in your shell
   history). It reports whether tool calling works, and whether a plain
   question (and, if email reading for the assistant is ever switched on, one
   that has read email) fits the plan's per-minute limit.
4. Netlify → Project configuration → Environment variables, scope Functions:
   - `GROQ_API_KEY`: the key. Paste it there and nowhere else: not into a
     file in this folder, not into a chat or an email. The pre-launch check
     fails if anything shaped like a Groq key (`gsk_...`) is in the code.
   - `GROQ_RETENTION`: `zero`. Your word that step 1 is done. Without it the
     assistant stays off, so Groq never runs with retention on.
   - `SUPABASE_URL` and `SUPABASE_KEY`: the same Project URL and publishable
     key as in `src/config.js` (step 3).
   - Optional: `GROQ_MODEL` to try another model; the default is in
     `src/lib/groq.js`. If email reading for the assistant is ever switched
     on, it runs only with Groq's production models (`GROQ_PRODUCTION_MODELS`
     there).
5. Then do the steps under "Every set-up" below.

What a plan allows is set per model and shown by `groq_check.py`. A question
costs one model request for each tool step, and each request carries Cadence's
instructions, the student's week and the chat so far (about 6,600 tokens),
plus room for a 1,500-token reply.
When the plan is too small for a request, students see "The AI could not be
reached" and the on-device reader answers instead; when it is busy, "The AI is
busy right now".

### Gemini

**Read this first.** Google's Gemini API terms say the API is for people 18
and over, and may not be part of a service "directed towards or ... likely to
be accessed by individuals under the age of 18". Cadence is made for
high-school students, so Google could switch the key off because of it.

1. Set `assistant: 'gemini'` in `src/config.js` and run
   `python3 scripts/stamp_pages.py`.
2. **Optional, and better for students:** aistudio.google.com → Projects. In
   your key's project, press **Set up billing**. On the paid plan Google says
   it does not use what students type to improve its products. On the free
   plan, Google may use it and people at Google may read it, and the privacy
   page says so. The assistant reads no email on either plan while
   `emailToAssistant` is off in `src/config.js`. If you do
   turn billing on: AI Studio → Spend → Monthly spend cap → Edit spend cap.
3. Netlify, scope Functions: `GEMINI_API_KEY` (the key, there and nowhere
   else) and `GEMINI_TIER` (`free` while the key has no billing, `paid` once
   it does; without it the assistant stays off), plus `SUPABASE_URL` and
   `SUPABASE_KEY`. Optional: `GEMINI_MODEL`.
4. Then do the steps under "Every set-up" below.

The model is `gemini-3.5-flash-lite`, named in `src/lib/gemini.js`: fast enough
for Netlify's 10-second limit.

### Claude

Set `assistant: 'claude'` in `src/config.js`, run `python3 scripts/stamp_pages.py`,
and set `ANTHROPIC_API_KEY` in Netlify (from console.anthropic.com, with a
monthly spend limit set there) with the two `SUPABASE_` variables. Claude
costs money for every message.

### Every set-up

1. So people using Cadence with only a name get the assistant too: Supabase →
   Authentication → Sign In / Providers → **Allow anonymous sign-ins** → on,
   and save. Each such browser gets a hidden account that the database lets do
   nothing but be counted, so the daily limits apply to them too. Supabase's
   Security Advisor then shows "Anonymous sign-ins enabled"; that is expected.
   Unused ones are removed after 30 days.
2. Redeploy (Deploys → Trigger deploy). Sign in on the website with your
   email, open the assistant and send "I have dinner at 6 then I want to
   work". The reply should come in a few seconds and the plan should change.
   If it answers the way it did before, the on-device reader answered: check
   the variables and that the deploy finished.
3. Decide on `AGENT_DAILY_LIMIT` (default 60 per account per day) and
   `AGENT_DAILY_TOTAL` (default 1500 across all accounts per day). The second
   is the most requests a single day can make, whatever anyone does,
   including people making many hidden accounts.
4. Letting more than 100 students connect Gmail (to find events in their
   email) needs Google's verification: `docs/GOOGLE_VERIFICATION.md` has
   everything to submit, and the question to ask Google about the security
   assessment.

## 5. The Chrome extension

1. `chrome://extensions` → Developer mode → Load unpacked → this folder.
   After pulling a new version, press the reload arrow on the extension's
   card, then reload any open Canvas tab.
2. If you set up the server function, put the full address of the site in
   `src/config.js` as `agentEndpoint` (for example
   `https://your-domain/api/agent`) so the extension can reach it.
3. To publish it on the Chrome Web Store, follow `STORE.md`. It has the
   listing, the permission explanations the store asks for, and
   `scripts/package_extension.py`, which builds the zip to upload. Once it is
   published, put its address in `site.extensionUrl` so the homepage shows an
   "Add to Chrome" button, and its ID (the last part of that address) in
   `extensionId`, so the website can show the events the extension finds in
   email. If the site's address changes, change `externally_connectable` in
   `manifest.json` to match (the claims check fails until they do).

### Anonymous usage data

`site.countUsage` in `src/config.js` is on. Before the site that sends it is
deployed, the database needs its half:

1. In Supabase, **SQL editor**, paste `supabase/usage_check.sql` and run it,
   then the same with `supabase/ux_check.sql`. Each should end with
   `ERROR: ROLLED BACK: every check passed`, which is success (they keep
   nothing). Any other error means the SQL needs a fix.
2. Apply the usage section of `supabase/schema.sql` the way the rest of the
   schema is applied (below).
3. `SUPABASE_URL` and `SUPABASE_KEY` are already on the server for the
   assistant; `netlify/functions/metric.mjs` reads the same two.
4. After a deploy, open Cadence, then in the SQL editor run
   `select * from usage_events order by day desc limit 5;`. There should be an
   `active` row, and `select kind, name from ux_events order by at desc limit 10;`
   should show the screens and presses from that visit.
   `supabase/ux_reports.sql` and `supabase/usage_queries.sql` have the reports.
5. To read them as charts instead: sign in to Cadence with your email, finish
   setup, and in the SQL editor run
   `insert into owners select id from auth.users where email = 'you@example.com';`
   with your address. Then open `/app?insights=1` on the site. Anyone else who
   opens it is told it is not theirs.

To turn counting off instead, set `countUsage: false` and run
`python3 scripts/stamp_pages.py` and `python3 scripts/claims_check.py --markdown`:
nothing is sent, and the pages say there are no analytics. (CLAIMS.md lists only
the claims that apply to the current setting, so it is regenerated each time.)

### Updating the database before the site

When `supabase/schema.sql` changes, apply it to the Supabase project before
the new version of the site goes live. The server functions call the
database's functions by name and with their current arguments; new code
against an old database fails (the assistant would answer "Could not check
your usage"), while old code against a new database keeps working. The whole
file can be run again safely.

## 6. The contact form

The contact page posts to Netlify Forms, which is part of Netlify. The free
plan includes a number of messages a month; Netlify's pricing page has the
current figure. It does nothing until you switch it on:

1. Netlify → your site → Forms → Enable form detection (on some accounts it
   is under Site configuration → Forms). Then trigger a new deploy (Deploys →
   Trigger deploy), because Netlify finds the form when it builds the site.
2. After the deploy, Forms should list one form called `contact`.
3. Forms → Settings and usage → Form notifications → add an email
   notification to your own address, so a message reaches you without you
   having to look.
4. Send yourself a message from `/contact` on the live site. You should land
   on the thank-you page, the message should appear under Forms, and the
   email should arrive.

Until step 1 is done, sending the form fails. With scripts on, the page says
so and keeps the message in the box; with scripts off the visitor gets the
"page does not exist" page. So do not link people to the contact page before
this works.

Two promises are made on that page in your name. Keep them, or change them:

- **"We reply within a week."** It comes from `site.replyWithin` in
  `src/config.js`. Change the words there and run the stamp script.
- **A message is deleted if its sender asks, in both places.** In Netlify →
  Forms → the message → Delete, and the copy Netlify emailed you, from your
  inbox and its trash.

The privacy page also says what Netlify keeps with a message (the address and
browser it was sent from) and that Netlify checks it for spam with Akismet.
That is how Netlify Forms is documented to work; if you ever move the form to
another service, that paragraph has to change with it.

## 7. Being found, once the site is open

1. Paste the address of the homepage into a chat with yourself (Messages,
   Discord, Slack). A card with the picture in `icons/social.png` should
   appear. If an old card shows, the app cached it; try a different app.
2. If you want Google to list the site: search.google.com/search-console →
   add the site → Sitemaps → submit `sitemap.xml`. It lists the homepage,
   privacy, terms and contact. The planner and the demo are left out on
   purpose.

## 8. Counting visits from shared links (optional, and off)

Leave this alone and the site counts nothing: a label on a link
(`?utm_source=newsletter`) is removed from the address and forgotten.

Turning it on is a decision about what the privacy page says, so make it on
purpose:

1. Do step 3 first; the counts are kept in the same Supabase project. If you
   ran `schema.sql` before this section existed, run it again. It is safe to
   run twice.
2. Netlify → Environment variables: `SUPABASE_URL` and `SUPABASE_KEY`,
   scope Functions (the same two the assistant uses).
3. In `src/config.js` set `site.countVisits` to `true`, and deploy.
4. Open the site once from a labelled link, for example
   `https://your-domain/?utm_source=test`, then look at Supabase → Table
   editor → `visit_counts`. There should be one row for today.
5. Read the "Cookies and tracking" section of the privacy page on the live
   site. Its wording changes when the switch is on. Make sure you are happy to
   stand behind it.

What you get is a number per label per day. It is an estimate: nothing about
the visitor is kept, so the same person on two days is two, and anyone can
send the request by hand.

## 9. When you change a public page

The footer of every public page shows the date the site was last changed. It
comes from one line, `SITE_UPDATED`, near the top of `site.js`. Change it in
the same commit as any change to those pages, then run
`python3 scripts/stamp_pages.py`, which writes the date into each footer and
into the sitemap. The check below fails if the date is older than the pages,
or if the script has not been run. If you change what the privacy policy or
the terms actually say, also change the "Last updated" date at the top of
that page.

A new public page needs four things: its own title and description at the
top, a line in the `PAGES` list in `scripts/stamp_pages.py`, an address in
`netlify.toml`, and a link to it from somewhere.

## 10. Check, then announce

```bash
python3 scripts/prelaunch_check.py
```

All checks passing, the privacy and terms pages read by someone you trust, and
you have signed in and used it for a day yourself.
