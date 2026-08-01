# Review Tab

**v1.0.0** — Batch diff review for [Claude Code](https://code.claude.com), inspired by the review workflow in editors like Antigravity and Windsurf.

## Table of contents

- [The problem](#the-problem)
- [What this does](#what-this-does)
- [Installation](#installation)
- [Usage](#usage)
- [How it works](#how-it-works)
- [Feedback](#feedback)
- [License](#license)

## The problem

Claude Code has several [permission modes](https://code.claude.com/docs/en/permission-modes) that control how much it asks before editing files. Two of them cover most day-to-day use:

- **Default mode** asks for approval before every single file edit. You review changes one at a time, with no visibility into what's coming next, and rejecting one edit stops the whole task rather than just skipping that change.
- **Accept edits mode** (`acceptEdits` in settings, shown as "Edit automatically" in some interfaces) lets Claude edit freely without asking. Anthropic's own documentation recommends this mode specifically for people who intend to review the results afterward, using their editor or `git diff`, instead of approving each edit as it happens.

That second half, reviewing everything after the fact, is where the built-in tooling stops. `git diff` gives you the raw text of every change with no way to act on it beyond reading. If you want to keep some edits and discard others, you're manually editing the diff output yourself or hoping you remember to check.

This tool fills that gap. It gives `acceptEdits` mode a proper review interface: every change Claude made, organized by file and hunk, with the ability to keep or restore anything down to a single line.

## What this does

Claude edits freely for the whole task, with no prompts interrupting it. When it finishes, a review page opens automatically in your browser, showing every change it made. The page lists every changed file in a sidebar, with one file's full diff shown at a time; you can open files in any order, not just top to bottom. From there you can:

- Keep or restore an entire file, an entire hunk, or a single line — restoring only some lines within a hunk is a first-class "partial" state, tracked and shown separately from fully kept or fully restored
- Switch between two review scopes: **Last Prompt** shows only what Claude changed in the most recent turn; **All Changes** shows everything uncommitted in the working tree vs the last git commit, across all turns
- Mark a file as viewed once you've gone through it, separately from keeping or restoring anything in it, so you can track your own progress through a large set of changes without it affecting what actually gets kept
- See exactly what changed with clear, correct diff styling (a line being restored looks different from a line being undone, since those are opposite outcomes), line numbers for both the old and new version of the file, and hunk boundaries described in plain terms rather than raw diff syntax
- Leave a short note explaining why you restored something. That note is automatically included in Claude's context on your next message, so it can avoid repeating the same mistake instead of guessing why you were unhappy
- Apply the review once you're satisfied, which reverts anything you restored and leaves the rest untouched
- Update the plugin to the latest version directly from the review page when one is available, without leaving the browser

Restored changes are reverted directly on disk using git, computed fresh each time against the current file state. Nothing is written to disk speculatively, and the underlying logic is covered by an automated test suite.

## Installation

```bash
claude plugin marketplace add <your-github-user>/review-tab
claude plugin install review-tab@review-tab-marketplace
```

This registers the plugin's hooks automatically. There's no settings file to edit and nothing to add to `.gitignore`. You'll need Node.js 18 or later and git, both of which any Claude Code user already has.

## Usage

1. Switch your session to `acceptEdits` mode. In the terminal, press `Shift+Tab` once; this is the same mode Anthropic recommends for reviewing changes afterward, which is exactly what this tool is for.
2. Ask Claude to do a task that involves editing files, and let it run to completion without interrupting it.
3. When it finishes, your browser opens automatically to a review page for that project.
4. Work through the file list in the sidebar in whatever order you like. For each file, keep or restore what you want, check it off as viewed once you're satisfied with it, and leave a short reason on anything you restore.
5. Click **Apply Review**. Restored changes are reverted; everything else stays as Claude left it. This works regardless of whether every file has been marked viewed.
6. If you restored anything, your next message to Claude will include an automatic note about what was restored and why.

## How it works

For readers who want the technical detail:

- This tool requires the project to be a git repository, since git's own object model is what it uses to take and compare snapshots without ever touching your actual commit history.
- At the start of a session, and again before each of your messages by default, the tool records the current state of your working tree as a baseline. This is done by writing it into a temporary git index and creating a commit object that never becomes part of your actual history. Any uncommitted changes you already had at that moment become part of the baseline, so they're never mistaken for something Claude did.
- When Claude finishes a turn, the tool diffs the current files against that baseline and builds the review page from the result. It reads the session transcript first to check whether any files were actually touched, so a turn that was pure conversation doesn't trigger any of this. Because the baseline covers your entire working tree, build output or dependency folders like `node_modules` that aren't already gitignored will make this step slower and the review noisier; keeping them gitignored is worth doing independently of this tool.
- How changes are grouped into hunks follows git's standard unified-diff format, so two edits within a few lines of each other appear as one combined hunk rather than two separate ones.
- Restoring a change works by reading the real file from disk and computing the diff again at that exact moment, then reverting just the selected lines. Recomputing fresh before every action, rather than trusting an older snapshot, means that restoring one change and later restoring a different change in the same file can't accidentally corrupt either one.
- The browser opens on its own once a review is ready, and does so instantly for the first review in a given project. If a review server has run for that project recently, opening waits briefly first, long enough for a tab left open from that earlier session to reconnect on its own, so you don't end up with a duplicate tab.

## Feedback

This is a young project built to close a specific gap in Claude Code's workflow. If something doesn't work the way you'd expect, or you have an idea that would make it more useful, please open an issue. A clear description of what you expected versus what happened is the most useful thing you can include.

If it's useful to you, starring the repository helps other people come across it.

## License

MIT
