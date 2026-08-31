#!/usr/bin/env bash
#
# test-deploy-watchdog.sh — proves deploy-watchdog.yml raises and stands down correctly.
#
#     ./.github/test-deploy-watchdog.sh
#
# The watchdog's logic lives inline in the workflow, because it runs without a checkout
# and so cannot call a script file. To keep this test honest it EXTRACTS that inline
# script from the YAML and runs the real thing — there is no second copy to drift.
#
# `gh` is faked from fixtures; jq, date and bash are real. Nothing here touches the
# network, the repository, or any issue.
#
# Requires: python3 with pyyaml (to read the workflow), jq.

set -uo pipefail
cd "$(dirname "$0")/.."
WF=.github/workflows/deploy-watchdog.yml
[[ -f "$WF" ]] || { echo "workflow not found: $WF" >&2; exit 1; }

ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
SCRIPT="$ROOT/watchdog.sh"

python3 - "$WF" "$SCRIPT" <<'PY'
import sys, yaml
wf = yaml.safe_load(open(sys.argv[1]))
steps = wf['jobs']['check']['steps']
assert not any('uses' in s for s in steps), \
    "watchdog must not use any actions — that is what makes it survive startup_failure"
open(sys.argv[2], 'w').write(steps[0]['run'])
PY
[[ -s "$SCRIPT" ]] || { echo "could not extract the inline script" >&2; exit 1; }

pass=0; fail=0
ok(){ pass=$((pass+1)); echo "  OK  $1"; }
no(){ fail=$((fail+1)); echo "  XX  $1"; [[ -n "${2:-}" ]] && sed 's/^/        | /' <<<"$2"; }

mkdir -p "$ROOT/bin"
cat > "$ROOT/bin/gh" <<'GH'
#!/usr/bin/env bash
# Fake gh. Fixtures come from env; every mutating call is appended to $GH_LOG.
case "$1 $2" in
  "api repos/"*) : ;;
esac
if [[ "$1" == "api" ]]; then
  case "$2" in
    */branches/*) [[ -n "${FX_PAGES_DATE:-}" ]] && { echo "$FX_PAGES_DATE"; exit 0; }; exit 1 ;;
    */actions/workflows/*) echo "${FX_RUNS:-{\"workflow_runs\":[]\}}"; exit 0 ;;
  esac
  exit 1
fi
if [[ "$1" == "issue" ]]; then
  case "$2" in
    list)    echo "${FX_OPEN_ISSUE:-}"; exit 0 ;;
    create)  echo "issue create" >> "$GH_LOG"; while [[ $# -gt 0 ]]; do [[ "$1" == "--body" ]] && echo "$2" >> "$GH_LOG"; shift; done; exit 0 ;;
    comment) echo "issue comment" >> "$GH_LOG"; exit 0 ;;
    close)   echo "issue close"   >> "$GH_LOG"; exit 0 ;;
  esac
fi
exit 0
GH
chmod +x "$ROOT/bin/gh"
export PATH="$ROOT/bin:$PATH"

export GH_TOKEN=x REPO=o/r DEPLOY_WORKFLOW=deploy.yml PAGES_BRANCH=gh-pages
export MAX_PAGES_AGE_DAYS=14 MAX_RUN_GAP_DAYS=14 ISSUE_LABEL=deploy-watchdog

ago() { date -u -d "$1 days ago" +%Y-%m-%dT%H:%M:%SZ; }
runs() { printf '{"workflow_runs":[{"conclusion":"%s","status":"completed","created_at":"%s","html_url":"https://x/1"}]}' "$1" "$(ago "$2")"; }

# $1 desc, $2 expected exit, rest via env
drive() { GH_LOG="$ROOT/log"; : > "$GH_LOG"; export GH_LOG; OUT=$(bash "$SCRIPT" 2>&1); RC=$?; LOG=$(cat "$GH_LOG"); }

echo "── healthy ──"
FX_PAGES_DATE=$(ago 1) FX_RUNS=$(runs success 1) FX_OPEN_ISSUE="" drive
[[ $RC -eq 0 ]]                  && ok "exits 0"            || no "exits 0" "$OUT"
[[ -z "$LOG" ]]                  && ok "raises nothing"     || no "raises nothing" "$LOG"

echo "── healthy, with an alert still open → stands down ──"
FX_PAGES_DATE=$(ago 1) FX_RUNS=$(runs success 1) FX_OPEN_ISSUE="42" drive
grep -q "issue comment" <<<"$LOG" && ok "comments on recovery" || no "comments" "$LOG"
grep -q "issue close"   <<<"$LOG" && ok "closes the issue"     || no "closes" "$LOG"
[[ $RC -eq 0 ]]                   && ok "exits 0"              || no "exits 0" "$OUT"

echo "── startup_failure — the case with no build log ──"
FX_PAGES_DATE=$(ago 1) FX_RUNS=$(runs startup_failure 1) FX_OPEN_ISSUE="" drive
grep -q "issue create"      <<<"$LOG" && ok "raises an issue"                  || no "raises" "$LOG"
grep -q "startup_failure"   <<<"$LOG" && ok "names startup_failure"            || no "names it" "$LOG"
grep -q "Actions policy"    <<<"$LOG" && ok "points at the Actions policy"     || no "points" "$LOG"
[[ $RC -eq 1 ]]                       && ok "fails the run too"                || no "exit 1" "$OUT"

echo "── ordinary build failure ──"
FX_PAGES_DATE=$(ago 1) FX_RUNS=$(runs failure 1) FX_OPEN_ISSUE="" drive
grep -q "issue create" <<<"$LOG" && ok "raises an issue" || no "raises" "$LOG"

echo "── stale site, all runs green ──"
FX_PAGES_DATE=$(ago 40) FX_RUNS=$(runs success 1) FX_OPEN_ISSUE="" drive
grep -q "not been rebuilt for \*\*40 days\*\*" <<<"$LOG" && ok "catches absence nothing else sees" || no "stale" "$LOG"

echo "── quiet fortnight is NOT an alert ──"
FX_PAGES_DATE=$(ago 13) FX_RUNS=$(runs success 13) FX_OPEN_ISSUE="" drive
[[ $RC -eq 0 && -z "$LOG" ]] && ok "13 days silent stays quiet — no crying wolf" || no "quiet ok" "$OUT"

echo "── deploy.yml has not run at all ──"
FX_PAGES_DATE=$(ago 1) FX_RUNS='{"workflow_runs":[]}' FX_OPEN_ISSUE="" drive
grep -q "No runs of" <<<"$LOG" && ok "flags a missing/renamed workflow" || no "no runs" "$LOG"

echo "── long gap since the last run ──"
FX_PAGES_DATE=$(ago 1) FX_RUNS=$(runs success 30) FX_OPEN_ISSUE="" drive
grep -q "has not run for \*\*30 days\*\*" <<<"$LOG" && ok "flags the gap" || no "gap" "$LOG"

echo "── gh-pages unreadable ──"
FX_PAGES_DATE="" FX_RUNS=$(runs success 1) FX_OPEN_ISSUE="" drive
grep -q "could not be read" <<<"$LOG" && ok "flags a deleted/unreadable branch" || no "unreadable" "$LOG"

echo "── already reported → no daily repeat ──"
FX_PAGES_DATE=$(ago 1) FX_RUNS=$(runs startup_failure 1) FX_OPEN_ISSUE="42" drive
grep -q "issue create"  <<<"$LOG" && no "should not create a second issue" "$LOG" || ok "does not open a duplicate"
grep -q "issue comment" <<<"$LOG" && no "should not comment daily" "$LOG"         || ok "does not comment daily — one alert per incident"
[[ $RC -eq 1 ]] && ok "still fails the run while broken" || no "exit 1" "$OUT"

echo
echo "===================================="
echo "  $pass passed, $fail failed"
echo "===================================="
[[ $fail -eq 0 ]]
