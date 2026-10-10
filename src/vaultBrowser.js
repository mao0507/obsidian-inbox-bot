import { vault } from "./app.js";

/**
 * 列出 vault 裡某個資料夾「直接底下」的子分類（含各自遞迴筆記數）跟直接放在這一層的筆記。
 * segments 是相對 vault 根目錄的路徑片段陣列，[] 代表根目錄（也就是所有頂層分類）。
 * 直接反映磁碟上目前實際存在的筆記——不是 taxonomy.js 裡設定的規則清單；
 * 底下完全沒有筆記的資料夾不會列出來。
 */
export function listFolder(segments = []) {
  const prefix = segments.join("/");
  const counts = new Map();
  const notes = [];

  for (const note of vault.listNotes(prefix)) {
    const rest = note.path.split("/").slice(segments.length);
    if (rest.length === 1) {
      notes.push({ name: rest[0].replace(/\.md$/i, ""), segments: [...segments, rest[0]] });
    } else {
      counts.set(rest[0], (counts.get(rest[0]) || 0) + 1);
    }
  }

  const byName = (a, b) => a.name.localeCompare(b.name, "zh-Hant");
  const subfolders = [...counts]
    .map(([name, noteCount]) => ({ name, segments: [...segments, name], noteCount }))
    .sort(byName);

  return { segments, subfolders, notes: notes.sort(byName) };
}

/** 讀取單一筆記（segments 最後一段是檔名本身，含 .md），回傳 Note 物件。 */
export function readNote(segments) {
  return vault.readNote(segments.join("/"));
}
