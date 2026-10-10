import { TAXONOMY } from "./taxonomy.js";
import { wikiLink } from "./noteStore.js";

// 分類地圖（<大項目>地圖.md）：每次有筆記寫進某個大項目，就整份重新產生一次，
// 依「中項目 → 主 tag」分段列出所有筆記連結（附篇數），取代手動維護的索引。
// 整份重新產生讓地圖永遠跟 vault 實際資料夾一致；這個檔案會被覆寫，想備註請寫在筆記本身。

const byName = (a, b) => a.localeCompare(b, "zh-Hant");

// 中項目照分類樹裡的順序，自訂的中項目（國家、專案名）排在後面、依名稱排序。
function subcategoryOrder(top) {
  const order = TAXONOMY[top].subcategories || [];
  const rank = (s) => (order.includes(s) ? order.indexOf(s) : Infinity);
  return (a, b) => rank(a) - rank(b) || byName(a, b);
}

/**
 * 重新產生 <top>地圖.md。不是大項目、是收件匣、或底下沒有筆記時跳過。
 * 不在「中項目/主tag」兩層底下的筆記（例如舊結構留下的）歸在「其他」。
 */
export function regenerateMoc(vault, top) {
  if (!TAXONOMY[top] || TAXONOMY[top].noTagLevel) return { updated: false };

  const groups = new Map(); // 中項目 -> Map(tag -> paths[])
  for (const note of vault.listNotes(top)) {
    if (note.frontmatter?.type === "MOC") continue;
    const parts = note.path.split("/");
    const [sub, tag] = parts.length === 4 ? [parts[1], parts[2]] : ["其他", parts.slice(1, -1).join("/") || top];
    if (!groups.has(sub)) groups.set(sub, new Map());
    const tags = groups.get(sub);
    if (!tags.has(tag)) tags.set(tag, []);
    tags.get(tag).push(note.path);
  }
  if (groups.size === 0) return { updated: false };

  const lines = ["---", `title: ${top}地圖`, "type: MOC", "---", "", `# ${top} 地圖`, ""];
  for (const sub of [...groups.keys()].sort(subcategoryOrder(top))) {
    lines.push(`## ${sub}`, "");
    const tags = groups.get(sub);
    for (const tag of [...tags.keys()].sort(byName)) {
      const notes = tags.get(tag).sort(byName);
      lines.push(`### ${tag}（${notes.length}）`, "", ...notes.map((p) => `- ${wikiLink(p)}`), "");
    }
  }

  const mocPath = `${top}/${top}地圖.md`;
  vault.writeFile(mocPath, `${lines.join("\n").trimEnd()}\n`);
  return { updated: true, mocPath };
}

/** pipeline 寫完一篇筆記後呼叫：重新產生該筆記所屬大項目的地圖。 */
export function syncMocForFolder(vault, folder) {
  return regenerateMoc(vault, folder.split("/")[0]);
}
