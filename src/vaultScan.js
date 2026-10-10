import { TAXONOMY } from "./taxonomy.js";

/**
 * 列出 vault 裡目前已經有筆記的分類資料夾（大/中/主tag）與篇數，放進 prompt 讓 AI 優先放進既有資料夾，
 * 不要每次生一個新的相似變體（同一主題被拆成兩個資料夾就是這樣來的）。
 * 只列符合目前分類樹的路徑；舊結構留下的資料夾不列，避免 AI 跟著沿用。
 */
export function describeExistingFolders(vault) {
  const counts = new Map();
  for (const note of vault.listNotes()) {
    const parts = note.path.split("/");
    const node = TAXONOMY[parts[0]];
    if (!node) continue;
    const depth = node.noTagLevel ? 2 : 3;
    if (parts.length !== depth + 1) continue; // 筆記要直接放在分類資料夾裡（地圖檔在大項目根目錄，不算）
    const folder = parts.slice(0, depth).join("/");
    counts.set(folder, (counts.get(folder) || 0) + 1);
  }
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b, "zh-Hant"))
    .map(([folder, count]) => `- ${folder}（${count} 篇）`)
    .join("\n");
}
