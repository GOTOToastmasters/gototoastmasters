/**
 * publish-events.test.js — proves the Melbourne time-zone helpers in
 * script-publish/publish.js that publishEvents_() uses for the Events page.
 *
 * Like publish-commit.test.js this is not jsdom: it extracts the real functions from
 * publish.js and runs them against a stand-in for Utilities.formatDate, built on Node's
 * own tz database. Apps Script's real formatDate is not exercised here.
 *
 * The bug it pins down (#71): every meeting was labelled "AEST", including the half of
 * the year Melbourne is on AEDT (UTC+11). It also drives publishEvents_() end to end
 * against a mocked Meetings sheet to check the per-meeting Event JSON-LD (#72).
 *
 * Set EVENTS_MD_OUT=path to also write the generated events.md there, e.g. to feed
 * `mkdocs build` and check the <script> block survives.
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

// ── GAS stand-in: just the patterns publishEvents_ and its helpers use ───────
function formatDate(d, tz, pattern) {
  if (pattern === 'yyyy-MM-dd') {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  }
  if (pattern === 'EEEE d MMMM yyyy') {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-AU', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      .formatToParts(d).map((x) => [x.type, x.value]));
    return `${p.weekday} ${p.day} ${p.month} ${p.year}`;
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

// ── publishEvents_ end to end (#72) ──────────────────────────────────────────
// "Today" is pinned so the fixture dates stay upcoming whenever this runs.
class FixedDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super('2026-10-16T09:00:00+11:00'); }
}

function buildPublish(rows) {
  const out = { md: null };
  const headers = ['Date', 'Type', 'Eventbrite URL', 'Manual Eventbrite URL', 'Easy-Speak Thread ID'];
  const grid = [headers].concat(rows);
  const sheet = {
    getLastRow: () => grid.length,
    getLastColumn: () => headers.length,
    getRange: (r, c, nr, nc) => ({ getValues: () => grid.slice(r - 1, r - 1 + nr).map((row) => row.slice(c - 1, c - 1 + nc)) }),
  };
  const ctx = {
    Date: FixedDate,
    console: { log() {} },
    Utilities: { formatDate },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }) },
    getMeetingsSsId_: () => 'ss',
    MEETINGS_TAB: 'Meetings',
    commitToGitHub_: (p, md) => { out.md = md; return 'https://github.com/x/y/commit/abc'; },
  };
  const src = [
    extract('melbourneOffset_'),
    extract('melbourneZoneLabel_'),
    extract('eventsJsonLd_'),
    extract('parseMeetingDate_'),
    extract('publishEvents_'),
    'return publishEvents_;',
  ].join('\n');
  const publishEvents_ = new Function(...Object.keys(ctx), src)(...Object.values(ctx));
  return () => { publishEvents_(); return out.md; };
}

const EB = 'https://www.eventbrite.com.au/e/example-tickets-1';
const md = buildPublish([
  ['1/9/2026',   'Regular', '', '', ''],           // past: dropped
  ['27/10/2026', 'Contest', '', '', '636317'],
  ['10/11/2026', 'Regular', EB, '', '636318'],
  ['9/6/2027',   'Special </script><b>', '', '', ''], // AEST, plus a hostile label
])();

A.section('label lines carry the right zone');
A.ok(md.includes('**Tuesday 27 October 2026** &nbsp;·&nbsp; 5:30 PM AEDT &nbsp;·&nbsp; Melbourne CBD'), 'Oct meeting says AEDT');
A.ok(md.includes('**Wednesday 9 June 2027** &nbsp;·&nbsp; 5:30 PM AEST &nbsp;·&nbsp; Melbourne CBD'), 'Jun meeting says AEST');

A.section('one Event per upcoming meeting');
const m = md.match(/<script type="application\/ld\+json">\n([\s\S]*?)\n<\/script>/);
A.ok(m, 'events.md carries a JSON-LD block');
const fromBlock = md.slice(md.indexOf('<script type="application/ld+json">'));
A.eq((fromBlock.match(/<\/script>/g) || []).length, 1, 'a "</script>" in a sheet value cannot close the block early');
const ld = JSON.parse(m[1]);
const evs = ld['@graph'];
A.eq(ld['@context'], 'https://schema.org', '@context set once');
A.eq(evs.length, 3, 'three upcoming meetings, the past one dropped');
A.eq(evs.map((e) => e.startDate), ['2026-10-27T17:30:00+11:00', '2026-11-10T17:30:00+11:00', '2027-06-09T17:30:00+10:00'], 'startDate is 5:30 PM with that date\'s offset');
A.eq(evs.map((e) => e.endDate), ['2026-10-27T21:00:00+11:00', '2026-11-10T21:00:00+11:00', '2027-06-09T21:00:00+10:00'], 'endDate is 9:00 PM with that date\'s offset');
A.eq(evs.map((e) => e.name), ['Contest', 'Regular', 'Special </script><b>'], 'name is the type label, round-tripped intact');
A.eq(evs[0].eventAttendanceMode, 'https://schema.org/OfflineEventAttendanceMode', 'offline attendance');
A.eq(evs[0].eventStatus, 'https://schema.org/EventScheduled', 'scheduled');
A.eq(evs[0].location.name, 'Mail Exchange Hotel', 'venue matches the home page');
A.eq(evs[0].offers.price + ' ' + evs[0].offers.priceCurrency, '55 AUD', 'standard guest fee');
A.eq(evs[1].offers.url, EB, 'offer url is the row\'s Eventbrite link');
A.eq(evs[0].offers.url, 'https://www.eventbrite.com.au/o/goto-toastmasters-111570638511', 'no link: falls back to the organiser page');
A.eq(evs[0].organizer, { '@id': 'https://gototoastmasters.com.au/#organization' }, 'organizer references the site Organization');

A.section('no upcoming meetings, no block');
const empty = buildPublish([['1/9/2026', 'Regular', '', '', '']])();
A.ok(empty.includes('No upcoming events scheduled'), 'empty page still says so');
A.ok(!empty.includes('application/ld+json'), 'and carries no JSON-LD');

if (process.env.EVENTS_MD_OUT) fs.writeFileSync(process.env.EVENTS_MD_OUT, md);

process.exit(A.summary() ? 0 : 1);
