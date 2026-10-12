/**
 * publish-commit.test.js — proves commitToGitHub_ in script-publish/publish.js.
 *
 * Unlike the other suites this one is not jsdom: the code under test is Apps Script,
 * not browser JS. It extracts the real functions from publish.js and runs them against
 * a mocked UrlFetchApp, so there is no second copy to drift and no network.
 *
 * The bug it pins down: the old version treated every non-200 read as "the file does
 * not exist" and then PUT without a sha. GitHub rejects a create over an existing file
 * with `422 "sha" wasn't supplied`, so a failed READ surfaced as a confusing error about
 * the WRITE. That is what stopped the Events page publishing after 2026-09-21.
 *
 * Covers: update, create, unchanged-skip, transient read retry, read failure refusing to
 * guess, redirect detection (wrong GITHUB_OWNER), and the 422 race self-heal.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const A = require('./assert');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'script-publish', 'publish.js'), 'utf8');

function extract(name) {
  const i = SRC.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`cannot find ${name} in publish.js`);
  const end = SRC.indexOf('\n}', i);
  return SRC.slice(i, end + 2);
}

// ── GAS stand-ins ────────────────────────────────────────────────────────────
let fetchLog = [];
let responder = () => ({ code: 200, body: '{}' });

const b64 = {
  encode: (s) => Buffer.from(s, 'utf8').toString('base64'),
  decode: (s) => Buffer.from(s, 'base64'),
};

function buildApi(props) {
  const ctx = {
    console: { log() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null }) },
    CacheService: { getScriptCache: () => ({ get: () => 'tok', put() {} }) },
    getInstallationToken_: () => 'tok',
    Utilities: {
      sleep() {},
      base64Encode: (s) => b64.encode(s),
      base64Decode: (s) => b64.decode(s),
      newBlob: (buf) => ({ getDataAsString: () => Buffer.from(buf).toString('utf8') }),
      Charset: { UTF_8: 'utf8' },
    },
    UrlFetchApp: {
      fetch(url, opts) {
        fetchLog.push({ url, method: (opts.method || 'get').toLowerCase(), opts });
        const r = responder(url, opts, fetchLog.length);
        return { getResponseCode: () => r.code, getContentText: () => r.body };
      },
    },
  };
  const src = [
    'var GITHUB_READ_RETRIES = 2;',
    extract('githubReadFile_'),
    extract('githubWriteFile_'),
    extract('commitToGitHub_'),
    'return { commitToGitHub_: commitToGitHub_, githubReadFile_: githubReadFile_ };',
  ].join('\n');
  return new Function(...Object.keys(ctx), src)(...Object.values(ctx));
}

const PROPS = { GITHUB_OWNER: 'GOTOToastmasters', GITHUB_REPO: 'gototoastmasters', GITHUB_BRANCH: 'main' };
const api = buildApi(PROPS);

const fileJson = (content, sha = 'abc123') =>
  JSON.stringify({ sha, content: b64.encode(content), type: 'file' });
const okCommit = JSON.stringify({ commit: { html_url: 'https://github.com/x/y/commit/deadbee' } });

const reset = () => { fetchLog = []; };
const puts = () => fetchLog.filter((f) => f.method === 'put');
const gets = () => fetchLog.filter((f) => f.method === 'get');
const putBody = (i = 0) => JSON.parse(puts()[i].opts.payload);

// ── the regression ───────────────────────────────────────────────────────────
A.section('updating an existing file supplies the sha');
reset();
responder = (url, opts) => (opts.method === 'put')
  ? { code: 200, body: okCommit }
  : { code: 200, body: fileJson('old content', 'sha-from-get') };
let out = api.commitToGitHub_('docs/events.md', 'new content', 'msg');
A.eq(putBody().sha, 'sha-from-get', 'sha from the read is sent on the write');
A.ok(out.includes('deadbee'), 'returns the commit url');

A.section('a genuine 404 means create, with no sha');
reset();
responder = (url, opts) => (opts.method === 'put')
  ? { code: 201, body: okCommit }
  : { code: 404, body: '{"message":"Not Found"}' };
api.commitToGitHub_('docs/new.md', 'hello', 'msg');
A.eq(putBody().sha, undefined, 'no sha sent when the file genuinely does not exist');

A.section('identical content skips the write entirely');
reset();
responder = (url, opts) => (opts.method === 'put')
  ? { code: 200, body: okCommit }
  : { code: 200, body: fileJson('same bytes') };
A.eq(api.commitToGitHub_('docs/events.md', 'same bytes', 'msg'), null, 'returns null when unchanged');
A.eq(puts().length, 0, 'no PUT issued at all');

A.section('a transient read failure is retried, not treated as absent');
reset();
responder = (url, opts, n) => {
  if (opts.method === 'put') return { code: 200, body: okCommit };
  return n === 1 ? { code: 502, body: 'bad gateway' } : { code: 200, body: fileJson('old', 'sha-2nd-try') };
};
api.commitToGitHub_('docs/events.md', 'new', 'msg');
A.eq(gets().length, 2, 'read retried once');
A.eq(putBody().sha, 'sha-2nd-try', 'the retry supplies the sha — the old code would have omitted it');

A.section('a read that never succeeds refuses to guess');
reset();
let threw = null;
responder = (url, opts) => (opts.method === 'put')
  ? { code: 422, body: '{"message":"Invalid request.\\n\\n\\"sha\\" wasn\'t supplied."}' }
  : { code: 500, body: 'server error' };
try { api.commitToGitHub_('docs/events.md', 'new', 'msg'); } catch (e) { threw = e.message; }
A.ok(threw && threw.includes('Could not read'), 'throws about the READ, not the write');
A.ok(threw.includes('500'), 'names the real status code');
A.ok(threw.includes('refusing to guess'), 'says why it stopped');
A.eq(puts().length, 0, 'never attempts a sha-less create over an existing file');

A.section('a redirect is reported, not followed (wrong GITHUB_OWNER)');
reset();
threw = null;
responder = () => ({ code: 301, body: '' });
try { api.commitToGitHub_('docs/events.md', 'new', 'msg'); } catch (e) { threw = e.message; }
A.ok(threw && threw.includes('redirected'), 'redirect surfaces as its own error');
A.ok(threw.includes('GITHUB_OWNER'), 'points at the likely misconfiguration');
A.eq(gets()[0].opts.followRedirects, false, 'reads do not follow redirects');

A.section('422 after a 404 read is a race, and self-heals');
reset();
responder = (url, opts, n) => {
  if (opts.method === 'get') return n === 1
    ? { code: 404, body: '{"message":"Not Found"}' }      // first read: absent
    : { code: 200, body: fileJson('appeared', 'sha-race') }; // re-read: there after all
  return puts().length === 1
    ? { code: 422, body: '{"message":"Invalid request.\\n\\n\\"sha\\" wasn\'t supplied."}' }
    : { code: 200, body: okCommit };
};
out = api.commitToGitHub_('docs/events.md', 'new', 'msg');
A.eq(puts().length, 2, 'retried the write once');
A.eq(putBody(1).sha, 'sha-race', 'retry supplies the sha found on re-read');
A.ok(out && out.includes('deadbee'), 'publish succeeds rather than failing on the race');

process.exit(A.summary() ? 0 : 1);
