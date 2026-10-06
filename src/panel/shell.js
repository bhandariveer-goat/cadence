// The frame every Cadence page shares: header, tab bar, the main view, the side
// pane and the assistant. It is built here rather than repeated in each HTML
// file because there are three of those now (the extension panel, the website
// app, the demo) and three copies of the same markup drift.

export const MARK = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M12 3.5a8.5 8.5 0 1 1-8.1 5.9"/><path d="M12 8a4 4 0 1 1-3.8 2.8"/></svg>';

// The modifier key as this machine writes it.
export const MOD = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl+';

export function mountShell(root = document.getElementById('root')) {
  root.innerHTML = `
  <a class="skip" href="#view">Skip to the page</a>
  <div class="app" id="app">
    <div class="demo-bar" id="demo-bar" hidden>
      <span>You are looking at a demo with sample data. Nothing here is yours.</span>
      <a class="demo-exit" id="demo-exit" href="#">Start with your own week</a>
    </div>
    <header class="top" id="top">
      <div class="brand"><span class="brand-mark">${MARK}</span><span>Cadence</span></div>
      <div class="top-actions">
        <button class="ghost-btn" id="btn-cmd" data-act="palette" aria-label="Search and commands" hidden>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>
          <span>Search</span><kbd>${MOD}K</kbd>
        </button>
        <button class="ask-btn" id="btn-agent" data-act="agent-toggle" aria-pressed="false" hidden>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5h16v10.5H9.5L5 19.5V16H4z"/><path d="M8 9.5h8M8 12.5h5"/></svg>
          <span>Ask Cadence</span>
        </button>
        <button class="streak-chip" id="streak" data-act="streak" hidden></button>
        <button class="icon-btn" id="btn-sync" data-tip="Refresh from Canvas" aria-label="Refresh from Canvas" hidden>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
        </button>
        <button class="avatar-btn" id="btn-account" data-act="open-account" aria-label="Your account" hidden></button>
        <button class="icon-btn" id="btn-close" data-tip="Close Cadence" aria-label="Close Cadence" hidden>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
    </header>

    <div class="body">
      <main id="view" tabindex="-1"></main>
      <nav class="tabbar" id="tabs" aria-label="Sections" hidden></nav>
      <aside class="side" id="side" hidden></aside>
      <aside class="agent" id="agent" aria-label="Cadence assistant" hidden></aside>
    </div>
  </div>

  <div id="toast" class="toast" role="status" aria-live="polite" hidden></div>

  <dialog id="sheet" class="sheet" aria-modal="true">
    <form method="dialog" id="sheet-form"></form>
  </dialog>`;
}
