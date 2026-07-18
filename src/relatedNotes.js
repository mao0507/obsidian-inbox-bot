import fs from "node:fs";
import path from "node:path";
import { vaultFilePath } from "./config.js";
import { FLAT_CATEGORIES, DYNAMIC_TAXONOMY } from "./taxonomy.js";

// 之前完全沒有自動建立筆記間的關聯，筆記分類完就各自獨立，
// 使用者要另外手動幫全部筆記補雙向 [[wikilink]]。這支模組在每次寫入新筆記之後執行，
// 自動幫新筆記跟判斷為相關的既有筆記互相補上「## 相關筆記」區塊裡的連結。
//
// 「相關」的判斷方式依分類種類而不同：
// - 動態分類（AI / 學習 / 旅遊）：folder 本身最後一層就是 AI 依內容判斷出來的具體主題
//   （例如 "AI/ClaudeCode/教學文章"、"旅遊/日本/北海道"），同一個最深層資料夾裡的筆記
//   幾乎一定是同主題，直接互相連結。
// - 扁平分類（知識庫 / 程式片段 / 踩雷筆記）：資料夾本身不分主題（技術分類全部靠 tags），
//   改成「至少共用一個 tag」的筆記才視為相關，避免把同資料夾裡完全不相關的技術筆記
//   （例如 Vue 筆記和 Docker 筆記）也連在一起。
// - 其他分類（收件匣 / 專案 / Assets）：不自動連結，這些多半是零散項目，關聯意義不大。

function isDynamicFolder(folder) {
  return Object.keys(DYNAMIC_TAXONOMY).some((top) => folder === top || folder.startsWith(`${top}/`));
}

function isFlatFolder(folder) {
  return FLAT_CATEGORIES.includes(folder);
}

function readFrontmatterTags(content) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return [];
  const tagsBlock = fmMatch[1].match(/^tags:\n((?:[ \t]*-[ \t].+\n?)*)/m);
  if (!tagsBlock) return [];
  return tagsBlock[1]
    .split("\n")
    .map((l) => l.replace(/^[ \t]*-[ \t]/, "").trim())
    .filter(Boolean);
}

// 純粹「加上一條連結」，不會動到區塊裡既有的其他連結（包含使用者自己手動加的）。
// 已經連過的話什麼都不做（避免重複）；完全沒有「## 相關筆記」區塊的話直接新增一段。
function addRelatedLink(content, targetBasename) {
  const heading = "## 相關筆記";
  const linkLine = `- [[${targetBasename}]]`;
  const headingIdx = content.indexOf(heading);

  if (headingIdx === -1) {
    return `${content.trimEnd()}\n\n${heading}\n\n${linkLine}\n`;
  }

  const afterHeading = content.slice(headingIdx + heading.length);
  const nextHeadingRel = afterHeading.search(/\n#{1,6}[ \t]/);
  const sectionEndAbs = nextHeadingRel === -1 ? content.length : headingIdx + heading.length + nextHeadingRel;
  const section = content.slice(headingIdx, sectionEndAbs);

  if (section.includes(`[[${targetBasename}]]`)) return content; // 已經連過了

  const before = content.slice(0, sectionEndAbs).replace(/\s+$/, "");
  const after = content.slice(sectionEndAbs);
  return `${before}\n${linkLine}\n${after}`;
}

/**
 * 一篇新筆記寫進 folder（filename 含 .md）之後呼叫。
 * 找出判斷為相關的既有筆記，雙向補上 [[wikilink]]（新筆記本身 + 每篇既有筆記都各補一條）。
 * 回傳 { linkedCount }：這次總共連結的既有筆記數，給呼叫端顯示狀態用。
 */
export function syncRelatedNotes({ folder, filename, tags }) {
  const dynamic = isDynamicFolder(folder);
  const flat = isFlatFolder(folder);
  if (!dynamic && !flat) return { linkedCount: 0 };

  const dirAbs = vaultFilePath(...folder.split("/"));
  let allFiles;
  try {
    allFiles = fs.readdirSync(dirAbs).filter((f) => f.endsWith(".md"));
  } catch {
    return { linkedCount: 0 };
  }

  const newTagsSet = new Set((tags || []).map((t) => String(t).trim()).filter(Boolean));
  const newBasename = filename.replace(/\.md$/, "");

  const siblings = allFiles.filter((f) => {
    if (f === filename) return false;
    if (dynamic) return true; // 同資料夾一律視為相關
    const full = path.join(dirAbs, f);
    let content;
    try {
      content = fs.readFileSync(full, "utf8");
    } catch {
      return false;
    }
    return readFrontmatterTags(content).some((t) => newTagsSet.has(t));
  });

  if (siblings.length === 0) return { linkedCount: 0 };

  // 新筆記本身：補上所有相關既有筆記的連結。
  const newFilePath = path.join(dirAbs, filename);
  let newContent;
  try {
    newContent = fs.readFileSync(newFilePath, "utf8");
  } catch {
    return { linkedCount: 0 };
  }
  for (const sib of siblings) {
    newContent = addRelatedLink(newContent, sib.replace(/\.md$/, ""));
  }
  fs.writeFileSync(newFilePath, newContent, "utf8");

  // 每篇相關的既有筆記：反過來補上新筆記的連結。
  for (const sib of siblings) {
    const sibPath = path.join(dirAbs, sib);
    let sibContent;
    try {
      sibContent = fs.readFileSync(sibPath, "utf8");
    } catch {
      continue;
    }
    const updated = addRelatedLink(sibContent, newBasename);
    if (updated !== sibContent) fs.writeFileSync(sibPath, updated, "utf8");
  }

  return { linkedCount: siblings.length };
}
