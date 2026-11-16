# Email events: public wording

Applied on 2026-11-08, on the owner's instruction ("just do all these things"),
and kept here as the record of what changed and why. Nothing is pushed: the
changes are local and show up in `git diff` for review before any push. The old
sentences and the code that backs the new ones are listed below, so the diff
can be checked against this file.

Each change says what it replaces and why. Promises that depend on something
not yet verified are marked.

## 1. privacy.html

### 1a. The Gmail section (`#gmail`): replace its first two paragraphs

Replaces the paragraphs that say email is read only when the student asks the
assistant, at most 10 messages, never saved, and nothing goes on the plan until
the student chooses it. All four are no longer true.

> Connecting Gmail is optional and works only in the Chrome extension. You sign in with Google and allow Cadence to read your email, using Google's read-only Gmail permission: Cadence cannot send, delete or change anything in Gmail. Once you connect it, and while "Add events from email automatically" is on, Cadence reads your recent email to find practices, games, deadlines and changes, and adds them to your calendar. It does this only while Cadence is open: when you open it, about every 30 minutes after that, and when you choose Check email now. Your browser reads your email straight from Google, without going through Cadence's server. It reads the text of emails in your inbox from the last two weeks, up to 25 at a time, and up to 3,000 characters of each; promotions, social and forum mail, spam, trash and drafts are left out. Attachments, images and links in an email are never opened, and text an email hides from view is left out where Cadence can tell.
>
> The events are found on your computer. Where your computer can run it, Chrome's built-in AI model reads each email inside Chrome; otherwise Cadence matches dates, times and words like "practice" or "due" itself. Your email is not sent to Cadence or to any AI company. Cadence checks each event against its email: the sentence it came from must be in the email, and the date must match that sentence. An email that looks written to give instructions to an AI is skipped.
>
> Events found in email are added to your calendar, labelled From email, with the sentence each came from. For each one, Cadence keeps its title, date and time, that sentence, the sender's name and email address, the email's subject, when it arrived and Gmail's id for it, in your browser's storage only: never in your account or on Cadence's server. It also keeps which emails it has already read (Gmail's id for each, not their contents) and which events you deleted, so that they are not added again. The assistant does not read your email, and the events found in it are left out of everything sent to the assistant's AI model. They are never added to your Google Calendar. If the Cadence website is open in the same browser, it can show these events by asking the Chrome extension directly, inside your browser, not through Cadence's server.
>
> You can delete any event (open it on your calendar and choose Delete event), switch "Add events from email automatically" off, which stops the reading and hides the events, or disconnect Gmail. No one at Cadence reads your email, and Cadence's server keeps no record of it. The Gmail sign-in lasts about an hour and is kept only in memory while Cadence is open: it is never written to your device's storage or saved to your account. Disconnecting Gmail under Calendars forgets it straight away and removes the events found in your email from this device; when Google Calendar is not also connected, Cadence also asks Google to cancel the sign-in, and says so if Google does not confirm. You can remove Cadence's access at any time at myaccount.google.com/permissions. While Google is reviewing Cadence's access to Gmail, only people Cadence has added as testers can connect it.

Why the address and Gmail id are listed: the code keeps the sender's address
(to tell a changed event from a new one) and Gmail's message id (so an email
is not read twice); the policy has to say so. The website never receives the
address or the ids (`lib/mailShare.js forSite()`).

Unverified, said carefully: "Chrome's built-in AI model reads each email
inside Chrome" is what the code does; that Chrome sends nothing to Google is
Chrome's documentation, not something Cadence can check (it goes in the
claims script's "not checked" list, below).

### 1b. The Limited Use paragraph (`#gmail`, third paragraph): two sentences change

Keep the paragraph and its two Limited Use sentences word for word. Change:

- "Google Calendar data is used only to show your calendar and plan around it, and Gmail data only to answer what you asked the assistant about your email."
  becomes "Google Calendar data is used only to show your calendar and plan around it, and Gmail data only to find the events added to your calendar."
- "Cadence does not use Gmail or any other Google user data to develop, improve or train AI or machine learning models, and the AI companies it sends email text to may not train on it either."
  becomes "Cadence does not use Gmail or any other Google user data to develop, improve or train AI or machine learning models, and does not send your email to any AI company."

### 1c. "The assistant, and AI": remove email reading

- Remove the list item "If you asked it to read your email: the sender, subject, time, whether you have opened it, and text of each message it read, as described under "Gmail"."
- Replace the paragraph "Reading email is offered only with an AI model that does not use what it receives to train its models: ... with your own Anthropic key, Claude can." with:

> The assistant does not read your email, and the events Cadence finds in your email are left out of the summary of your week and of everything else sent to the AI model.

Why: `emailToAssistant: false` and `forAssistant()` (claim rules `assistant-email-off`, `assistant-never-sees-mail`).

### 1d. "In your browser": two list items change

- In the chats item, remove the last sentence: "When the assistant reads your email, its answer is kept in the chat, but the emails themselves are left out when the chat is saved."
- Replace "If you connect Gmail, or sign in with Google for Google Calendar: that it is connected, to which address, and when the assistant last read your email." with:

> If you connect Gmail, or sign in with Google for Google Calendar: that it is connected and to which address. With Gmail, also the events Cadence found in your email, which emails it has read and which events you deleted, as described under "Gmail".

(The rest of that item, about Google's sign-in never being stored, stays.)

### 1e. "In your account": the copy leaves out the email events

"The copy leaves out your Anthropic API key, your Google Calendar connection and its events, your Gmail connection, your calendar links, and your chats with the assistant."
becomes
"The copy leaves out your Anthropic API key, your Google Calendar connection and its events, your Gmail connection and the events found in your email, your calendar links, and your chats with the assistant."

### 1f. "Who else handles your data"

- Netlify row: "Messages to the assistant, including any email it read for you, passing through on their way to the AI and not kept." becomes "Messages to the assistant, passing through on their way to the AI and not kept."
- Google rows (both the Gemini and the non-Gemini variant): "Requests to read your email, made by your browser when you ask the assistant" becomes "Requests to read your email, made by your browser while Cadence is open, if you connect Gmail".

### 1g. "Deleting your data"

"To stop the assistant reading your email, open Calendars in the Chrome extension and choose Disconnect on the Gmail card."
becomes
"To stop Cadence reading your email and remove the events it found, open Calendars in the Chrome extension and choose Disconnect on the Gmail card. To remove one event, open it on your calendar and choose Delete event."

### 1h. The date

"Last updated" becomes 8 November 2026 (`2026-11-08`), so the change is
announced in the app and `claims_check.py --accept` will record the new data
surface (which now includes the website address allowed to ask the extension).

## 2. src/lib/policy.js (shown once in the app before the assistant is next used)

```js
export const POLICY_CHANGE = {
  date: '2026-11-08',
  what: 'The Chrome extension can now read your Gmail on your computer, only if you choose to, and add the events it finds to your calendar. Your email is not sent to Cadence or to any AI company.'
};
```

Replaces the 2026-11-06 notice. The earlier fact (messages to the assistant go
to a different AI company) stays true and stays on the privacy page.

## 3. index.html, the question "Can Cadence read my email?"

Replaces the answer that says it reads only when you ask the assistant, up to
10 messages, and nothing goes on the plan until you tap:

> Only if you connect Gmail in the Chrome extension. Then, while Cadence is open, it reads your recent email on your computer, with read-only access, finds practices, games, deadlines and changes, and adds them to your calendar labelled From email, with the sentence each came from. Your email isn't sent to Cadence or to any AI company, and the events stay on your device. Delete any that are wrong, switch it off or disconnect at any time. The privacy policy explains [exactly what happens](/privacy.html#gmail).

The number of questions stays at 13.

## 4. STORE.md (the Chrome Web Store listing's disclosures)

- Host `gmail.googleapis.com`: "Reads up to 10 recent emails, read-only, only when the student has connected Gmail and asks the assistant about their email." becomes "Reads up to 25 recent inbox emails, read-only, while Cadence is open, after the student connects Gmail, to find events on their computer. Nothing from the email is sent anywhere."
- Data usage, Personal communications: replace the part about Gmail with "and, only if the student connects Gmail, the text of their recent inbox emails, read on their own computer to find events. The email is not sent anywhere; the events found (title, date and time, the sentence each came from, the sender, the subject) are kept on the device only."
- After the Limited Use paragraph, add: "The extension also lists the Cadence website in `externally_connectable`, so the website open in the same browser can show the events found in email; no other site or extension can ask it anything."
- "The Gmail sheet in Calendars ... says what is read and where it goes" stays true (the sheet now says what is read, where, and what is kept).

## 5. Wording already in the app (built; please read before it ships)

These are in the code because the feature cannot work without them, but they
are promises too. Approve or change them with the rest.

- Gmail card, not connected: "Cadence reads your recent email on this computer, finds practices, games, deadlines and changes, and adds them to your calendar. Your email is not sent anywhere." (the spec's wording)
- Connect sheet (`gmailConnect()` in `src/panel/views/calendars.js`): title "Find events in your Gmail?"; "What it reads: the text of emails in your inbox from the last two weeks, up to 25 at a time. Spam, trash, drafts, promotions and social mail are skipped, and attachments, images and links are never opened." "Where: on this computer, while Cadence is open. Chrome's on-device AI reads them inside Chrome, or simpler matching does where this computer can't run it. Your email is not sent to Cadence or to any AI company." "What it keeps: the events it finds, each with the sentence it came from, in this browser only. They are not saved to your account." "Events are added for you and labelled From email. Delete any that are wrong, turn this off, or disconnect at any time. It is read only: Cadence cannot send, delete or change anything in Gmail." Then the Limited Use sentence and the privacy link, unchanged.
- Switch: "Add events from email automatically", with "Cadence checks your inbox about every 30 minutes while it is open, and labels what it adds From email." or, off, "Off: Cadence does not read your email, and the events it found are hidden."
- Disconnect sheet: "Cadence stops reading your email, this device forgets the Gmail sign-in, and the events found in your email are removed from this device." Toasts: "Gmail disconnected, and the events found in your email were removed from this device." or, when Google did not confirm, "Gmail disconnected here, and the events found in your email were removed. Google did not confirm it, so remove Cadence at myaccount.google.com/permissions too."
- Calendars screen, "Where this goes": the old last sentence ("Email is read only when you ask the assistant, and none of it is saved to your plan.") is replaced by "With Gmail connected, your email is read on this computer to find events: no email is sent anywhere, and the events found stay in this browser, not in your account."
- Event detail: "Cadence found this in your email and added it. If it is wrong, delete it and that email will not add it again."
- The assistant, when asked about email and the AI cannot answer: "The assistant does not read your email. With Gmail connected under Calendars in the Cadence Chrome extension, Cadence finds events in your email and adds them to your calendar." The model itself is told it cannot read email or see those events (`NO_EMAIL_RULES` in `src/lib/agentspec.js`).

The Gmail sheet's sentence about the sender's address is not there: the sheet
says "the events it finds, each with the sentence it came from"; the privacy
page (1a) gives the full list. If you would rather the sheet name every field,
say so.

## 6. What changed in the claims check (done)

Done together with the wording; `python3 scripts/claims_check.py` now holds (46 claims, 13 rules about email), CLAIMS.md is regenerated and the data surface accepted:

- Replace `gmail-only-when-asked` with a claim on "your browser reads your email straight from google, without going through cadence's server" and "your email is not sent to cadence or to any ai company", proven by `proof_gmail_direct` and the rules `mail-no-network` and `assistant-email-off`.
- Rewrite `gmail-bounded` for "up to 25 at a time", "from the last two weeks" and "up to 3,000 characters of each", proven against `INBOX` and `LIMITS` in `gmail.js`.
- Replace `gmail-not-saved` with a claim on "in your browser's storage only: never in your account or on cadence's server", proven by `mail-stays-on-device` and the sign-in-in-memory proof.
- Replace `gmail-you-choose` with a claim on "events found in email are added to your calendar, labelled from email" and "which events you deleted, so that they are not added again", proven against the calendar views' label and `merge()`'s handling of deleted events.
- Remove `gmail-asks-first`, `gmail-not-in-saved-chats` and `email-fields-to-ai` (the assistant no longer reads email); rewrite `gmail-no-training` on the new sentences in 1b and 1c, proven by `assistant-email-off` and `assistant-never-sees-mail`.
- Update `account-copy-leaves-out` and `gmail-disconnect` to the new sentences (1e, 1a), adding `disconnect-deletes-mail`.
- Add a claim on "it can show these events by asking the chrome extension directly, inside your browser, not through cadence's server", proven by `bridge-only-own-site`.
- Add to the "not checked" list: that Chrome's on-device model sends nothing to Google (Chrome's documentation), and that the real model's accuracy has not been measured.
- Then `python3 scripts/claims_check.py --markdown` (CLAIMS.md) and, after the privacy date moves, `--accept`.
