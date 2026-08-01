const fs = require("fs");

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// Scans the session JSONL transcript for Edit/Write tool calls to find which files Claude touched.
function editedFiles(transcriptPath) {
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch (_) {
    return null; // can't read — caller falls back to full diff
  }
  const files = new Set();
  for (const line of raw.split("\n")) {
    if (!line.includes('"tool_use"')) continue; // cheap pre-filter
    try {
      const entry = JSON.parse(line);
      const content =
        (entry.message && entry.message.content) || entry.content || [];
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (
          block &&
          block.type === "tool_use" &&
          EDIT_TOOLS.has(block.name) &&
          block.input &&
          (block.input.file_path || block.input.notebook_path)
        ) {
          files.add(block.input.file_path || block.input.notebook_path);
        }
      }
    } catch (_) { }
  }
  return [...files];
}

module.exports = { editedFiles };
