const fs = require("fs");
const { statePath, log } = require("./util");

// Writes feedback.md with rejection reasons; delivered to Claude on the next prompt (see bin/review-tab.js).
function writeFeedback(repoRoot, model, selections, reasons) {
  const restored = [];
  for (const f of model.files) {
    for (const h of f.hunks) {
      const sel = selections[h.id];
      if (sel && sel.lines && sel.lines.length) {
        const changed = h.lines.filter((l) => l[0] === "+" || l[0] === "-").length;
        restored.push({
          file: f.filePath,
          header: h.header,
          partial: sel.lines.length < changed,
          reason: (reasons && reasons[h.id]) || "",
        });
      }
    }
  }
  if (!restored.length) return;
  const lines = [
    "# Review feedback for Claude",
    "",
    "The user reviewed your last session's changes and RESTORED the following",
    "(they have been reverted). Do not re-apply them as written.",
    "",
  ];
  for (const r of restored) {
    lines.push(`- ${r.file} at ${r.header}${r.partial ? " (some lines only)" : ""}`);
    if (r.reason) lines.push(`  Reason: ${r.reason}`);
  }
  fs.writeFileSync(statePath(repoRoot, "feedback.md"), lines.join("\n") + "\n");
  log(repoRoot, `feedback written (${restored.length} restored hunks)`);
}

module.exports = { writeFeedback };
