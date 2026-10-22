// Signing in. The first thing anyone sees, and the reason a plan has a name on
// it: nothing is shown, and no sample data is loaded, until Cadence knows whose
// week this is.
//
// Two kinds of account. With an email, the plan is kept in your account, so it
// follows you between the extension and the website: you make the account
// with your email, a code sent to it, and a password, and after that sign in
// with the email and password (or a code, if the password is forgotten).
// Without one, the account is a name kept in this browser; it is honest about
// that limit and can be upgraded to an email later.

import { app, render, signInLocal, signInCloud, signInPassword, hadAccount, nameAccount, resolvePlanConflict, planConflict, insideCanvas, STANDALONE, pendingInvite, params } from '../core.js';
import { CONFIG, cloudConfigured } from '../../config.js';
import { svg, I, esc, toast, flash } from '../ui.js';
import { ART } from './parts.js';

/**
 * A page of the website, by file name. On the website it is a sibling page.
 * In the Chrome extension it is the website's own copy when this copy knows
 * the site's address, so the store package does not need to carry the public
 * pages; an unpacked folder without one still has them alongside.
 */
export const pageUrl = (page) => (!/^https?:$/.test(location.protocol) && CONFIG.site?.domain
  ? new URL(`/${page}`, `https://${CONFIG.site.domain}`).href
  : new URL(`../../../${page}`, import.meta.url).href);

// Codes are six digits unless whoever runs the project chose longer ones.
const CODE = /^\d{6,10}$/;

/**
 * Where a sign-in link should lead, for a project whose email carries a link
 * instead of a code: this app, on the website. Inside the extension that is
 * the website's address, if this copy of Cadence has been told what it is.
 */
const returnAddress = () => (/^https?:$/.test(location.protocol) ? pageUrl('app')
  : CONFIG.site?.domain ? `https://${CONFIG.site.domain}/app` : '');

// Passwords are at least this long. The project's own rule can ask for more,
// and the server then says what is missing.
const MIN_PASSWORD = 8;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// A new account's password, kept here between sending the code and checking
// it, so it can be set the moment the email is proven. Nowhere else: not in
// the plan, not in browser storage, and gone once it is used or abandoned.
let pendingPassword = '';

/** Where sign-in is up to (start, code, password, name, conflict), which way
    in (sign in or create an account) and what was typed, kept until it is done. */
function draft() {
  app.signin ||= {};
  return Object.assign(app.signin, { step: app.signin.step || 'start' });
}

/** Sign in, or create an account: what the form shows unless the person has
    picked. Someone who has used an email account in this browser before is
    most likely coming back; anyone else is most likely new. */
function modeOf(d, { again = false } = {}) {
  if (d.mode) return d.mode;
  if (d.upgrading) return again ? 'signin' : 'create';
  return hadAccount() ? 'signin' : 'create';
}

// The fields both ways in use. A password field has Show beside it, and its
// value is never written back into the page: after an error it is typed again.
const emailField = (d) => `<label class="field"><span>School or personal email</span>
  <input type="email" id="signin-email" name="email" value="${esc(d.email || '')}" autocomplete="email" spellcheck="false" placeholder="you@school.org" required data-error="Enter an email like you@school.org."></label>`;
const passwordField = (id, name, label, autocomplete, error) => `<div class="field"><label for="${id}">${label}</label>
  <div class="with-btn"><input type="password" id="${id}" name="${name}" autocomplete="${autocomplete}" spellcheck="false" required data-error="${esc(error)}">
    <button type="button" class="btn soft" data-reveal="${id}" data-what="the password" aria-label="Show the password">Show</button></div></div>`;
const formError = (d, ...fields) => (d.error && fields.includes(d.errorFor) ? `<p class="form-error" role="alert">${esc(d.error)}</p>` : '');

/** The email form, one of two ways: signing in with a password (and a way to
    have a code emailed instead), or making an account (email, password twice). */
function accountForm(d, mode) {
  if (mode === 'signin') {
    return `
      <form class="signin-form" data-form="signin-password" autocomplete="on">
        ${emailField(d)}
        ${passwordField('signin-pw', 'password', 'Password', 'current-password', 'Enter your password.')}
        ${formError(d, 'email', 'password')}
        <button class="btn primary block" type="submit" ${d.busy ? 'aria-busy="true"' : ''}>${d.busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <p class="signin-more">
        <button class="link" data-act="signin-code-instead" ${d.sending ? 'aria-busy="true"' : ''}>${d.sending ? 'Sending a code…' : 'Forgot your password, or never set one? Email me a code'}</button>
      </p>
      <p class="hint">New to Cadence? <button class="link" data-act="signin-mode" data-mode="create">Create an account</button></p>`;
  }
  return `
    <form class="signin-form" data-form="signin-create" autocomplete="on">
      ${emailField(d)}
      ${passwordField('signin-pw', 'password', `Password <small>(at least ${MIN_PASSWORD} characters)</small>`, 'new-password', 'Choose a password.')}
      ${passwordField('signin-pw2', 'password2', 'Type the password again', 'new-password', 'Type the password again.')}
      ${formError(d, 'email', 'password')}
      <button class="btn primary block" type="submit" ${d.busy ? 'aria-busy="true"' : ''}>${d.busy ? 'Sending a code…' : 'Create account'}</button>
    </form>
    <p class="hint">Cadence emails you a code to check the address is yours. After that, you sign in with your email and this password, in the Chrome extension and on the website.</p>
    <p class="hint">Already have an account? <button class="link" data-act="signin-mode" data-mode="signin">Sign in</button></p>`;
}

/** The sign-in screen, at whatever step it is on: setting a password, choosing
    between two plans after a conflict, a name for a new account, the code from
    the email, or the start (sign in, create an account, or go on without one). */
export function viewSignIn() {
  const d = draft();
  const cloud = cloudConfigured();

  // Just signed in: a password for next time. Asked before the "which plan?"
  // question, which follows it.
  if (d.step === 'password') {
    const retry = d.purpose === 'create';
    return `<div class="signin">
      <h1>${retry ? 'Set your password' : 'Set a password'}</h1>
      <p class="lead">${retry
        ? 'Your account is made and you are signed in, but the password was not saved. Try it again here.'
        : 'Next time, sign in with your email and this password instead of waiting for a code.'}</p>
      <form class="signin-form" data-form="signin-setpass" autocomplete="on">
        <input type="email" name="email" value="${esc(d.email || '')}" autocomplete="username" hidden>
        ${passwordField('signin-pw', 'password', `New password <small>(at least ${MIN_PASSWORD} characters)</small>`, 'new-password', 'Choose a password.')}
        ${passwordField('signin-pw2', 'password2', 'Type it again', 'new-password', 'Type the password again.')}
        ${formError(d, 'password')}
        <button class="btn primary block" type="submit" ${d.busy ? 'aria-busy="true"' : ''}>${d.busy ? 'Saving…' : 'Save password'}</button>
      </form>
      <button class="link mt4" data-act="signin-skip-password">Skip for now</button>
      <p class="hint">You can set or change it any time in Account.</p>
    </div>`;
  }

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

  // Signed in by opening the link in the email, so nobody has typed a name yet.
  if (d.step === 'name') {
    return `<div class="signin">
      <h1>You are signed in</h1>
      <p class="lead">One thing is missing: what should Cadence call you?</p>
      <form class="signin-form" data-form="signin-name" autocomplete="on">
        <label class="field"><span>Your name</span>
          <input type="text" name="name" value="${esc(d.name || '')}" maxlength="60" autocomplete="given-name" required data-error="Enter a name for Cadence to call you."></label>
        ${d.error ? `<p class="form-error" role="alert">${esc(d.error)}</p>` : ''}
        <button class="btn primary block" type="submit">Start planning</button>
      </form>
    </div>`;
  }

  if (d.step === 'code') {
    const making = d.purpose === 'create';
    return `<div class="signin">
      <h1>Check your email</h1>
      <p class="lead">We sent a code to <b>${esc(d.email)}</b>. Type it here to ${making ? 'finish making your account' : 'sign in'}. It can take a minute to arrive.</p>
      <form class="signin-form" data-form="signin-code" autocomplete="off">
        <label class="field"><span>Code</span>
          <input type="text" class="code-input" name="code" value="${esc(d.code || '')}" inputmode="numeric" maxlength="10" autocomplete="one-time-code" spellcheck="false" placeholder="123456" required data-error="Enter the code from the email."></label>
        ${d.error ? `<p class="form-error" role="alert">${esc(d.error)}</p>` : ''}
        <button class="btn primary block" type="submit" ${d.busy ? 'aria-busy="true"' : ''}>${d.busy ? 'Checking…' : making ? 'Create account' : 'Sign in'}</button>
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
    if (again && !d.email) d.email = app.S.account.email || '';
    return `<div class="signin">
      <h1>${again ? 'Sign in again' : 'Add an email'}</h1>
      <p class="lead">${again
        ? 'Your plan is still on this device. Sign in to start saving it to your account again.'
        : 'Your plan stays as it is. With an email it is also saved to your account, so the Chrome extension and the website show the same week.'}</p>
      ${consentBox()}
      ${accountForm(d, modeOf(d, { again }))}
      <button class="link mt4" data-act="signin-cancel">Go back without ${again ? 'signing in' : 'adding one'}</button>
    </div>`;
  }

  const invite = cloud ? pendingInvite() : null;
  const mode = modeOf(d);
  return `<div class="signin">
    <div class="art">${ART}</div>
    <h1>${insideCanvas ? 'Set up Cadence' : !cloud ? 'Start using Cadence' : mode === 'signin' ? 'Sign in to Cadence' : 'Create your Cadence account'}</h1>
    <p class="lead">Your classes, activities and assignments on one calendar, with the time to do them already planned.</p>
    ${params.get('welcome') === '1' && typeof chrome !== 'undefined' && chrome.runtime?.id ? `<div class="card soft small mb4" role="status"><b>Cadence is installed.</b> Open Canvas in this browser (refresh it if it was already open) and press the Cadence button at the bottom right. Your assignments come in from there. You can also sign in here first.</div>` : ''}
    ${invite ? `<div class="card soft small mb4" role="status"><b>You have an invite</b> to ${invite.kind === 'club' ? 'join a club' : 'be accountability partners'}. Sign in with your email to accept it: partners and clubs need an email account.</div>` : ''}

    ${consentBox()}
    ${cloud ? `${accountForm(d, mode)}
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

// Shows `message` next to the field it is about (`errorFor`) and stops the busy state.
const fail = (message, errorFor) => { Object.assign(draft(), { error: message, errorFor, busy: false }); render(); };

// Agreeing to the terms, and saying you are 13 or older, before an account is
// made. Asked once: an account that has agreed is not asked again. The moment
// is kept in this browser until the account exists (an email sign-in link can
// open in another tab), then saved with the plan (core.js consentStamp).
const CONSENT_SLOT = 'cadence.consented-at';
// Only asked until it has been agreed to once.
const needsConsent = () => !app.S.profile?.consentedAt;
// The age and terms checkbox, with its error under it when it was missed.
const consentBox = () => (needsConsent() ? `
  <label class="toggle consent mb3"><input type="checkbox" id="consent" ${draft().consented ? 'checked' : ''}><i></i>
    <span>I am 13 or older and agree to the <a href="${esc(pageUrl('terms.html'))}" target="_blank" rel="noopener">Terms</a> and the <a href="${esc(pageUrl('privacy.html'))}" target="_blank" rel="noopener">Privacy Policy</a>
      <small>If you are under 18, check with a parent or guardian first.</small></span></label>
  ${draft().errorFor === 'consent' ? `<p class="field-error" role="alert">${esc(draft().error)}</p>` : ''}` : '');

/** True when the box is ticked (or was agreed before); otherwise says so next to it. */
function consented() {
  if (!needsConsent()) return true;
  const box = document.getElementById('consent');
  if (box?.checked) {
    draft().consented = true;
    try { localStorage.setItem(CONSENT_SLOT, new Date().toISOString()); } catch { /* saved with the plan instead */ }
    return true;
  }
  fail('Tick the box to say you are 13 or older and agree to the Terms and Privacy Policy.', 'consent');
  return false;
}

/** The name a sign-in carries with it: one this device already knows, if any. */
const knownName = (d) => String(app.S.account?.name || app.S.profile?.name || d.canvasName || '').trim();

/**
 * Where a successful sign-in goes next: the "which plan?" question if this
 * device and the account both have one, a name if the account has none, or
 * straight into the app.
 */
function signedInNext(d, { conflict = false, remote = null } = {}, said = 'Signed in') {
  if (conflict) { Object.assign(d, { step: 'conflict', remote, busy: false, error: null, after: null }); return render(); }
  if (!app.S.account?.name) { app.signin = { step: 'name', name: '' }; return render(); }
  app.signin = null;
  render();
  toast(said);
}

/** A new password, checked here before it goes anywhere: long enough, and typed the same twice. */
function newPassword(data) {
  const password = String(data.get('password') || '');
  if (password.length < MIN_PASSWORD) { fail(`Use at least ${MIN_PASSWORD} characters for the password.`, 'password'); return null; }
  if (password !== String(data.get('password2') || '')) { fail('The two passwords are not the same. Type them again.', 'password'); return null; }
  return password;
}

/** Emails a code to `email` and shows the box to type it in. `purpose` is
    'create' (finishing a new account) or 'code' (signing in without the password). */
async function sendCodeTo(d, email, purpose) {
  await app.cloud.sendCode(email, returnAddress());
  Object.assign(d, { step: 'code', purpose, email, code: '', busy: false, sending: false, error: null });
  render();
}

export const submitActions = {
  'signin-local': async (form, data) => {
    if (!consented()) return;
    try { await signInLocal(data.get('name')); app.signin = null; }
    catch (e) { fail(e.message, 'local'); }
  },

  // Email and password.
  'signin-password': async (form, data) => {
    const d = draft();
    if (d.busy) return;
    const email = String(data.get('email') || '').trim().toLowerCase();
    const password = String(data.get('password') || '');
    d.email = email;                      // kept through a mistake: only the password is typed again
    if (!consented()) return;
    if (!EMAIL.test(email)) return fail('Enter an email like you@school.org.', 'email');
    if (!password) return fail('Enter your password.', 'password');
    Object.assign(d, { email, busy: true, error: null });
    render();
    try { signedInNext(d, await signInPassword(email, password, knownName(d))); }
    catch (e) { fail(e.message, 'password'); }
  },

  // A new account: the email is proven with a code first, then the password is set.
  'signin-create': async (form, data) => {
    const d = draft();
    if (d.busy) return;
    const email = String(data.get('email') || '').trim().toLowerCase();
    d.email = email;                      // kept through a mistake: only the passwords are typed again
    if (!consented()) return;
    if (!EMAIL.test(email)) return fail('Enter an email like you@school.org.', 'email');
    const password = newPassword(data);
    if (!password) return;
    Object.assign(d, { email, busy: true, error: null });
    render();
    try {
      pendingPassword = password;
      await sendCodeTo(d, email, 'create');
    } catch (e) { pendingPassword = ''; fail(e.message, 'email'); }
  },

  'signin-name': async (form, data) => {
    try { await nameAccount(data.get('name')); app.signin = null; render(); }
    catch (e) { fail(e.message, 'name'); }
  },

  'signin-code': async (form, data) => {
    const d = draft();
    if (d.busy) return;
    const code = String(data.get('code') || '').replace(/\D/g, '');
    if (!CODE.test(code)) return fail('Enter the code from the email. It is six digits, sometimes more.', 'code');
    Object.assign(d, { code, busy: true, error: null });
    render();
    let result;
    try { result = await signInCloud(d.email, code, knownName(d)); }
    catch (e) { return fail(e.message, 'code'); }
    // A new account gets the password it was made with, now that the email is proven.
    if (d.purpose === 'create' && pendingPassword) {
      const password = pendingPassword;
      pendingPassword = '';
      try {
        await app.cloud.setPassword(password);
        return signedInNext(d, result, 'Your account is ready');
      } catch (e) {
        Object.assign(d, { step: 'password', after: result, busy: false, error: e.message, errorFor: 'password' });
        return render();
      }
    }
    // Signed in with a code instead of a password (forgotten, never set, or a
    // page reloaded mid-way): offer to set one for next time.
    Object.assign(d, { step: 'password', purpose: d.purpose === 'create' ? 'set' : d.purpose, after: result, busy: false, error: null });
    render();
  },

  // A password set just after signing in, for next time.
  'signin-setpass': async (form, data) => {
    const d = draft();
    if (d.busy) return;
    const password = newPassword(data);
    if (!password) return;
    Object.assign(d, { busy: true, error: null });
    render();
    try {
      await app.cloud.setPassword(password);
      signedInNext(d, d.after || {}, 'Password saved');
    } catch (e) { fail(e.message, 'password'); }
  }
};

export const actions = {
  'signin-back': () => { pendingPassword = ''; Object.assign(draft(), { step: 'start', error: null, busy: false, code: '' }); render(); },
  // Sign in, or create an account. What is typed in the email box is kept.
  'signin-mode': (el) => {
    const d = draft();
    const typed = document.getElementById('signin-email')?.value;
    Object.assign(d, { mode: el.dataset.mode === 'signin' ? 'signin' : 'create', error: null, email: typed ?? d.email });
    render();
    document.getElementById('signin-email')?.focus();
  },
  // A forgotten password, or an account made before passwords: a code by email instead.
  'signin-code-instead': async () => {
    const d = draft();
    if (d.busy || d.sending) return;
    const email = String(document.getElementById('signin-email')?.value || '').trim().toLowerCase();
    d.email = email;
    if (!consented()) return;
    if (!EMAIL.test(email)) return fail('Type your email above first, then ask for a code.', 'email');
    Object.assign(d, { email, sending: true, error: null });
    render();
    try { await sendCodeTo(d, email, 'code'); }
    catch (e) { d.sending = false; fail(e.message, 'email'); }
  },
  'signin-skip-password': () => { const d = draft(); signedInNext(d, d.after || {}); },
  // A code that never arrived, or ran out. What is already typed is kept, and
  // the result is said next to the form: sent, or why not.
  'signin-resend': async () => {
    const d = draft();
    if (d.busy || d.resending || !d.email) return;
    const typed = (name) => document.querySelector(`.signin-form [name="${name}"]`)?.value;
    Object.assign(d, { resending: true, error: null, code: typed('code') ?? d.code, name: typed('name') ?? d.name });
    render();
    try {
      await app.cloud.sendCode(d.email, returnAddress());
      d.resending = false;
      render();
      flash('signin-status', `A new code is on its way to ${d.email}. Use the newest one.`, 20000);
    } catch (e) {
      d.resending = false;
      fail(e.message, 'code');
    }
  },
  'signin-cancel': () => { pendingPassword = ''; app.signin = null; render(); },
  'signin-keep': async (el) => {
    const d = draft();
    try {
      await resolvePlanConflict(el.dataset.keep, d.remote || null);
      app.signin = null;
      render();
    } catch (e) { Object.assign(d, { error: e.message }); render(); }
  }
};
