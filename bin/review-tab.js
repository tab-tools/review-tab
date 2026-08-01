#!/usr/bin/env node
// review-tab — batch diff review for Claude Code.
// snapshot (SessionStart) | prompt (UserPromptSubmit) | open (Stop) | review (manual)
// All state in .review-tab/. Every command exits 0; failures log to log.txt.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { log, readStdinJson, findRepoRoot, statePath } = require("../lib/util");

const cmd = process.argv[2];
const USAGE = "Usage: review-tab <snapshot|prompt|open|review>";
// Manual commands print a message when no project is found; hook-fired commands exit silently.
const MANUAL_CMDS = ["review"];

async function main() {
  if (!cmd) {
    console.log(USAGE);
    process.exit(0);
  }
  const repoRoot = findRepoRoot(process.cwd());
  if (!repoRoot) {
    if (MANUAL_CMDS.includes(cmd)) {
      console.log(`review-tab: this folder (${process.cwd()}) isn't inside a git repository. Run this from your project folder instead.`);
    }
    process.exit(0);
  }
  // Refuse if repo root is the home directory (would snapshot the entire profile).
  if (path.resolve(repoRoot) === path.resolve(os.homedir())) {
    log(repoRoot, `SKIP ${cmd}: repo root is the home directory. Run 'git init' inside your project folder instead.`);
    if (MANUAL_CMDS.includes(cmd)) {
      console.log("review-tab: your project resolved to a git repo at your HOME directory — refusing. Run 'git init' inside the project folder.");
    }
    process.exit(0);
  }

  switch (cmd) {
    case "snapshot": {
      const { snapshot } = require("../lib/snapshot");
      snapshot(repoRoot, { reset: true });
      break;
    }
    case "prompt": {
      // Deliver rejection reasons to Claude once (stdout → context), then clear.
      const fbPath = statePath(repoRoot, "feedback.md");
      try {
        const fb = fs.readFileSync(fbPath, "utf8");
        if (fb.trim()) {
          console.log(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "UserPromptSubmit",
              additionalContext: fb.trim(),
            },
          }));
        }
        fs.unlinkSync(fbPath);
      } catch (_) {}
      // Advance per-request baseline; sessionStart (accumulate) is preserved inside snapshot().
      { const { snapshot } = require("../lib/snapshot"); snapshot(repoRoot); }
      break;
    }
    case "open":
    case "review": {
      const { openReview } = require("../lib/server");
      const hookInput = cmd === "open" ? await readStdinJson() : null;
      await openReview(repoRoot, { manual: cmd === "review", hookInput });
      break;
    }
    case "serve": {
      const { serve } = require("../lib/server");
      serve(repoRoot);
      return; // keep process alive
    }
    default:
      console.log(USAGE);
  }
}

main().catch((err) => {
  try {
    log(findRepoRoot(process.cwd()) || process.cwd(), `FATAL ${cmd}: ${err.stack}`);
  } catch (_) {}
  // Hooks must not fail Claude's session.
  process.exit(0);
});
