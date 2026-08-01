const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const STATE_DIR = ".review-tab";

function findRepoRoot(startDir) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: startDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (_) {
    return null;
  }
}

function stateDir(repoRoot) {
  const dir = path.join(repoRoot, STATE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function statePath(repoRoot, file) {
  return path.join(stateDir(repoRoot), file);
}

function log(repoRoot, msg) {
  try {
    fs.appendFileSync(
      statePath(repoRoot, "log.txt"),
      `[${new Date().toISOString()}] ${msg}\n`
    );
  } catch (_) { }
}

function git(repoRoot, args, opts = {}) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    ...opts,
  });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function readStdinJson() {
  return new Promise((resolve) => {
    let data = "";
    const timer = setTimeout(() => resolve(null), 3000); // never hang a hook
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data));
      } catch (_) {
        resolve(null);
      }
    });
    process.stdin.on("error", () => resolve(null));
  });
}

module.exports = {
  STATE_DIR,
  findRepoRoot,
  stateDir,
  statePath,
  log,
  git,
  readJson,
  writeJson,
  readStdinJson,
};
