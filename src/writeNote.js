import fs from "node:fs";
import path from "node:path";
import { vaultFilePath } from "./config.js";

function sanitizeFilename(name) {
  return name
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "未命名筆記";
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function yamlEscape(str) {
  // 簡單處理：含冒號、引號或開頭特殊字元就整體用雙引號包起來
  if (/[:#"'\n]/.test(str)) {
    return JSON.stringify(str);
  }
  return str;
}

function buildFrontmatter({ title, tags, summary, sources, sourceChannel, reasoning }) {
  const lines = ["---"];
  lines.push(`title: ${yamlEscape(title)}`);
  if (sources?.length) {
    lines.push(`source: ${yamlEscape(sources[0])}`);
    if (sources.length > 1) {
      lines.push("other_sources:");
      for (const s of sources.slice(1)) lines.push(`  - ${yamlEscape(s)}`);
    }
  }
  lines.push(`date_added: ${todayISO()}`);
  lines.push(`via: ${sourceChannel}`);
  lines.push(`summary: ${yamlEscape(summary || "")}`);
  lines.push("tags:");
  for (const t of tags || []) lines.push(`  - ${String(t).replace(/^#/, "")}`);
  lines.push("status: 已整理");
  if (reasoning) lines.push(`classify_note: ${yamlEscape(reasoning)}`);
  lines.push("---");
  return lines.join("\n");
}

/**
 * 把 classify() 的結果寫成 .md 檔到 vault 對應資料夾。
 * 檔名重複時自動加上流水號，絕不覆蓋既有筆記。
 */
export function writeNote({ folder, filename, title, tags, summary, body, reasoning, sources, sourceChannel }) {
  const dirAbs = vaultFilePath(...folder.split("/"));
  fs.mkdirSync(dirAbs, { recursive: true });

  const base = sanitizeFilename(filename || title || "未命名筆記");
  let finalName = `${base}.md`;
  let counter = 2;
  while (fs.existsSync(path.join(dirAbs, finalName))) {
    finalName = `${base} (${counter}).md`;
    counter += 1;
  }

  const frontmatter = buildFrontmatter({ title, tags, summary, sources, sourceChannel, reasoning });
  const content = `${frontmatter}\n\n# ${title}\n\n${body.trim()}\n`;

  const fullPath = path.join(dirAbs, finalName);
  fs.writeFileSync(fullPath, content, "utf8");

  return {
    relativePath: path.join(folder, finalName),
    fullPath,
  };
}
