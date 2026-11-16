// A stand-in for the Chrome extension APIs Cadence uses (storage, identity,
// runtime), so the panel's code can be tested in a plain page. Test-only:
// loaded by scripts/mail_core_test.html before any Cadence module.
(function () {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return;   // test-only: local dev server only
  const data = {};
  window.__auth = [];
  window.__authMode = 'allow';
  window.chrome = {
    runtime: { lastError: null, id: 'testextension', getManifest: () => ({ version: '0.3.0' }) },
    storage: {
      local: {
        _data: data,
        get: async (key) => ({ [key]: data[key] === undefined ? undefined : structuredClone(data[key]) }),
        set: async (obj) => { for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v); },
        remove: async (key) => { delete data[key]; }
      }
    },
    identity: {
      getRedirectURL: (path) => `https://testextension.chromiumapp.org/${path}`,
      launchWebAuthFlow: (opts, cb) => {
        window.__auth.push({ interactive: !!opts.interactive, url: opts.url });
        const deny = window.__authMode === 'deny' || (window.__authMode === 'quiet-deny' && !opts.interactive);
        if (deny) { window.chrome.runtime.lastError = { message: 'User interaction required.' }; cb(undefined); window.chrome.runtime.lastError = null; return; }
        cb(`https://testextension.chromiumapp.org/google#access_token=tok-${window.__auth.length}&expires_in=3600&scope=${encodeURIComponent('https://www.googleapis.com/auth/gmail.readonly')}`);
      }
    }
  };
})();
