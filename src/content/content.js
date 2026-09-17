/* Cadence content script.
 *
 * Two jobs:
 *   1. Put the launcher button on every Canvas page and slide the panel in.
 *   2. Act as the Canvas API bridge. The panel lives in an extension iframe, so
 *      it can't hit Canvas with the student's session directly. Requests come
 *      over postMessage and go out from here — same-origin, cookies and CSRF
 *      token attached automatically, no API token to generate.
 */
(() => {
  if (window.__cadenceLoaded) return;
  window.__cadenceLoaded = true;

  const PANEL_URL = chrome.runtime.getURL('src/panel/panel.html');
  let host, frame, open = false;

  // ---------------------------------------------------------------- launcher
  const btn = document.createElement('button');
  btn.id = 'cadence-launcher';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Open Cadence planner');
  btn.innerHTML = `
    <span class="cadence-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="15" height="15">
        <path d="M5 18v-5m5 5V8m5 10v-7m4 7V6" stroke="currentColor" stroke-width="2.6"
              stroke-linecap="round" fill="none"/>
      </svg>
    </span>
    <span>Cadence</span>
    <em id="cadence-badge" hidden></em>`;
  btn.addEventListener('click', () => togglePanel());
  document.documentElement.appendChild(btn);

  function togglePanel(force) {
    open = force ?? !open;
    if (open && !host) mountPanel();
    if (host) host.classList.toggle('cadence-open', open);
    btn.classList.toggle('cadence-hidden', open);
    if (open && frame) frame.contentWindow?.postMessage({ type: 'cadence:shown', context: pageContext() }, '*');
  }

  function mountPanel() {
    host = document.createElement('div');
    host.id = 'cadence-host';
    frame = document.createElement('iframe');
    frame.id = 'cadence-frame';
    frame.src = `${PANEL_URL}?host=${encodeURIComponent(location.origin)}`;
    frame.setAttribute('title', 'Cadence planner');
    host.appendChild(frame);
    document.documentElement.appendChild(host);
  }

  /** What page are we on? Lets the panel offer "add this assignment". */
  function pageContext() {
    const course = location.pathname.match(/\/courses\/(\d+)/);
    const assignment = location.pathname.match(/\/assignments\/(\d+)/);
    const title = document.querySelector('h1.title, .assignment-title h1, #content h1')?.textContent?.trim();
    return {
      origin: location.origin,
      courseId: course ? course[1] : null,
      assignmentId: assignment ? assignment[1] : null,
      pageTitle: title || document.title,
      courseName: document.querySelector('#breadcrumbs .ellipsible')?.textContent?.trim() || ''
    };
  }

  function csrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)_csrf_token=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  // ------------------------------------------------------------ API bridge
  async function canvasFetch({ path, method = 'GET', body }) {
    const url = path.startsWith('http') ? path : `${location.origin}${path}`;
    const headers = { Accept: 'application/json+canvas-string-ids, application/json' };
    const init = { method, headers, credentials: 'same-origin' };

    if (body != null) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (method !== 'GET') {
      const token = csrfToken();
      if (token) headers['X-CSRF-Token'] = token;
    }

    const res = await fetch(url, init);
    const text = await res.text();
    // Canvas prefixes JSON responses with a while(1); anti-JSON-hijacking guard.
    const clean = text.replace(/^while\(1\);/, '');
    let data = null;
    try { data = clean ? JSON.parse(clean) : null; } catch { data = { message: clean.slice(0, 200) }; }
    return { ok: res.ok, status: res.status, data, link: res.headers.get('Link') || '' };
  }

  window.addEventListener('message', async (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object') return;
    // Only trust messages coming from our own panel frame.
    if (frame && ev.source !== frame.contentWindow) return;

    if (msg.type === 'cadence:close') return togglePanel(false);
    if (msg.type === 'cadence:context') {
      return frame.contentWindow.postMessage({ type: 'cadence:context:res', id: msg.id, context: pageContext() }, '*');
    }
    if (msg.type === 'cadence:badge') {
      const el = btn.querySelector('#cadence-badge');
      el.textContent = msg.count > 0 ? String(msg.count) : '';
      el.hidden = !msg.count;
      return;
    }
    if (msg.type === 'cadence:canvas') {
      let payload;
      try { payload = await canvasFetch(msg.req); }
      catch (e) { payload = { ok: false, status: 0, data: { message: e.message } }; }
      return frame.contentWindow.postMessage({ type: 'cadence:canvas:res', id: msg.id, payload }, '*');
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'cadence:open') togglePanel(true);
  });
})();
