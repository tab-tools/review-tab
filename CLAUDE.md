# review-tab

## What this is

A Claude Code plugin that adds post-edit diff review to Claude Code sessions, in the style of Cursor or Windsurf's inline review, but delivered as a browser page rather than an editor extension. After Claude finishes making changes, a review page opens automatically showing exactly what changed, organized file by file, with per-hunk and per-line keep/restore control. Anything restored is reverted via git. Anything you type as a reason for restoring something is delivered back to Claude automatically the next time you send a message, so it can course-correct without you having to re-explain yourself.

Repo: github.com/nishit1617/review-tab — v1.0.0

## Why this exists

Claude Code has no native mechanism for reviewing a batch of edits after the fact, only keeping or restoring changes one at a time as they happen, or trusting everything and checking git diff manually afterward. This plugin sits in that gap: it snapshots the state of the repo when a session starts, lets Claude work normally and freely, then on request builds a full diff against that snapshot and gives you a structured way to review it, keep most of it, restore specific pieces, and tell Claude why.

## Core concepts

**Snapshot-based diffing, not working-tree diffing.** The plugin creates a dangling git commit (never touching branches or the real git history) at session start as a baseline, and rebuilds a fresh baseline before each new prompt. Everything shown is a diff between that baseline commit and the current working tree, computed via git's own diff machinery, not a custom line-matching algorithm.

**Transcript-scoped review.** Claude Code's own session transcript (a JSONL file) is parsed to determine which files Claude actually edited via tool calls (Edit, Write, MultiEdit, NotebookEdit) in the current session. The review is scoped to only those files, so unrelated changes already in the working tree don't show up as something to review. This can be disabled per-project via .review-tab/config.json with {"transcriptFilter": false}, which falls back to showing everything changed since the baseline.

**Master-detail review UI.** The browser page shows a file sidebar on the left and one file's full diff on the right at a time, not every file stacked on one long page. Files can be opened in any order via the sidebar, not just sequentially.

**Three hunk states: kept, restored, partial.** A hunk is "kept" when no lines are rejected, "restored" when every changed line is rejected, and "partial" when some lines within the hunk are rejected but not all. Partial is a first-class state: it's tracked in the stats bar, shown in the sidebar file list, and available as a filter. The file-level state (kept / partial / restored) is derived from its hunks using the same logic.

**Viewed is separate from Keep/Restore.** Each file has its own Keep/Restore controls (also available per-hunk when a file has more than one separate block of change) plus a distinct "Viewed" checkbox. Viewed is pure bookkeeping — checking it doesn't keep or restore anything, it just tracks that you've looked at that file and advances you to the next file that hasn't been viewed yet, wrapping around the file list if needed. Unchecking it un-marks the file without navigating anywhere. Reviewing everything to Apply doesn't require every file to be marked viewed — anything untouched is kept by default when you apply.

**Line numbers and human-readable hunk ranges.** Each diff line shows both its old and new line number in the file. Hunk boundaries are shown as "Lines N to M" rather than raw unified-diff @@ syntax.

**Two review modes with independent selections.** The review page has a mode toggle: "Last Prompt" (per-request) shows only the files Claude touched in the most recent prompt, diffed against the baseline that was snapshotted before that prompt. "All Changes" (accumulate) shows every uncommitted change in the working tree vs HEAD, regardless of which session or prompt made it. Selections (keep/restore/partial per hunk) are kept **completely separate** per mode — stored under the key `cr-state-{mode}-{sig}` in both sessionStorage and localStorage. When you switch modes, your previous mode's selections are preserved and will still be there if you return. Apply only applies the selections from the **current** mode; other modes' selections are not touched. Switching modes shows a one-time confirmation explaining this independence.

**Apply confirmation modal.** Clicking Apply shows a modal with a summary of what will be applied (files affected, count of kept/partial/fully-restored hunks) and displays which **mode** the selections are from. This makes it clear exactly which mode's selections you're applying before confirming. A small note reminds you that only the current mode's selections are applied. Anything un-touched in other modes is not affected.

**Feedback loop.** Restoring something with a typed reason writes that reason, along with which file and which lines, to .review-tab/feedback.md. The next time you send Claude a message, a UserPromptSubmit hook reads that file, prints its contents (which Claude Code adds to Claude's context for that turn), and deletes the file so it's delivered exactly once.

**Auto-update.** On startup the server checks the GitHub tags API for a newer version. If one is available, the review page shows an update banner. Clicking "Update Now" calls /api/update, which runs `claude plugin install review-tab@review-tab-marketplace` and then exits so the next session picks up the new code. Stale servers (version mismatch detected on the /api/status response) are automatically replaced when a new review is triggered.

**Smart auto-open and in-place refresh.** The review page opens in your browser automatically when Claude finishes and there's no review tab already open. If a review tab is already open showing the same diff, nothing happens — avoid redundant tabs. If the diff changes (Claude made new edits), the existing open tab refreshes in place with the new content via its polling mechanism — no new tab is opened. The browser is only opened when there's no server yet or when the server is running but no tab is active. When you close a tab, a `pagehide` beacon fires `/api/close` to reset the server's activity timer and clear `opened.sig`, so the next Claude prompt can open a fresh tab even if the diff is identical.

## File structure

hooks/hooks.json            SessionStart -> snapshot, UserPromptSubmit -> prompt, Stop -> open

lib/util.js                 git wrapper, state-file helpers, logging
lib/snapshot.js              creates the dangling-commit baseline
lib/diff.js                   builds the review model (files, hunks, lines) from two snapshots
lib/transcript.js              parses the session transcript to scope review to edited files
lib/revert.js                   reverts rejected lines via content-based matching, always re-diffs fresh first
lib/feedback.js                  writes feedback.md, only for hunks genuinely present in the current rejections
lib/server.js                     HTTP server, browser auto-open logic, live-update polling endpoint
lib/update.js                      checks GitHub tags API for newer versions; drives the in-page update banner and /api/update endpoint

public/index.html                  the entire browser UI: sidebar, detail pane, all styling and client JS

bin/review-tab.js                CLI entry point (snapshot / prompt / open / review / serve)

.claude-plugin/plugin.json, marketplace.json   plugin manifests
package.json                         version, currently 1.0.0

Runtime state lives in .review-tab/ inside whichever project the plugin is reviewing (not in the plugin's own folder), and is git-excluded automatically:

**Server-side state:**
session.json          current baseline commit + tracked file list
review.json           frozen copy of the review model (per-request mode); updated when diff changes and a tab is already open
review-current.json   snapshot of the model as last served by /api/review; used by /api/submit so hunk IDs stay consistent even if baseline or tree changes
feedback.md           pending rejection reasons, deleted once delivered
opened.sig            SHA1 of diff files; prevents reopening the same diff if tab is already active; cleared by /api/close beacon
server.pid            current server's process id; mtime used to detect a recent prior server for auto-open grace period
port                  persisted port number when hash-derived port was reassigned due to collision
log.txt               append-only diagnostic log, never trimmed
config.json           optional, user-created; supports `{"transcriptFilter": false}` to show all working-tree changes vs HEAD
tmp-index, tmp-index-now    internal git scratch files used to build snapshots without touching the real index

**Client-side state (browser):**
Browser selections are stored in both **sessionStorage** and **localStorage** under the key: `cr-state-{mode}-{sig}` where mode is `per-request` or `accumulate` and sig is the review signature. Each entry contains:
- `lineRej`: object mapping hunk IDs to array of rejected line indices
- `reasons`: object mapping hunk IDs to restore reasons (user-typed text)
- `reasonConfirmed`: object mapping hunk IDs to whether reason was user-confirmed

`cr-mode-switch-ack-{port}`: sessionStorage flag set per port after user sees the mode-switch confirmation; ensures the modal appears once per port session and resets when the tab/session closes.

## Working conventions for this project

- The plugin version is only bumped when explicitly requested — treat it as held by default across a set of changes.
- Every change to lib/ or public/index.html should keep the existing automated test suites passing (uitest/, config-test/, version-test/, grace-period-test/), and any new behavior should get its own test alongside the change, not just a manual check.
- The browser UI is a single self-contained HTML file by design — no build step, no framework, no bundler.
- There is no VS Code or other editor extension — this plugin is browser-only.
