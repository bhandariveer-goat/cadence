# Launching Cadence

The site does not launch until every line of this passes:

```bash
python3 scripts/prelaunch_check.py
```

Most of it already does. What is left needs accounts, a purchase, or a decision
that only the owner can make.

## 1. A custom domain

1. Buy a domain (Netlify sells them, or use any registrar).
2. Netlify → your site → Domain management → Add a domain. Follow its DNS
   steps and wait for the certificate (HTTPS) to show as active.
3. In `src/config.js` set `site.domain` to the domain, with no `https://`.

## 2. Who runs it

In `src/config.js` fill in:

- `site.operator`: the name that should appear on the privacy and terms pages.
- `site.contactEmail`: an address people can write to about their data. Use
  one you are happy to publish; it is shown on a public page.

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
2. If you set up the server function, put the full address of the site in
   `src/config.js` as `agentEndpoint` (for example
   `https://your-domain/api/agent`) so the extension can reach it.

## 6. Check, then announce

```bash
python3 scripts/prelaunch_check.py
```

All checks passing, the privacy and terms pages read by someone you trust, and
you have signed in and used it for a day yourself.
