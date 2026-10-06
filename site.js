// Fills in who runs this copy of Cadence on the public pages, from the one
// place that is written down (src/config.js). Until those fields are filled
// in, the pages say so rather than showing an invented name or address.

import { CONFIG, cloudConfigured } from './src/config.js';

const site = CONFIG.site || {};
const pending = (what) => `<span class="pending">${what} to be added before launch</span>`;

for (const el of document.querySelectorAll('[data-site]')) {
  const key = el.dataset.site;
  if (key === 'operator') el.innerHTML = site.operator ? escapeHtml(site.operator) : pending('Operator name');
  if (key === 'contact') el.innerHTML = site.contactEmail ? `<a href="mailto:${escapeHtml(site.contactEmail)}">${escapeHtml(site.contactEmail)}</a>` : pending('Contact email');
  if (key === 'domain') el.textContent = site.domain || location.host;
}

// Sentences about email sign-in and sync only make sense once they exist.
for (const el of document.querySelectorAll('[data-needs="cloud"]')) el.hidden = !cloudConfigured();
for (const el of document.querySelectorAll('[data-needs="no-cloud"]')) el.hidden = cloudConfigured();

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
