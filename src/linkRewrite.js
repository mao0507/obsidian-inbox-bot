import { basenameOf } from "./noteStore.js";

// 筆記搬家（舊筆記重建、tag 合併搬資料夾、概念卡合併）之後，把全 vault 指向舊路徑的 [[連結]] 改指向新路徑。
// 舊連結可能是完整路徑 [[資料夾/檔名]]，也可能只寫檔名 [[檔名]]（Obsidian 預設寫法）；
// 只寫檔名、而且有兩篇以上搬家的筆記同名時，無法判斷原本連到哪一篇，那種連結不動。

const withoutExt = (relPath) => relPath.replace(/\.md$/i, "");

// [[目標#標題|別名]]
const WIKILINK = /\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/g;

/**
 * @param {Map<string, string>} moves 舊路徑 -> 新路徑（都是 vault 相對路徑，含 .md）
 * @returns {(content: string) => string} 改寫一篇筆記內容的函式；保留標題錨點與別名，沒有別名就用新檔名
 */
export function createLinkRewriter(moves) {
  const byPath = new Map();
  const byName = new Map();
  const ambiguous = new Set();
  for (const [oldPath, newPath] of moves) {
    byPath.set(withoutExt(oldPath), newPath);
    const name = basenameOf(oldPath);
    if (byName.has(name) && byName.get(name) !== newPath) ambiguous.add(name);
    byName.set(name, newPath);
  }
  ambiguous.forEach((name) => byName.delete(name));

  return (content) =>
    content.replace(WIKILINK, (link, target, heading = "", alias) => {
      const key = withoutExt(target.trim());
      const newPath = byPath.get(key) || (!key.includes("/") && byName.get(key));
      if (!newPath) return link;
      // 顯示文字就是舊檔名（自動產生的那種）就跟著換成新檔名；使用者自己取的別名保留
      const keepAlias = alias !== undefined && alias !== basenameOf(key);
      return `[[${withoutExt(newPath)}${heading}|${keepAlias ? alias : basenameOf(newPath)}]]`;
    });
}

/** 對全 vault 套用連結改寫（skip 裡的路徑略過，例如即將刪除的舊檔）。回傳有改動的筆記數。 */
export function rewriteVaultLinks(vault, moves, { skip = new Set() } = {}) {
  const rewrite = createLinkRewriter(moves);
  let changed = 0;
  for (const note of vault.listNotes()) {
    if (!skip.has(note.path) && vault.updateNote(note.path, rewrite)) changed++;
  }
  return changed;
}
