/**
 * assert.js — tiny zero-dependency test runner with pass/fail tallies.
 * (Same shape as the member-system Node suite.)
 */
'use strict';

let passed = 0, failed = 0;
const failures = [];

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}\n      expected ${e}\n      actual   ${a}`); }
}

function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg} (expected truthy, got ${cond})`); }
}

function section(name) { console.log(`\n── ${name} ──`); }

function summary() {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed) { console.log('  FAILED:'); failures.forEach(f => console.log('   - ' + f)); }
  console.log('='.repeat(50));
  return failed === 0;
}

module.exports = { eq, ok, section, summary };
