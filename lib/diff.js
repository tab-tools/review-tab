const path = require("path");
const crypto = require("crypto");
const { git, statePath, readJson } = require("./util");

// Diffs the session baseline against the working tree; parses into files → hunks → lines.

function getSession(repoRoot) {
  return readJson(statePath(repoRoot, "session.json"), null);
}

const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function currentHead(repoRoot) {
  try {
    return git(repoRoot, ["rev-parse", "HEAD"]).trim();
  } catch (_) {
    return EMPTY_TREE_SHA; // unborn branch — nothing committed yet
  }
}

function rawDiff(repoRoot, baseline, files) {
  // Commit-to-commit diff picks up newly created (untracked) files; commit-vs-worktree misses them.
  const tmpIndex = statePath(repoRoot, "tmp-index-now");
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    git(repoRoot, ["read-tree", "HEAD"], { env });
  } catch (_) { }
  git(repoRoot, ["add", "-A", "--", "."], { env });
  const tree = git(repoRoot, ["write-tree"], { env }).trim();
  const current = git(repoRoot, ["commit-tree", tree, "-m", "review-tab current"], {
    env,
  }).trim();
  const pathFilter = files && files.length ? ["--", ...files] : [];
  return git(repoRoot, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--unified=3",
    baseline,
    current,
    ...pathFilter,
  ]);
}

function parseDiff(diffText) {
  const files = [];
  let current = null;
  let hunk = null;

  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = { header: [line], filePath: null, hunks: [], binary: false };
      files.push(current);
      hunk = null;
      continue;
    }
    if (!current) continue;

    if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      hunk = {
        header: line,
        oldStart: m ? parseInt(m[1], 10) : 0,
        newStart: m ? parseInt(m[3], 10) : 0,
        lines: [],
        additions: 0,
        deletions: 0,
      };
      current.hunks.push(hunk);
      continue;
    }

    if (hunk) {
      // Hunk body: context (' '), add ('+'), del ('-'), or '\ No newline'
      if (/^[ +\-\\]/.test(line) || line === "") {
        hunk.lines.push(line);
        if (line.startsWith("+")) hunk.additions++;
        if (line.startsWith("-")) hunk.deletions++;
        continue;
      }
      hunk = null; // fell out of hunk body into next file header line
    }

    current.header.push(line);
    if (line.includes("Binary files")) current.binary = true;
    const plus = /^\+\+\+ b\/(.*)$/.exec(line);
    if (plus) current.filePath = plus[1];
    const minusOnly = /^--- a\/(.*)$/.exec(line);
    if (minusOnly && !current.filePath) current.filePath = minusOnly[1];
    if (line === "+++ /dev/null") current.deleted = true;
    if (line === "--- /dev/null") current.created = true;
  }

  // Fallback file path from the "diff --git a/x b/x" line (renames, /dev/null)
  for (const f of files) {
    if (!f.filePath) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(f.header[0]);
      if (m) f.filePath = m[2];
    }
  }

  // Assign deterministic hunk IDs based on filePath and hunk index within file
  for (const f of files) {
    if (!f.filePath) continue;
    f.hunks.forEach((h, idx) => {
      const hash = crypto.createHash("sha1").update(`${f.filePath}:${idx}`).digest("hex").slice(0, 12);
      h.id = `h_${hash}`;
    });
  }

  return files.filter((f) => f.filePath);
}

function buildReviewModel(repoRoot, reviewMode) {
  const session = getSession(repoRoot);
  if (!session || !session.baseline) {
    return { error: "No session found. Did the SessionStart hook run?" };
  }
  // accumulate: all uncommitted changes vs HEAD. per-request: only files touched this session/prompt.
  const baseline = reviewMode === "accumulate" ? currentHead(repoRoot) : session.baseline;
  const files = reviewMode === "accumulate" ? [] : session.files || [];
  const diffText = rawDiff(repoRoot, baseline, files);
  const parsed = parseDiff(diffText);
  return {
    repoRoot,
    baseline: session.baseline,
    startedAt: session.startedAt,
    trackedFiles: files,
    files: parsed.map((f) => ({
      filePath: f.filePath,
      binary: !!f.binary,
      created: !!f.created,
      deleted: !!f.deleted,
      additions: f.hunks.reduce((n, h) => n + h.additions, 0),
      deletions: f.hunks.reduce((n, h) => n + h.deletions, 0),
      hunks: f.hunks.map((h) => ({
        id: h.id,
        header: h.header,
        oldStart: h.oldStart,
        newStart: h.newStart,
        lines: h.lines,
        additions: h.additions,
        deletions: h.deletions,
      })),
    })),
  };
}

module.exports = { buildReviewModel };
