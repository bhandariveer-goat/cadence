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

Colour says one of three things: what you can do next (orange), what state
something is in (green, amber, red), or what kind of thing it is (the four
`--k` colours). People and courses are not given colours of their own.

The panel inside Canvas follows the system's light or dark setting. The
website is light.

## Type

System fonts, so nothing is fetched from a third party and the extension
works offline. Three sizes for text: 12px for meta (timestamps, helper text,
keys), 14px for the interface, 16px for anything read as a sentence and for
every field. Above that the app steps by 1.125 and the public pages by 1.2.

Three weights: 400, 500, 600. Hierarchy comes from size and colour before
weight. Times and counts use tabular figures so columns of them line up.

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
- Fields are checked when they are left, not while they are typed in, and the message clears when the field is touched again.

## Overlays

- A short form is a sheet: beside the page on a wide screen, rising from the bottom on a narrow one.
- A question with no fields is a small dialog in the middle. If it destroys something it names the thing, says what goes, and opens with focus on the way out.
- Anything that can be put back is not asked about; it is done and offers Undo.

## Motion

100, 150 or 200ms, on opacity and transform only, easing out on the way in.
Nothing moves unless something was done or something is loading. With
"reduce motion" set, everything is immediate.

## Layout

- Below 768px: one column, tabs along the bottom. This is the extension panel (440px) and the website on a phone.
- From 768px: header, a row of tabs, the page, and up to two panes on the right.
- The header and tab row span the window. What is inside them is kept to 1280px by a gutter measured from the window, so the header's left edge and the page's left edge are the same line.
