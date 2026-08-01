const fs = require("fs");
const { git, statePath, readJson, writeJson, log } = require("./util");

// Creates a dangling commit baseline without touching the tree, index, or HEAD.
// Pre-session uncommitted edits are included so they never appear in the review.
// reset:true (SessionStart) starts a fresh session; false preserves sessionStart across per-request snapshots.
function snapshot(repoRoot, { reset = false } = {}) {
  ensureExcluded(repoRoot);
  const tmpIndex = statePath(repoRoot, "tmp-index");
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };

  // Seed temp index from HEAD if present (empty repo is fine).
  let head = null;
  try {
    head = git(repoRoot, ["rev-parse", "HEAD"]).trim();
    git(repoRoot, ["read-tree", "HEAD"], { env });
  } catch (_) {
    /* unborn branch — start from empty index */
  }

  git(repoRoot, ["add", "-A", "--", "."], { env });
  const tree = git(repoRoot, ["write-tree"], { env }).trim();
  const parentArgs = head ? ["-p", head] : [];
  const commit = git(
    repoRoot,
    ["commit-tree", tree, ...parentArgs, "-m", "review-tab baseline"],
    { env }
  ).trim();

  const existing = reset ? {} : (readJson(statePath(repoRoot, "session.json"), {}));
  writeJson(statePath(repoRoot, "session.json"), {
    baseline: commit,
    sessionStart: existing.sessionStart || commit,
    startedAt: existing.startedAt || new Date().toISOString(),
    files: [],
  });

  try { fs.unlinkSync(statePath(repoRoot, "opened.sig")); } catch (_) { }
  log(repoRoot, `snapshot baseline=${commit}${reset ? " (session reset)" : ""}`);
}

// Add .review-tab/ to .git/info/exclude (repo-local ignore) to avoid polluting the user's .gitignore.
function ensureExcluded(repoRoot) {
  try {
    const path = require("path");
    const gitDir = git(repoRoot, ["rev-parse", "--git-dir"]).trim();
    const abs = path.isAbsolute(gitDir) ? gitDir : path.join(repoRoot, gitDir);
    const excl = path.join(abs, "info", "exclude");
    fs.mkdirSync(path.dirname(excl), { recursive: true });
    let cur = "";
    try { cur = fs.readFileSync(excl, "utf8"); } catch (_) { }
    if (!cur.split(/\r?\n/).includes(".review-tab/")) {
      fs.appendFileSync(excl, (cur.endsWith("\n") || !cur ? "" : "\n") + ".review-tab/\n");
    }
  } catch (_) { }
}

module.exports = { snapshot };
