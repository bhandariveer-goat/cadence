// An event found in email, opened from the calendar: what it is, when, who
// sent the email and its subject, and the exact words it came from, with a way
// to delete it (and take that back). Cadence adds these on its own, so the
// email's own words are always one tap away: that is how the student can tell
// a right one from a wrong one (lib/mailEvents.js).

import { app, deleteMailEvent, undoMailEvent } from '../core.js';
import { inLocalTime, KIND_LABEL } from '../../lib/mailEvents.js';
import { fmtTime } from '../../lib/util.js';
import { esc, sheet, toast } from '../ui.js';

/** An email event by id, with its times worked out in this computer's time. */
const findEvent = (id) => {
  const e = (app.S?.sources?.mail?.events || []).find((x) => x.id === id);
  return e ? inLocalTime(e) : null;
};

/** When an event happens, the way the calendar says it. */
function whenText(e) {
  const day = new Date(e.start).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  return e.allDay ? `${day}, all day` : `${day}, ${fmtTime(e.start)} to ${fmtTime(e.end)}`;
}

/** The detail sheet for one email event, and what follows from its Delete button. */
export async function mailEventSheet(id) {
  const e = findEvent(id);
  if (!e) return toast('That event is no longer on your calendar.');
  const m = e.mail || {};
  const from = [m.from, m.subject ? `"${m.subject}"` : ''].filter(Boolean).join(', ');
  const res = await sheet(`
    <h2 data-about="email">${esc(e.title)}</h2>
    <p class="lead">${esc(whenText(e))}${KIND_LABEL[m.kind] && m.kind !== 'other' && m.kind !== 'cancelled' ? ` <span class="muted">(${esc(KIND_LABEL[m.kind].toLowerCase())})</span>` : ''}</p>
    <div class="card soft small mb4">
      <div class="muted">From email${from ? `: ${esc(from)}` : ''}</div>
      <blockquote class="mail-quote">${esc(m.quote || '')}</blockquote>
    </div>
    <p class="hint">Cadence found this in your email and added it. If it is wrong, delete it and that email will not add it again.</p>
    <div class="actions"><button class="btn ghost" value="cancel">Close</button><button class="btn soft danger" name="op" value="delete">Delete event</button></div>`);
  if (res?.get('op') !== 'delete') return;
  const gone = await deleteMailEvent(id);
  if (!gone) return toast(inExtension() ? 'That event was already gone.' : 'Cadence could not reach the extension, so the event was not deleted. Try again from the extension.');
  toast('Event deleted. That email will not add it again.', { label: 'Undo', run: () => undo(id) });
}

/** Take a deletion back, and say plainly when that is no longer possible. */
async function undo(id) {
  const r = await undoMailEvent(id);
  toast(r?.ok ? 'Event put back'
    : r?.why === 'newer' ? 'A newer email changed this event, so the newer one stays.'
      : r?.why === 'unreachable' ? 'Cadence could not reach the extension, so the event was not put back.'
        : 'This can no longer be undone.');
}

const inExtension = () => typeof chrome !== 'undefined' && !!chrome?.storage?.local;

// Buttons, by data-act.
export const actions = {
  'open-mail-event': (el) => mailEventSheet(el.dataset.id)
};
