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
| `identity` | Signs in to Google Calendar, only if the student chooses to connect it. |
| Host `*.instructure.com`, `*.canvaslms.com` | Shows the Cadence button on Canvas pages and reads the student's own courses and assignments with their existing Canvas login. |
| Host `api.anthropic.com` | Sends assistant messages to Claude, only if the student adds their own Anthropic API key. |
| Host `www.googleapis.com`, `oauth2.googleapis.com` | Reads Google Calendar events (and, only if turned on, adds Cadence's blocks), after the student connects Google Calendar. |

**Remote code:** No. All of the extension's code is in the package.

**Data usage** (tick what applies; this matches `privacy.html`):
- Personally identifiable information: the name the student gives, and their
  email address if they sign in with one.
- Authentication information: the sign-in session for their Cadence account,
  kept on the device.
- Website content: Canvas assignments (titles, due dates, instructions, points)
  read from the student's Canvas account to make the plan.
- Personal communications: messages the student types to the assistant, which
  are sent to the AI model that answers them.

Then certify all three: the data is not sold to third parties, not used or
transferred for purposes unrelated to the single purpose, and not used to
decide creditworthiness or for lending.

**Privacy policy URL:** `https://<site.domain>/privacy`

## Later, to make the install warning shorter

Chrome's install dialog lists every host the extension may read. The Anthropic
and Google hosts are only for optional features, so they could move to
`optional_host_permissions` and be asked for when the student turns the
feature on (`chrome.permissions.request`, called directly in the click that
connects it). That needs testing in real Chrome, so it has not been done yet.
