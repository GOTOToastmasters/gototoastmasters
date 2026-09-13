/**
 * onboarding-hub.test.js — proves the client logic of docs/onboarding/index.html.
 *
 * The hub is a Google-Identity-gated SPA. jsdom won't load the external GIS
 * script, so we stub `window.google` and drive handleCredentialResponse() with a
 * hand-built ID token, plus a mocked hubPost/fetch. Covers:
 *   - auth gating: server "Access denied" → denied screen, app stays hidden,
 *     committee user → app shown (auth-refactor handoff, client side)
 *   - hubPost sends the ID token + uses the simple-CORS text/plain content type (A1)
 *   - rowsToObjects header normalisation (mirrors the GAS dataRangeToObject)
 *   - norm / esc helpers
 *   - onboarding checklist includes the new Member Goals + LinkedIn steps
 *     (feat/onboarding-checklist-steps)
 *   - dashboard reflects the loaded data (prospect count, signed-in email)
 */
'use strict';

const { loadPage } = require('./jsdom-harness');
const A = require('./assert');

const PAGE = 'docs/onboarding/index.html';
const waitTicks = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

// Minimal unsigned JWT: header.payload.sig, payload base64url-encoded (as GIS emits).
function makeIdToken(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.sig`;
}

// Stub GIS so gisLoaded()/signOut() have something to call.
function stubGoogle(window) {
  window.google = { accounts: { id: {
    initialize() {}, renderButton() {}, disableAutoSelect() {}, prompt() {},
  } } };
}

// A hubPost/fetch double that returns whatever the test wants for action:getAll.
function serverFetch(responseFor) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const payload = responseFor(body) || {};
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  };
}

const ML_HEADERS = ['First', 'Last', 'Email', 'Status', 'Invoice Paid Date', 'TI Payment Submitted', 'Onboarding Complete', 'Membership Until'];
const GETALL_DATA = {
  data: {
    'Member List': [
      ML_HEADERS,
      ['Ann', 'Prospect', 'ann@x.com', 'Prospect', '', '', '', ''],
      ['Bob', 'Active', 'bob@x.com', 'Active', '01/07/2026', '', '', ''],
    ],
    'Onboarding': [], 'Invoices': [], 'Transactions': [], 'Errors': [],
  },
};

async function signIn(fetchImpl) {
  const ctx = await loadPage(PAGE, { fetch: fetchImpl, url: 'https://gototoastmasters.com.au/onboarding' });
  stubGoogle(ctx.window);
  const token = makeIdToken({ email: 'chair@gototoastmasters.com.au', name: 'Chair', email_verified: true });
  await ctx.window.handleCredentialResponse({ credential: token });
  await waitTicks();
  return { ...ctx, token };
}

// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  A.section('hub — pure helpers');
  {
    const { window } = await loadPage(PAGE);
    A.eq(window.norm('  Active '), 'active', 'norm lowercases + trims');
    A.eq(window.norm(null), '', 'norm(null) → empty string');
    A.eq(window.esc('<b>"Tom & Jerry"</b>'), '&lt;b&gt;&quot;Tom &amp; Jerry&quot;&lt;/b&gt;', 'esc escapes &<>"');

    A.eq(window.rowsToObjects([]), [], 'empty input → []');
    A.eq(window.rowsToObjects([['H1', 'H2']]), [], 'header-only input → [] (needs >= 2 rows)');

    const objs = window.rowsToObjects([
      ['First Name', 'Email', 'Onboarding Complete'],
      ['Rob', 'r@x.com', 'TRUE'],
    ]);
    A.eq(objs.length, 1, 'one data row → one object');
    A.eq(objs[0].first_name, 'Rob', 'header "First Name" → key first_name');
    A.eq(objs[0].onboarding_complete, 'TRUE', 'header "Onboarding Complete" → onboarding_complete');
    A.eq(objs[0]._rowNumber, 2, 'rowNumber tracked (1-based, +header)');
  }

  A.section('hub — auth gating: non-committee user is denied');
  {
    const { window, fetchCalls } = await signIn(serverFetch(() => ({ error: 'Access denied' })));
    A.eq(window.document.getElementById('denied-msg').style.display, 'block', 'denied message shown');
    A.ok(window.document.getElementById('app-view').style.display !== 'block', 'app view NOT revealed for non-committee');
    A.eq(fetchCalls[0].body.action, 'getAll', 'first call is action:getAll');
  }

  A.section('hub — auth gating: committee user gets the app');
  {
    const { window } = await signIn(serverFetch((b) => (b.action === 'getAll' ? GETALL_DATA : {})));
    A.eq(window.document.getElementById('app-view').style.display, 'block', 'app view revealed');
    A.eq(window.document.getElementById('login-view').style.display, 'none', 'login view hidden');
    A.ok(window.document.getElementById('denied-msg').style.display !== 'block', 'no denied message for committee');
  }

  A.section('hub — hubPost carries the ID token + simple-CORS content type');
  {
    const { fetchCalls, token } = await signIn(serverFetch(() => GETALL_DATA));
    A.eq(fetchCalls[0].body.idToken, token, 'ID token sent in the POST body (server verifies committee membership)');
    A.eq(fetchCalls[0].init.headers['Content-Type'], 'text/plain;charset=utf-8', 'text/plain content type → no CORS preflight (A1)');
  }

  A.section('hub — dashboard reflects loaded data');
  {
    const { window } = await signIn(serverFetch(() => GETALL_DATA));
    const html = window.renderDashboard();
    const m = html.match(/tile-count">(\d+)<\/div>\s*<div class="tile-label">Applications to review/);
    A.ok(m && m[1] === '1', 'dashboard counts 1 prospect (Ann)');
    A.ok(html.includes('chair@gototoastmasters.com.au'), 'shows the signed-in committee email');
  }

  A.section('hub — onboarding checklist includes the new Member Goals + LinkedIn steps');
  {
    const { window } = await loadPage(PAGE);
    const member = { email: 'bob@x.com', first: 'Bob', last: 'Active', status: 'Active', invoice_paid_date: '01/07/2026' };
    const html = window.renderMemberManagement(member, null, {}, false);
    A.ok(html.includes('Member goals discussion'), 'checklist has the Member Goals step');
    A.ok(html.includes('LinkedIn follow/connection'), 'checklist has the LinkedIn step');
    A.ok(html.includes("markChecklistStep('bob@x.com','member_goals_discussion'"), 'Member Goals step wired to markChecklistStep with its key');
    A.ok(html.includes('Club Central registered'), 'original checklist steps still present');
  }
  {
    // Checklist stays locked until a paid date exists.
    const { window } = await loadPage(PAGE);
    const html = window.renderMemberManagement({ email: 'x@x.com', first: 'X', last: 'Y', status: 'Prospect' }, null, {}, false);
    A.ok(html.includes('Checklist unlocks when Invoice Paid Date is set'), 'checklist locked without a paid date');
  }

  process.exit(A.summary() ? 0 : 1);
})();
