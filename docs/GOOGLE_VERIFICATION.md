# Getting Google's approval for Gmail reading

What it takes for more than 100 students to connect Gmail to Cadence, what is
already done in the code, what only the owner can do, and what it costs.
Written from Google's own pages as of November 2026 (sources at the end).
Google's reviewers decide; nothing here guarantees approval.

How Cadence uses Gmail now (since 2026-11-08): the Chrome extension reads the
student's recent inbox in their browser and finds practices, games, deadlines
and schedule changes on their computer, with Chrome's built-in on-device AI or
simple matching, and adds them to their Cadence calendar (`src/lib/mailEvents.js`,
`docs/EMAIL_EVENTS_SPEC.md`). No email content is sent to Cadence's server or
to any other company. The assistant's own email reading (`read_email`) is
switched off (`emailToAssistant: false` in `src/config.js`).

## The short version

- **Google's side, up to 100 students: free, no review.** Leave the Google
  Cloud project in Testing and add each student under Test users (up to 100).
  Google shows them an "unverified app" warning. Google's page says a Testing
  project's refresh tokens expire after 7 days; Cadence uses short-lived tokens
  without refresh tokens, and whether the same weekly re-approval applies to
  them is not stated (expect students to be asked to approve again; the
  Gmail card then says "Gmail needs your approval again").
- **No AI company is involved, so there is no AI cost.** The email never
  leaves the student's computer.
- **One school: no review,** if that school's Google Workspace admin marks
  Cadence as a trusted app for their domain.
- **More than 100 students on personal Gmail accounts:** Google's full review
  for a *restricted* permission (`gmail.readonly`), about 6 weeks. Google's
  page says the security assessment is required "if you store or transmit
  restricted scope data on servers". Cadence does neither, but the page states
  no exemption for apps that keep everything on the device, so ask Google (the
  exact question is under step 5) and budget for the assessment until it says
  otherwise: about $3,000 to $6,000 a year at vendors' published prices.

## Where things stand

| Google's requirement | Status | Where |
| --- | --- | --- |
| The app's own OAuth client, so students never set one up | **Owner:** create it (step 2) and put its ID in `googleClientId` in `src/config.js`. Until then Cadence asks whoever connects for an ID of their own | `src/config.js`, `clientIdFor()` in `googleCalendar.js` |
| Ask for the narrowest scope that does the job | Done for Gmail: `gmail.readonly` only, the narrowest Gmail scope that returns message text. Calendar: see the note under step 3 | `src/lib/sources/gmail.js` |
| Ask for it in context, not at install | Done: only from **Connect Gmail** on the Calendars screen; each Google sign-in carries only its own scopes | `calendars.js`, `include_granted_scopes: 'false'` |
| A disclosure in the app, right before Google's consent screen, needing a positive action | Done: the Connect Gmail sheet says what is read (inbox text from the last two weeks, up to 25 at a time), where (on this computer, by Chrome's on-device AI or simpler matching, nothing sent to Cadence or any AI company), what is kept (the events and the sentence each came from, in this browser only), that events are added and can be deleted, and the Limited Use sentence. **Continue to Google** opens consent | `gmailConnect()` in `calendars.js` |
| Using Gmail data with AI | The AI is Chrome's own model running on the student's computer; nothing is sent to any AI company and nothing trains on it. Reading runs on its own once the student turns it on, with no per-email confirmation (see open questions) | `src/lib/mailEvents.js` |
| Protection against prompt injection | Done (see below) | `mailEvents.js`, `gmail.js` |
| No permanent copies of Gmail data | The emails themselves are not stored anywhere. Derived data, said plainly: each event found (title, date and time, the quoted sentence, the sender's name, the subject) is kept in the browser's storage on that device, never on a server or in the account; disconnecting deletes it | `state.sources.mail`, `cloud.js portable()` |
| No humans reading the data | Nothing leaves the device, so no one at Cadence can read it | claim rules `mail-no-network`, `mail-stays-on-device` |
| No AI training on the data, and the policy says so | Nothing is sent to train anything; the model runs locally (Chrome's documentation says it sends no data to Google) | `privacy.html#gmail` |
| Limited Use statement, one click from the homepage | Done: in the privacy policy's Gmail section, linked from every page's footer, and on the Connect Gmail sheet | `privacy.html#gmail` |
| Every company that receives the data named | Only Google itself (the Gmail API) | `privacy.html` |
| Telling users before data is used in a new way | Done in code: a change to who receives what is shown before the assistant is next used; the notice for this change (2026-11-08) is in `policy.js` | `src/lib/policy.js`, `policyNotice()` |
| Help on managing and deleting the data | Done: delete any event (with Undo for 15 minutes), switch automatic adding off, disconnect Gmail (deletes the events), myaccount.google.com/permissions | `views/mail.js`, `calendars.js` |
| OAuth tokens not kept at rest unencrypted | Done: Google's sign-ins (Calendar and Gmail) are held in memory only; a reading that runs by itself never opens a sign-in window | `googleCalendar.js`, `gmail.js`, claim `google-signins-not-stored` |
| A homepage that explains the app, why it asks for Google data, and the age rule | Done: the homepage's Gmail question and the privacy policy describe reading on the device | `index.html#questions` |
| The homepage and privacy policy on a domain you own, verified in Search Console | **Owner:** buy and connect the custom domain (also a launch gate), verify it | step 1 |
| Consent screen branding, scopes, justification, demo video | **Owner**, with the text and script below | steps 2 to 5 |
| Security assessment (CASA) | **Owner**: ask Google whether it applies (step 5); if it does, it is paid, when Google asks | step 6 |

`python3 scripts/claims_check.py` checks the privacy policy's promises against
the code, and eight rules about email that hold whatever the pages say
(`CLAIMS.md` lists both).

## Step by step (owner)

### 1. Domain

1. Buy a domain and connect it to the Netlify site (LAUNCH.md, step 1). A
   `*.netlify.app` address cannot be verified the way Google requires, because
   you cannot add a DNS record to it.
2. Google Search Console: add a **Domain** property (not a URL prefix) for it,
   and verify with the DNS TXT record, signed in as the Google Cloud project's
   **Owner**.
3. Set `site.domain` in `src/config.js` and run `python3 scripts/stamp_pages.py`.
   Change `externally_connectable` in `manifest.json` to the same address (the
   claims check fails until they match).

### 2. Google Cloud project and client ID

1. Use one project for the published extension and a separate one for
   development (unpacked builds have a different extension id). Delete OAuth
   clients you do not use: every client that asks for a restricted scope must
   be ready for review.
2. Credentials: create an OAuth client of type **Web application**, with the
   authorized redirect `https://<published extension id>.chromiumapp.org/google`.
   Put its client ID in `googleClientId` in `src/config.js`, and the published
   extension's ID in `extensionId` (the website then shows the events the
   extension found). A client ID is not a secret.
3. **Branding:** app name `Cadence` (the same everywhere; no Google product
   names), user support email, logo, homepage `https://<domain>/`, privacy
   policy `https://<domain>/privacy`, terms `https://<domain>/terms`,
   authorized domain `<domain>`, developer contact.
4. **Data Access:** add exactly the scopes the code asks for, and no others:
   - `https://www.googleapis.com/auth/calendar.readonly` (sensitive)
   - `https://www.googleapis.com/auth/calendar.events` (sensitive)
   - `https://www.googleapis.com/auth/gmail.readonly` (restricted)
5. **Audience:** keep it in Testing, with students as test users (up to 100),
   until the review is approved.

### 3. Scope justifications (paste these)

**gmail.readonly.** Cadence is a planner for high-school students. Its
optional Gmail feature finds the practices, games, deadlines and schedule
changes in a student's recent email and adds them to their Cadence calendar.
Cadence requests gmail.readonly only when the student chooses Connect Gmail,
after a screen that explains what is read, where it is read, and what is kept.
While Cadence is open, the extension fetches up to 25 inbox messages from the
last 14 days from gmail.googleapis.com in the student's browser (promotions,
social, forum mail, spam, trash and drafts are skipped; attachments, images
and links are never fetched) and reads up to 3,000 characters of plain text
from each. The events are found on the student's computer, by Chrome's
built-in on-device AI model or by simple matching; no email content is sent to
our servers or to any other company. Only the events found are kept (title,
date and time, the sentence each came from, the sender's name and the
subject), in the browser's storage on that device; they are never uploaded to
our database. The Cadence website, when open in the same browser, can show
those events by asking the extension inside Chrome; nothing goes over the
network. The student can delete any event, switch the feature off, or
disconnect Gmail, which deletes the events. gmail.metadata is not enough
because it excludes the message body, where the dates and times are. No send,
modify, compose or settings scope is requested because Cadence never changes
the mailbox.

**calendar.readonly.** Reads the events on the calendars the student picks,
with their titles, and the list of their calendars to pick from, so the
planner schedules homework around them and shows what each busy block is.
Events are kept on the student's device only. Free/busy information alone
would show busy times but not what each event is or which calendars exist.

**calendar.events.** Only if the student turns on "Add Cadence blocks to Google
Calendar": Cadence adds its planned work blocks to one calendar the student
chooses, tags each with a private extended property, and later changes or
removes only events with that tag. It never edits or deletes an event it did
not create, and never writes anything found in email to Google Calendar.

A note on Calendar: Google may ask why narrower scopes would not do, such as
`calendar.events.readonly` with `calendar.calendarlist.readonly` for reading,
or `calendar.events.owned` or `calendar.app.created` for writing. Moving to
those is a code change in `src/lib/sources/googleCalendar.js`; consider it
before submitting.

### 4. Demo video (unlisted YouTube link)

Record in English, with narration or captions, on the published extension:

1. Show the extension's name and the Cadence homepage on your domain, with the
   privacy policy link and the question about Gmail.
2. Calendars, then **Connect Gmail**. Pause on the explanation sheet and read
   it out: what is read, that it is read on this computer, what is kept, and
   the Limited Use sentence.
3. **Continue to Google.** Set the consent screen's language menu (bottom left)
   to English. Show the Google sign-in, then the consent screen: the app name,
   the scope listed, and the window's address showing the `client_id`. If the
   sign-in window hides its address, show it some other way (Google asks for
   the client id to be visible).
4. Back in Cadence: the Gmail card shows the connected address, then what was
   found. Open Chrome's DevTools Network panel and show that the only requests
   are to gmail.googleapis.com, reading.
5. Open the Calendar: an event labelled **From email**. Open it to show the
   email's own sentence, the sender and the subject. Delete it, and show it
   does not come back on **Check email now**.
6. Switch **Add events from email automatically** off: the events are hidden
   and nothing is read.
7. Calendars, then **Disconnect Gmail**: the events are removed from the device.
8. Repeat 2 and 3 for Google Calendar's own connect flow (calendar.readonly),
   and show "Add Cadence blocks to Google Calendar" for calendar.events.

### 5. Submit, and ask about the security assessment

Submit from the Verification Center. Google's estimate is about 6 weeks for a
restricted scope, longer if you reply slowly; a request closes after 90 days
without a reply. Reviewers may ask for changes or a narrower scope. Give them a
way to install the extension (the Chrome Web Store link) and, if they need an
account, a test account with two-step verification off.

Put this question to Google in the submission:

> All Gmail processing happens in the user's browser with an on-device model.
> No Gmail-derived data is transmitted to or stored on any server we operate
> or any third party. Please confirm the security assessment does not apply.

### 6. Security assessment (CASA), if Google says it applies

Google's Trust and Safety team emails when to start. You choose a lab on the
App Defense Alliance's list of authorized labs and agree a price with it;
Google charges nothing. Google decides the assurance level (a small new app is
likely AL1). Critical and high findings must be fixed before the lab issues
its letter. Repeat every 12 months, and when a new restricted scope is added.

What the lab will look at, and what Cadence already has:

- Data in transit over HTTPS only; a strict Content-Security-Policy
  (`netlify.toml`); no third-party scripts (claim `no-ads-or-analytics`).
- No email text at rest anywhere Cadence controls, and no Gmail data on any
  server; Google's sign-ins in memory only. Data derived from email (the
  events) is stored only in the browser's storage on the student's device.
- The server function stores and logs nothing, checks the Supabase session,
  and enforces daily limits in the database.
- Row level security on every table (claim `tables-protected`); a secret scan
  in `scripts/prelaunch_check.py`, run before each release.

## How the data moves

1. The student connects Gmail under Calendars after reading the explanation,
   and leaves **Add events from email automatically** on.
2. While a Cadence page is open in the extension (and about every 30 minutes
   while it stays open), the browser gets a one-hour, read-only token from
   Google (held in memory, never stored; never by opening a window on its own)
   and reads up to 25 inbox messages from the last 14 days from
   `gmail.googleapis.com`, skipping promotions, social, forum mail, spam,
   trash and drafts, and any message it already read.
3. It keeps plain text only: for an email with both versions it reads the HTML
   one Gmail shows; hidden HTML, invisible characters, scripts and images are
   removed; attachments are never fetched; each message is cut to 3,000
   characters.
4. On the same computer, Chrome's on-device model reads one email at a time in
   a session of its own and answers in a fixed shape (or simple matching does,
   where the computer cannot run the model). The code then checks each event
   against its email: the quoted sentence must be in it, and the date must be
   real, near, and agree with any weekday or date the sentence names.
5. The events are added to the student's calendar on that device, labelled
   **From email**, each with its sentence. They are kept under
   `state.sources.mail`, which is never copied to the account, never sent to
   the assistant's AI company, and never written to Google Calendar. The
   Cadence website in the same browser can show them by asking the extension.
6. Deleting an event keeps it from coming back; disconnecting Gmail deletes them all.

## Prompt-injection protection

Google requires protection against instructions hidden in data an AI reads.
Cadence does not use Google's Model Armor; it uses these layers instead:

1. **The model can only fill in a fixed form** (a JSON schema of events), and
   nothing it writes is run or obeyed: an event is data shown to the student.
2. **The code checks every event against the email** (`validate()` in
   `mailEvents.js`): the quoted sentence must be in the email, the date must be
   real and agree with the sentence, the times must be real times. An invented
   event cannot get through.
3. **Hidden text is removed** before the model sees it: the HTML version Gmail
   shows is read instead of a plain copy; `display:none`, zero-size and
   transparent text, `hidden` and `aria-hidden` elements, and simple
   style-block rules are dropped; invisible and "tag" characters are stripped
   (`gmail.js`).
4. **An email written like instructions to an AI is skipped entirely**
   (`looksLikeSteering`): no event is taken from it.
5. **One email, one session:** each email is read in its own model session,
   closed afterwards, so one email cannot affect another; marker lines inside
   an email are taken out so it cannot pretend to end early.
6. **The worst case is small:** an event that should not be there, labelled
   From email with the email's own sentence beside it, which the student can
   delete. Nothing is sent, no setting changes, and the assistant never sees it.

## Open questions Google does not answer

- Whether keeping all Gmail processing on the device takes Cadence out of the
  security assessment. Google's page ties the assessment to storing or
  transmitting restricted scope data on servers, and states no local-only
  exemption. Ask (step 5).
- Whether Google's rules for using Workspace data with AI expect a person to
  confirm each use. Cadence reads on its own once the student turns it on (the
  owner decided this), with the disclosure first, labelled results, Delete and
  an off switch. Check Google's current AI wording before submitting.
- Whether a Testing project's 7-day expiry applies to the token flow Cadence
  uses, which has no refresh token.
- Whether reviewers accept a `chromiumapp.org` redirect address and a "Web
  application" OAuth client used through `chrome.identity.launchWebAuthFlow`,
  or ask for the Chrome Extension client type with `getAuthToken`.
- Whether the sign-in window shows its full address (Google asks the demo to
  show the client id).
- Whether a student planner counts as "enhancing the email experience", the
  approved Gmail use closest to it.
- Which assurance level Google assigns, and current lab prices, if the
  assessment applies.
- If the assistant's own email reading is ever switched back on
  (`emailToAssistant`), email would go to an AI company again, and the earlier
  questions about Groq's and Anthropic's retention and review terms come back.

## Sources

- Restricted scope verification: https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
- Gmail API scopes: https://developers.google.com/workspace/gmail/api/auth/scopes
- Gmail API users.messages.list (labelIds, q): https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list
- Google Workspace user data and developer policy: https://developers.google.com/workspace/workspace-api-user-data-developer-policy
- Google API Services User Data Policy: https://developers.google.com/terms/api-services-user-data-policy
- Chrome Web Store Limited Use: https://developer.chrome.com/docs/webstore/program-policies/policies#limited_use
- Chrome's Prompt API (on-device model): https://developer.chrome.com/docs/ai/prompt-api
- CASA assurance levels: https://appdefensealliance.dev/casa/casa-tiering
- Authorized labs: https://www.appdefensealliance.org/certification/authorized-labs
