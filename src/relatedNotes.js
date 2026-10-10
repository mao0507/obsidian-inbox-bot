import { TAXONOMY } from "./taxonomy.js";

// 每次寫入新筆記之後執行，自動幫新筆記跟判斷為相關的既有筆記互相補上「## 相關筆記」區塊裡的連結。
// 相關：同一個「大項目/中項目/主tag」資料夾裡的筆記一律視為同主題，直接互相連結。
// 收件匣（沒有 tag 層）不自動連結，那裡多半是零散項目。

function isTagFolder(folder) {
  const parts = folder.split("/");
  return parts.length === 3 && Boolean(TAXONOMY[parts[0]]);
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
export function syncRelatedNotes(vault, { folder, filename, tags }) {
  if (!isTagFolder(folder)) return { linkedCount: 0 };

  const newPath = `${folder}/${filename}`;
  const basename = (relPath) => relPath.slice(relPath.lastIndexOf("/") + 1).replace(/\.md$/, "");

  // 只看「直接放在同一個資料夾」的筆記，不往子資料夾找。
  const siblings = vault
    .listNotes(folder)
    .filter((note) => note.path !== newPath && note.path === `${folder}/${basename(note.path)}.md`);

  if (siblings.length === 0) return { linkedCount: 0 };

  // 新筆記本身：補上所有相關既有筆記的連結；每篇相關的既有筆記：反過來補上新筆記的連結。
  vault.updateNote(newPath, (content) =>
    siblings.reduce((acc, sib) => addRelatedLink(acc, basename(sib.path)), content)
  );
  for (const sib of siblings) {
    try {
      vault.updateNote(sib.path, (content) => addRelatedLink(content, basename(newPath)));
    } catch {
      // 讀寫單篇既有筆記失敗就跳過，不影響其他筆記
    }
  }

  return { linkedCount: siblings.length };
}
