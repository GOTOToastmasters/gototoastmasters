# CI for the GOTO Toastmasters site

Two workflows, and a test.

| File | What it does |
|---|---|
| `workflows/deploy.yml` | builds the MkDocs site and publishes it to `gh-pages` |
| `workflows/deploy-watchdog.yml` | daily check that the site is still actually deploying |
| `test-deploy-watchdog.sh` | runs the watchdog's logic against fixtures, offline |

## Why the watchdog exists

The site once went **a month** without deploying and nobody knew.

The repository transfer into `GOTOToastmasters` left the Actions policy at `local_only`,
which rejects `actions/checkout` and `actions/setup-python`. Every run ended in
`startup_failure` — the job never started, so there was no build log, no annotation, and
nothing to read. `gh-pages` last built 2026-07-28; the live site served that content until
2026-08-30.

Nothing reported it, and each component was telling the truth:

- the publish pipeline reported success, because its job ends at the commit
- `deploy.yml` produced no failing build, because it never got as far as building
- the daily notification emails had gone quiet for an unrelated reason

The Events page drives meeting attendance, and it was a month stale.

## What it checks

1. **Is `gh-pages` fresh?** Catches the case nothing else can see — a deploy that never
   ran looks identical to a quiet week from the runs API.
2. **How did the last `deploy.yml` run end?** Including `startup_failure`, which is the one
   a build-failure check misses.
3. **Has `deploy.yml` run at all recently?** Its `push` trigger only fires on `docs/**`,
   `mkdocs.yml` and `theme/**`, so a long gap is plausible — but not a fortnight-long one.

Thresholds are generous (14 days) on purpose. These catch "this has stopped", not "this is
late". An alert that fires on a quiet fortnight is one people learn to skim past.

## How it tells you

It opens **one** GitHub issue labelled `deploy-watchdog`, and closes it automatically when
things recover. While a problem is still open it says nothing further — no daily "still
broken" comment. One notification per incident, not per check: a daily alert earns a filter
rule, and then the real one is filtered along with it.

## Why it uses no actions

There is deliberately not one `uses:` line in `deploy-watchdog.yml`. Every step is a plain
`run:` using the preinstalled `gh` CLI.

`startup_failure` is what happens when a workflow cannot resolve its actions. A watchdog
built out of actions could therefore be killed by the exact condition it exists to detect,
and would die the same silent way. This one has nothing to resolve.

That also means no checkout, which is why its logic is inline in the YAML rather than in a
script file — `.github/scripts` is unreachable without `actions/checkout`.
`test-deploy-watchdog.sh` extracts that inline block and tests the real thing, so there is
no second copy to drift.

## What it cannot catch

**Its own absence.** GitHub disables scheduled workflows in a repository with no activity
for 60 days, and a disabled cron is silent like everything else here. This repo commits most
days, so that is unlikely rather than impossible. It is a reduction in risk, not a guarantee.

## Running the test

```bash
./.github/test-deploy-watchdog.sh
```

Offline. `gh` is faked from fixtures; nothing touches the network, the repository, or any
issue. Needs `python3` with `pyyaml`, and `jq`.
