import { mapFrontmatterList } from "./noteStore.js";
import { createTagVocabulary } from "./tagVocabulary.js";
import { rewriteVaultLinks } from "./linkRewrite.js";
import { regenerateMoc } from "./mocSync.js";
import { TAXONOMY } from "./taxonomy.js";

// tag 管理（/tags）：看 tag 使用量、把重複的 tag 併進另一個。
// 合併會：改所有筆記 frontmatter 的 tags、把以舊 tag 當主 tag 的資料夾搬到新 tag 底下、改寫指向搬家筆記的連結、
// 舊 tag 變成新 tag 的別名（之後 AI 再寫舊名也會自動變成新名）、重新產生受影響的分類地圖。

const isNote = (note) => !["MOC", "card"].includes(note.frontmatter?.type);

/** 每個 tag 用在幾篇筆記：[[tag, count], ...]，由多到少。 */
export function tagUsage(vault) {
  const counts = new Map();
  for (const note of vault.listNotes().filter(isNote)) {
    for (const tag of note.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-Hant"));
}

/** 把 tag from 併進 into。回傳 { retagged: 改了 tags 的筆記數, moved: 搬資料夾的筆記數 }。 */
export function mergeTags(vault, from, into) {
  const vocab = createTagVocabulary(vault);
  const notes = vault.listNotes().filter(isNote);
  const fromName = vocab.lookup(from) || from;
  const intoName = vocab.lookup(into) || String(into).replace(/\s+/g, "");
  if (!vocab.lookup(from) && !notes.some((n) => n.tags.includes(fromName))) throw new Error(`找不到 tag「${from}」`);
  if (fromName === intoName) throw new Error(`「${from}」和「${into}」已經是同一個 tag`);

  vocab.mergeInto(fromName, intoName);

  let retagged = 0;
  const moves = new Map();
  const affectedTops = new Set();
  for (const note of notes) {
    if (note.tags.includes(fromName)) {
      vault.updateNote(note.path, (content) =>
        mapFrontmatterList(content, "tags", (tags) => tags.map((t) => (t === fromName ? intoName : t)))
      );
      retagged++;
    }
    // 以舊 tag 當主 tag 的資料夾（大/中/舊tag/筆記.md）搬到 大/中/新tag
    const [top, sub, tagFolder, file] = note.path.split("/");
    if (file && TAXONOMY[top] && tagFolder === fromName) {
      moves.set(note.path, vault.moveNote(note.path, `${top}/${sub}/${intoName}`));
      affectedTops.add(top);
    }
  }

  if (moves.size) rewriteVaultLinks(vault, moves);
  affectedTops.forEach((top) => regenerateMoc(vault, top));
  return { retagged, moved: moves.size };
}
