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

## 4. The assistant with Gemini (optional)

Without this the assistant still reads plain sentences on the device. With it,
anyone signed in with an email gets an AI model that understands whatever they
type and changes the plan through the same steps they could take themselves.

**Read this first.** Google's Gemini API terms say the API is for people 18
and over, and may not be part of a service "directed towards or ... likely to
be accessed by individuals under the age of 18". Cadence is made for
high-school students. Using Gemini here was a deliberate choice, and Google
could switch the key off because of it. The server function still supports
Claude, whose maker allows products used by people under 18 when they add
safeguards: remove `GEMINI_API_KEY` and set `ANTHROPIC_API_KEY` to switch,
with no change to the code.

1. **Optional, and better for students:** aistudio.google.com → Projects. In
   your key's project, press **Set up billing**. On the paid plan Google says
   it does not use what students type to improve its products. On the free
   plan, which you chose to start with, Google may use it and people at Google
   may read it, and the privacy page says so. Free also has lower rate
   limits, so a class using it at once may see "busy".
2. If you do turn billing on: AI Studio → Spend → Monthly spend cap → Edit
   spend cap. New accounts pay in advance (Prepay), which limits spending to
   the credit bought.
3. Netlify → Project configuration → Environment variables, scope Functions:
   - `GEMINI_API_KEY`: the key. Paste it there and nowhere else: not into a
     file in this folder, not into a chat or an email. The pre-launch check
     fails if anything shaped like a Google key appears in the code.
   - `GEMINI_TIER`: `free` while the key has no billing, `paid` once it does.
     Without it the assistant stays off, so using Gemini is always a choice.
     The privacy page is written for the free plan, which is the worse case
     and so stays true after you upgrade.
   - `SUPABASE_URL` and `SUPABASE_KEY`: the same Project URL and publishable
     key as in `src/config.js` (step 3).
4. So people using Cadence with only a name get the assistant too: Supabase →
   Authentication → Sign In / Providers → **Allow anonymous sign-ins** → on,
   and save. Each such browser gets a hidden account that the database lets do
   nothing but be counted, so the daily limits apply to them too. Supabase's
   Security Advisor then shows "Anonymous sign-ins enabled"; that is expected.
   Unused ones are removed after 30 days.
5. Redeploy (Deploys → Trigger deploy). Sign in on the website with your
   email, open the assistant and send "I have dinner at 6 then I want to
   work". The reply should come in a few seconds and the plan should change.
   If it answers the way it did before, the on-device reader answered: check
   the three variables and that the deploy finished.
6. Decide on `AGENT_DAILY_LIMIT` (default 60 per account per day) and
   `AGENT_DAILY_TOTAL` (default 1500 across all accounts per day). The second
   is the most requests a single day can make, whatever anyone does,
   including people making many hidden accounts.

The model is `gemini-3.5-flash-lite`, named in `src/lib/gemini.js`: fast enough for Netlify's 10-second limit, and with a larger free allowance than `gemini-3.8-flash`, which ran out after a few messages. To try another, set `GEMINI_MODEL` in Netlify (for example `gemini-3.8-flash`, which is smarter but slower and needs billing to be usable).

To use Claude instead, do the same with `ANTHROPIC_API_KEY` (from
console.anthropic.com, with a monthly spend limit set there) in place of the
two Gemini variables, and change the privacy page's assistant section to match.

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
   "Add to Chrome" button.

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
