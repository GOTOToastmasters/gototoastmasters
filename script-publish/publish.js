// ============================================================
// GOTO Toastmasters — Google Docs → Markdown → GitHub Publish Pipeline
//
// Standalone Apps Script project. One-time setup:
//   1. clasp create --type standalone --title "GOTO Publish Pipeline"
//   2. Set Script Properties (Project Settings → Script Properties):
//        GITHUB_TOKEN  — fine-grained PAT with contents:write on the repo
//        GITHUB_OWNER  — e.g. "rkenefeck"
//        GITHUB_REPO   — e.g. "gototoastmasters"
//        GITHUB_BRANCH — e.g. "main"  (defaults to "main" if omitted)
//   3. Add the Role Guide Doc ID (and others) to PUBLISH_ALLOWLIST below.
//   4. Run createDailyTrigger() once to start the scheduled poll.
//
// Safe to re-run publishAll() manually at any time.
// ============================================================

// ── Allowlist: Doc ID → repo path ─────────────────────────────────────────────
// Only Docs explicitly listed here can ever be published.
// This is the security guardrail: sensitive Docs (handover runbooks, etc.)
// are never listed and therefore can never reach the public site.
// Adding a Doc here is a deliberate, code-reviewed act.

var PUBLISH_ALLOWLIST = {
  // Role Guide → Meeting Roles page
  '1c-_XD32gXbSiElJUc99GAyZUq_Ywq02uBAjTXTTW3e0': 'docs/roles.md',
  // Club Offering → The Pitch page
  '11odd_FP2wLXZOGLoNw1y8upnEfUBXVrq3JNnOenZSJ4':  'docs/pitch.md',
  // Toastmaster Checklist (static content; interactivity added in Phase D)
  '1X7Z86L2b7jwmTZ2YC59FZY6sGESKVyZIoobmAFj_ceI': 'docs/checklist.md',
  // Committee Role Expectations → Committee Roles page
  '1UAgKxeTZIC6ObXLkzT7e58qSW0jrKW_mQksQRzVIf-Q': 'docs/committee-roles.md',
};

// Committee notification email (receives a summary on every publish run that
// produces changes — the audit safeguard per ADR 0002).
var NOTIFY_EMAIL = 'goto.toastmasters.committee@gmail.com';

// ── Entry points ──────────────────────────────────────────────────────────────

/**
 * Main publish loop — run daily via time trigger or manually.
 * Checks each allowlisted Doc for changes since last publish; only re-publishes
 * if the Doc has been modified since the last successful publish.
 */
// ── Spreadsheet config (for Events / Meetings tab) ────────────────────────────
// The spreadsheet holding the Meetings tab. Set via Script Properties so the
// owner can repoint it (e.g. to the prod sheet) without a code change:
//   Project Settings → Script Properties → MEETINGS_SS_ID = <sheet id>
// The account the daily trigger runs as must have read access to that sheet.
var MEETINGS_TAB = 'Meetings';

function getMeetingsSsId_() {
  var id = PropertiesService.getScriptProperties().getProperty('MEETINGS_SS_ID');
  if (!id) {
    throw new Error('MEETINGS_SS_ID not set in Script Properties. ' +
      'Add it under Project Settings → Script Properties.');
  }
  return id;
}

function publishAll() {
  console.log('=== publishAll starting ===');
  var props   = PropertiesService.getScriptProperties();
  var changed = 0;
  var errors  = [];

  var docIds = Object.keys(PUBLISH_ALLOWLIST);
  if (docIds.length === 0) {
    console.log('Allowlist is empty — nothing to publish. Add Doc IDs to PUBLISH_ALLOWLIST.');
    return;
  }

  docIds.forEach(function(docId) {
    var repoPath = PUBLISH_ALLOWLIST[docId];
    try {
      var file        = DriveApp.getFileById(docId);
      var modifiedKey = 'last_published_' + docId;
      var lastMs      = props.getProperty(modifiedKey);
      var currentMs   = file.getLastUpdated().getTime().toString();

      if (lastMs === currentMs) {
        console.log('  No changes: ' + file.getName());
        return;
      }

      console.log('  Publishing: ' + file.getName() + ' → ' + repoPath);
      var doc      = DocumentApp.openById(docId);
      var markdown = docToMarkdown_(doc);
      var url = commitToGitHub_(repoPath, markdown, 'Auto-publish: ' + doc.getName());
      props.setProperty(modifiedKey, currentMs);
      if (url !== null) {
        changed++;
        console.log('  Done: ' + url);
      } else {
        console.log('  Skipped (content unchanged): ' + repoPath);
      }
    } catch (err) {
      console.log('  ERROR for ' + docId + ': ' + err.message);
      errors.push(docId + ': ' + err.message);
    }
  });

  // Phase C: sync Eventbrite URLs into the Meetings tab, then regenerate events page
  try {
    syncEventbriteUrls_();
  } catch (err) {
    console.log('  Eventbrite sync error: ' + err.message);
    errors.push('Eventbrite sync: ' + err.message);
  }
  try {
    var evChanged = publishEvents_();
    if (evChanged) changed++;
  } catch (err) {
    console.log('  Events page error: ' + err.message);
    errors.push('Events page: ' + err.message);
  }

  console.log('=== publishAll complete. ' + changed + ' published, ' + errors.length + ' error(s) ===');

  if (changed > 0 || errors.length > 0) {
    notifyCommittee_(changed, errors);
  }
}

/**
 * "Publish now" — force-publishes one Doc from the allowlist, regardless of
 * last-modified time. Call from a custom menu or manually.
 *
 * @param {string} docId  The Google Doc ID to publish.
 */
function publishNow(docId) {
  var repoPath = PUBLISH_ALLOWLIST[docId];
  if (!repoPath) {
    throw new Error('Doc ID not in allowlist — cannot publish: ' + docId);
  }
  var doc      = DocumentApp.openById(docId);
  var markdown = docToMarkdown_(doc);
  var url      = commitToGitHub_(repoPath, markdown, 'Manual publish: ' + doc.getName());
  PropertiesService.getScriptProperties().setProperty(
    'last_published_' + docId,
    DriveApp.getFileById(docId).getLastUpdated().getTime().toString()
  );
  console.log('Published ' + doc.getName() + ' → ' + repoPath);
  console.log('Commit: ' + (url || 'OK'));
}

// ── PROTOTYPE — run this first to validate the converter ─────────────────────
/**
 * Convert the Role Guide Doc and log the Markdown output.
 * Run this in the Apps Script editor to validate converter output before
 * wiring up the full pipeline.
 *
 * Steps:
 *   1. Open the Role Guide Doc in Google Docs.
 *   2. Copy the Doc ID from the URL: docs.google.com/document/d/<THIS_PART>/edit
 *   3. Paste it below and run this function.
 *   4. Check the execution log output against the live roles.md.
 */
function protoConvertRoleGuide() {
  var DOC_ID = '1c-_XD32gXbSiElJUc99GAyZUq_Ywq02uBAjTXTTW3e0';

  console.log('Opening doc...');
  var doc = DocumentApp.openById(DOC_ID);
  console.log('Converting: ' + doc.getName());

  var md = docToMarkdown_(doc);
  console.log('Output length: ' + md.length + ' chars');

  // Log in 3000-char chunks (Apps Script logger truncates long strings)
  for (var i = 0; i < md.length; i += 3000) {
    console.log(md.substring(i, i + 3000));
  }
}

/**
 * Debug helper: log the element types and first 80 chars of text for every
 * top-level child in the Pitch doc body. Run this when content appears missing
 * to identify unexpected element types (text boxes, TOC, extra sections, etc.)
 */
function debugPitchElements() {
  var DOC_ID = '11odd_FP2wLXZOGLoNw1y8upnEfUBXVrq3JNnOenZSJ4';
  var doc    = DocumentApp.openById(DOC_ID);
  var body   = doc.getBody();
  var n      = body.getNumChildren();
  console.log('Total body children: ' + n);
  for (var i = 0; i < n; i++) {
    var child = body.getChild(i);
    var type  = child.getType();
    var preview = '';
    try { preview = child.asText ? child.asText().getText().substring(0, 80)
                                 : child.getText().substring(0, 80); } catch(e) {}
    console.log('[' + i + '] ' + type + ' | ' + preview);
  }
}

// ── Converter: Google Doc body → Markdown ─────────────────────────────────────
/**
 * Convert a Google Docs Document to a Markdown string.
 *
 * Supported elements:
 *   - Headings H1–H6
 *   - Normal paragraphs (with inline bold, italic, bold-italic, strikethrough,
 *     monospace/code, hyperlinks)
 *   - Unordered and ordered lists (with nesting)
 *   - Tables (GitHub-flavoured Markdown pipe tables)
 *   - Horizontal rules
 *   - Table of contents (skipped — MkDocs generates its own)
 *   - Inline images (skipped — no meaningful Markdown equivalent)
 *   - [imageN] placeholder strings stripped
 *
 * @param {GoogleAppsScript.Document.Document} doc
 * @returns {string} Markdown text.
 */
function docToMarkdown_(doc) {
  var body        = doc.getBody();
  var numChildren = body.getNumChildren();
  // Emit the document file name as the top-level H1 title.
  // getBody() does NOT include the document title — only body paragraphs.
  var lines       = ['# ' + doc.getName(), ''];
  var prevBlank   = true;
  var listCounters = {}; // nestingLevel → ordered list counter

  // ── Pass 1: collect H1 headings for the auto-generated inline TOC ─────────
  // The Doc's native TOC element is skipped (it can drift out of sync).
  // We rebuild it from the actual headings so it's always accurate.
  var tocEntries = []; // { text, anchor }
  for (var t = 0; t < numChildren; t++) {
    var el = body.getChild(t);
    if (el.getType() === DocumentApp.ElementType.PARAGRAPH) {
      var p = el.asParagraph();
      if (p.getHeading() === DocumentApp.ParagraphHeading.HEADING1) {
        var headingText = p.getText().trim();
        if (headingText) {
          // Derive the GitHub/MkDocs anchor: lowercase, non-alphanumeric → hyphen,
          // collapse hyphens, strip leading/trailing hyphens.
          var anchor = headingText.toLowerCase()
            .replace(/[^\w\s-]/g, '')   // strip special chars (except hyphens)
            .replace(/[\s_]+/g, '-')    // spaces/underscores → hyphens
            .replace(/-+/g, '-')        // collapse multiple hyphens
            .replace(/^-+|-+$/g, '');   // trim leading/trailing hyphens
          tocEntries.push({ text: headingText, anchor: anchor });
        }
      }
    }
  }

  for (var i = 0; i < numChildren; i++) {
    var child = body.getChild(i);
    var type  = child.getType();

    // ── LIST_ITEM elements (Google Docs native list type) ──────────────────
    if (type === DocumentApp.ElementType.LIST_ITEM) {
      var li         = child.asListItem();
      var nestLevel  = li.getNestingLevel(); // 0-based
      var glyphType  = li.getGlyphType();
      var isOrdered  = (
        glyphType === DocumentApp.GlyphType.NUMBER        ||
        glyphType === DocumentApp.GlyphType.LATIN_UPPER   ||
        glyphType === DocumentApp.GlyphType.LATIN_LOWER   ||
        glyphType === DocumentApp.GlyphType.ROMAN_UPPER   ||
        glyphType === DocumentApp.GlyphType.ROMAN_LOWER
      );
      var indent     = repeatStr('  ', nestLevel);
      var inlineText = paraInlineToMd_(li);

      // Python-Markdown (used by MkDocs) requires a blank line before a list
      // when it follows a paragraph. Insert one at the start of each list block
      // (i.e. when the previous output line was not already blank).
      if (!prevBlank && nestLevel === 0) { lines.push(''); }

      if (isOrdered) {
        Object.keys(listCounters).forEach(function(k) {
          if (parseInt(k, 10) > nestLevel) delete listCounters[k];
        });
        listCounters[nestLevel] = (listCounters[nestLevel] || 0) + 1;
        lines.push(indent + listCounters[nestLevel] + '. ' + inlineText);
      } else {
        lines.push(indent + '- ' + inlineText);
      }
      prevBlank = false;
      continue;
    }

    if (type === DocumentApp.ElementType.PARAGRAPH) {
      var para    = child.asParagraph();
      var heading = para.getHeading();

      // ── List items (PARAGRAPH subtype with a list ID) ─────────────────────
      // Some older Google Docs represent list items as PARAGRAPH elements with
      // a listId rather than as LIST_ITEM elements. Handle both.
      var listId = null;
      try { listId = para.getListId(); } catch (e) {}

      if (listId) {
        var nestLevel  = para.getNestingLevel(); // 0-based
        var glyphType  = para.getGlyphType();
        var isOrdered  = (
          glyphType === DocumentApp.GlyphType.NUMBER        ||
          glyphType === DocumentApp.GlyphType.LATIN_UPPER   ||
          glyphType === DocumentApp.GlyphType.LATIN_LOWER   ||
          glyphType === DocumentApp.GlyphType.ROMAN_UPPER   ||
          glyphType === DocumentApp.GlyphType.ROMAN_LOWER
        );
        var indent     = repeatStr('  ', nestLevel);
        var inlineText = paraInlineToMd_(para);

        if (!prevBlank && nestLevel === 0) { lines.push(''); }

        if (isOrdered) {
          Object.keys(listCounters).forEach(function(k) {
            if (parseInt(k, 10) > nestLevel) delete listCounters[k];
          });
          listCounters[nestLevel] = (listCounters[nestLevel] || 0) + 1;
          lines.push(indent + listCounters[nestLevel] + '. ' + inlineText);
        } else {
          lines.push(indent + '- ' + inlineText);
        }
        prevBlank = false;
        continue;
      }

      // Leaving a list — reset ordered counters
      listCounters = {};

      // ── Skip TITLE / SUBTITLE body paragraphs ─────────────
      // The document title is already emitted from doc.getName() at the top.
      // TITLE/SUBTITLE styled body paragraphs are decorative and would produce
      // a duplicate heading (or stray plain text if they match the file name).
      var H_ = DocumentApp.ParagraphHeading;
      if (heading === H_.TITLE || heading === H_.SUBTITLE) {
        if (!prevBlank) { lines.push(''); prevBlank = true; }
        continue;
      }

      // ── Headings ──────────────────────────────────────────
      var hashes = headingPrefix_(heading);
      var inlineText = paraInlineToMd_(para);

      if (!inlineText.trim()) {
        // Empty paragraph = blank separator line
        if (!prevBlank) { lines.push(''); prevBlank = true; }
        continue;
      }

      if (hashes) {
        // Blank styled paragraph (e.g. empty H2 used as spacer) → blank line only
        if (!inlineText.trim()) {
          if (!prevBlank) { lines.push(''); prevBlank = true; }
          continue;
        }
        // Before the first H1, inject the auto-generated TOC
        if (hashes === '# ' && tocEntries.length > 0) {
          // Check we haven't already emitted the TOC
          var tocAlreadyEmitted = lines.some(function(l) { return l.indexOf('<!-- toc -->') >= 0; });
          if (!tocAlreadyEmitted) {
            if (!prevBlank) lines.push('');
            lines.push('<!-- toc -->');
            tocEntries.forEach(function(entry) {
              lines.push('- [' + entry.text + '](#' + entry.anchor + ')');
            });
            lines.push('<!-- /toc -->');
            lines.push('');
            prevBlank = true;
          }
        }
        // Ensure a blank line before headings (except at start of document)
        if (lines.length > 0 && !prevBlank) { lines.push(''); }
        lines.push(hashes + inlineText);
        lines.push('');
        prevBlank = true;
      } else {
        lines.push(inlineText);
        prevBlank = false;
      }

    } else if (type === DocumentApp.ElementType.TABLE) {
      listCounters = {};
      if (!prevBlank) lines.push('');
      tableToMd_(child.asTable()).forEach(function(l) { lines.push(l); });
      lines.push('');
      prevBlank = true;

    } else if (type === DocumentApp.ElementType.HORIZONTAL_RULE) {
      listCounters = {};
      if (!prevBlank) lines.push('');
      lines.push('---');
      lines.push('');
      prevBlank = true;

    } else if (type === DocumentApp.ElementType.TABLE_OF_CONTENTS) {
      // Skip — MkDocs generates its own TOC from headings
      continue;
    }
    // All other types (inline images at block level, page breaks, etc.) skipped
  }

  var md = lines.join('\n');

  // ── Post-processing ────────────────────────────────────────────────────────
  // 0. Strip carriage returns (\r) — Google Docs sometimes embeds Windows
  //    line endings; ^M chars appear in the rendered output without this.
  md = md.replace(/\r/g, '');

  // 1. Strip [imageN] placeholders (e.g. [image1], [image12])
  md = md.replace(/\[image\d+\]/gi, '');

  // 2. Strip bold/italic whitespace-only artifacts from empty styled paragraphs
  //    e.g. "** **", "* *", "*** ***" — visually blank lines in the Doc
  md = md.replace(/^\*{1,3}\s+\*{1,3}$/gm, '');

  // 3. Collapse 3+ consecutive blank lines → 2 (one blank line between blocks)
  md = md.replace(/\n{3,}/g, '\n\n');

  // 4. Remove trailing whitespace on each line
  md = md.split('\n').map(function(l) { return l.replace(/\s+$/, ''); }).join('\n');

  return md.trim() + '\n';
}

/**
 * Return the Markdown heading prefix (e.g. "## ") for a ParagraphHeading enum,
 * or empty string for normal body text.
 */
function headingPrefix_(heading) {
  var H = DocumentApp.ParagraphHeading;
  // TITLE and SUBTITLE are Google Docs styling applied to body paragraphs; the
  // actual document title comes from doc.getName() and is emitted separately at
  // the top of the output. Treat these body styles as normal text to avoid
  // producing blank H1/H2 lines when the paragraph text is empty or decorative.
  if (heading === H.HEADING1) return '# ';
  if (heading === H.HEADING2) return '## ';
  if (heading === H.HEADING3) return '### ';
  if (heading === H.HEADING4) return '#### ';
  if (heading === H.HEADING5) return '##### ';
  if (heading === H.HEADING6) return '###### ';
  return '';
}

/**
 * Convert a Paragraph's inline children to Markdown.
 * Handles Text elements (with formatting) and skips InlineImages.
 */
function paraInlineToMd_(para) {
  var result = '';
  var numCh  = para.getNumChildren();
  for (var i = 0; i < numCh; i++) {
    var child = para.getChild(i);
    if (child.getType() === DocumentApp.ElementType.TEXT) {
      result += textElToMd_(child.asText());
    }
    // InlineImage, Equation, etc. — skipped
  }

  // Convert soft line breaks (Shift+Enter in Google Docs = \n inside a single
  // paragraph element) to Markdown hard line breaks (two trailing spaces + \n).
  // Without this, consecutive lines like a committee list collapse into one line
  // because Markdown ignores single newlines.
  return result.replace(/\n/g, '  \n');
}

/**
 * Convert a Text element (which can have mixed inline formatting across
 * character ranges) to a Markdown string.
 *
 * Uses getTextAttributeIndices() to get run-change boundaries efficiently,
 * avoiding a character-by-character scan on long paragraphs.
 */
function textElToMd_(textEl) {
  var full = textEl.getText();
  if (!full) return '';

  // getTextAttributeIndices() returns the start positions of each distinct
  // formatting run. We append `full.length` as the end sentinel.
  var indices    = textEl.getTextAttributeIndices();
  var boundaries = indices.concat([full.length]);
  var md         = '';

  for (var i = 0; i < boundaries.length - 1; i++) {
    var start = boundaries[i];
    var end   = boundaries[i + 1];
    var t     = full.substring(start, end);
    if (!t) continue;

    var bold    = !!textEl.isBold(start);
    var italic  = !!textEl.isItalic(start);
    var strike  = !!textEl.isStrikethrough(start);
    var font    = textEl.getFontFamily(start) || '';
    var mono    = (font === 'Courier New' || font === 'Roboto Mono' ||
                   font === 'Consolas'    || font === 'Source Code Pro');
    var link    = textEl.getLinkUrl(start);

    // Escape Markdown special chars in plain text runs only
    if (!mono) {
      t = t.replace(/\\/g, '\\\\')
            .replace(/\[/g,  '\\[')
            .replace(/\]/g,  '\\]');
    }

    if (mono) {
      // Inline code — use backticks; double-backtick if content contains backtick
      var tick = t.indexOf('`') >= 0 ? '``' : '`';
      t = tick + t + tick;
    } else if (bold || italic || strike) {
      // Markdown inline markers must not have leading/trailing spaces inside them
      // (e.g. "** text **" is not valid bold — the spaces break the parser).
      // Strip surrounding spaces from the text, apply markers, then reattach spaces.
      var leading  = t.match(/^\s*/)[0];
      var trailing = t.match(/\s*$/)[0];
      var inner    = t.slice(leading.length, t.length - trailing.length);
      if (inner) {
        if (strike)           inner = '~~' + inner + '~~';
        if (bold && italic)   inner = '***' + inner + '***';
        else if (bold)        inner = '**' + inner + '**';
        else if (italic)      inner = '*' + inner + '*';
      }
      t = leading + inner + trailing;
    }

    if (link) t = '[' + t + '](' + link + ')';
    md += t;
  }

  return md;
}

/**
 * Convert a Table element to a GitHub-flavoured Markdown pipe table.
 * First row is treated as the header row.
 * Inline formatting in cells is not currently preserved (plain text only).
 *
 * @returns {string[]} Array of Markdown lines.
 */
function tableToMd_(table) {
  var numRows = table.getNumRows();
  if (numRows === 0) return [];

  // Collect cell text, escaping pipes
  var rows = [];
  for (var r = 0; r < numRows; r++) {
    var row   = table.getRow(r);
    var cells = [];
    for (var c = 0; c < row.getNumCells(); c++) {
      var text = row.getCell(c).getText()
                    .replace(/\n/g, ' ')   // collapse multi-line cells to one line
                    .replace(/\|/g, '\\|') // escape any literal pipes
                    .trim();
      cells.push(text);
    }
    rows.push(cells);
  }

  var numCols = rows[0].length;
  var lines   = [];

  // Header row
  lines.push('| ' + rows[0].join(' | ') + ' |');
  // Separator row
  lines.push('| ' + rows[0].map(function() { return '---'; }).join(' | ') + ' |');
  // Body rows
  for (var r = 1; r < rows.length; r++) {
    var cells = rows[r].slice(0, numCols);
    while (cells.length < numCols) cells.push('');
    lines.push('| ' + cells.join(' | ') + ' |');
  }

  return lines;
}

// ── GitHub REST API — commit a file ───────────────────────────────────────────
/**
 * Create or update a file in the GitHub repo via the Contents API.
 * Fetches the current file SHA first (required for updates).
 *
 * Requires Script Properties:
 *   GITHUB_TOKEN  — fine-grained PAT with "Contents: Read and Write" on the repo.
 *   GITHUB_OWNER  — GitHub username or org (e.g. "rkenefeck").
 *   GITHUB_REPO   — Repository name (e.g. "gototoastmasters").
 *   GITHUB_BRANCH — Branch to commit to (defaults to "main").
 *
 * @param {string} repoPath  File path in the repo (e.g. "docs/roles.md").
 * @param {string} content   UTF-8 file content.
 * @param {string} message   Commit message.
 * @returns {string|null}    HTML URL of the commit, or null.
 */
function commitToGitHub_(repoPath, content, message) {
  var props  = PropertiesService.getScriptProperties();
  var token  = props.getProperty('GITHUB_TOKEN');
  var owner  = props.getProperty('GITHUB_OWNER');
  var repo   = props.getProperty('GITHUB_REPO');
  var branch = props.getProperty('GITHUB_BRANCH') || 'main';

  if (!token || !owner || !repo) {
    throw new Error(
      'GitHub Script Properties not configured. ' +
      'Set GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO in Project Settings → Script Properties.'
    );
  }

  var apiUrl  = 'https://api.github.com/repos/' + owner + '/' + repo +
                '/contents/' + repoPath;
  var headers = {
    'Authorization': 'Bearer ' + token,
    'Accept':        'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // GET the current file to retrieve its SHA (required for updates)
  var currentSha = null;
  var getResp = UrlFetchApp.fetch(apiUrl + '?ref=' + branch, {
    method:            'get',
    headers:           headers,
    muteHttpExceptions: true,
  });
  if (getResp.getResponseCode() === 200) {
    var getObj = JSON.parse(getResp.getContentText());
    currentSha = getObj.sha;

    // Skip the PUT entirely if the new content is byte-identical to what's
    // already on GitHub. GitHub's Contents API returns 200 with the EXISTING
    // commit for an identical PUT (no new commit), which used to make callers
    // think a change happened and fire a false "page auto-published" email.
    if (getObj.content) {
      var existing = Utilities.newBlob(
        Utilities.base64Decode(getObj.content.replace(/\n/g, ''), Utilities.Charset.UTF_8)
      ).getDataAsString('UTF-8');
      if (existing === content) {
        console.log('[commitToGitHub_] ' + repoPath + ' unchanged — skipping commit.');
        return null;
      }
    }
  }

  // PUT (create or update)
  var payload = {
    message: message,
    content: Utilities.base64Encode(content, Utilities.Charset.UTF_8),
    branch:  branch,
  };
  if (currentSha) payload.sha = currentSha;

  var putResp = UrlFetchApp.fetch(apiUrl, {
    method:            'put',
    headers:           Object.assign({}, headers, { 'Content-Type': 'application/json' }),
    payload:           JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  var code    = putResp.getResponseCode();
  var respObj = JSON.parse(putResp.getContentText());
  if (code !== 200 && code !== 201) {
    throw new Error('GitHub API ' + code + ': ' +
                    (respObj.message || JSON.stringify(respObj)));
  }

  return respObj.commit ? respObj.commit.html_url : null;
}

// ── Committee notification ────────────────────────────────────────────────────
/**
 * Email the committee account with a publish summary.
 * This is the audit safeguard — an unexpected publish is noticed immediately.
 */
function notifyCommittee_(numChanged, errors) {
  var props  = PropertiesService.getScriptProperties();
  var owner  = props.getProperty('GITHUB_OWNER') || '';
  var repo   = props.getProperty('GITHUB_REPO')  || '';
  var repoUrl = owner && repo
    ? 'https://github.com/' + owner + '/' + repo + '/commits/main'
    : '(repo not configured)';

  var subject = '[GOTO site] ' + numChanged + ' page(s) auto-published';
  var body    = numChanged + ' page(s) were automatically published to gototoastmasters.com.au.\n\n' +
                'Review commits: ' + repoUrl + '\n';

  if (errors && errors.length > 0) {
    body += '\nErrors (' + errors.length + '):\n' +
            errors.map(function(e) { return '  - ' + e; }).join('\n') + '\n';
  }

  body += '\n— GOTO Publish Pipeline (Apps Script)';

  try {
    GmailApp.sendEmail(NOTIFY_EMAIL, subject, body);
  } catch (e) {
    console.log('Failed to send notification email: ' + e.message);
  }
}

// ── Phase C: Eventbrite sync ──────────────────────────────────────────────────

/**
 * Fetches upcoming events from Eventbrite for the GOTO org and writes the
 * registration URL into the Meetings tab for any row whose date matches.
 *
 * Rules:
 *   - If a row has a Manual Eventbrite URL, it is never overwritten.
 *   - If Eventbrite returns an event on the same date, write its URL into
 *     the Eventbrite URL column.
 *
 * Requires Script Properties: EVENTBRITE_TOKEN, EVENTBRITE_ORG_ID.
 */
function syncEventbriteUrls_() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var token = props['EVENTBRITE_TOKEN'];
  var orgId = props['EVENTBRITE_ORG_ID'] || '111570638511';

  if (!token) {
    console.log('[syncEventbrite] EVENTBRITE_TOKEN not set — skipping.');
    return;
  }

  // Fetch live upcoming events
  var allEvents = [];
  var page      = 1;
  var hasMore   = true;
  while (hasMore) {
    var pageUrl = 'https://www.eventbriteapi.com/v3/organizers/' + orgId +
                  '/events/?status=live&order_by=start_asc&page=' + page;
    var resp = UrlFetchApp.fetch(pageUrl, {
      headers: { 'Authorization': 'Bearer ' + token },
      muteHttpExceptions: true,
    });
    if (resp.getResponseCode() !== 200) {
      console.log('[syncEventbrite] API error ' + resp.getResponseCode() + ': ' +
                 resp.getContentText().substring(0, 200));
      return;
    }
    var body = JSON.parse(resp.getContentText());
    (body.events || []).forEach(function(ev) { allEvents.push(ev); });
    var pg  = body.pagination;
    hasMore = !!(pg && pg.has_more_items);
    page++;
  }
  console.log('[syncEventbrite] Fetched ' + allEvents.length + ' live event(s).');

  // Build YYYY-MM-DD → { url, name } map
  var eventByDate = {};
  allEvents.forEach(function(ev) {
    var dateKey = ev.start.local.substring(0, 10);
    eventByDate[dateKey] = { url: ev.url, name: (ev.name || {}).text || '' };
  });

  var ss    = SpreadsheetApp.openById(getMeetingsSsId_());
  var sheet = ss.getSheetByName(MEETINGS_TAB);
  if (!sheet) { console.log('[syncEventbrite] Meetings tab not found.'); return; }

  var lastCol      = sheet.getLastColumn();
  var headers      = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var autoUrlCol   = headers.indexOf('Eventbrite URL');
  var manualUrlCol = headers.indexOf('Manual Eventbrite URL');

  if (autoUrlCol < 0) {
    console.log('[syncEventbrite] "Eventbrite URL" column missing — run fixMasterSchema() first.');
    return;
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var data    = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var updated = 0;

  data.forEach(function(row, i) {
    var rowNum  = i + 2;
    var rawDate = row[0]; // Date is always column 1
    if (!rawDate) return;
    if (manualUrlCol >= 0 && row[manualUrlCol]) return; // manual URL wins

    var d = parseMeetingDate_(rawDate);
    if (!d) return;
    var dateKey = Utilities.formatDate(d, 'Australia/Melbourne', 'yyyy-MM-dd');
    var match   = eventByDate[dateKey];
    var current = row[autoUrlCol] || '';
    var newUrl  = match ? match.url : '';

    if (newUrl && newUrl !== current) {
      sheet.getRange(rowNum, autoUrlCol + 1).setValue(newUrl);
      console.log('[syncEventbrite] Row ' + rowNum + ' (' + dateKey + '): ' + newUrl);
      updated++;
    }
  });

  SpreadsheetApp.flush();
  console.log('[syncEventbrite] ' + updated + ' row(s) updated.');
}

// ── Phase C: Events page generator ───────────────────────────────────────────

/**
 * Reads the Meetings tab and generates docs/events.md, committing to GitHub.
 * Only upcoming meetings (date >= today) are included.
 * Returns true if the commit went through.
 */
function publishEvents_() {
  var ss    = SpreadsheetApp.openById(getMeetingsSsId_());
  var sheet = ss.getSheetByName(MEETINGS_TAB);
  if (!sheet || sheet.getLastRow() < 2) {
    console.log('[publishEvents] Meetings tab empty — skipping.');
    return false;
  }

  var lastCol      = sheet.getLastColumn();
  var headers      = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var autoUrlCol   = headers.indexOf('Eventbrite URL');
  var manualUrlCol = headers.indexOf('Manual Eventbrite URL');
  var esIdCol      = headers.indexOf('Easy-Speak Thread ID');
  var TYPE_COL     = 1; // col 2 = Type (0-based index 1)

  var today = new Date();
  today.setHours(0, 0, 0, 0);

  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, lastCol).getValues();

  var upcoming = [];
  data.forEach(function(row) {
    var rawDate = row[0];
    if (!rawDate) return;
    var d = parseMeetingDate_(rawDate);
    if (!d || d < today) return;
    var url  = (manualUrlCol >= 0 && row[manualUrlCol]) ? row[manualUrlCol]
             : (autoUrlCol   >= 0 ? row[autoUrlCol]   : '');
    var esId = (esIdCol >= 0 && row[esIdCol]) ? String(row[esIdCol]).trim() : '';
    upcoming.push({ date: d, type: (row[TYPE_COL] || '').trim(), url: url || '', esId: esId });
  });

  upcoming.sort(function(a, b) { return a.date - b.date; });

  var lines = [
    '# Upcoming Events',
    '',
    '_This page updates automatically from the meeting schedule._',
    '',
    '[→ Agenda for our next meeting on Easy-Speak](https://easy-speak.org/view_meeting.php?c=13017&show=next)',
    '',
  ];

  if (upcoming.length === 0) {
    lines.push('No upcoming events scheduled at this time. Check back soon!');
    lines.push('');
  } else {
    upcoming.forEach(function(ev) {
      var dateFmt = Utilities.formatDate(ev.date, 'Australia/Melbourne', 'EEEE d MMMM yyyy');
      var label   = ev.type || 'GOTO Toastmasters Meeting';

      lines.push(ev.url ? '## [' + label + '](' + ev.url + ')' : '## ' + label);
      lines.push('');
      lines.push('**' + dateFmt + '** &nbsp;·&nbsp; 5:30 PM AEST &nbsp;·&nbsp; Melbourne CBD');
      lines.push('');
      if (ev.url) {
        lines.push('[Register on Eventbrite ↗](' + ev.url + ')');
        lines.push('');
      }
      if (ev.esId) {
        lines.push('[View agenda on Easy-Speak ↗](https://easy-speak.org/view_meeting.php?t=' + ev.esId + ')');
        lines.push('');
      }
      lines.push('---');
      lines.push('');
    });
  }

  var md     = lines.join('\n');
  var result = commitToGitHub_('docs/events.md', md, 'auto: refresh Events page from meeting schedule');
  console.log('[publishEvents] events.md committed with ' + upcoming.length + ' upcoming event(s).');
  return !!result;
}

/**
 * Parse a date value from the Meetings sheet.
 * Handles Date objects, ISO strings, and DD/MM/YYYY strings.
 */
function parseMeetingDate_(val) {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  var s  = val.toString().trim();
  var au = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (au) return new Date(parseInt(au[3]), parseInt(au[2]) - 1, parseInt(au[1]));
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// ── Trigger setup (run once) ──────────────────────────────────────────────────
/**
 * Create the daily time-based trigger for publishAll().
 * Run this function once from the Apps Script editor after deploying.
 * Safe to re-run — won't create a duplicate trigger.
 */
function createDailyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'publishAll') {
      console.log('Daily trigger already exists — skipping.');
      return;
    }
  }
  ScriptApp.newTrigger('publishAll')
    .timeBased()
    .everyDays(1)
    .atHour(3) // 3am Melbourne time
    .create();
  console.log('Daily trigger created (runs at 3am Melbourne time).');
}

/**
 * Remove the daily trigger (for maintenance / debugging).
 */
function removeDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'publishAll') {
      ScriptApp.deleteTrigger(t);
      console.log('Daily trigger removed.');
    }
  });
}

// ── Helper ────────────────────────────────────────────────────────────────────
function repeatStr(s, n) {
  var r = '';
  for (var i = 0; i < n; i++) r += s;
  return r;
}
