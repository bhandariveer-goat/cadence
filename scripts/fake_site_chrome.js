// A stand-in for what a web page sees of Chrome when an extension lists it in
// externally_connectable: chrome.runtime.sendMessage and nothing else (no
// extension storage). Test-only, for scripts/mail_bridge_test.html. The
// "extension" side is set by the test (window.__ext.handler).
(function () {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return;   // test-only: local dev server only
  window.__ext = { reachable: true, delays: [], handler: null, calls: [] };
  window.chrome = {
    runtime: {
      lastError: null,
      sendMessage(extensionId, message, cb) {
        window.__ext.calls.push({ extensionId, message });
        const delay = window.__ext.delays.length ? window.__ext.delays.shift() : 0;
        const finish = (reply, error) => setTimeout(() => {
          window.chrome.runtime.lastError = error ? { message: error } : null;
          try { cb(reply); } finally { window.chrome.runtime.lastError = null; }
        }, delay);
        if (!window.__ext.reachable || !window.__ext.handler) return finish(undefined, 'Could not establish connection. Receiving end does not exist.');
        Promise.resolve(window.__ext.handler(JSON.parse(JSON.stringify(message)), { origin: location.protocol === 'http:' ? 'https://cadenceaiplanning.netlify.app' : location.origin }))
          .then((reply) => finish(reply || undefined, reply ? null : 'The message port closed before a response was received.'));
      }
    }
  };
})();
