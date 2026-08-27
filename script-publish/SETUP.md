# Publish Pipeline — Setup Checklist

One-time setup. Do these steps in order.

---

## 1. Create the Apps Script project

```bash
cd "script-publish"
clasp login    # if not already logged in as the committee account
clasp create --type standalone --title "GOTO Publish Pipeline"
# This writes the scriptId into .clasp.json automatically
clasp push
```

---

## 2. Authentication — the committee GitHub App

The pipeline commits to GitHub as a **committee-owned GitHub App**, not as a personal
access token. Commits land authored by `goto-publish-pipeline[bot]`. Installation tokens
are minted per run and expire after an hour, so there is no standing credential anyone has
to remember to rotate.

Background: `docs/adr/0007-transfer-repo-to-committee-org.md` (Phase 3) records the
decision; ADR-0006 is the tech debt it closed.

> **The App already exists and is running.** Steps 2a–2b below are the one-time build-out,
> kept for disaster recovery and for whoever inherits this. If you are only re-deploying
> the script, skip to **2c**.

### 2a. Create and install the App *(one-time — already done)*

1. Org → **Settings → Developer settings → GitHub Apps → New GitHub App**, under the
   `GOTOToastmasters` org.
2. **Repository permissions → Contents: Read & write.** Everything else **None**.
3. Untick **Webhook → Active** (the pipeline polls; it receives nothing).
4. Note the **App ID**, then **Generate a private key** — this downloads a `.pem`.
5. **Install** the App on the org, scoped to **only** the `gototoastmasters` repo. The
   install URL ends `.../settings/installations/<INSTALL_ID>` — that number is the
   **installation ID**.

### 2b. Convert and store the private key *(the fiddly bit)*

Two gotchas, both of which produce confusing failures if missed:

- GitHub issues the key as **PKCS#1**; Apps Script needs **PKCS#8**.
- Script Properties **flatten newlines to spaces**, which makes
  `Utilities.computeRsaSha256Signature` throw `Invalid argument: key`. The key is
  therefore stored **base64-encoded to a single line** and decoded at runtime.

```bash
# 1. PKCS#1 -> PKCS#8
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
  -in <app>.pem -out <app>-pkcs8.pem

# 2. Flatten to one line — paste this output as GITHUB_APP_PRIVATE_KEY
openssl base64 -A -in <app>-pkcs8.pem
```

### 2c. Set Script Properties

In the Apps Script editor: **Project Settings → Script Properties → Add property**

| Property                 | Value                                                              |
|--------------------------|--------------------------------------------------------------------|
| `GITHUB_APP_ID`          | The App ID from step 2a                                            |
| `GITHUB_APP_INSTALL_ID`  | The installation ID from step 2a                                   |
| `GITHUB_APP_PRIVATE_KEY` | PKCS#8 key, base64-encoded to a single line (step 2b)              |
| `GITHUB_OWNER`           | `GOTOToastmasters` (the committee GitHub org)                      |
| `GITHUB_REPO`            | `gototoastmasters`                                                 |
| `GITHUB_BRANCH`          | `main`                                                             |
| `MEETINGS_SS_ID`         | Spreadsheet ID holding the `Meetings` tab (drives the Events page) |
| `EVENTBRITE_TOKEN`       | Eventbrite API token (optional — enables auto Eventbrite URL sync) |
| `EVENTBRITE_ORG_ID`      | Eventbrite organiser ID (optional; defaults to `111570638511`)     |

> **`GITHUB_TOKEN` is obsolete — do not re-add it.** The old no-expiry PAT was revoked and
> the property deleted when the App took over. If you find yourself creating a PAT to make
> this work, something else is wrong; fix that instead.

### 2d. Branch protection — the App needs a bypass

The default branch has **"Require a pull request before merging"** enabled. The pipeline
writes directly via the Contents API, which that rule rejects with:

```
GitHub API 409: Could not update file: Changes must be made through a pull request.
```

The App is registered as a bypass actor to allow this: repo → **Settings → Branches** →
the default-branch rule → **"Allow specified actors to bypass required pull requests"** →
add the publish App. **Re-enabling branch protection from scratch, or re-transferring the
repo, will reproduce the 409** — re-add the bypass. (If the block is a *ruleset* rather
than classic protection, the equivalent is Settings → Rules → Rulesets → the branch
ruleset → Bypass list → Add bypass → GitHub Apps → mode Always.)

The security trade-off this bypass implies is recorded in ADR-0007 → *Post-migration
incident (2026-08-27)*. Short version: the App's private key and the committee Gmail
account are now the effective controls on the live site, so key hygiene and 2FA matter
more than they used to.

`MEETINGS_SS_ID` is read at runtime (not hardcoded), so you can repoint the Events page
to a different sheet by changing this property alone. The account the daily trigger runs
as must have **read access** to that sheet.

---

## 3. Allowlist is already configured

`PUBLISH_ALLOWLIST` in `publish.js` already contains:

| Doc                    | Repo path            |
|------------------------|----------------------|
| Role Guide             | `docs/roles.md`      |
| Club Offering          | `docs/pitch.md`      |
| Toastmaster Checklist  | `docs/checklist.md`  |

To add the Committee Roles doc when it's authored: uncomment its line in
`PUBLISH_ALLOWLIST` and add the Doc ID.

---

## 4. Prototype — validate the converter first

Before wiring up live publishing, test the converter output:

1. In the Apps Script editor, run `protoConvertRoleGuide()`
   (the Role Guide Doc ID is already set)
3. Check the execution log — compare the Markdown output against
   the live `docs/roles.md` in the repo
4. Key things to verify:
   - Headings render at the right level (`#`, `##`, `###`)
   - Bullet lists are indented correctly
   - `[image1]` etc. are stripped
   - Tables render as pipe tables
   - Bold / italic text is preserved
   - Links are preserved

If the output looks good, proceed to step 5.

---

## 5. Create the daily trigger

Run `createDailyTrigger()` once from the Apps Script editor.
This creates a 3am daily time trigger for `publishAll()`.

---

## 6. Test a live publish

Run `publishAll()` manually from the editor.
Check:
- The Markdown was committed to the repo (check GitHub commits)
- The committee email received a notification
- The site builds and deploys correctly (GitHub Actions)

---

## Notes

- The pipeline checks last-modified time before publishing — it will not
  re-commit a file if the Doc hasn't changed.
- To force a re-publish of one Doc: run `publishNow('DOC_ID')`.
- To add a new Doc to the pipeline later: add it to `PUBLISH_ALLOWLIST` and
  run `clasp push`. The daily trigger picks it up automatically.
- To remove a Doc from publishing: remove it from `PUBLISH_ALLOWLIST`.
  The file already in the repo is not deleted.

## Events page (in addition to the Docs)

Beyond the allowlisted Docs, `publishAll()` also regenerates `docs/events.md` from the
`Meetings` tab of `MEETINGS_SS_ID`: it syncs Eventbrite registration URLs (if
`EVENTBRITE_TOKEN` is set) and renders per-meeting Easy-Speak agenda links. Per-meeting
Easy-Speak links come from an **Easy-Speak Thread ID** column on the `Meetings` tab, which
is maintained manually (re-exported from Easy-Speak when the schedule changes) — there is
no live feed.
