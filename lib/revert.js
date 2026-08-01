const fs = require("fs");
const path = require("path");
const { log } = require("./util");

// Content-based revert (vs git apply -R) so individual lines inside a hunk can be reverted.
// selections: { [hunkId]: { lines: [rejected indices into hunk.lines] } }
// Walk: context → keep file line, '+' rejected → drop, '-' rejected → re-insert old line.
// Bottom-up per file so earlier line numbers stay valid.
function revertSelection(repoRoot, model, selections, reasons) {
  const results = [];
  for (const file of model.files) {
    const touched = file.hunks.filter(
      (h) => selections[h.id] && selections[h.id].lines && selections[h.id].lines.length
    );
    if (!touched.length) continue;

    const abs = path.join(repoRoot, file.filePath);
    let content = "";
    let existed = false;
    try {
      content = fs.readFileSync(abs, "utf8");
      existed = true;
    } catch (_) {}

    const eol = content.includes("\r\n") ? "\r\n" : "\n";
    const hadTrailingNL = existed ? /\r?\n$/.test(content) : true;
    let lines = existed ? content.split(/\r?\n/) : [];
    if (existed && hadTrailingNL) lines.pop(); // drop empty tail from split

    // Bottom-up so earlier hunks' offsets are unaffected.
    const ordered = [...touched].sort((a, b) => b.newStart - a.newStart);
    let ok = true;
    for (const h of ordered) {
      const restored = new Set(selections[h.id].lines);
      const newCount = h.lines.filter((l) => l[0] === " " || l[0] === "+").length;
      const start = Math.max(h.newStart - 1, 0);
      const rebuilt = [];
      let ptr = start;
      for (let i = 0; i < h.lines.length; i++) {
        const l = h.lines[i];
        const p = l[0];
        if (l.startsWith("\\")) continue; // "\ No newline at end of file"
        if (p === " ") {
          rebuilt.push(lines[ptr]); ptr++;
        } else if (p === "+") {
          if (!restored.has(i)) rebuilt.push(lines[ptr]);
          ptr++;
        } else if (p === "-") {
          if (restored.has(i)) rebuilt.push(l.slice(1).replace(/\r$/, ""));
        }
      }
      if (ptr !== start + newCount) {
        ok = false;
        results.push({ file: file.filePath, hunk: h.id, ok: false,
          error: "file changed since diff was taken — re-open the review" });
        log(repoRoot, `revert FAIL ${file.filePath} ${h.id}: region mismatch`);
        continue;
      }
      lines.splice(start, newCount, ...rebuilt);
      results.push({ file: file.filePath, hunk: h.id, ok: true });
      log(repoRoot, `revert ok ${file.filePath} ${h.id} (${restored.size} lines)`);
    }

    if (lines.length === 0 && file.created) {
      // Fully restored new file: remove it.
      try { fs.unlinkSync(abs); } catch (_) {}
      log(repoRoot, `deleted fully-restored new file ${file.filePath}`);
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, lines.join(eol) + (hadTrailingNL && lines.length ? eol : ""));
    }
  }
  return results;
}

module.exports = { revertSelection };
