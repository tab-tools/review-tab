const https = require("https");
const { log } = require("./util");

let _updateStatus = null; // null = pending/failed/up-to-date; { latestVersion, updateAvailable }

function semverGt(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

function checkForUpdate(repoRoot, currentVersion) {
  (async () => {
    try {
      const body = await new Promise((resolve, reject) => {
        const req = https.get(
          "https://api.github.com/repos/nishit1617/review-tab/tags",
          {
            headers: {
              "User-Agent": "review-tab-plugin",
              "Accept": "application/vnd.github+json",
            },
          },
          (res) => {
            if (res.statusCode !== 200) { res.resume(); reject(new Error(`status ${res.statusCode}`)); return; }
            let data = "";
            res.on("data", (c) => (data += c));
            res.on("end", () => resolve(data));
          }
        );
        req.setTimeout(10000, () => { req.destroy(); reject(new Error("timeout")); });
        req.on("error", reject);
      });
      const tags = JSON.parse(body);
      if (!Array.isArray(tags) || !tags.length) return;
      const latest = tags[0].name.replace(/^v/, "");
      if (semverGt(latest, currentVersion)) {
        _updateStatus = { latestVersion: latest, updateAvailable: true };
        log(repoRoot, `update available: v${currentVersion} → v${latest}`);
      }
    } catch (_) { }
  })();
}

function getUpdateStatus() {
  return _updateStatus;
}

module.exports = { checkForUpdate, getUpdateStatus };
