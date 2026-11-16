# Publishing the extension on the Chrome Web Store

The Chrome Web Store is how most students will find Cadence: a search for a
Canvas planner, then one click. This file has what the store asks for, written
to match what the code does. Nothing here is submitted until you do it.

## Before you submit

1. A Chrome Web Store developer account (one-time US$5 fee). The account
   holder has to be 18 or older, so a parent or guardian may need to open it.
2. `site.domain` in `src/config.js` is the address the site really lives at
   (the custom domain once you have one). The extension sends people there for
   the privacy policy, the terms and email sign-in links.
3. Build the package:

   ```bash
   python3 scripts/package_extension.py
   ```

   It writes `dist/cadence-extension-<version>.zip` and refuses to build if a
   file is missing or the config is not ready. Raise `"version"` in
   `manifest.json` before every new upload; the store rejects a version it has
   already seen.
4. Test the zip, not the folder: `chrome://extensions` → Developer mode →
   Load unpacked → the unzipped folder. Check, in a fresh Chrome profile:
   - Installing opens a welcome page.
   - On a Canvas page the Cadence button is bottom right, the panel opens, and
     assignments come in.
   - The Privacy, Terms and Contact links open the website.
   - Reminders arrive before a planned block.
   - If you use them: Google Calendar sign-in, and the assistant with your own
     Anthropic key.
5. After it is published, put its store address in `site.extensionUrl` in
   `src/config.js` and run `python3 scripts/stamp_pages.py`. That turns on the
   "Add to Chrome" button on the homepage and the offer in the app's setup.

## Store listing

**Name:** Cadence: planner for Canvas

**Summary** (132 characters at most):
Your Canvas assignments, classes and activities on one calendar, with the time to do the work planned around your day.

**Category:** Education (or Productivity)

**Language:** English

**Description:**

> Cadence reads your assignments from Canvas and plans when to do them, around
> school, practice, your calendar and sleep.
>
> How it works
> - A Cadence button appears on every Canvas page. It reads your courses and
>   assignments with the Canvas login you already have: no API token, nothing
>   for your school to set up.
> - Each assignment gets a time estimate, and the work is split into blocks
>   across the days before it is due. Long projects are spread out; light weeks
>   stay light.
> - If something will not fit before it is due, Cadence says so, by name.
> - Tell it when your day changes ("I'm tired, an hour tonight", "no school
>   Friday") and the week is rebuilt. Every change is listed and can be undone.
> - Add practice, clubs and a job, and see each week whether you showed up.
> - The same plan is on the website, on your phone, if you sign in with an email.
>
> Cadence has no ads and does not sell anything about you. The privacy policy
> lists exactly what is stored and what is sent anywhere.

**Screenshots** (1280 x 800 or 640 x 400, up to five). Take them from the real
extension on a real or demo week, never mock-ups:
1. The Canvas page with the Cadence panel open on Today.
2. The week view with planned blocks.
3. An assignment opened, with its estimate and steps.
4. The assistant after "I'm tired, an hour tonight", showing what moved.
5. Activities with the weekly counts.

**Small promo tile** (440 x 280): the Cadence mark and name on a plain
background. No invented ratings, user counts or awards.

## Privacy tab

**Single purpose:** Plan a student's schoolwork and activities around their
day, using the assignments in their Canvas account.

**Permission justifications:**

| Permission | Why Cadence needs it |
| --- | --- |
| `storage` | Keeps the student's plan, settings and connected calendars on their device. |
| `alarms` | Reminds the student before a planned work block, and refreshes connected calendars in the background. |
| `notifications` | Shows those reminders. They can be turned off in Cadence. |
| `identity` | Signs in to Google Calendar or Gmail, only if the student chooses to connect them. |
| Host `*.instructure.com`, `*.canvaslms.com` | Shows the Cadence button on Canvas pages and reads the student's own courses and assignments with their existing Canvas login. |
| Host `api.anthropic.com` | Sends assistant messages to Claude, only if the student adds their own Anthropic API key. |
| Host `www.googleapis.com`, `oauth2.googleapis.com` | Reads Google Calendar events (and, only if turned on, adds Cadence's blocks), after the student connects Google Calendar. |
| Host `gmail.googleapis.com` | Reads up to 25 recent inbox emails, read-only, while Cadence is open, after the student connects Gmail, to find events on their computer. Nothing from the email is sent anywhere. |

**Remote code:** No. All of the extension's code is in the package.

**Data usage** (tick what applies; this matches `privacy.html`):
- Personally identifiable information: the name the student gives, and their
  email address if they sign in with one.
- Authentication information: the sign-in session for their Cadence account
  and, if they add one, their Anthropic API key, kept on the device; Google's
  sign-in for Calendar and Gmail, held in memory only and never stored.
- Website content: Canvas assignments (titles, due dates, instructions, points)
  read from the student's Canvas account to make the plan.
- User activity: anonymous usage data, only after the student has agreed to
  the terms and seen the notice, and with a switch to turn it off in Account.
  With a random ID (not the account): one of five counts (used Cadence on a
  day, finished setup, has work in the plan, first check-in, connected a
  calendar), and how the app is used: which screen is open and for how long,
  which controls are pressed (by their name in Cadence's code), presses on
  things that are not controls, quick repeated presses, how far setup and the
  tour get, errors (kind and place in the code), and how long the app and its
  own requests take. Sent to Cadence's own server; counts kept up to 400 days,
  the rest up to 180. Clicks are recorded, so tick "User activity". Never
  sent: what is typed, field contents, the words on a control, where on the
  screen, mouse movement, scrolling, the plan, messages, calendar contents,
  error messages, or anything from Gmail or email. Before sign-up, the sign-up
  screen's daily numbers (shown, typed in, sent, got in) are counted with no ID.
- Personal communications: messages the student types to the assistant, which
  are sent to the AI model that answers them; and, only if the student connects
  Gmail, the text of their recent inbox emails, read on their own computer to
  find events. The email is not sent anywhere; the events found (title, date
  and time, the sentence each came from, the sender, the subject) are kept on
  the device only.

Then certify all three: the data is not sold to third parties, not used or
transferred for purposes unrelated to the single purpose, and not used to
decide creditworthiness or for lending.

Gmail and Google Calendar data also fall under Google's Limited Use rules for
API data; `docs/GOOGLE_VERIFICATION.md` maps each rule to the code that keeps
it. The Gmail sheet in Calendars is the prominent disclosure the Chrome Web
Store asks for: it says what is read and where it goes before Google's consent
screen opens.

The extension also lists the Cadence website in `externally_connectable`, so the website open in the same browser can show the events found in email; no other site or extension can ask it anything.

**Privacy policy URL:** `https://<site.domain>/privacy`

## Later, to make the install warning shorter

Chrome's install dialog lists every host the extension may read. The Anthropic
and Google hosts are only for optional features, so they could move to
`optional_host_permissions` and be asked for when the student turns the
feature on (`chrome.permissions.request`, called directly in the click that
connects it). That needs testing in real Chrome, so it has not been done yet.
