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

// Obsidian 的 tag 不能含空白（有空白會被判定成無效標籤，UI 上會用刪除線顯示）。
// AI 有時候還是會生成像 "Claude Code" 這種含空白的 tag，這裡強制拿掉空白當最後防線，
// 例如 "Claude Code" -> "ClaudeCode"。
function sanitizeTag(tag) {
  return String(tag)
    .replace(/^#/, "")
    .trim()
    .replace(/\s+/g, "");
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
  for (const t of tags || []) {
    const clean = sanitizeTag(t);
    if (clean) lines.push(`  - ${clean}`);
  }
  lines.push("status: 已整理");
  if (reasoning) lines.push(`classify_note: ${yamlEscape(reasoning)}`);
  lines.push("---");
  return lines.join("\n");
}

// 把已經下載到 vault 同一個資料夾裡的圖片檔案，用 Obsidian 的 ![[檔名]] 內嵌語法
// 直接插進筆記正文，打開筆記就看得到圖，不用點連結或另外開 Eagle。
// 沒有內嵌圖片（Eagle 沒啟用/沒圖片/下載失敗）就不加這一段。
function buildEmbeddedImagesSection(filenames) {
  if (!filenames || filenames.length === 0) return "";
  const embeds = filenames.map((f) => `![[${f}]]`).join("\n\n");
  return `\n\n## 圖片\n\n${embeds}`;
}

// 把 Eagle App 同步回來的 eagle://item/<id> 深連結整理成一段 Markdown，附在筆記正文最後，
// 這樣打開筆記就能直接點回 Eagle 裡對應的圖片（例如要去 Eagle 裡加標籤、整理）。
// 沒有連結（Eagle 沒啟用/沒圖片/同步失敗）就不加這一段。
function buildEagleLinksSection(eagleImages) {
  if (!eagleImages || eagleImages.length === 0) return "";
  const lines = ["## 在 Eagle 中開啟", ""];
  eagleImages.forEach((link, i) => {
    lines.push(`- [圖片 ${i + 1}](${link})`);
  });
  return `\n\n${lines.join("\n")}`;
}

/**
 * 把 classify() 的結果寫成 .md 檔到 vault 對應資料夾。
 * 檔名重複時自動加上流水號，絕不覆蓋既有筆記。
 *
 * embeddedImageFilenames（選用）：imageEmbed.js 下載到同一個資料夾裡的圖片檔名，
 * 會用 ![[檔名]] 直接內嵌顯示在筆記正文裡。
 * eagleImages（選用）：syncImagesToEagle() 回傳的 eagle://item/<id> 深連結，
 * 會附加一段「在 Eagle 中開啟」的連結清單。
 * 兩者互相獨立，都有的話會依序出現在筆記最後。
 */
export function writeNote({
  folder,
  filename,
  title,
  tags,
  summary,
  body,
  reasoning,
  sources,
  sourceChannel,
  embeddedImageFilenames,
  eagleImages,
}) {
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
  const embeddedSection = buildEmbeddedImagesSection(embeddedImageFilenames);
  const eagleLinksSection = buildEagleLinksSection(eagleImages);
  const content = `${frontmatter}\n\n# ${title}\n\n${body.trim()}${embeddedSection}${eagleLinksSection}\n`;

  const fullPath = path.join(dirAbs, finalName);
  fs.writeFileSync(fullPath, content, "utf8");

  return {
    relativePath: path.join(folder, finalName),
    fullPath,
  };
}
