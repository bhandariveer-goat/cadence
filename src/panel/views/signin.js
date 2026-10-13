// Signing in. The first thing anyone sees, and the reason a plan has a name on
// it: nothing is shown, and no sample data is loaded, until Cadence knows whose
// week this is.
//
// Two kinds of account. With an email, a six-digit code signs you in and the
// plan follows you between the extension and the website. Without one, the
// account is a name kept in this browser; it is honest about that limit and
// can be upgraded to an email later.

import { app, render, signInLocal, signInCloud, resolvePlanConflict, planConflict, insideCanvas, STANDALONE } from '../core.js';
import { svg, I, esc, toast, flash } from '../ui.js';
import { cloudConfigured } from '../../config.js';
import { ART } from './parts.js';

export const pageUrl = (page) => new URL(`../../../${page}`, import.meta.url).href;

function draft() {
  app.signin ||= {};
  return Object.assign(app.signin, { step: app.signin.step || 'start' });
}

export function viewSignIn() {
  const d = draft();
  const cloud = cloudConfigured();

  if (d.step === 'conflict' || planConflict()) {
    // Two ways to get here: signing in to an account that already has a plan
    // from a device that also has one, or the same plan changed on two devices
    // before either could save. Either way it is the person's call.
    const diverged = app.S.cloud?.conflict === 'diverged';
    return `<div class="signin">
      <h1>${diverged ? 'Your plan changed in two places' : 'This account already has a plan'}</h1>
      <p class="lead">${diverged
        ? 'Changes were made on this device and somewhere else before they could be saved together. Cadence will not pick for you. Which plan should it keep?'
        : `There is a week saved under ${esc(d.email || app.S.account?.email || 'your account')}, and there is also one on this device. Which should Cadence use here?`}</p>
      ${d.error ? `<p class="form-error" role="alert">${esc(d.error)}</p>` : ''}
      <div class="signin-choices">
        <button class="btn primary block" data-act="signin-keep" data-keep="cloud">Use the one saved to my account</button>
        <button class="btn soft block" data-act="signin-keep" data-keep="device">Keep what is on this device</button>
      </div>
      <p class="hint">${diverged
        ? 'The plan you do not choose is replaced, along with the changes that were only in it.'
        : "Keeping this device's plan replaces the one saved to the account."}</p>
    </div>`;
  }

  if (d.step === 'code') {
    return `<div class="signin">
      <h1>Check your email</h1>
      <p class="lead">We sent a six-digit code to <b>${esc(d.email)}</b>. It can take a minute to arrive.</p>
      <form class="signin-form" data-form="signin-code" autocomplete="off">
        <label class="field"><span>Code</span>
          <input type="text" class="code-input" name="code" value="${esc(d.code || '')}" inputmode="numeric" maxlength="6" autocomplete="one-time-code" spellcheck="false" placeholder="123456" required data-error="Enter the six-digit code from the email."></label>
        <label class="field"><span>Your name</span>
          <input type="text" name="name" value="${esc(d.name || d.canvasName || '')}" maxlength="60" autocomplete="given-name" required data-error="Enter a name for Cadence to call you."></label>
        ${d.error ? `<p class="form-error" role="alert">${esc(d.error)}</p>` : ''}
        <button class="btn primary block" type="submit" ${d.busy ? 'aria-busy="true"' : ''}>${d.busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <p class="form-success" id="signin-status" role="status"></p>
      <p class="signin-more">
        <button class="link" data-act="signin-resend" ${d.resending ? 'aria-busy="true"' : ''}>${d.resending ? 'Sending a new code…' : 'Send a new code'}</button>
        <button class="link" data-act="signin-back">Use a different email</button>
      </p>
    </div>`;
  }

  // Someone already using Cadence on this device, adding an email to it (or
  // signing back in after a session ended). Their plan is not going anywhere.
  if (d.upgrading && cloud) {
    const again = app.S.account?.mode === 'cloud';
    return `<div class="signin">
      <h1>${again ? 'Sign in again' : 'Add an email'}</h1>
      <p class="lead">${again
        ? 'Your plan is still on this device. Sign in to start saving it to your account again.'
        : 'Your plan stays as it is. With an email it is also saved to your account, so the Chrome extension and the website show the same week.'}</p>
      <form class="signin-form" data-form="signin-email" autocomplete="on">
        <label class="field"><span>School or personal email</span>
          <input type="email" name="email" value="${esc(d.email || '')}" autocomplete="email" spellcheck="false" placeholder="you@school.org" required data-error="Enter an email like you@school.org."></label>
        ${d.error ? `<p class="form-error" role="alert">${esc(d.error)}</p>` : ''}
        <button class="btn primary block" type="submit" ${d.busy ? 'aria-busy="true"' : ''}>${d.busy ? 'Sending…' : 'Email me a sign-in code'}</button>
      </form>
      <p class="hint">No password. We send a six-digit code.</p>
      <button class="link mt4" data-act="signin-cancel">Go back without adding one</button>
    </div>`;
  }

  return `<div class="signin">
    <div class="art">${ART}</div>
    <h1>${insideCanvas ? 'Set up Cadence' : cloud ? 'Sign in to Cadence' : 'Start using Cadence'}</h1>
    <p class="lead">Your classes, activities and assignments on one calendar, with the time to do them already planned.</p>

    ${cloud ? `
      <form class="signin-form" data-form="signin-email" autocomplete="on">
        <label class="field"><span>School or personal email</span>
          <input type="email" name="email" value="${esc(d.email || '')}" autocomplete="email" spellcheck="false" placeholder="you@school.org" required data-error="Enter an email like you@school.org."></label>
        ${d.error && d.errorFor === 'email' ? `<p class="form-error" role="alert">${esc(d.error)}</p>` : ''}
        <button class="btn primary block" type="submit" ${d.busy ? 'aria-busy="true"' : ''}>${d.busy ? 'Sending…' : 'Email me a sign-in code'}</button>
      </form>
      <p class="hint">No password. The same account works in the Chrome extension and on the website, so they show the same week.</p>
      <div class="signin-or"><span>or</span></div>` : ''}

    <form class="signin-form" data-form="signin-local" autocomplete="on">
      <label class="field"><span>${cloud ? 'Your name, to use it on this device only' : 'Your name'}</span>
        <input type="text" name="name" value="${esc(d.name || d.canvasName || '')}" maxlength="60" autocomplete="given-name" required data-error="Enter a name for Cadence to call you."></label>
      ${d.error && d.errorFor === 'local' ? `<p class="form-error" role="alert">${esc(d.error)}</p>` : ''}
      <button class="btn ${cloud ? 'soft' : 'primary'} block" type="submit">${d.canvasName && !cloud ? `Start as ${esc(d.canvasName.split(' ')[0])}` : 'Start planning'}</button>
    </form>
    <p class="hint">${cloud
      ? 'Without an email your plan stays in this browser only. You can add an email later.'
      : 'Your plan is kept in this browser.'}</p>

    <p class="signin-foot">
      ${STANDALONE ? `<a href="${esc(pageUrl('demo.html'))}">Try the demo</a>` : ''}
      <a href="${esc(pageUrl('privacy.html'))}" target="_blank" rel="noopener">Privacy</a>
      <a href="${esc(pageUrl('terms.html'))}" target="_blank" rel="noopener">Terms</a>
      <a href="${esc(pageUrl('contact.html'))}" target="_blank" rel="noopener">Contact</a>
    </p>
  </div>`;
}

const fail = (message, errorFor) => { Object.assign(draft(), { error: message, errorFor, busy: false }); render(); };

export const submitActions = {
  'signin-local': async (form, data) => {
    try { await signInLocal(data.get('name')); app.signin = null; }
    catch (e) { fail(e.message, 'local'); }
  },

  'signin-email': async (form, data) => {
    const d = draft();
    if (d.busy) return;
    const email = String(data.get('email') || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('Enter an email like you@school.org.', 'email');
    Object.assign(d, { email, busy: true, error: null, code: '' });
    render();
    try {
      await app.cloud.sendCode(email);
      Object.assign(d, { step: 'code', busy: false });
      render();
    } catch (e) { fail(e.message, 'email'); }
  },

  'signin-code': async (form, data) => {
    const d = draft();
    if (d.busy) return;
    const code = String(data.get('code') || '').replace(/\D/g, '');
    const name = String(data.get('name') || '').trim();
    if (code.length !== 6) return fail('Enter the six-digit code from the email.', 'code');
    Object.assign(d, { name, code, busy: true, error: null });
    render();
    try {
      const { conflict, remote } = await signInCloud(d.email, code, name);
      if (conflict) { Object.assign(d, { step: 'conflict', remote, busy: false }); return render(); }
      app.signin = null;
      render();
      toast('Signed in');
    } catch (e) { fail(e.message, 'code'); }
  }
};

export const actions = {
  'signin-back': () => { Object.assign(draft(), { step: 'start', error: null, busy: false, code: '' }); render(); },
  // A code that never arrived, or ran out. What is already typed is kept, and
  // the result is said next to the form: sent, or why not.
  'signin-resend': async () => {
    const d = draft();
    if (d.busy || d.resending || !d.email) return;
    const typed = (name) => document.querySelector(`.signin-form [name="${name}"]`)?.value;
    Object.assign(d, { resending: true, error: null, code: typed('code') ?? d.code, name: typed('name') ?? d.name });
    render();
    try {
      await app.cloud.sendCode(d.email);
      d.resending = false;
      render();
      flash('signin-status', `A new code is on its way to ${d.email}. Use the newest one.`, 20000);
    } catch (e) {
      d.resending = false;
      fail(e.message, 'code');
    }
  },
  'signin-cancel': () => { app.signin = null; render(); },
  'signin-keep': async (el) => {
    const d = draft();
    try {
      await resolvePlanConflict(el.dataset.keep, d.remote || null);
      app.signin = null;
      render();
    } catch (e) { Object.assign(d, { error: e.message }); render(); }
  }
};
