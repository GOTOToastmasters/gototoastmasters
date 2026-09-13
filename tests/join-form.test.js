/**
 * join-form.test.js — proves the client logic of docs/join/index.html.
 *
 * Loads the REAL page in jsdom with a mocked fetch, then exercises the three
 * historically-buggy areas plus the payload contract:
 *   - join-month dropdown: value ('YYYY-MM') and label agree (no off-by-one) — bug #2
 *   - attendedAsGuest radios send a real boolean the server can read — bug #3
 *   - server {status:'error'} shows the error banner, NOT a false success — bug (join-form §Bug 2)
 *   - network failure is surfaced as an error, form stays usable
 *   - abuse fields (honeypot `website`, timing `renderedAt`) are in the payload
 *   - conditional fields (previous-TM, company billing) reveal + validate
 */
'use strict';

const { loadPage, setField, checkRadio } = require('./jsdom-harness');
const A = require('./assert');

const PAGE = 'docs/join/index.html';
const NOW  = new Date(2026, 6, 13); // 13 Jul 2026 — deterministic dropdown
const tick = () => new Promise((r) => setTimeout(r, 5));

// Fill the minimum valid submission. Returns nothing; mutates the DOM.
function fillValid(document) {
  setField(document, 'firstName', 'Smoke');
  setField(document, 'lastName', 'Test');
  setField(document, 'email', 'rob.kenefeck+smoke@gmail.com');
  setField(document, 'phone', '0411000000');
  setField(document, 'addressLine1', '10 Collins St');
  setField(document, 'addressCity', 'Melbourne');
  setField(document, 'addressState', 'VIC');
  setField(document, 'addressPostcode', '3000');
  const terms = document.getElementById('agreeToTerms');
  terms.checked = true;
}

async function submit(document) {
  document.getElementById('join-form').dispatchEvent(
    new document.defaultView.Event('submit', { bubbles: true, cancelable: true })
  );
  await tick();
}

// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  A.section('join form — join-month dropdown (known bug #2: value/label off-by-one)');
  {
    const { document } = await loadPage(PAGE, { now: NOW });
    const opts = [...document.getElementById('joinMonth').options];
    A.eq(opts.length, 9, 'dropdown has 9 months');
    A.eq(opts[0].value, '2026-07', 'first option value = current month (2026-07)');
    A.ok(opts[0].selected, 'first option is selected by default');

    // The real bug: label text must describe the same month as the value encodes.
    const fmt = new Intl.DateTimeFormat('en-AU', { month: 'long', year: 'numeric' });
    let allConsistent = true;
    for (const o of opts) {
      const [y, m] = o.value.split('-').map(Number);
      const expected = fmt.format(new Date(y, m - 1, 1));
      if (o.textContent.trim() !== expected) allConsistent = false;
    }
    A.ok(allConsistent, 'every option label matches its YYYY-MM value (no off-by-one)');
    A.eq(opts[6].value, '2027-01', 'month 7 crosses the year boundary → 2027-01');
    A.eq(opts[6].textContent.trim(), 'January 2027', '…and its label reads January 2027');
  }

  A.section('join form — attendedAsGuest boolean (known bug #3)');
  {
    const { document, fetchCalls } = await loadPage(PAGE, { now: NOW });
    fillValid(document);
    await submit(document);
    A.eq(fetchCalls.length, 1, 'submit posts once');
    A.eq(fetchCalls[0].body.attendedAsGuest, false, 'default "No" radio → boolean false (not "false"/"no")');
  }
  {
    const { document, fetchCalls } = await loadPage(PAGE, { now: NOW });
    fillValid(document);
    checkRadio(document, 'attendedAsGuest', 'true');
    await submit(document);
    A.eq(fetchCalls[0].body.attendedAsGuest, true, '"Yes" radio → boolean true');
  }

  A.section('join form — payload contract + abuse fields');
  {
    const { document, fetchCalls } = await loadPage(PAGE, { now: NOW });
    fillValid(document);
    await submit(document);
    const b = fetchCalls[0].body;
    A.eq(b.firstName, 'Smoke', 'firstName carried through');
    A.eq(b.email, 'rob.kenefeck+smoke@gmail.com', 'email carried through');
    A.eq(b.joinMonth, '2026-07', 'joinMonth from the dropdown');
    A.eq(b.termLength, '6month', 'termLength defaults to 6month');
    A.eq(b.badgePreference, 'Magnetic', 'badgePreference default');
    A.eq(b.agreeToTerms, true, 'agreeToTerms is a real boolean');
    A.eq(b.website, '', 'honeypot `website` present and empty for a real user');
    A.ok(typeof b.renderedAt === 'number', 'timing field `renderedAt` present (number)');
  }

  A.section('join form — server error shows banner, NOT a false success');
  {
    const errFetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ status: 'error', message: 'Invalid transaction date' }),
      text: async () => '{"status":"error"}',
    });
    const { document } = await loadPage(PAGE, { now: NOW, fetch: errFetch });
    fillValid(document);
    await submit(document);
    A.ok(document.getElementById('msg-error').classList.contains('visible'), 'error banner is shown');
    A.ok(document.getElementById('error-detail').textContent.includes('Invalid transaction date'), 'server message surfaced');
    A.ok(!document.getElementById('msg-success').classList.contains('visible'), 'success banner NOT shown on error');
    A.ok(document.getElementById('join-form').style.display !== 'none', 'form stays visible so the user can retry');
    A.eq(document.getElementById('submit-btn').disabled, false, 'submit button re-enabled after error');
  }

  A.section('join form — happy path hides form and shows success');
  {
    const { document } = await loadPage(PAGE, { now: NOW }); // default fetch → {status:'success'}
    fillValid(document);
    await submit(document);
    A.ok(document.getElementById('msg-success').classList.contains('visible'), 'success banner shown');
    A.eq(document.getElementById('join-form').style.display, 'none', 'form hidden on success');
  }

  A.section('join form — network failure is surfaced (not a silent success)');
  {
    const boom = async () => { throw new Error('NetworkError'); };
    const { document } = await loadPage(PAGE, { now: NOW, fetch: boom });
    fillValid(document);
    await submit(document);
    A.ok(document.getElementById('msg-error').classList.contains('visible'), 'error banner shown on fetch rejection');
    A.ok(!document.getElementById('msg-success').classList.contains('visible'), 'no success banner on network failure');
  }

  A.section('join form — conditional fields reveal + validate');
  {
    const { document } = await loadPage(PAGE, { now: NOW });
    A.ok(!document.getElementById('field-tm-id').classList.contains('visible'), 'TM-ID hidden for a new member');
    checkRadio(document, 'previouslyTMMember', 'yes');
    A.ok(document.getElementById('field-tm-id').classList.contains('visible'), 'TM-ID revealed when "yes"');
    A.ok(document.getElementById('field-tm-club').classList.contains('visible'), 'TM-club revealed when "yes"');
    checkRadio(document, 'previouslyTMMember', 'not_sure');
    A.ok(document.getElementById('field-tm-id').classList.contains('visible'), 'TM-ID revealed when "not sure"');
    A.ok(!document.getElementById('field-tm-club').classList.contains('visible'), 'TM-club hidden when "not sure"');
  }
  {
    // Company billing selected but name left blank → client-side error, no post.
    const { document, fetchCalls } = await loadPage(PAGE, { now: NOW });
    fillValid(document);
    checkRadio(document, 'invoiceBilledTo', 'company');
    await submit(document);
    A.eq(fetchCalls.length, 0, 'company billing without a name does NOT post');
    A.ok(document.getElementById('error-detail').textContent.toLowerCase().includes('company'), 'prompts for the company name');
  }

  process.exit(A.summary() ? 0 : 1);
})();
