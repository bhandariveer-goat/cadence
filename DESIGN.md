# Cadence design system

The rules the interface is built on. They live as tokens at the top of
`src/panel/panel.css` (the app) and `site.css` (the public pages); this file
says what they are for, so a change can be checked against them.

## Colour

| Token | Value | Used for |
| --- | --- | --- |
| `--bg`, `--surface` | `#ffffff` | The page, and frames on it |
| `--surface-2`, `--surface-3` | `#f7f6f4`, `#eeece9` | Side panes, table heads, pressed states |
| `--line`, `--line-strong` | `#e7e5e1`, `#d4d1cc` | Hairlines; the outline of a frame or a button |
| `--field` | `#948e87` | The outline of a text field (3:1 on white) |
| `--text`, `--text-2`, `--muted` | `#1c1b19`, `#55514c`, `#736e68` | Text. `--muted` is 5:1 on white and is the lightest text allowed |
| `--accent` | `#f0712b` | The one orange: primary buttons, the current tab, today |
| `--accent-strong` | `#c2410c` | Orange that has to be read as text or found as a line: links, focus rings |
| `--on-accent` | `#1c1b19` | Text on an orange fill (5.8:1; white would be 3:1) |
| `--green`, `--amber`, `--red` | | Done, careful, wrong. Never decoration |
| `--k-school`, `--k-event`, `--k-activity`, `--k-work` | grey, blue, green, orange | What kind of thing is on a calendar |
| `--a-practice` ... `--a-custom` | one per kind of activity | Which activity: its ring, its icon, its block in the day strip |

Colour says one of four things: what you can do next (orange), what state
something is in (green, amber, red), what kind of time it is (the four `--k`
colours, on the calendar), or which activity it is (the `--a` colours, by
kind of activity, chosen so none is the blue of an event, the orange of
homework or the grey of school). A friend's avatar is tinted with their own
colour. Courses are not given colours of their own.

### The loud part

Today opens with the one place the design raises its voice: the date, a big
greeting, one sentence about the day, and the day strip, a bar from waking to
bed with school, plans, activities and homework in their colours and a mark
for now. The card for the next thing to do is tinted with that thing's colour.
Everything else stays quiet so these read first.

### Light and dark

Every token above has a dark value (`:root[data-theme="dark"]` in both
stylesheets). Which one shows is decided by `src/panel/theme.js`, a small
script in the `<head>` of every page that runs before anything is drawn, so a
dark page never flashes white.

- The choice is light, dark, or match this device. It is kept in the browser
  (`localStorage`, key `cadence.theme`), never in the plan and never synced:
  it is a fact about one screen.
- Where nobody has chosen, the website starts light and the panel inside
  Canvas follows the system (`data-theme-default` on `<html>`).
- It is changed from the header of the public pages, the header of the app on
  a wide screen, Account > Appearance, and the command palette.
- Dark is for screens. The dark block sits inside `@media screen`, so
  anything printed uses the light values.

## Type

System fonts, so nothing is fetched from a third party and the extension
works offline. Three sizes for text: 12px for meta (timestamps, helper text,
keys), 14px for the interface, 16px for anything read as a sentence and for
every field. Above that the app steps by 1.125 and the public pages by 1.2.

Three weights for text: 400, 500, 600. Display type (the greeting, page
titles, the title of the next thing to do) is 700 with tight tracking
(`--display-weight`, `--display-track`). Hierarchy comes from size and colour
before weight. Times and counts use tabular figures so columns of them line up.

## Space, corners, depth

- Spacing is a multiple of 4, from the `--s` tokens (4, 8, 12, 16, 24, 32, 48, 64).
- Corners: 4px for small marks, 6px for controls, 8px for frames, 12px for overlays. Nothing is pill-shaped; avatars are the only circles.
- A frame is a 1px line. Only things that float (menus, dialogs, toasts) have a shadow, and it is under 8% black.
- A list is rows inside one frame with hairlines between them, not a stack of cards.

## Controls

- Anything a finger is asked to hit is at least 44px. With a mouse the visible size drops to 36 or 40px and the clickable area stays 44px.
- Buttons say what they do, verb first: "Add assignment", "Save changes", "Delete account". A submit button is never disabled; it says what is missing, next to the field.
- Every field has a visible label. A placeholder is only ever an example of what to type.
- A control that is only an icon has a tooltip on hover and on keyboard focus (`data-tip`), and a matching `aria-label`.
- Fields are checked when they are left, not while they are typed in, and the message clears when the field is changed. Moving the cursor to a field does not clear it.
- A button that is working says what it is doing ("Sending…") and shows a small turning ring (`aria-busy="true"`). It keeps its place.
- When a form works, that is said next to the form in a `.form-success` line, not only in a toast. The line is on the page from the start and empty, so a screen reader announces it when it is filled.
- A copy button (`data-copy="text"`) says "Copied" on itself for two seconds, then goes back to its own words.
- A password or key field has a Show / Hide button beside it (`data-reveal="field-id"`).
- Everything that can be clicked has a hover state; nothing changes size or position on hover.

## Overlays

- A short form is a sheet: beside the page on a wide screen, rising from the bottom on a narrow one.
- A question with no fields is a small dialog in the middle. If it destroys something it names the thing, says what goes, and opens with focus on the way out.
- Anything that can be put back is not asked about; it is done and offers Undo.

## Motion

100, 150 or 200ms, on opacity and transform only, easing out on the way in.
Nothing moves unless something was done or something is loading. With
"reduce motion" set, everything is immediate.

Loading has three forms and no others: the ring on a busy button, a line or
two of placeholder that breathes slowly where text is about to arrive, and
the three dots while the assistant is thinking.

Nothing animates because the page was scrolled. Three things on the public
pages know where the scroll is, and `scripts/prelaunch_check.py` allows those
three by name and fails on any other: a 2px reading-progress line on the
lower edge of the header (CSS only, hidden with "reduce motion"), the
back-to-top button, which appears once the top of the page is a screen and a
half behind, and the bar of two buttons at the bottom of the homepage on a
phone, which is there only while the page's own two buttons are off screen.
None of the three is an animation: each is either there or not.

## Layout

- Below 768px: one column, tabs along the bottom. This is the extension panel (440px) and the website on a phone.
- From 768px: header, a row of tabs, the page, and up to two panes on the right.
- The header and tab row span the window. What is inside them is kept to 1280px by a gutter measured from the window, so the header's left edge and the page's left edge are the same line.
- The public header has three widths. On a phone: the name, the main button and a menu. From 768px: search, the theme and both buttons join it, and the links stay in the menu. From 1080px the links are written out and the menu goes. A header never wraps onto a second line; when something does not fit, it moves into the menu.
- Every public page below the homepage starts with breadcrumbs (Home, then the page). The last one is where you are and is not a link.
- A primary action is never on screen twice. On the homepage on a phone that is one of: the buttons at the top, the bar at the bottom, the buttons at the end.
- Headers stay put: the site header, the week grid's row of days, and the group headings in the School list (each stays at the top while its own rows scroll under it).
- Only the page column scrolls, never the document. Anything positioned absolutely needs a positioned parent inside that column, or it escapes and makes the whole page scroll.

## Words on the public pages

- Everything a page says is in its HTML. A script may add a control; it may not add a sentence. Values that come from `src/config.js` are written in by `scripts/stamp_pages.py`. A sentence a script decides when to show (the storage notice, the contact form's "that did not send") is written in the page and hidden, and the script only reveals it.
- A page does not say two things. Where the wording depends on the set-up, both versions are in the file marked `data-needs`, and the stamp script comments out the one that is not true.
- A list of links to go to (on the 404 page, the thank-you page, "Before you write") uses `class="ways"`, which makes each link a full 44px tall.
- Something the owner has not decided yet is shown as a highlighted "to be added before launch", never left blank and never invented.
- An example is labelled as one. The sample week on the homepage says the student is made up and that the numbers are the planner's own output. There are no testimonials, counts of users or ratings, because there is nothing true to put in them yet.
- A promise (a reply time, deleting a message on request) is only on the page if the person who runs the site has made it.

## Print

Both stylesheets have a print block. The public pages print as documents:
no header or buttons, black on white, every link's address written out after
it, every question in the FAQ open. The app prints the page that is showing,
all of it rather than the part that fits the window, without the controls,
and keeps the four calendar colours.
