/**
 * jsdom-harness.js — loads a real site page into jsdom and runs its inline scripts.
 *
 * The join form / hub are static HTML with inline <script> that talk to the Apps
 * Script web app via window.fetch. jsdom gives us a real DOM so we can exercise
 * that client logic (dropdown population, conditional fields, payload assembly,
 * success/error handling) WITHOUT a browser or network — fetch is mocked.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const REPO = path.resolve(__dirname, '..');

/**
 * @param {string} relPath   page path relative to repo root, e.g. 'docs/join/index.html'
 * @param {Object} opts
 *   opts.fetch     {Function}  window.fetch implementation (async). Defaults to a stub
 *                              that resolves { status:'success' }.
 *   opts.now       {Date}      value returned by `new Date()` / Date.now() inside the page.
 *   opts.url       {string}    document URL (defaults to the live join URL).
 *   opts.quiet     {boolean}   swallow page console output (default true).
 * @returns {Promise<{window, document, dom, fetchCalls}>}
 */
async function loadPage(relPath, opts = {}) {
  const html = fs.readFileSync(path.join(REPO, relPath), 'utf8');
  const fetchCalls = [];

  const defaultFetch = async (url, init) => ({
    ok: true,
    status: 200,
    json: async () => ({ status: 'success' }),
    text: async () => '{"status":"success"}',
  });

  const fetchImpl = opts.fetch || defaultFetch;

  const virtualConsole = new VirtualConsole();
  if (!opts.quiet) virtualConsole.sendTo(console);

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: opts.url || 'https://gototoastmasters.com.au/join',
    virtualConsole,
    beforeParse(window) {
      // Optional deterministic clock so month-dropdown assertions are stable.
      if (opts.now) {
        const FixedDate = class extends window.Date {
          constructor(...args) { return args.length ? super(...args) : super(opts.now.getTime()); }
          static now() { return opts.now.getTime(); }
        };
        window.Date = FixedDate;
      }
      // Mock fetch and record calls (payload is the 2nd arg's body).
      window.fetch = (url, init) => {
        fetchCalls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
        return Promise.resolve(fetchImpl(url, init));
      };
      // jsdom lacks scrollIntoView; the page calls it on the error banner.
      window.HTMLElement.prototype.scrollIntoView = function () {};
    },
  });

  // Let inline IIFEs / DOMContentLoaded listeners run.
  await new Promise((r) => setTimeout(r, 0));
  if (dom.window.document.readyState !== 'complete') {
    await new Promise((r) => dom.window.addEventListener('load', r));
  }

  return { window: dom.window, document: dom.window.document, dom, fetchCalls };
}

/** Fill an input/select/textarea by name (first match) and fire input+change. */
function setField(document, name, value) {
  const el = document.querySelector(`[name="${name}"]`);
  if (!el) throw new Error(`no field named "${name}"`);
  el.value = value;
  el.dispatchEvent(new el.ownerDocument.defaultView.Event('input', { bubbles: true }));
  el.dispatchEvent(new el.ownerDocument.defaultView.Event('change', { bubbles: true }));
  return el;
}

/** Check a radio/checkbox by name+value and fire change. */
function checkRadio(document, name, value) {
  const el = document.querySelector(`[name="${name}"][value="${value}"]`);
  if (!el) throw new Error(`no radio "${name}" with value "${value}"`);
  el.checked = true;
  el.dispatchEvent(new el.ownerDocument.defaultView.Event('change', { bubbles: true }));
  return el;
}

module.exports = { loadPage, setField, checkRadio, REPO };
