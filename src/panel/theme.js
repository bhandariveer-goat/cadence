// Light or dark, decided before the page paints.
//
// This is a plain script in <head>, not a module, so it runs before anything
// is drawn and a dark page never flashes white. It is the same file for the
// website, the app and the extension panel.
//
// The choice is 'light', 'dark' or 'system' and is kept in this browser only
// (localStorage): it is a preference about one screen, not part of the plan,
// so it is never sent anywhere or synced. Where nobody has chosen, the page
// says what it wants with data-theme-default on <html>: the website starts
// light, the panel inside Canvas follows the system.
//
// The stylesheets only ever look at <html data-theme="light|dark">.

(function () {
  var KEY = 'cadence.theme';
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var COLORS = { light: '#ffffff', dark: '#141312' };

  // Used when storage is unavailable (a private window), so the toggle still
  // works for as long as the page is open.
  var remembered = null;

  function stored() {
    try {
      var v = localStorage.getItem(KEY);
      if (v === 'light' || v === 'dark' || v === 'system') return v;
    } catch (e) { /* fall through */ }
    return remembered;
  }
  function preference() {
    return stored() || (root.getAttribute('data-theme-default') === 'system' ? 'system' : 'light');
  }
  function resolve(pref) {
    if (pref === 'system') return media && media.matches ? 'dark' : 'light';
    return pref;
  }
  function apply() {
    var theme = resolve(preference());
    root.setAttribute('data-theme', theme);
    // The browser's own chrome (address bar on a phone) takes the same colour.
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) { metas[i].removeAttribute('media'); metas[i].setAttribute('content', COLORS[theme]); }
    return theme;
  }

  apply();

  window.CadenceTheme = {
    /** What was chosen: 'light', 'dark' or 'system'. */
    preference: preference,
    /** What is showing: 'light' or 'dark'. */
    current: function () { return resolve(preference()); },
    set: function (pref) {
      if (pref !== 'light' && pref !== 'dark' && pref !== 'system') return;
      remembered = pref;
      try { localStorage.setItem(KEY, pref); } catch (e) { /* kept in memory instead */ }
      var theme = apply();
      document.dispatchEvent(new CustomEvent('cadence:theme', { detail: { preference: pref, theme: theme } }));
    }
  };

  var changed = function () {
    var theme = apply();
    document.dispatchEvent(new CustomEvent('cadence:theme', { detail: { preference: preference(), theme: theme } }));
  };
  // The system switching at sunset, and another tab (or the demo framed on the
  // homepage) changing the choice.
  if (media) { if (media.addEventListener) media.addEventListener('change', changed); else if (media.addListener) media.addListener(changed); }
  window.addEventListener('storage', function (e) { if (e.key === KEY || e.key === null) changed(); });
  // <head> runs before the theme-color tags below it exist in some orders.
  document.addEventListener('DOMContentLoaded', apply);
})();
