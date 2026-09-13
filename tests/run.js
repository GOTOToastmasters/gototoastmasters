/**
 * run.js — runs the front-end jsdom suites and prints one combined summary.
 *
 *   cd tests && npm install && node run.js
 *
 * Each *.test.js is self-contained (own async IIFE + own assert tally), so we
 * run them as child processes and aggregate exit codes.
 */
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const suites = ['join-form.test.js', 'onboarding-hub.test.js'];
let failed = 0;

for (const s of suites) {
  console.log(`\n════ ${s} ════`);
  try {
    execFileSync(process.execPath, [path.join(__dirname, s)], { stdio: 'inherit' });
  } catch (_) {
    failed++;
  }
}

console.log('\n' + '#'.repeat(50));
console.log(failed ? `  ${failed} suite(s) FAILED` : '  all front-end suites passed');
console.log('#'.repeat(50));
process.exit(failed ? 1 : 0);
