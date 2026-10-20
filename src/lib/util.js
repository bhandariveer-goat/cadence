// Small date/format helpers shared by every module. No dependencies on purpose:
// the extension has no build step, so everything is plain ES modules.

export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

// A short random id with a prefix that says what it is for ("t_x7k2m9q").
export const uid = (p = 't') => `${p}_${Math.random().toString(36).slice(2, 9)}`;

/** Midnight at the start of `d`'s day, local time. */
export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** `d` moved by `n` calendar days (the same clock time, across daylight-saving changes). */
export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** A day as YYYY-MM-DD in local time, the key plans and check-ins are filed by. */
export function dateKey(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

/** "16:30" + a day -> Date on that day at 16:30 local. */
export function atTime(day, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const x = startOfDay(day);
  x.setHours(h, m || 0, 0, 0);
  return x;
}

/** Minutes as "45m", "2h" or "1h 30m". */
export function fmtMinutes(min) {
  const m = Math.round(min);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

/**
 * A clock time the way a person says it: "6pm", "6:30pm", "midnight".
 * One format for the whole product; it used to be "6:30 PM" in some places and
 * "6:30pm" in others.
 */
export function fmtClock(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  if ((h === 23 && m === 59) || (h === 0 && !m) || (h === 24 && !m)) return 'midnight';
  if (h === 12 && !m) return 'noon';
  const ap = h >= 12 ? 'pm' : 'am';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return m ? `${hr}:${String(m).padStart(2, '0')}${ap}` : `${hr}${ap}`;
}

/** A moment's clock time, the way a person says it ("4pm", "4:30pm"). */
export function fmtTime(d) {
  const x = new Date(d);
  return fmtClock(`${x.getHours()}:${x.getMinutes()}`);
}

/** A day as "Today", "Tomorrow", "Yesterday", the weekday within the next
    week, or "Tue, Oct 27" further out. */
export function fmtDay(d) {
  const t = startOfDay(new Date());
  const k = startOfDay(d);
  const diff = Math.round((k - t) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return new Date(d).toLocaleDateString([], { weekday: 'long' });
  return new Date(d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Human "due in" string, negative when overdue. */
export function fmtDue(due) {
  if (!due) return 'No due date';
  const ms = new Date(due) - Date.now();
  if (ms < 0) {
    const d = Math.ceil(-ms / DAY);
    return d <= 1 ? 'Overdue' : `${d}d overdue`;
  }
  const h = ms / HOUR;
  if (h < 1) return `Due in ${Math.round(ms / MIN)}m`;
  if (h < 24) return `Due in ${Math.round(h)}h`;
  return `Due ${fmtDay(due)} · ${fmtTime(due)}`;
}

// `v`, kept between `lo` and `hi`.
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Overlap in ms between two [start,end) intervals. */
export function overlap(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(+aEnd, +bEnd) - Math.max(+aStart, +bStart));
}

/** Text made safe to put inside HTML. Everything from a person or another
    service goes through this before it is drawn. */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
