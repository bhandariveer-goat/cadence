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

## 3. Email sign-in and sync (optional, but the login is local-only without it)

1. Create a project at supabase.com.
2. SQL editor → paste all of `supabase/schema.sql` → Run.
3. Authentication → Providers → Email → enabled. Then Authentication → Email
   templates → Magic Link: make sure the template includes `{{ .Token }}`.
4. Project settings → API: copy the Project URL and the `anon` `public` key
   into `src/config.js` (`supabaseUrl`, `supabaseAnonKey`). Do not copy the
   `service_role` key anywhere.
5. Sign in on the site with your own email and check the code arrives.

## 4. The assistant with Claude (optional)

Without this the assistant still reads plain sentences on the device.

1. Get an API key at console.anthropic.com and set a monthly spend limit there.
2. Netlify → Project configuration → Environment variables → add
   `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`. Scope: Functions.
3. Redeploy. Sign in with an email, open the assistant, and send a message.
4. Decide on `AGENT_DAILY_LIMIT` (default 60 per account per day) and
   `AGENT_DAILY_TOTAL` (default 1500 across all accounts per day). Every
   request costs money on your Anthropic account; the second number is the
   most a single day can cost, whatever anyone does.

## 5. The Chrome extension

1. `chrome://extensions` → Developer mode → Load unpacked → this folder.
   After pulling a new version, press the reload arrow on the extension's
   card, then reload any open Canvas tab.
2. If you set up the server function, put the full address of the site in
   `src/config.js` as `agentEndpoint` (for example
   `https://your-domain/api/agent`) so the extension can reach it.

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
2. Netlify → Environment variables: `SUPABASE_URL` and `SUPABASE_ANON_KEY`,
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
