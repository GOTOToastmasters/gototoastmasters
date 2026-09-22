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
 *   - display name resolves to Preferred Name, not InvoiceName (issue #29)
 *   - unpaid / overdue invoice derivation + invoices view (issue #30)
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


  A.section('hub — display name is the preferred name, not the invoice name');
  {
    // Fixtures go through the real getAll → rowsToObjects path so header
    // normalisation ('Preferred Name' → preferred_name) is exercised too.
    const HEADERS = ['First', 'Last', 'Preferred Name', 'InvoiceName', 'Email', 'Status',
                     'Invoice Paid Date', 'TI Payment Submitted', 'Onboarding Complete', 'Membership Until'];
    const DATA = {
      data: {
        'Member List': [
          HEADERS,
          // preferred name set, and an InvoiceName that differs
          ['Robert', 'Kenefeck', 'Bob', 'Robert J Kenefeck', 'bob@x.com', 'Active', '01/07/2026', '', '', ''],
          // no preferred name → falls back to First
          ['Jane', 'Smith', '', 'Jane Smith', 'jane@x.com', 'Active', '01/07/2026', '', '', ''],
          // no name parts at all → falls back to InvoiceName (company billing)
          ['', '', '', 'Acme Pty Ltd', 'acme@x.com', 'Active', '01/07/2026', '', '', ''],
          // a prospect, for the application review card
          ['Ann', 'Prospect', 'Annie', 'Ann R Prospect', 'ann@x.com', 'Prospect', '', '', '', ''],
        ],
        'Dietary': [
          ['Member Email', 'Dietary Requirements', 'Allergies', 'Accessibility Needs'],
          ['bob@x.com', 'Vegetarian', 'Nuts', ''],
        ],
        'Education': [
          ['Member Email', 'Edu Objectives', 'Main Edu Path', 'Levels To Complete'],
          ['bob@x.com', 'Level 3', 'Presentation Mastery', '2'],
        ],
        'Onboarding': [], 'Invoices': [], 'Transactions': [], 'Errors': [],
      },
    };

    const { window } = await signIn(serverFetch((b) => (b.action === 'getAll' ? DATA : {})));
    const doc = window.document;

    // ── members table ───────────────────────────────────────────────────────
    const members = window.renderMembers();
    A.ok(members.includes('Bob Kenefeck'), 'members table shows the preferred name "Bob Kenefeck"');
    A.ok(!members.includes('Robert J Kenefeck'), 'members table does NOT show the invoice name');
    A.ok(members.includes('Jane Smith'), 'no preferred name → falls back to First + Last');
    A.ok(members.includes('Acme Pty Ltd'), 'no name parts at all → falls back to InvoiceName');
    A.ok(!/undefined/.test(members), 'no "undefined" leaks into the rendered table');
    A.ok(!/<td>\s{2,}[A-Za-z]/.test(members), 'no stray whitespace from blank name parts');

    // ── search matches either name ──────────────────────────────────────────
    doc.getElementById('main-content').innerHTML = members;
    window.showView('members');
    const search = doc.querySelector('.filter-bar input[type="text"]');
    search.value = 'Robert';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    const filtered = doc.getElementById('main-content').innerHTML;
    A.ok(filtered.includes('bob@x.com'), 'searching the legal name "Robert" finds the member shown as "Bob"');
    A.ok(!filtered.includes('jane@x.com'), 'search still excludes non-matching members');

    // ── dietary + education views ───────────────────────────────────────────
    const dietary = window.renderDietary();
    A.ok(dietary.includes('Bob Kenefeck'), 'dietary view uses the display name');
    A.ok(!dietary.includes('Robert J Kenefeck'), 'dietary view does not use the invoice name');
    A.ok(window.renderEducation().includes('Bob Kenefeck'), 'education view uses the display name');
  }

  A.section('hub — application review shows both names (Club Central needs the legal one)');
  {
    const { window } = await loadPage(PAGE);
    const prospect = {
      email: 'ann@x.com', first: 'Ann', last: 'Prospect',
      preferred_name: 'Annie', invoicename: 'Ann R Prospect', status: 'Prospect',
    };
    const html = window.renderMemberDetail({ member: prospect });

    A.ok(html.includes('<h2 style="margin:0">Annie Prospect</h2>'), 'detail heading uses the preferred name');
    A.ok(html.includes('Preferred name'), 'application review labels the preferred name');
    A.ok(html.includes('Legal name (TI / invoice)'), 'application review also shows the legal name');
    A.ok(html.includes('Ann R Prospect'), 'the legal name is rendered for Club Central / TI');
    A.ok(html.includes("copyText('Ann R Prospect')"), 'copy button carries the LEGAL name, not the preferred one');

    // Google lookup must search the legal name once — it used to be duplicated.
    const m = html.match(/google\.com\/search\?q=([^"&]*)/);
    A.ok(m, 'google lookup link present for a prospect without LinkedIn');
    A.eq(decodeURIComponent(m[1]), 'Ann R Prospect', 'google lookup searches the legal name exactly once');
  }
  {
    // When there is nothing to disambiguate, the second row is not rendered.
    const { window } = await loadPage(PAGE);
    const html = window.renderMemberDetail({
      member: { email: 'j@x.com', first: 'Jane', last: 'Smith', invoicename: 'Jane Smith', status: 'Prospect' },
    });
    A.ok(html.includes('Preferred name'), 'preferred name row always rendered');
    A.ok(!html.includes('Legal name (TI / invoice)'), 'legal name row omitted when it matches the display name');
  }

  A.section('hub — legacy "Prefered Name" header still resolves');
  {
    // fix_schema.js renames the misspelled column, but a sheet predating that
    // rename must still resolve — resolveBadgeName_ in the backend does the same.
    const { window } = await loadPage(PAGE);
    const objs = window.rowsToObjects([
      ['First', 'Last', 'Prefered Name', 'InvoiceName', 'Email'],
      ['Robert', 'Kenefeck', 'Bob', 'Robert J Kenefeck', 'bob@x.com'],
    ]);
    A.eq(objs[0].prefered_name, 'Bob', 'legacy header normalises to prefered_name');
    A.eq(window.displayName(objs[0]), 'Bob Kenefeck', 'displayName accepts the legacy misspelling');
    A.eq(window.legalName(objs[0]), 'Robert J Kenefeck', 'legalName is unaffected');
  }

  A.section('hub — name helper edge cases');
  {
    const { window } = await loadPage(PAGE);
    A.eq(window.displayName({}), '', 'displayName of an empty row is an empty string, not "undefined"');
    A.eq(window.legalName({}), '', 'legalName of an empty row is an empty string');
    A.eq(window.displayName({ first: 'Solo' }), 'Solo', 'first name only — no trailing space');
    A.eq(window.displayName({ last: 'Surname' }), 'Surname', 'surname only — no leading space');
    A.eq(window.displayName({ preferred_name: '  Bob  ', last: '  Kenefeck ' }), 'Bob Kenefeck', 'whitespace trimmed on both parts');
    A.eq(window.displayName({ invoicename: 'Acme Pty Ltd' }), 'Acme Pty Ltd', 'falls back to InvoiceName when no name parts');
    A.eq(window.legalName({ first: 'Jane', last: 'Smith' }), 'Jane Smith', 'legalName falls back to first + last without InvoiceName');
  }


  A.section('hub — unpaid / overdue invoice derivation');
  {
    // Fixed clock so "overdue" arithmetic is deterministic.
    const NOW = new Date(2026, 8, 15); // 15 Sep 2026, local
    const past   = '01/08/2026';
    const future = '01/10/2026';

    const INV_HEADERS = ['Invoice Number', 'Invoice Date', 'Billing Name', 'Email', 'Notes',
                         'Amount Due', 'Due Date', 'Invoice Link', 'Email Sent', 'PDF Status',
                         'Paid Date', 'Invoice Status'];
    const inv = (num, email, due, emailSent, paidDate, status) =>
      [num, '01/07/2026', 'Billing Name', email, '', '340', due, '', emailSent, 'Generated', paidDate, status];

    const DATA = {
      data: {
        'Member List': [
          ['First', 'Last', 'Email', 'Status'],
          ['Leslie', 'Shroot', 'leslie@x.com', 'Active'],
        ],
        'Invoices': [
          INV_HEADERS,
          inv('2025064', 'leslie@x.com', past,   'Sent',           '',           ''),        // unpaid + overdue
          inv('2025065', 'leslie@x.com', future, 'Sent',           '',           'Live'),    // unpaid, not overdue
          inv('2025080', 'pend@x.com',   past,   'Pending',        '',           ''),        // never counted
          inv('2025081', 'rev@x.com',    past,   'Pending Review', '',           ''),        // never counted
          inv('2025082', 'no@x.com',     past,   'No',             '',           ''),        // never counted
          inv('2025052', 'test@x.com',   past,   'Sent',           '',           'Ignored'), // excluded everywhere
          inv('2025001', 'darren@x.com', past,   'Sent',           '01/08/2026', ''),        // paid
        ],
        'Onboarding': [], 'Transactions': [], 'Errors': [], 'Dietary': [], 'Education': [],
      },
    };

    const ctx = await loadPage(PAGE, {
      fetch: serverFetch((b) => (b.action === 'getAll' ? DATA : {})),
      url: 'https://gototoastmasters.com.au/onboarding',
      now: NOW,
    });
    stubGoogle(ctx.window);
    await ctx.window.handleCredentialResponse({
      credential: makeIdToken({ email: 'chair@gototoastmasters.com.au', name: 'Chair', email_verified: true }),
    });
    await waitTicks();
    const { window } = ctx;

    const nums = (list) => list.map(i => String(i.invoice_number)).sort();

    A.eq(nums(window.unpaidInvoices()), ['2025064', '2025065'], 'unpaid = Sent, no Paid Date, not Ignored');
    A.eq(nums(window.overdueInvoices()), ['2025064'], 'overdue = unpaid AND due date in the past');

    // invoicesList is a script-scope `let`, so it is not reachable as a window
    // property. Rebuild the same objects through the real normaliser instead.
    const invObjs = window.rowsToObjects(DATA.data['Invoices']);
    const byNum = (n) => invObjs.find(i => String(i.invoice_number) === n);

    A.ok(window.isUnpaidInvoice(byNum('2025064')), 'Sent + no paid date + past due → unpaid');
    A.ok(window.isOverdueInvoice(byNum('2025064')), '…and overdue');
    A.ok(window.isUnpaidInvoice(byNum('2025065')), 'Sent + no paid date + future due → unpaid');
    A.ok(!window.isOverdueInvoice(byNum('2025065')), '…but not overdue');

    A.ok(!window.isUnpaidInvoice(byNum('2025080')), 'Pending is not a debt — not yet sent');
    A.ok(!window.isUnpaidInvoice(byNum('2025081')), 'Pending Review is not a debt — committee gate');
    A.ok(!window.isUnpaidInvoice(byNum('2025082')), 'Email Sent = No is not a debt');

    A.ok(!window.isUnpaidInvoice(byNum('2025052')), 'Ignored excluded even though it looks overdue');
    A.ok(!window.isOverdueInvoice(byNum('2025052')), 'Ignored never counts as overdue');

    A.eq(window.invoiceStatusOf(byNum('2025064')), 'Live', 'blank Invoice Status reads as Live');
    A.ok(!window.isUnpaidInvoice(byNum('2025001')), 'Paid Date set → excluded from unpaid');

    // The Leslie Shroot case — the whole point of the issue.
    const leslie = window.unpaidInvoices().filter(i => i.email === 'leslie@x.com');
    A.eq(leslie.length, 2, 'a member with two outstanding invoices shows both');
    const leslieMixed = invObjs.filter(i => i.email === 'leslie@x.com' && window.invoiceIsPaid(i));
    A.eq(leslieMixed.length, 0, 'neither of Leslie\'s invoices is paid yet');

    A.eq(window.daysOverdue(byNum('2025064')), 45, 'days overdue counted from the due date (01/08 → 15/09)');
    A.eq(window.daysOverdue(byNum('2025065')), 0, 'not-yet-due invoice reports 0 days overdue');

    // ── dashboard tile matches the view ─────────────────────────────────────
    const dash = window.renderDashboard();
    const tile = dash.match(/tile-count">(\d+)<\/div>\s*<div class="tile-label">Unpaid invoices/);
    A.ok(tile, 'dashboard has an unpaid invoices tile');
    A.eq(tile[1], '2', 'tile count matches unpaidInvoices()');
    A.ok(/Unpaid invoices — 1 overdue/.test(dash), 'tile calls out the overdue count');
    A.ok(/class="tile alert"/.test(dash), 'tile uses the alert class while something is overdue');

    // ── the view itself ─────────────────────────────────────────────────────
    window.showView('invoices');
    const html = window.document.getElementById('main-content').innerHTML;
    A.ok(html.includes('2025064') && html.includes('2025065'), 'default filter shows both unpaid invoices');
    A.ok(!html.includes('2025001'), 'paid invoice hidden under the default filter');
    A.ok(!html.includes('2025052'), 'Ignored invoice hidden unless explicitly selected');
    A.ok(html.indexOf('2025064') < html.indexOf('2025065'), 'overdue sorts first');

    window.filterInvoices('ignored');
    const ignoredHtml = window.document.getElementById('main-content').innerHTML;
    A.ok(ignoredHtml.includes('2025052'), 'Ignored filter reveals ignored invoices');
    A.ok(!ignoredHtml.includes('2025064'), 'Ignored filter shows only ignored invoices');

    window.filterInvoices('paid');
    A.ok(window.document.getElementById('main-content').innerHTML.includes('2025001'), 'Paid filter shows the paid invoice');
    window.filterInvoices('unpaid'); // restore
  }

  A.section('hub — invoice columns absent (pre-schema-change sheet)');
  {
    // Before the two columns are added the tile must stay hidden rather than
    // reporting every sent invoice as unpaid.
    const DATA = {
      data: {
        'Member List': [['First', 'Last', 'Email', 'Status'], ['A', 'B', 'a@x.com', 'Active']],
        'Invoices': [
          ['Invoice Number', 'Billing Name', 'Email', 'Amount Due', 'Due Date', 'Email Sent', 'PDF Status'],
          ['2025001', 'A B', 'a@x.com', '340', '01/08/2026', 'Sent', 'Generated'],
        ],
        'Onboarding': [], 'Transactions': [], 'Errors': [],
      },
    };
    const { window } = await signIn(serverFetch((b) => (b.action === 'getAll' ? DATA : {})));
    A.ok(!window.invoiceColumnsPresent(), 'columns reported absent on a pre-change sheet');
    A.ok(!/tile-label">Unpaid invoices/.test(window.renderDashboard()), 'no unpaid tile until the columns exist');
  }

  A.section('hub — Australian date parsing');
  {
    const { window } = await loadPage(PAGE);
    // new Date('01/07/2026') would be 7 January in US order; this is 1 July.
    const d = window.parseAuDate('01/07/2026');
    A.eq(d.getMonth(), 6, 'dd/mm/yyyy parsed as July, not January');
    A.eq(d.getDate(), 1, 'day-of-month read from the first field');
    A.eq(window.parseAuDate('2026-07-01').getMonth(), 6, 'ISO dates still parse');
    A.eq(window.parseAuDate(''), null, 'blank date → null');
    A.eq(window.parseAuDate('not a date'), null, 'unparseable date → null');
  }


  A.section('hub — Mark as Paid is invoice-scoped');
  {
    const INV_HEADERS = ['Invoice Number', 'Billing Name', 'Email', 'Amount Due', 'Due Date',
                         'Email Sent', 'PDF Status', 'Paid Date', 'Invoice Status'];
    const DATA = {
      data: {
        'Member List': [
          ['First', 'Last', 'Email', 'Status', 'Invoice Paid Date'],
          ['Leslie', 'Shroot', 'leslie@x.com', 'Invoiced', ''],
          ['Solo',   'One',    'solo@x.com',   'Invoiced', ''],
        ],
        'Invoices': [
          INV_HEADERS,
          ['2025064', 'Leslie Shroot', 'leslie@x.com', '340', '01/08/2026', 'Sent', 'Generated', '', ''],
          ['2025065', 'Leslie Shroot', 'leslie@x.com', '470', '01/10/2026', 'Sent', 'Generated', '', ''],
          ['2025070', 'Solo One',      'solo@x.com',   '340', '01/08/2026', 'Sent', 'Generated', '', ''],
        ],
        'Onboarding': [], 'Transactions': [], 'Errors': [],
      },
    };

    const posts = [];
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.action !== 'getAll') posts.push(body);
      const payload = body.action === 'getAll' ? DATA : { ok: true };
      return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
    };

    const { window } = await signIn(fetchImpl);
    window.prompt = () => '05/09/2026';

    // One outstanding invoice → chosen automatically, no extra click.
    await window.markPaidForMember('solo@x.com');
    await waitTicks(6);
    const paidPost = posts.find(p => p.action === 'markPaid');
    A.ok(paidPost, 'markPaid was posted');
    A.eq(paidPost.invoiceNumber, '2025070', 'single outstanding invoice is selected automatically');
    A.eq(paidPost.date, '05/09/2026', 'the entered date is sent');
    A.ok(!('memberEmail' in paidPost), 'no memberEmail — the call is invoice-scoped now');

    // Two outstanding → must not guess; sends the treasurer to the list.
    posts.length = 0;
    await window.markPaidForMember('leslie@x.com');
    await waitTicks(4);
    A.eq(posts.filter(p => p.action === 'markPaid').length, 0, 'two outstanding invoices → nothing is posted');
    // currentView is a script-scope `let`, so assert through the DOM instead.
    A.ok(window.document.getElementById('nav-invoices').classList.contains('active'),
         '…the treasurer is sent to the invoices view to choose');
    A.ok(window.document.getElementById('main-content').innerHTML.includes('2025064'),
         '…with both outstanding invoices listed');

    // The row action posts the invoice it belongs to.
    posts.length = 0;
    await window.markPaid('2025065');
    await waitTicks(6);
    const rowPost = posts.find(p => p.action === 'markPaid');
    A.eq(rowPost.invoiceNumber, '2025065', 'row action posts its own invoice number');

    const invHtml = window.renderInvoices();
    A.ok(invHtml.includes("markPaid('2025064')"), 'each unpaid row carries a Mark as Paid action for its own invoice');
  }

  // ───────────────────────────────────────────────────────────────────────────
  A.section('onboarding checklist by item (issue #32)');
  {
    const DATA = {
      data: {
        'Member List': [
          ['First', 'Last', 'Email', 'Status', 'Invoice Paid Date', 'Onboarding Complete'],
          // mid-onboarding: paid, active, not complete
          ['Ann',  'New',   'ann@x.com',  'Active',   '01/08/2026', ''],
          ['Bob',  'New',   'bob@x.com',  'Active',   '01/08/2026', ''],
          // complete — out of the cohort
          ['Cara', 'Done',  'cara@x.com', 'Active',   '01/08/2026', 'TRUE'],
          // unpaid — checklist has not unlocked
          ['Dan',  'Owing', 'dan@x.com',  'Active',   '',           ''],
          // not active
          ['Eve',  'Gone',  'eve@x.com',  'Lapsed',   '01/08/2026', ''],
        ],
        'Onboarding': [
          ['Member Email', 'Member Name', 'Calendar Invited', 'WhatsApp Added'],
          // Ann already has her calendar invite; Bob does not.
          ['ann@x.com', 'Ann New', '05/08/2026', ''],
          ['bob@x.com', 'Bob New', '',           '06/08/2026'],
        ],
        'Invoices': [], 'Transactions': [], 'Errors': [],
      },
    };

    const posts = [];
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.action !== 'getAll') posts.push(body);
      const payload = body.action === 'getAll' ? DATA : { ok: true };
      return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
    };

    const { window } = await signIn(fetchImpl);

    const CAL = { key: 'calendar_invited', label: 'Google Calendar invited', col: 'Calendar Invited' };
    const WA  = { key: 'whatsapp_added',   label: 'Added to WhatsApp',       col: 'WhatsApp Added' };

    // memberList is a script-scope `let`, so rebuild the objects through the real
    // normaliser rather than reaching for it — same approach as the invoices tests.
    const members = window.rowsToObjects(DATA.data['Member List']);
    const memberByEmail = (e) => members.find(m => m.email === e);

    // ── who counts as mid-onboarding ────────────────────────────────────────
    const cohort = window.checklistCohort().map(m => m.email).sort();
    A.eq(cohort, ['ann@x.com', 'bob@x.com'], 'cohort = active, invoice paid, onboarding not complete');

    // ── per-item outstanding lists ──────────────────────────────────────────
    A.eq(window.membersOutstandingFor(CAL).map(m => m.email), ['bob@x.com'],
         'calendar invite outstanding for Bob only — Ann is already stamped');
    A.eq(window.membersOutstandingFor(WA).map(m => m.email), ['ann@x.com'],
         'WhatsApp outstanding for Ann only');

    // A member with no Onboarding row at all is outstanding, not invisible.
    A.ok(window.checklistStepDone(memberByEmail('ann@x.com'), CAL),
         'a stamped step reads as done');
    A.ok(!window.checklistStepDone(memberByEmail('bob@x.com'), CAL),
         'a blank step reads as not done');

    // ── the view ────────────────────────────────────────────────────────────
    window.filterChecklist('calendar_invited');
    const html = window.document.getElementById('main-content').innerHTML;
    A.ok(window.document.getElementById('nav-checklist').classList.contains('active'),
         'the checklist view is reachable from the nav');
    A.ok(html.includes('bob@x.com'), 'the outstanding member is listed');
    A.ok(!html.includes('ann@x.com'), 'the member who has it done is not');
    A.ok(/Google Calendar invited\s*—\s*1 outstanding/.test(html), 'the heading names the step and the count');
    A.ok(html.includes('Copy 1 email'), 'the addresses can be copied in one go');

    // Counts on every step button, so you can see where the work is.
    A.ok(/Added to WhatsApp \(1\)/.test(html), 'each step button carries its outstanding count');

    // ── ticking one off ─────────────────────────────────────────────────────
    posts.length = 0;
    await window.markChecklistStep('bob@x.com', 'calendar_invited', 'Calendar Invited', 'checklist');
    await waitTicks(6);
    const post = posts.find(p => p.action === 'markChecklistStep');
    A.ok(post, 'markChecklistStep was posted');
    A.eq(post.memberEmail, 'bob@x.com', '…for the row that was clicked');
    A.eq(post.colName, 'Calendar Invited', '…naming the Onboarding column the backend stamps');

    // The whole point of working down a list: you stay on it.
    A.ok(window.document.getElementById('nav-checklist').classList.contains('active'),
         'ticking from the by-item view keeps you in the by-item view');

    // ── the member card still drives off the same list ──────────────────────
    const card = window.renderMemberManagement(
      memberByEmail('bob@x.com'), null, window.onboardingFor('bob@x.com'), false);
    A.ok(card.includes('Google Calendar invited'), 'the per-member card renders the shared step list');
    A.ok(card.includes('Added to WhatsApp'), '…all of it');
  }

  process.exit(A.summary() ? 0 : 1);
})();
