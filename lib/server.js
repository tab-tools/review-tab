const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const path = require("path");
const { spawn, execFile, exec } = require("child_process");
const { buildReviewModel } = require("./diff");
const { revertSelection } = require("./revert");
const { statePath, readJson, writeJson, log } = require("./util");
const { writeFeedback } = require("./feedback");
const { checkForUpdate, getUpdateStatus } = require("./update");

const VERSION = require("../package.json").version;

// Port derived from repo path so each project gets its own; prevents cross-project collision.
function portFor(repoRoot) {
  const h = crypto.createHash("sha1").update(path.resolve(repoRoot)).digest();
  return 4600 + (h.readUInt16BE(0) % 400); // 4600–4999
}

// Persists any port reassignment (from hash collision) so future calls skip the re-probe.
function resolvePort(repoRoot) {
  try {
    const saved = parseInt(fs.readFileSync(statePath(repoRoot, "port"), "utf8"), 10);
    if (saved) return saved;
  } catch (_) { }
  return portFor(repoRoot);
}

function persistPort(repoRoot, port) {
  fs.writeFileSync(statePath(repoRoot, "port"), String(port));
}

// Scans forward from a known-occupied port for one nobody's listening on.
async function findFreePort(avoidPort) {
  for (let i = 1; i < 400; i++) {
    const candidate = 4600 + (((avoidPort - 4600 + i) % 400) + 400) % 400;
    if (!(await serverAlive(candidate))) return candidate;
  }
  return avoidPort; // 400 concurrent projects colliding — not realistic
}

function currentMode(repoRoot) {
  return readJson(statePath(repoRoot, "config.json"), {}).reviewMode === "accumulate"
    ? "accumulate"
    : "per-request";
}

function reviewSig(repoRoot) {
  try {
    const st = fs.statSync(statePath(repoRoot, "review.json"));
    return st.mtimeMs + "-" + st.size;
  } catch (_) {
    return "none";
  }
}

// Stop hook: spawns a detached `serve` process and exits immediately (hooks must return fast).
async function openReview(repoRoot, { manual, hookInput } = {}) {
  let port = resolvePort(repoRoot);

  // Skip if no files were edited (fast path). transcriptFilter:false in config falls back to full diff.
  const transcriptFilterEnabled =
    readJson(statePath(repoRoot, "config.json"), {}).transcriptFilter !== false;
  if (!manual && hookInput && hookInput.transcript_path && transcriptFilterEnabled) {
    const { editedFiles } = require("./transcript");
    const edited = editedFiles(hookInput.transcript_path);
    if (edited !== null) {
      const rel = edited
        .map((p) => (path.isAbsolute(p) ? path.relative(repoRoot, p) : p))
        .filter((p) => p && !p.startsWith(".."));
      if (!rel.length) {
        log(repoRoot, "transcript shows no file edits — skipping (fast path)");
        return;
      }
      const sessionFile = statePath(repoRoot, "session.json");
      const session = readJson(sessionFile, null);
      if (session) {
        const merged = new Set([...(session.files || []), ...rel]);
        session.files = [...merged];
        fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
      }
    }
  }

  // Always freeze per-request; accumulate is computed live, so review.json only holds per-request content.
  const model = buildReviewModel(repoRoot, "per-request");
  if (model.error || !model.files.length) {
    if (manual) console.log(model.error || "No changes to review.");
    return;
  }

  const sig = crypto.createHash("sha1").update(JSON.stringify(model.files)).digest("hex");
  const sigFile = statePath(repoRoot, "opened.sig");
  let lastSig = "";
  try { lastSig = fs.readFileSync(sigFile, "utf8"); } catch (_) { }

  // Check server/tab status before deciding whether to open.
  let alive = await serverAlive(port);
  // alive.repoRoot absent on old servers — treat as ours so version upgrades still replace them.
  if (alive && alive.repoRoot && alive.repoRoot !== path.resolve(repoRoot)) {
    log(repoRoot, `port ${port} belongs to a different project (${alive.repoRoot}) — reassigning`);
    port = await findFreePort(port);
    persistPort(repoRoot, port);
    alive = await serverAlive(port);
  }
  let hadViewerBeforeKill = false;
  if (alive && alive.version !== VERSION) {
    log(repoRoot, `stale server v${alive.version || "?"} detected (current v${VERSION}) — replacing`);
    hadViewerBeforeKill = !!alive.viewing;
    killStaleServer(repoRoot);
    await new Promise((r) => setTimeout(r, 300));
    alive = await serverAlive(port);
  }

  fs.writeFileSync(sigFile, sig);

  if (alive) {
    if (alive.viewing) {
      if (sig !== lastSig) {
        // Diff changed — write new review.json so the open tab refreshes via its poll
        fs.writeFileSync(statePath(repoRoot, "review.json"), JSON.stringify(model));
        log(repoRoot, "diff updated — existing tab will refresh in place");
      } else {
        log(repoRoot, "diff unchanged and tab already open — nothing to do");
      }
    } else {
      fs.writeFileSync(statePath(repoRoot, "review.json"), JSON.stringify(model));
      log(repoRoot, "server running, no active tab — opening tab for new review");
      openBrowser(`http://localhost:${port}`);
    }
    if (manual) console.log(`Review UI: http://localhost:${port}`);
    return;
  }

  // Freeze the review; in per-request mode the baseline moves on the next prompt.
  fs.writeFileSync(statePath(repoRoot, "review.json"), JSON.stringify(model));

  // Skip auto-open if an existing tab was polling the killed server — it will reconnect on its own.
  const child = spawn(
    process.execPath,
    [path.join(__dirname, "..", "bin", "review-tab.js"), "serve"],
    {
      cwd: repoRoot, detached: true, stdio: "ignore", windowsHide: true,
      env: { ...process.env, REVIEW_TAB_SKIP_AUTOOPEN: hadViewerBeforeKill ? "1" : "" },
    }
  );
  child.unref();
  log(repoRoot, `spawned review server pid=${child.pid} port=${port}${hadViewerBeforeKill ? " (skip-autoopen, existing tab will reconnect)" : ""}`);
  if (manual) console.log(`Review UI: http://localhost:${port}`);
}

function serve(repoRoot) {
  // Mode in memory only; always starts per-request. Persisting it caused mode to leak across sessions.
  let reviewMode = "per-request";
  let updateApplied = false; // set once an in-session update installs, so the banner stops nagging
  checkForUpdate(repoRoot, VERSION); // fire-and-forget, never blocks

  const port = resolvePort(repoRoot);
  let lastPoll = 0;

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/") {
      const projectName = path.basename(path.resolve(repoRoot));
      const html = fs
        .readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8")
        .replace(/__CR_VERSION__/g, VERSION)
        .replace(/__CR_PROJECT__/g, projectName);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && (req.url === "/favicon.ico" || req.url === "/favicon.svg")) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none"><rect x="2" y="4" width="28" height="24" rx="5" stroke="#52525B" stroke-width="3"/><path d="M2 12h28M14 12v16" stroke="#52525B" stroke-width="2.5"/></svg>`;
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
      res.end(svg);
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/review_complete.png")) {
      try {
        const img = fs.readFileSync(path.join(__dirname, "..", "public", "review_complete.png"));
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
        res.end(img);
        return;
      } catch (_) { }
    }
    if (req.method === "GET" && req.url === "/api/review") {
      const mode = reviewMode;
      let model;
      if (mode === "per-request") {
        // Serve frozen review.json (captured before baseline advanced); live build only if file missing.
        try {
          model = JSON.parse(fs.readFileSync(statePath(repoRoot, "review.json"), "utf8"));
        } catch (_) {
          model = buildReviewModel(repoRoot, "per-request");
        }
      } else {
        // Accumulate always computed live (HEAD never moves between prompts).
        model = buildReviewModel(repoRoot, "accumulate");
      }
      // Snapshot the model so /api/submit uses the same hunk IDs even if baseline or tree changes.
      try { fs.writeFileSync(statePath(repoRoot, "review-current.json"), JSON.stringify(model)); } catch (_) { }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(model));
      return;
    }
    if (req.method === "GET" && req.url === "/api/sig") {
      lastPoll = Date.now();
      res.writeHead(200, { "Content-Type": "application/json" });
      // mode piggybacks the sig poll so config.json edits show up live.
      const us = getUpdateStatus();
      res.end(JSON.stringify({
        sig: reviewSig(repoRoot), version: VERSION, mode: reviewMode,
        updateAvailable: updateApplied ? false : (us ? us.updateAvailable : false),
        latestVersion: us ? us.latestVersion : null,
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/close") {
      lastPoll = 0;
      try { fs.unlinkSync(statePath(repoRoot, "opened.sig")); } catch (_) { }
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && req.url === "/api/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      // 5 min tolerance: explicit tab close calls /api/close (lastPoll=0 instantly);
      // background tabs in Chrome/Edge may throttle polling timers up to a few minutes.
      res.end(JSON.stringify({
        viewing: lastPoll > 0 && Date.now() - lastPoll < 300000,
        version: VERSION,
        repoRoot: path.resolve(repoRoot),
      }));
      return;
    }
    if (req.method === "GET" && req.url === "/api/mode") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ mode: reviewMode }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/mode") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const { mode: newMode } = JSON.parse(body || "{}");
          if (newMode !== "per-request" && newMode !== "accumulate") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "mode must be 'per-request' or 'accumulate'" }));
            return;
          }
          reviewMode = newMode;
          log(repoRoot, `reviewMode set to ${reviewMode}`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ mode: reviewMode }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err.message) }));
        }
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/submit") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const { selections = {}, reasons = {} } = JSON.parse(body || "{}");
          // Use snapshot from /api/review so hunk IDs match what the UI showed.
          const model = readJson(statePath(repoRoot, "review-current.json"), null)
            || buildReviewModel(repoRoot, currentMode(repoRoot));
          const results = revertSelection(repoRoot, model, selections, reasons);
          writeFeedback(repoRoot, model, selections, reasons);
          // Move the baseline forward: everything up to now is reviewed.
          try {
            require("./snapshot").snapshot(repoRoot);
            fs.unlinkSync(statePath(repoRoot, "opened.sig"));
          } catch (_) { }
          try { fs.unlinkSync(statePath(repoRoot, "review.json")); } catch (_) { }
          try { fs.unlinkSync(statePath(repoRoot, "review-current.json")); } catch (_) { }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ results }));
          setTimeout(() => server.close(() => process.exit(0)), 1500);
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err.message) }));
        }
      });
      return;
    }


    if (req.method === "POST" && req.url === "/api/update") {
      const us = getUpdateStatus();
      if (!us || !us.updateAvailable) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No update available" }));
        return;
      }
      const { latestVersion } = us;
      const onDone = (err, stderr) => {
        if (err) {
          log(repoRoot, `update failed: ${err.message}`);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message, details: stderr }));
          return;
        }
        // Keep serving on the current code: not exiting avoids a dead port, and not relaunching avoids a
        // console-window flash from a detached spawn. The installed version applies on the next session.
        updateApplied = true;
        log(repoRoot, `update to v${latestVersion} installed (applies next session)`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, latestVersion }));
      };
      // Run the claude executable directly (no shell) so no cmd.exe window is created; windowsHide keeps
      // claude's own console hidden. Fall back to a shell invocation only if the binary can't be resolved.
      execFile(
        "claude",
        ["plugin", "install", "review-tab@review-tab-marketplace"],
        { timeout: 60000, windowsHide: true },
        (err, _stdout, stderr) => {
          if (err && err.code === "ENOENT") {
            exec(
              "claude plugin install review-tab@review-tab-marketplace",
              { shell: true, timeout: 60000, windowsHide: true },
              (e2, _o2, se2) => onDone(e2, se2)
            );
            return;
          }
          onDone(err, stderr);
        }
      );
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  // Recent server.pid mtime means a tab may still be reconnecting. Existence alone would delay
  // every session forever since server.pid is never deleted, only overwritten.
  const pidPath = statePath(repoRoot, "server.pid");
  let isRecentRestart = false;
  try {
    const ageMs = Date.now() - fs.statSync(pidPath).mtimeMs;
    isRecentRestart = ageMs < 5 * 60 * 1000; // 5 minutes
  } catch (_) { } // no prior server.pid at all — definitely not a restart
  fs.writeFileSync(pidPath, String(process.pid));
  server.listen(port, "127.0.0.1", () => {
    log(repoRoot, `review server v${VERSION} listening on ${port} for ${repoRoot}`);
    if (process.env.REVIEW_TAB_SKIP_AUTOOPEN === "1") {
      log(repoRoot, "skipping auto-open — an existing tab is expected to reconnect to this server");
      return;
    }
    if (!isRecentRestart) {
      log(repoRoot, "no recent prior server for this project — opening immediately, no reconnecting tab is possible");
      openBrowser(`http://localhost:${port}`);
      return;
    }
    // 3s grace: poll tracking is in-memory and dies with the old process. An existing tab's 1s poll
    // will reconnect within this window; opening a duplicate is worse than a short delay.
    const graceStart = Date.now();
    setTimeout(() => {
      if (lastPoll >= graceStart) {
        log(repoRoot, "existing tab reconnected during startup grace period — not opening a duplicate");
      } else {
        openBrowser(`http://localhost:${port}`);
      }
    }, 3000);
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") process.exit(0);
    log(repoRoot, `server error: ${err.message}`);
  });

  const IDLE_MS = parseInt(process.env.REVIEW_TAB_IDLE_MS, 10) || 60 * 60 * 1000;
  const startedAt = Date.now();
  setInterval(() => {
    const lastActivity = lastPoll || startedAt;
    if (Date.now() - lastActivity > IDLE_MS) {
      log(repoRoot, "no viewer activity within idle window — shutting down");
      server.close(() => process.exit(0));
    }
  }, 60 * 1000).unref();
}

function serverAlive(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/api/status", timeout: 400, agent: false },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try { resolve(JSON.parse(body)); } catch (_) { resolve({ viewing: false, version: null }); }
        });
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

// Kill the old server so an update doesn't silently keep serving stale code.
function killStaleServer(repoRoot) {
  try {
    const pid = parseInt(fs.readFileSync(statePath(repoRoot, "server.pid"), "utf8"), 10);
    if (pid) process.kill(pid, "SIGTERM");
    log(repoRoot, `killed stale server pid=${pid}`);
  } catch (_) { }
}

function openBrowser(url) {
  if (process.platform === "darwin") {
    execFile("open", [url], {}, () => {});
  } else if (process.platform === "win32") {
    const script = `(New-Object -ComObject WScript.Shell).Run('${url}', 1, $false)`;
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true }, () => {});
  } else {
    execFile("xdg-open", [url], {}, () => {});
  }
}

module.exports = { openReview, serve };
