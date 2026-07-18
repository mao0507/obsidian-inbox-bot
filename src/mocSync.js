import fs from "node:fs";
import path from "node:path";
import { vaultFilePath } from "./config.js";
import { DYNAMIC_TAXONOMY } from "./taxonomy.js";

// 之前分類地圖（<類別>地圖.md）完全要手動維護——動態分類（AI / 學習 / 旅遊）
// 底下寫進新筆記之後，沒有任何機制自動反映到索引檔案裡。
// 這支模組在每次寫入動態分類筆記之後，重新掃描整個分類資料夾、依實際存在的
// 子資料夾巢狀結構完整重新產生一份 <類別>地圖.md，取代手動維護。
//
// 用「整份重新產生」而不是增量插入，是為了讓地圖內容永遠跟 vault 實際資料夾結構
// 一致（不會因為某個 edge case 沒處理到而長期跟真實結構產生落差），
// 筆記數量在這個規模（幾十~幾百篇）下重新掃描整個資料夾樹幾乎是瞬間完成。
//
// 注意：這個檔案是自動產生的索引，每次動態分類有新筆記進來都會整份覆寫。
// 想在地圖上額外寫點什麼，請寫在筆記本身裡，不要手動編輯 <類別>地圖.md，
// 手動加的內容下次自動重新產生時會被覆蓋掉。

function walkLeaves(dirAbs, relParts, mocFilename, out) {
  let entries;
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  const mdFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== mocFilename)
    .map((e) => e.name.slice(0, -3))
    .sort((a, b) => a.localeCompare(b, "zh-Hant"));

  if (mdFiles.length > 0) {
    out.push({ parts: [...relParts], files: mdFiles });
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      walkLeaves(path.join(dirAbs, entry.name), [...relParts, entry.name], mocFilename, out);
    }
  }
}

/**
 * 幫傳入的動態分類頂層資料夾（例如 "AI"、"旅遊"、"學習"）重新產生一份 <top>地圖.md，
 * 依實際存在的子資料夾巢狀結構分段列出所有筆記連結（## 上層 / ### 下層 依深度遞增）。
 * 不是這三個動態分類之一就直接跳過、什麼都不做。資料夾底下完全沒有筆記時也跳過，
 * 不會生出一份空地圖。
 */
export function regenerateMoc(top) {
  if (!DYNAMIC_TAXONOMY[top]) return { updated: false };

  const dirAbs = vaultFilePath(top);
  const mocFilename = `${top}地圖.md`;
  const groups = [];
  walkLeaves(dirAbs, [], mocFilename, groups);

  if (groups.length === 0) return { updated: false };

  groups.sort((a, b) => a.parts.join("/").localeCompare(b.parts.join("/"), "zh-Hant"));

  const lines = ["---", `title: ${top}地圖`, "type: MOC", "---", "", `# ${top} 地圖`, ""];
  let prevParts = [];
  for (const group of groups) {
    // 只要有一層跟前一組不同，這一層以下（包含後面更深的層）都要重印標題，
    // 就算剛好文字跟前一組同層剛好一樣也一樣要印
    // （例如 ClaudeCode/教學文章 換到 OpenAI/教學文章 這種巧合同名）。
    let changed = false;
    group.parts.forEach((part, i) => {
      if (changed || prevParts[i] !== part) {
        changed = true;
        lines.push(`${"#".repeat(Math.min(2 + i, 6))} ${part}`);
      }
    });
    prevParts = group.parts;
    lines.push("");
    group.files.forEach((f) => lines.push(`- [[${f}]]`));
    lines.push("");
  }

  fs.mkdirSync(dirAbs, { recursive: true });
  const content = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  fs.writeFileSync(path.join(dirAbs, mocFilename), content, "utf8");

  return { updated: true, mocPath: path.join(top, mocFilename).replace(/\\/g, "/") };
}

/**
 * pipeline.js 寫完一篇筆記後呼叫：folder 是這篇筆記實際去的資料夾路徑
 * （例如 "AI/ClaudeCode/教學文章"），只有第一段對應到動態分類時才會重新產生地圖，
 * 其他分類（收件匣/知識庫/專案...）直接跳過、回傳 { updated: false }。
 */
export function syncMocForFolder(folder) {
  const top = folder.split("/")[0];
  return regenerateMoc(top);
}
