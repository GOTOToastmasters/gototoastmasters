# Front-end tests

jsdom suites that load the **real** site pages (`docs/join/index.html`,
`docs/onboarding/index.html`), run their inline `<script>`, and assert the
client logic — with `window.fetch` mocked, so no browser and no network.

## Run

```bash
cd tests
npm install      # jsdom, one-time
node run.js      # both suites, combined summary
```

Or a single suite: `node join-form.test.js` / `node onboarding-hub.test.js`.

## What's covered

**join-form.test.js** (33 assertions) — the three historically-buggy areas plus
the payload contract:
- join-month dropdown: every option's `YYYY-MM` value agrees with its label
  (no off-by-one) — *former bug #2*
- `attendedAsGuest` radios send a real boolean `false`/`true` — *former bug #3*
- server `{status:'error'}` shows the error banner, NOT a false success; form
  stays usable and the submit button re-enables — *former "false success" bug*
- happy path hides the form and shows success; network failure is surfaced
- payload carries the honeypot (`website`) and timing (`renderedAt`) abuse fields
- conditional fields (previous-TM, company billing) reveal + validate

**onboarding-hub.test.js** (24 assertions) — the GIS-gated committee SPA:
- auth gating: server "Access denied" → denied screen, app stays hidden;
  committee user → app revealed
- `hubPost` sends the ID token in the body and uses the simple-CORS
  `text/plain;charset=utf-8` content type (no preflight)
- `rowsToObjects` header normalisation + `_rowNumber` tracking; `norm`/`esc`
- checklist includes the new Member Goals + LinkedIn steps, wired to
  `markChecklistStep`; checklist stays locked until an Invoice Paid Date exists
- dashboard reflects loaded data (prospect count, signed-in email)

The hub has no external GIS in jsdom, so the suite stubs `window.google` and
hand-builds an unsigned ID token (JWT) to drive `handleCredentialResponse`.

## Live smoke test (2026-07-13)

Both deployed pages were also driven in a real browser:
- `/join` — dropdown renders 9 months, all value/label pairs consistent, current
  month selected; `attendedAsGuest` values `false`/`true`; conditional reveal
  works; honeypot present. (No submission — avoids writing a live member row.)
- `/onboarding` — sign-in gate shown, `app-view` hidden, no data exposed
  pre-auth, GIS script loaded. (Stopped at the gate — no OAuth sign-in.)

## Two quirks worth knowing (not failures)

1. `rowsToObjects` filters out all-empty rows via
   `Object.values(o).some(v => v !== '' ...)`, but every object also carries a
   numeric `_rowNumber`, so the filter never actually drops a row. Harmless
   today (header + real rows only), but the guard is a no-op.
2. In the join form's submit handler, a non-JSON server response is caught and
   treated as success. A malformed/HTML error page from `/exec` would therefore
   read as a successful join. The `{status:'error'}` JSON path is handled
   correctly; only the non-JSON branch is optimistic.

## Note

Green here proves the **client** logic of the static pages. It does not exercise
the deployed Apps Script `/exec` — that's the member-system Node suite plus the
join-form permutation matrix.
