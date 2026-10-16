/**
 * publish-events.test.js — proves the Melbourne time-zone helpers in
 * script-publish/publish.js that publishEvents_() uses for the Events page.
 *
 * Like publish-commit.test.js this is not jsdom: it extracts the real functions from
 * publish.js and runs them against a stand-in for Utilities.formatDate, built on Node's
 * own tz database. Apps Script's real formatDate is not exercised here.
 *
 * The bug it pins down (#71): every meeting was labelled "AEST", including the half of
 * the year Melbourne is on AEDT (UTC+11).
 */
'use strict';

process.env.TZ = 'Australia/Melbourne'; // match appsscript.json, so sheet dates parse as they do live

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

// ── GAS stand-in: just the two patterns the helpers use ─────────────────────
function formatDate(d, tz, pattern) {
  if (pattern === 'yyyy-MM-dd') {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  }
  if (pattern === 'XXX') {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
      .formatToParts(d).find((p) => p.type === 'timeZoneName').value; // e.g. "GMT+11:00"
    return name === 'GMT' ? 'Z' : name.replace('GMT', '');
  }
  throw new Error('stub does not support pattern ' + pattern);
}

function buildApi(fmt) {
  const src = [
    extract('melbourneOffset_'),
    extract('melbourneZoneLabel_'),
    extract('parseMeetingDate_'),
    'return { melbourneOffset_: melbourneOffset_, melbourneZoneLabel_: melbourneZoneLabel_, parseMeetingDate_: parseMeetingDate_ };',
  ].join('\n');
  return new Function('Utilities', src)({ formatDate: fmt });
}

const api = buildApi(formatDate);
const day = (s) => api.parseMeetingDate_(s); // DD/MM/YYYY, as the Meetings sheet holds it

A.section('zone label follows daylight saving');
A.eq(api.melbourneZoneLabel_(day('10/11/2026')), 'AEDT', 'Tue 10 Nov 2026 is AEDT (was wrongly "AEST")');
A.eq(api.melbourneZoneLabel_(day('9/6/2026')), 'AEST', 'Tue 9 Jun 2026 is AEST');
A.eq(api.melbourneOffset_(day('10/11/2026')), '+11:00', 'AEDT offset is +11:00');
A.eq(api.melbourneOffset_(day('9/6/2026')), '+10:00', 'AEST offset is +10:00');

A.section('either side of DST starting, Sun 4 Oct 2026');
A.eq(api.melbourneZoneLabel_(day('29/9/2026')), 'AEST', 'Tue 29 Sep 2026 is AEST');
A.eq(api.melbourneZoneLabel_(day('3/10/2026')), 'AEST', 'Sat 3 Oct 2026 is AEST');
A.eq(api.melbourneZoneLabel_(day('4/10/2026')), 'AEDT', 'Sun 4 Oct 2026 at meeting time is AEDT (midnight was still AEST)');
A.eq(api.melbourneZoneLabel_(day('6/10/2026')), 'AEDT', 'Tue 6 Oct 2026 is AEDT');
A.eq(formatDate(day('4/10/2026'), 'Australia/Melbourne', 'XXX'), '+10:00', '(control: probing at midnight would have said +10:00)');

A.section('either side of DST ending, Sun 4 Apr 2027');
A.eq(api.melbourneZoneLabel_(day('30/3/2027')), 'AEDT', 'Tue 30 Mar 2027 is AEDT');
A.eq(api.melbourneZoneLabel_(day('3/4/2027')), 'AEDT', 'Sat 3 Apr 2027 is AEDT');
A.eq(api.melbourneZoneLabel_(day('4/4/2027')), 'AEST', 'Sun 4 Apr 2027 at meeting time is AEST (midnight was still AEDT)');
A.eq(api.melbourneZoneLabel_(day('6/4/2027')), 'AEST', 'Tue 6 Apr 2027 is AEST');
A.eq(formatDate(day('4/4/2027'), 'Australia/Melbourne', 'XXX'), '+11:00', '(control: probing at midnight would have said +11:00)');

A.section('an unexpected offset falls back rather than guessing');
const odd = buildApi((d, tz, p) => (p === 'XXX' ? 'Z' : formatDate(d, tz, p)));
A.eq(odd.melbourneZoneLabel_(day('10/11/2026')), 'Melbourne time', 'offset "Z" gives "Melbourne time"');

process.exit(A.summary() ? 0 : 1);
